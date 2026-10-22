'use strict';

const crypto = require('crypto');
const express = require('express');
const { FEATURES } = require('./features');
const { addPeriod } = require('./payments');

/**
 * Administration API for the dashboard at /admin. It is separate from the user API: its own
 * accounts (never regular users), its own short-lived sessions, and every change is written to
 * an audit log. Two roles:
 *  - super:   everything, including feature switches, settings and managing administrators
 *  - support: look at everything and moderate (suspend users, remove channels, handle reports)
 */
function createAdminRouter({ store, service, io, onlineCount, integrations = () => ({}), sessionMs = 8 * 60 * 60 * 1000, loginLimit = { max: 5, windowMs: 15 * 60 * 1000 } }) {
  const router = express.Router();
  const sessions = new Map(); // token -> { admin, role, exp }
  const failures = new Map(); // key -> { count, resetAt }

  const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  router.use(express.json({ limit: '50kb' }));

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [t, s] of sessions) if (s.exp <= now) sessions.delete(t);
    for (const [k, f] of failures) if (f.resetAt <= now) failures.delete(k);
  }, 60 * 1000);
  sweep.unref();

  const run = (fn) => async (req, res, next) => {
    try {
      const result = await fn(req, res);
      if (result === undefined) return res.status(204).end();
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  const auth = (req, res, next) => {
    const token = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const s = token && sessions.get(token);
    if (!s || s.exp <= Date.now() || !store.data.admins[s.admin]) return next(fail(401, 'unauthorized', 'Sign in to the admin dashboard'));
    req.admin = s.admin;
    req.role = store.data.admins[s.admin].role; // roles apply immediately
    req.token = token;
    next();
  };
  const superOnly = (req, res, next) => (req.role === 'super' ? next() : next(fail(403, 'forbidden', 'Only a super admin can do this')));
  const log = (req, action, target, detail) => store.audit(req.admin, action, target, detail);

  // ---------- sign in ----------

  // Lets the dashboard say "no administrator is set up" instead of just failing to sign in.
  router.get('/status', run(() => ({ configured: store.listAdmins().length > 0 })));

  router.post('/login', run((req) => {
    const { username, password } = req.body || {};
    const keys = [`ip:${req.ip}`, `u:${String(username || '').toLowerCase()}`];
    const now = Date.now();
    for (const k of keys) {
      const f = failures.get(k);
      if (f && f.resetAt > now && f.count >= loginLimit.max) throw fail(429, 'rate_limited', 'Too many failed sign-ins. Try again later.');
    }
    const admin = store.verifyAdmin(username, password);
    if (!admin) {
      for (const k of keys) {
        const f = failures.get(k);
        if (!f || f.resetAt <= now) failures.set(k, { count: 1, resetAt: now + loginLimit.windowMs });
        else f.count += 1;
      }
      throw fail(401, 'invalid_credentials', 'Wrong username or password');
    }
    keys.forEach((k) => failures.delete(k));
    const token = `adm_${crypto.randomBytes(24).toString('hex')}`;
    sessions.set(token, { admin: admin.username, exp: now + sessionMs });
    store.audit(admin.username, 'login', null, null);
    return { token, admin, expiresIn: Math.round(sessionMs / 1000) };
  }));

  router.post('/logout', auth, run((req) => {
    sessions.delete(req.token);
    return undefined;
  }));

  router.get('/me', auth, run((req) => ({ admin: { username: req.admin, role: req.role } })));

  // ---------- overview ----------

  router.get('/overview', auth, run(() => ({
    stats: store.stats(onlineCount()),
    config: service.config(),
    integrations: integrations(),
    legal: { configured: require('./legal').details(store.getSettings()).configured, version: require('./legal').VERSION },
    server: { uptimeSeconds: Math.round(process.uptime()), node: process.version, memoryMb: Math.round(process.memoryUsage().rss / 1048576) },
  })));

  // ---------- users ----------

  router.get('/users', auth, run((req) => store.listUsers({ q: req.query.q, filter: req.query.filter, page: req.query.page, pageSize: req.query.pageSize })));

  const user = (req) => {
    const u = store.adminUserView(String(req.params.username || '').toLowerCase());
    if (!u) throw fail(404, 'not_found', 'User not found');
    return u;
  };
  router.get('/users/:username', auth, run((req) => ({ user: user(req) })));

  router.post('/users/:username/suspend', auth, run((req) => {
    const u = user(req);
    store.suspendUser(u.username, req.body?.reason, req.admin);
    io.in(`user:${u.username}`).disconnectSockets(true);
    log(req, 'suspend', u.username, req.body?.reason || null);
    return { user: store.adminUserView(u.username) };
  }));

  router.post('/users/:username/unsuspend', auth, run((req) => {
    const u = user(req);
    store.unsuspendUser(u.username);
    log(req, 'unsuspend', u.username, null);
    return { user: store.adminUserView(u.username) };
  }));

  router.post('/users/:username/logout', auth, run((req) => {
    const u = user(req);
    store.dropSessionsOf(u.username);
    io.in(`user:${u.username}`).disconnectSockets(true);
    log(req, 'force-logout', u.username, null);
    return { user: store.adminUserView(u.username) };
  }));

  router.post('/users/:username/premium', auth, superOnly, run((req) => {
    const u = user(req);
    const { days, revoke } = req.body || {};
    if (revoke) {
      store.setPremiumByAdmin(u.username, null);
      log(req, 'premium-revoke', u.username, null);
    } else {
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw fail(400, 'invalid_request', 'days must be a whole number from 1 to 3650');
      const base = Math.max(Date.now(), store.subscriptionOf(u.username)?.expiresAt || 0);
      store.setPremiumByAdmin(u.username, addPeriod(base, { days }));
      log(req, 'premium-grant', u.username, `${days} days`);
    }
    service.refreshAccount(u.username);
    return { user: store.adminUserView(u.username) };
  }));

  router.post('/users/:username/verified', auth, superOnly, run((req) => {
    const u = user(req);
    if (typeof req.body?.verified !== 'boolean') throw fail(400, 'invalid_request', 'verified must be true or false');
    store.setVerifiedByAdmin(u.username, req.body.verified);
    log(req, req.body.verified ? 'verified-grant' : 'verified-remove', u.username, null);
    service.refreshAccount(u.username);
    return { user: store.adminUserView(u.username) };
  }));

  // ---------- channels and reports ----------

  const channelRow = (c) => ({
    id: c.id, handle: c.handle, name: c.name, owner: c.owner, followers: Object.keys(c.followers).length,
    posts: (store.data.channelPosts[c.id] || []).length, createdAt: c.createdAt,
    reports: store.data.reports.filter((r) => r.channelId === c.id).length,
  });

  router.get('/channels', auth, run((req) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const list = Object.values(store.data.channels)
      .filter((c) => !q || c.handle.includes(q) || c.name.toLowerCase().includes(q) || c.owner.includes(q))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
    return { channels: list.map(channelRow) };
  }));

  router.delete('/channels/:id', auth, run((req) => {
    const ch = store.data.channels[req.params.id];
    if (!ch) throw fail(404, 'not_found', 'Channel not found');
    const followers = store.deleteChannel(ch.owner, ch.id);
    for (const f of followers) io.to(`user:${f}`).emit('channel:deleted', { id: ch.id });
    log(req, 'channel-delete', `@${ch.handle}`, `owner ${ch.owner}`);
    return undefined;
  }));

  router.get('/reports', auth, run(() => ({
    reports: store.data.reports.filter((r) => r.type !== 'photo').map((r) => ({ ...r, channel: store.data.channels[r.channelId] ? { id: r.channelId, handle: store.data.channels[r.channelId].handle, name: store.data.channels[r.channelId].name, owner: store.data.channels[r.channelId].owner } : null })).sort((a, b) => b.ts - a.ts),
  })));

  router.post('/reports/dismiss', auth, run((req) => {
    const { channelId, reporter } = req.body || {};
    const before = store.data.reports.length;
    store.data.reports = store.data.reports.filter((r) => !(r.channelId === channelId && (!reporter || r.reporter === reporter)));
    if (store.data.reports.length === before) throw fail(404, 'not_found', 'Report not found');
    store._save();
    log(req, 'report-dismiss', channelId, reporter || 'all');
    return undefined;
  }));

  // ---------- payments received ----------

  router.get('/payments', auth, run(() => {
    const list = store.allPayments(500);
    const now = Date.now();
    const sum = (rows) => rows.reduce((t, p) => t + p.amount - (p.refundedMinor || 0) / 100, 0);
    const totals = {};
    for (const p of store.allPayments(100000)) {
      const t = (totals[p.currency] ||= { all: 0, last30Days: 0, count: 0 });
      const net = p.amount - (p.refundedMinor || 0) / 100;
      t.all += net;
      t.count += 1;
      if (p.at > now - 30 * 86400000) t.last30Days += net;
    }
    for (const t of Object.values(totals)) { t.all = Math.round(t.all * 100) / 100; t.last30Days = Math.round(t.last30Days * 100) / 100; }
    return { payments: list.map((p) => ({ id: p.id, user: p.username, deleted: !!p.deleted, plan: p.plan, amount: p.amount, currency: p.currency, at: p.at, periodEnd: p.periodEnd, method: p.method || null, provider: p.provider || null, refunded: p.refundedMinor ? p.refundedMinor / 100 : 0 })), totals, shown: sum(list) };
  }));

  // ---------- reported profile photos ----------

  const photoReportView = (g) => ({
    owner: g.owner, photoId: g.photoId, hidden: g.hidden, minor: g.minor, reports: g.reports,
    ownerName: store.data.users[g.owner]?.displayName || g.owner,
  });
  router.get('/photo-reports', auth, run(() => ({ reports: store.photoReports().map(photoReportView) })));

  // The picture itself, for review (administrators only; the owner's privacy setting does not apply to a reported photo).
  router.get('/photo-reports/:owner/:photoId/image', auth, (req, res) => {
    const file = store.photoFile(String(req.params.owner), String(req.params.photoId), req.query.size === 'full' ? 'full' : 'thumb');
    if (!file) return res.status(404).json({ error: { code: 'not_found', message: 'Photo not found' } });
    return res.set('Content-Type', file.mime).send(file.buffer);
  });

  router.post('/photo-reports/dismiss', auth, run((req) => {
    const { owner, photoId } = req.body || {};
    try {
      store.dismissPhotoReports(String(owner), String(photoId));
    } catch (err) {
      throw fail(err.status || 400, err.code || 'invalid_request', err.message);
    }
    service.refreshPhotos(String(owner));
    log(req, 'photo-report-dismiss', String(owner), String(photoId));
    return undefined;
  }));

  router.post('/photo-reports/remove', auth, run((req) => {
    const { owner, photoId } = req.body || {};
    try {
      store.removePhoto(String(owner), String(photoId));
    } catch (err) {
      throw fail(err.status || 400, err.code || 'invalid_request', err.message);
    }
    service.refreshPhotos(String(owner));
    log(req, 'photo-remove', String(owner), String(photoId));
    return undefined;
  }));

  // ---------- settings: feature switches, limits, prices, announcements, maintenance ----------

  router.get('/settings', auth, run(() => ({ settings: store.getSettings(), features: FEATURES })));

  router.put('/settings', auth, superOnly, run((req) => {
    let result;
    try {
      result = store.updateSettings(req.body || {});
    } catch (err) {
      throw fail(err.status || 400, err.code || 'invalid_request', err.message);
    }
    if (result.changes.length) {
      log(req, 'settings', null, result.changes.join('; '));
      service.broadcastConfig(); // every connected app and every mobile client updates at once
    }
    return { settings: result.settings, changes: result.changes };
  }));

  // ---------- audit log ----------

  router.get('/audit', auth, run((req) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    return { entries: store.data.audit.slice(-limit).reverse() };
  }));

  // ---------- administrators ----------

  router.get('/admins', auth, superOnly, run(() => ({ admins: store.listAdmins() })));

  router.post('/admins', auth, superOnly, run((req) => {
    const { username, password, role } = req.body || {};
    const name = String(username || '').trim().toLowerCase();
    if (store.data.admins[name]) throw fail(409, 'conflict', 'That administrator already exists');
    let admin;
    try {
      admin = store.upsertAdmin(name, password, role || 'support');
    } catch (err) {
      throw fail(err.status || 400, 'invalid_request', err.message);
    }
    log(req, 'admin-create', admin.username, admin.role);
    return { admin };
  }));

  router.delete('/admins/:username', auth, superOnly, run((req) => {
    const name = req.params.username;
    if (name === req.admin) throw fail(400, 'invalid_request', 'You cannot remove yourself');
    const target = store.data.admins[name];
    if (target?.role === 'super' && store.listAdmins().filter((a) => a.role === 'super').length < 2) throw fail(400, 'invalid_request', 'There must be at least one super admin');
    store.removeAdmin(name);
    for (const [t, s] of sessions) if (s.admin === name) sessions.delete(t);
    log(req, 'admin-remove', name, null);
    return undefined;
  }));

  router.post('/password', auth, run((req) => {
    const { current, password } = req.body || {};
    if (!store.verifyAdmin(req.admin, current)) throw fail(403, 'forbidden', 'Your current password is wrong');
    try {
      store.upsertAdmin(req.admin, password, req.role);
    } catch (err) {
      throw fail(400, 'invalid_request', err.message);
    }
    // Other sessions of this admin end; this one stays.
    for (const [t, s] of sessions) if (s.admin === req.admin && t !== req.token) sessions.delete(t);
    log(req, 'password-change', req.admin, null);
    return undefined;
  }));

  router.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found' } }));
  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: { code: err.code || (status === 400 ? 'invalid_request' : 'internal_error'), message: status >= 500 ? 'Internal server error' : err.message } });
  });

  router.stop = () => clearInterval(sweep);
  return router;
}

module.exports = { createAdminRouter };
