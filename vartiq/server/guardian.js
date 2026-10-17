'use strict';

/**
 * Children and their parents or guardians.
 *
 * - Everyone gives a date of birth when signing up. Below `minAge` (8 by default) there is no account.
 * - From `minAge` up to 17 a parent or guardian is mandatory: name, relationship and a mobile number or an email
 *   (at least one). The account opens, but can do nothing until the guardian has opened the private link we send them
 *   and agreed ("verifiable parental consent").
 * - The same link is the guardian's control page: switch calls, location sharing, being found by new people and public
 *   channels on or off, disable the account, or delete it. Guardians never see messages (they are end-to-end encrypted).
 * - At 18 everything is released: the controls stop, and the guardian's contact details are erased.
 */

const ADULT_AGE = 18;
const DEFAULT_MIN_AGE = 8;
const RELATIONSHIPS = [
  { id: 'mother', label: 'Mother' },
  { id: 'father', label: 'Father' },
  { id: 'guardian', label: 'Legal guardian' },
  { id: 'other', label: 'Other (with the right to decide for the child)' },
];

/** What a guardian can switch. `default` is where a new account starts (safer for children: strangers cannot find them, no location). */
const CONTROLS = [
  { id: 'calls', label: 'Voice and video calls', help: 'Making and receiving calls.', default: true },
  { id: 'location', label: 'Sharing location', help: 'Sharing a location, once or live, in chats.', default: false },
  { id: 'discoverable', label: 'Being found by new people', help: 'Off: people who are not already chatting with your child cannot find them in search or start a chat or group with them. Your child can still start chats themselves.', default: false },
  { id: 'channels', label: 'Public channels', help: 'Finding, following and creating public channels.', default: true },
];

const defaultControls = () => Object.fromEntries(CONTROLS.map((c) => [c.id, c.default]));

/** `YYYY-MM-DD` that is a real date between 1900 and today, or null. */
function parseBirthDate(value, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  if (y < 1900 || date.getTime() > now) return null;
  return { y, m: mo, d, text: `${m[1]}-${m[2]}-${m[3]}` };
}

/** Age in whole years on the day of `now` (UTC), or null for a missing or bad date. */
function ageOn(birthDate, now = Date.now()) {
  const b = parseBirthDate(birthDate, Infinity);
  if (!b) return null;
  const t = new Date(now);
  let age = t.getUTCFullYear() - b.y;
  if (t.getUTCMonth() + 1 < b.m || (t.getUTCMonth() + 1 === b.m && t.getUTCDate() < b.d)) age -= 1;
  return age;
}

/** The message sent to a guardian (SMS or email). `link` is their private page. */
function guardianMessage({ childName, link, brand = 'VartiQ' }) {
  return `${childName} signed up for ${brand} and named you as their parent or guardian. Please open this private link to see what ${brand} is and to allow or decline: ${link} . If you do not know this person, open it and choose "Not my child", or ignore this message.`;
}

/**
 * The address guardian links are built on: PUBLIC_URL (always, in production), or the address the request came to when
 * that is this machine itself (development). Never an address taken from a request to somewhere else: a child could
 * otherwise make us text a stranger a link to a site of their choosing.
 */
function baseUrl(configured, requestOrigin) {
  if (configured) return String(configured).replace(/\/+$/, '');
  try {
    const u = new URL(requestOrigin);
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return u.origin;
  } catch { /* none */ }
  return null;
}

/** Sends the private link to a guardian's contacts. `otp.notify` applies the limits (no flooding a number or address). */
function createMailer(otp) {
  const contacts = (g) => [
    ...(g.phone ? [{ channel: 'sms', to: g.phone }] : []),
    ...(g.email ? [{ channel: 'email', to: g.email }] : []),
  ];
  /** Returns `{ delivered: true, to: [masked…] }`, or `{ delivered: false, error }`. Never throws. */
  async function send({ childName, token, guardian, base }) {
    const text = guardianMessage({ childName, link: `${base}/guardian/${token}` });
    const reached = [];
    let lastError = null;
    for (const dest of contacts(guardian)) {
      try {
        reached.push((await otp.notify({ ...dest, purpose: 'guardian', text })).sentTo);
      } catch (err) {
        lastError = err;
      }
    }
    return reached.length ? { delivered: true, to: reached } : { delivered: false, error: lastError?.message || 'Could not reach the parent or guardian' };
  }
  return { contacts, send };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The guardian's page, `/guardian/<token>`: reads and writes through `/api/v1/guardian/<token>`. */
function pageHtml({ brand = 'VartiQ' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="referrer" content="no-referrer" />
<title>Parent or guardian page | ${esc(brand)}</title>
<style>
  :root { --bg:#fff; --text:#0B1A33; --muted:#5B6B82; --line:#E1E8F2; --link:#0558B3; --soft:#F1F5FB; --primary:#0670DE; --danger:#C0302A; --ok:#0F7F4E; }
  @media (prefers-color-scheme: dark) { :root { --bg:#07101F; --text:#E6EDF7; --muted:#93A4BE; --line:#1C2C4D; --link:#4DA3FF; --soft:#0C1730; --primary:#1F6FDB; --danger:#FF7A72; --ok:#4FD39B; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 24px; margin: 8px 0 4px; } h2 { font-size: 18px; margin: 24px 0 8px; }
  .muted { color: var(--muted); } a { color: var(--link); }
  .card { background: var(--soft); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin: 12px 0; }
  .row { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-top: 1px solid var(--line); } .row:first-child { border-top: 0; }
  .row input { margin-top: 5px; width: 20px; height: 20px; flex: none; }
  .row small { display: block; color: var(--muted); }
  button { font: inherit; border-radius: 22px; padding: 10px 18px; border: 1px solid var(--line); background: var(--bg); color: var(--text); cursor: pointer; }
  button.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
  button.danger { color: var(--danger); border-color: var(--danger); }
  button:disabled { opacity: .5; cursor: default; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
  .agree { display: flex; gap: 10px; align-items: flex-start; margin: 12px 0; } .agree input { margin-top: 5px; width: 20px; height: 20px; }
  .msg { padding: 10px 12px; border-radius: 8px; margin: 10px 0; } .msg.ok { color: var(--ok); } .msg.err { color: var(--danger); }
  .hidden { display: none; }
</style>
</head>
<body>
<main>
  <p class="muted">${esc(brand)}, a PrayukTech product</p>
  <h1 id="title">Parent or guardian page</h1>
  <p id="loading" class="muted">Loading…</p>
  <p id="error" class="msg err hidden" role="alert"></p>
  <p id="note" class="msg ok hidden" role="status"></p>

  <section id="consent" class="hidden">
    <p id="consent-intro"></p>
    <div class="card">
      <strong>What ${esc(brand)} is</strong>
      <p>${esc(brand)} is a messaging app: chats, groups, voice and video calls, status updates and public channels. Messages typed in the app are end-to-end encrypted, so we cannot read them, and neither can you through this page.</p>
      <strong>What we keep about your child</strong>
      <p id="consent-data"></p>
      <p><a id="link-privacy" href="/legal/privacy" target="_blank" rel="noopener">Privacy Notice</a> · <a id="link-terms" href="/legal/terms" target="_blank" rel="noopener">Terms of Use</a></p>
    </div>
    <label class="agree"><input type="checkbox" id="agree" /> <span id="agree-text"></span></label>
    <div class="actions">
      <button class="primary" id="btn-consent" disabled>I agree: allow my child to use ${esc(brand)}</button>
      <button class="danger" id="btn-decline">No, delete this account</button>
    </div>
    <p class="muted">Not your child? Choose "No, delete this account": the account and everything it holds is removed.</p>
  </section>

  <section id="manage" class="hidden">
    <p id="manage-intro"></p>
    <h2>What your child can do</h2>
    <p id="premium-note" class="msg hidden"><strong>Premium feature.</strong> Changing these is part of ${esc(brand)} Premium, which is bought in your child's app (Profile, Premium). Until then the safe settings below stay as they are: no location sharing, and not findable by new people. You can still disable or delete the account here.</p>
    <div class="card" id="controls"></div>
    <p class="muted">Changes apply at once. Your child sees which of these are off.</p>
    <h2>Pause or delete the account</h2>
    <div class="actions">
      <button id="btn-disable">Disable the account for now</button>
      <button id="btn-enable" class="primary hidden">Enable the account again</button>
      <button class="danger" id="btn-delete">Delete the account</button>
    </div>
    <p class="muted">Disabling signs your child out everywhere and stops them logging in until you enable it again. Deleting is permanent: the account is disabled now and the chats and personal data are erased within 24 hours.</p>
    <p class="muted">At 18 these controls end and your contact details are erased from the account.</p>
  </section>
</main>
<script>
(function () {
  var token = location.pathname.split('/').filter(Boolean).pop();
  var api = '/api/v1/guardian/' + encodeURIComponent(token);
  var $ = function (id) { return document.getElementById(id); };
  var state = null;
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  function fail(msg) { $('error').textContent = msg; show('error', !!msg); }
  function ok(msg) { $('note').textContent = msg; show('note', !!msg); }
  function call(method, path, body) {
    return fetch(api + path, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error((j.error && j.error.message) || 'Something went wrong'); return j; }); });
  }
  function render(s) {
    state = s;
    show('loading', false);
    var name = s.child.displayName;
    $('title').textContent = 'Parent or guardian page for ' + name;
    show('consent', s.state === 'pending');
    show('manage', s.state === 'active');
    if (s.state === 'pending') {
      $('consent-intro').textContent = name + ' (username ' + s.child.username + ') signed up for ${esc(brand)} and named you as their ' + s.relationship + '. Because they are under 18, ${esc(brand)} needs your permission first. Until you agree, the account cannot be used.';
      $('consent-data').textContent = 'Their name, username, mobile number, date of birth, chats and settings, and your contact details and your decision. We never sell data, and children are never shown ads. You can change your mind at any time from this page.';
      $('agree-text').textContent = 'I am ' + name + '\\'s ' + s.relationship + ', or have the legal right to decide for them. I have read the Privacy Notice and Terms of Use and I allow ' + name + ' to use ${esc(brand)}.';
    }
    if (s.state === 'active') {
      var locked = !s.premium;
      show('premium-note', locked);
      $('manage-intro').textContent = 'You allowed ' + name + ' to use ${esc(brand)}' + (s.consentedAt ? ' on ' + new Date(s.consentedAt).toLocaleDateString() : '') + '.' + (s.disabled ? ' The account is disabled right now.' : '');
      var box = $('controls'); box.textContent = '';
      s.controlList.forEach(function (c) {
        var row = document.createElement('label'); row.className = 'row';
        var input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!s.controls[c.id]; input.disabled = locked;
        input.addEventListener('change', function () {
          var patch = {}; patch[c.id] = input.checked; input.disabled = true;
          call('PUT', '/controls', patch).then(function (r) { render(r); ok('Saved'); }).catch(function (e) { input.checked = !input.checked; fail(e.message); }).then(function () { input.disabled = false; });
        });
        var text = document.createElement('span'); var b = document.createElement('strong'); b.textContent = c.label;
        var sm = document.createElement('small'); sm.textContent = c.help;
        text.appendChild(b); text.appendChild(sm); row.appendChild(input); row.appendChild(text); box.appendChild(row);
      });
      show('btn-disable', !s.disabled); show('btn-enable', !!s.disabled);
    }
  }
  function load() {
    call('GET', '').then(render).catch(function (e) { show('loading', false); fail(e.message); });
  }
  $('agree').addEventListener('change', function () { $('btn-consent').disabled = !$('agree').checked; });
  $('btn-consent').addEventListener('click', function () {
    $('btn-consent').disabled = true;
    call('POST', '/consent', { agree: true }).then(function (r) { render(r); fail(''); ok('Thank you. ' + r.child.displayName + ' can now use ${esc(brand)}.'); }).catch(function (e) { fail(e.message); $('btn-consent').disabled = false; });
  });
  function remove() {
    if (!confirm('Delete this account? It is disabled now, and the chats and personal data are erased within 24 hours. This cannot be undone.')) return;
    call('POST', '/delete', { confirmed: true }).then(function () { show('consent', false); show('manage', false); fail(''); ok('The account is deleted. Its data will be erased within 24 hours.'); }).catch(function (e) { fail(e.message); });
  }
  $('btn-decline').addEventListener('click', remove);
  $('btn-delete').addEventListener('click', remove);
  $('btn-disable').addEventListener('click', function () { call('POST', '/disable').then(function (r) { render(r); fail(''); ok('The account is disabled.'); }).catch(function (e) { fail(e.message); }); });
  $('btn-enable').addEventListener('click', function () { call('POST', '/enable').then(function (r) { render(r); fail(''); ok('The account is enabled again.'); }).catch(function (e) { fail(e.message); }); });
  load();
}());
</script>
</body>
</html>`;
}

module.exports = { ADULT_AGE, DEFAULT_MIN_AGE, RELATIONSHIPS, CONTROLS, defaultControls, parseBirthDate, ageOn, guardianMessage, baseUrl, createMailer, pageHtml };
