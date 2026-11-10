/*
 * Photos, videos and documents in chats: choosing a file, making it small enough (photos are resized), a preview picture, and
 * showing a received file in the chat (a picture in place, a video that plays on tap, a document card that saves on tap).
 * Files in an end-to-end encrypted chat are encrypted on the device before upload and decrypted here after download.
 */
window.createAttachments = function createAttachments(options) {
  'use strict';

  const { token, appSession, decrypt, limits, toast } = options;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // What may be sent (the server checks again).
  const IMAGE = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const VIDEO = ['video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp'];
  const FILE_BY_EXT = {
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', rtf: 'application/rtf', zip: 'application/zip',
    doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  };
  const FILE_MIMES = new Set(Object.values(FILE_BY_EXT));
  const BLOCKED = /\.(exe|msi|bat|cmd|com|scr|pif|js|mjs|vbs|vbe|wsf|jar|apk|sh|ps1|dll|lnk|reg|html?|xhtml|svg|swf)$/i;
  const ACCEPT = [...IMAGE, ...VIDEO, ...Object.keys(FILE_BY_EXT).map((e) => `.${e}`)].join(',');
  const MAX_SIDE = 1600;
  const KEEP_ORIGINAL_BYTES = 1.2 * 1024 * 1024;

  const sizeLabel = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const durationLabel = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  const urls = new Map(); // mediaId -> object URL of the downloaded (and decrypted) file
  const loading = new Map(); // mediaId -> promise

  function mimeOf(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const type = String(file.type || '').toLowerCase();
    if (IMAGE.includes(type) || VIDEO.includes(type) || FILE_MIMES.has(type)) return type;
    return FILE_BY_EXT[ext] || type;
  }

  function kindOf(mime) {
    if (IMAGE.includes(mime)) return 'image';
    if (VIDEO.includes(mime)) return 'video';
    if (FILE_MIMES.has(mime)) return 'file';
    return null;
  }

  const loadImage = (blob) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture could not be read')); };
    img.src = url;
  });

  const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

  /** A small JPEG preview (a data URL under 24,000 characters), or null. */
  async function thumbnail(source, w, h) {
    for (const [side, q] of [[160, 0.55], [128, 0.5], [96, 0.45]]) {
      const scale = Math.min(1, side / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', q);
      if (url.length <= 24000) return url;
    }
    return null;
  }

  async function prepareImage(file, mime) {
    const img = await loadImage(file);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const thumb = await thumbnail(img, w, h);
    // A large picture is resized and saved as JPEG (a phone photo is often 5 MB or more); small ones and GIFs are sent as they are.
    if (mime === 'image/gif' || (file.size <= KEEP_ORIGINAL_BYTES && Math.max(w, h) <= MAX_SIDE * 1.5)) {
      return { mime, blob: file, w, h, thumb };
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; // a transparent picture becomes white instead of black
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const blob = await toBlob(c, 'image/jpeg', 0.82);
    if (!blob) return { mime, blob: file, w, h, thumb };
    return { mime: 'image/jpeg', blob, w: c.width, h: c.height, thumb };
  }

  function prepareVideo(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      const done = (extra) => { URL.revokeObjectURL(url); resolve(extra); };
      v.onerror = () => done({});
      v.onloadedmetadata = () => {
        const info = { w: v.videoWidth || undefined, h: v.videoHeight || undefined, duration: Number.isFinite(v.duration) ? Math.round(v.duration) : undefined };
        // The first picture as the preview; some formats cannot be drawn, then there is none.
        v.onseeked = async () => {
          try { info.thumb = await thumbnail(v, v.videoWidth, v.videoHeight); } catch { /* no preview */ }
          done(info);
        };
        try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); } catch { done(info); }
      };
      v.src = url;
      setTimeout(() => done({}), 8000);
    });
  }

  /**
   * Check and prepare a file chosen by the person. Returns { kind, mime, blob, name, size, w, h, duration, thumb }
   * or throws an Error with a message to show.
   */
  async function prepare(file) {
    const mime = mimeOf(file);
    const kind = kindOf(mime);
    if (!kind) throw new Error('That kind of file cannot be sent. Photos, videos and documents (PDF, Word, Excel, text and similar) can.');
    if (kind === 'file' && BLOCKED.test(file.name)) throw new Error('Programs and web pages cannot be sent as documents.');
    const lim = limits();
    const max = { image: lim?.imageMB, video: lim?.videoMB, file: lim?.fileMB }[kind];
    let info = { kind, mime, blob: file, name: file.name || kind, w: undefined, h: undefined, duration: undefined, thumb: null };
    if (kind === 'image') Object.assign(info, await prepareImage(file, mime));
    else if (kind === 'video') Object.assign(info, await prepareVideo(file));
    info.size = info.blob.size;
    if (max && info.size > max * 1024 * 1024) {
      throw new Error(`That ${kind === 'file' ? 'document' : kind} is ${sizeLabel(info.size)}; the limit is ${max} MB.`);
    }
    if (kind === 'image' && info.mime === 'image/jpeg' && !/\.jpe?g$/i.test(info.name)) info.name = info.name.replace(/\.[^.]*$/, '') + '.jpg';
    return info;
  }

  // ---------- showing a file in the chat ----------

  async function fetchFile(m) {
    const id = m.media.mediaId;
    if (urls.has(id)) return urls.get(id);
    if (!loading.has(id)) {
      loading.set(id, (async () => {
        const res = await fetch(`/media/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token()}`, 'X-App-Session': appSession } });
        if (!res.ok) throw new Error(res.status === 423 ? 'Unlock the chat to open this file' : res.status === 404 ? 'This file is no longer available' : 'Could not load the file');
        let blob;
        if (m.e2ee) {
          const { media } = await decrypt(m, new Uint8Array(await res.arrayBuffer()));
          blob = new Blob([media], { type: m.media.mime || 'application/octet-stream' });
        } else {
          blob = await res.blob();
        }
        const url = URL.createObjectURL(blob);
        urls.set(id, url);
        return url;
      })().finally(() => loading.delete(id)));
    }
    return loading.get(id);
  }

  const localOrFetch = (m) => (m.media.localUrl ? Promise.resolve(m.media.localUrl) : fetchFile(m));

  /** A full-screen look at a picture or video. */
  function viewer(m) {
    const wrap = el('div', 'media-viewer');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', m.media.name || 'Photo');
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    const x = el('button', 'media-viewer-close', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    const body = el('div', 'media-viewer-body', 'Loading…');
    wrap.append(x, body);
    document.body.appendChild(wrap);
    localOrFetch(m).then((url) => {
      body.textContent = '';
      const node = m.media.kind === 'video' ? el('video') : el('img');
      if (m.media.kind === 'video') Object.assign(node, { controls: true, autoplay: true, playsInline: true });
      else node.alt = m.media.name || 'Photo';
      node.src = url;
      body.appendChild(node);
    }).catch((err) => { body.textContent = err.message; });
  }

  /** Save a file to the device under its own name (never opened by the page). */
  async function save(m) {
    try {
      const url = await localOrFetch(m);
      const a = el('a');
      a.href = url;
      a.download = m.media.name || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) { toast(err.message); }
  }

  function badge(m) {
    return m.media.kind === 'video' ? `▶ ${m.media.duration ? durationLabel(m.media.duration) : 'Video'}` : '';
  }

  /** The picture or video part of a bubble: the preview at once, the real picture loaded in the background. */
  function visual(m, onLoaded) {
    const box = el('button', 'media-visual');
    box.type = 'button';
    box.setAttribute('aria-label', m.media.kind === 'video' ? 'Play video' : 'Open photo');
    const { w, h } = m.media;
    if (w && h) box.style.aspectRatio = `${w} / ${h}`;
    const img = el('img');
    img.alt = m.media.name || (m.media.kind === 'video' ? 'Video' : 'Photo');
    img.decoding = 'async';
    if (m.media.localUrl && m.media.kind === 'image') img.src = m.media.localUrl;
    else if (m.media.thumb) { img.src = m.media.thumb; img.classList.add('blur'); }
    box.appendChild(img);
    if (m.media.kind === 'video') box.appendChild(el('span', 'media-badge', badge(m)));
    if (m.localStatus === 'sending') box.appendChild(el('span', 'media-uploading', 'Sending…'));
    box.addEventListener('click', () => viewer(m));
    // Photos are fetched in the background so they show sharp; videos only when tapped.
    if (m.media.kind === 'image' && !m.media.localUrl && !m.deleted) {
      const load = () => fetchFile(m).then((url) => { img.src = url; img.classList.remove('blur'); onLoaded?.(); }).catch(() => {});
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { io.disconnect(); load(); } });
        io.observe(box);
      } else load();
    }
    return box;
  }

  function fileCard(m) {
    const card = el('button', 'media-file');
    card.type = 'button';
    card.setAttribute('aria-label', `Save ${m.media.name || 'document'}`);
    const ext = ((m.media.name || '').split('.').pop() || 'file').slice(0, 4).toUpperCase();
    const info = el('span', 'media-file-info');
    info.append(el('strong', '', m.media.name || 'Document'), el('small', '', `${ext} · ${sizeLabel(m.media.size || 0)}${m.localStatus === 'sending' ? ' · sending…' : ''}`));
    card.append(el('span', 'media-file-icon', ext), info);
    card.addEventListener('click', () => save(m));
    return card;
  }

  /** The attachment part of a message bubble (the caption is added by the caller). */
  function view(m) {
    return m.media.kind === 'file' ? fileCard(m) : visual(m);
  }

  /** What to show in the chat list instead of the message text. */
  function preview(m) {
    const k = m.media?.kind;
    const label = k === 'image' ? '📷 Photo' : k === 'video' ? '🎥 Video' : `📄 ${m.media?.name || 'Document'}`;
    return m.text ? `${label} ${m.text}` : label;
  }

  /** The file of a message as a Blob (downloaded and decrypted if needed), to send it on to another chat. */
  async function blobOf(m) {
    const url = await localOrFetch(m);
    return (await fetch(url)).blob();
  }

  function reset() {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls.clear();
  }

  return { ACCEPT, prepare, view, preview, blobOf, reset, sizeLabel };
};
