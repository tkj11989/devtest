/* global io */
'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const EMOJIS = ['😀', '😂', '🤣', '😊', '😍', '😘', '😎', '🤔', '😅', '😢', '😭', '😡', '👍', '👎', '👏', '🙏',
    '💪', '🎉', '❤️', '🔥', '✨', '💯', '✅', '👀', '🙌', '🤝', '👋', '😴', '🤗', '😇', '🥳', '😜'];

  const state = {
    token: null,
    me: null,
    socket: null,
    conversations: new Map(), // id -> conversation summary
    users: {}, // username -> public user (+online)
    messages: new Map(), // convId -> [message]
    activeId: null,
    typing: new Map(), // convId -> Map(username -> timeout)
    filter: '',
    groupMembers: new Set(),
    iceServers: [],
    calls: null, // call controller (see call.js)
    outbox: new Map(), // clientId -> my message not yet confirmed by the server
    revealed: new Set(), // ids of masked messages this viewer chose to reveal
    showOriginal: new Set(), // translated messages the viewer switched back to the original
    languages: [], // languages offered for translation
    maskNext: false, // composer: send the next message masked
    blocked: new Set(), // usernames I have blocked
    lock: { hasCode: false, lockedChats: new Set(), biometric: [] }, // chat lock settings
    hiddenOpen: false, // hidden chats revealed in this page load
    bioPlatform: false, // this device has a fingerprint/face sensor
    defaultDisappear: null, // my timer (seconds) for chats I start
    myBusiness: null, // my business profile (with greeting/away), or null
    voiceUrls: new Map(), // mediaId -> object URL of downloaded voice audio
  };

  // Chat lock: unlocked chats stay open only for this page load. Reloading the app or
  // logging in again starts a new app session in which locked chats are locked again.
  const APP_SESSION = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-z0-9-]/gi, '');

  // ---------- helpers ----------

  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // Avatar colours: brand blues and orange plus companions (all readable with white initials).
  const COLORS = ['#0670DE', '#C24E08', '#003D82', '#0A72B0', '#6A4BD8', '#C2387A', '#0F7F72', '#9A5B00', '#3F51B5', '#4A5C78'];
  const colorFor = (s) => {
    let h = 0;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  };
  const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join('') || '?';

  function avatar(name, key, { online = false, cls = 'avatar', group = false } = {}) {
    const a = el(cls === 'avatar-btn' ? 'button' : 'div', cls);
    paintAvatar(a, name, key, { online, group });
    return a;
  }
  /**
   * A round picture: the person's photo when I may see one, else their initials on a colour. Photos need my login to
   * download, so they are fetched with it and shown from memory (`big`: the 512 px picture, else the thumbnail).
   */
  function paintAvatar(node, name, key, { online = false, group = false, big = false } = {}) {
    node.style.background = colorFor(key || name);
    node.textContent = group ? '👥' : initials(name);
    node.classList.toggle('online', online);
    node.classList.remove('has-photo');
    const photo = !group && state.users?.[key]?.photo;
    const id = photo && (big ? photo.id : photo.thumb);
    node.dataset.photo = id || '';
    if (id) {
      photoUrl(id).then((url) => {
        if (!url || node.dataset.photo !== id) return;
        node.style.background = `center / cover no-repeat url("${url}")`;
        node.textContent = '';
        node.classList.add('has-photo');
      });
    }
  }
  const photoUrls = new Map(); // media id -> Promise of an object URL
  function photoUrl(id) {
    if (!photoUrls.has(id)) {
      photoUrls.set(id, fetch(`/media/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${state.token}` } })
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? URL.createObjectURL(b) : (photoUrls.delete(id), null)))
        .catch(() => { photoUrls.delete(id); return null; }));
    }
    return photoUrls.get(id);
  }

  const displayName = (u) => state.users[u]?.displayName || u;

  const timeOf = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  function dayLabel(ts) {
    const now = Date.now();
    if (sameDay(ts, now)) return 'Today';
    if (sameDay(ts, now - 864e5)) return 'Yesterday';
    return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function listTime(ts) {
    if (sameDay(ts, Date.now())) return timeOf(ts);
    if (sameDay(ts, Date.now() - 864e5)) return 'Yesterday';
    return new Date(ts).toLocaleDateString();
  }
  function lastSeenText(u) {
    const user = state.users[u];
    if (!user) return '';
    if (user.online) return 'online';
    if (!user.lastSeen) return '';
    const ts = user.lastSeen;
    if (sameDay(ts, Date.now())) return `last seen today at ${timeOf(ts)}`;
    if (sameDay(ts, Date.now() - 864e5)) return `last seen yesterday at ${timeOf(ts)}`;
    return `last seen ${new Date(ts).toLocaleDateString()}`;
  }

  const convTitle = (c) => (c.type === 'group' ? c.name : displayName(c.members.find((m) => m !== state.me.username)));
  const convPeer = (c) => (c.type === 'direct' ? c.members?.find((m) => m !== state.me.username) : null);

  /**
   * Status of a message I sent:
   *   'sending'   on its way to the server
   *   'pending'   on the server but not yet delivered to every recipient
   *   'delivered' delivered to every recipient
   *   'read'      read by every recipient
   *   'failed'    could not be sent (tap to retry)
   */
  function statusOf(msg, conv) {
    if (msg.localStatus) return msg.localStatus; // 'sending' | 'failed'
    const others = conv.members.filter((m) => m !== msg.from);
    if (others.length && others.every((m) => msg.readBy.includes(m))) return 'read';
    if (others.length && others.every((m) => msg.deliveredTo.includes(m))) return 'delivered';
    return 'pending';
  }

  // Icons in public/icons/ (cut from the design sheet by tools/extract-status-icons.py)
  const ICON_LABELS = {
    sending: 'Sending',
    pending: 'Not delivered yet',
    delivered: 'Delivered',
    read: 'Read',
    failed: 'Not sent',
    deleted: 'Deleted',
    masked: 'Masked',
    typing: 'Typing',
    recording: 'Recording audio',
    blocked: 'Blocked',
    starred: 'Starred',
    offline: 'Offline',
    call: 'Call',
    calling: 'Call in progress',
    'call-end': 'Missed call',
    'call-declined': 'Declined call',
    'group-call': 'Group call',
    'on-hold': 'On hold',
  };
  // Load every icon up front so they still show while offline (e.g. "failed").
  const preloadedIcons = Object.keys(ICON_LABELS).map((name) => {
    const img = new Image();
    img.src = `icons/${name}.png`;
    return img;
  });

  function icon(name, cls = 'status-icon') {
    const img = el('img', `${cls} icon-${name}`);
    img.src = `icons/${name}.png`;
    img.alt = ICON_LABELS[name];
    img.title = ICON_LABELS[name];
    img.draggable = false;
    return img;
  }

  // ---------- call history entries ----------

  const fmtDuration = (s) => (s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

  /** Title, subtitle and icon for a call entry from my point of view. */
  function describeCall(m) {
    const { kind, status, duration, group, joined = [] } = m.call;
    const me = state.me.username;
    const mine = m.from === me;
    const noun = `${group ? 'group ' : ''}${kind === 'video' ? 'video call' : 'voice call'}`;
    const missed = group ? !mine && !joined.includes(me) : !mine && status !== 'completed';
    const title = missed ? `Missed ${noun}` : noun[0].toUpperCase() + noun.slice(1);
    let sub;
    let iconName;
    if (missed) [sub, iconName] = ['Tap to call back', 'call-end'];
    else if (status === 'completed') [sub, iconName] = [`${fmtDuration(duration)}${m.call.recorded ? ' · Recorded' : ''}`, group ? 'group-call' : 'call'];
    else if (status === 'declined') [sub, iconName] = ['Declined', 'call-declined'];
    else [sub, iconName] = ['No answer', 'call-end'];
    return { title, sub, missed, icon: iconName };
  }

  const emit = (event, payload) => new Promise((resolve, reject) => {
    state.socket.emit(event, payload, (res) => {
      if (res?.code === 'consent_required') showConsentGate(); // the Terms or Privacy Notice changed while the app was open
      if (res?.code === 'guardian_required') showGuardianGate(null); // the account is waiting for the parent or guardian
      if (!(res && res.ok)) return reject(Object.assign(new Error(res?.error || 'Request failed'), { code: res?.code }));
      // End-to-end encrypted messages in the reply are decrypted before anyone sees them.
      decryptPayload(res).then(() => resolve(res), () => resolve(res));
    });
  });

  // ---------- end-to-end encryption ----------

  /** Decrypt an encrypted message in place: `text` becomes readable; failures are marked `undecryptable`. */
  async function readMessage(m) {
    if (!m?.e2ee) return m;
    m.encrypted = true;
    if (m.deleted || m.text || m.undecryptable) return m;
    if (!state.e2ee?.ready || !m.e2ee.w[state.e2ee.deviceId]) {
      m.undecryptable = true; // sent before this device had its key, or no key here
      return m;
    }
    try {
      const { payload } = await state.e2ee.decrypt(m);
      if (m.type !== 'voice') m.text = payload.t ?? '';
      if (m.type === 'location') m.loc = window.Place.clean(payload.loc);
    } catch (err) {
      console.warn('Could not decrypt a message:', err.message);
      m.undecryptable = true;
    }
    return m;
  }

  /** Decrypt every message found in a server reply or event (history, previews, stars, new messages). */
  async function decryptPayload(res) {
    const jobs = [];
    const add = (m) => { if (m?.e2ee) jobs.push(readMessage(m)); };
    res.messages?.forEach(add);
    add(res.message);
    add(res.conversation?.lastMessage);
    res.conversations?.forEach((c) => add(c.lastMessage));
    if (jobs.length) await Promise.all(jobs);
  }

  /** Text for a message in lists and previews. */
  const previewText = (m) => (m.undecryptable ? '🔒 Encrypted message' : m.type === 'location' ? (m.live ? '📍 Live location' : '📍 Location') : m.masked ? 'Masked message' : m.text);

  const openLockSvg = () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'plain-mark');
    svg.innerHTML = '<path d="M12 1a5 5 0 0 0-5 5h2a3 3 0 1 1 6 0v3H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V11a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Z"/>';
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = 'Not end-to-end encrypted';
    svg.appendChild(title);
    return svg;
  };

  // ---------- auth ----------

  // Sign up and log in with one-time codes: a mobile number for individuals,
  // mobile number + email (both verified) for businesses.

  const COUNTRY_CODES = [
    ['IN', '+91'], ['US', '+1'], ['GB', '+44'], ['AE', '+971'], ['SA', '+966'], ['QA', '+974'], ['SG', '+65'],
    ['AU', '+61'], ['CA', '+1'], ['DE', '+49'], ['FR', '+33'], ['NL', '+31'], ['IT', '+39'], ['ES', '+34'],
    ['IE', '+353'], ['NZ', '+64'], ['JP', '+81'], ['CN', '+86'], ['HK', '+852'], ['MY', '+60'], ['ID', '+62'],
    ['PH', '+63'], ['TH', '+66'], ['PK', '+92'], ['BD', '+880'], ['NP', '+977'], ['LK', '+94'], ['ZA', '+27'],
    ['NG', '+234'], ['KE', '+254'], ['EG', '+20'], ['BR', '+55'], ['MX', '+52'], ['RU', '+7'],
  ];
  const flag = (cc) => String.fromCodePoint(...[...cc].map((ch) => 0x1f1a5 + ch.charCodeAt(0)));
  (() => {
    const select = $('#auth-form [name=cc]');
    const region = (navigator.language || '').split('-')[1]?.toUpperCase();
    for (const [cc, dial] of COUNTRY_CODES) select.appendChild(new Option(`${flag(cc)} ${dial}`, `${cc}${dial}`));
    select.value = COUNTRY_CODES.some(([cc]) => cc === region) ? COUNTRY_CODES.find(([cc]) => cc === region).join('') : 'IN+91';
    const gselect = $('#auth-form [name=gcc]');
    for (const [cc, dial] of COUNTRY_CODES) gselect.appendChild(new Option(`${flag(cc)} ${dial}`, `${cc}${dial}`));
    gselect.value = select.value;
    const category = $('#auth-form [name=category]');
    for (const c of window.BusinessHours.CATEGORIES) category.appendChild(new Option(c, c));
  })();

  /** "+91" + "98765 43210" -> "+919876543210"; a number typed with "+" keeps its own code. */
  function fullPhone(form) {
    const typed = form.phone.value.trim();
    if (/^(\+|00)/.test(typed)) return typed;
    return `${form.cc.value.replace(/^[A-Z]+/, '')}${typed.replace(/^0+/, '')}`;
  }

  async function apiPost(path, body, token) {
    const res = await fetch(`/api/v1${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Version': CLIENT_VERSION, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error?.message || 'Something went wrong'), { code: data.error?.code });
    return data;
  }

  /**
   * A "send code / enter code" field. `send()` asks the server for a code and returns
   * its reply; `proof()` gives `{ requestId, code }` once a code was sent and typed.
   */
  function createOtpField(root, { destination, request, onError }) {
    const codeInput = root.querySelector('.otp-code input');
    const hint = root.querySelector('.otp-hint');
    const sendBtn = root.querySelector('.resend');
    let sent = null; // { requestId, to }
    let timer = null;

    const countdown = (seconds, sentTo, devCode) => {
      clearInterval(timer);
      let left = seconds;
      const paint = () => {
        hint.textContent = `Code sent to ${sentTo}.`;
        if (devCode) hint.append(' ', el('span', 'dev-code', `Dev code: ${devCode}`));
        sendBtn.disabled = left > 0;
        sendBtn.textContent = left > 0 ? `Resend in ${left}s` : 'Resend code';
      };
      paint();
      timer = setInterval(() => {
        left -= 1;
        paint();
        if (left <= 0) clearInterval(timer);
      }, 1000);
    };

    const reset = () => {
      clearInterval(timer);
      sent = null;
      codeInput.value = '';
      hint.textContent = '';
      sendBtn.disabled = false;
      sendBtn.textContent = 'Resend code';
      root.querySelector('.otp-code').classList.add('hidden');
    };

    async function send() {
      const to = destination();
      sendBtn.disabled = true;
      try {
        const res = await request(to);
        sent = { requestId: res.requestId, to };
        root.querySelector('.otp-code').classList.remove('hidden');
        countdown(res.resendIn, res.sentTo, res.devCode);
        codeInput.focus();
        return true;
      } catch (err) {
        sendBtn.disabled = false;
        onError(err.message);
        return false;
      }
    }

    sendBtn.addEventListener('click', () => { onError(''); send(); });
    // Changing the number/email after a code was sent means a new code is needed.
    root.querySelectorAll('.otp-input-row input, .otp-input-row select').forEach((input) => input.addEventListener('input', () => {
      if (sent && destination() !== sent.to) reset();
    }));
    codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6); });

    return {
      send,
      reset,
      get sent() { return !!sent; },
      get ready() { return !!sent && /^\d{6}$/.test(codeInput.value); },
      proof: () => ({ requestId: sent.requestId, code: codeInput.value }),
      focusCode: () => codeInput.focus(),
    };
  }

  /** A short name for this browser, shown in "Link a browser" on the phone. */
  const browserName = () => {
    const ua = navigator.userAgent;
    const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const o = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    return o ? `${b} on ${o}` : b;
  };
  const authForm = $('#auth-form');
  const auth = { mode: 'login', type: 'individual', loginBy: 'phone', passcode: false };
  const authError = (text) => { $('#auth-error').textContent = text; };
  const purpose = () => (auth.mode === 'login' ? 'login' : 'register');
  const phoneField = createOtpField(authForm.querySelector('[data-field=phone]'), {
    destination: () => fullPhone(authForm),
    request: (phone) => apiPost('/auth/otp', { purpose: purpose(), phone, ...(auth.mode === 'login' ? { clientType: 'web' } : {}) }).catch((err) => {
      // A browser cannot use an SMS code while the phone is signed in: ask for the passcode from the phone instead.
      if (err.code === 'passcode_required') {
        auth.passcode = true;
        paintAuth();
        $('#passcode-box input').focus();
      }
      throw err;
    }),
    onError: (text) => authError(auth.passcode ? '' : text),
  });
  const emailField = createOtpField(authForm.querySelector('[data-field=email]'), {
    destination: () => authForm.email.value.trim(),
    request: (email) => apiPost('/auth/otp', { purpose: purpose(), email }),
    onError: authError,
  });

  /** Which code fields this form needs, in order. */
  const neededFields = () => {
    if (auth.mode === 'login') return auth.passcode ? [] : [auth.loginBy === 'email' ? emailField : phoneField];
    // An individual's email is optional; when they type one it is verified with a code too.
    return auth.type === 'business' || authForm.email.value.trim() ? [phoneField, emailField] : [phoneField];
  };

  // Age: below the minimum there is no account; under 18 a parent or guardian is mandatory.
  const ADULT_AGE = () => state.config?.limits?.adultAge || 18;
  const MIN_AGE = () => state.config?.limits?.minAge || 8;
  function ageFromInput() {
    const v = authForm.birthDate.value;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return null;
    const born = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const now = new Date();
    if (born.getUTCFullYear() < 1900 || born > now) return null;
    let age = now.getUTCFullYear() - born.getUTCFullYear();
    if (now.getUTCMonth() < born.getUTCMonth() || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate())) age -= 1;
    return age;
  }
  /** Show the parent or guardian fields to someone old enough to sign up but under 18. */
  function paintGuardianBox() {
    const age = ageFromInput();
    const needs = auth.mode === 'register' && auth.type === 'individual' && age !== null && age >= MIN_AGE() && age < ADULT_AGE();
    $('#guardian-box').classList.toggle('hidden', !needs);
    return needs;
  }
  /** What is wrong with the age (or the guardian's details), as { text, field }, or null. */
  function checkAgeAndGuardian() {
    const age = ageFromInput();
    if (age === null) return { text: 'Enter your date of birth', field: authForm.birthDate };
    if (age < MIN_AGE()) return { text: `VartiQ is for people aged ${MIN_AGE()} and over.`, field: authForm.birthDate };
    if (age >= ADULT_AGE()) return null;
    if (auth.type === 'business') return { text: 'A business account must be opened by an adult (18 or over)', field: authForm.birthDate };
    if (!authForm.gName.value.trim()) return { text: "Enter your parent's or guardian's name", field: authForm.gName };
    if (!authForm.gRel.value) return { text: 'Choose how they are related to you', field: authForm.gRel };
    if (!authForm.gPhone.value.trim() && !authForm.gEmail.value.trim()) return { text: "Enter your parent's or guardian's mobile number or email (at least one)", field: authForm.gPhone };
    if (authForm.gPhone.value.trim() && guardianPhone() === fullPhone(authForm)) return { text: "Their mobile number must be different from yours", field: authForm.gPhone };
    return null;
  }
  const guardianPhone = () => {
    const typed = authForm.gPhone.value.trim();
    if (!typed) return '';
    return /^(\+|00)/.test(typed) ? typed : `${authForm.gcc.value.replace(/^[A-Z]+/, '')}${typed.replace(/^0+/, '')}`;
  };

  function paintAuth() {
    const register = auth.mode === 'register';
    const business = register && auth.type === 'business';
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === auth.mode));
    document.querySelectorAll('.seg').forEach((b) => {
      b.classList.toggle('active', b.dataset.type === auth.type);
      b.setAttribute('aria-checked', String(b.dataset.type === auth.type));
    });
    authForm.querySelectorAll('.register-only').forEach((n) => n.classList.toggle('hidden', !register));
    authForm.querySelectorAll('.business-only').forEach((n) => n.classList.toggle('hidden', !business));
    authForm.querySelectorAll('.login-only').forEach((n) => n.classList.toggle('hidden', register));
    const usePhone = register || auth.loginBy === 'phone';
    const useEmail = register || (!register && auth.loginBy === 'email' && !auth.passcode);
    authForm.querySelector('[data-field=phone]').classList.toggle('hidden', !usePhone);
    authForm.querySelector('[data-field=email]').classList.toggle('hidden', !useEmail);
    $('#passcode-box').classList.toggle('hidden', register || !auth.passcode);
    $('#auth-email-label').textContent = register && !business ? 'Email (optional)' : 'Email';
    $('#auth-email').placeholder = business ? 'you@business.com' : register ? 'you@example.com' : 'Your business email';
    $('#auth-name-label').textContent = business ? 'Business name' : 'Your name';
    $('#auth-use-email').textContent = auth.loginBy === 'email' ? 'Log in with mobile number instead' : 'Business account? Log in with email';
    paintGuardianBox();
    $('#auth-lead').textContent = !register && auth.passcode ? 'Log in on this browser with your mobile number and a passcode from the VartiQ app on your phone.'
      : !register
      ? (auth.loginBy === 'email' ? 'Log in with your business email. We\'ll email you a code.' : 'Log in with your mobile number. We\'ll send you a code by SMS.')
      : (business ? 'Business accounts verify both a mobile number and an email address.' : 'Sign up with your mobile number. We\'ll verify it with a code by SMS.');
    paintSubmit();
  }

  function paintSubmit() {
    const pending = neededFields().find((f) => !f.sent);
    $('#auth-submit').textContent = pending ? 'Send code' : auth.mode === 'login' ? 'Log in' : auth.type === 'business' ? 'Create business account' : 'Create account';
  }

  function setAuthMode(mode) {
    auth.mode = mode;
    auth.passcode = false;
    phoneField.reset();
    emailField.reset();
    authError('');
    paintAuth();
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
  document.querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => {
    auth.type = b.dataset.type;
    emailField.reset();
    authError('');
    paintAuth();
  }));
  $('#passcode-back').addEventListener('click', () => {
    auth.passcode = false;
    phoneField.reset();
    authError('');
    paintAuth();
  });
  $('#auth-use-email').addEventListener('click', () => {
    auth.passcode = false;
    auth.loginBy = auth.loginBy === 'email' ? 'phone' : 'email';
    phoneField.reset();
    emailField.reset();
    authError('');
    paintAuth();
  });
  authForm.addEventListener('input', () => { authError(''); paintGuardianBox(); paintSubmit(); });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError('');
    const register = auth.mode === 'register';
    const business = register && auth.type === 'business';
    if (register && !authForm.displayName.value.trim()) {
      authError(business ? 'Enter your business name' : 'Enter your name');
      return authForm.displayName.focus();
    }
    if (business && !authForm.category.value) {
      authError('Choose a business category');
      return authForm.category.focus();
    }
    if (register) {
      const problem = checkAgeAndGuardian();
      if (problem) {
        authError(problem.text);
        return problem.field.focus();
      }
    }
    // Agreement comes first: nothing is sent to anyone's phone before the person has agreed.
    if (register && !authForm.agreeTerms.checked) {
      authError('Please accept the Terms of Use and Privacy Notice to create an account');
      return authForm.agreeTerms.focus();
    }
    if (register && !state.legal) {
      authError('Could not load the Terms of Use and Privacy Notice. Check your connection and try again.');
      return loadLegal();
    }
    // Step through the codes: send the next one that wasn't sent, then ask for any missing code.
    const submit = $('#auth-submit');
    submit.disabled = true;
    try {
      const fields = neededFields();
      const unsent = fields.find((f) => !f.sent);
      if (unsent) {
        await unsent.send();
        return;
      }
      const missing = fields.find((f) => !f.ready);
      if (missing) {
        authError('Enter the 6-digit code we sent you');
        return missing.focusCode();
      }
      let data;
      if (!register && auth.passcode) {
        const linkCode = authForm.linkCode.value.replace(/\D/g, '');
        if (!/^\d{6}$/.test(linkCode)) {
          authError('Enter the 6-digit passcode from your phone');
          return authForm.linkCode.focus();
        }
        if (!authForm.phone.value.trim()) {
          authError('Enter your mobile number');
          return authForm.phone.focus();
        }
        data = await apiPost('/auth/login', { phone: fullPhone(authForm), linkCode, clientType: 'web', deviceName: browserName() });
      } else if (!register) {
        const by = auth.loginBy === 'email' ? { email: authForm.email.value.trim() } : { phone: fullPhone(authForm) };
        data = await apiPost('/auth/login', { ...by, ...(auth.loginBy === 'email' ? emailField : phoneField).proof() });
      } else {
        data = await apiPost('/auth/register', {
          accountType: auth.type,
          displayName: authForm.displayName.value.trim(),
          phone: fullPhone(authForm),
          phoneOtp: phoneField.proof(),
          consent: { terms: true, version: state.legal.version },
          birthDate: authForm.birthDate.value,
          ...(paintGuardianBox() ? {
            guardian: {
              name: authForm.gName.value.trim(),
              relationship: authForm.gRel.value,
              ...(authForm.gPhone.value.trim() ? { phone: guardianPhone() } : {}),
              ...(authForm.gEmail.value.trim() ? { email: authForm.gEmail.value.trim() } : {}),
            },
          } : {}),
          ...(business || authForm.email.value.trim() ? { email: authForm.email.value.trim(), emailOtp: emailField.proof() } : {}),
          ...(business ? {
            business: { category: authForm.category.value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
          } : {}),
        });
      }
      storage.set('chat.token', data.token);
      state.guardianDelivery = data.guardian?.delivery || null; // the waiting screen says whether the link reached them
      authForm.reset();
      phoneField.reset();
      emailField.reset();
      start(data.token, data.user);
    } catch (err) {
      authError(err.message);
      // The code is gone (expired / too many tries): let them ask for a new one.
      if (err.code === 'otp_expired') {
        if (/email code/.test(err.message) || (!register && auth.loginBy === 'email')) emailField.reset();
        else phoneField.reset();
      }
    } finally {
      submit.disabled = false;
      paintSubmit();
    }
  });
  paintAuth();

  function showAuth() {
    $('#app').classList.add('hidden');
    $('#auth').classList.remove('hidden');
  }

  async function logout() {
    await Promise.race([detachNotificationsAndLocation(), new Promise((r) => setTimeout(r, 1500))]);
    if (state.token) fetch('/api/v1/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } }).catch(() => {});
    storage.del('chat.token');
    cacheTimers.forEach(clearTimeout);
    cacheTimers.clear();
    purged.clear();
    moreEarlier.clear();
    hideGuardianGate();
    photoUrls.forEach((p) => p.then((u) => u && URL.revokeObjectURL(u)));
    photoUrls.clear();
    state.photos = null;
    state.cache?.clear(); // the saved chats stay on this device only while you are logged in
    state.cache = null;
    state.calls?.dispose();
    statusUpdates.reset();
    channelsUI.reset();
    state.socket?.disconnect();
    Object.assign(state, { token: null, me: null, socket: null, activeId: null, calls: null, contact: null, e2ee: null, sub: null, privacy: null, profileCard: null, notif: null, guardian: null, guardianDelivery: null });
    state.conversations.clear();
    state.messages.clear();
    state.outbox.clear();
    state.revealed.clear();
    state.lock = { hasCode: false, lockedChats: new Set(), biometric: [] };
    state.hiddenOpen = false;
    state.blocked.clear();
    stopRecording(false);
    state.voiceUrls.forEach((url) => URL.revokeObjectURL(url));
    state.voiceUrls.clear();
    state.users = {};
    showAuth();
  }

  // ---------- administrator settings: features, announcement, maintenance ----------

  const CLIENT_VERSION = '1.0.0';

  /** Controls to hide when the administrator switches a feature off (the server refuses it as well). */
  const FEATURE_CONTROLS = {
    registration: ['.tab[data-mode=register]'],
    groups: ['#btn-new-group'],
    voiceMessages: ['#btn-record'],
    disappearing: ['#menu-timer', '#btn-default-timer@.link-row'],
    calls: ['#call-buttons', '#btn-join-call'],
    location: ['#btn-place'],
    profilePhotos: ['#btn-photos'],
    push: ['#btn-notifications'],
    callRecording: ['#call-record'],
    appearance: ['#btn-appearance'],
    status: ['#btn-status'],
    channels: ['#btn-channels'],
    profileViews: ['#btn-views'],
    translation: ['#menu-translate', '#translate-banner'],
    business: ['#btn-business'],
    catalogue: ['#btn-catalogue-edit', '.catalogue-btn'],
    premium: ['#premium-row'],
    verification: ['#verify-row'],
    developerApi: ['#btn-developer'],
  };

  function applyConfig(cfg) {
    if (!cfg) return;
    state.config = cfg;
    for (const [feature, selectors] of Object.entries(FEATURE_CONTROLS)) {
      const off = cfg.features?.[feature] === false;
      for (const sel of selectors) {
        const [target, up] = sel.split('@');
        document.querySelectorAll(target).forEach((n) => (up ? n.closest(up) || n : n).classList.toggle('feature-off', off));
      }
    }
    // Announcement (dismissable until it changes).
    const text = cfg.announcement || '';
    const dismissed = storage.get('chat.announce.dismissed') === text;
    $('#announce-text').textContent = text;
    $('#announce').classList.toggle('hidden', !text || dismissed);
    if (cfg.maintenance?.on) showGate('maintenance', cfg.maintenance.message);
    else if (!$('#maintenance').classList.contains('hidden') && state.gate === 'maintenance') location.reload();
  }
  $('#announce-close').addEventListener('click', () => {
    storage.set('chat.announce.dismissed', state.config?.announcement || '');
    $('#announce').classList.add('hidden');
  });

  /** Maintenance, or an app version that is too old: nothing else works, so say so (and come back when it is fixed). */
  function showGate(kind, message) {
    state.gate = kind;
    $('#maintenance-title').textContent = kind === 'update_required' ? 'Update required' : 'Down for maintenance';
    $('#maintenance-text').textContent = message || (kind === 'update_required' ? 'Please update the app to continue.' : 'We will be back soon.');
    $('#maintenance-reload').classList.toggle('hidden', kind !== 'update_required');
    $('#maintenance').classList.remove('hidden');
    clearInterval(state.gateTimer);
    if (kind === 'maintenance') {
      state.gateTimer = setInterval(async () => {
        const cfg = await fetch('/api/v1/config').then((r) => r.json()).catch(() => null);
        if (cfg && !cfg.maintenance?.on) location.reload();
      }, 15000);
    }
  }
  $('#maintenance-reload').addEventListener('click', () => location.reload());

  /** Read the configuration before anyone signs in (also what mobile apps do). */
  fetch('/api/v1/config', { headers: { 'X-Client-Version': CLIENT_VERSION } }).then((r) => r.json()).then(applyConfig).catch(() => {});

  // ---------- Terms of Use, Privacy Notice and consent ----------

  const consentById = (id) => state.legal?.consents?.find((c) => c.id === id);
  /** The exact wording a person agrees to (the server records which version they accepted). */
  const consentText = (id) => consentById(id)?.text || '';
  function paintConsentTexts() {
    if (!state.legal) return;
    $('#consent-terms-text').textContent = consentText('terms');
    $('#gate-terms-text').textContent = consentText('terms');
  }
  function loadLegal() {
    return fetch('/api/v1/legal').then((r) => r.json()).then((l) => { state.legal = l; paintConsentTexts(); }).catch(() => {});
  }
  loadLegal();

  function downloadJson(name, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function downloadMyData() {
    try {
      const data = await emit('account:export');
      delete data.ok;
      downloadJson(`vartiq-${state.me.username}-data.json`, data);
      toast('Your data was downloaded');
    } catch (err) {
      toast(err.message);
    }
  }

  /**
   * Deleting the account: a confirmation popup with a tick box, then a code sent to the account's mobile number.
   * Login stops at once; the server erases all the data within 24 hours.
   */
  async function deleteAccountFlow() {
    let sent;
    const agreed = await dialog({
      title: 'Delete your account?',
      text: [
        'If you continue:',
        '\u2022 Your account is permanently disabled. You are logged out and can never log in to it again, starting now.',
        '\u2022 Your chats and messages you sent, photos, voice notes and personal data are erased within 24 hours.',
        '\u2022 A basic record that the account existed (username, registration date, what you agreed to) is kept.',
        '\u2022 You can sign up again any time as a new account.',
        '',
        'This cannot be undone. Download your data first if you want a copy (Profile \u2192 Privacy and consent).',
      ].join('\n'),
      fields: [{ name: 'understand', type: 'checkbox', label: 'I understand that my account will be permanently disabled and my chats, media and personal data deleted, and that this cannot be undone.' }],
      submit: 'Continue',
      onSubmit: async (v) => {
        if (!v.understand) throw new Error('Tick the box to continue');
        sent = await emit('account:delete-code');
      },
    });
    if (!agreed || !sent) return;
    const result = await dialog({
      title: 'Enter the code to delete your account',
      text: `Enter the code we sent by SMS to ${sent.sentTo || 'your mobile number'}.${sent.devCode ? ` (Sandbox code: ${sent.devCode})` : ''}`,
      fields: [{ name: 'code', label: 'Code from SMS', type: 'text', maxLength: 8, autocomplete: 'one-time-code' }],
      submit: 'Delete my account',
      onSubmit: async (v) => emit('account:delete', { requestId: sent.requestId, code: v.code.trim(), confirmed: true }),
    });
    if (!result) return;
    storage.del('chat.token');
    await dialog({
      title: 'Your account is permanently disabled',
      text: `You are logged out and can no longer log in to it. Your chats, media and personal data will be erased within 24 hours (by ${new Date(result.dataErasedBy).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} at the latest). You can sign up again at any time as a new account.`,
      fields: [],
      submit: 'OK',
      onSubmit: async () => {},
    });
    location.reload();
  }

  // ---------- profile photos ----------
  //
  // Up to 2 photos for a free account, 5 with Premium. The first is the picture people see. Each photo is cropped square
  // and shrunk here (512 px, plus a 128 px thumbnail) before it is sent, so uploads are small and fast.

  state.photos = null;

  async function loadPhotos() {
    try {
      state.photos = await emit('photos:get');
    } catch { /* the panel shows what it has */ }
    renderPhotos();
  }

  function renderPhotos() {
    const ph = state.photos;
    if (!ph) return;
    const tag = (cls, text) => el('span', `tag ${cls}`, text);
    $('#photos-summary').textContent = `${ph.photos.length} of ${ph.limit} photos.${!ph.premium && ph.limit < ph.premiumLimit ? ` Premium lets you keep ${ph.premiumLimit}.` : ''} The first one is your picture.`;
    $('#photos-row-summary').textContent = ph.photos.length ? `${ph.photos.length} photo${ph.photos.length === 1 ? '' : 's'} · ${ph.privacy === 'everyone' ? 'everyone sees' : ph.privacy === 'nobody' ? 'nobody sees' : 'my contacts see'}` : 'Add a picture people see next to your name';
    const grid = $('#photo-grid');
    grid.textContent = '';
    for (const p of ph.photos) {
      const tile = el('div', `photo-tile${p.main ? ' main' : ''}`);
      const pic = el('button', 'pic');
      pic.type = 'button';
      pic.title = 'View photo';
      pic.setAttribute('aria-label', 'View photo');
      photoUrl(p.thumb).then((url) => { if (url) pic.style.backgroundImage = `url("${url}")`; });
      pic.addEventListener('click', () => openPhotoViewer(state.me.username, p.id));
      tile.appendChild(pic);
      if (p.main) tile.appendChild(tag('', 'Your picture'));
      if (p.hidden) tile.appendChild(tag('warn', 'Under review'));
      const acts = el('div', 'acts');
      if (!p.main) {
        const make = el('button', 'link', 'Make main');
        make.type = 'button';
        make.addEventListener('click', () => photoAction('photo:main', { id: p.id }));
        acts.appendChild(make);
      }
      const del = el('button', 'link', 'Remove');
      del.type = 'button';
      del.addEventListener('click', () => { if (confirm('Remove this photo?')) photoAction('photo:delete', { id: p.id }); });
      acts.appendChild(del);
      tile.appendChild(acts);
      grid.appendChild(tile);
    }
    const full = ph.photos.length >= ph.limit;
    const add = el('button', 'photo-add', '+');
    add.type = 'button';
    add.title = full ? 'Photo limit reached' : 'Add a photo';
    add.setAttribute('aria-label', add.title);
    add.addEventListener('click', () => {
      $('#photos-error').textContent = '';
      if (!full) return $('#photo-file').click();
      if (!ph.premium && ph.limit < ph.premiumLimit) return offerUpgrade(`A free account can keep ${ph.freeLimit} profile photos. Premium allows ${ph.premiumLimit}.`);
      $('#photos-error').textContent = `You can keep up to ${ph.limit} photos. Remove one to add another.`;
      return undefined;
    });
    grid.appendChild(add);
    document.querySelectorAll('input[name=photo-privacy]').forEach((r) => { r.checked = r.value === ph.privacy; });
    const rot = ph.rotation || {};
    $('#photo-rotate').checked = !!rot.on;
    $('#photo-rotate-note').textContent = rot.on && rot.active ? `Next change: ${new Date(rot.nextAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}.`
      : rot.on ? (ph.premium ? 'Add a full set of photos for this to run.' : 'Paused until you have Premium again.')
      : !ph.premium ? `Premium feature. Add ${ph.premiumLimit} photos and switch it on.` : ph.photos.length < ph.premiumLimit ? `Add ${ph.premiumLimit} photos to use this (you have ${ph.photos.length}).` : '';
    $('#photos-privacy-note').textContent = ph.minor
      ? 'Because you are under 18, your photos are only ever shown to people you already chat with, whatever you choose here.'
      : ph.privacy === 'contacts' ? 'People who are not in a chat or group with you cannot see your photos.' : '';
  }

  async function photoAction(event, payload) {
    $('#photos-error').textContent = '';
    try {
      state.photos = await emit(event, payload);
      renderPhotos();
    } catch (err) {
      $('#photos-error').textContent = err.message;
    }
  }

  function openPhotos() {
    openPanel('#panel-photos');
    renderPhotos();
    loadPhotos();
  }
  $('#btn-photos').addEventListener('click', openPhotos);
  $('#profile-avatar').addEventListener('click', openPhotos);
  $('#profile-avatar').style.cursor = 'pointer';
  document.querySelectorAll('input[name=photo-privacy]').forEach((r) => r.addEventListener('change', () => photoAction('photo:privacy', { who: r.value })));
  $('#photo-rotate').addEventListener('change', async (e) => {
    const on = e.target.checked;
    if (on && state.photos && !state.photos.premium) {
      e.target.checked = false;
      return offerUpgrade('Changing your picture automatically every 7 days is a Premium feature.');
    }
    await photoAction('photo:rotate', { on });
    renderPhotos(); // puts the switch back where the server left it when it refused
    return undefined;
  });

  // --- Link a browser: a passcode made here lets one browser log in ---
  let linkTimer = null;
  async function loadLinked() {
    try {
      const { devices, primary } = await emit('link:list');
      $('#link-make').disabled = !primary;
      $('#link-lead').textContent = primary
        ? 'To log in to VartiQ on a computer, make a passcode here and type it on the login page together with your mobile number. A passcode works once and lasts 2 minutes.'
        : 'Passcodes are made on the phone you signed up on. You are logged in on a browser.';
      $('#link-summary').textContent = devices.length ? `${devices.length} browser${devices.length === 1 ? '' : 's'} logged in` : 'Get a passcode to log in on a computer';
      const list = $('#link-list');
      list.textContent = '';
      if (!devices.length) list.appendChild(el('p', 'muted', 'No browsers are logged in with a passcode.'));
      for (const d of devices) {
        const row = el('div', 'link-row static');
        row.appendChild(el('span', '', ''));
        const label = el('span', '');
        label.appendChild(el('strong', '', d.current ? `${d.name} (this browser)` : d.name));
        label.appendChild(el('small', '', `Logged in ${new Date(d.at).toLocaleString()}`));
        row.appendChild(label);
        const out = el('button', 'link', 'Sign out');
        out.type = 'button';
        out.addEventListener('click', async () => {
          try {
            await emit('link:remove', { id: d.id });
            if (d.current) logout();
            else loadLinked();
          } catch (err) { $('#link-error').textContent = err.message; }
        });
        row.appendChild(out);
        list.appendChild(row);
      }
    } catch (err) {
      $('#link-error').textContent = err.message;
    }
  }
  function showLinkCode(res) {
    clearInterval(linkTimer);
    $('#link-code-box').classList.remove('hidden');
    $('#link-code').textContent = `${res.code.slice(0, 3)} ${res.code.slice(3)}`;
    const tick = () => {
      const left = Math.max(0, Math.round((res.expiresAt - Date.now()) / 1000));
      $('#link-countdown').textContent = left ? `Valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}. Use it once.` : 'Expired. Make a new one.';
      if (!left) { clearInterval(linkTimer); $('#link-code').textContent = '------'; }
    };
    tick();
    linkTimer = setInterval(tick, 1000);
  }
  $('#btn-link').addEventListener('click', () => {
    openPanel('#panel-link');
    $('#link-error').textContent = '';
    loadLinked();
  });
  $('#link-make').addEventListener('click', async () => {
    $('#link-error').textContent = '';
    try { showLinkCode(await emit('link:create')); } catch (err) { $('#link-error').textContent = err.message; }
  });
  $('#panel-link [data-close]').addEventListener('click', () => { clearInterval(linkTimer); $('#link-code-box').classList.add('hidden'); });

  // --- crop: a square, moved by dragging and zoomed with a slider ---
  const crop = { bmp: null, zoom: 1, ox: 0, oy: 0, base: 1 };
  const cropCanvas = $('#crop-canvas');
  function drawCrop(canvas, size) {
    const ctx = canvas.getContext('2d');
    canvas.width = size;
    canvas.height = size;
    const k = size / 280; // the preview is 280 px: everything is relative to it
    const scale = crop.base * crop.zoom * k;
    const w = crop.bmp.width * scale;
    const h = crop.bmp.height * scale;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(crop.bmp, (size - w) / 2 + crop.ox * k, (size - h) / 2 + crop.oy * k, w, h);
  }
  const clampCrop = () => {
    const w = crop.bmp.width * crop.base * crop.zoom;
    const h = crop.bmp.height * crop.base * crop.zoom;
    crop.ox = Math.max(-(w - 280) / 2, Math.min((w - 280) / 2, crop.ox));
    crop.oy = Math.max(-(h - 280) / 2, Math.min((h - 280) / 2, crop.oy));
  };
  const repaintCrop = () => { clampCrop(); drawCrop(cropCanvas, 280); };
  let dragging = null;
  cropCanvas.addEventListener('pointerdown', (e) => { dragging = { x: e.clientX, y: e.clientY, ox: crop.ox, oy: crop.oy }; cropCanvas.setPointerCapture(e.pointerId); });
  cropCanvas.addEventListener('pointermove', (e) => { if (!dragging) return; crop.ox = dragging.ox + (e.clientX - dragging.x); crop.oy = dragging.oy + (e.clientY - dragging.y); repaintCrop(); });
  cropCanvas.addEventListener('pointerup', () => { dragging = null; });
  $('#crop-zoom').addEventListener('input', (e) => { crop.zoom = Number(e.target.value); repaintCrop(); });
  const toBlob = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

  /** Let the person place the picture, then return { image, thumb } as bytes (or null if they cancel). */
  function cropPhoto(file) {
    return new Promise((resolve) => {
      createImageBitmap(file).then((bmp) => {
        Object.assign(crop, { bmp, zoom: 1, ox: 0, oy: 0, base: 280 / Math.min(bmp.width, bmp.height) });
        $('#crop-zoom').value = 1;
        $('#crop-error').textContent = '';
        $('#crop-modal').classList.remove('hidden');
        repaintCrop();
        const done = (result) => {
          $('#crop-modal').classList.add('hidden');
          $('#crop-save').onclick = null;
          $('#crop-cancel').onclick = null;
          bmp.close?.();
          resolve(result);
        };
        $('#crop-cancel').onclick = () => done(null);
        $('#crop-save').onclick = async () => {
          const big = document.createElement('canvas');
          const small = document.createElement('canvas');
          drawCrop(big, 512);
          drawCrop(small, 128);
          const [image, thumb] = await Promise.all([toBlob(big, 0.86), toBlob(small, 0.8)]);
          if (!image || !thumb) { $('#crop-error').textContent = 'Could not prepare this photo'; return; }
          done({ image: await image.arrayBuffer(), thumb: await thumb.arrayBuffer() });
        };
      }).catch(() => { $('#photos-error').textContent = 'This file cannot be read as a picture. Use a JPEG, PNG or WebP photo.'; resolve(null); });
    });
  }
  $('#photo-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { $('#photos-error').textContent = 'That file is too large'; return; }
    const prepared = await cropPhoto(file);
    if (prepared) await photoAction('photo:upload', prepared);
  });

  // --- viewing someone's photos, and reporting one ---
  const viewer = { photos: [], i: 0, username: null, canReport: false, reasons: [] };
  async function openPhotoViewer(username, startId) {
    try {
      const res = await emit('photos:user', { username });
      if (!res.photos.length) return toast('No photos to show');
      Object.assign(viewer, { photos: res.photos, i: Math.max(0, res.photos.findIndex((p) => p.id === startId)), username, canReport: res.canReport, reasons: res.reasons });
      $('#photo-viewer').classList.remove('hidden');
      showViewerPhoto();
    } catch (err) {
      toast(err.message);
    }
    return undefined;
  }
  function showViewerPhoto() {
    const p = viewer.photos[viewer.i];
    const img = $('#pv-img');
    img.removeAttribute('src');
    photoUrl(p.image).then((url) => { if (url && viewer.photos[viewer.i] === p) img.src = url; });
    $('#pv-title').textContent = displayName(viewer.username);
    $('#pv-count').textContent = `${viewer.i + 1} of ${viewer.photos.length}`;
    $('#pv-prev').hidden = viewer.i === 0;
    $('#pv-next').hidden = viewer.i === viewer.photos.length - 1;
    $('#pv-report').classList.toggle('hidden', !viewer.canReport);
  }
  const closeViewer = () => $('#photo-viewer').classList.add('hidden');
  $('#pv-close').addEventListener('click', closeViewer);
  $('#pv-prev').addEventListener('click', () => { viewer.i = Math.max(0, viewer.i - 1); showViewerPhoto(); });
  $('#pv-next').addEventListener('click', () => { viewer.i = Math.min(viewer.photos.length - 1, viewer.i + 1); showViewerPhoto(); });
  document.addEventListener('keydown', (e) => {
    if ($('#photo-viewer').classList.contains('hidden')) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowLeft') $('#pv-prev').click();
    else if (e.key === 'ArrowRight') $('#pv-next').click();
  });
  $('#pv-report').addEventListener('click', async () => {
    const p = viewer.photos[viewer.i];
    const who = viewer.username;
    closeViewer();
    const done = await dialog({
      title: 'Report this photo',
      text: `Tell us what is wrong with ${displayName(who)}'s photo. We review reports. If several people report a photo, or you say a child may be at risk, it is hidden from everyone while we look.`,
      fields: [
        { name: 'reason', label: 'What is wrong?', options: viewer.reasons.map((r) => [r.id, r.label]) },
        { name: 'detail', label: 'More details (optional)', type: 'text', required: false, maxLength: 300 },
      ],
      submit: 'Send report',
      onSubmit: async (v) => emit('photo:report', { username: who, id: p.id, reason: v.reason, detail: (v.detail || '').trim() }),
    });
    if (done) toast('Thank you. We will review this photo.');
  });
  // Someone's big picture (their profile card or contact info) opens their photos.
  document.addEventListener('click', (e) => {
    const av = e.target.closest('#contact-body .avatar.xl');
    if (!av) return;
    const username = state.profileCard || (state.conversations.get(state.activeId)?.type === 'direct' ? convPeer(state.conversations.get(state.activeId)) : null);
    if (username && state.users[username]?.photo) openPhotoViewer(username);
  });

  // ---------- parent or guardian (under 18) ----------

  let guardianPoll = null;
  function paintGuardianGate(g) {
    const who = g.name ? g.name : 'your parent or guardian';
    $('#guardian-gate-text').textContent = `Because you are under 18, ${who} has to allow you to use VartiQ. We sent them a private link. Ask them to open it and agree. Until then your account is closed to you.`;
    const where = g.contacts?.length ? `Sent to ${g.contacts.join(' and ')}.` : '';
    const d = state.guardianDelivery;
    $('#guardian-gate-sent').textContent = d && d.delivered === false
      ? `We could not reach them (${d.error}). Check their details with "Change their details", or try "Send them the link again".`
      : where;
    $('#guardian-gate-error').textContent = '';
  }
  async function showGuardianGate(g) {
    $('#consent-gate').classList.add('hidden');
    $('#auth').classList.add('hidden');
    $('#guardian-gate').classList.remove('hidden');
    if (!g) {
      try { g = (await emit('guardian:status')).guardian; } catch { return; }
      if (!g || g.state !== 'pending') { location.reload(); return; }
    }
    paintGuardianGate(g);
    clearInterval(guardianPoll);
    guardianPoll = setInterval(() => guardianRefresh(true), 20000);
  }
  function hideGuardianGate() {
    $('#guardian-gate').classList.add('hidden');
    clearInterval(guardianPoll);
    guardianPoll = null;
  }
  async function guardianRefresh(quiet) {
    try {
      const { guardian } = await emit('guardian:status');
      if (!guardian || guardian.state !== 'pending') { location.reload(); return; }
      paintGuardianGate(guardian);
      if (!quiet) $('#guardian-gate-error').textContent = 'They have not agreed yet.';
    } catch (err) {
      if (!quiet) $('#guardian-gate-error').textContent = err.message;
    }
  }
  $('#guardian-gate-refresh').addEventListener('click', () => guardianRefresh(false));
  $('#guardian-gate-resend').addEventListener('click', async () => {
    try {
      const res = await emit('guardian:resend');
      state.guardianDelivery = res.delivery;
      paintGuardianGate(res.guardian);
      $('#guardian-gate-error').textContent = res.delivery.delivered ? 'Sent again. The older link no longer works.' : res.delivery.error;
    } catch (err) {
      $('#guardian-gate-error').textContent = err.message;
    }
  });
  $('#guardian-gate-change').addEventListener('click', async () => {
    const res = await dialog({
      title: 'Change your parent or guardian\'s details',
      text: 'A new private link goes to the new details, and the old link stops working. A mobile number (with country code, e.g. +91 98765 43210) or an email: at least one.',
      fields: [
        { name: 'name', label: 'Their name', type: 'text', maxLength: 60 },
        { name: 'relationship', label: 'Who are they to you?', options: [['mother', 'Mother'], ['father', 'Father'], ['guardian', 'Legal guardian'], ['other', 'Other (with the right to decide for me)']] },
        { name: 'phone', label: 'Their mobile number', type: 'tel', required: false, maxLength: 20 },
        { name: 'email', label: 'Or their email', type: 'email', required: false, maxLength: 120 },
      ],
      submit: 'Save and send the link',
      onSubmit: async (v) => emit('guardian:contact', { name: v.name.trim(), relationship: v.relationship, ...(v.phone.trim() ? { phone: v.phone.trim() } : {}), ...(v.email.trim() ? { email: v.email.trim() } : {}) }),
    });
    if (res && res !== true) {
      state.guardianDelivery = res.delivery;
      paintGuardianGate(res.guardian);
    }
  });
  $('#guardian-gate-export').addEventListener('click', downloadMyData);
  $('#guardian-gate-delete').addEventListener('click', deleteAccountFlow);
  $('#guardian-gate-logout').addEventListener('click', () => { hideGuardianGate(); logout(); });

  /** After approval: hide what the parent or guardian switched off, and say so in Profile. */
  function applyGuardian() {
    const g = state.guardian;
    const c = g?.controls || {};
    const off = (sel, hide) => document.querySelectorAll(sel).forEach((n) => n.classList.toggle('guardian-off', !!hide));
    off('#btn-place', g && c.location === false);
    off('#call-buttons, #btn-join-call', g && c.calls === false);
    off('#btn-channels', g && c.channels === false);
    const note = $('#guardian-note');
    note.classList.toggle('hidden', !g);
    note.textContent = '';
    if (!g) return;
    note.appendChild(el('strong', '', 'Parental controls are on'));
    note.appendChild(el('p', 'muted', `${g.name || 'Your parent or guardian'} allowed you to use VartiQ and decides these things until you turn 18:`));
    const list = el('ul', 'consent-facts');
    for (const item of g.controlList || []) list.appendChild(el('li', '', `${item.label}: ${c[item.id] === false ? 'off' : 'on'}`));
    note.appendChild(list);
    if (!g.premium) note.appendChild(el('p', 'muted small-note', 'Your parent or guardian can change these once your account has Premium (Profile, Premium). Until then the settings above stay as they are.'));
    note.appendChild(el('p', 'muted small-note', 'They cannot read your messages. At 18 these controls end.'));
  }

  function showConsentGate() {
    paintConsentTexts();
    $('#gate-terms').checked = false;
    $('#gate-error').textContent = '';
    $('#consent-gate').classList.remove('hidden');
    $('#auth').classList.add('hidden');
  }
  function hideConsentGate() {
    $('#consent-gate').classList.add('hidden');
  }
  $('#gate-accept').addEventListener('click', async () => {
    if (!$('#gate-terms').checked) {
      $('#gate-error').textContent = 'Please tick the box to continue';
      return;
    }
    try {
      await emit('consent:accept', { terms: true });
      location.reload();
    } catch (err) {
      $('#gate-error').textContent = err.message;
    }
  });
  $('#gate-export').addEventListener('click', downloadMyData);
  $('#gate-delete').addEventListener('click', deleteAccountFlow);
  $('#gate-logout').addEventListener('click', () => { hideConsentGate(); logout(); });

  async function openPrivacy() {
    openPanel('#panel-privacy');
    let st;
    try {
      st = await emit('consent:status');
    } catch (err) {
      return toast(err.message);
    }
    state.consent = { ...state.consent, optional: st.optional };
    $('#privacy-accepted').textContent = st.acceptedVersion
      ? `You accepted version ${st.acceptedVersion} on ${new Date(st.acceptedAt).toLocaleDateString([], { dateStyle: 'long' })}. Current version: ${st.version}.`
      : `Current version: ${st.version}.`;
    const g = st.summary.company.grievanceOfficer;
    $('#privacy-contact').textContent = `Grievance Officer: ${g.name}, ${g.email}${g.phone ? `, ${g.phone}` : ''}. ${st.summary.company.name}, ${st.summary.company.address}.`;
    const box = $('#privacy-optional');
    box.textContent = '';
    box.appendChild(el('strong', '', 'Things you can switch on or off'));
    for (const c of st.summary.consents.filter((x) => !x.required)) {
      const row = el('label', 'consent-toggle');
      const input = el('input');
      Object.assign(input, { type: 'checkbox', checked: !!st.optional[c.id] });
      input.addEventListener('change', async () => {
        try {
          const res = await emit('consent:set', { id: c.id, granted: input.checked });
          state.consent = { ...state.consent, optional: res.optional };
          toast(input.checked ? 'Saved' : `${c.title}: consent withdrawn`);
        } catch (err) {
          input.checked = !input.checked;
          toast(err.message);
        }
      });
      const text = el('span');
      text.append(el('strong', '', c.title), el('br'), c.text);
      row.append(input, text);
      box.appendChild(row);
    }
  }
  $('#btn-privacy').addEventListener('click', openPrivacy);
  $('#btn-export').addEventListener('click', downloadMyData);
  $('#btn-delete-account').addEventListener('click', deleteAccountFlow);

  // ---------- startup ----------

  function start(token, user) {
    state.token = token;
    state.me = user || null;
    const socket = io({ auth: { token, appSession: APP_SESSION, clientVersion: CLIENT_VERSION } });
    state.socket = socket;
    state.calls = window.createCallController({
      socket,
      emit,
      iceServers: () => state.iceServers,
      displayName,
      paintAvatar,
      me: () => state.me.username,
      toast: (text) => toast(text),
      isPremium: () => !!state.me?.premium,
      needPremium: (text) => offerUpgrade(text),
    });
    statusUpdates.attach(socket);
    channelsUI.attach(socket);

    // Events that carry (or refer to) messages are handled one at a time, in order, after decryption.
    let inbox = Promise.resolve();
    const onOrdered = (event, handler) => socket.on(event, (payload) => {
      inbox = inbox.then(() => decryptPayload(payload)).then(() => handler(payload)).catch(console.error);
    });

    // The administrator can change features, announcements and maintenance at any time.
    socket.on('config:update', applyConfig);
    socket.on('photos:update', (ph) => { state.photos = ph; renderPhotos(); }); // another of my devices changed my photos
    // The parent or guardian agreed, changed what is allowed, or the child turned 18.
    socket.on('guardian:update', ({ guardian }) => {
      const gateOpen = !$('#guardian-gate').classList.contains('hidden');
      if (gateOpen && guardian?.state === 'pending') { paintGuardianGate(guardian); return; }
      if (gateOpen || (!guardian && state.guardian)) { location.reload(); return; } // agreed, or turned 18: start afresh
      state.guardian = guardian;
      applyGuardian();
    });
    socket.on('connect_error', (err) => {
      if (err.message === 'maintenance' || err.message === 'update_required') {
        showGate(err.data?.code || err.message, err.data?.message);
        return;
      }
      if (err.message === 'unauthorized') {
        socket.disconnect();
        storage.del('chat.token');
        showAuth();
      }
    });

    socket.on('connect', async () => {
      try {
        const meReply = await emit('me');
        // Changed Terms or Privacy Notice? Nothing else works until they are accepted.
        if (meReply.consent && !meReply.consent.upToDate) {
          state.me = meReply.user;
          showConsentGate();
          return;
        }
        hideConsentGate();
        const { user: me, iceServers, blocked, defaultDisappear, business, contact, privacy, appearance, consent } = meReply;
        state.consent = consent || null;
        // A child's account waits here until the parent or guardian has agreed.
        if (meReply.guardian?.state === 'pending') {
          state.me = meReply.user;
          showGuardianGate(meReply.guardian);
          return;
        }
        hideGuardianGate();
        state.guardian = meReply.guardian || null;
        const lockSettings = await emit('chatlock:settings');
        state.defaultDisappear = defaultDisappear || null;
        state.contact = contact || { phone: null, email: null };
        state.privacy = privacy || { profileViews: true };
        renderViewsRow();
        state.myBusiness = business || null;
        setLockSettings(lockSettings);
        state.me = me;
        state.cache ||= window.ChatCache.create(me.username);
        window.Appearance.load().then(() => window.Appearance.apply(appearance)).catch(() => {});
        // This device's encryption key (made once, kept in the browser) must be ready before any message is read.
        if (!state.e2ee) state.e2ee = window.E2EE.createClient({ emit, username: me.username, deviceName: deviceName() });
        await state.e2ee.init();
        renderE2eeSummary();
        emit('subscription:status').then((sub) => { state.sub = sub; renderPremiumRow(); }).catch(() => {});
        state.iceServers = iceServers || [];
        state.blocked = new Set(blocked || []);
        setOffline(false);
        state.users[me.username] = { ...me, online: true };
        $('#auth').classList.add('hidden');
        $('#app').classList.remove('hidden');
        paintAvatar($('#btn-profile'), me.displayName, me.username);
        await loadConversations();
        applyGuardian();
        statusUpdates.load();
        channelsUI.load();
        resumeNotificationsAndLocation();
        // Refresh the open chat after a reconnect.
        if (state.activeId) openChat(state.activeId);
        // Back online: resend anything that failed while we were offline.
        for (const m of state.outbox.values()) if (m.localStatus === 'failed') deliver(m);
      } catch (err) {
        console.error(err);
      }
    });

    socket.on('disconnect', () => setOffline(true));
    onOrdered('message:new', ({ message }) => onMessage(message));
    onOrdered('location:update', ({ message }) => onLocationUpdate(message));
    socket.on('call:incoming', (call) => localNotifyCall(call));
    onOrdered('message:starred', ({ convId, id, starred }) => {
      const m = state.messages.get(convId)?.find((x) => x.id === id);
      if (m) m.starred = starred;
      if (convId === state.activeId) renderMessages();
      if (!$('#panel-starred').classList.contains('hidden')) loadStarred();
    });
    onOrdered('conversation:updated', ({ conversation }) => {
      const conv = state.conversations.get(conversation.id);
      if (!conv) {
        loadConversations();
        return;
      }
      if (!('disappearAfter' in conversation)) delete conv.disappearAfter;
      Object.assign(conv, conversation);
      renderChatList();
      if (conversation.id === state.activeId) renderHeader();
      refreshContactInfo();
    });
    onOrdered('message:expired', ({ convId, ids }) => removeMessages(convId, new Set(ids)));
    // Translation language changed for a chat (maybe on another device).
    socket.on('translate:update', ({ convId, lang }) => applyTranslation(convId, lang));
    // My look changed (another device, or Premium started or ended).
    socket.on('appearance:update', (prefs) => {
      window.Appearance.apply(prefs);
      if (!$('#panel-appearance').classList.contains('hidden')) renderAppearance();
    });
    // My Premium started or ended (maybe on another device).
    socket.on('payment:received', (e) => paymentReceivedHook(e));
    socket.on('payment:refunded', (e) => toast(`A refund of ${money({ currency: e.payment.currency, price: e.payment.refunded || e.payment.amount })} was processed${e.revoked ? ', so that Premium period was taken back' : ''}.`));
    socket.on('subscription:update', (sub) => {
      state.sub = sub;
      if (state.me) state.me.premium = !!sub.premium;
      renderPremiumRow();
      if (!$('#panel-appearance').classList.contains('hidden')) renderAppearance();
    });
    // Someone viewed my profile (or I changed the setting elsewhere): refresh the list if it is open.
    socket.on('profile:viewed', () => {
      if (!$('#panel-views').classList.contains('hidden')) loadViews();
    });
    // Someone added or removed a device: refresh keys so new messages are encrypted for the right devices.
    socket.on('e2ee:update', () => {
      state.e2ee?.invalidate();
      if (!$('#panel-devices').classList.contains('hidden')) renderDevices().catch(() => {});
      if (state.activeId) renderHeader();
    });
    // Someone I chat with deleted their account: their name and messages change.
    socket.on('peer:deleted', () => loadConversations());
    // Chats were hidden/unhidden (maybe on another device): reload the list.
    socket.on('hidden:update', () => loadConversations());
    socket.on('chatlock:update', async (settings) => {
      setLockSettings(settings);
      // Locks changed (maybe on another device): reload so locked chats lose their content.
      await loadConversations();
      if (state.activeId) openChat(state.activeId);
    });
    socket.on('blocked:update', ({ blocked }) => {
      state.blocked = new Set(blocked);
      renderChatList();
      renderHeader();
    });
    socket.on('call:state', ({ convId, call }) => {
      const conv = state.conversations.get(convId);
      if (!conv) return;
      conv.activeCall = call;
      renderChatList();
      if (convId === state.activeId) renderHeader();
    });
    onOrdered('message:status', ({ convId, messages }) => {
      const list = state.messages.get(convId);
      const conv = state.conversations.get(convId);
      for (const s of messages) {
        const m = list?.find((x) => x.id === s.id);
        if (m) Object.assign(m, s);
        if (conv?.lastMessage?.id === s.id) Object.assign(conv.lastMessage, s);
      }
      if (convId === state.activeId) renderMessages();
      renderChatList();
    });
    onOrdered('message:deleted', ({ convId, id }) => {
      const m = state.messages.get(convId)?.find((x) => x.id === id);
      if (m) Object.assign(m, { deleted: true, text: '' });
      const conv = state.conversations.get(convId);
      if (conv?.lastMessage?.id === id) Object.assign(conv.lastMessage, { deleted: true, text: '' });
      if (convId === state.activeId) renderMessages();
      renderChatList();
    });
    onOrdered('conversation:new', ({ conversation, users }) => {
      Object.assign(state.users, users);
      if (!state.conversations.has(conversation.id)) state.conversations.set(conversation.id, conversation);
      renderChatList();
    });
    socket.on('presence', ({ username, online, lastSeen }) => {
      state.users[username] = { ...(state.users[username] || { username, displayName: username }), online, lastSeen };
      renderChatList();
      renderHeader();
    });
    socket.on('user:updated', ({ user }) => {
      // Replace (not merge), so removed fields such as a business profile disappear too.
      const prev = state.users[user.username] || {};
      state.users[user.username] = { ...user, online: user.online ?? prev.online };
      if (user.username === state.me?.username) {
        state.me = { ...state.me, ...user, business: user.business, verified: user.verified, premium: user.premium, photo: user.photo };
        renderVerifyRow();
        if (!user.business) state.myBusiness = null;
      }
      refreshContactInfo();
      renderChatList();
      renderHeader();
      if (state.activeId) renderMessages();
    });
    socket.on('typing', ({ convId, username, isTyping, activity = 'typing' }) => {
      if (!state.typing.has(convId)) state.typing.set(convId, new Map());
      const map = state.typing.get(convId);
      clearTimeout(map.get(username)?.timer);
      if (isTyping) {
        map.set(username, { activity, timer: setTimeout(() => { map.delete(username); refreshTyping(convId); }, 5000) });
      } else {
        map.delete(username);
      }
      refreshTyping(convId);
    });
  }

  async function loadConversations() {
    const { conversations, users } = await emit('conversations');
    Object.assign(state.users, users);
    state.conversations.clear();
    conversations.forEach((c) => state.conversations.set(c.id, c));
    // Hidden chats are never in this list; reload them if this session has them open.
    if (state.hiddenOpen) await loadHidden().catch(() => closeHidden());
    renderChatList();
  }

  // ---------- chat list ----------

  /** What others are doing in a chat right now: `{ text, activity: 'typing'|'recording' }` or null. */
  function activityOf(convId) {
    const map = state.typing.get(convId);
    if (!map?.size) return null;
    const entries = [...map.entries()];
    const recording = entries.filter(([, v]) => v.activity === 'recording');
    const activity = recording.length ? 'recording' : 'typing';
    const names = (recording.length ? recording : entries).map(([u]) => u);
    const verb = activity === 'recording' ? 'recording audio…' : 'typing…';
    let text;
    if (state.conversations.get(convId)?.type === 'direct') text = verb;
    else if (names.length === 1) text = `${displayName(names[0])} is ${verb}`;
    else text = `${names.length} people are ${verb}`;
    return { text, activity };
  }

  function refreshTyping(convId) {
    renderChatList();
    if (convId === state.activeId) renderHeader();
  }

  function renderChatList() {
    const q = state.filter.toLowerCase();
    const convs = [...state.conversations.values()]
      .filter((c) => !c.hidden)
      .filter((c) => c.type === 'group' || c.lastMessage || c.disappearAfter || c.id === state.activeId)
      .filter((c) => !q || convTitle(c).toLowerCase().includes(q))
      .sort((a, b) => (b.lastMessage?.ts || b.createdAt) - (a.lastMessage?.ts || a.createdAt));

    $('#chat-list-empty').classList.toggle('hidden', convs.length > 0 || !!q);
    fillChatList($('#chat-list'), convs);
    if (state.hiddenOpen) renderHiddenList();
  }

  function renderHiddenList() {
    const convs = [...state.conversations.values()]
      .filter((c) => c.hidden)
      .sort((a, b) => (b.lastMessage?.ts || b.createdAt) - (a.lastMessage?.ts || a.createdAt));
    $('#hidden-empty').classList.toggle('hidden', convs.length > 0);
    fillChatList($('#hidden-list'), convs);
  }

  function fillChatList(list, convs) {
    list.textContent = '';

    for (const c of convs) {
      const li = el('li');
      if (c.id === state.activeId) li.classList.add('active');
      if (c.unread) li.classList.add('has-unread');
      const peer = convPeer(c);
      li.appendChild(avatar(convTitle(c), c.type === 'group' ? c.id : peer, {
        online: !!(peer && state.users[peer]?.online),
        group: c.type === 'group',
      }));

      const body = el('div', 'body');
      const top = el('div', 'row');
      top.appendChild(el('span', 'name', convTitle(c)));
      if (peer && state.users[peer]) top.append(...userBadges(state.users[peer]));
      if (c.disappearAfter) top.appendChild(timerIcon(`Auto-delete: ${fmtTimer(c.disappearAfter)}`));
      if (c.locked) top.appendChild(lockIcon(c.unlocked ? 'Locked chat (unlocked for now)' : 'Locked chat'));
      if (peer && state.blocked.has(peer)) top.appendChild(icon('blocked'));
      top.appendChild(el('span', 'time', c.lastMessage ? listTime(c.lastMessage.ts) : ''));
      body.appendChild(top);

      const bottom = el('div', 'row');
      const activity = activityOf(c.id);
      const live = c.activeCall && c.type === 'group';
      const preview = el('span', 'preview' + (activity || live ? ' typing' : ''));
      if (activity) {
        preview.append(icon(activity.activity), activity.text);
      } else if (live) {
        preview.append(icon('calling'), `Ongoing ${c.activeCall.kind === 'video' ? 'video' : 'voice'} call`);
      } else if (c.lastMessage?.type === 'system') {
        preview.append(timerIcon(''), describeSystem(c.lastMessage, true));
      } else if (c.lastMessage?.type === 'call') {
        const d = describeCall(c.lastMessage);
        preview.append(icon(d.icon), `${d.title}${c.lastMessage.call.status === 'completed' && !d.missed ? ` · ${d.sub}` : ''}`);
      } else if (c.lastMessage) {
        const m = c.lastMessage;
        const mine = m.from === state.me.username;
        let prefix = '';
        if (c.type === 'group') prefix = mine ? 'You: ' : `${displayName(m.from)}: `;
        let text;
        if (m.locked) {
          text = 'Locked chat · tap to unlock';
        } else if (m.deleted) {
          preview.appendChild(icon('deleted'));
          text = 'This message was deleted';
        } else {
          if (mine) preview.appendChild(icon(statusOf(m, c)));
          // Masked text never shows in the chat list, not even to the sender.
          if (m.masked) preview.appendChild(icon('masked'));
          if (m.type === 'voice') text = `${prefix}🎤 Voice message (${fmtDuration(m.voice.duration)})`;
          else text = prefix + previewText(m);
        }
        preview.appendChild(document.createTextNode(text));
      } else if (c.type === 'group') {
        preview.textContent = `${c.members.length} participants`;
      }
      bottom.appendChild(preview);
      if (c.unread) bottom.appendChild(el('span', 'badge', String(c.unread)));
      body.appendChild(bottom);

      li.appendChild(body);
      li.addEventListener('click', () => openChat(c.id));
      list.appendChild(li);
    }
  }

  $('#chat-filter').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderChatList();
  });

  // ---------- chat view ----------


  // ---------- chats saved on this device ----------

  const cacheEnabled = () => storage.get('chat.cache') !== 'off';
  /** Chats that are locked, hidden or set to disappear are never saved on the device. */
  const cacheable = (conv) => !!(state.cache?.available && cacheEnabled() && conv && !conv.locked && !conv.hidden && !conv.disappearAfter);
  const purged = new Set();
  const purgeOnce = (convId) => {
    if (!state.cache || purged.has(convId)) return;
    purged.add(convId);
    state.cache.purge(convId);
  };
  const cacheTimers = new Map();
  /** Save the open chat's messages shortly after they change. */
  function scheduleCacheSave(convId) {
    if (!state.cache) return;
    clearTimeout(cacheTimers.get(convId));
    cacheTimers.set(convId, setTimeout(() => {
      cacheTimers.delete(convId);
      const conv = state.conversations.get(convId);
      if (!conv) return;
      if (!cacheable(conv)) { if (conv.locked || conv.hidden || conv.disappearAfter) purgeOnce(convId); return; }
      purged.delete(convId);
      state.cache.save(convId, state.messages.get(convId) || []);
    }, 800));
  }

  /**
   * What to show for a chat opened with a saved copy: the saved messages older than the newest page from the server,
   * plus that page (which also corrects delivery ticks and removes messages deleted or expired since).
   * If more messages arrived than fit in one page, older pages are fetched until they meet the saved copy.
   */
  async function mergeWithSaved(convId, saved, page) {
    let fetched = page.messages.slice();
    if (!fetched.length) return [];
    const newestSaved = saved[saved.length - 1].ts;
    let more = page.hasMore;
    let before = page.nextBefore;
    for (let n = 0; more && fetched[0].ts > newestSaved && n < 10; n++) {
      const older = await emit('messages:get', { convId, before, limit: 100 });
      fetched = older.messages.concat(fetched);
      more = older.hasMore;
      before = older.nextBefore;
    }
    const met = !more || fetched[0].ts <= newestSaved; // a gap we could not fill means the old copy cannot be trusted
    return (met ? saved.filter((m) => m.ts < fetched[0].ts) : []).concat(fetched);
  }

  const moreEarlier = new Map(); // convId -> whether older messages may exist
  async function loadEarlier() {
    const convId = state.activeId;
    const conv = state.conversations.get(convId);
    const list = state.messages.get(convId) || [];
    const oldest = list.find((m) => !m.localStatus);
    if (!conv || !oldest) return;
    let older = cacheable(conv) ? await state.cache.load(convId, 100, oldest.ts) : [];
    if (older.length) {
      await Promise.all(older.map(readMessage));
    } else {
      const res = await emit('messages:get', { convId, before: oldest.ts, limit: 100 });
      older = res.messages;
      moreEarlier.set(convId, res.hasMore);
    }
    if (!older.length) moreEarlier.set(convId, false);
    if (state.activeId !== convId) return;
    const box = $('#messages');
    const height = box.scrollHeight;
    state.messages.set(convId, older.concat(list));
    renderMessages(false);
    box.scrollTop = box.scrollHeight - height;
  }

  async function openChat(id, { highlight } = {}) {
    const conv = state.conversations.get(id);
    if (!conv) return;
    // Switching chats mid-recording sends the recording to the chat it was made in.
    if (state.recorder && state.recorder.convId !== id) stopRecording(true);
    state.activeId = id;
    channelsUI?.hide();
    $('#empty-state').classList.add('hidden');
    $('#chat-view').classList.remove('hidden');
    $('#app').classList.add('chat-open');
    $('#emoji-picker').classList.add('hidden');
    renderHeader();
    renderChatList();
    if (isLockedView(conv)) {
      $('#unlock-error').textContent = '';
      $('#unlock-code').value = '';
      $('#unlock-code').focus();
      return;
    }
    try {
      const withOutbox = (list) => {
        // Keep my unconfirmed / failed messages visible across reloads of the chat.
        for (const m of state.outbox.values()) {
          if (m.convId !== id) continue;
          if (list.some((x) => x.clientId === m.id)) state.outbox.delete(m.id);
          else list.push(m);
        }
        return list;
      };
      // Show the copy saved on this device straight away, then bring it up to date.
      let saved = [];
      if (cacheable(conv)) {
        saved = await state.cache.load(id);
        if (saved.length) {
          await Promise.all(saved.map(readMessage));
          if (state.activeId !== id) return;
          state.messages.set(id, saved.slice());
          renderMessages(true);
        }
      } else {
        purgeOnce(id);
      }
      const page = await emit('messages:get', { convId: id });
      if (state.activeId !== id) return;
      let messages = page.messages;
      if (saved.length) {
        messages = await mergeWithSaved(id, saved, page);
        if (state.activeId !== id) return;
      }
      moreEarlier.set(id, page.hasMore);
      messages = withOutbox(messages);
      state.messages.set(id, messages);
      renderMessages(true);
      maybeTranslate(conv);
      markRead(id);
      if (highlight) flashMessage(highlight);
    } catch (err) {
      if (/locked/i.test(err.message)) {
        // Locked meanwhile (e.g. on another device): show the lock screen.
        Object.assign(conv, { locked: true, unlocked: false });
        if (state.activeId === id) renderHeader();
        renderChatList();
      } else {
        console.error(err);
      }
    }
    $('#message-input').focus();
  }

  function flashMessage(id) {
    const node = document.querySelector(`#messages .msg[data-id="${CSS.escape(id)}"]`);
    if (!node) return;
    node.scrollIntoView({ block: 'center' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1600);
  }

  function closeChat() {
    state.activeId = null;
    $('#app').classList.remove('chat-open');
    $('#chat-view').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    renderChatList();
  }
  $('#btn-back').addEventListener('click', closeChat);

  function markRead(id) {
    const conv = state.conversations.get(id);
    if (!conv || document.hidden || isLockedView(conv)) return;
    conv.unread = 0;
    emit('messages:read', { convId: id }).catch(() => {});
    renderChatList();
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.activeId) markRead(state.activeId);
  });

  function renderHeader() {
    const conv = state.conversations.get(state.activeId);
    if (!conv) return;
    const peer = convPeer(conv);
    paintAvatar($('#chat-avatar'), convTitle(conv), conv.type === 'group' ? conv.id : peer, {
      online: !!(peer && state.users[peer]?.online),
      group: conv.type === 'group',
    });
    $('#chat-name').textContent = convTitle(conv);
    const badgesEl = $('#chat-badges');
    badgesEl.textContent = '';
    if (peer && state.users[peer]) badgesEl.append(...userBadges(state.users[peer]));
    if (conv.disappearAfter) badgesEl.appendChild(timerIcon(`Auto-delete: ${fmtTimer(conv.disappearAfter)}`));
    $('#menu-info span').textContent = conv.type === 'group' ? 'Group info' : 'Contact info';
    $('#chat-title-btn').title = conv.type === 'group' ? 'Group info' : 'Contact info';
    const group = conv.type === 'group';
    const blocked = !group && state.blocked.has(peer);
    $('#call-buttons').classList.toggle('hidden', blocked);
    $('#btn-voice-call').classList.toggle('hidden', group);
    $('#btn-group-call').classList.toggle('hidden', !group);
    $('#menu-block').classList.toggle('hidden', group);
    $('#menu-block span').textContent = blocked ? 'Unblock contact' : 'Block contact';
    $('#menu-lock span').textContent = conv.locked ? 'Remove chat lock' : 'Lock chat';
    $('#menu-lock').classList.toggle('hidden', !!conv.hidden);
    $('#menu-hide span').textContent = conv.hidden ? 'Unhide chat' : 'Hide chat';
    $('#menu-hide').classList.toggle('hidden', isLockedView(conv));
    $('#lock-screen h2').textContent = conv.hidden ? 'This chat is hidden' : 'This chat is locked';
    $('#btn-unlock-bio').classList.toggle('hidden', !canUseBiometric());

    // Locked and not unlocked in this session: show the lock screen instead of the chat.
    const lockedView = isLockedView(conv);
    $('#lock-screen').classList.toggle('hidden', !lockedView);
    $('#messages').classList.toggle('hidden', lockedView);
    if (lockedView) forgetChatContent(conv.id);
    $('#timer-banner').classList.toggle('hidden', !conv.disappearAfter || lockedView);
    if (conv.disappearAfter) {
      $('#timer-banner-text').textContent = `Auto-delete is on. Sent messages are removed ${fmtTimer(conv.disappearAfter)} after sending. Tap to change.`;
    }

    const status = $('#chat-status');
    status.textContent = '';
    const activity = blocked ? null : activityOf(conv.id);
    status.classList.toggle('typing', !!activity);
    if (activity) {
      status.append(icon(activity.activity), activity.text);
    } else if (group) {
      status.textContent = conv.members
        .map((m) => (m === state.me.username ? 'You' : displayName(m)))
        .sort((a, b) => (a === 'You') - (b === 'You'))
        .join(', ');
    } else if (blocked) {
      status.append(icon('blocked'), 'Blocked');
    } else if (state.users[peer]?.online) {
      status.textContent = 'online';
    } else {
      status.append(icon('offline'), lastSeenText(peer) || 'offline');
    }

    // A group call is running that I'm not in: offer to join it.
    const running = group && conv.activeCall && state.calls?.convId !== conv.id ? conv.activeCall : null;
    $('#call-banner').classList.toggle('hidden', !running);
    if (running) {
      const n = running.participants.length;
      $('#call-banner-text').textContent = `Ongoing ${running.kind === 'video' ? 'video' : 'voice'} call · ${n} ${n === 1 ? 'person' : 'people'}`;
    }

    // Blocked contact: the composer is replaced by an unblock banner.
    $('#blocked-banner').classList.toggle('hidden', !blocked);
    if (blocked) $('#blocked-banner-text').textContent = `You blocked ${displayName(peer)}. Tap to unblock.`;
    $('#composer').classList.toggle('hidden', blocked || lockedView || !!state.recorder);
    paintE2eeBanner(conv, lockedView);
    paintTranslateBanner(conv, lockedView);
    $('#menu-translate').classList.toggle('hidden', lockedView);
  }

  /** "Messages in this chat are end-to-end encrypted", or why they are not. */
  async function paintE2eeBanner(conv, lockedView) {
    const banner = $('#e2ee-banner');
    if (lockedView) return banner.classList.add('hidden');
    let ok = false;
    try {
      ok = !!(await state.e2ee?.canEncrypt(conv.id));
    } catch { /* keys unavailable */ }
    if (state.activeId !== conv.id) return;
    banner.classList.toggle('hidden', false);
    banner.classList.toggle('warn', !ok);
    $('#e2ee-banner-text').textContent = ok
      ? 'Messages in this chat are end-to-end encrypted. Only people in this chat can read them.'
      : state.e2ee?.ready
        ? "Messages are not end-to-end encrypted yet: someone in this chat hasn't set up encryption."
        : 'End-to-end encryption is not available in this browser, so messages are not encrypted.';
  }

  // chat menu (block / unblock)
  $('#btn-chat-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#chat-menu').classList.toggle('hidden');
  });
  document.addEventListener('click', () => $('#chat-menu').classList.add('hidden'));
  async function setBlocked(username, blocked) {
    if (blocked && !confirm(`Block ${displayName(username)}? Blocked contacts can't call you or send you messages.`)) return;
    try {
      const { blocked: list, user } = await emit('user:block', { username, blocked });
      state.blocked = new Set(list);
      state.users[username] = { ...(state.users[username] || {}), ...user };
      if (blocked) stopRecording(false);
      renderChatList();
      renderHeader();
    } catch (err) {
      alert(err.message);
    }
  }
  $('#menu-block').addEventListener('click', () => {
    const peer = convPeer(state.conversations.get(state.activeId) || {});
    if (peer) setBlocked(peer, !state.blocked.has(peer));
  });
  $('#blocked-banner').addEventListener('click', () => {
    const peer = convPeer(state.conversations.get(state.activeId) || {});
    if (peer) setBlocked(peer, false);
  });
  $('#btn-join-call').addEventListener('click', () => startCall(state.conversations.get(state.activeId)?.activeCall?.kind || 'audio'));

  function renderMessages(scrollToEnd = false) {
    const box = $('#messages');
    const conv = state.conversations.get(state.activeId);
    if (!conv) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.textContent = '';
    const msgs = state.messages.get(conv.id) || [];
    if (moreEarlier.get(conv.id) && msgs.length) {
      const earlier = el('button', 'link load-earlier', 'Load earlier messages');
      earlier.type = 'button';
      earlier.addEventListener('click', () => loadEarlier().catch((err) => toast(err.message)));
      box.appendChild(earlier);
    }
    const chatEncrypted = msgs.some((x) => x.encrypted);
    let prev = null;
    for (const m of msgs) {
      if (!prev || !sameDay(prev.ts, m.ts)) box.appendChild(el('div', 'day', dayLabel(m.ts)));
      const mine = m.from === state.me.username;
      const first = !prev || prev.from !== m.from || !sameDay(prev.ts, m.ts);
      if (m.type === 'call') {
        box.appendChild(callBubble(m, conv, mine, first));
        prev = m;
        continue;
      }
      if (m.type === 'system') {
        const note = el('div', 'system-note');
        note.append(timerIcon(''), describeSystem(m));
        box.appendChild(note);
        prev = { ...m, from: null }; // keeps the day separator; the next bubble starts a new group
        continue;
      }
      const status = mine && !m.deleted ? statusOf(m, conv) : null;
      const covered = m.masked && !m.deleted && !mine && !state.revealed.has(m.id);
      const bubble = el('div', `msg${mine ? ' out' : ''}${first ? ' first' : ''}${m.deleted ? ' deleted' : ''}${status === 'failed' ? ' failed' : ''}${m.type === 'voice' && !m.deleted ? ' voice' : ''}${m.type === 'location' && !m.deleted ? ` place${m.live && window.Place.liveActive(m.live) ? ' live-on' : ''}` : ''}`);
      bubble.dataset.id = m.id;
      if (conv.type === 'group' && !mine && first) {
        const author = el('div', 'author', displayName(m.from));
        author.style.color = colorFor(m.from);
        bubble.appendChild(author);
      }
      if (m.statusReply && !m.deleted) bubble.appendChild(statusQuote(m.statusReply));
      if (m.deleted) {
        const text = el('span', 'text');
        text.append(icon('deleted', 'inline-icon'), 'This message was deleted');
        bubble.appendChild(text);
      } else if (m.type === 'voice') {
        bubble.appendChild(voicePlayer(m));
      } else if (m.type === 'location') {
        bubble.appendChild(placeCard(m, mine));
      } else if (covered) {
        const cover = el('button', 'masked-cover');
        cover.type = 'button';
        cover.title = 'Reveal message';
        cover.append(icon('masked', 'inline-icon'), el('span', '', 'Masked message'), el('small', '', 'Tap to reveal'));
        cover.addEventListener('click', () => { state.revealed.add(m.id); renderMessages(); maybeTranslate(conv); });
        bubble.appendChild(cover);
      } else if (m.undecryptable) {
        bubble.appendChild(el('span', 'text undecryptable', "🔒 This message can't be read on this device (it was sent before this device was set up)."));
      } else {
        // Received messages of a chat with translation on: show the translation, with a way back to the original.
        const tr = !mine && m.tr && !state.showOriginal.has(m.id) ? m.tr : null;
        bubble.appendChild(el('span', 'text', tr ? tr.text : m.text));
        if (!mine && m.tr) {
          const note = el('span', 'tr-note');
          const flip = el('button', '', tr ? 'Show original' : 'Show translation');
          flip.type = 'button';
          flip.addEventListener('click', () => {
            if (state.showOriginal.has(m.id)) state.showOriginal.delete(m.id);
            else state.showOriginal.add(m.id);
            renderMessages();
          });
          note.append(`Translated${m.tr.detected ? ` from ${langName(m.tr.detected)}` : ''} · `, flip);
          bubble.appendChild(note);
        }
      }
      const meta = el('span', 'meta');
      // In a chat that is end-to-end encrypted, mark messages that were not (API apps, automatic replies, older messages).
      if (chatEncrypted && !m.encrypted && !m.deleted && !m.localStatus) meta.appendChild(openLockSvg());
      if (m.auto && !m.deleted) meta.appendChild(el('span', 'auto-label', 'Automated'));
      if (m.expiresAt && !m.deleted) meta.appendChild(timerIcon(`Removed on ${new Date(m.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`));
      if (m.starred && !m.deleted) meta.appendChild(icon('starred'));
      if (m.masked && !m.deleted && !covered) meta.appendChild(icon('masked'));
      meta.appendChild(document.createTextNode(timeOf(m.ts)));
      if (status) meta.appendChild(icon(status));
      bubble.appendChild(meta);
      if (status === 'failed') {
        const retry = el('button', 'retry', 'Not sent. Tap to retry');
        retry.type = 'button';
        retry.title = m.error || 'Not sent';
        retry.addEventListener('click', () => deliver(m));
        bubble.appendChild(retry);
      }
      if (!m.deleted && !m.localStatus) {
        const star = el('button', `star${m.starred ? ' on' : ''}`);
        star.type = 'button';
        star.title = m.starred ? 'Unstar message' : 'Star message';
        star.appendChild(icon('starred', 'star-icon'));
        star.addEventListener('click', () => emit('message:star', { id: m.id, starred: !m.starred }).catch((e) => alert(e.message)));
        bubble.appendChild(star);
      }
      if (mine && !m.deleted && !m.localStatus) {
        const del = el('button', 'del', '✕');
        del.title = 'Delete message';
        del.addEventListener('click', () => {
          if (confirm('Delete this message for everyone?')) emit('message:delete', { id: m.id }).catch((e) => alert(e.message));
        });
        bubble.appendChild(del);
      } else if (status === 'failed') {
        const del = el('button', 'del', '✕');
        del.title = 'Discard message';
        del.addEventListener('click', () => discard(m));
        bubble.appendChild(del);
      }
      box.appendChild(bubble);
      prev = m;
    }
    if (scrollToEnd || nearBottom) box.scrollTop = box.scrollHeight;
    scheduleCacheSave(conv.id);
  }

  /** The status update a message replies to, shown above the reply. */
  function statusQuote(r) {
    const q = el('button', 'status-quote');
    q.type = 'button';
    q.title = 'View status';
    const who = r.owner === state.me.username ? 'You' : displayName(r.owner);
    const body = el('div', 'sq-body');
    body.appendChild(el('div', 'sq-who', `${who} · Status`));
    body.appendChild(el('div', 'sq-text', r.type === 'image' ? `📷 ${r.preview || 'Photo'}` : r.preview));
    q.appendChild(body);
    if (r.type === 'text') {
      const sw = el('div', 'sq-swatch', r.preview.slice(0, 2));
      sw.style.background = r.bg || 'var(--green)';
      q.appendChild(sw);
    }
    q.addEventListener('click', () => {
      if (!statusUpdates.openById(r.statusId)) toast('This status update is no longer available');
    });
    return q;
  }

  function callBubble(m, conv, mine, first) {
    const { title, sub, missed, icon: iconName } = describeCall(m);
    const bubble = el('div', `msg call-entry${mine ? ' out' : ''}${first ? ' first' : ''}${missed ? ' missed' : ''}`);
    bubble.dataset.id = m.id;
    bubble.title = 'Call again';
    const row = el('div', 'call-row');
    row.appendChild(icon(iconName, 'call-entry-icon'));
    const text = el('div');
    text.appendChild(el('div', 'call-title', title));
    text.appendChild(el('div', 'call-sub', sub));
    row.appendChild(text);
    bubble.appendChild(row);
    bubble.appendChild(el('span', 'meta', timeOf(m.ts)));
    bubble.addEventListener('click', () => startCall(m.call.kind, conv.id));
    return bubble;
  }

  function startCall(kind, convId = state.activeId) {
    const conv = state.conversations.get(convId);
    if (!conv || !state.calls) return;
    const group = conv.type === 'group';
    if (!group && state.blocked.has(convPeer(conv))) {
      alert(`Unblock ${convTitle(conv)} to call them.`);
      return;
    }
    stopRecording(false);
    state.calls.start(conv.id, {
      kind: (group && conv.activeCall?.kind) || kind, // joining a running call keeps its kind
      group,
      title: convTitle(conv),
      key: group ? conv.id : convPeer(conv),
    });
  }
  $('#btn-voice-call').addEventListener('click', () => startCall('audio'));
  $('#btn-group-call').addEventListener('click', () => startCall('audio'));
  $('#btn-video-call').addEventListener('click', () => startCall('video'));

  // ---------- voice messages: playback ----------

  const player = new Audio();
  let playingId = null;

  /** Object URL for uploaded media (voice audio, status photos); downloaded once with my token. */
  async function mediaUrl(id) {
    if (!state.voiceUrls.has(id)) {
      const res = await fetch(`/media/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${state.token}`, 'X-App-Session': APP_SESSION } });
      if (!res.ok) throw new Error('Could not load media');
      state.voiceUrls.set(id, URL.createObjectURL(await res.blob()));
    }
    return state.voiceUrls.get(id);
  }

  /** An encrypted voice message: download the ciphertext, decrypt it on this device, play it from memory. */
  async function encryptedVoiceUrl(m) {
    const id = m.voice.mediaId;
    if (!state.voiceUrls.has(id)) {
      const res = await fetch(`/media/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${state.token}`, 'X-App-Session': APP_SESSION } });
      if (!res.ok) throw new Error('Could not load media');
      const { media } = await state.e2ee.decrypt(m, new Uint8Array(await res.arrayBuffer()));
      state.voiceUrls.set(id, URL.createObjectURL(new Blob([media], { type: m.voice.mime })));
    }
    return state.voiceUrls.get(id);
  }
  const voiceUrl = (m) => (m.localUrl ? Promise.resolve(m.localUrl) : m.e2ee ? encryptedVoiceUrl(m) : mediaUrl(m.voice.mediaId));

  function voicePlayer(m) {
    const wrap = el('div', 'voice-player');
    const btn = el('button', 'voice-btn');
    btn.type = 'button';
    const playing = playingId === m.id && !player.paused;
    btn.textContent = playing ? '❚❚' : '▶';
    btn.title = playing ? 'Pause' : 'Play voice message';
    const bar = el('input', 'voice-bar');
    bar.type = 'range';
    bar.min = 0;
    bar.max = 1000;
    bar.value = playingId === m.id && player.duration ? Math.round((player.currentTime / player.duration) * 1000) : 0;
    const time = el('span', 'voice-time', fmtDuration(playingId === m.id ? Math.floor(player.currentTime) : m.voice.duration));
    wrap.append(btn, bar, time);

    btn.addEventListener('click', async () => {
      if (playingId === m.id && !player.paused) {
        player.pause();
        return;
      }
      try {
        const url = await voiceUrl(m);
        if (playingId !== m.id) {
          player.src = url;
          playingId = m.id;
        }
        await player.play();
      } catch (err) {
        alert(err.message);
      }
    });
    bar.addEventListener('input', () => {
      if (playingId === m.id && player.duration) player.currentTime = (bar.value / 1000) * player.duration;
    });
    return wrap;
  }

  function syncPlayer() {
    const bubble = playingId && document.querySelector(`.msg[data-id="${CSS.escape(playingId)}"]`);
    if (!bubble) return;
    const playing = !player.paused;
    bubble.querySelector('.voice-btn').textContent = playing ? '❚❚' : '▶';
    if (player.duration && Number.isFinite(player.duration)) bubble.querySelector('.voice-bar').value = Math.round((player.currentTime / player.duration) * 1000);
    bubble.querySelector('.voice-time').textContent = fmtDuration(Math.floor(player.currentTime));
  }
  ['play', 'pause', 'timeupdate'].forEach((ev) => player.addEventListener(ev, syncPlayer));
  player.addEventListener('ended', () => {
    playingId = null;
    if (state.activeId) renderMessages();
  });

  /** Add a server message, replacing my optimistic copy of it (matched by clientId). */
  function upsertMessage(msg) {
    const conv = state.conversations.get(msg.convId);
    const list = state.messages.get(msg.convId);
    if (list) {
      const i = list.findIndex((m) => m.id === msg.id || (msg.clientId && m.id === msg.clientId));
      if (i >= 0) {
        // My own voice message: keep playing from the local recording instead of downloading it.
        if (list[i].localUrl && msg.voice) state.voiceUrls.set(msg.voice.mediaId, list[i].localUrl);
        if (playingId === list[i].id) playingId = msg.id;
        list[i] = msg;
      } else {
        list.push(msg);
      }
    }
    if (msg.clientId) state.outbox.delete(msg.clientId);
    if (conv && (!conv.lastMessage || conv.lastMessage.ts <= msg.ts || conv.lastMessage.id === msg.clientId)) {
      conv.lastMessage = msg;
    }
  }

  function refreshConversation(convId) {
    if (convId === state.activeId) renderMessages(true);
    renderChatList();
  }

  // ---------- sending ----------

  const SEND_TIMEOUT_MS = 10000;
  const VOICE_TIMEOUT_MS = 30000; // uploads take longer

  /** The payload for the server: encrypted for everyone in the chat when possible, else plain (and marked so). */
  async function buildPayload(msg, voice) {
    const conv = state.conversations.get(msg.convId);
    const base = voice
      ? { convId: msg.convId, clientId: msg.id, duration: msg.voice.duration, mime: msg.voice.mime }
      : { convId: msg.convId, masked: !!msg.masked, clientId: msg.id };
    if (conv && state.e2ee?.ready && await state.e2ee.canEncrypt(conv.id).catch(() => false)) {
      const sealed = await state.e2ee.encrypt(conv, voice ? { kind: 'voice' } : { t: msg.text }, voice ? new Uint8Array(msg.audio) : undefined);
      msg.encrypted = true;
      return voice ? { ...base, e2ee: sealed.envelope, data: sealed.media } : { ...base, e2ee: sealed.envelope };
    }
    msg.encrypted = false;
    return voice ? { ...base, data: msg.audio } : { ...base, text: msg.text };
  }

  /** Send (or re-send) one of my messages; failures leave it in the chat marked as failed. */
  async function deliver(msg) {
    msg.localStatus = 'sending';
    delete msg.error;
    refreshConversation(msg.convId);
    const voice = msg.type === 'voice';
    const fail = (error) => {
      if (!state.outbox.has(msg.id)) return; // confirmed meanwhile (e.g. via message:new)
      msg.localStatus = 'failed';
      msg.error = error;
      refreshConversation(msg.convId);
    };
    if (!state.socket?.connected) return fail('You are offline');
    let payload;
    try {
      payload = await buildPayload(msg, voice);
    } catch (err) {
      console.error(err);
      return fail('Could not encrypt this message');
    }
    state.socket.timeout(voice ? VOICE_TIMEOUT_MS : SEND_TIMEOUT_MS).emit(voice ? 'voice:send' : 'message:send', payload, (err, res) => {
      if (err) fail('No response from the server');
      else if (!res?.ok) {
        // Someone's keys changed while we were encrypting: fetch the new keys and encrypt again, once.
        if (res?.code === 'keys_changed' && !msg.keyRetry) {
          msg.keyRetry = true;
          state.e2ee?.invalidate();
          deliver(msg);
          return;
        }
        fail(res?.error || 'Could not send');
      } else {
        // The server only has ciphertext: keep the text I typed.
        if (res.message.e2ee) Object.assign(res.message, { text: msg.text, encrypted: true });
        upsertMessage(res.message);
        refreshConversation(msg.convId);
      }
    });
  }

  function discard(msg) {
    state.outbox.delete(msg.id);
    if (msg.localUrl) URL.revokeObjectURL(msg.localUrl);
    const list = state.messages.get(msg.convId);
    if (list) state.messages.set(msg.convId, list.filter((m) => m !== msg));
    const conv = state.conversations.get(msg.convId);
    if (conv?.lastMessage === msg) conv.lastMessage = (state.messages.get(msg.convId) || []).filter((m) => !m.localStatus).pop() || null;
    refreshConversation(msg.convId);
  }

  /** Show a new message of mine right away and send it. `extra` holds type-specific fields. */
  function sendNew(convId, text, masked, extra = {}) {
    const clientId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const msg = {
      ...extra,
      id: clientId,
      clientId,
      convId,
      from: state.me.username,
      text,
      ts: Date.now(),
      deliveredTo: [],
      readBy: [],
      localStatus: 'sending',
    };
    if (masked) msg.masked = true;
    state.outbox.set(clientId, msg);
    if (!state.messages.has(convId)) state.messages.set(convId, []);
    state.messages.get(convId).push(msg);
    const conv = state.conversations.get(convId);
    if (conv) conv.lastMessage = msg;
    deliver(msg);
  }

  function onMessage(msg) {
    const conv = state.conversations.get(msg.convId);
    if (!conv) {
      // Conversation we don't know about yet; reload list.
      loadConversations();
      return;
    }
    upsertMessage(msg);
    const mine = msg.from === state.me.username;
    if (!mine) localNotify(msg, conv);
    if (msg.convId === state.activeId) {
      renderMessages(mine);
      if (!mine) markRead(msg.convId);
      maybeTranslate(conv);
    } else if (!mine && !msg.readBy.includes(state.me.username)) {
      conv.unread = (conv.unread || 0) + 1;
    }
    // Sender stops typing once a message arrives.
    const typingMap = state.typing.get(msg.convId);
    if (typingMap?.has(msg.from)) {
      clearTimeout(typingMap.get(msg.from).timer);
      typingMap.delete(msg.from);
      if (msg.convId === state.activeId) renderHeader();
    }
    renderChatList();
  }

  // ---------- composer ----------

  const input = $('#message-input');
  let typingTimer = null;
  let isTyping = false;

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }

  function stopTyping() {
    clearTimeout(typingTimer);
    if (isTyping && state.activeId) state.socket.emit('typing', { convId: state.activeId, isTyping: false });
    isTyping = false;
  }

  /** Empty composer shows the record button; typing shows send. */
  function updateComposerButtons() {
    const empty = !input.value.trim();
    $('#btn-send').classList.toggle('hidden', empty);
    $('#btn-record').classList.toggle('hidden', !empty);
  }

  input.addEventListener('input', () => {
    autosize();
    updateComposerButtons();
    if (!state.activeId) return;
    if (!isTyping) {
      isTyping = true;
      state.socket.emit('typing', { convId: state.activeId, isTyping: true });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 2500);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });

  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !state.activeId) return;
    stopTyping();
    input.value = '';
    autosize();
    updateComposerButtons();
    $('#emoji-picker').classList.add('hidden');
    sendNew(state.activeId, text, state.maskNext);
    setMaskNext(false);
  });

  // ---------- voice messages: recording ----------

  const VOICE_MAX_SECONDS = 5 * 60;
  state.recorder = null; // { convId, media, stream, chunks, startedAt, clock, keepAlive }

  function pickAudioType() {
    const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
    return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
  }

  const sendActivity = (convId, on) => state.socket?.emit('typing', { convId, isTyping: on, activity: 'recording' });

  async function startRecording() {
    if (state.recorder || !state.activeId) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      alert('Voice messages need a secure connection (https:// or localhost) and a browser that can record audio.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      alert('Microphone access was denied or no microphone was found.');
      return;
    }
    const convId = state.activeId;
    const type = pickAudioType();
    const media = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 32000 });
    const rec = { convId, media, stream, chunks: [], startedAt: Date.now() };
    state.recorder = rec;
    media.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
    media.start(250);
    stopTyping();
    sendActivity(convId, true);
    rec.keepAlive = setInterval(() => sendActivity(convId, true), 3000);
    const tick = () => {
      const secs = Math.floor((Date.now() - rec.startedAt) / 1000);
      $('#rec-time').textContent = fmtDuration(secs);
      if (secs >= VOICE_MAX_SECONDS) stopRecording(true);
    };
    tick();
    rec.clock = setInterval(tick, 250);
    $('#composer').classList.add('hidden');
    $('#recorder').classList.remove('hidden');
  }

  /** Stop recording; `send` uploads it as a voice message, otherwise it is discarded. */
  function stopRecording(send) {
    const rec = state.recorder;
    if (!rec) return;
    state.recorder = null;
    clearInterval(rec.clock);
    clearInterval(rec.keepAlive);
    sendActivity(rec.convId, false);
    $('#recorder').classList.add('hidden');
    $('#composer').classList.remove('hidden');
    const duration = Math.max(1, Math.round((Date.now() - rec.startedAt) / 1000));
    rec.media.onstop = async () => {
      rec.stream.getTracks().forEach((t) => t.stop());
      if (!send || !rec.chunks.length) return;
      const blob = new Blob(rec.chunks, { type: rec.media.mimeType || 'audio/webm' });
      sendNew(rec.convId, '', false, {
        type: 'voice',
        voice: { duration, mime: blob.type },
        audio: await blob.arrayBuffer(),
        localUrl: URL.createObjectURL(blob),
      });
    };
    if (rec.media.state !== 'inactive') rec.media.stop();
    else rec.media.onstop();
    if (state.activeId) renderHeader();
  }

  $('#btn-record').addEventListener('click', startRecording);
  $('#btn-rec-send').addEventListener('click', () => stopRecording(true));
  $('#btn-rec-cancel').addEventListener('click', () => stopRecording(false));

  // masked messages: hidden for recipients until they tap to reveal
  function setMaskNext(on) {
    state.maskNext = on;
    const btn = $('#btn-mask');
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Masked: recipients must tap to reveal (click to turn off)' : 'Send as masked message';
    input.placeholder = on ? 'Type a masked message' : 'Type a message';
  }
  $('#btn-mask').addEventListener('click', () => { setMaskNext(!state.maskNext); input.focus(); });

  // emoji picker
  const picker = $('#emoji-picker');
  for (const em of EMOJIS) {
    const b = el('button', '', em);
    b.type = 'button';
    b.addEventListener('click', () => {
      const { selectionStart: s, selectionEnd: t, value } = input;
      input.value = value.slice(0, s) + em + value.slice(t);
      input.selectionStart = input.selectionEnd = s + em.length;
      updateComposerButtons();
      input.focus();
    });
    picker.appendChild(b);
  }
  $('#btn-emoji').addEventListener('click', () => picker.classList.toggle('hidden'));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.emoji-wrap')) picker.classList.add('hidden');
  });

  // ---------- notifications (push) ----------
  //
  // Notifications are asked for only when the person taps "Turn on" (never on page load). They say who and what kind,
  // never the message. The browser's subscription belongs to this browser, so it is removed on log out (the next
  // person to sign in here would otherwise get the previous person's notifications) and only restored when this
  // account turned notifications on in this browser.

  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
  const pushFlag = () => `chat.push.${state.me?.username}`;
  let swReady = null;
  function serviceWorkerReady() {
    if (!pushSupported()) return Promise.resolve(null);
    swReady ||= navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).catch(() => null);
    return swReady;
  }
  const keyBytes = (b64u) => {
    const raw = atob((b64u + '='.repeat((4 - (b64u.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };

  async function pushStatus() {
    const cfg = await emit('push:config');
    state.notif = cfg;
    const reg = await serviceWorkerReady();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return { cfg, reg, sub, on: !!sub && Notification.permission === 'granted' && storage.get(pushFlag()) === sub.endpoint };
  }

  async function renderNotifications() {
    const status = $('#notif-status');
    const help = $('#notif-help');
    const btn = $('#btn-notif-toggle');
    const test = $('#btn-notif-test');
    const prefs = $('#notif-prefs');
    help.textContent = '';
    if (!pushSupported()) {
      status.textContent = 'This browser cannot show notifications.';
      help.textContent = 'On iPhone and iPad, tap Share, then Add to Home Screen, and open VartiQ from the Home Screen. Notifications also need a secure (https) address.';
      btn.disabled = true;
      test.classList.add('hidden');
      prefs.classList.add('hidden');
      return;
    }
    let st;
    try {
      st = await pushStatus();
    } catch (err) {
      toast(err.message);
      return;
    }
    const blocked = Notification.permission === 'denied';
    btn.dataset.state = st.on ? 'on' : 'off';
    btn.textContent = st.on ? 'Turn off' : 'Turn on';
    btn.disabled = !st.cfg.enabled || (blocked && !st.on);
    test.classList.toggle('hidden', !st.on);
    prefs.classList.toggle('hidden', !st.on);
    if (!st.cfg.enabled) status.textContent = 'Notifications are turned off by the administrator.';
    else if (st.on) status.textContent = `On for this device. ${st.cfg.devices} device${st.cfg.devices === 1 ? '' : 's'} on your account.`;
    else status.textContent = 'Off for this device.';
    if (blocked && !st.on) help.textContent = 'Notifications are blocked for this site in your browser. Allow them in the browser\'s site settings (the lock icon next to the address), then come back and tap Turn on.';
    $('#np-messages').checked = st.cfg.preferences.messages;
    $('#np-calls').checked = st.cfg.preferences.calls;
    $('#np-preview').checked = st.cfg.preferences.preview;
    $('#notifications-summary').textContent = st.on ? 'On for this device' : 'Get alerts for messages and calls when the app is closed';
  }

  async function openNotifications() {
    openPanel('#panel-notifications');
    await renderNotifications();
  }
  $('#btn-notifications').addEventListener('click', openNotifications);

  $('#btn-notif-toggle').addEventListener('click', async () => {
    const btn = $('#btn-notif-toggle');
    btn.disabled = true;
    try {
      if (btn.dataset.state === 'on') {
        const st = await pushStatus();
        if (st.sub) {
          await emit('push:unsubscribe', { endpoint: st.sub.endpoint });
          await st.sub.unsubscribe();
        }
        storage.del(pushFlag());
        toast('Notifications are off on this device');
      } else {
        // Asked straight from the tap (browsers only allow the question in answer to one).
        const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        if (perm !== 'granted') throw new Error('Notifications were not allowed. You can allow them in your browser\'s site settings.');
        const st = await pushStatus();
        if (!st.cfg.enabled) throw new Error('Notifications are turned off by the administrator');
        let sub = st.sub;
        if (sub) {
          // A subscription made with another server key cannot be reused.
          try { await sub.unsubscribe(); } catch { /* ignore */ }
          sub = null;
        }
        sub = await st.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(st.cfg.publicKey) });
        await emit('push:subscribe', { subscription: sub.toJSON(), userAgent: navigator.userAgent.slice(0, 120) });
        storage.set(pushFlag(), sub.endpoint);
        toast('Notifications are on for this device');
      }
    } catch (err) {
      toast(err.message);
    }
    await renderNotifications();
  });

  $('#btn-notif-test').addEventListener('click', async () => {
    try {
      await emit('push:test');
      toast('Test sent. It should arrive in a moment.');
    } catch (err) {
      toast(err.message);
    }
  });
  for (const [id, key] of [['#np-messages', 'messages'], ['#np-calls', 'calls'], ['#np-preview', 'preview']]) {
    $(id).addEventListener('change', async (e) => {
      try {
        const res = await emit('push:settings', { [key]: e.target.checked });
        state.notif = { ...state.notif, preferences: res.preferences };
      } catch (err) {
        e.target.checked = !e.target.checked;
        toast(err.message);
      }
    });
  }

  /** A message arrived while this tab is hidden: the server sends no push to someone who is connected, so show it here. */
  function localNotify(msg, conv) {
    if (document.visibilityState !== 'hidden' || !pushSupported() || Notification.permission !== 'granted' || storage.get(pushFlag()) == null) return;
    const prefs = state.notif?.preferences || { messages: true, preview: true };
    if (!prefs.messages || msg.type === 'call' || msg.type === 'system') return;
    const generic = conv.locked || conv.hidden || !prefs.preview;
    const what = msg.type === 'voice' ? 'Voice message' : msg.type === 'location' ? 'Location' : 'New message';
    const title = generic ? 'VartiQ' : conv.type === 'group' ? conv.name : displayName(msg.from);
    const body = !generic && conv.type === 'group' ? `${displayName(msg.from)}: ${what}` : what;
    serviceWorkerReady().then((reg) => reg?.showNotification(title, {
      body, tag: generic ? 'msg' : `c-${conv.id}`, renotify: true, icon: '/app-icons/icon-192.png', badge: '/app-icons/icon-32.png', data: { convId: conv.locked || conv.hidden ? null : conv.id },
    })).catch(() => {});
  }

  function localNotifyCall(call) {
    if (document.visibilityState !== 'hidden' || !pushSupported() || Notification.permission !== 'granted' || storage.get(pushFlag()) == null) return;
    if (state.notif?.preferences && !state.notif.preferences.calls) return;
    const conv = state.conversations.get(call.convId);
    const generic = conv?.locked || conv?.hidden || state.notif?.preferences?.preview === false;
    serviceWorkerReady().then((reg) => reg?.showNotification(generic ? 'VartiQ' : (call.user?.displayName || call.from), {
      body: `Incoming ${call.kind === 'video' ? 'video' : 'voice'} call`, tag: `call-${call.callId}`, requireInteraction: true, icon: '/app-icons/icon-192.png', data: { convId: generic ? null : call.convId },
    })).catch(() => {});
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'open-chat' && state.conversations.has(e.data.convId)) openChat(e.data.convId);
      else if (e.data?.type === 'push-resubscribe') resyncPush().catch(() => {});
    });
  }

  /** After sign-in: keep the server's copy of this browser's subscription current (only if this account turned it on here). */
  async function resyncPush() {
    const cfg = await emit('push:config');
    state.notif = cfg;
    if (!cfg.enabled || !pushSupported() || Notification.permission !== 'granted' || storage.get(pushFlag()) == null) return;
    const reg = await serviceWorkerReady();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub && sub.endpoint === storage.get(pushFlag())) {
      await emit('push:subscribe', { subscription: sub.toJSON(), userAgent: navigator.userAgent.slice(0, 120) });
    } else if (reg) {
      // The browser dropped or replaced it: try to make a fresh one with the same permission.
      try {
        const fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.publicKey) });
        await emit('push:subscribe', { subscription: fresh.toJSON(), userAgent: navigator.userAgent.slice(0, 120) });
        storage.set(pushFlag(), fresh.endpoint);
      } catch { storage.del(pushFlag()); }
    }
  }

  // ---------- sharing a location ----------
  //
  // A position is sent like a message: encrypted for the people in the chat when possible. A live share keeps sending
  // the new position (only while VartiQ is open: browsers do not let a web page track you in the background), stops at
  // the time chosen or when you tap Stop, and the position is then erased from the server.

  const GEO = { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 };
  const geoMessage = (e) => (e.code === 1
    ? 'Location is blocked for this site. Allow it in your browser\'s site settings and try again.'
    : e.code === 2 ? 'Your location is not available right now.' : 'Getting your location took too long. Try again.');

  function currentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('This browser cannot share a location'));
      return navigator.geolocation.getCurrentPosition(
        (pos) => { const loc = window.Place.fromPosition(pos); if (loc) resolve(loc); else reject(new Error('Could not read your location')); },
        (err) => reject(new Error(geoMessage(err))),
        GEO,
      );
    });
  }

  /** The position as the server should get it: inside an encryption envelope when the chat can be encrypted. */
  async function sealPlace(conv, loc) {
    if (conv && state.e2ee?.ready && await state.e2ee.canEncrypt(conv.id).catch(() => false)) {
      const sealed = await state.e2ee.encrypt(conv, { t: 'Location', loc });
      return { e2ee: sealed.envelope };
    }
    return { location: loc };
  }

  function pinIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z');
    svg.appendChild(path);
    return svg;
  }

  function placeCard(m, mine) {
    const card = el('div', 'place-card');
    const live = m.live;
    const active = window.Place.liveActive(live);
    const title = el('div', 'place-title');
    title.append(pinIcon(), live ? (active ? 'Live location' : 'Live location ended') : 'Location');
    card.appendChild(title);
    if (m.undecryptable) {
      card.appendChild(el('span', 'text undecryptable', "🔒 This location can't be read on this device (it was sent before this device was set up)."));
      return card;
    }
    const loc = window.Place.clean(m.loc || m.location);
    if (live && active) card.appendChild(el('div', 'place-live', `Sharing until ${timeOf(live.until)}${live.updatedAt ? ` · updated ${window.Place.ago(live.updatedAt)}` : ''}`));
    if (loc && (!live || active)) {
      card.appendChild(el('div', 'place-coords', window.Place.describe(loc)));
      const open = el('a', 'place-open', 'Open in map');
      open.href = window.Place.mapUrl(loc);
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      card.appendChild(open);
    }
    if (mine && live && active && !m.localStatus) {
      const stop = el('button', 'place-stop', 'Stop sharing');
      stop.type = 'button';
      stop.addEventListener('click', () => stopLive(m.id).catch((e) => toast(e.message)));
      card.appendChild(stop);
    }
    return card;
  }

  const newClientId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  async function sharePlace(convId, liveSeconds) {
    const conv = state.conversations.get(convId);
    const loc = await currentPosition();
    const clientId = newClientId();
    for (let attempt = 0; ; attempt++) {
      const sealed = await sealPlace(conv, loc);
      try {
        const res = await emit('location:send', { convId, live: liveSeconds, clientId, ...sealed });
        const msg = res.message;
        if (msg.e2ee) Object.assign(msg, { text: 'Location', encrypted: true, loc });
        upsertMessage(msg);
        refreshConversation(convId);
        if (liveSeconds) startLive(convId, msg.id, msg.live.until, loc);
        return;
      } catch (err) {
        // Someone's keys changed while we were encrypting: fetch the new keys and encrypt again, once.
        if (err.code === 'keys_changed' && attempt === 0) { state.e2ee?.invalidate(); continue; }
        throw err;
      }
    }
  }

  async function placeDialog() {
    const convId = state.activeId;
    if (!convId) return;
    await dialog({
      title: 'Share location',
      text: 'Your browser will ask to allow your location. Only the people in this chat see it. Opening it in a map shows it to the map service you choose. A live location is updated while VartiQ stays open and stops when the time is up or when you tap Stop sharing; then your position is erased.',
      fields: [{
        name: 'mode', label: 'What to share', value: 'once',
        options: [['once', 'My current location (once)'], ...window.Place.LIVE_CHOICES.map((c) => [String(c.seconds), `Live location for ${c.label}`])],
      }],
      submit: 'Share',
      onSubmit: async ({ mode }) => sharePlace(convId, mode === 'once' ? 0 : Number(mode)),
    });
  }
  $('#btn-place').addEventListener('click', placeDialog);

  // The running live share of this person (one at a time in the app).
  const liveShare = { id: null, convId: null, until: 0, watch: null, timer: null, last: null, lastSent: 0, busy: false };
  const liveKey = () => `chat.live.${state.me?.username}`;

  function updateLiveBanner() {
    const banner = $('#live-banner');
    const on = !!liveShare.id;
    banner.classList.toggle('hidden', !on);
    if (!on) return;
    const conv = state.conversations.get(liveShare.convId);
    $('#live-banner-text').textContent = `Sharing your live location with ${conv ? (conv.type === 'group' ? conv.name : displayName(conv.members.find((u) => u !== state.me.username))) : 'a chat'} until ${timeOf(liveShare.until)}. Updates only while VartiQ is open.`;
  }

  function startLive(convId, id, until, first) {
    clearLiveLocal();
    Object.assign(liveShare, { id, convId, until, last: first || null, lastSent: first ? Date.now() : 0, busy: false });
    storage.set(liveKey(), JSON.stringify({ id, convId, until }));
    liveShare.watch = navigator.geolocation.watchPosition(onLivePosition, (err) => {
      if (err.code === 1) { toast(geoMessage(err)); stopLive(id).catch(() => {}); }
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
    liveShare.timer = setTimeout(() => { stopLive(id).catch(() => {}); }, Math.max(0, until - Date.now()));
    updateLiveBanner();
  }

  /** Stop watching the position here (does not tell the server). */
  function clearLiveLocal() {
    if (liveShare.watch != null) navigator.geolocation.clearWatch(liveShare.watch);
    clearTimeout(liveShare.timer);
    Object.assign(liveShare, { id: null, convId: null, until: 0, watch: null, timer: null, last: null, lastSent: 0, busy: false });
    if (state.me) storage.del(liveKey());
    updateLiveBanner();
  }

  /** Stop sharing: the server erases the position and tells the chat. */
  async function stopLive(id = liveShare.id) {
    clearLiveLocal();
    if (!id || !state.socket?.connected) return;
    try {
      await emit('location:stop', { id });
    } catch (err) {
      if (err.code !== 'not_found') throw err; // already ended: fine
    }
  }
  $('#live-banner-stop').addEventListener('click', () => stopLive().catch((e) => toast(e.message)));

  async function onLivePosition(pos) {
    const loc = window.Place.fromPosition(pos);
    const id = liveShare.id;
    if (!loc || !id || liveShare.busy) return;
    const now = Date.now();
    if (now >= liveShare.until) { stopLive(id).catch(() => {}); return; }
    if (!window.Place.shouldSend(liveShare.last, loc, now, liveShare.lastSent)) return;
    liveShare.busy = true;
    try {
      const sealed = await sealPlace(state.conversations.get(liveShare.convId), loc);
      await emit('location:update', { id, ...sealed });
      liveShare.last = loc;
      liveShare.lastSent = now;
    } catch (err) {
      if (['not_found', 'live_ended', 'feature_disabled'].includes(err.code)) clearLiveLocal(); // ended elsewhere, or switched off
      else if (err.code === 'chat_locked') stopLive(id).catch(() => {}); // the chat was locked: stop sharing from it
      else if (err.code === 'keys_changed') state.e2ee?.invalidate();
      // anything else (a brief network problem, "too frequent") just waits for the next position
    } finally {
      liveShare.busy = false;
    }
  }

  /** A new position (or the end) of someone's live share, sent by the server. */
  function onLocationUpdate(msg) {
    const list = state.messages.get(msg.convId);
    const i = list ? list.findIndex((m) => m.id === msg.id) : -1;
    if (i >= 0) {
      if (list[i].from === state.me.username && list[i].loc && !msg.loc && !msg.undecryptable) msg.loc = list[i].loc;
      list[i] = msg;
    }
    const conv = state.conversations.get(msg.convId);
    if (conv?.lastMessage?.id === msg.id) conv.lastMessage = msg;
    if (liveShare.id === msg.id && msg.live?.endedAt) clearLiveLocal();
    if (msg.convId === state.activeId) renderMessages();
    renderChatList();
  }

  // Positions and "updated 2 min ago" go stale on screen: refresh a visible live share now and then.
  setInterval(() => {
    if (document.visibilityState !== 'visible' || !state.activeId) return;
    if ((state.messages.get(state.activeId) || []).some((m) => m.live && window.Place.liveActive(m.live))) renderMessages();
  }, 30000);

  /** After sign-in: pick up where the person left off. */
  function resumeNotificationsAndLocation() {
    if (pushSupported()) serviceWorkerReady();
    resyncPush().catch(() => {});
    // Opened from a notification: go to that chat.
    const wanted = new URLSearchParams(location.search).get('open');
    if (wanted && state.conversations.has(wanted)) {
      openChat(wanted);
      history.replaceState(null, '', location.pathname);
    }
    // A live share that was running when the page was closed carries on (until its time is up).
    try {
      const saved = JSON.parse(storage.get(liveKey()) || 'null');
      if (saved && saved.until > Date.now() && !liveShare.id && navigator.geolocation) {
        const msg = (state.messages.get(saved.convId) || []).find((m) => m.id === saved.id);
        startLive(saved.convId, saved.id, saved.until, msg?.loc || null);
      } else if (saved && !liveShare.id) {
        storage.del(liveKey());
      }
    } catch { storage.del(liveKey()); }
  }

  /** Log out: this browser stops getting this account's notifications and the live share stops. */
  async function detachNotificationsAndLocation() {
    try {
      if (liveShare.id) await stopLive();
      if (state.me && storage.get(pushFlag()) != null && pushSupported()) {
        const reg = await serviceWorkerReady();
        const sub = reg && await reg.pushManager.getSubscription();
        if (sub && state.socket?.connected) await emit('push:unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
        if (sub) await sub.unsubscribe().catch(() => {});
        storage.del(pushFlag());
      }
    } catch { /* logging out must not fail */ }
  }

  // ---------- side panels ----------

  function openPanel(id) {
    if (id !== '#panel-hidden' && state.hiddenOpen) closeHidden();
    document.querySelectorAll('.panel.overlay').forEach((p) => p.classList.add('hidden'));
    $(id).classList.remove('hidden');
  }
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => b.closest('.panel').classList.add('hidden')));
  // Leaving the hidden-chats panel (Profile's back arrow etc.) closes them again.
  $('#panel-profile [data-close]').addEventListener('click', () => state.hiddenOpen && closeHidden());

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function userRow(u, { checkbox = false, checked = false } = {}) {
    const li = el('li');
    li.appendChild(avatar(u.displayName, u.username, { online: u.online }));
    const body = el('div', 'body');
    const top = el('div', 'row');
    top.appendChild(el('span', 'name', u.displayName));
    top.append(...userBadges(u));
    if (checkbox) {
      const cb = el('input', 'check');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.tabIndex = -1;
      top.appendChild(cb);
    }
    body.appendChild(top);
    const bottom = el('div', 'row');
    bottom.appendChild(el('span', 'preview', `@${u.username} · ${u.about || ''}`));
    body.appendChild(bottom);
    li.appendChild(body);
    return li;
  }

  // New chat
  async function searchPeople(q, target, render) {
    try {
      const { users } = await emit('users:search', { q });
      users.forEach((u) => (state.users[u.username] = { ...(state.users[u.username] || {}), ...u }));
      target.textContent = '';
      if (!users.length) target.appendChild(el('p', 'muted pad', 'No people found.'));
      users.forEach((u) => target.appendChild(render(u)));
    } catch (err) {
      console.error(err);
    }
  }

  const renderNewChatResults = (q) => searchPeople(q, $('#user-results'), (u) => {
    const li = userRow(u);
    const avatarEl = li.querySelector('.avatar');
    if (avatarEl) {
      avatarEl.classList.add('tappable');
      avatarEl.title = 'View profile';
      avatarEl.addEventListener('click', (e) => {
        e.stopPropagation();
        $('#panel-new-chat').classList.add('hidden');
        showProfile(u.username);
      });
    }
    const hide = el('button', 'icon-btn row-action');
    hide.type = 'button';
    hide.title = `Hide chat with ${u.displayName}`;
    hide.setAttribute('aria-label', hide.title);
    hide.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 7a5 5 0 0 1 5 5c0 .65-.13 1.26-.36 1.83l2.92 2.92A11.8 11.8 0 0 0 22.99 12 11.83 11.83 0 0 0 12 4.5c-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7ZM2 4.27l2.28 2.28.46.46A11.8 11.8 0 0 0 1 12a11.83 11.83 0 0 0 15.38 6.62l.42.42L19.73 22 21 20.73 3.27 3 2 4.27Z"/></svg>';
    hide.addEventListener('click', (e) => {
      e.stopPropagation();
      hideContact(u);
    });
    li.appendChild(hide);
    li.addEventListener('click', async () => {
      try {
        const { conversation } = await emit('chat:direct', { username: u.username });
        if (!state.conversations.has(conversation.id)) state.conversations.set(conversation.id, conversation);
        $('#panel-new-chat').classList.add('hidden');
        openChat(conversation.id);
      } catch (err) {
        alert(err.message);
      }
    });
    return li;
  });

  $('#btn-new-chat').addEventListener('click', () => {
    openPanel('#panel-new-chat');
    $('#user-search').value = '';
    renderNewChatResults('');
    $('#user-search').focus();
  });
  $('#user-search').addEventListener('input', debounce((e) => renderNewChatResults(e.target.value), 200));

  // New group
  function renderGroupChips() {
    const chips = $('#group-chips');
    chips.textContent = '';
    for (const u of state.groupMembers) {
      const chip = el('span', 'chip', displayName(u));
      const x = el('button', '', '✕');
      x.type = 'button';
      x.addEventListener('click', () => {
        state.groupMembers.delete(u);
        renderGroupChips();
        renderGroupResults($('#group-search').value);
      });
      chip.appendChild(x);
      chips.appendChild(chip);
    }
  }

  const renderGroupResults = (q) => searchPeople(q, $('#group-results'), (u) => {
    const li = userRow(u, { checkbox: true, checked: state.groupMembers.has(u.username) });
    li.addEventListener('click', () => {
      if (state.groupMembers.has(u.username)) state.groupMembers.delete(u.username);
      else state.groupMembers.add(u.username);
      li.querySelector('.check').checked = state.groupMembers.has(u.username);
      renderGroupChips();
    });
    return li;
  });

  $('#btn-new-group').addEventListener('click', () => {
    openPanel('#panel-new-group');
    state.groupMembers.clear();
    $('#group-name').value = '';
    $('#group-search').value = '';
    $('#group-error').textContent = '';
    renderGroupChips();
    renderGroupResults('');
    $('#group-name').focus();
  });
  $('#group-search').addEventListener('input', debounce((e) => renderGroupResults(e.target.value), 200));

  $('#btn-create-group').addEventListener('click', async () => {
    try {
      const { conversation } = await emit('group:create', {
        name: $('#group-name').value,
        members: [...state.groupMembers],
      });
      state.conversations.set(conversation.id, conversation);
      $('#panel-new-group').classList.add('hidden');
      openChat(conversation.id);
    } catch (err) {
      $('#group-error').textContent = err.message;
    }
  });

  // Profile
  $('#btn-profile').addEventListener('click', () => {
    openPanel('#panel-profile');
    const form = $('#profile-form');
    form.displayName.value = state.me.displayName;
    form.about.value = state.me.about || '';
    $('#profile-msg').textContent = '';
    paintAvatar($('#profile-avatar'), state.me.displayName, state.me.username, { big: true });
    $('#profile-username').textContent = '@' + state.me.username;
    renderVerifyRow();
    renderLockSummary();
    renderProfileExtras();
  });
  $('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.me.verified && e.target.displayName.value.trim() !== state.me.displayName
      && !confirm('Your Verified badge belongs to your current name. If you change it, the badge is removed until you verify again. Continue?')) return;
    try {
      const { user } = await emit('profile:update', {
        displayName: e.target.displayName.value,
        about: e.target.about.value,
      });
      state.me = user;
      state.users[user.username] = { ...user, online: true };
      paintAvatar($('#btn-profile'), user.displayName, user.username);
      paintAvatar($('#profile-avatar'), user.displayName, user.username, { big: true });
      $('#profile-msg').textContent = 'Saved ✓';
      renderVerifyRow();
    } catch (err) {
      $('#profile-msg').textContent = err.message;
    }
  });

  $('#btn-logout').addEventListener('click', logout);

  // ---------- developer settings (API keys & webhooks via the REST API) ----------

  async function apiFetch(method, path, body) {
    const res = await fetch(`/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${state.token}`, 'X-App-Session': APP_SESSION, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Request failed');
    return data;
  }

  const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

  async function loadDeveloper() {
    $('#dev-error').textContent = '';
    try {
      const [{ apiKeys }, { webhooks, events }] = await Promise.all([apiFetch('GET', '/api-keys'), apiFetch('GET', '/webhooks')]);

      const keys = $('#dev-keys');
      keys.textContent = '';
      if (!apiKeys.length) keys.appendChild(el('li', 'muted dev-empty', 'No API keys yet'));
      for (const k of apiKeys) {
        const li = el('li');
        const body = el('div', 'body');
        body.append(el('div', 'name', k.name), el('div', 'sub', `${k.preview} · created ${fmtWhen(k.createdAt)} · last used ${fmtWhen(k.lastUsedAt)}`));
        const revoke = el('button', 'danger-link', 'Revoke');
        revoke.type = 'button';
        revoke.addEventListener('click', async () => {
          if (!confirm(`Revoke "${k.name}"? Anything using it will stop working.`)) return;
          await apiFetch('DELETE', `/api-keys/${k.id}`).catch((e) => { $('#dev-error').textContent = e.message; });
          $('#dev-key-new').classList.add('hidden');
          loadDeveloper();
        });
        li.append(body, revoke);
        keys.appendChild(li);
      }

      $('#dev-events').innerHTML = '';
      for (const e of ['*', ...events]) {
        const o = document.createElement('option');
        o.value = e;
        $('#dev-events').appendChild(o);
      }
      const hooks = $('#dev-hooks');
      hooks.textContent = '';
      if (!webhooks.length) hooks.appendChild(el('li', 'muted dev-empty', 'No webhooks yet'));
      for (const w of webhooks) {
        const li = el('li');
        const body = el('div', 'body');
        const last = w.lastDelivery
          ? `${w.lastDelivery.ok ? '✓' : '✗'} ${w.lastDelivery.event} ${w.lastDelivery.ok ? w.lastDelivery.status : w.lastDelivery.error} · ${fmtWhen(w.lastDelivery.at)}`
          : 'no deliveries yet';
        body.append(
          el('div', 'name dev-url', w.url),
          el('div', 'sub', `${w.events.join(', ')}${w.active ? '' : ' · switched off'}`),
          el('div', `sub ${w.lastDelivery && !w.lastDelivery.ok ? 'error' : ''}`, last),
        );
        const actionsEl = el('div', 'dev-actions');
        const btn = (label, fn, cls = 'link') => {
          const b = el('button', cls, label);
          b.type = 'button';
          b.addEventListener('click', async () => {
            try { await fn(); } catch (e) { $('#dev-error').textContent = e.message; }
            loadDeveloper();
          });
          actionsEl.appendChild(b);
        };
        btn('Send test', async () => {
          const { result } = await apiFetch('POST', `/webhooks/${w.id}/test`);
          toast(result.ok ? `Test delivered (HTTP ${result.status})` : `Test failed: ${result.error}`);
        });
        btn(w.active ? 'Turn off' : 'Turn on', () => apiFetch('PATCH', `/webhooks/${w.id}`, { active: !w.active }));
        btn('Delete', async () => {
          if (confirm('Delete this webhook?')) await apiFetch('DELETE', `/webhooks/${w.id}`);
        }, 'danger-link');
        li.append(body, actionsEl);
        hooks.appendChild(li);
      }
    } catch (err) {
      $('#dev-error').textContent = err.message;
    }
  }

  $('#btn-developer').addEventListener('click', () => {
    openPanel('#panel-developer');
    $('#dev-key-new').classList.add('hidden');
    $('#dev-hook-new').classList.add('hidden');
    loadDeveloper();
  });
  $('#dev-key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { key } = await apiFetch('POST', '/api-keys', { name: e.target.name.value });
      $('#dev-key-value').textContent = key;
      $('#dev-key-new').classList.remove('hidden');
      e.target.reset();
      loadDeveloper();
    } catch (err) {
      $('#dev-error').textContent = err.message;
    }
  });
  $('#dev-hook-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const events = e.target.events.value.split(',').map((x) => x.trim()).filter(Boolean);
    try {
      const { secret } = await apiFetch('POST', '/webhooks', { url: e.target.url.value, events });
      $('#dev-hook-secret').textContent = secret;
      $('#dev-hook-new').classList.remove('hidden');
      e.target.reset();
      loadDeveloper();
    } catch (err) {
      $('#dev-error').textContent = err.message;
    }
  });
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($(`#${b.dataset.copy}`).textContent);
      toast('Copied');
    } catch {
      toast('Select the text and copy it manually');
    }
  }));

  // ---------- disappearing messages ----------

  const TIMER_PATH = 'M15 1H9v2h6V1Zm-4 13h2V8h-2v6Zm8.03-6.61 1.42-1.42c-.43-.51-.9-.99-1.41-1.41l-1.42 1.42A8.96 8.96 0 0 0 12 4a9 9 0 1 0 9 9c0-2.12-.74-4.07-1.97-5.61ZM12 20a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z';
  const BRIEFCASE_PATH = 'M10 16v-1H3.01L3 19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4h-7v1h-4Zm10-9h-4.01V5l-2-2h-4l-2 2v2H4a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h6v-2h4v2h6a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Zm-6 0h-4V5h4v2Z';
  const TIMER_MIN = 60;
  const TIMER_MAX = 365 * 24 * 3600;

  function svgIcon(path, cls, title) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', cls);
    if (title) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', title);
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      t.textContent = title;
      svg.appendChild(t);
    } else {
      svg.setAttribute('aria-hidden', 'true');
    }
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    svg.appendChild(p);
    return svg;
  }
  const timerIcon = (title) => svgIcon(TIMER_PATH, 'timer-icon', title);
  const businessBadge = () => svgIcon(BRIEFCASE_PATH, 'biz-badge', 'Business account');
  // Verified (identity checked with a KYC ID) or not: everyone gets one of the two next to their name.
  const SEAL = 'M12 1 9.5 3.2 6.2 3 5.4 6.2 2.6 7.9l1.2 3.1L2.6 14l2.8 1.7.8 3.2 3.3-.2L12 21l2.5-2.3 3.3.2.8-3.2 2.8-1.7-1.2-3 1.2-3.1-2.8-1.7-.8-3.2-3.3.2L12 1Z';
  const CHECK = 'm10.5 15.5-3-3 1.2-1.2 1.8 1.8 4.3-4.3 1.2 1.2-5.5 5.5Z';
  function trustBadge(u) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const verified = !!u?.verified;
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', `trust-badge ${verified ? 'verified' : 'unverified'}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', verified ? 'Verified' : 'Not verified');
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    t.textContent = verified ? 'Verified: identity checked with a government ID' : 'Not verified';
    const seal = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    seal.setAttribute('d', SEAL);
    svg.append(t, seal);
    if (verified) {
      const check = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      check.setAttribute('d', CHECK);
      check.setAttribute('class', 'check');
      svg.appendChild(check);
    }
    return svg;
  }
  const STAR = 'M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 16.9 5.9 20.4l1.5-6.8L2.2 9l6.9-.7L12 2Z';
  const premiumBadge = () => svgIcon(STAR, 'premium-badge', 'Premium');
  /** The badges for a person: Verified / Not verified, Premium, then Business. */
  const userBadges = (u) => (u ? [trustBadge(u), ...(u.premium ? [premiumBadge()] : []), ...(u.business ? [businessBadge()] : [])] : []);

  /** 189000 -> "2 days 4 hours 30 minutes" */
  function fmtTimer(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const part = (n, unit) => (n ? [`${n} ${unit}${n === 1 ? '' : 's'}`] : []);
    return [...part(d, 'day'), ...part(h, 'hour'), ...part(m, 'minute')].join(' ') || `${sec} seconds`;
  }

  function describeSystem(m, short = false) {
    const who = m.from === state.me.username ? 'You' : displayName(m.from);
    const s = m.system || {};
    if (s.event !== 'disappearing') return 'Chat settings changed';
    if (!s.seconds) return `${who} switched off auto-delete.`;
    return short
      ? `${who} set auto-delete to ${fmtTimer(s.seconds)}.`
      : `${who} switched on auto-delete. Sent messages are removed ${fmtTimer(s.seconds)} after sending.`;
  }

  /** Remove messages (expired or deleted) from a chat, here and in the chat list. */
  let reloadTimer = null;
  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => loadConversations().catch(() => {}), 800);
  };
  function removeMessages(convId, ids) {
    const list = state.messages.get(convId);
    if (list) state.messages.set(convId, list.filter((m) => !ids.has(m.id)));
    if (playingId && ids.has(playingId)) {
      player.pause();
      playingId = null;
    }
    const conv = state.conversations.get(convId);
    if (conv?.lastMessage && ids.has(conv.lastMessage.id)) {
      const remaining = state.messages.get(convId);
      if (remaining) conv.lastMessage = remaining.filter((m) => !m.localStatus).at(-1) || null;
      else scheduleReload();
    }
    if (convId === state.activeId) renderMessages();
    renderChatList();
  }

  // Remove messages as their timer runs out, without waiting for the server's sweep.
  setInterval(() => {
    if (!state.me) return;
    const now = Date.now();
    for (const [convId, list] of state.messages) {
      const expired = list.filter((m) => m.expiresAt && m.expiresAt <= now);
      if (expired.length) removeMessages(convId, new Set(expired.map((m) => m.id)));
    }
    for (const c of state.conversations.values()) {
      if (c.lastMessage?.expiresAt && c.lastMessage.expiresAt <= now && !state.messages.has(c.id)) scheduleReload();
    }
  }, 2000);

  /** Seconds from the dialog, or throws with a readable reason. */
  function timerFromForm(form) {
    const preset = form.preset.value;
    if (preset !== 'custom') return Number(preset);
    const n = (name, max) => {
      const v = Number(form[name].value || 0);
      if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`${name[0].toUpperCase() + name.slice(1)} must be a whole number from 0 to ${max}`);
      return v;
    };
    const seconds = n('days', 365) * 86400 + n('hours', 23) * 3600 + n('minutes', 59) * 60;
    if (seconds < TIMER_MIN) throw new Error('Choose at least 1 minute');
    if (seconds > TIMER_MAX) throw new Error('The longest timer is 365 days');
    return seconds;
  }

  /** mode 'chat': the open chat's timer; 'default': my timer for new chats. */
  function openTimerDialog(mode) {
    const conv = mode === 'chat' ? state.conversations.get(state.activeId) : null;
    if (mode === 'chat' && !conv) return;
    const current = (mode === 'chat' ? conv.disappearAfter : state.defaultDisappear) || 0;
    const form = $('#timer-form');
    $('#timer-title').textContent = mode === 'chat' ? 'Auto-delete' : 'Default auto-delete';
    $('#timer-text').textContent = mode === 'chat'
      ? `Messages sent in this chat are removed for everyone once the timer runs out. Anyone here can change it. Messages sent before a change keep their original timer.`
      : `Chats you start will use this auto-delete timer. Chats that already exist keep theirs.`;
    $('#timer-error').textContent = '';
    const presets = ['0', '86400', '604800', '7776000'];
    const isPreset = presets.includes(String(current));
    form.preset.value = isPreset ? String(current) : 'custom';
    form.days.value = Math.floor(current / 86400);
    form.hours.value = Math.floor((current % 86400) / 3600);
    form.minutes.value = Math.floor((current % 3600) / 60);
    const update = () => {
      const custom = form.preset.value === 'custom';
      $('#timer-custom').classList.toggle('disabled', !custom);
      for (const f of ['days', 'hours', 'minutes']) form[f].disabled = !custom;
      try {
        const sec = timerFromForm(form);
        $('#timer-preview').textContent = sec ? `Sent messages are removed ${fmtTimer(sec)} after sending.` : 'Auto-delete is off.';
        $('#timer-error').textContent = '';
      } catch (err) {
        $('#timer-preview').textContent = '';
        $('#timer-error').textContent = err.message;
      }
    };
    form.oninput = update;
    update();
    $('#timer-modal').classList.remove('hidden');
    const close = () => {
      $('#timer-modal').classList.add('hidden');
      form.onsubmit = null;
    };
    $('#timer-cancel').onclick = close;
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const seconds = timerFromForm(form);
        if (mode === 'chat') {
          const { conversation } = await emit('chat:disappearing', { convId: conv.id, seconds });
          if (!('disappearAfter' in conversation)) delete conv.disappearAfter;
          Object.assign(conv, conversation);
          renderHeader();
          renderChatList();
        } else {
          const { defaultDisappear } = await emit('settings:default-disappear', { seconds });
          state.defaultDisappear = defaultDisappear;
          renderProfileExtras();
        }
        close();
        toast(seconds ? `Auto-delete set to ${fmtTimer(seconds)}` : 'Auto-delete switched off');
      } catch (err) {
        $('#timer-error').textContent = err.message;
      }
    };
  }

  $('#menu-timer').addEventListener('click', () => openTimerDialog('chat'));
  $('#timer-banner').addEventListener('click', () => openTimerDialog('chat'));
  $('#btn-default-timer').addEventListener('click', () => openTimerDialog('default'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#timer-modal').classList.contains('hidden')) $('#timer-cancel').click();
  });

  // ---------- verified mobile number and email ----------

  /** "+919876543210" -> "+91 98765 43210" (Indian numbers), others "+44 7700900123". */
  function prettyPhone(p) {
    if (!p) return '';
    if (p.startsWith('+91') && p.length === 13) return `+91 ${p.slice(3, 8)} ${p.slice(8)}`;
    const m = COUNTRY_CODES.map(([, d]) => d).sort((a, b) => b.length - a.length).find((d) => p.startsWith(d));
    return m ? `${m} ${p.slice(m.length)}` : p;
  }

  /** Add or change the mobile number ("phone") or email: send a code, then check it. */
  async function verifyContactFlow(kind) {
    const isPhone = kind === 'phone';
    const current = state.contact?.[kind];
    let sent = null;
    let value = '';
    const ok = await dialog({
      title: `${current ? 'Change' : 'Add'} ${isPhone ? 'mobile number' : 'email'}`,
      text: isPhone
        ? 'Enter the new number with its country code. We\'ll send it a code by SMS.'
        : 'Enter your email address. We\'ll email you a code.',
      fields: [isPhone
        ? { name: 'value', label: 'Mobile number, e.g. +91 98765 43210', type: 'tel', autocomplete: 'tel' }
        : { name: 'value', label: 'Email', type: 'email', autocomplete: 'email' }],
      submit: 'Send code',
      onSubmit: async (v) => {
        value = v.value.trim();
        sent = await emit('me:contact-code', isPhone ? { phone: value } : { email: value });
      },
    });
    if (!ok || !sent) return false;
    const done = await dialog({
      title: 'Enter the code',
      text: `We sent a 6-digit code to ${sent.sentTo}.${sent.devCode ? ` (Dev code: ${sent.devCode})` : ''}`,
      fields: [{ name: 'code', label: '6-digit code', type: 'text', autocomplete: 'one-time-code' }],
      submit: 'Verify',
      onSubmit: async (v) => {
        const res = await emit('me:contact-verify', { ...(isPhone ? { phone: value } : { email: value }), requestId: sent.requestId, code: v.code.trim() });
        state.contact = res.contact;
        state.myBusiness = res.business || null;
      },
    });
    if (!done) return false;
    renderProfileExtras();
    toast(isPhone ? 'Mobile number verified' : 'Email verified');
    return true;
  }
  $('#btn-contact-phone').addEventListener('click', () => verifyContactFlow('phone'));
  $('#btn-contact-email').addEventListener('click', () => verifyContactFlow('email'));

  function renderProfileExtras() {
    const c = state.contact || {};
    $('#contact-phone').textContent = c.phone ? prettyPhone(c.phone) : 'Not added';
    $('#contact-email').textContent = c.email || 'Not added';
    $('#btn-contact-phone').textContent = c.phone ? 'Change' : 'Add';
    $('#btn-contact-email').textContent = c.email ? 'Change' : 'Add';
    $('#default-timer-summary').textContent = state.defaultDisappear
      ? `${fmtTimer(state.defaultDisappear)} for chats you start`
      : 'Off';
    const b = state.myBusiness;
    $('#business-row-title').textContent = b ? `Business account · ${b.category}` : 'Switch to a business account';
    $('#business-row-sub').textContent = b
      ? 'Edit your business details, hours, greeting and away messages'
      : 'Show your hours, address and website; send greeting and away messages';
  }

  // ---------- contact / group info ----------

  function infoRow(label, value, href) {
    const row = el('div', 'info-row');
    row.appendChild(el('div', 'info-label', label));
    if (href) {
      const a = el('a', 'info-value', value);
      a.href = href;
      if (/^https?:/.test(href)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      row.appendChild(a);
    } else {
      row.appendChild(el('div', 'info-value', value));
    }
    return row;
  }

  function businessCard(b, username) {
    const H = window.BusinessHours;
    const card = el('section', 'info-card biz-card');
    const head = el('div', 'biz-head');
    head.append(businessBadge(), el('span', 'biz-category', b.category));
    card.appendChild(head);
    if (b.description) card.appendChild(el('p', 'biz-desc', b.description));
    if (b.hours) {
      const open = H.isOpenNow(b);
      const { day } = H.localNow(b.timezone);
      const status = el('div', `biz-status ${open ? 'open' : 'closed'}`);
      status.append(el('strong', '', open ? 'Open now' : 'Closed now'), ` · Today ${H.describeDay(b.hours[day])}`);
      card.appendChild(status);
      const table = el('div', 'biz-week');
      for (const d of H.DAYS) {
        const row = el('div', `biz-day${d === day ? ' today' : ''}`);
        row.append(el('span', '', H.DAY_NAMES[d]), el('span', '', H.describeDay(b.hours[d])));
        table.appendChild(row);
      }
      card.appendChild(table);
      const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (viewerTz !== b.timezone) card.appendChild(el('p', 'muted small-note', `Hours are in the business's time zone (${b.timezone}).`));
    }
    if (b.address) card.appendChild(infoRow('Address', b.address, `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.address)}`));
    if (b.email) card.appendChild(infoRow('Email', b.email, `mailto:${b.email}`));
    if (b.website) card.appendChild(infoRow('Website', b.website.replace(/^https?:\/\//, '').replace(/\/$/, ''), b.website));
    if (username && b.productCount) {
      const btn = el('button', 'primary catalogue-btn', `View catalogue (${b.productCount})`);
      btn.type = 'button';
      btn.addEventListener('click', () => openCatalogue(username));
      card.appendChild(btn);
    }
    return card;
  }

  function renderContactInfo(conv) {
    const body = $('#contact-body');
    body.textContent = '';
    const group = conv.type === 'group';
    const peer = convPeer(conv);
    const user = peer ? state.users[peer] || { username: peer, displayName: peer } : null;
    $('#contact-title').textContent = group ? 'Group info' : user?.business ? 'Business info' : 'Contact info';

    const top = el('section', 'info-top');
    const av = el('div', 'avatar xl');
    paintAvatar(av, convTitle(conv), group ? conv.id : peer, { group, big: true });
    const name = el('h2', 'info-name', convTitle(conv));
    if (user && !group) name.append(...userBadges(user));
    top.append(av, name, el('p', 'muted', group ? `Group · ${conv.members.length} members` : `@${peer}`));
    if (user && !group) top.appendChild(el('p', 'muted', user.online ? 'online' : lastSeenText(peer) || ''));
    body.appendChild(top);

    if (user?.about) {
      const about = el('section', 'info-card');
      about.append(el('div', 'info-label', 'About'), el('div', '', user.about));
      body.appendChild(about);
    }
    if (user?.business) body.appendChild(businessCard(user.business, peer));

    const timer = el('section', 'info-card info-action');
    timer.appendChild(timerIcon(''));
    const tbody = el('div', 'grow');
    tbody.append(el('div', '', 'Auto-delete'), el('div', 'muted small-note', conv.disappearAfter ? fmtTimer(conv.disappearAfter) : 'Off'));
    const change = el('button', 'link', 'Change');
    change.type = 'button';
    change.addEventListener('click', () => openTimerDialog('chat'));
    timer.append(tbody, change);
    body.appendChild(timer);

    // Encryption: what is protected, and the security code to compare with a contact.
    if (!isLockedView(conv)) {
      const encCard = el('section', 'info-card info-action');
      const ebody = el('div', 'grow');
      ebody.append(
        el('div', '', 'Encryption'),
        el('div', 'muted small-note', group
          ? 'Messages in this group are end-to-end encrypted when every member has set up encryption.'
          : 'Messages are end-to-end encrypted. Verify the security code to be sure it is really them.'),
      );
      encCard.appendChild(ebody);
      if (!group) {
        const verify = el('button', 'link', 'Verify');
        verify.type = 'button';
        verify.addEventListener('click', () => showSafetyNumber(conv));
        encCard.appendChild(verify);
      }
      body.appendChild(encCard);
    }

    if (!group) body.appendChild(viewNote());

    // Hide this one chat (a contact or a group) from the chat list.
    if (!isLockedView(conv)) {
      const hideCard = el('section', 'info-card info-action');
      const hbody = el('div', 'grow');
      hbody.append(
        el('div', '', conv.hidden ? 'Hidden chat' : 'Hide chat'),
        el('div', 'muted small-note', conv.hidden ? 'Only in Profile → Hidden chats' : 'Remove from the chat list; open with your secret code or fingerprint / face'),
      );
      const toggle = el('button', 'link', conv.hidden ? 'Unhide' : 'Hide');
      toggle.type = 'button';
      toggle.addEventListener('click', () => toggleHide(conv));
      hideCard.append(hbody, toggle);
      body.appendChild(hideCard);
    }

    if (group) {
      const members = el('section', 'info-card');
      members.appendChild(el('div', 'info-label', `${conv.members.length} members`));
      const ul = el('ul', 'list member-list');
      for (const m of conv.members) {
        const u = state.users[m] || { username: m, displayName: m };
        const li = el('li');
        li.appendChild(avatar(u.displayName, m, { online: u.online }));
        const b = el('div', 'body');
        const row = el('div', 'row');
        row.appendChild(el('span', 'name', m === state.me.username ? 'You' : u.displayName));
        row.append(...userBadges(u));
        if (conv.admins?.includes(m)) row.appendChild(el('span', 'admin-tag', 'Admin'));
        b.append(row, el('div', 'sub', u.business ? u.business.category : `@${m}`));
        li.appendChild(b);
        if (m !== state.me.username) {
          li.classList.add('tappable');
          li.title = 'View profile';
          li.addEventListener('click', () => showProfile(m));
        }
        ul.appendChild(li);
      }
      members.appendChild(ul);
      body.appendChild(members);
    }
  }

  function openContactInfo() {
    const conv = state.conversations.get(state.activeId);
    if (!conv) return;
    state.profileCard = null;
    openPanel('#panel-contact');
    renderContactInfo(conv);
    const peer = convPeer(conv);
    if (peer && conv.type === 'direct') emit('profile:view', { username: peer }).catch(() => {});
  }
  function refreshContactInfo() {
    if ($('#panel-contact').classList.contains('hidden')) return;
    if (state.profileCard) return renderProfileCard(state.users[state.profileCard] || { username: state.profileCard, displayName: state.profileCard });
    const conv = state.conversations.get(state.activeId);
    if (conv) renderContactInfo(conv);
  }

  /** A person's profile (from a group, or search), for people I may not have a chat with. Opening it records a view. */
  function renderProfileCard(user) {
    const body = $('#contact-body');
    body.textContent = '';
    $('#contact-title').textContent = user.business ? 'Business info' : 'Profile';
    const top = el('section', 'info-top');
    const av = el('div', 'avatar xl');
    paintAvatar(av, user.displayName, user.username, { big: true });
    const name = el('h2', 'info-name', user.displayName);
    name.append(...userBadges(user));
    top.append(av, name, el('p', 'muted', `@${user.username}`), el('p', 'muted', user.online ? 'online' : lastSeenText(user.username) || ''));
    body.appendChild(top);
    if (user.about) {
      const about = el('section', 'info-card');
      about.append(el('div', 'info-label', 'About'), el('div', '', user.about));
      body.appendChild(about);
    }
    if (user.business) body.appendChild(businessCard(user.business, user.username));
    body.appendChild(viewNote());
  }

  async function showProfile(username) {
    if (!username || username === state.me.username) return;
    try {
      const { user } = await emit('user:get', { username });
      state.users[username] = { ...(state.users[username] || {}), ...user };
      state.profileCard = username;
      openPanel('#panel-contact');
      renderProfileCard(state.users[username]);
      emit('profile:view', { username }).catch(() => {});
    } catch (err) {
      toast(err.message);
    }
  }

  /** A one-line reminder that looking at a profile is visible to them. */
  function viewNote() {
    return el('p', 'muted small-note view-note', state.privacy?.profileViews === false
      ? "Profile views are off: people can't see that you looked, and you can't see who looks at you."
      : 'They can see that you viewed their profile. Change this in Profile → Who viewed my profile.');
  }
  $('#chat-title-btn').addEventListener('click', openContactInfo);
  $('#menu-info').addEventListener('click', openContactInfo);

  // ---------- business profile settings ----------

  function defaultHours() {
    const H = window.BusinessHours;
    return Object.fromEntries(H.DAYS.map((d) => [d, ['sat', 'sun'].includes(d) ? { mode: 'closed' } : { mode: 'hours', open: '09:00', close: '17:00' }]));
  }

  function openBusinessPanel() {
    updateCatalogueRow();
    const H = window.BusinessHours;
    const form = $('#business-form');
    const b = state.myBusiness;
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    if (!form.category.options.length) {
      form.category.appendChild(new Option('Choose a category', ''));
      for (const c of H.CATEGORIES) form.category.appendChild(new Option(c, c));
      const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [browserTz, 'UTC'];
      for (const z of new Set(['UTC', browserTz, ...zones])) form.timezone.appendChild(new Option(z.replace(/_/g, ' '), z));
    }
    form.category.value = b?.category || '';
    form.description.value = b?.description || '';
    form.address.value = b?.address || '';
    form.email.value = state.contact?.email || b?.email || '';
    form.website.value = b?.website || '';
    // Time-zone lists differ between browsers (e.g. "Asia/Calcutta" vs "Asia/Kolkata"):
    // make sure the saved zone is always selectable.
    const tz = b?.timezone || browserTz;
    if (![...form.timezone.options].some((o) => o.value === tz)) form.timezone.appendChild(new Option(tz.replace(/_/g, ' '), tz));
    form.timezone.value = tz;
    form.greetingEnabled.checked = !!b?.greeting?.enabled;
    form.greetingText.value = b?.greeting?.text || '';
    form.awayEnabled.checked = !!b?.away?.enabled;
    form.awayText.value = b?.away?.text || '';

    const hours = b?.hours || defaultHours();
    const rows = $('#biz-hours-rows');
    rows.textContent = '';
    for (const d of H.DAYS) {
      const h = hours[d] || { mode: 'closed' };
      const row = el('div', 'hours-row');
      row.dataset.day = d;
      const mode = el('select');
      mode.name = `mode-${d}`;
      for (const [v, label] of [['hours', 'Open'], ['open24', 'Open 24 hours'], ['closed', 'Closed']]) mode.appendChild(new Option(label, v));
      mode.value = h.mode;
      const open = el('input');
      Object.assign(open, { type: 'time', name: `open-${d}`, value: h.open || '09:00' });
      const close = el('input');
      Object.assign(close, { type: 'time', name: `close-${d}`, value: h.close || '17:00' });
      const times = el('div', 'times');
      times.append(open, el('span', 'muted', 'to'), close);
      const sync = () => {
        open.disabled = close.disabled = mode.value !== 'hours';
        times.classList.toggle('hidden', mode.value !== 'hours');
      };
      mode.addEventListener('change', sync);
      sync();
      open.setAttribute('aria-label', `${H.DAY_NAMES[d]} opening time`);
      close.setAttribute('aria-label', `${H.DAY_NAMES[d]} closing time`);
      mode.setAttribute('aria-label', `${H.DAY_NAMES[d]}`);
      row.append(el('span', 'day-name', H.DAY_NAMES[d]), mode, times);
      rows.appendChild(row);
    }
    $('#business-error').textContent = '';
    $('#business-save').textContent = b ? 'Save changes' : 'Switch to business account';
    $('#business-remove').classList.toggle('hidden', !b);
    openPanel('#panel-business');
  }

  $('#btn-business').addEventListener('click', async () => {
    // A business needs a verified mobile number and email; verify whichever is missing first.
    if (!state.myBusiness) {
      for (const kind of ['phone', 'email']) {
        if (state.contact?.[kind]) continue;
        toast(`A business account needs a verified ${kind === 'phone' ? 'mobile number' : 'email'}`);
        if (!(await verifyContactFlow(kind))) return;
      }
    }
    openBusinessPanel();
  });
  $('#business-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const H = window.BusinessHours;
    const f = e.target;
    const hours = {};
    for (const d of H.DAYS) {
      const mode = f[`mode-${d}`].value;
      hours[d] = mode === 'hours' ? { mode, open: f[`open-${d}`].value, close: f[`close-${d}`].value } : { mode };
    }
    try {
      const { business } = await emit('business:set', {
        category: f.category.value,
        description: f.description.value,
        address: f.address.value,
        website: f.website.value,
        timezone: f.timezone.value,
        hours,
        greeting: { enabled: f.greetingEnabled.checked, text: f.greetingText.value },
        away: { enabled: f.awayEnabled.checked, text: f.awayText.value },
      });
      const wasBusiness = !!state.myBusiness;
      state.myBusiness = business;
      renderProfileExtras();
      $('#business-save').textContent = 'Save changes';
      $('#business-remove').classList.remove('hidden');
      $('#business-error').textContent = '';
      toast(wasBusiness ? 'Business profile saved' : 'You now have a business account');
    } catch (err) {
      $('#business-error').textContent = err.message;
    }
  });
  $('#business-remove').addEventListener('click', async () => {
    if (!confirm('Switch back to a personal account? Your business details, hours and automatic messages will be removed.')) return;
    try {
      await emit('business:remove');
      state.myBusiness = null;
      renderProfileExtras();
      $('#panel-business').classList.add('hidden');
      toast('Switched to a personal account');
    } catch (err) {
      $('#business-error').textContent = err.message;
    }
  });

  // ---------- chat lock ----------

  const LOCK_PATH = 'M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V11a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Zm-3 8V6a3 3 0 1 1 6 0v3H9Zm3 4a2 2 0 0 1 1 3.73V19h-2v-2.27A2 2 0 0 1 12 13Z';
  function lockIcon(title) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'lock-icon');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', title);
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    t.textContent = title;
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', LOCK_PATH);
    svg.append(t, p);
    return svg;
  }

  /** A locked chat that hasn't been unlocked in this app session. */
  const isLockedView = (conv) => !!conv?.locked && !conv.unlocked;

  /** Drop everything already loaded for a chat that is now locked (in memory and on screen). */
  function forgetChatContent(convId) {
    const playingHere = playingId && state.messages.get(convId)?.some((m) => m.id === playingId);
    if (playingHere) {
      player.pause();
      playingId = null;
    }
    state.messages.delete(convId);
    if (state.activeId === convId) $('#messages').textContent = '';
  }

  function setLockSettings({ hasCode, lockedChats, biometric, hiddenCount }) {
    state.lock = { hasCode, lockedChats: new Set(lockedChats), biometric: biometric || [], hiddenCount: hiddenCount ?? state.lock.hiddenCount };
    renderLockSummary();
  }

  function renderLockSummary() {
    const n = state.lock.lockedChats.size;
    $('#lock-summary').textContent = !state.lock.hasCode
      ? 'Lock chats with a secret code'
      : `${n} locked chat${n === 1 ? '' : 's'} · the code is asked again every new session`;
    $('#btn-lock-code').textContent = state.lock.hasCode ? 'Change secret code' : 'Set secret code';
    $('#btn-lock-forgot').classList.toggle('hidden', !state.lock.hasCode);
    $('#btn-lock-now').classList.toggle('hidden', !n);
    $('#btn-lock-clear').classList.toggle('hidden', !n);
    renderHideSettings();
    renderPremiumRow();
  }

  function renderHideSettings() {
    const { hasCode, biometric } = state.lock;
    const mine = storage.get('chat.bioId');
    const thisDevice = biometric.some((d) => d.id === mine);
    $('#bio-row').classList.toggle('hidden', !state.bioPlatform && !biometric.length);
    $('#bio-summary').textContent = biometric.length
      ? `On for ${biometric.map((d) => d.name).join(', ')}`
      : 'Open hidden and locked chats without typing the code';
    $('#btn-bio-add').textContent = thisDevice ? 'Turn off' : 'Set up';
    $('#btn-bio-add').disabled = !thisDevice && !state.bioPlatform;
    $('#btn-hidden-clear').classList.toggle('hidden', !hasCode);
  }

  /**
   * Small modal form. `fields`: [{ name, label, type, autocomplete }]. `onSubmit(values)` may throw
   * to show an error and keep the dialog open. Resolves with its result, or null if cancelled.
   */
  function dialog({ title, text = '', fields, submit = 'OK', onSubmit, alt = null }) {
    return new Promise((resolve) => {
      const modal = $('#modal');
      const form = $('#modal-form');
      $('#modal-title').textContent = title;
      $('#modal-text').textContent = text;
      $('#modal-error').textContent = '';
      $('#modal-submit').textContent = submit;
      const box = $('#modal-fields');
      box.textContent = '';
      for (const f of fields) {
        if (f.type === 'checkbox') {
          const row = el('label', 'agree');
          const tick = el('input');
          Object.assign(tick, { type: 'checkbox', name: f.name, required: f.required !== false });
          row.append(tick, el('span', '', f.label));
          box.appendChild(row);
          continue;
        }
        const label = el('label', '', f.label);
        let input;
        if (f.options) {
          input = el('select');
          for (const [value, text] of f.options) input.appendChild(new Option(text, value));
          input.name = f.name;
          if (f.value !== undefined) input.value = f.value;
        } else {
          input = el('input');
          Object.assign(input, { name: f.name, type: f.type || 'password', required: f.required !== false, maxLength: f.maxLength || 64, autocomplete: f.autocomplete || 'off' });
          if (f.placeholder) input.placeholder = f.placeholder;
          if (f.value !== undefined) input.value = f.value;
        }
        label.appendChild(input);
        box.appendChild(label);
      }
      // Optional second way to continue, e.g. fingerprint / face: `alt.run()` returns the values to submit.
      if (alt) {
        const b = el('button', 'link', alt.label);
        b.type = 'button';
        b.addEventListener('click', async () => {
          $('#modal-error').textContent = '';
          try {
            await submitValues(await alt.run());
          } catch (err) {
            $('#modal-error').textContent = err.message;
          }
        });
        box.appendChild(b);
      }
      modal.classList.remove('hidden');
      box.querySelector('input')?.focus();
      const close = (result) => {
        modal.classList.add('hidden');
        box.textContent = ''; // whatever was typed (a secret code, an ID number) is gone from the page
        form.onsubmit = null;
        $('#modal-cancel').onclick = null;
        resolve(result);
      };
      $('#modal-cancel').onclick = () => close(null);
      async function submitValues(values) {
        $('#modal-submit').disabled = true;
        try {
          close((await onSubmit(values)) ?? true);
        } catch (err) {
          $('#modal-error').textContent = err.message;
        } finally {
          $('#modal-submit').disabled = false;
        }
      }
      form.onsubmit = (e) => {
        e.preventDefault();
        return submitValues(Object.fromEntries(new FormData(form).entries()));
      };
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) $('#modal-cancel').click();
  });

  const codeFields = [
    { name: 'code', label: 'New secret code (4–32 characters)', autocomplete: 'new-password' },
    { name: 'confirm', label: 'Type it again', autocomplete: 'new-password' },
  ];
  const checkNewCode = ({ code, confirm }) => {
    if (code !== confirm) throw new Error("The codes don't match");
  };

  function setCodeDialog() {
    const changing = state.lock.hasCode;
    return dialog({
      title: changing ? 'Change secret code' : 'Create a secret code',
      text: changing
        ? 'Enter your current code, then the new one.'
        : 'Locked chats ask for this code every time you open VartiQ or log in. Keep it private.',
      fields: changing ? [{ name: 'currentCode', label: 'Current secret code' }, ...codeFields] : codeFields,
      submit: changing ? 'Change code' : 'Create code',
      onSubmit: async (v) => {
        checkNewCode(v);
        setLockSettings(await emit('chatlock:set-code', { code: v.code, currentCode: v.currentCode }));
        toast(changing ? 'Secret code changed' : 'Secret code created');
      },
    });
  }

  async function forgotCodeDialog() {
    // Accounts with a mobile number get a code by SMS; older accounts use their password.
    if (state.contact?.phone) {
      let sent;
      try {
        sent = await emit('chatlock:reset-sms');
      } catch (err) {
        toast(err.message);
        return null;
      }
      return dialog({
        title: 'Forgot secret code?',
        text: `We sent a 6-digit code by SMS to ${sent.sentTo}.${sent.devCode ? ` (Dev code: ${sent.devCode})` : ''} Enter it and choose a new secret code. Your locked chats stay locked.`,
        fields: [{ name: 'otp', label: 'SMS code', type: 'text', autocomplete: 'one-time-code' }, ...codeFields],
        submit: 'Set new code',
        onSubmit: async (v) => {
          checkNewCode(v);
          setLockSettings(await emit('chatlock:reset-code', { requestId: sent.requestId, code: v.otp.trim(), newCode: v.code }));
          toast('New secret code set');
        },
      });
    }
    return dialog({
      title: 'Forgot secret code?',
      text: 'Enter your account password to choose a new secret code. Your locked chats stay locked.',
      fields: [{ name: 'password', label: 'Account password', autocomplete: 'current-password' }, ...codeFields],
      submit: 'Set new code',
      onSubmit: async (v) => {
        checkNewCode(v);
        setLockSettings(await emit('chatlock:reset-code', { password: v.password, newCode: v.code }));
        toast('New secret code set');
      },
    });
  }


  async function toggleChatLock() {
    const conv = state.conversations.get(state.activeId);
    if (!conv) return;
    if (conv.locked) {
      await askProof({
        title: 'Remove chat lock',
        text: `Enter your secret code to stop locking "${convTitle(conv)}".`,
        submit: 'Remove lock',
        run: async (proof) => {
          setLockSettings(await emit('chatlock:remove', { convId: conv.id, ...proof }));
          toast('Chat lock removed');
        },
      });
      return;
    }
    if (!state.lock.hasCode && !(await setCodeDialog())) return;
    try {
      setLockSettings(await emit('chatlock:lock', { convId: conv.id }));
      toast('Chat locked · your secret code is needed to open it');
    } catch (err) {
      if (err.code === 'premium_required') return offerUpgrade(err.message);
      alert(err.message);
    }
  }

  $('#menu-lock').addEventListener('click', toggleChatLock);
  $('#btn-lock-code').addEventListener('click', setCodeDialog);
  $('#btn-lock-forgot').addEventListener('click', forgotCodeDialog);
  $('#btn-forgot-code').addEventListener('click', forgotCodeDialog);
  $('#btn-lock-now').addEventListener('click', async () => {
    await emit('chatlock:relock').catch(() => {});
    await closeHidden();
    for (const c of state.conversations.values()) {
      if (c.locked) forgetChatContent(c.id);
    }
    await loadConversations();
    if (state.activeId) openChat(state.activeId);
    toast('Locked and hidden chats are closed again');
  });

  /** Unlock the open chat (a hidden chat opens all hidden chats). `proof`: { code } or { biometric }. */
  async function doUnlock(proof) {
    const id = state.activeId;
    try {
      const { conversation } = await emit('chatlock:unlock', { convId: id, ...proof });
      $('#unlock-code').value = '';
      if (conversation.hidden) {
        // Opening one hidden chat opens them all: show them in the Hidden chats panel.
        state.hiddenOpen = true;
        await loadHidden();
        openPanel('#panel-hidden');
        renderChatList();
      } else {
        Object.assign(state.conversations.get(id), conversation);
      }
      openChat(id);
    } catch (err) {
      $('#unlock-error').textContent = err.message;
      $('#unlock-code').select();
    }
  }
  $('#unlock-form').addEventListener('submit', (e) => {
    e.preventDefault();
    doUnlock({ code: $('#unlock-code').value });
  });
  $('#btn-unlock-bio').addEventListener('click', async () => {
    $('#unlock-error').textContent = '';
    try {
      doUnlock(await biometricProof());
    } catch (err) {
      $('#unlock-error').textContent = err.message;
    }
  });

  // ---------- fingerprint / face lock (WebAuthn) ----------

  const bufToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64uToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const canUseBiometric = () => !!(state.bioPlatform && state.lock.biometric.length);
  if (window.PublicKeyCredential && window.isSecureContext) {
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.()
      .then((ok) => { state.bioPlatform = !!ok && typeof AuthenticatorAttestationResponse?.prototype?.getPublicKey === 'function'; renderHideSettings(); })
      .catch(() => {});
  }
  const bioError = (err) => (err?.name === 'NotAllowedError' || err?.name === 'AbortError'
    ? new Error('Fingerprint / face check was cancelled')
    : err);

  /** Ask the phone to check the person; returns the proof the server verifies. */
  async function biometricProof() {
    try {
      const ch = await emit('biometric:challenge');
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge: b64uToBuf(ch.challenge),
          rpId: location.hostname,
          allowCredentials: ch.credentials.map((id) => ({ type: 'public-key', id: b64uToBuf(id), transports: ['internal'] })),
          userVerification: 'required',
          timeout: 60000,
        },
      });
      const r = cred.response;
      return {
        biometric: {
          id: cred.id,
          clientDataJSON: bufToB64u(r.clientDataJSON),
          authenticatorData: bufToB64u(r.authenticatorData),
          signature: bufToB64u(r.signature),
        },
      };
    } catch (err) {
      throw bioError(err);
    }
  }

  /** Make a credential on this device (the phone asks for fingerprint/face). */
  async function createBiometric() {
    try {
      const ch = await emit('biometric:challenge');
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: b64uToBuf(ch.challenge),
          rp: { name: 'VartiQ', id: location.hostname },
          user: { id: b64uToBuf(ch.userId), name: state.me.username, displayName: state.me.displayName },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
          excludeCredentials: ch.credentials.map((id) => ({ type: 'public-key', id: b64uToBuf(id) })),
          attestation: 'none',
          timeout: 60000,
        },
      });
      const r = cred.response;
      return {
        id: cred.id,
        clientDataJSON: bufToB64u(r.clientDataJSON),
        authenticatorData: bufToB64u(r.getAuthenticatorData()),
        publicKey: bufToB64u(r.getPublicKey()),
        alg: r.getPublicKeyAlgorithm(),
      };
    } catch (err) {
      throw bioError(err);
    }
  }

  const deviceName = () => {
    const ua = navigator.userAgent;
    const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Device';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
    return `${os} · ${browser}`;
  };

  /** Ask for the secret code (or fingerprint/face when set up); `run(proof)` performs the action. */
  function askProof({ title, text, submit = 'Continue', run }) {
    return dialog({
      title,
      text,
      submit,
      fields: [{ name: 'code', label: 'Secret code' }],
      alt: canUseBiometric() ? { label: 'Use fingerprint / face', run: async () => (await biometricProof()) } : null,
      onSubmit: async (v) => run(v.biometric ? { biometric: v.biometric } : { code: v.code }),
    });
  }

  $('#btn-bio-add').addEventListener('click', async () => {
    const mine = storage.get('chat.bioId');
    if (state.lock.biometric.some((d) => d.id === mine)) {
      await askProof({
        title: 'Turn off fingerprint / face lock',
        text: 'This device will ask for your secret code again.',
        submit: 'Turn off',
        run: async (proof) => {
          setLockSettings(await emit('biometric:remove', { id: mine, ...proof }));
          storage.del('chat.bioId');
          renderHideSettings();
          toast('Fingerprint / face lock turned off');
        },
      });
      return;
    }
    if (!state.lock.hasCode && !(await setCodeDialog())) return;
    await dialog({
      title: 'Set up fingerprint / face lock',
      text: 'Enter your secret code, then confirm with your fingerprint or face when your phone asks.',
      fields: [{ name: 'code', label: 'Secret code' }],
      submit: 'Continue',
      onSubmit: async ({ code }) => {
        const credential = await createBiometric();
        setLockSettings(await emit('biometric:add', { code, name: deviceName(), credential }));
        storage.set('chat.bioId', credential.id);
        renderHideSettings();
        toast('Fingerprint / face lock is on');
      },
    });
  });

  // ---------- product catalogue ----------

  const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY', 'CNY', 'SAR', 'ZAR', 'NGN', 'BRL'];
  const catalogue = { owner: null, currency: 'INR', products: [], editing: null };

  function formatPrice(p, currency) {
    if (p.price === null || p.price === undefined) return { main: 'Price on request', unit: '' };
    let main;
    try {
      main = new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(p.price);
    } catch {
      main = `${currency} ${p.price}`;
    }
    return { main, unit: p.unit || '' };
  }

  async function openCatalogue(username) {
    const mine = username === state.me.username;
    try {
      const res = await emit('catalogue:get', { username });
      Object.assign(catalogue, { owner: res.owner, currency: res.currency, products: res.products });
    } catch (err) {
      return toast(err.message);
    }
    $('#catalogue-title').textContent = mine ? 'My catalogue' : `${displayName(username)} · Catalogue`;
    $('#catalogue-tools').classList.toggle('hidden', !mine);
    if (mine) {
      const sel = $('#catalogue-currency');
      sel.textContent = '';
      for (const c of new Set([catalogue.currency, ...CURRENCIES])) sel.appendChild(new Option(c, c));
      sel.value = catalogue.currency;
    }
    openPanel('#panel-catalogue');
    renderCatalogue(mine);
  }

  function renderCatalogue(mine) {
    const list = $('#product-list');
    list.textContent = '';
    $('#catalogue-empty').classList.toggle('hidden', catalogue.products.length > 0);
    for (const p of catalogue.products) {
      const li = el('li', `product${p.available ? '' : ' out'}`);
      const thumb = p.image ? el('img', 'thumb') : el('div', 'thumb', 'No photo');
      if (p.image) {
        thumb.alt = p.name;
        mediaUrl(p.image).then((url) => { thumb.src = url; }).catch(() => {});
      }
      const info = el('div', 'info');
      info.appendChild(el('span', 'pname', p.name));
      const { main, unit } = formatPrice(p, catalogue.currency);
      const price = el('span', 'price', main);
      if (unit) price.append(' ', el('small', '', `· ${unit}`));
      info.appendChild(price);
      if (!p.available) info.appendChild(el('span', 'ptag', 'Out of stock'));
      if (p.description) info.appendChild(el('span', 'pdesc', p.description));
      if (p.category || p.sku) info.appendChild(el('span', 'pdesc', [p.category, p.sku && `Code ${p.sku}`].filter(Boolean).join(' · ')));
      const actions = el('div', 'actions');
      if (p.link) {
        const a = el('a', 'link', 'Open link');
        a.href = p.link;
        a.target = '_blank';
        a.rel = 'noopener';
        actions.appendChild(a);
      }
      if (mine) {
        const edit = el('button', 'link', 'Edit');
        edit.type = 'button';
        edit.addEventListener('click', () => openProductForm(p));
        actions.appendChild(edit);
      } else if (p.available) {
        const ask = el('button', 'link', 'Ask about this');
        ask.type = 'button';
        ask.addEventListener('click', () => askAboutProduct(p));
        actions.appendChild(ask);
      }
      if (actions.childNodes.length) info.appendChild(actions);
      li.append(thumb, info);
      list.appendChild(li);
    }
  }

  /** A customer taps "Ask about this": open the chat with the business and start a message about the product. */
  async function askAboutProduct(p) {
    try {
      const { conversation } = await emit('chat:direct', { username: catalogue.owner });
      if (!state.conversations.has(conversation.id)) state.conversations.set(conversation.id, conversation);
      $('#panel-catalogue').classList.add('hidden');
      $('#panel-contact').classList.add('hidden');
      await openChat(conversation.id);
      const { main } = formatPrice(p, catalogue.currency);
      const input = $('#message-input');
      input.value = `Hi, I'm interested in "${p.name}"${p.price === null ? '' : ` (${main})`}. `;
      input.focus();
      autosize();
    } catch (err) {
      toast(err.message);
    }
  }

  function openProductForm(product) {
    const f = $('#product-form');
    f.reset();
    catalogue.editing = product || null;
    $('#product-title').textContent = product ? 'Edit product' : 'Add product';
    $('#product-error').textContent = '';
    $('#product-delete').classList.toggle('hidden', !product);
    f.elements.name.value = product?.name || '';
    f.price.value = product?.price ?? '';
    f.onRequest.checked = product ? product.price === null : false;
    f.price.disabled = f.onRequest.checked;
    f.unit.value = product?.unit || '';
    f.description.value = product?.description || '';
    f.category.value = product?.category || '';
    f.link.value = product?.link || '';
    f.sku.value = product?.sku || '';
    f.available.checked = product ? product.available : true;
    const preview = $('#product-photo-preview');
    preview.classList.add('hidden');
    $('#product-photo-remove').classList.toggle('hidden', !product?.image);
    if (product?.image) mediaUrl(product.image).then((url) => { preview.src = url; preview.classList.remove('hidden'); }).catch(() => {});
    openPanel('#panel-product');
  }

  $('#product-form').elements.onRequest.addEventListener('change', (e) => {
    $('#product-form').price.disabled = e.target.checked;
  });
  $('#product-form').elements.photo.addEventListener('change', (e) => {
    const file = e.target.files[0];
    const preview = $('#product-photo-preview');
    if (!file) return;
    if (file.size > 1024 * 1024) {
      e.target.value = '';
      $('#product-error').textContent = 'That picture is over 1 MB. Choose a smaller one.';
      return;
    }
    preview.src = URL.createObjectURL(file);
    preview.classList.remove('hidden');
  });

  $('#product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const fields = {
      name: f.elements.name.value,
      price: f.onRequest.checked || f.price.value === '' ? null : Number(f.price.value),
      unit: f.unit.value,
      description: f.description.value,
      category: f.category.value,
      link: f.link.value,
      sku: f.sku.value,
      available: f.available.checked,
    };
    $('#product-save').disabled = true;
    try {
      const { product } = await emit('catalogue:save', { ...fields, ...(catalogue.editing ? { id: catalogue.editing.id } : {}) });
      const file = f.photo.files[0];
      if (file) await emit('catalogue:image', { id: product.id, mime: file.type, data: await file.arrayBuffer() });
      toast(catalogue.editing ? 'Product saved' : 'Product added');
      await openCatalogue(state.me.username);
      await refreshMyBusiness();
    } catch (err) {
      $('#product-error').textContent = err.message;
    } finally {
      $('#product-save').disabled = false;
    }
  });

  $('#product-photo-remove').addEventListener('click', async () => {
    if (!catalogue.editing) return;
    try {
      await emit('catalogue:image-remove', { id: catalogue.editing.id });
      $('#product-photo-preview').classList.add('hidden');
      $('#product-photo-remove').classList.add('hidden');
      catalogue.editing.image = undefined;
    } catch (err) {
      $('#product-error').textContent = err.message;
    }
  });

  $('#product-delete').addEventListener('click', async () => {
    if (!catalogue.editing || !confirm(`Delete "${catalogue.editing.name}" from your catalogue?`)) return;
    try {
      await emit('catalogue:delete', { id: catalogue.editing.id });
      await openCatalogue(state.me.username);
      await refreshMyBusiness();
    } catch (err) {
      $('#product-error').textContent = err.message;
    }
  });

  $('#btn-product-add').addEventListener('click', () => openProductForm(null));
  $('#catalogue-currency').addEventListener('change', async (e) => {
    try {
      const { currency } = await emit('catalogue:currency', { currency: e.target.value });
      catalogue.currency = currency;
      renderCatalogue(true);
    } catch (err) {
      toast(err.message);
    }
  });
  $('#btn-catalogue-edit').addEventListener('click', () => openCatalogue(state.me.username));

  /** My own profile's product count changed: keep my copy of it fresh. */
  async function refreshMyBusiness() {
    try {
      const { user } = await emit('me');
      state.me = { ...state.me, ...user, business: user.business, verified: user.verified, premium: user.premium };
      updateCatalogueRow();
    } catch { /* ignore */ }
  }

  function updateCatalogueRow() {
    const n = state.me?.business?.productCount || 0;
    $('#btn-catalogue-edit').classList.toggle('hidden', !state.myBusiness);
    $('#catalogue-edit-sub').textContent = n ? `${n} product${n === 1 ? '' : 's'} with prices` : 'List your products with prices';
  }

  // ---------- translating received messages ----------

  const langName = (code) => {
    const l = state.languages.find((x) => x.code === code);
    return l ? l.name : code;
  };

  async function loadLanguages() {
    if (state.languageInfo) return state.languageInfo;
    state.languageInfo = await emit('translate:languages');
    state.languages = state.languageInfo.languages;
    return state.languageInfo;
  }

  function paintTranslateBanner(conv, lockedView) {
    const banner = $('#translate-banner');
    const lang = conv.translateTo;
    banner.classList.toggle('hidden', !lang || lockedView);
    if (!lang) return;
    loadLanguages().then(() => {
      const l = state.languages.find((x) => x.code === lang);
      if (state.activeId === conv.id) $('#translate-banner-text').textContent = `Messages you receive here are shown in ${l ? `${l.name} (${l.native})` : lang}`;
    }).catch(() => {});
  }

  /** Translate the chat's received text messages that aren't translated yet (the app decrypted them; the text goes to the translation service). */
  async function maybeTranslate(conv) {
    const lang = conv?.translateTo;
    if (!lang) return;
    const todo = (state.messages.get(conv.id) || []).filter((m) => m.from !== state.me.username && (!m.type || m.type === 'text')
      && m.text && !m.deleted && !m.undecryptable && !m.trBusy && m.trLang !== lang
      && !(m.masked && !state.revealed.has(m.id)));
    for (let i = 0; i < todo.length; i += 20) {
      const batch = todo.slice(i, i + 20);
      batch.forEach((m) => { m.trBusy = true; });
      try {
        const { translations } = await emit('translate:text', { convId: conv.id, texts: batch.map((m) => m.text) });
        batch.forEach((m, k) => {
          const t = translations[k];
          m.trLang = lang;
          // Already in my language: nothing to show.
          m.tr = t.detected === lang || t.text === m.text ? null : { text: t.text, detected: t.detected, lang };
        });
      } catch (err) {
        batch.forEach((m) => { m.trLang = lang; m.tr = null; }); // don't retry in a loop
        if (!state.translateWarned) {
          state.translateWarned = true;
          toast(`Translation: ${err.message}`);
          setTimeout(() => { state.translateWarned = false; }, 15000);
        }
      } finally {
        batch.forEach((m) => { m.trBusy = false; });
      }
    }
    if (conv.id === state.activeId) renderMessages();
  }

  /** Pick the language this contact's messages are shown in. */
  async function translateDialog() {
    const conv = state.conversations.get(state.activeId);
    if (!conv) return;
    let info;
    try {
      info = await loadLanguages();
    } catch (err) {
      return toast(err.message);
    }
    if (!info.available && !conv.translateTo) return toast('Translation is not available on this server yet');
    const who = conv.type === 'direct' ? displayName(convPeer(conv)) : convTitle(conv);
    const opened = dialog({
      title: `Translate messages from ${who}`,
      text: 'Messages you receive in this chat will be shown in the language you choose, with a way back to the original. Only this chat is affected.\n\nMessages are end-to-end encrypted, so to translate one your app sends its text to the translation service, which returns it and does not store it. Turn translation off to stop.',
      fields: [
        { name: 'lang', label: 'Show received messages in', options: [['', 'Off (show original)'], ...info.languages.map((l) => [l.code, `${l.name} · ${l.native}`])] },
        ...(state.consent?.optional?.translation ? [] : [{ name: 'agree', type: 'checkbox', required: false, label: consentText('translation') }]),
      ],
      submit: 'Save',
      onSubmit: async (v) => {
        if (v.lang && !state.consent?.optional?.translation) {
          if (!v.agree) throw new Error('Tick the box to agree to this, or choose "Off"');
          await emit('consent:set', { id: 'translation', granted: true });
          state.consent = { ...state.consent, optional: { ...state.consent?.optional, translation: true } };
        }
        const res = await emit('translate:set', { convId: conv.id, lang: v.lang || null });
        applyTranslation(conv.id, res.lang);
      },
    });
    $('#modal-fields [name=lang]').value = conv.translateTo || '';
    await opened;
  }

  /** Apply a chat's language change (from this device or another): clear old translations and translate again. */
  function applyTranslation(convId, lang) {
    const conv = state.conversations.get(convId);
    if (!conv) return;
    if (lang) conv.translateTo = lang;
    else delete conv.translateTo;
    for (const m of state.messages.get(convId) || []) {
      delete m.tr;
      delete m.trLang;
    }
    if (convId === state.activeId) {
      renderHeader();
      renderMessages();
      maybeTranslate(conv);
    }
  }
  $('#menu-translate').addEventListener('click', translateDialog);
  $('#translate-change').addEventListener('click', translateDialog);

  // ---------- who viewed my profile ----------

  const viewedAt = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  function renderViewsRow() {
    const on = state.privacy?.profileViews !== false;
    $('#views-summary').textContent = on ? 'See who looked at your profile, and when' : 'Off · views are not recorded or shown';
  }

  async function openViews() {
    openPanel('#panel-views');
    $('#views-toggle').checked = state.privacy?.profileViews !== false;
    await loadViews();
  }

  async function loadViews() {
    const list = $('#views-list');
    try {
      const res = await emit('profile:views');
      list.textContent = '';
      $('#views-off').classList.toggle('hidden', res.enabled);
      $('#views-empty').classList.toggle('hidden', !res.enabled || res.viewers.length > 0);
      $('#views-count').textContent = res.enabled && res.viewers.length
        ? `${res.viewers.length} ${res.viewers.length === 1 ? 'person' : 'people'} viewed your profile in the last ${res.retentionDays} days`
        : '';
      for (const v of res.viewers) {
        const u = v.user;
        state.users[u.username] = { ...(state.users[u.username] || {}), ...u };
        const li = el('li');
        li.appendChild(avatar(u.displayName, u.username, { online: u.online }));
        const body = el('div', 'body');
        const top = el('div', 'row');
        top.appendChild(el('span', 'name', u.displayName));
        top.append(...userBadges(u));
        top.appendChild(el('span', `contact-tag${v.inContact ? ' in' : ''}`, v.inContact ? 'In contacts' : 'Not in contacts'));
        body.appendChild(top);
        body.appendChild(el('div', 'row')).appendChild(el('span', 'preview', `Last viewed ${viewedAt(v.lastViewedAt)}`));
        li.appendChild(body);
        li.addEventListener('click', () => showProfile(u.username));
        list.appendChild(li);
      }
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- settings: chats on this device ----------

  async function renderCacheRow() {
    const on = cacheEnabled() && !!state.cache?.available;
    $('#cache-toggle').checked = on;
    $('#cache-toggle').disabled = !state.cache?.available;
    $('#btn-cache-clear').disabled = !on;
    const n = state.cache ? await state.cache.count() : 0;
    $('#cache-summary').textContent = !state.cache?.available
      ? 'Not available in this browser'
      : on
        ? `Chats open faster; only new messages are fetched${n ? ` · ${n} saved` : ''}`
        : 'Off · every chat is fetched from the server each time';
  }
  $('#cache-toggle').addEventListener('change', async (e) => {
    storage.set('chat.cache', e.target.checked ? 'on' : 'off');
    if (!e.target.checked) await state.cache?.clear();
    purged.clear();
    renderCacheRow();
  });
  $('#btn-cache-clear').addEventListener('click', async () => {
    if (!confirm('Remove the chats saved on this device? They stay on the server and are fetched again when you open them.')) return;
    await state.cache?.clear();
    purged.clear();
    toast('Saved chats removed from this device');
    renderCacheRow();
  });
  $('#btn-profile').addEventListener('click', () => { renderCacheRow(); });

  // ---------- appearance ----------

  function renderAppearance() {
    const cat = window.Appearance.catalogue;
    const box = (id) => { const n = $(id); n.textContent = ''; return n; };
    if (!cat) return;
    const premium = !!state.me?.premium;
    const current = window.Appearance.prefs;
    const option = (cls, key, item, content) => {
      const b = el('button', `${cls}${item.premium && !premium ? ' locked' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(current[key] === item.id));
      b.dataset.shape = item.id;
      b.append(...content);
      b.addEventListener('click', () => chooseAppearance({ [key]: item.id }, item.premium));
      return b;
    };
    const modeLabels = { auto: 'Automatic', light: 'Light', dark: 'Dark' };
    const modes = box('#ap-modes');
    for (const m of cat.modes) modes.appendChild(option('mode-opt', 'mode', { id: m }, [modeLabels[m]]));
    const themes = box('#ap-themes');
    for (const t of cat.themes) {
      const sw = el('i');
      sw.style.background = t.swatch;
      const b = option('swatch', 'theme', t, [sw, t.label]);
      b.title = t.label;
      themes.appendChild(b);
    }
    const icons = box('#ap-icons');
    for (const i of cat.icons) {
      const holder = el('span');
      holder.innerHTML = i.svg; // from our own server's fixed catalogue
      icons.appendChild(option('icon-opt', 'appIcon', i, [holder.firstChild, i.label]));
    }
    const shapes = box('#ap-shapes');
    for (const s of cat.avatarShapes) shapes.appendChild(option('shape-opt', 'avatarShape', s, [el('i'), s.label]));
    $('#ap-note').textContent = premium ? 'Your choices follow you to every device.' : 'Colour themes, app icons and picture shapes need Premium. Light and dark mode are free.';
    const themeName = cat.themes.find((t) => t.id === current.theme)?.label;
    $('#appearance-summary').textContent = `${modeLabels[current.mode]} · ${themeName} theme`;
  }

  async function chooseAppearance(patch, needsPremium) {
    if (needsPremium && !state.me?.premium) {
      return offerUpgrade('Colour themes, app icons and picture shapes are a Premium feature.');
    }
    const before = { ...window.Appearance.prefs };
    window.Appearance.apply({ ...before, ...patch });
    renderAppearance();
    try {
      const res = await emit('appearance:set', patch);
      window.Appearance.apply(res.appearance);
    } catch (err) {
      window.Appearance.apply(before);
      if (err.code === 'premium_required') offerUpgrade(err.message);
      else toast(err.message);
    }
    renderAppearance();
  }

  $('#btn-appearance').addEventListener('click', async () => {
    openPanel('#panel-appearance');
    await window.Appearance.load().catch(() => {});
    renderAppearance();
  });

  $('#btn-views').addEventListener('click', openViews);
  $('#views-toggle').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    if (!enabled && !confirm("Turn off profile views? Your current list is erased, people won't see when you look at their profile, and you won't see who looks at yours.")) {
      e.target.checked = true;
      return;
    }
    try {
      const res = await emit('profile:views-set', { enabled });
      state.privacy = res.privacy;
      renderViewsRow();
      await loadViews();
    } catch (err) {
      e.target.checked = !enabled;
      toast(err.message);
    }
  });

  // ---------- Premium ----------

  const money = (p) => {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency, maximumFractionDigits: 0 }).format(p.price);
    } catch {
      return `${p.currency} ${p.price}`;
    }
  };

  function renderPremiumRow() {
    const s = state.sub;
    if (!s) return;
    const locks = state.lock.lockedChats.size;
    const hidden = state.lock.hiddenCount ?? s.usage.hiddenChats;
    const until = s.expiresAt ? new Date(s.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: s.plan === 'daily' ? 'short' : undefined }) : '';
    $('#premium-summary').textContent = s.premium
      ? `Premium (${s.plan}) until ${until} · unlimited locked and hidden chats`
      : `${s.expired ? `Premium ended ${until} · ` : 'Free plan · '}${locks} of ${s.limits.free.chatLocks} chats locked · ${hidden} of ${s.limits.free.hiddenChats} hidden`;
    $('#btn-premium').textContent = s.premium ? 'Extend' : 'Upgrade';
    const name = $('#premium-name');
    name.textContent = '';
    if (s.premium) name.appendChild(premiumBadge());
  }

  /** A limit was hit: explain, then offer the plans. */
  async function offerUpgrade(message) {
    const go = await dialog({
      title: 'Premium required',
      text: `${message}\n\nFree: up to 3 locked chats and 1 hidden chat.\nPremium: unlimited locked and hidden chats, call recording, colour themes, app icons and picture shapes.`,
      fields: [],
      submit: 'See plans',
      onSubmit: async () => {},
    });
    if (go) await upgradeDialog();
  }

  /** Choose Daily / Monthly / Yearly, pay on the provider's page, then confirm. */
  async function upgradeDialog() {
    let info;
    try {
      info = await emit('subscription:status');
    } catch (err) {
      return toast(err.message);
    }
    state.sub = info;
    if (!info.available) return toast('Subscriptions are not available on this server yet');
    let order;
    const chosen = await dialog({
      title: 'Upgrade to Premium',
      text: `Unlimited locked chats and hidden chats, up to 5 profile photos (free accounts: 2), a Premium badge${state.guardian ? ', and your parent or guardian can then change your parental controls' : ''}. Paid in advance for the period you choose; it does not renew by itself, and buying again extends it.`,
      fields: [{ name: 'plan', label: 'Plan', options: info.plans.map((p) => [p.id, planLabel(p)]) }],
      submit: info.providerLabel && info.provider !== 'sandbox' && info.provider !== 'relay' ? `Pay with ${info.providerLabel}` : 'Continue to payment',
      onSubmit: async (v) => {
        // Open the payment tab straight from the tap (browsers block tabs opened after a wait), then point it at the payment page.
        const tab = info.provider === 'sandbox' ? null : window.open('', '_blank');
        try {
          order = await emit('subscription:checkout', { plan: v.plan });
        } catch (err) {
          tab?.close();
          throw err;
        }
        if (tab && order.paymentUrl) tab.location.href = order.paymentUrl;
        else tab?.close();
      },
    });
    if (!chosen || !order) return;
    state.awaitingPayment = order.orderId;
    const paid = await dialog({
      title: order.sandbox ? 'Pay (sandbox)' : 'Complete your payment',
      text: order.sandbox
        ? 'Sandbox: no real payment is taken.'
        : `Pay on the ${order.providerLabel || 'payment'} page that opened. Your card and bank details never reach VartiQ.\n\nPremium switches on by itself as soon as the payment is received. If it does not, tap "I have paid".`,
      fields: [],
      submit: order.sandbox ? 'Pay (test)' : 'I have paid',
      onSubmit: async () => { state.sub = await emit('subscription:confirm', { orderId: order.orderId }); },
    });
    state.awaitingPayment = null;
    if (paid) {
      renderPremiumRow();
      toast('You are Premium ★');
    }
  }

  /** "Monthly · ₹99", with what a longer plan saves. */
  function planLabel(p) {
    const per = p.months > 1 && p.perMonth ? ` · ${money({ currency: p.currency, price: Math.round(p.perMonth) })}/month` : '';
    return `${p.label} · ${money(p)}${per}${p.savePct ? ` · save ${p.savePct}%` : ''}`;
  }

  // Razorpay (or our check) says the payment arrived, even if this app was in the background or closed the payment tab.
  const paymentReceivedHook = (e) => {
    toast(`Payment received: ${money({ currency: e.payment.currency, price: e.payment.amount })}. Premium is on until ${new Date(e.subscription.expiresAt).toLocaleDateString([], { dateStyle: 'medium' })}.`);
    if (state.awaitingPayment && !$('#modal').classList.contains('hidden')) {
      state.awaitingPayment = null;
      $('#modal-cancel').click(); // the waiting dialog is done
    }
  };

  $('#btn-payments').addEventListener('click', async () => {
    try {
      const { payments } = await emit('payments:history');
      const lines = payments.length
        ? payments.map((p) => `${new Date(p.at).toLocaleDateString([], { dateStyle: 'medium' })} · ${money({ currency: p.currency, price: p.amount })} · ${p.plan}${p.refunded ? ` · refunded ${money({ currency: p.currency, price: p.refunded })}` : ''}\nReceipt ${p.id}`).join('\n\n')
        : 'No payments yet.';
      await dialog({ title: 'My payments', text: lines, fields: [], submit: 'Close', onSubmit: async () => {} });
    } catch (err) {
      toast(err.message);
    }
  });
  $('#btn-premium').addEventListener('click', upgradeDialog);

  // ---------- verified badge (KYC) ----------

  function renderVerifyRow() {
    const verified = !!state.me?.verified;
    $('#verify-summary').textContent = verified
      ? 'Verified · your identity was checked with a government ID'
      : 'Not verified · verify with a government ID to get the Verified badge';
    const btn = $('#btn-verify');
    btn.textContent = verified ? 'Verified ✓' : 'Verify';
    btn.disabled = verified;
    const name = $('#verify-name');
    name.textContent = '';
    name.appendChild(trustBadge(state.me));
  }

  /** Pick an ID type, enter its number (sent straight to the verification service, never stored), then the OTP. */
  async function startVerification() {
    let info;
    try {
      info = await emit('kyc:status');
    } catch (err) {
      return toast(err.message);
    }
    if (info.verified) return toast('You are already verified');
    if (!info.available) return toast('Identity verification is not available on this server yet');
    let sent;
    const first = await dialog({
      title: 'Get the Verified badge',
      text: 'Verify with any government ID. We pass the number to the verification service, which sends a one-time code to the mobile number linked to the ID. We do not store your ID number or any KYC details: only that you are verified.',
      fields: [
        { name: 'type', label: 'ID type', options: info.types.map((t) => [t.id, `${t.label} (${t.hint})`]) },
        { name: 'idNumber', label: 'ID number', type: 'text', maxLength: 30, autocomplete: 'off' },
        ...(state.consent?.optional?.kyc ? [] : [{ name: 'agree', type: 'checkbox', label: consentText('kyc') }]),
      ],
      submit: 'Send code',
      onSubmit: async (v) => {
        if (!state.consent?.optional?.kyc) {
          await emit('consent:set', { id: 'kyc', granted: true });
          state.consent = { ...state.consent, optional: { ...state.consent?.optional, kyc: true } };
        }
        sent = await emit('kyc:start', { type: v.type, idNumber: v.idNumber });
      },
    });
    if (!first || !sent) return;
    const done = await dialog({
      title: 'Enter the code',
      text: `Enter the one-time code sent to the mobile number linked to your ID${sent.sentTo ? ` (${sent.sentTo})` : ''}.${sent.devCode ? ` (Sandbox code: ${sent.devCode})` : ''}`,
      fields: [{ name: 'otp', label: 'One-time code', type: 'text', maxLength: 8, autocomplete: 'one-time-code' }],
      submit: 'Verify',
      onSubmit: async (v) => {
        const res = await emit('kyc:verify', { requestId: sent.requestId, otp: v.otp.trim() });
        state.me = { ...state.me, ...res.user, verified: res.user.verified };
        state.users[state.me.username] = { ...res.user, online: true };
      },
    });
    if (done) {
      renderVerifyRow();
      renderChatList();
      toast('You are verified ✓');
    }
  }
  $('#btn-verify').addEventListener('click', startVerification);

  // ---------- encryption: security code and devices ----------

  async function showSafetyNumber(conv) {
    const peer = convPeer(conv);
    try {
      const keys = await state.e2ee.keysFor(conv.id, { refresh: true });
      const mine = { username: state.me.username, devices: keys[state.me.username] || [] };
      const theirs = { username: peer, devices: keys[peer] || [] };
      if (!theirs.devices.length) return toast(`${displayName(peer)} hasn't set up encryption yet`);
      const number = await window.E2EE.safetyNumber(mine, theirs);
      await dialog({
        title: 'Verify security code',
        text: `To check that your chat with ${displayName(peer)} is end-to-end encrypted, compare this number with the one on their phone, in person or over a call. It changes if either of you adds or removes a device.\n\n${number}`,
        fields: [],
        submit: 'Done',
        onSubmit: async () => {},
      });
    } catch (err) {
      toast(err.message);
    }
  }

  function renderE2eeSummary() {
    $('#e2ee-summary').textContent = state.e2ee?.ready
      ? 'Messages are end-to-end encrypted · manage linked devices'
      : 'Not available in this browser';
  }

  async function renderDevices() {
    const list = $('#device-list');
    const { devices } = await emit('e2ee:devices');
    list.textContent = '';
    for (const d of devices) {
      const li = el('li');
      const body = el('div', 'body');
      const top = el('div', 'row');
      top.appendChild(el('span', 'name', d.name));
      if (d.id === state.e2ee?.deviceId) top.appendChild(el('span', 'device-this', 'This device'));
      body.appendChild(top);
      body.appendChild(el('div', 'row', '')).appendChild(el('span', 'preview', `Added ${new Date(d.createdAt).toLocaleDateString([], { dateStyle: 'medium' })} · key ${d.keyId}`));
      li.appendChild(body);
      if (d.id !== state.e2ee?.deviceId) {
        const rm = el('button', 'link danger-link', 'Remove');
        rm.type = 'button';
        rm.addEventListener('click', async () => {
          if (!confirm(`Remove "${d.name}"? It will no longer be able to read new messages.`)) return;
          try {
            await emit('e2ee:remove', { id: d.id });
            await renderDevices();
          } catch (err) {
            toast(err.message);
          }
        });
        li.appendChild(rm);
      }
      list.appendChild(li);
    }
  }
  $('#btn-devices').addEventListener('click', async () => {
    openPanel('#panel-devices');
    try {
      await renderDevices();
    } catch (err) {
      toast(err.message);
    }
  });

  // ---------- hidden chats ----------

  async function loadHidden() {
    const { conversations, users } = await emit('hidden:list');
    Object.assign(state.users, users);
    for (const c of [...state.conversations.values()]) if (c.hidden) state.conversations.delete(c.id);
    conversations.forEach((c) => state.conversations.set(c.id, c));
  }

  /** Close hidden chats again: forget their content and drop them from memory. */
  async function closeHidden() {
    if (!state.hiddenOpen) return;
    state.hiddenOpen = false;
    emit('hidden:close').catch(() => {});
    for (const c of [...state.conversations.values()]) {
      if (!c.hidden) continue;
      forgetChatContent(c.id);
      state.conversations.delete(c.id);
      if (state.activeId === c.id) closeChat();
    }
    $('#hidden-list').textContent = '';
    $('#panel-hidden').classList.add('hidden');
    renderChatList();
  }
  $('#btn-hidden-back').addEventListener('click', closeHidden);

  $('#btn-hidden-open').addEventListener('click', async () => {
    if (!state.lock.hasCode) {
      toast('Nothing is hidden yet. Open a chat, tap ⋮ and choose Hide chat.');
      return;
    }
    await askProof({
      title: 'Hidden chats',
      text: 'Enter your secret code to open your hidden chats.',
      submit: 'Open',
      run: async (proof) => {
        const { conversations, users } = await emit('hidden:reveal', proof);
        Object.assign(state.users, users);
        state.hiddenOpen = true;
        conversations.forEach((c) => state.conversations.set(c.id, c));
        renderChatList();
        openPanel('#panel-hidden');
      },
    });
  });

  /** Hide or unhide the chat with a conversation (the open chat, or from contact info). */
  async function toggleHide(conv) {
    try {
      if (conv.hidden) {
        const res = await emit('hidden:unhide', { convId: conv.id });
        state.conversations.set(conv.id, res.conversation);
        setLockSettings(res);
        renderChatList();
        renderHeader();
        refreshContactInfo();
        toast('Chat is back in your chat list');
        return;
      }
      if (!state.lock.hasCode && !(await setCodeDialog())) return;
      setLockSettings(await emit('hidden:hide', { convId: conv.id }));
      forgetChatContent(conv.id);
      state.conversations.delete(conv.id);
      closeChat();
      $('#panel-contact').classList.add('hidden');
      toast('Chat hidden · open it from Profile → Hidden chats');
    } catch (err) {
      if (err.code === 'premium_required') return offerUpgrade(err.message);
      toast(err.message);
    }
  }
  $('#menu-hide').addEventListener('click', () => {
    const conv = state.conversations.get(state.activeId);
    if (conv) toggleHide(conv);
  });

  /** Hide one specific contact's chat (from the New chat list), even if you have never chatted. */
  async function hideContact(u) {
    if (!state.lock.hasCode && !(await setCodeDialog())) return;
    try {
      setLockSettings(await emit('hidden:hide', { username: u.username }));
      state.conversations.delete(dmId(u.username));
      renderChatList();
      toast(`Chat with ${u.displayName} is hidden · open it from Profile → Hidden chats`);
    } catch (err) {
      if (err.code === 'premium_required') return offerUpgrade(err.message);
      toast(err.message);
    }
  }
  const dmId = (other) => 'dm:' + [state.me.username, other].sort().join(':');

  $('#btn-hidden-clear').addEventListener('click', () => askProof({
    title: 'Clear all chats from Hide chat',
    text: 'Every hidden chat goes back to your chat list. Nothing is deleted. Enter your secret code to continue.',
    submit: 'Clear all',
    run: async (proof) => {
      const res = await emit('hidden:clear', proof);
      setLockSettings(res);
      await closeHidden();
      await loadConversations();
      toast(res.cleared ? `${res.cleared} chat${res.cleared === 1 ? ' is' : 's are'} back in your chat list` : 'No chats were hidden');
    },
  }));

  $('#btn-lock-clear').addEventListener('click', () => askProof({
    title: 'Remove all chats from Chat lock',
    text: 'None of your chats will ask for the secret code any more. Enter your secret code to continue.',
    submit: 'Remove all locks',
    run: async (proof) => {
      const res = await emit('chatlock:clear', proof);
      setLockSettings(res);
      await loadConversations();
      if (state.activeId) openChat(state.activeId);
      toast(res.cleared ? `Chat lock removed from ${res.cleared} chat${res.cleared === 1 ? '' : 's'}` : 'No chats were locked');
    },
  }));

  // Short notices at the bottom of the screen.
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  // Public channels (see channels.js)
  const channelsUI = window.createChannelsController({
    emit,
    me: () => state.me,
    displayName,
    avatar,
    userBadges,
    toast,
    dialog,
    openPanel,
    mergeUsers: (users) => {
      for (const [u, info] of Object.entries(users || {})) state.users[u] = { ...(state.users[u] || {}), ...info };
    },
    // A channel took over the main area (or gave it back).
    onShow(show) {
      if (show) {
        state.activeId = null;
        $('#chat-view').classList.add('hidden');
        $('#empty-state').classList.add('hidden');
        $('#app').classList.add('chat-open');
        renderChatList();
      } else {
        $('#app').classList.remove('chat-open');
        $('#empty-state').classList.remove('hidden');
      }
    },
  });

  // Status updates (see status.js)
  const statusUpdates = window.createStatusController({
    emit,
    // Encrypt a reply to someone's status like any other message to them (null = send it plain).
    sealReply: async (owner, text) => {
      try {
        const conv = { id: dmId(owner) };
        if (!state.e2ee?.ready || !(await state.e2ee.canEncrypt(conv.id))) return null;
        return (await state.e2ee.encrypt(conv, { t: text })).envelope;
      } catch {
        return null;
      }
    },
    me: () => state.me,
    displayName,
    paintAvatar,
    mediaUrl,
    toast,
    mergeUsers: (users) => {
      for (const [u, info] of Object.entries(users || {})) state.users[u] = { ...(state.users[u] || {}), ...info };
    },
  });
  $('#btn-status').addEventListener('click', () => {
    openPanel('#panel-status');
    statusUpdates.renderPanel();
    statusUpdates.load();
  });

  // Starred messages
  async function loadStarred() {
    const list = $('#starred-list');
    try {
      const { messages } = await emit('messages:starred');
      list.textContent = '';
      $('#starred-empty').classList.toggle('hidden', messages.length > 0);
      for (const m of messages) {
        const conv = state.conversations.get(m.convId);
        if (!conv) continue;
        const li = el('li');
        li.appendChild(avatar(displayName(m.from), m.from));
        const body = el('div', 'body');
        const top = el('div', 'row');
        const who = m.from === state.me.username ? 'You' : displayName(m.from);
        top.appendChild(el('span', 'name', conv.type === 'group' ? `${who} ▸ ${convTitle(conv)}` : who));
        top.appendChild(el('span', 'time', listTime(m.ts)));
        body.appendChild(top);
        const bottom = el('div', 'row');
        const preview = el('span', 'preview');
        preview.appendChild(icon('starred'));
        if (m.masked) preview.appendChild(icon('masked'));
        preview.appendChild(document.createTextNode(
          m.locked ? '🔒 In a locked chat'
            : m.type === 'voice' ? `🎤 Voice message (${fmtDuration(m.voice.duration)})` : previewText(m),
        ));
        bottom.appendChild(preview);
        body.appendChild(bottom);
        li.appendChild(body);
        li.addEventListener('click', () => {
          $('#panel-starred').classList.add('hidden');
          openChat(m.convId, { highlight: m.id });
        });
        list.appendChild(li);
      }
    } catch (err) {
      console.error(err);
    }
  }
  $('#btn-starred').addEventListener('click', () => {
    openPanel('#panel-starred');
    loadStarred();
  });

  // Offline banner: shown while the connection to the server is down.
  function setOffline(offline) {
    $('#offline-banner').classList.toggle('hidden', !offline);
  }
  window.addEventListener('offline', () => setOffline(true));
  window.addEventListener('online', () => setOffline(!state.socket?.connected));

  // Keep "last seen" labels fresh.
  setInterval(() => { if (state.activeId) renderHeader(); }, 60_000);

  // ---------- boot ----------
  const saved = storage.get('chat.token');
  if (saved) start(saved);
  else showAuth();
})();
