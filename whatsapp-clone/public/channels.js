/*
 * Public channels: a list of the channels I follow, a directory to discover more, and a
 * channel screen with its posts. Owners and admins post; everyone can read and follow.
 * Channel posts are public, so they are not end-to-end encrypted.
 */
window.createChannelsController = function createChannelsController(options) {
  'use strict';

  const { emit, displayName, avatar, userBadges, toast, dialog, openPanel, mergeUsers, onShow } = options;

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const state = { tab: 'following', mine: new Map(), found: [], current: null, posts: [], users: {}, query: '' };

  const timeLabel = (ts) => {
    const d = new Date(ts);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /** Text with http(s) links made clickable (built from nodes, never as HTML). */
  function linkified(text) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      frag.append(text.slice(last, m.index));
      const url = m[0].replace(/[.,;:!?)]+$/, '');
      const a = el('a', '', url);
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      frag.appendChild(a);
      frag.append(m[0].slice(url.length));
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    return frag;
  }

  // ---------- lists ----------

  async function loadMine() {
    const res = await emit('channels:mine');
    mergeUsers(res.users);
    state.mine = new Map(res.channels.map((c) => [c.id, c]));
    renderTotals();
  }

  async function loadFound() {
    const res = await emit('channels:search', { q: state.query });
    mergeUsers(res.users);
    state.found = res.channels;
  }

  /** Unread posts across channels: shown on the sidebar button. */
  function renderTotals() {
    const n = [...state.mine.values()].reduce((sum, c) => sum + (c.unread || 0), 0);
    const badge = $('#channels-unread');
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', !n);
  }

  function row(c) {
    const li = el('li');
    li.appendChild(avatar(c.name, `ch:${c.id}`, { group: false }));
    const body = el('div', 'body');
    const top = el('div', 'row');
    top.appendChild(el('span', 'name', c.name));
    const ownerUser = state.users[c.owner] || {};
    if (ownerUser.verified) top.appendChild(userBadges({ verified: true })[0]);
    top.appendChild(el('span', 'time', c.lastPost ? timeLabel(c.lastPost.ts) : ''));
    body.appendChild(top);
    const bottom = el('div', 'row');
    bottom.appendChild(el('span', 'preview', c.lastPost ? c.lastPost.text : (c.description || `@${c.handle}`)));
    if (c.unread) bottom.appendChild(el('span', 'badge', String(c.unread)));
    else if (state.tab === 'discover') bottom.appendChild(el('span', 'muted small-note', plural(c.followers, 'follower', 'followers')));
    body.appendChild(bottom);
    li.appendChild(body);
    li.addEventListener('click', () => open(c.id));
    return li;
  }

  function renderList() {
    const list = $('#channel-list');
    list.textContent = '';
    const items = state.tab === 'following' ? [...state.mine.values()].sort((a, b) => (b.lastPost?.ts || b.createdAt) - (a.lastPost?.ts || a.createdAt)) : state.found;
    for (const c of items) list.appendChild(row(c));
    const empty = $('#channels-empty');
    empty.classList.toggle('hidden', items.length > 0);
    empty.textContent = state.tab === 'following'
      ? 'You are not following any channel yet. Open Discover to find some, or create your own.'
      : 'No channels found.';
    $('#channel-search-wrap').classList.toggle('hidden', state.tab !== 'discover');
    document.querySelectorAll('#panel-channels .chan-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  }

  async function openPanelList() {
    openPanel('#panel-channels');
    try {
      await loadMine();
      if (state.tab === 'discover') await loadFound();
    } catch (err) {
      toast(err.message);
    }
    renderList();
  }

  async function setTab(tab) {
    state.tab = tab;
    try {
      if (tab === 'discover') await loadFound();
      else await loadMine();
    } catch (err) {
      toast(err.message);
    }
    renderList();
  }

  // ---------- channel screen ----------

  const canPost = (c) => c.role === 'owner' || c.role === 'admin';

  function renderHeader() {
    const c = state.current;
    const av = $('#channel-avatar');
    av.replaceWith(Object.assign(avatar(c.name, `ch:${c.id}`), { id: 'channel-avatar' }));
    $('#channel-name').textContent = c.name;
    const ownerUser = state.users[c.owner];
    const by = ownerUser ? displayName(c.owner) : c.owner;
    $('#channel-sub').textContent = `@${c.handle} · ${plural(c.followers, 'follower', 'followers')} · by ${by}`;
    const owner = $('#channel-owner-badges');
    owner.textContent = '';
    if (ownerUser) owner.append(...userBadges(ownerUser).slice(0, 2));
    const follow = $('#channel-follow');
    follow.classList.toggle('hidden', c.role === 'owner');
    follow.textContent = c.following ? 'Following' : 'Follow';
    follow.classList.toggle('primary', !c.following);
    follow.classList.toggle('outline', c.following);
    $('#channel-composer').classList.toggle('hidden', !canPost(c));
    $('#channel-readonly').classList.toggle('hidden', canPost(c));
    $('#channel-readonly-text').textContent = c.following
      ? 'Only the owner and admins can post here. You will see new posts as they come.'
      : 'Follow this channel to get its new posts. Only the owner and admins can post.';
    $('#channel-readonly-follow').textContent = c.following ? 'Unfollow' : 'Follow';
    $('#channel-menu-edit').classList.toggle('hidden', !canPost(c));
    $('#channel-menu-admins').classList.toggle('hidden', c.role !== 'owner');
    $('#channel-menu-delete').classList.toggle('hidden', c.role !== 'owner');
    $('#channel-menu-report').classList.toggle('hidden', c.role === 'owner');
  }

  function renderPosts(scrollToEnd = true) {
    const box = $('#channel-posts');
    const c = state.current;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.textContent = '';
    box.appendChild(el('div', 'channel-public-note', 'Channels are public: posts here are visible to anyone and are not end-to-end encrypted.'));
    if (!state.posts.length) box.appendChild(el('div', 'channel-empty', canPost(c) ? 'No posts yet. Write the first one below.' : 'No posts yet.'));
    let prevDay = null;
    for (const p of state.posts) {
      const day = new Date(p.ts).toDateString();
      if (day !== prevDay) box.appendChild(el('div', 'day', new Date(p.ts).toLocaleDateString([], { dateStyle: 'medium' })));
      prevDay = day;
      const bubble = el('div', 'post');
      if (c.admins.length && p.by !== c.owner) bubble.appendChild(el('div', 'post-by', displayName(p.by)));
      bubble.appendChild(el('div', 'post-text')).appendChild(linkified(p.text));
      const meta = el('div', 'post-meta', timeLabel(p.ts));
      if (canPost(c)) {
        const del = el('button', 'link danger-link', 'Delete');
        del.type = 'button';
        del.addEventListener('click', async () => {
          if (!confirm('Delete this post for everyone?')) return;
          try {
            await emit('channel:post-delete', { id: c.id, postId: p.id });
          } catch (err) {
            toast(err.message);
          }
        });
        meta.prepend(del, ' · ');
      }
      bubble.appendChild(meta);
      box.appendChild(bubble);
    }
    if (scrollToEnd || nearBottom) box.scrollTop = box.scrollHeight;
  }

  async function open(id) {
    try {
      const [{ channel, users }, page] = await Promise.all([emit('channel:get', { id }), emit('channel:posts', { id })]);
      mergeUsers(users);
      mergeUsers(page.users);
      Object.assign(state.users, users, page.users);
      state.current = channel;
      state.posts = page.posts;
      if (channel.following) state.mine.set(channel.id, { ...channel, unread: 0 });
      renderTotals();
      onShow(true);
      $('#channel-view').classList.remove('hidden');
      renderHeader();
      renderPosts(true);
      $('#channel-more').classList.toggle('hidden', !page.hasMore);
      state.nextBefore = page.nextBefore;
      if (canPost(channel)) $('#channel-input').focus();
    } catch (err) {
      toast(err.message);
    }
  }

  function close() {
    state.current = null;
    $('#channel-view').classList.add('hidden');
    onShow(false);
  }

  /** The chat view took over the main area. */
  function hide() {
    state.current = null;
    $('#channel-view').classList.add('hidden');
  }

  // ---------- actions ----------

  async function createDialog() {
    let created;
    const ok = await dialog({
      title: 'Create a channel',
      text: 'A channel is a public feed: you and your admins post, and anyone can find and follow it. Posts are visible to everyone and are not end-to-end encrypted. The handle cannot be changed later.',
      fields: [
        { name: 'name', label: 'Channel name', type: 'text', maxLength: 60 },
        { name: 'handle', label: 'Handle (letters, numbers, _)', type: 'text', maxLength: 30 },
        { name: 'description', label: 'What is it about? (optional)', type: 'text', maxLength: 300, required: false },
        { name: 'category', label: 'Category (optional)', type: 'text', maxLength: 30, required: false },
      ],
      submit: 'Create channel',
      onSubmit: async (v) => { created = (await emit('channel:create', v)).channel; },
    });
    if (ok && created) {
      state.mine.set(created.id, created);
      await open(created.id);
    }
  }

  async function toggleFollow() {
    const c = state.current;
    if (!c) return;
    try {
      const res = await emit(c.following ? 'channel:unfollow' : 'channel:follow', { id: c.id });
      state.current = res.channel;
      if (res.channel.following) state.mine.set(c.id, res.channel);
      else state.mine.delete(c.id);
      renderHeader();
      renderTotals();
    } catch (err) {
      toast(err.message);
    }
  }

  async function post() {
    const c = state.current;
    const input = $('#channel-input');
    const text = input.value.trim();
    if (!c || !text) return;
    input.disabled = true;
    try {
      await emit('channel:post', { id: c.id, text });
      input.value = '';
    } catch (err) {
      toast(err.message);
    } finally {
      input.disabled = false;
      input.focus();
    }
  }

  async function editDialog() {
    const c = state.current;
    await dialog({
      title: 'Edit channel',
      text: `@${c.handle}`,
      fields: [
        { name: 'name', label: 'Channel name', type: 'text', maxLength: 60, value: c.name },
        { name: 'description', label: 'Description', type: 'text', maxLength: 300, value: c.description, required: false },
        { name: 'category', label: 'Category', type: 'text', maxLength: 30, value: c.category || '', required: false },
      ],
      submit: 'Save',
      onSubmit: async (v) => { state.current = (await emit('channel:update', { id: c.id, ...v })).channel; renderHeader(); },
    });
  }

  async function adminsDialog() {
    const c = state.current;
    await dialog({
      title: 'Channel admins',
      text: `Admins can post, delete posts and edit the channel. Now: ${c.admins.length ? c.admins.map((a) => `@${a}`).join(', ') : 'none'}.`,
      fields: [
        { name: 'username', label: 'Username', type: 'text', maxLength: 20 },
        { name: 'action', label: 'Action', options: [['add', 'Make admin'], ['remove', 'Remove admin']] },
      ],
      submit: 'Apply',
      onSubmit: async (v) => {
        state.current = (await emit('channel:admin', { id: c.id, username: v.username, admin: v.action === 'add' })).channel;
        renderHeader();
        renderPosts(false);
      },
    });
  }

  function infoDialog() {
    const c = state.current;
    return dialog({
      title: c.name,
      text: `${c.description || 'No description.'}\n\n@${c.handle}${c.category ? ` · ${c.category}` : ''}\n${plural(c.followers, 'follower', 'followers')} · created ${new Date(c.createdAt).toLocaleDateString([], { dateStyle: 'medium' })}\nOwner: ${displayName(c.owner)}\n\nPosts in channels are public and not end-to-end encrypted.`,
      fields: [],
      submit: 'Close',
      onSubmit: async () => {},
    });
  }

  async function reportDialog() {
    const c = state.current;
    await dialog({
      title: 'Report channel',
      text: 'Tell us what is wrong with this channel. Reports are reviewed by the people who run this service.',
      fields: [{ name: 'reason', label: 'What is wrong?', type: 'text', maxLength: 200 }],
      submit: 'Report',
      onSubmit: async (v) => { await emit('channel:report', { id: c.id, reason: v.reason }); toast('Thanks, we will take a look'); },
    });
  }

  async function deleteChannel() {
    const c = state.current;
    if (!confirm(`Delete "${c.name}" and all its posts for good? Its ${plural(c.followers, 'follower', 'followers')} will lose it.`)) return;
    try {
      await emit('channel:delete', { id: c.id });
    } catch (err) {
      toast(err.message);
    }
  }

  async function loadOlder() {
    const c = state.current;
    if (!c || !state.nextBefore) return;
    try {
      const page = await emit('channel:posts', { id: c.id, before: state.nextBefore });
      mergeUsers(page.users);
      Object.assign(state.users, page.users);
      state.posts = [...page.posts, ...state.posts];
      state.nextBefore = page.nextBefore;
      $('#channel-more').classList.toggle('hidden', !page.hasMore);
      renderPosts(false);
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- live events ----------

  function attach(socket) {
    socket.on('channel:post', ({ post, channel }) => {
      if (state.mine.has(channel.id)) state.mine.set(channel.id, channel);
      if (state.current?.id === channel.id) {
        if (!state.posts.some((p) => p.id === post.id)) state.posts.push(post);
        state.current = channel;
        emit('channel:read', { id: channel.id }).catch(() => {});
        state.mine.set(channel.id, { ...channel, unread: 0 });
        renderPosts(true);
      }
      renderTotals();
      if (!$('#panel-channels').classList.contains('hidden')) renderList();
    });
    socket.on('channel:post-deleted', ({ channelId, postId, channel }) => {
      if (state.mine.has(channelId)) state.mine.set(channelId, channel);
      if (state.current?.id === channelId) {
        state.posts = state.posts.filter((p) => p.id !== postId);
        state.current = channel;
        renderPosts(false);
      }
      renderTotals();
    });
    socket.on('channel:updated', ({ channel }) => {
      if (channel.following) state.mine.set(channel.id, channel);
      else state.mine.delete(channel.id);
      if (state.current?.id === channel.id) {
        state.current = channel;
        renderHeader();
      }
      renderTotals();
      if (!$('#panel-channels').classList.contains('hidden') && state.tab === 'following') renderList();
    });
    socket.on('channel:deleted', ({ id }) => {
      state.mine.delete(id);
      if (state.current?.id === id) {
        close();
        toast('This channel was deleted');
      }
      renderTotals();
      if (!$('#panel-channels').classList.contains('hidden')) renderList();
    });
  }

  // ---------- wiring ----------

  $('#btn-channels').addEventListener('click', openPanelList);
  $('#btn-channel-create').addEventListener('click', createDialog);
  document.querySelectorAll('#panel-channels .chan-tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  let searchTimer;
  $('#channel-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.query = e.target.value;
      await loadFound().catch((err) => toast(err.message));
      renderList();
    }, 250);
  });
  $('#btn-channel-back').addEventListener('click', close);
  $('#channel-follow').addEventListener('click', toggleFollow);
  $('#channel-readonly-follow').addEventListener('click', toggleFollow);
  $('#channel-composer').addEventListener('submit', (e) => { e.preventDefault(); post(); });
  $('#channel-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post(); }
  });
  $('#channel-more').addEventListener('click', loadOlder);
  $('#btn-channel-menu').addEventListener('click', (e) => { e.stopPropagation(); $('#channel-menu').classList.toggle('hidden'); });
  document.addEventListener('click', () => $('#channel-menu').classList.add('hidden'));
  $('#channel-menu-info').addEventListener('click', infoDialog);
  $('#channel-menu-edit').addEventListener('click', editDialog);
  $('#channel-menu-admins').addEventListener('click', adminsDialog);
  $('#channel-menu-report').addEventListener('click', reportDialog);
  $('#channel-menu-delete').addEventListener('click', deleteChannel);
  $('#channel-title-btn').addEventListener('click', infoDialog);

  return { attach, hide, load: () => loadMine().catch(() => {}), reset() { state.mine.clear(); state.current = null; renderTotals(); } };
};
