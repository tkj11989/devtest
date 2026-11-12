/*
 * Find friends: which of the people in my phone's contacts are on VartiQ?
 *
 * The numbers never leave the phone: each one is turned into a SHA-256 fingerprint here and only the fingerprints are sent. The
 * server compares them with its accounts and keeps nothing it was sent. Only people who allow it (Profile, Privacy) and are not
 * blocked are found. Contacts come from the Android app (its Contacts plugin), from the browser's contact picker where there is one
 * (Chrome on Android), or from numbers pasted in.
 */
window.createFindFriends = function createFindFriends(options) {
  'use strict';

  const { emit, toast, openPanel, userRow, openDirect, myPhone } = options;

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const plugin = (name) => window.Capacitor?.Plugins?.[name];
  const nativeContacts = () => !!(window.Capacitor?.isNativePlatform?.() && plugin('Contacts'));
  const pickerContacts = () => !!(navigator.contacts && typeof navigator.contacts.select === 'function');

  // Country calling codes people commonly use, to read a local number like 98765 43210 as +91 98765 43210.
  const CC = ['+91', '+44', '+1', '+61', '+971', '+92', '+880', '+977', '+94', '+65', '+49', '+33', '+86', '+81', '+966', '+974', '+968', '+965', '+973'];
  const countryOf = (phone) => CC.filter((c) => String(phone || '').startsWith(c)).sort((a, b) => b.length - a.length)[0] || null;

  /** A number as E.164 (+919876543210), or null if it is not one we can read. */
  function normalize(raw, cc) {
    let s = String(raw || '').trim().replace(/[\s\-().]/g, '');
    if (!s) return null;
    if (s.startsWith('00')) s = `+${s.slice(2)}`;
    if (!s.startsWith('+')) {
      if (!cc) return null; // a local number and we do not know the country
      s = `${cc}${s.replace(/^0+/, '')}`;
    }
    return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
  }

  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  const state = { matches: [], total: 0 };

  function intro() {
    $('#find-intro').textContent = 'VartiQ checks which of your contacts are here. Each number is turned into a fingerprint on your phone and only the fingerprint is sent; the numbers are not sent and nothing is kept. Only people who allow it (Profile, Privacy) can be found.';
    $('#find-pick').classList.toggle('hidden', !(nativeContacts() || pickerContacts()));
    $('#find-paste').classList.toggle('hidden', nativeContacts() || pickerContacts());
    $('#find-paste-toggle').classList.toggle('hidden', !(nativeContacts() || pickerContacts()));
    $('#find-status').textContent = '';
    $('#find-results').textContent = '';
    $('#find-invite').classList.add('hidden');
  }

  function open() {
    openPanel('#panel-find');
    intro();
  }

  /** The numbers chosen from the phone's contacts (Android app or browser picker). */
  async function fromContacts() {
    if (nativeContacts()) {
      const C = plugin('Contacts');
      const perm = await C.requestPermissions();
      if ((perm.contacts || perm.readContacts) !== 'granted') throw new Error('Contacts were not allowed. You can allow them in Android Settings, Apps, VartiQ, Permissions.');
      const res = await C.getContacts({ projection: { name: true, phones: true } });
      return (res.contacts || []).flatMap((c) => (c.phones || []).map((p) => p.number));
    }
    const chosen = await navigator.contacts.select(['tel'], { multiple: true });
    return chosen.flatMap((c) => c.tel || []);
  }

  /** Look up these numbers and show who is on VartiQ. */
  async function run(rawNumbers) {
    const cc = countryOf(myPhone());
    const numbers = [...new Set(rawNumbers.map((n) => normalize(n, cc)).filter(Boolean))];
    const skipped = rawNumbers.filter((n) => String(n).trim() && !normalize(n, cc)).length; // not a number we can read (repeats are not counted)
    const status = $('#find-status');
    const list = $('#find-results');
    list.textContent = '';
    $('#find-invite').classList.add('hidden');
    if (!numbers.length) {
      status.textContent = 'No readable phone numbers. Use the international form, for example +91 98765 43210.';
      return;
    }
    status.textContent = `Checking ${numbers.length} number${numbers.length === 1 ? '' : 's'}…`;
    const matches = [];
    try {
      const hashes = await Promise.all(numbers.map(sha256));
      for (let i = 0; i < hashes.length; i += 1000) {
        const res = await emit('contacts:match', { hashes: hashes.slice(i, i + 1000) });
        matches.push(...res.matches);
      }
    } catch (err) {
      status.textContent = err.message;
      return;
    }
    state.matches = matches;
    state.total = numbers.length;
    const byUser = new Map(matches.map((m) => [m.user.username, m])); // two numbers of one person count once
    status.textContent = byUser.size
      ? `${byUser.size} of your ${numbers.length} contact${numbers.length === 1 ? '' : 's'} ${byUser.size === 1 ? 'is' : 'are'} on VartiQ${skipped ? ` (${skipped} could not be read)` : ''}.`
      : `None of your ${numbers.length} contact${numbers.length === 1 ? '' : 's'} are on VartiQ yet${skipped ? ` (${skipped} could not be read)` : ''}.`;
    for (const { user, chatting } of byUser.values()) {
      const li = userRow(user);
      const go = el('button', 'primary small row-action', chatting ? 'Chat' : 'Message');
      go.type = 'button';
      go.addEventListener('click', (e) => { e.stopPropagation(); openDirect(user.username); });
      li.appendChild(go);
      li.addEventListener('click', () => openDirect(user.username));
      list.appendChild(li);
    }
    $('#find-invite').classList.toggle('hidden', numbers.length <= byUser.size);
  }

  async function invite() {
    const text = `Join me on VartiQ, a private messenger: ${location.origin}`;
    try {
      if (navigator.share) await navigator.share({ title: 'VartiQ', text, url: location.origin });
      else { await navigator.clipboard.writeText(text); toast('Invitation copied: paste it in any app'); }
    } catch (err) {
      if (err?.name !== 'AbortError') toast('Could not share the invitation');
    }
  }

  $('#find-pick').addEventListener('click', async () => {
    try {
      const numbers = await fromContacts();
      if (numbers.length) await run(numbers);
    } catch (err) {
      if (err?.name !== 'AbortError') $('#find-status').textContent = err.message;
    }
  });
  $('#find-paste-toggle').addEventListener('click', () => $('#find-paste').classList.toggle('hidden'));
  $('#find-go').addEventListener('click', () => run($('#find-numbers').value.split(/[\n,;]+/)));
  $('#find-invite').addEventListener('click', invite);

  return { open, normalize, sha256 };
};
