/*
 * A copy of each chat on this device, so opening a chat shows it straight away and only the newest messages
 * are fetched again. Kept in IndexedDB, one database per account, and cleared on log out.
 *
 * What is stored: the messages as the server sent them. For end-to-end encrypted messages that is the
 * encrypted envelope only (the readable text is not saved; the app decrypts it again with this device's key).
 * Not stored: chats that are locked, hidden or have disappearing messages, voice-note audio, and messages that have not been sent yet.
 */
(function () {
  'use strict';

  const MAX_PER_CHAT = 1000; // oldest are dropped beyond this
  const available = typeof indexedDB !== 'undefined';

  /** A copy that is safe to keep: no readable text for encrypted messages, no local-only fields. */
  function clean(m) {
    const c = JSON.parse(JSON.stringify(m));
    delete c.localStatus;
    delete c.undecryptable;
    delete c.encrypted;
    if (c.e2ee && !c.deleted) c.text = '';
    return c;
  }

  const wrap = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  function open(username) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(`vartiq-chats:${username}`, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('msgs', { keyPath: ['c', 'ts', 'id'] });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const range = (convId, from = 0) => IDBKeyRange.bound([convId, from, ''], [convId, Number.MAX_SAFE_INTEGER, '￿']);

  /** The cache for one account. Every method resolves (to an empty result) even if the browser refuses storage. */
  function create(username) {
    let dbp = null;
    const db = () => {
      if (!available) return Promise.reject(new Error('no storage'));
      dbp ||= open(username);
      return dbp;
    };
    const safe = (fn, fallback) => async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        console.warn('Chat cache:', err.message);
        return fallback;
      }
    };

    return {
      available,

      /** The newest `limit` cached messages of a chat, oldest first. */
      load: safe(async (convId, limit = 300, before = Infinity) => {
        const d = await db();
        const out = [];
        await new Promise((resolve, reject) => {
          const upper = Number.isFinite(before) ? [convId, before - 1, '￿'] : [convId, Number.MAX_SAFE_INTEGER, '￿'];
          const req = d.transaction('msgs').objectStore('msgs').openCursor(IDBKeyRange.bound([convId, 0, ''], upper), 'prev');
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur || out.length >= limit) return resolve();
            out.push(cur.value.m);
            cur.continue();
            return undefined;
          };
          req.onerror = () => reject(req.error);
        });
        return out.reverse();
      }, []),

      /**
       * Save `messages` (oldest first) as the current state of that part of the chat: they are added or updated, and any
       * cached message newer than the first of them that is no longer in the list (deleted, expired) is removed.
       */
      save: safe(async (convId, messages) => {
        const list = messages.filter((m) => !m.localStatus && m.id && m.ts);
        if (!list.length) return;
        const d = await db();
        const tx = d.transaction('msgs', 'readwrite');
        const store = tx.objectStore('msgs');
        const keep = new Set(list.map((m) => m.id));
        const existing = await wrap(store.getAll(range(convId, list[0].ts)));
        for (const rec of existing) if (!keep.has(rec.id)) store.delete([rec.c, rec.ts, rec.id]);
        for (const m of list) store.put({ c: convId, ts: m.ts, id: m.id, m: clean(m) });
        await done(tx);
        const count = await wrap(d.transaction('msgs').objectStore('msgs').count(range(convId)));
        if (count > MAX_PER_CHAT) {
          const tx2 = d.transaction('msgs', 'readwrite');
          const keys = await wrap(tx2.objectStore('msgs').getAllKeys(range(convId)));
          for (const k of keys.slice(0, count - MAX_PER_CHAT)) tx2.objectStore('msgs').delete(k);
          await done(tx2);
        }
      }, undefined),

      /** Forget everything cached for one chat (it became locked or hidden, or got a disappearing-message timer). */
      purge: safe(async (convId) => {
        const d = await db();
        const tx = d.transaction('msgs', 'readwrite');
        tx.objectStore('msgs').delete(range(convId));
        await done(tx);
      }, undefined),

      /** Forget everything for this account (log out, or the person asked). */
      clear: safe(async () => {
        if (dbp) (await dbp).close();
        dbp = null;
        await new Promise((resolve) => {
          const req = indexedDB.deleteDatabase(`vartiq-chats:${username}`);
          req.onsuccess = resolve;
          req.onerror = resolve;
          req.onblocked = resolve;
        });
      }, undefined),

      /** How many messages are saved. */
      count: safe(async () => {
        const d = await db();
        return wrap(d.transaction('msgs').objectStore('msgs').count());
      }, 0),
    };
  }

  window.ChatCache = { create, available };
}());
