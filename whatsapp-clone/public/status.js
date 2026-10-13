'use strict';

/**
 * Status updates: text or photo posts that disappear after 24 hours, shown to
 * everyone you have a one-to-one chat with.
 *
 *   const status = createStatusController({ emit, me, displayName, paintAvatar, mediaUrl, toast, mergeUsers });
 *   status.attach(socket);   // after each (re)login
 *   status.load();           // after connecting
 */
window.createStatusController = function createStatusController({ emit, me, displayName, paintAvatar, mediaUrl, toast, mergeUsers }) {
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const BACKGROUNDS = ['#0670DE', '#061639', '#C24E08', '#0A72B0', '#6A4BD8', '#C2387A', '#0F7F72', '#4A5C78'];
  const TEXT_MS = 5000;
  const PHOTO_MS = 6000;
  const PHOTO_MAX_SIDE = 1600;

  const statuses = new Map(); // id -> status
  let viewer = null; // { owners: [username], o: index, i: index, elapsed, last, raf, paused: Set }

  // ---------- helpers ----------

  const myName = () => me()?.username;
  const timeOf = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  function timeAgo(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    if (sameDay(ts, Date.now())) return `Today, ${timeOf(ts)}`;
    return `Yesterday, ${timeOf(ts)}`;
  }

  /** owner -> their live statuses, oldest first */
  function byOwner() {
    const map = new Map();
    const now = Date.now();
    for (const s of [...statuses.values()].sort((a, b) => a.ts - b.ts)) {
      if (s.expiresAt <= now) continue;
      if (!map.has(s.owner)) map.set(s.owner, []);
      map.get(s.owner).push(s);
    }
    return map;
  }

  const isSeen = (s) => s.owner === myName() || !!s.viewed;

  /** Other people's updates: unseen first (newest first), then fully seen ones. */
  function ownerOrder() {
    const groups = byOwner();
    groups.delete(myName());
    const latest = (o) => groups.get(o).at(-1).ts;
    const owners = [...groups.keys()].sort((a, b) => latest(b) - latest(a));
    const recent = owners.filter((o) => groups.get(o).some((s) => !isSeen(s)));
    const viewed = owners.filter((o) => !recent.includes(o));
    return { groups, recent, viewed };
  }

  /** Avatar with a ring split into one segment per update (green = unseen). */
  function ringAvatar(username, items) {
    const wrap = el('div', 'status-ring');
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 52 52');
    const r = 24.5;
    const C = 2 * Math.PI * r;
    const n = items.length;
    const gap = n > 1 ? Math.min(4, C / n / 3) : 0;
    items.forEach((s, i) => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', 26);
      c.setAttribute('cy', 26);
      c.setAttribute('r', r);
      const seg = C / n - gap;
      c.setAttribute('stroke-dasharray', `${seg} ${C - seg}`);
      c.setAttribute('stroke-dashoffset', String(-(i * C) / n - gap / 2));
      c.setAttribute('class', isSeen(s) && s.owner !== myName() ? 'seen' : 'unseen');
      svg.appendChild(c);
    });
    const av = el('div', 'avatar');
    paintAvatar(av, displayName(username), username);
    wrap.append(svg, av);
    return wrap;
  }

  // ---------- status list panel ----------

  function renderPanel() {
    const { groups, recent, viewed } = ownerOrder();
    const mine = byOwner().get(myName()) || [];

    const myRow = $('#my-status');
    myRow.querySelector('.status-ring')?.remove();
    const ring = mine.length ? ringAvatar(myName(), mine) : (() => {
      const w = el('div', 'status-ring empty');
      const av = el('div', 'avatar');
      paintAvatar(av, displayName(myName()), myName());
      w.append(av, el('span', 'add-badge', '+'));
      return w;
    })();
    myRow.prepend(ring);
    $('#my-status-sub').textContent = mine.length
      ? `${mine.length} update${mine.length === 1 ? '' : 's'} · ${timeAgo(mine.at(-1).ts)}`
      : 'Tap to add a status update';

    const fill = (list, owners) => {
      list.textContent = '';
      for (const o of owners) {
        const items = groups.get(o);
        const li = el('li');
        li.appendChild(ringAvatar(o, items));
        const body = el('div', 'body');
        body.appendChild(el('div', 'name', displayName(o)));
        body.appendChild(el('div', 'sub', timeAgo(items.at(-1).ts)));
        li.appendChild(body);
        li.addEventListener('click', () => openViewer(o));
        list.appendChild(li);
      }
    };
    fill($('#status-recent'), recent);
    fill($('#status-viewed'), viewed);
    $('#status-recent-title').classList.toggle('hidden', !recent.length);
    $('#status-viewed-title').classList.toggle('hidden', !viewed.length);
    $('#status-empty').classList.toggle('hidden', recent.length + viewed.length > 0);
    $('#btn-status').classList.toggle('has-unseen', recent.length > 0);
  }

  $('#my-status').addEventListener('click', (e) => {
    if (e.target.closest('.status-actions')) return;
    if (byOwner().get(myName())?.length) openViewer(myName());
    else openComposer('text');
  });

  // ---------- composer ----------

  let composer = { mode: 'text', bg: BACKGROUNDS[0], file: null, url: null };
  const comp = $('#status-composer');

  function openComposer(mode, file) {
    composer = { mode, bg: BACKGROUNDS[Math.floor(Math.random() * BACKGROUNDS.length)], file: file || null, url: null };
    comp.classList.remove('hidden');
    comp.dataset.mode = mode;
    $('#status-compose-error').textContent = '';
    if (mode === 'text') {
      comp.style.background = composer.bg;
      $('#status-text-input').value = '';
      $('#status-text-input').focus();
    } else {
      comp.style.background = '#000';
      composer.url = URL.createObjectURL(file);
      $('#status-photo-preview').src = composer.url;
      $('#status-caption').value = '';
      $('#status-caption').focus();
    }
  }
  function closeComposer() {
    comp.classList.add('hidden');
    if (composer.url) URL.revokeObjectURL(composer.url);
    $('#status-photo-preview').removeAttribute('src');
  }

  /** Shrink big photos before upload (JPEG, longest side PHOTO_MAX_SIDE). */
  async function preparePhoto(file) {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file is not an image we can read'));
      i.src = composer.url;
    });
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) throw new Error('Could not prepare the photo');
    return blob.arrayBuffer();
  }

  async function post() {
    const btn = $('#btn-status-post');
    btn.disabled = true;
    try {
      let payload;
      if (composer.mode === 'text') {
        const text = $('#status-text-input').value.trim();
        if (!text) return;
        payload = { type: 'text', text, bg: composer.bg };
      } else {
        payload = { type: 'image', mime: 'image/jpeg', data: await preparePhoto(composer.file), caption: $('#status-caption').value };
      }
      const { status } = await emit('status:post', payload);
      statuses.set(status.id, status);
      closeComposer();
      renderPanel();
      toast('Status posted · visible for 24 hours');
    } catch (err) {
      $('#status-compose-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  $('#btn-status-text').addEventListener('click', () => openComposer('text'));
  $('#btn-status-photo').addEventListener('click', () => $('#status-photo-input').click());
  $('#status-photo-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) openComposer('image', file);
  });
  $('#btn-status-bg').addEventListener('click', () => {
    composer.bg = BACKGROUNDS[(BACKGROUNDS.indexOf(composer.bg) + 1) % BACKGROUNDS.length];
    comp.style.background = composer.bg;
    $('#status-text-input').focus();
  });
  $('#btn-status-cancel').addEventListener('click', closeComposer);
  $('#btn-status-post').addEventListener('click', post);
  $('#status-text-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post(); }
  });
  $('#status-caption').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); post(); }
  });

  // ---------- viewer ----------

  const sv = $('#status-viewer');

  function openViewer(owner, statusId) {
    let owners;
    if (owner === myName()) {
      owners = [owner];
    } else {
      const { recent, viewed } = ownerOrder();
      const list = recent.includes(owner) ? recent : viewed;
      owners = list.slice(list.indexOf(owner));
    }
    const items = byOwner().get(owner) || [];
    if (!items.length) return;
    let i = statusId ? items.findIndex((s) => s.id === statusId) : items.findIndex((s) => !isSeen(s));
    if (i < 0) i = 0;
    viewer = { owners, o: 0, i, paused: new Set() };
    sv.classList.remove('hidden');
    show();
  }

  function closeViewer() {
    if (!viewer) return;
    cancelAnimationFrame(viewer.raf);
    viewer = null;
    sv.classList.add('hidden');
    $('#sv-viewers').classList.add('hidden');
    $('#sv-media').removeAttribute('src');
    renderPanel();
  }

  const currentItems = () => (viewer ? byOwner().get(viewer.owners[viewer.o]) || [] : []);
  const current = () => currentItems()[viewer?.i];

  async function show() {
    const items = currentItems();
    if (!items.length) return next();
    viewer.i = Math.min(viewer.i, items.length - 1);
    const s = items[viewer.i];
    const mine = s.owner === myName();
    cancelAnimationFrame(viewer.raf);
    viewer.elapsed = 0;
    viewer.duration = s.type === 'text' ? Math.min(10000, TEXT_MS + s.text.length * 30) : PHOTO_MS;
    viewer.ready = false;

    const bars = $('#sv-bars');
    bars.textContent = '';
    items.forEach((_, k) => {
      const bar = el('div', 'sv-bar');
      const fillEl = el('div', 'sv-fill');
      fillEl.style.width = k < viewer.i ? '100%' : '0%';
      bar.appendChild(fillEl);
      bars.appendChild(bar);
    });
    paintAvatar($('#sv-avatar'), displayName(s.owner), s.owner);
    $('#sv-name').textContent = mine ? 'My status' : displayName(s.owner);
    $('#sv-time').textContent = timeAgo(s.ts);

    const text = $('#sv-text');
    const media = $('#sv-media');
    sv.dataset.type = s.type;
    sv.classList.toggle('mine', mine);
    $('#sv-caption').textContent = s.type === 'image' ? s.caption : '';
    $('#sv-caption').classList.toggle('hidden', !(s.type === 'image' && s.caption));
    if (s.type === 'text') {
      $('#sv-stage').style.background = s.bg;
      text.textContent = s.text;
      text.classList.toggle('long', s.text.length > 120);
      media.removeAttribute('src');
      viewer.ready = true;
    } else {
      $('#sv-stage').style.background = '#000';
      text.textContent = '';
      media.removeAttribute('src');
      try {
        const url = await mediaUrl(s.mediaId);
        if (!viewer || current() !== s) return;
        media.src = url;
        await media.decode().catch(() => {});
      } catch {
        if (viewer && current() === s) text.textContent = 'This photo could not be loaded';
      }
      if (!viewer || current() !== s) return;
      viewer.ready = true;
    }

    if (mine) {
      renderViews(s);
    } else if (!s.viewed) {
      s.viewed = true;
      emit('status:view', { id: s.id }).catch(() => {});
    }
    viewer.last = performance.now();
    viewer.raf = requestAnimationFrame(tick);
  }

  function tick(now) {
    if (!viewer) return;
    const dt = now - viewer.last;
    viewer.last = now;
    if (viewer.ready && !viewer.paused.size && !document.hidden) viewer.elapsed += dt;
    const fillEl = $('#sv-bars').children[viewer.i]?.firstChild;
    if (fillEl) fillEl.style.width = `${Math.min(100, (viewer.elapsed / viewer.duration) * 100)}%`;
    if (viewer.elapsed >= viewer.duration) next();
    else viewer.raf = requestAnimationFrame(tick);
  }

  function next() {
    if (!viewer) return;
    if (viewer.i + 1 < currentItems().length) {
      viewer.i += 1;
    } else if (viewer.o + 1 < viewer.owners.length) {
      viewer.o += 1;
      const items = currentItems();
      viewer.i = Math.max(0, items.findIndex((s) => !isSeen(s)));
    } else {
      return closeViewer();
    }
    show();
  }

  function prev() {
    if (!viewer) return;
    if (viewer.i > 0) viewer.i -= 1;
    else if (viewer.o > 0) {
      viewer.o -= 1;
      viewer.i = currentItems().length - 1;
    }
    show();
  }

  function renderViews(s) {
    const views = s.views || [];
    $('#sv-views-count').textContent = String(views.length);
    const list = $('#sv-viewers-list');
    list.textContent = '';
    for (const v of views) {
      const li = el('li');
      const av = el('div', 'avatar');
      paintAvatar(av, displayName(v.username), v.username);
      const body = el('div', 'body');
      body.append(el('div', 'name', displayName(v.username)), el('div', 'sub', timeAgo(v.ts)));
      li.append(av, body);
      list.appendChild(li);
    }
    $('#sv-viewers-empty').classList.toggle('hidden', views.length > 0);
  }

  const pause = (why) => viewer?.paused.add(why);
  const resume = (why) => viewer?.paused.delete(why);

  // Tap the left third to go back, elsewhere to go forward; press and hold to pause.
  let pressAt = 0;
  $('#sv-stage').addEventListener('pointerdown', () => { pressAt = Date.now(); pause('hold'); });
  $('#sv-stage').addEventListener('pointerup', (e) => {
    resume('hold');
    if (Date.now() - pressAt > 300) return; // it was a hold
    const { left, width } = e.currentTarget.getBoundingClientRect();
    if (e.clientX - left < width / 3) prev();
    else next();
  });
  $('#sv-stage').addEventListener('pointerleave', () => resume('hold'));
  $('#sv-close').addEventListener('click', closeViewer);
  document.addEventListener('keydown', (e) => {
    if (!viewer || document.activeElement === $('#sv-reply-input')) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
  });

  $('#sv-views').addEventListener('click', () => {
    pause('viewers');
    $('#sv-viewers').classList.remove('hidden');
  });
  $('#sv-viewers-close').addEventListener('click', () => {
    $('#sv-viewers').classList.add('hidden');
    resume('viewers');
  });
  $('#sv-delete').addEventListener('click', async () => {
    const s = current();
    if (!s) return;
    pause('confirm');
    if (!confirm('Delete this status update for everyone?')) return resume('confirm');
    try {
      await emit('status:delete', { id: s.id });
      statuses.delete(s.id);
      resume('confirm');
      if (!currentItems().length) closeViewer();
      else show();
    } catch (err) {
      resume('confirm');
      toast(err.message);
    }
  });

  const replyInput = $('#sv-reply-input');
  replyInput.addEventListener('focus', () => pause('reply'));
  replyInput.addEventListener('blur', () => resume('reply'));
  $('#sv-reply').addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = current();
    const text = replyInput.value.trim();
    if (!s || !text) return;
    try {
      await emit('status:reply', { id: s.id, text, clientId: `sr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` });
      replyInput.value = '';
      replyInput.blur();
      toast(`Reply sent to ${displayName(s.owner)}`);
    } catch (err) {
      toast(err.message);
    }
  });

  // ---------- data ----------

  async function load() {
    try {
      const { statuses: list, users } = await emit('statuses');
      mergeUsers(users);
      statuses.clear();
      list.forEach((s) => statuses.set(s.id, s));
      renderPanel();
    } catch (err) {
      console.error(err);
    }
  }

  function attach(socket) {
    socket.on('status:new', ({ status }) => {
      statuses.set(status.id, status);
      renderPanel();
    });
    socket.on('status:deleted', ({ id }) => {
      const showing = current()?.id === id;
      statuses.delete(id);
      renderPanel();
      if (showing) show();
    });
    socket.on('status:viewed', ({ id, username, ts }) => {
      const s = statuses.get(id);
      if (!s || s.owner !== myName()) return;
      s.views = [{ username, ts }, ...(s.views || []).filter((v) => v.username !== username)];
      if (current()?.id === id) renderViews(s);
    });
  }

  // Updates expire after 24 hours; keep the list and "x minutes ago" labels fresh.
  setInterval(() => {
    if (!statuses.size) return;
    const now = Date.now();
    for (const [id, s] of statuses) if (s.expiresAt <= now) statuses.delete(id);
    if (!viewer) renderPanel();
  }, 30000);

  return {
    attach,
    load,
    renderPanel,
    /** Open a status by id (e.g. from a reply quote); false if it is gone. */
    openById(id) {
      const s = statuses.get(id);
      if (!s || s.expiresAt <= Date.now()) return false;
      openViewer(s.owner, id);
      return true;
    },
    reset() {
      closeViewer();
      closeComposer();
      statuses.clear();
    },
  };
};
