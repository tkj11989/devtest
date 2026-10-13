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
    voiceUrls: new Map(), // mediaId -> object URL of downloaded voice audio
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
    state.outbox.clear();
    state.revealed.clear();
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
        const { user: me, iceServers, blocked } = await emit('me');
        state.me = me;
        state.iceServers = iceServers || [];
        state.blocked = new Set(blocked || []);
        setOffline(false);
        state.users[me.username] = { ...me, online: true };
        $('#auth').classList.add('hidden');
        $('#app').classList.remove('hidden');
        paintAvatar($('#btn-profile'), me.displayName, me.username);
        await loadConversations();
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
      state.users[user.username] = { ...(state.users[user.username] || {}), ...user };
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
      } else if (c.lastMessage?.type === 'call') {
        const d = describeCall(c.lastMessage);
        preview.append(icon(d.icon), `${d.title}${c.lastMessage.call.status === 'completed' && !d.missed ? ` · ${d.sub}` : ''}`);
      } else if (c.lastMessage) {
        const m = c.lastMessage;
        const mine = m.from === state.me.username;
        let prefix = '';
        if (c.type === 'group') prefix = mine ? 'You: ' : `${displayName(m.from)}: `;
        let text;
        if (m.deleted) {
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
      console.error(err);
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
    const group = conv.type === 'group';
    const blocked = !group && state.blocked.has(peer);
    $('#call-buttons').classList.toggle('hidden', blocked);
    $('#btn-voice-call').classList.toggle('hidden', group);
    $('#btn-group-call').classList.toggle('hidden', !group);
    $('#chat-menu').parentElement.classList.toggle('hidden', group);
    $('#menu-block span').textContent = blocked ? 'Unblock contact' : 'Block contact';

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
    $('#composer').classList.toggle('hidden', blocked || !!state.recorder);
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
      const status = mine && !m.deleted ? statusOf(m, conv) : null;
      const covered = m.masked && !m.deleted && !mine && !state.revealed.has(m.id);
      const bubble = el('div', `msg${mine ? ' out' : ''}${first ? ' first' : ''}${m.deleted ? ' deleted' : ''}${status === 'failed' ? ' failed' : ''}${m.type === 'voice' && !m.deleted ? ' voice' : ''}`);
      bubble.dataset.id = m.id;
      if (conv.type === 'group' && !mine && first) {
        const author = el('div', 'author', displayName(m.from));
        author.style.color = colorFor(m.from);
        bubble.appendChild(author);
      }
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

  async function voiceUrl(m) {
    if (m.localUrl) return m.localUrl;
    const id = m.voice.mediaId;
    if (!state.voiceUrls.has(id)) {
      const res = await fetch(`/media/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${state.token}` } });
      if (!res.ok) throw new Error('Could not load the voice message');
      state.voiceUrls.set(id, URL.createObjectURL(await res.blob()));
    }
    return state.voiceUrls.get(id);
  }

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
          m.type === 'voice' ? `🎤 Voice message (${fmtDuration(m.voice.duration)})` : m.masked ? 'Masked message' : m.text,
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
