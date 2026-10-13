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
  };

  // ---------- helpers ----------

  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const COLORS = ['#00a884', '#25a3e0', '#e66b4f', '#a36de0', '#e0a325', '#4fb3a8', '#e04f86', '#6b8be0', '#7cb342', '#ff7043'];
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
  const convPeer = (c) => (c.type === 'direct' ? c.members.find((m) => m !== state.me.username) : null);

  /** 'sent' | 'delivered' | 'read' for a message I sent. */
  function statusOf(msg, conv) {
    const others = conv.members.filter((m) => m !== msg.from);
    if (others.length && others.every((m) => msg.readBy.includes(m))) return 'read';
    if (others.length && others.every((m) => msg.deliveredTo.includes(m))) return 'delivered';
    return 'sent';
  }
  function ticks(status) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 11');
    svg.setAttribute('class', 'ticks' + (status === 'read' ? ' read' : ''));
    svg.setAttribute('aria-label', status);
    const d = status === 'sent' ? 'M1.5 6 4.5 9 10.5 2' : 'M1 6 4 9 10 2 M6 8.2 7 9 13 2';
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    return svg;
  }

  // ---------- call history entries ----------

  const CALL_ICONS = {
    audio: 'M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1L6.6 10.8Z',
    video: 'M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4Z',
  };
  function callGlyph(kind, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', cls);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', CALL_ICONS[kind] || CALL_ICONS.audio);
    svg.appendChild(p);
    return svg;
  }
  const fmtDuration = (s) => (s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

  /** Title/subtitle for a call entry from my point of view. */
  function describeCall(m) {
    const { kind, status, duration } = m.call;
    const mine = m.from === state.me.username;
    const noun = kind === 'video' ? 'video call' : 'voice call';
    const missed = !mine && status !== 'completed';
    const title = missed ? `Missed ${noun}` : noun[0].toUpperCase() + noun.slice(1);
    let sub;
    if (status === 'completed') sub = fmtDuration(duration);
    else if (mine) sub = status === 'declined' ? 'Declined' : 'No answer';
    else sub = 'Tap to call back';
    return { title, sub, missed };
  }

  const emit = (event, payload) => new Promise((resolve, reject) => {
    state.socket.emit(event, payload, (res) => (res && res.ok ? resolve(res) : reject(new Error(res?.error || 'Request failed'))));
  });

  // ---------- auth ----------

  let authMode = 'login';
  function setAuthMode(mode) {
    authMode = mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
    document.querySelectorAll('.register-only').forEach((n) => n.classList.toggle('hidden', mode !== 'register'));
    $('#auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
    $('#auth-form [name=password]').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('#auth-error').textContent = '';
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const body = Object.fromEntries(form.entries());
    $('#auth-submit').disabled = true;
    try {
      const res = await fetch(`/api/${authMode === 'login' ? 'login' : 'register'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      storage.set('chat.token', data.token);
      e.target.reset();
      start(data.token, data.user);
    } catch (err) {
      $('#auth-error').textContent = err.message;
    } finally {
      $('#auth-submit').disabled = false;
    }
  });

  function showAuth() {
    $('#app').classList.add('hidden');
    $('#auth').classList.remove('hidden');
  }

  async function logout() {
    if (state.token) fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } }).catch(() => {});
    storage.del('chat.token');
    state.calls?.dispose();
    state.socket?.disconnect();
    Object.assign(state, { token: null, me: null, socket: null, activeId: null, calls: null });
    state.conversations.clear();
    state.messages.clear();
    state.users = {};
    showAuth();
  }

  // ---------- startup ----------

  function start(token, user) {
    state.token = token;
    state.me = user || null;
    const socket = io({ auth: { token } });
    state.socket = socket;
    state.calls = window.createCallController({
      socket,
      emit,
      iceServers: () => state.iceServers,
      displayName,
      paintAvatar,
    });

    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') {
        socket.disconnect();
        storage.del('chat.token');
        showAuth();
      }
    });

    socket.on('connect', async () => {
      try {
        const { user: me, iceServers } = await emit('me');
        state.me = me;
        state.iceServers = iceServers || [];
        state.users[me.username] = { ...me, online: true };
        $('#auth').classList.add('hidden');
        $('#app').classList.remove('hidden');
        paintAvatar($('#btn-profile'), me.displayName, me.username);
        await loadConversations();
        // Refresh the open chat after a reconnect.
        if (state.activeId) openChat(state.activeId);
      } catch (err) {
        console.error(err);
      }
    });

    socket.on('message:new', ({ message }) => onMessage(message));
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
      state.users[user.username] = { ...(state.users[user.username] || {}), ...user };
      renderChatList();
      renderHeader();
      if (state.activeId) renderMessages();
    });
    socket.on('typing', ({ convId, username, isTyping }) => {
      if (!state.typing.has(convId)) state.typing.set(convId, new Map());
      const map = state.typing.get(convId);
      clearTimeout(map.get(username));
      if (isTyping) map.set(username, setTimeout(() => { map.delete(username); refreshTyping(convId); }, 5000));
      else map.delete(username);
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

  function typingText(convId) {
    const names = [...(state.typing.get(convId)?.keys() || [])];
    if (!names.length) return '';
    const conv = state.conversations.get(convId);
    if (conv?.type === 'direct') return 'typing…';
    return names.length === 1 ? `${displayName(names[0])} is typing…` : `${names.length} people are typing…`;
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
      .filter((c) => c.type === 'group' || c.lastMessage || c.id === state.activeId)
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
      top.appendChild(el('span', 'time', c.lastMessage ? listTime(c.lastMessage.ts) : ''));
      body.appendChild(top);

      const bottom = el('div', 'row');
      const typing = typingText(c.id);
      const preview = el('span', 'preview' + (typing ? ' typing' : ''));
      if (typing) {
        preview.textContent = typing;
      } else if (c.lastMessage?.type === 'call') {
        const { title, sub, missed } = describeCall(c.lastMessage);
        preview.appendChild(callGlyph(c.lastMessage.call.kind, 'call-glyph' + (missed ? ' missed' : '')));
        preview.appendChild(document.createTextNode(`${title}${c.lastMessage.call.status === 'completed' ? ` · ${sub}` : ''}`));
      } else if (c.lastMessage) {
        const m = c.lastMessage;
        const mine = m.from === state.me.username;
        if (mine && !m.deleted) preview.appendChild(ticks(statusOf(m, c)));
        let prefix = '';
        if (c.type === 'group') prefix = mine ? 'You: ' : `${displayName(m.from)}: `;
        preview.appendChild(document.createTextNode(
          (mine && !m.deleted ? ' ' : '') + (m.deleted ? '🚫 This message was deleted' : prefix + m.text),
        ));
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

  async function openChat(id) {
    const conv = state.conversations.get(id);
    if (!conv) return;
    state.activeId = id;
    $('#empty-state').classList.add('hidden');
    $('#chat-view').classList.remove('hidden');
    $('#app').classList.add('chat-open');
    $('#emoji-picker').classList.add('hidden');
    renderHeader();
    renderChatList();
    try {
      const { messages } = await emit('messages:get', { convId: id });
      if (state.activeId !== id) return;
      state.messages.set(id, messages);
      renderMessages(true);
      markRead(id);
    } catch (err) {
      console.error(err);
    }
    $('#message-input').focus();
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
    if (!conv || document.hidden) return;
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
    $('#call-buttons').classList.toggle('hidden', conv.type !== 'direct');
    const status = $('#chat-status');
    const typing = typingText(conv.id);
    status.classList.toggle('typing', !!typing);
    if (typing) status.textContent = typing;
    else if (conv.type === 'group') {
      status.textContent = conv.members
        .map((m) => (m === state.me.username ? 'You' : displayName(m)))
        .sort((a, b) => (a === 'You') - (b === 'You'))
        .join(', ');
    } else status.textContent = lastSeenText(peer);
  }

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
      const bubble = el('div', `msg${mine ? ' out' : ''}${first ? ' first' : ''}${m.deleted ? ' deleted' : ''}`);
      if (conv.type === 'group' && !mine && first) {
        const author = el('div', 'author', displayName(m.from));
        author.style.color = colorFor(m.from);
        bubble.appendChild(author);
      }
      bubble.appendChild(el('span', 'text', m.deleted ? '🚫 This message was deleted' : m.text));
      const meta = el('span', 'meta', timeOf(m.ts));
      if (mine && !m.deleted) meta.appendChild(ticks(statusOf(m, conv)));
      bubble.appendChild(meta);
      if (mine && !m.deleted) {
        const del = el('button', 'del', '✕');
        del.title = 'Delete message';
        del.addEventListener('click', () => {
          if (confirm('Delete this message for everyone?')) emit('message:delete', { id: m.id }).catch((e) => alert(e.message));
        });
        bubble.appendChild(del);
      }
      box.appendChild(bubble);
      prev = m;
    }
    if (scrollToEnd || nearBottom) box.scrollTop = box.scrollHeight;
  }

  function callBubble(m, conv, mine, first) {
    const { title, sub, missed } = describeCall(m);
    const bubble = el('div', `msg call-entry${mine ? ' out' : ''}${first ? ' first' : ''}${missed ? ' missed' : ''}`);
    bubble.title = 'Call again';
    const row = el('div', 'call-row');
    const icon = el('div', 'call-icon');
    icon.appendChild(callGlyph(m.call.kind));
    row.appendChild(icon);
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
    if (!conv || conv.type !== 'direct' || !state.calls) return;
    state.calls.start(conv.id, convPeer(conv), kind);
  }
  $('#btn-voice-call').addEventListener('click', () => startCall('audio'));
  $('#btn-video-call').addEventListener('click', () => startCall('video'));

  function onMessage(msg) {
    const conv = state.conversations.get(msg.convId);
    if (!conv) {
      // Conversation we don't know about yet; reload list.
      loadConversations();
      return;
    }
    const list = state.messages.get(msg.convId);
    if (list && !list.some((m) => m.id === msg.id)) list.push(msg);
    conv.lastMessage = msg;
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
      clearTimeout(typingMap.get(msg.from));
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

  input.addEventListener('input', () => {
    autosize();
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
    $('#emoji-picker').classList.add('hidden');
    try {
      await emit('message:send', { convId: state.activeId, text });
    } catch (err) {
      alert(err.message);
      input.value = text;
    }
  });

  // emoji picker
  const picker = $('#emoji-picker');
  for (const em of EMOJIS) {
    const b = el('button', '', em);
    b.type = 'button';
    b.addEventListener('click', () => {
      const { selectionStart: s, selectionEnd: t, value } = input;
      input.value = value.slice(0, s) + em + value.slice(t);
      input.selectionStart = input.selectionEnd = s + em.length;
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

  // Keep "last seen" labels fresh.
  setInterval(() => { if (state.activeId) renderHeader(); }, 60_000);

  // ---------- boot ----------
  const saved = storage.get('chat.token');
  if (saved) start(saved);
  else showAuth();
})();
