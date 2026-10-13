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
    maskNext: false, // composer: send the next message masked
    blocked: new Set(), // usernames I have blocked
    lock: { hasCode: false, lockedChats: new Set() }, // chat lock settings
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
    a.style.background = colorFor(key || name);
    a.textContent = group ? '👥' : initials(name);
    if (online) a.classList.add('online');
    return a;
  }
  function paintAvatar(node, name, key, { online = false, group = false } = {}) {
    node.style.background = colorFor(key || name);
    node.textContent = group ? '👥' : initials(name);
    node.classList.toggle('online', online);
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
    else if (status === 'completed') [sub, iconName] = [fmtDuration(duration), group ? 'group-call' : 'call'];
    else if (status === 'declined') [sub, iconName] = ['Declined', 'call-declined'];
    else [sub, iconName] = ['No answer', 'call-end'];
    return { title, sub, missed, icon: iconName };
  }

  const emit = (event, payload) => new Promise((resolve, reject) => {
    state.socket.emit(event, payload, (res) => (res && res.ok ? resolve(res) : reject(new Error(res?.error || 'Request failed'))));
  });

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
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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

  const authForm = $('#auth-form');
  const auth = { mode: 'login', type: 'individual', loginBy: 'phone' };
  const authError = (text) => { $('#auth-error').textContent = text; };
  const purpose = () => (auth.mode === 'login' ? 'login' : 'register');
  const phoneField = createOtpField(authForm.querySelector('[data-field=phone]'), {
    destination: () => fullPhone(authForm),
    request: (phone) => apiPost('/auth/otp', { purpose: purpose(), phone }),
    onError: authError,
  });
  const emailField = createOtpField(authForm.querySelector('[data-field=email]'), {
    destination: () => authForm.email.value.trim(),
    request: (email) => apiPost('/auth/otp', { purpose: purpose(), email }),
    onError: authError,
  });

  /** Which code fields this form needs, in order. */
  const neededFields = () => {
    if (auth.mode === 'login') return [auth.loginBy === 'email' ? emailField : phoneField];
    return auth.type === 'business' ? [phoneField, emailField] : [phoneField];
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
    const useEmail = business || (!register && auth.loginBy === 'email');
    authForm.querySelector('[data-field=phone]').classList.toggle('hidden', !usePhone);
    authForm.querySelector('[data-field=email]').classList.toggle('hidden', !useEmail);
    $('#auth-email').placeholder = business ? 'you@business.com' : 'Your business email';
    $('#auth-name-label').textContent = business ? 'Business name' : 'Your name';
    $('#auth-use-email').textContent = auth.loginBy === 'email' ? 'Log in with mobile number instead' : 'Business account? Log in with email';
    $('#auth-lead').textContent = !register
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
  $('#auth-use-email').addEventListener('click', () => {
    auth.loginBy = auth.loginBy === 'email' ? 'phone' : 'email';
    phoneField.reset();
    emailField.reset();
    authError('');
    paintAuth();
  });
  authForm.addEventListener('input', () => { authError(''); paintSubmit(); });

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
      if (!register) {
        const by = auth.loginBy === 'email' ? { email: authForm.email.value.trim() } : { phone: fullPhone(authForm) };
        data = await apiPost('/auth/login', { ...by, ...(auth.loginBy === 'email' ? emailField : phoneField).proof() });
      } else {
        data = await apiPost('/auth/register', {
          accountType: auth.type,
          displayName: authForm.displayName.value.trim(),
          phone: fullPhone(authForm),
          phoneOtp: phoneField.proof(),
          ...(business ? {
            email: authForm.email.value.trim(),
            emailOtp: emailField.proof(),
            business: { category: authForm.category.value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
          } : {}),
        });
      }
      storage.set('chat.token', data.token);
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
    if (state.token) fetch('/api/v1/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } }).catch(() => {});
    storage.del('chat.token');
    state.calls?.dispose();
    statusUpdates.reset();
    state.socket?.disconnect();
    Object.assign(state, { token: null, me: null, socket: null, activeId: null, calls: null, contact: null });
    state.conversations.clear();
    state.messages.clear();
    state.outbox.clear();
    state.revealed.clear();
    state.lock = { hasCode: false, lockedChats: new Set() };
    state.blocked.clear();
    stopRecording(false);
    state.voiceUrls.forEach((url) => URL.revokeObjectURL(url));
    state.voiceUrls.clear();
    state.users = {};
    showAuth();
  }

  // ---------- startup ----------

  function start(token, user) {
    state.token = token;
    state.me = user || null;
    const socket = io({ auth: { token, appSession: APP_SESSION } });
    state.socket = socket;
    state.calls = window.createCallController({
      socket,
      emit,
      iceServers: () => state.iceServers,
      displayName,
      paintAvatar,
    });
    statusUpdates.attach(socket);

    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') {
        socket.disconnect();
        storage.del('chat.token');
        showAuth();
      }
    });

    socket.on('connect', async () => {
      try {
        const [{ user: me, iceServers, blocked, defaultDisappear, business, contact }, lockSettings] = await Promise.all([emit('me'), emit('chatlock:settings')]);
        state.defaultDisappear = defaultDisappear || null;
        state.contact = contact || { phone: null, email: null };
        state.myBusiness = business || null;
        setLockSettings(lockSettings);
        state.me = me;
        state.iceServers = iceServers || [];
        state.blocked = new Set(blocked || []);
        setOffline(false);
        state.users[me.username] = { ...me, online: true };
        $('#auth').classList.add('hidden');
        $('#app').classList.remove('hidden');
        paintAvatar($('#btn-profile'), me.displayName, me.username);
        await loadConversations();
        statusUpdates.load();
        // Refresh the open chat after a reconnect.
        if (state.activeId) openChat(state.activeId);
        // Back online: resend anything that failed while we were offline.
        for (const m of state.outbox.values()) if (m.localStatus === 'failed') deliver(m);
      } catch (err) {
        console.error(err);
      }
    });

    socket.on('disconnect', () => setOffline(true));
    socket.on('message:new', ({ message }) => onMessage(message));
    socket.on('message:starred', ({ convId, id, starred }) => {
      const m = state.messages.get(convId)?.find((x) => x.id === id);
      if (m) m.starred = starred;
      if (convId === state.activeId) renderMessages();
      if (!$('#panel-starred').classList.contains('hidden')) loadStarred();
    });
    socket.on('conversation:updated', ({ conversation }) => {
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
    socket.on('message:expired', ({ convId, ids }) => removeMessages(convId, new Set(ids)));
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
    socket.on('message:status', ({ convId, messages }) => {
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
    socket.on('message:deleted', ({ convId, id }) => {
      const m = state.messages.get(convId)?.find((x) => x.id === id);
      if (m) Object.assign(m, { deleted: true, text: '' });
      const conv = state.conversations.get(convId);
      if (conv?.lastMessage?.id === id) Object.assign(conv.lastMessage, { deleted: true, text: '' });
      if (convId === state.activeId) renderMessages();
      renderChatList();
    });
    socket.on('conversation:new', ({ conversation, users }) => {
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
        state.me = { ...state.me, ...user, business: user.business };
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
    const list = $('#chat-list');
    list.textContent = '';
    const q = state.filter.toLowerCase();
    const convs = [...state.conversations.values()]
      .filter((c) => c.type === 'group' || c.lastMessage || c.disappearAfter || c.id === state.activeId)
      .filter((c) => !q || convTitle(c).toLowerCase().includes(q))
      .sort((a, b) => (b.lastMessage?.ts || b.createdAt) - (a.lastMessage?.ts || a.createdAt));

    $('#chat-list-empty').classList.toggle('hidden', convs.length > 0 || !!q);

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
      if (peer && state.users[peer]?.business) top.appendChild(businessBadge());
      if (c.disappearAfter) top.appendChild(timerIcon(`Disappearing messages: ${fmtTimer(c.disappearAfter)}`));
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
          else text = prefix + (m.masked ? 'Masked message' : m.text);
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

  async function openChat(id, { highlight } = {}) {
    const conv = state.conversations.get(id);
    if (!conv) return;
    // Switching chats mid-recording sends the recording to the chat it was made in.
    if (state.recorder && state.recorder.convId !== id) stopRecording(true);
    state.activeId = id;
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
      const { messages } = await emit('messages:get', { convId: id });
      if (state.activeId !== id) return;
      // Keep my unconfirmed / failed messages visible across reloads of the chat.
      for (const m of state.outbox.values()) {
        if (m.convId !== id) continue;
        if (messages.some((x) => x.clientId === m.id)) state.outbox.delete(m.id);
        else messages.push(m);
      }
      state.messages.set(id, messages);
      renderMessages(true);
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
    if (peer && state.users[peer]?.business) badgesEl.appendChild(businessBadge());
    if (conv.disappearAfter) badgesEl.appendChild(timerIcon(`Disappearing messages: ${fmtTimer(conv.disappearAfter)}`));
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

    // Locked and not unlocked in this session: show the lock screen instead of the chat.
    const lockedView = isLockedView(conv);
    $('#lock-screen').classList.toggle('hidden', !lockedView);
    $('#messages').classList.toggle('hidden', lockedView);
    if (lockedView) forgetChatContent(conv.id);
    $('#timer-banner').classList.toggle('hidden', !conv.disappearAfter || lockedView);
    if (conv.disappearAfter) {
      $('#timer-banner-text').textContent = `Disappearing messages are on: new messages disappear ${fmtTimer(conv.disappearAfter)} after they're sent. Tap to change.`;
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
      const bubble = el('div', `msg${mine ? ' out' : ''}${first ? ' first' : ''}${m.deleted ? ' deleted' : ''}${status === 'failed' ? ' failed' : ''}${m.type === 'voice' && !m.deleted ? ' voice' : ''}`);
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
      } else if (covered) {
        const cover = el('button', 'masked-cover');
        cover.type = 'button';
        cover.title = 'Reveal message';
        cover.append(icon('masked', 'inline-icon'), el('span', '', 'Masked message'), el('small', '', 'Tap to reveal'));
        cover.addEventListener('click', () => { state.revealed.add(m.id); renderMessages(); });
        bubble.appendChild(cover);
      } else {
        bubble.appendChild(el('span', 'text', m.text));
      }
      const meta = el('span', 'meta');
      if (m.auto && !m.deleted) meta.appendChild(el('span', 'auto-label', 'Automated'));
      if (m.expiresAt && !m.deleted) meta.appendChild(timerIcon(`Disappears ${new Date(m.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`));
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

  const voiceUrl = (m) => (m.localUrl ? Promise.resolve(m.localUrl) : mediaUrl(m.voice.mediaId));

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

  /** Send (or re-send) one of my messages; failures leave it in the chat marked as failed. */
  function deliver(msg) {
    msg.localStatus = 'sending';
    delete msg.error;
    refreshConversation(msg.convId);
    const voice = msg.type === 'voice';
    const payload = voice
      ? { convId: msg.convId, clientId: msg.id, duration: msg.voice.duration, mime: msg.voice.mime, data: msg.audio }
      : { convId: msg.convId, text: msg.text, masked: !!msg.masked, clientId: msg.id };
    const fail = (error) => {
      if (!state.outbox.has(msg.id)) return; // confirmed meanwhile (e.g. via message:new)
      msg.localStatus = 'failed';
      msg.error = error;
      refreshConversation(msg.convId);
    };
    if (!state.socket?.connected) return fail('You are offline');
    state.socket.timeout(voice ? VOICE_TIMEOUT_MS : SEND_TIMEOUT_MS).emit(voice ? 'voice:send' : 'message:send', payload, (err, res) => {
      if (err) fail('No response from the server');
      else if (!res?.ok) fail(res?.error || 'Could not send');
      else {
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
    if (msg.convId === state.activeId) {
      renderMessages(mine);
      if (!mine) markRead(msg.convId);
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

  // ---------- side panels ----------

  function openPanel(id) {
    document.querySelectorAll('.panel.overlay').forEach((p) => p.classList.add('hidden'));
    $(id).classList.remove('hidden');
  }
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => b.closest('.panel').classList.add('hidden')));

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
    if (u.business) top.appendChild(businessBadge());
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
    paintAvatar($('#profile-avatar'), state.me.displayName, state.me.username);
    $('#profile-username').textContent = '@' + state.me.username;
    renderLockSummary();
    renderProfileExtras();
  });
  $('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { user } = await emit('profile:update', {
        displayName: e.target.displayName.value,
        about: e.target.about.value,
      });
      state.me = user;
      state.users[user.username] = { ...user, online: true };
      paintAvatar($('#btn-profile'), user.displayName, user.username);
      paintAvatar($('#profile-avatar'), user.displayName, user.username);
      $('#profile-msg').textContent = 'Saved ✓';
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
    if (!s.seconds) return `${who} turned off disappearing messages.`;
    return short
      ? `${who} set messages to disappear after ${fmtTimer(s.seconds)}`
      : `${who} turned on disappearing messages. New messages will disappear ${fmtTimer(s.seconds)} after they're sent.`;
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
    $('#timer-title').textContent = mode === 'chat' ? 'Disappearing messages' : 'Default message timer';
    $('#timer-text').textContent = mode === 'chat'
      ? `New messages in this chat will disappear for everyone after the time you choose. Anyone in the chat can change it. Messages already sent aren't affected.`
      : `New one-to-one chats and groups you start will have disappearing messages turned on. Existing chats aren't affected.`;
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
        $('#timer-preview').textContent = sec ? `Messages will disappear ${fmtTimer(sec)} after they're sent.` : 'Messages will not disappear.';
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
        toast(seconds ? `Messages will disappear after ${fmtTimer(seconds)}` : 'Disappearing messages turned off');
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
      ? `${fmtTimer(state.defaultDisappear)} for new chats you start`
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

  function businessCard(b) {
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
    paintAvatar(av, convTitle(conv), group ? conv.id : peer, { group });
    const name = el('h2', 'info-name', convTitle(conv));
    if (user?.business) name.appendChild(businessBadge());
    top.append(av, name, el('p', 'muted', group ? `Group · ${conv.members.length} members` : `@${peer}`));
    if (user && !group) top.appendChild(el('p', 'muted', user.online ? 'online' : lastSeenText(peer) || ''));
    body.appendChild(top);

    if (user?.about) {
      const about = el('section', 'info-card');
      about.append(el('div', 'info-label', 'About'), el('div', '', user.about));
      body.appendChild(about);
    }
    if (user?.business) body.appendChild(businessCard(user.business));

    const timer = el('section', 'info-card info-action');
    timer.appendChild(timerIcon(''));
    const tbody = el('div', 'grow');
    tbody.append(el('div', '', 'Disappearing messages'), el('div', 'muted small-note', conv.disappearAfter ? fmtTimer(conv.disappearAfter) : 'Off'));
    const change = el('button', 'link', 'Change');
    change.type = 'button';
    change.addEventListener('click', () => openTimerDialog('chat'));
    timer.append(tbody, change);
    body.appendChild(timer);

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
        if (u.business) row.appendChild(businessBadge());
        if (conv.admins?.includes(m)) row.appendChild(el('span', 'admin-tag', 'Admin'));
        b.append(row, el('div', 'sub', u.business ? u.business.category : `@${m}`));
        li.appendChild(b);
        ul.appendChild(li);
      }
      members.appendChild(ul);
      body.appendChild(members);
    }
  }

  function openContactInfo() {
    const conv = state.conversations.get(state.activeId);
    if (!conv) return;
    openPanel('#panel-contact');
    renderContactInfo(conv);
  }
  function refreshContactInfo() {
    if ($('#panel-contact').classList.contains('hidden')) return;
    const conv = state.conversations.get(state.activeId);
    if (conv) renderContactInfo(conv);
  }
  $('#chat-title-btn').addEventListener('click', openContactInfo);
  $('#menu-info').addEventListener('click', openContactInfo);

  // ---------- business profile settings ----------

  function defaultHours() {
    const H = window.BusinessHours;
    return Object.fromEntries(H.DAYS.map((d) => [d, ['sat', 'sun'].includes(d) ? { mode: 'closed' } : { mode: 'hours', open: '09:00', close: '17:00' }]));
  }

  function openBusinessPanel() {
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

  function setLockSettings({ hasCode, lockedChats }) {
    state.lock = { hasCode, lockedChats: new Set(lockedChats) };
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
  }

  /**
   * Small modal form. `fields`: [{ name, label, type, autocomplete }]. `onSubmit(values)` may throw
   * to show an error and keep the dialog open. Resolves with its result, or null if cancelled.
   */
  function dialog({ title, text = '', fields, submit = 'OK', onSubmit }) {
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
        const label = el('label', '', f.label);
        const input = el('input');
        Object.assign(input, { name: f.name, type: f.type || 'password', required: true, maxLength: 64, autocomplete: f.autocomplete || 'off' });
        label.appendChild(input);
        box.appendChild(label);
      }
      modal.classList.remove('hidden');
      box.querySelector('input')?.focus();
      const close = (result) => {
        modal.classList.add('hidden');
        form.onsubmit = null;
        $('#modal-cancel').onclick = null;
        resolve(result);
      };
      $('#modal-cancel').onclick = () => close(null);
      form.onsubmit = async (e) => {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(form).entries());
        $('#modal-submit').disabled = true;
        try {
          close((await onSubmit(values)) ?? true);
        } catch (err) {
          $('#modal-error').textContent = err.message;
        } finally {
          $('#modal-submit').disabled = false;
        }
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
        : 'Locked chats ask for this code every time you open ChatApp or log in. Keep it private.',
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
      await dialog({
        title: 'Remove chat lock',
        text: `Enter your secret code to stop locking "${convTitle(conv)}".`,
        fields: [{ name: 'code', label: 'Secret code' }],
        submit: 'Remove lock',
        onSubmit: async ({ code }) => {
          setLockSettings(await emit('chatlock:remove', { convId: conv.id, code }));
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
      alert(err.message);
    }
  }

  $('#menu-lock').addEventListener('click', toggleChatLock);
  $('#btn-lock-code').addEventListener('click', setCodeDialog);
  $('#btn-lock-forgot').addEventListener('click', forgotCodeDialog);
  $('#btn-forgot-code').addEventListener('click', forgotCodeDialog);
  $('#btn-lock-now').addEventListener('click', async () => {
    await emit('chatlock:relock').catch(() => {});
    for (const c of state.conversations.values()) {
      if (c.locked) forgetChatContent(c.id);
    }
    await loadConversations();
    if (state.activeId) openChat(state.activeId);
    toast('Locked chats are locked again');
  });

  $('#unlock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = state.activeId;
    try {
      const { conversation } = await emit('chatlock:unlock', { convId: id, code: $('#unlock-code').value });
      Object.assign(state.conversations.get(id), conversation);
      $('#unlock-code').value = '';
      openChat(id);
    } catch (err) {
      $('#unlock-error').textContent = err.message;
      $('#unlock-code').select();
    }
  });

  // Short notices at the bottom of the screen.
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  // Status updates (see status.js)
  const statusUpdates = window.createStatusController({
    emit,
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
            : m.type === 'voice' ? `🎤 Voice message (${fmtDuration(m.voice.duration)})` : m.masked ? 'Masked message' : m.text,
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
