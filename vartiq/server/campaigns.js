'use strict';

/**
 * Bulk messaging for business accounts: a campaign sends one message to many people, each into their own one-to-one chat with
 * the business (so everyone sees an ordinary message from the business, and replies reach the business alone), and keeps a
 * delivery report for it.
 *
 * Each person in a campaign is in one of these states:
 *   queued     waiting to be sent (also while the campaign is scheduled, or paused because the feature is off)
 *   sent       the message is stored and on its way
 *   delivered  it reached the person's device
 *   read       the person opened the chat
 *   failed     it was not delivered (reason `opted_out`: the person asked this business to stop; `not_delivered`: anything else,
 *              deliberately not more exact, so a report never tells a business who has blocked it or which numbers have no account)
 *   cancelled  the campaign was cancelled or stopped before this person's turn
 *
 * "Delivered" and "read" are read from the message itself, so they are always what the chat shows. The state a person reached is
 * remembered (it only ever moves forward), so a report stays the same if the message is later deleted or expires.
 *
 * Campaign messages are readable by the server (they are written on the server side of a business's account) and are not
 * end-to-end encrypted. People under 18 never receive them, and anyone can stop a business's campaigns for good.
 */

const crypto = require('crypto');
const { Store } = require('./store');
const { normalisePhone } = require('./otp');

const NAME_MAX = 80;
const TEXT_MAX = 1000;
const MAX_AHEAD_MS = 30 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const BATCH = 40; // people sent to per run (runs about every second), so a big campaign never stalls the server
const STATES = ['queued', 'sent', 'delivered', 'read', 'failed', 'cancelled'];
const RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };

/** A cell for a spreadsheet: quoted, and a leading = + - @ is defused so a typed value cannot become a formula. */
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

function createCampaigns({ store, sendMessage, notify, ApiError }) {
  const all = () => store.data.campaigns;

  const fail = (status, code, message) => new ApiError(status, code, message);

  const limitsOf = (me) => {
    const l = store.getSettings().limits;
    const premium = store.isPremium(me);
    return {
      premium,
      recipients: premium ? l.premiumCampaignRecipients : l.freeCampaignRecipients,
      perDay: premium ? l.premiumCampaignsPerDay : l.freeCampaignsPerDay,
      premiumRecipients: l.premiumCampaignRecipients,
      premiumPerDay: l.premiumCampaignsPerDay,
    };
  };

  const mine = (me, id) => {
    const c = all()[String(id)];
    if (!c || c.owner !== me) throw fail(404, 'not_found', 'Campaign not found');
    return c;
  };

  /** People who have written to this business (an existing one-to-one chat where they sent something). */
  const customersOf = (me) => {
    const out = [];
    for (const conv of store._convsOf(me)) {
      if (conv.type !== 'direct') continue;
      const peer = conv.members.find((m) => m !== me);
      const user = store.data.users[peer];
      if (!user || store.isClosed(peer)) continue;
      const wrote = (store.data.messages[conv.id] || []).some((m) => m.from === peer && m.type !== 'system' && !m.auto);
      if (wrote) out.push(peer);
    }
    return out;
  };

  // ---------- sending ----------

  /** Why this person cannot be sent to, or null. Never says more than `opted_out` or `not_delivered`. */
  const refusal = (owner, username) => {
    const u = store.data.users[username];
    if (!u || store.isClosed(username)) return 'not_delivered';
    if (u.promoOptOut?.includes(owner)) return 'opted_out';
    if (store.isMinor(username)) return 'not_delivered'; // promotional messages never go to children
    if (store.hasBlocked(username, owner) || store.hasBlocked(owner, username)) return 'not_delivered';
    return null;
  };

  const sendOne = (c, r, now) => {
    const why = r.u ? refusal(c.owner, r.u) : 'not_delivered';
    if (why) { r.s = 'failed'; r.r = why; r.t = now; return; }
    try {
      const conv = store.getOrCreateDirect(c.owner, r.u);
      // The same clientId every time, so a retry after a crash never sends a second copy.
      const view = sendMessage(c.owner, conv.id, c.text, { clientId: `cmp:${c.id}:${r.u}`, campaign: c.id });
      r.s = 'sent'; r.m = view.id; r.t = now;
    } catch {
      r.s = 'failed'; r.r = 'not_delivered'; r.t = now;
    }
  };

  const finishIfDone = (c, now) => {
    if (c.status === 'sending' && !c.recipients.some((r) => r.s === 'queued')) {
      c.status = 'completed';
      c.finishedAt = now;
    }
  };

  /** Start campaigns whose time has come and send the next batch of every running one. Called about every second. */
  const tick = (now = Date.now()) => {
    if (!store.featureOn('bulkMessaging')) return 0; // paused: people stay queued, nothing is sent
    let sent = 0;
    for (const c of Object.values(all())) {
      if (c.status === 'scheduled' && c.scheduledAt <= now) { c.status = 'sending'; c.startedAt = now; }
      if (c.status !== 'sending') continue;
      if (store.isClosed(c.owner)) { stop(c, 'owner closed', now); continue; }
      let n = 0;
      for (const r of c.recipients) {
        if (r.s !== 'queued') continue;
        sendOne(c, r, now);
        sent++;
        if (++n >= BATCH) break;
      }
      finishIfDone(c, now);
      store._save();
      notify(c.owner, 'campaign:update', { campaign: summary(c) });
    }
    return sent;
  };

  const stop = (c, by, now = Date.now()) => {
    for (const r of c.recipients) if (r.s === 'queued') r.s = 'cancelled';
    c.status = by === 'owner' ? 'cancelled' : 'stopped';
    if (by !== 'owner') c.stoppedBy = by;
    c.finishedAt = now;
  };

  // ---------- reports ----------

  /** Bring every person's state up to date from their message (delivered / read / replied). */
  const refresh = (c) => {
    let changed = false;
    for (const r of c.recipients) {
      if (!r.m || r.s === 'failed' || r.s === 'cancelled') continue;
      const list = store.data.messages[Store.directId(c.owner, r.u)];
      if (!list) continue;
      let msg = null;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].id === r.m) { msg = list[i]; break; }
      if (!msg) continue; // deleted or expired: keep what was known
      const now = msg.readBy.includes(r.u) ? 'read' : msg.deliveredTo.includes(r.u) ? 'delivered' : 'sent';
      if (RANK[now] > RANK[r.s]) { r.s = now; changed = true; }
      if (!r.rp && list.some((m) => m.from === r.u && m.ts > msg.ts && m.type !== 'system')) { r.rp = true; changed = true; }
    }
    if (changed) store._save();
  };

  const counts = (c) => {
    const n = { total: c.recipients.length, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, cancelled: 0 };
    let replied = 0;
    const reasons = { opted_out: 0, not_delivered: 0 };
    for (const r of c.recipients) {
      n[r.s]++;
      if (r.rp) replied++;
      if (r.s === 'failed') reasons[r.r === 'opted_out' ? 'opted_out' : 'not_delivered']++;
    }
    return {
      ...n,
      // The usual three figures: how many were sent, how many of those arrived, how many were opened.
      cumulative: { sent: n.sent + n.delivered + n.read, delivered: n.delivered + n.read, read: n.read },
      replied,
      failedReasons: reasons,
    };
  };

  const summary = (c) => ({
    id: c.id, name: c.name, text: c.text, status: c.status, audience: c.audience,
    createdAt: c.createdAt, scheduledAt: c.scheduledAt || null, startedAt: c.startedAt || null, finishedAt: c.finishedAt || null,
    ...(c.stoppedBy ? { stoppedBy: c.stoppedBy } : {}),
    counts: counts(c),
  });

  /** One row of the report. The person's name is shown only where the business already knows who they are. */
  const row = (r, c) => {
    const known = c.audience === 'customers' || r.k === 'username';
    const user = known && r.u ? store.publicUser(r.u) : null;
    return {
      to: r.k === 'phone' ? r.n : (r.u || r.n || '—'),
      ...(user ? { username: user.username, displayName: user.displayName } : {}),
      status: r.s,
      ...(r.r ? { reason: r.r } : {}),
      sentAt: r.m ? r.t : null,
      replied: !!r.rp,
    };
  };

  const recipientsPage = (c, { status, limit = 50, offset = 0 } = {}) => {
    if (status && !STATES.includes(status)) throw fail(400, 'invalid_request', `status must be one of ${STATES.join(', ')}`);
    const rows = c.recipients.filter((r) => !status || r.s === status);
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    const from = Math.max(0, Number(offset) || 0);
    return { total: rows.length, items: rows.slice(from, from + n).map((r) => row(r, c)), hasMore: from + n < rows.length };
  };

  /** A typed username or mobile number: who it is (null when there is no such account) and what kind it was. */
  const resolve = (s) => {
    if (/^\+?[\d\s\-().]{8,}$/.test(s)) {
      try { return { k: 'phone', u: store.findByPhone(normalisePhone(s))?.username || null }; } catch { return { k: 'phone', u: null }; }
    }
    const handle = s.replace(/^@/, '').toLowerCase();
    return { k: 'username', u: store.data.users[handle] ? handle : null };
  };

  // ---------- actions ----------

  const requireBusiness = (me) => {
    if (!store.getBusiness(me)) throw fail(403, 'business_required', 'Only business accounts can send campaigns. Turn on your business profile first.');
  };

  const actions = {
    /** What the create screen needs: how many customers there are and what this account's limits are. */
    campaignAudience(me) {
      const limits = limitsOf(me);
      const day = Date.now() - DAY_MS;
      return {
        business: !!store.getBusiness(me),
        customers: store.getBusiness(me) ? customersOf(me).length : 0,
        limits,
        usedToday: Object.values(all()).filter((c) => c.owner === me && c.createdAt > day).length,
        maxNameLength: NAME_MAX, maxTextLength: TEXT_MAX,
      };
    },

    campaignCreate(me, { name, text, audience, to, scheduleAt, confirmed } = {}) {
      requireBusiness(me);
      if (confirmed !== true) throw fail(400, 'confirmation_required', 'Confirm that the people you are sending to agreed to receive messages from your business');
      name = String(name || '').trim();
      text = String(text || '').trim();
      if (!name || name.length > NAME_MAX) throw fail(400, 'invalid_request', `Give the campaign a name (up to ${NAME_MAX} characters)`);
      if (!text || text.length > TEXT_MAX) throw fail(400, 'invalid_request', `The message must be 1 to ${TEXT_MAX} characters`);
      if (!['customers', 'list'].includes(audience)) throw fail(400, 'invalid_request', 'audience must be "customers" or "list"');

      const limits = limitsOf(me);
      const day = Date.now() - DAY_MS;
      if (Object.values(all()).filter((c) => c.owner === me && c.createdAt > day).length >= limits.perDay) {
        throw limits.premium
          ? fail(429, 'campaign_limit', `You can start ${limits.perDay} campaigns a day. Try again tomorrow.`)
          : fail(402, 'premium_required', `Free business accounts can start ${limits.perDay} campaign${limits.perDay === 1 ? '' : 's'} a day. Premium allows ${limits.premiumPerDay}.`);
      }

      const seen = new Set();
      const recipients = [];
      const add = (rec) => {
        const key = rec.u || `?${rec.n}`;
        if (seen.has(key)) return;
        seen.add(key);
        recipients.push({ ...rec, s: 'queued' });
      };
      if (audience === 'customers') {
        for (const u of customersOf(me)) add({ u, k: 'username' });
      } else {
        if (!Array.isArray(to) || !to.length) throw fail(400, 'invalid_request', 'Add the people to send to (usernames or mobile numbers)');
        if (to.length > 5000) throw fail(400, 'too_many_recipients', 'That list is far too long');
        for (const raw of to) {
          const s = String(raw ?? '').trim();
          if (!s) continue;
          const { u, k } = resolve(s);
          if (u === me) continue;
          add({ u, k, n: s.slice(0, 40) });
        }
      }
      if (!recipients.length) throw fail(400, 'no_recipients', audience === 'customers' ? 'Nobody has written to your business yet, so there is no one to send to.' : 'There is nobody to send to');
      if (recipients.length > limits.recipients) {
        throw limits.premium || limits.recipients >= limits.premiumRecipients
          ? fail(400, 'too_many_recipients', `A campaign can reach at most ${limits.recipients} people. This one has ${recipients.length}.`)
          : fail(402, 'premium_required', `Free business accounts can send to ${limits.recipients} people at a time (this has ${recipients.length}). Premium allows ${limits.premiumRecipients}.`);
      }
      // A person or number that has no account is already a failure; no message is made for them.
      for (const r of recipients) if (!r.u) { r.s = 'failed'; r.r = 'not_delivered'; r.t = Date.now(); }

      const now = Date.now();
      let at = null;
      if (scheduleAt !== undefined && scheduleAt !== null && scheduleAt !== '') {
        at = Number(scheduleAt);
        if (!Number.isFinite(at) || at > now + MAX_AHEAD_MS) throw fail(400, 'invalid_request', 'Choose a time within the next 30 days');
        if (at <= now + 5000) at = null;
      }
      const c = {
        id: crypto.randomBytes(6).toString('hex'),
        owner: me, name, text, audience, recipients, confirmedAt: Date.now(),
        status: at ? 'scheduled' : 'sending',
        createdAt: now, scheduledAt: at, startedAt: at ? null : now,
      };
      all()[c.id] = c;
      finishIfDone(c, now); // nobody to send to (all failed)
      store._save();
      return { campaign: summary(c) };
    },

    campaigns(me, { limit = 30, before } = {}) {
      const n = Math.max(1, Math.min(100, Number(limit) || 30));
      const list = Object.values(all()).filter((c) => c.owner === me && (!before || c.createdAt < Number(before)))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, n + 1);
      for (const c of list.slice(0, n)) if (c.status !== 'scheduled') refresh(c);
      return { campaigns: list.slice(0, n).map(summary), hasMore: list.length > n };
    },

    campaignGet(me, { id, status, limit, offset } = {}) {
      const c = mine(me, id);
      refresh(c);
      return { campaign: summary(c), recipients: recipientsPage(c, { status, limit, offset }) };
    },

    /** Stop a campaign that has not finished: people not reached yet are not sent to. Messages already sent stay. */
    campaignCancel(me, { id } = {}) {
      const c = mine(me, id);
      if (!['scheduled', 'sending'].includes(c.status)) throw fail(409, 'conflict', 'This campaign has already finished');
      stop(c, 'owner');
      store._save();
      return { campaign: summary(c) };
    },

    /** Send again to the people it failed for, except those who opted out. */
    campaignRetry(me, { id } = {}) {
      const c = mine(me, id);
      if (!['completed', 'cancelled'].includes(c.status)) throw fail(409, 'conflict', 'Only a finished or cancelled campaign can be retried (one an administrator stopped cannot)');
      const again = [];
      for (const r of c.recipients) {
        if (r.s === 'cancelled') { again.push(r); continue; }
        if (r.s !== 'failed') continue;
        if (!r.u && r.n) r.u = resolve(r.n).u; // the person may have signed up since
        if (!r.u) continue;
        if (r.r === 'opted_out' && store.data.users[r.u]?.promoOptOut?.includes(c.owner)) continue; // still asked us to stop
        again.push(r);
      }
      if (!again.length) throw fail(409, 'conflict', 'There is nobody to retry');
      for (const r of again) { r.s = 'queued'; delete r.r; }
      c.status = 'sending'; delete c.finishedAt;
      store._save();
      return { campaign: summary(c), requeued: again.length };
    },

    campaignDelete(me, { id } = {}) {
      const c = mine(me, id);
      if (['scheduled', 'sending'].includes(c.status)) throw fail(409, 'conflict', 'Cancel the campaign first');
      delete all()[c.id];
      store._save();
      return { ok: true };
    },

    /** The report as a spreadsheet (CSV). */
    campaignCsv(me, { id } = {}) {
      const c = mine(me, id);
      refresh(c);
      const lines = [['Recipient', 'Name', 'Status', 'Reason', 'Sent at', 'Replied'].map(csvCell).join(',')];
      for (const r of c.recipients) {
        const v = row(r, c);
        lines.push([v.to, v.displayName || '', v.status, v.reason || '', v.sentAt ? new Date(v.sentAt).toISOString() : '', v.replied ? 'yes' : 'no'].map(csvCell).join(','));
      }
      return { filename: `campaign-${c.id}.csv`, csv: `﻿${lines.join('\r\n')}\r\n` };
    },

    /** Stop (or start again) receiving campaigns from one business. Always allowed, even when the feature is off. */
    promoPreference(me, { business, receive } = {}) {
      const biz = String(business || '').trim().toLowerCase().replace(/^@/, '');
      if (!store.data.users[biz]) throw fail(404, 'not_found', 'User not found');
      if (typeof receive !== 'boolean') throw fail(400, 'invalid_request', 'receive must be true or false');
      const u = store.data.users[me];
      const list = new Set(u.promoOptOut || []);
      if (receive) list.delete(biz); else list.add(biz);
      u.promoOptOut = [...list];
      store._save();
      return { business: biz, receive };
    },

    promoOptOuts(me) {
      return { optedOut: [...(store.data.users[me]?.promoOptOut || [])] };
    },
  };

  return {
    actions, tick, summary, counts,
    /** Every campaign, newest first, for the administrators. */
    adminList() {
      return Object.values(all()).sort((a, b) => b.createdAt - a.createdAt).map((c) => { refresh(c); return { ...summary(c), owner: c.owner }; });
    },
    /** An administrator stops a campaign (abuse). */
    adminStop(id, admin) {
      const c = all()[String(id)];
      if (!c) throw fail(404, 'not_found', 'Campaign not found');
      if (!['scheduled', 'sending'].includes(c.status)) throw fail(409, 'conflict', 'This campaign has already finished');
      stop(c, `admin:${admin}`);
      store._save();
      notify(c.owner, 'campaign:update', { campaign: summary(c) });
      return summary(c);
    },
    /** A person's deletion was requested: campaigns they own stop (nothing more goes out in their name). */
    stopOwnedBy(owner) {
      for (const c of Object.values(all())) if (c.owner === owner && ['scheduled', 'sending'].includes(c.status)) stop(c, 'owner');
    },
  };
}

module.exports = { createCampaigns, STATES, TEXT_MAX, NAME_MAX };
