/*
 * Bulk messaging for business accounts: the list of campaigns, the "new campaign" form and the delivery report
 * (sent, delivered, read, failed). A campaign sends one message to many people, each in their own chat with the business.
 */
window.createCampaignsController = function createCampaignsController(options) {
  'use strict';

  const { emit, toast, dialog, openPanel, token } = options;

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const STATUS = { scheduled: 'Scheduled', sending: 'Sending', completed: 'Completed', cancelled: 'Cancelled', stopped: 'Stopped by an administrator' };
  const PERSON = { queued: 'Waiting', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', cancelled: 'Cancelled' };
  const REASON = { opted_out: 'Asked not to receive messages from you', not_delivered: 'Could not be delivered' };
  const FILTERS = [['', 'All'], ['queued', 'Waiting'], ['sent', 'Sent'], ['delivered', 'Delivered'], ['read', 'Read'], ['failed', 'Failed']];
  const POLL_MS = 6000;

  const state = { list: [], audience: null, id: null, report: null, people: null, filter: '', timer: null };

  const when = (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

  /** The stacked bar: how much of the campaign has been read, delivered, only sent, failed or is still waiting. */
  function bar(c) {
    const box = el('div', 'cmp-bar');
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', `${c.read} read, ${c.delivered} delivered, ${c.sent} sent, ${c.failed} failed, ${c.queued} waiting`);
    for (const k of ['read', 'delivered', 'sent', 'failed', 'queued']) {
      if (!c[k]) continue;
      const seg = el('span', `seg ${k}`);
      seg.style.width = `${(c[k] / c.total) * 100}%`;
      box.appendChild(seg);
    }
    return box;
  }

  /** "Sent 12 · Delivered 10 · Read 7 · Failed 2": the usual figures (each counts everyone who got further). */
  function figures(c) {
    const f = c.cumulative;
    const row = el('div', 'cmp-figures');
    for (const [label, n, cls] of [['Sent', f.sent, 'sent'], ['Delivered', f.delivered, 'delivered'], ['Read', f.read, 'read'], ['Failed', c.failed, 'failed']]) {
      const s = el('span', `fig ${cls}`);
      s.append(el('strong', '', String(n)), ` ${label}`);
      row.appendChild(s);
    }
    return row;
  }

  // ---------- the list ----------

  async function open() {
    openPanel('#panel-campaigns');
    $('#campaign-list').textContent = '';
    $('#campaign-empty').classList.add('hidden');
    try {
      const [list, aud] = await Promise.all([emit('campaigns', {}), emit('campaign:audience', {})]);
      state.list = list.campaigns;
      state.audience = aud;
    } catch (err) {
      return toast(err.message);
    }
    renderList();
  }

  function renderList() {
    const a = state.audience;
    $('#campaign-limits').textContent = a
      ? `Up to ${a.limits.recipients} people per campaign and ${a.limits.perDay} campaign${a.limits.perDay === 1 ? '' : 's'} a day${a.limits.premium ? '' : ` (Premium: ${a.limits.premiumRecipients} and ${a.limits.premiumPerDay})`}. Started today: ${a.usedToday}.`
      : '';
    const ul = $('#campaign-list');
    ul.textContent = '';
    $('#campaign-empty').classList.toggle('hidden', state.list.length > 0);
    for (const c of state.list) {
      const li = el('li', 'cmp-card');
      li.tabIndex = 0;
      const top = el('div', 'cmp-top');
      top.append(el('strong', 'cmp-name', c.name), el('span', `cmp-status ${c.status}`, c.status === 'scheduled' ? `Scheduled · ${when(c.scheduledAt)}` : STATUS[c.status]));
      li.append(top, el('p', 'muted cmp-text', c.text), bar(c.counts), figures(c.counts), el('small', 'muted', `${c.counts.total} people · ${when(c.createdAt)}`));
      const go = () => openReport(c.id);
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      ul.appendChild(li);
    }
  }

  // ---------- new campaign ----------

  async function create() {
    let aud;
    try { aud = await emit('campaign:audience', {}); } catch (err) { return toast(err.message); }
    if (aud.canSend === false) return toast('Bulk messages can only be sent from an account of someone aged 18 or over.');
    const biz = aud.business;
    const n = biz ? aud.customers : aud.contacts;
    dialog({
      title: 'New campaign',
      text: `Each person gets your message in their own chat with you, and can reply to you alone. Up to ${aud.limits.recipients} people${biz ? '' : ' (only people you already chat with)'}. People under 18, people who blocked you or asked not to hear from you are skipped.`,
      submit: 'Send campaign',
      fields: [
        { name: 'name', label: 'Campaign name (only you see it)', type: 'text', maxLength: 80, placeholder: 'e.g. Diwali offer' },
        { name: 'text', label: 'Message', type: 'textarea', maxLength: 1000, rows: 5 },
        { name: 'audience', label: 'Send to', options: [[biz ? 'customers' : 'contacts', biz ? `My customers: people who wrote to me (${n})` : `My chats: everyone I already chat with (${n})`], ['list', biz ? 'A list I type below' : 'A list I type below (only people I chat with)']], value: n ? (biz ? 'customers' : 'contacts') : 'list' },
        { name: 'to', label: 'List: usernames or mobile numbers (with country code), one per line', type: 'textarea', required: false, maxLength: 50000, rows: 4, placeholder: 'ann\n+91 98765 43210' },
        { name: 'schedule', label: 'Send at (leave empty to send now)', type: 'datetime-local', required: false, maxLength: 40 },
        { name: 'confirmed', type: 'checkbox', label: biz ? 'I confirm that these people agreed to receive messages from my business.' : 'I confirm that these people are happy to get a message like this from me.' },
      ],
      async onSubmit(v) {
        const to = String(v.to || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
        const scheduleAt = v.schedule ? new Date(v.schedule).getTime() : undefined;
        if (v.audience === 'list' && !to.length) throw new Error('Type at least one username or number, or send to your chats');
        const res = await emit('campaign:create', { name: v.name, text: v.text, audience: v.audience, to, scheduleAt, confirmed: v.confirmed === 'on' });
        state.list.unshift(res.campaign);
        toast(res.campaign.status === 'scheduled' ? 'Campaign scheduled' : 'Campaign started');
        setTimeout(() => openReport(res.campaign.id), 0);
      },
    });
  }

  // ---------- the report ----------

  async function openReport(id) {
    state.id = id;
    state.filter = '';
    openPanel('#panel-campaign');
    $('#campaign-report').textContent = '';
    await refresh();
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      if ($('#panel-campaign').classList.contains('hidden')) { clearInterval(state.timer); return; }
      refresh(true);
    }, POLL_MS);
  }

  async function refresh(quiet = false) {
    try {
      const res = await emit('campaign:get', { id: state.id, status: state.filter || undefined, limit: 200 });
      state.report = res.campaign;
      state.people = res.recipients;
    } catch (err) {
      if (!quiet) toast(err.message);
      return;
    }
    renderReport();
  }

  function renderReport() {
    const c = state.report;
    const box = $('#campaign-report');
    box.textContent = '';
    $('#campaign-title').textContent = c.name;
    const n = c.counts;

    const head = el('div', 'cmp-head');
    head.append(el('span', `cmp-status ${c.status}`, c.status === 'scheduled' ? `Scheduled · ${when(c.scheduledAt)}` : STATUS[c.status]),
      el('small', 'muted', c.finishedAt ? `Finished ${when(c.finishedAt)}` : c.startedAt ? `Started ${when(c.startedAt)}` : `Created ${when(c.createdAt)}`));
    box.append(head, el('blockquote', 'cmp-message', c.text), bar(n));

    const grid = el('div', 'cmp-stats');
    const tile = (label, value, sub, cls) => {
      const t = el('div', `cmp-tile ${cls || ''}`);
      t.append(el('div', 'n', String(value)), el('div', 'l', label));
      if (sub) t.appendChild(el('div', 's', sub));
      return t;
    };
    const of = (k) => `${pct(k, n.cumulative.sent || n.total)}%`;
    grid.append(
      tile('People', n.total),
      tile('Sent', n.cumulative.sent, of(n.cumulative.sent), 'sent'),
      tile('Delivered', n.cumulative.delivered, of(n.cumulative.delivered), 'delivered'),
      tile('Read', n.cumulative.read, of(n.cumulative.read), 'read'),
      tile('Failed', n.failed, n.failed ? `${n.failedReasons.opted_out} opted out` : '', 'failed'),
      tile('Replied', n.replied, of(n.replied)),
    );
    if (n.queued) grid.appendChild(tile('Waiting', n.queued, c.status === 'scheduled' ? 'not started' : 'being sent', 'queued'));
    if (n.cancelled) grid.appendChild(tile('Cancelled', n.cancelled));
    box.appendChild(grid);
    box.appendChild(el('p', 'muted small-note', 'Sent = left our servers. Delivered = reached the person\'s phone. Read = they opened the chat. "Failed" does not say why, so you cannot tell who blocked you or which numbers have no account.'));

    const actions = el('div', 'cmp-actions');
    const button = (label, cls, fn) => {
      const b = el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    button('Refresh', 'primary small', () => refresh());
    if (['scheduled', 'sending'].includes(c.status)) button('Cancel campaign', 'link', cancel);
    if (['completed', 'cancelled'].includes(c.status) && (n.failed || n.cancelled)) button('Retry failed', 'link', retry);
    button('Download report (CSV)', 'link', download);
    if (!['scheduled', 'sending'].includes(c.status)) button('Delete', 'danger-link', remove);
    box.appendChild(actions);

    const chips = el('div', 'cmp-filters');
    chips.setAttribute('role', 'group');
    for (const [value, label] of FILTERS) {
      const b = el('button', `cmp-chip${state.filter === value ? ' on' : ''}`, label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.filter === value));
      b.addEventListener('click', () => { state.filter = value; refresh(); });
      chips.appendChild(b);
    }
    box.appendChild(chips);

    const ul = el('ul', 'cmp-people');
    for (const p of state.people.items) {
      const li = el('li');
      const who = el('div', 'who');
      who.append(el('strong', '', p.displayName || p.to), p.displayName ? el('small', 'muted', p.username ? `@${p.username}` : p.to) : '');
      const right = el('div', 'st');
      right.appendChild(el('span', `cmp-pill ${p.status}`, PERSON[p.status]));
      const note = p.reason ? REASON[p.reason] : p.replied ? 'Replied' : p.sentAt ? when(p.sentAt) : '';
      if (note) right.appendChild(el('small', 'muted', note));
      li.append(who, right);
      ul.appendChild(li);
    }
    box.appendChild(ul);
    if (!state.people.items.length) box.appendChild(el('p', 'muted pad', 'Nobody in this group yet.'));
    else if (state.people.hasMore) box.appendChild(el('p', 'muted small-note pad', `Showing the first ${state.people.items.length} of ${state.people.total}. Download the report for everybody.`));
  }

  async function cancel() {
    if (!confirm('Stop this campaign? People who have not been sent the message yet will not get it. Messages already sent stay.')) return;
    try { await emit('campaign:cancel', { id: state.id }); toast('Campaign cancelled'); } catch (err) { toast(err.message); }
    refresh();
  }

  async function retry() {
    try {
      const res = await emit('campaign:retry', { id: state.id });
      toast(`Sending again to ${res.requeued} ${res.requeued === 1 ? 'person' : 'people'}`);
    } catch (err) { toast(err.message); }
    refresh();
  }

  async function remove() {
    if (!confirm('Delete this campaign and its report? The messages already sent stay in the chats.')) return;
    try { await emit('campaign:delete', { id: state.id }); } catch (err) { return toast(err.message); }
    clearInterval(state.timer);
    state.list = state.list.filter((c) => c.id !== state.id);
    open();
  }

  async function download() {
    try {
      const res = await fetch(`/api/v1/campaigns/${encodeURIComponent(state.id)}/report.csv`, { headers: { Authorization: `Bearer ${token()}` } });
      if (!res.ok) throw new Error('Could not download the report');
      const url = URL.createObjectURL(await res.blob());
      const a = el('a');
      a.href = url;
      a.download = `campaign-${state.id}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) { toast(err.message); }
  }

  /** The server says a campaign moved on (a batch went out, or it was stopped). */
  function onUpdate(c) {
    const i = state.list.findIndex((x) => x.id === c.id);
    if (i >= 0) state.list[i] = c;
    if (!$('#panel-campaigns').classList.contains('hidden')) renderList();
    if (state.id === c.id && !$('#panel-campaign').classList.contains('hidden')) refresh(true);
  }

  $('#btn-campaign-new').addEventListener('click', create);
  $('#campaign-back').addEventListener('click', () => { clearInterval(state.timer); open(); });

  return { open, onUpdate };
};
