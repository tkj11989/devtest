/*
 * Chat backup and new-phone history.
 *
 * Old encrypted messages stay on the server as ciphertext, but only the devices that existed when they were sent can open
 * them. A backup is ONE small file holding the content key of each message, locked in this app with a recovery key that only
 * the person has (the server cannot open it). On a new phone, the recovery key unlocks the file and the phone can then read
 * the history the server still keeps. Media (photos, voice notes) open the same way.
 */
window.createBackupController = function createBackupController(o) {
  'use strict';

  const { E2EE, emit, getE2ee, token, appSession, username, conversations, toast, dialog, openPanel, reloadChats, clearCache } = o;
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const KEY = () => `backupkey:${username()}`;
  const AUTO_MS = 24 * 3600 * 1000;
  const state = { info: null, busy: false, progress: '' };

  const headers = () => ({ Authorization: `Bearer ${token()}`, 'X-App-Session': appSession });

  async function status() {
    const res = await emit('backup:status', {});
    state.info = res.backup;
    state.max = res.maxBytes;
    return res.backup;
  }

  const savedKey = async () => (await getE2ee().store.get(KEY()))?.key || null;

  /** Every content key this device can produce: from the server's messages and from an earlier restore. */
  async function collect(progress) {
    const e = getE2ee();
    const keys = {};
    let seen = 0;
    const chats = [...conversations().values()].filter((c) => !c.hidden && !(c.locked && !c.unlocked));
    let i = 0;
    for (const conv of chats) {
      i++;
      let before;
      for (let page = 0; page < 500; page++) {
        let res;
        try { res = await emit('messages:get', { convId: conv.id, before, limit: 100 }); } catch { break; } // locked or gone: skipped
        for (const m of res.messages) {
          if (!m.e2ee) continue;
          const k = await e.contentKey(m);
          if (k) { keys[m.id] = k; seen++; }
        }
        progress?.(`Chat ${i} of ${chats.length} · ${seen} messages`);
        if (!res.hasMore || !res.nextBefore) break;
        before = res.nextBefore;
      }
    }
    return { keys, seen };
  }

  async function backupNow({ silent = false } = {}) {
    if (state.busy) return;
    const key = await savedKey();
    if (!key) return silent ? undefined : toast('Turn on chat backup first');
    state.busy = true;
    const progress = (t) => { state.progress = t; render(); };
    try {
      const { keys, seen } = await collect(progress);
      // Keys restored earlier from a backup (for messages this device cannot open itself) stay in.
      const count = Object.keys(keys).length;
      const bytes = await E2EE.lockBackup(key, { v: 1, at: Date.now(), keys });
      const res = await fetch('/api/v1/backup/file', { method: 'PUT', headers: { ...headers(), 'Content-Type': 'application/octet-stream', 'X-Backup-Messages': String(count), 'X-Backup-Device': (navigator.userAgentData?.platform || navigator.platform || 'This device').slice(0, 40) }, body: bytes });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message || 'The backup could not be saved');
      state.info = body.backup;
      if (!silent) toast(`Backed up ${seen} messages`);
    } catch (err) {
      if (!silent) toast(err.message);
    } finally {
      state.busy = false;
      state.progress = '';
      render();
    }
  }

  /** The recovery key is shown once: copy it, save it as a file, and say it is safe. */
  function showNewKey(recovery) {
    return new Promise((resolve) => {
      dialog({
        title: 'Your recovery key',
        text: `${recovery.text}\n\nWrite it down or save it somewhere safe, like a password manager. Without it nobody, not even VartiQ, can restore your old messages on a new phone. Anyone who has this key and your login can read your old messages, so do not share it.`,
        submit: 'I saved it. Turn on backup',
        fields: [
          { name: 'action', label: 'Before you continue', options: [['copy', 'Copy the key'], ['file', 'Save it as a text file'], ['none', 'I have already written it down']], value: 'copy' },
          { name: 'saved', label: 'I have saved my recovery key', type: 'checkbox', required: true },
        ],
        async onSubmit(v) {
          if (v.action === 'copy') { try { await navigator.clipboard.writeText(recovery.text); } catch { /* shown in the dialog */ } }
          if (v.action === 'file') {
            const a = el('a');
            a.href = URL.createObjectURL(new Blob([`VartiQ recovery key\n${recovery.text}\n`], { type: 'text/plain' }));
            a.download = 'vartiq-recovery-key.txt';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          }
          resolve(true);
        },
      }).then((r) => { if (r === null) resolve(false); });
    });
  }

  async function enable() {
    if (!getE2ee()?.ready) return toast('Encryption is not available in this browser');
    const recovery = E2EE.newRecoveryKey();
    if (!await showNewKey(recovery)) return;
    const key = await E2EE.backupKeyFrom(recovery.bytes);
    await getE2ee().store.put(KEY(), { key, at: Date.now() });
    await backupNow();
    render();
  }

  async function disable() {
    if (!confirm('Turn off backup and delete the backup file from the server? Messages already on this phone stay. A new phone could then not read your old messages.')) return;
    try {
      await emit('backup:delete', {});
      await getE2ee().store.put(KEY(), null);
      state.info = null;
      toast('Backup turned off and deleted');
    } catch (err) { toast(err.message); }
    render();
  }

  /** On a new phone: type the recovery key, download the file, unlock it and keep the keys on this device. */
  async function restore() {
    if (!getE2ee()?.ready) return toast('Encryption is not available in this browser');
    return dialog({
      title: 'Restore your old messages',
      text: 'Type the recovery key you saved when you turned on backup (13 groups of 4 letters and digits).',
      submit: 'Restore',
      fields: [{ name: 'key', label: 'Recovery key', type: 'text', maxLength: 80, autocomplete: 'off' }],
      async onSubmit(v) {
        const bytes = E2EE.parseRecoveryKey(v.key);
        const res = await fetch('/api/v1/backup/file', { headers: headers() });
        if (res.status === 404) throw new Error('There is no backup for this account');
        if (!res.ok) throw new Error('The backup could not be downloaded');
        const key = await E2EE.backupKeyFrom(bytes);
        const content = await E2EE.unlockBackup(key, await res.arrayBuffer());
        const total = await getE2ee().addRestored(content.keys);
        await getE2ee().store.put(KEY(), { key, at: Date.now() }); // this phone now keeps the backup up to date
        await clearCache?.();
        await reloadChats();
        await status().catch(() => {});
        render();
        toast(`Restored ${Object.keys(content.keys).length} messages (${total} in all)`);
        hideBanner();
      },
    });
  }

  /** Back up by itself once a day, if it is on and the app is open. */
  async function auto() {
    try {
      if (!await savedKey()) return;
      const info = await status();
      if (!info || Date.now() - info.at > AUTO_MS) await backupNow({ silent: true });
    } catch { /* later */ }
  }

  // ----- the screen -----

  function render() {
    const box = $('#backup-body');
    if (!box) return;
    box.textContent = '';
    const info = state.info;
    box.appendChild(el('p', 'muted', 'Your messages are end-to-end encrypted, so a new phone cannot read the old ones by itself. A backup saves the keys to them in one file that only your recovery key can open. VartiQ cannot read it.'));
    const card = el('section', 'info-card');
    card.appendChild(el('div', 'info-label', 'Backup'));
    card.appendChild(el('div', '', info ? `Last backup ${new Date(info.at).toLocaleString()} · ${info.messages} messages${info.device ? ` · from ${info.device}` : ''}` : 'No backup yet'));
    if (state.progress) card.appendChild(el('div', 'muted small-note', `Backing up… ${state.progress}`));
    card.appendChild(el('div', 'muted small-note', 'Included: messages in your chats, with their photos, videos, documents and voice notes while the server still keeps them. Not included: locked and hidden chats, and messages you or others have deleted or that have timed out.'));
    box.appendChild(card);
    savedKey().then((key) => {
      const row = el('div', 'stack pad');
      const btn = (label, fn, cls = 'primary') => { const b = el('button', cls, label); b.type = 'button'; b.disabled = state.busy; b.addEventListener('click', fn); row.appendChild(b); };
      if (key) {
        btn('Back up now', () => backupNow());
        btn('Turn off and delete backup', disable, 'danger-link');
      } else {
        btn('Turn on backup', enable);
      }
      btn('Restore from a backup', restore, 'link');
      box.appendChild(row);
    });
  }

  async function open() {
    openPanel('#panel-backup');
    await status().catch(() => {});
    render();
  }

  // ----- the offer on a new phone -----

  function hideBanner() { $('#restore-banner')?.classList.add('hidden'); }

  async function offerRestore() {
    try {
      const banner = $('#restore-banner');
      if (!banner || localStorage.getItem(`chat.restoreOffer.${username()}`) === 'no') return;
      if (!getE2ee()?.ready || await savedKey() || getE2ee().restoredCount) return;
      const info = await status();
      if (!info) return;
      banner.classList.remove('hidden');
    } catch { /* no offer */ }
  }

  $('#btn-backup')?.addEventListener('click', open);
  $('#restore-open')?.addEventListener('click', restore);
  $('#restore-no')?.addEventListener('click', () => { try { localStorage.setItem(`chat.restoreOffer.${username()}`, 'no'); } catch { /* ignore */ } hideBanner(); });

  return { open, auto, offerRestore, backupNow, restore };
};
