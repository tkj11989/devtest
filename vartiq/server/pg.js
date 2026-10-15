'use strict';

/**
 * PostgreSQL persistence for the data store.
 *
 * The store keeps its working data in memory (fast, synchronous). This module saves it to
 * PostgreSQL by writing only what changed, a moment after it changed ("write-behind"), instead of
 * rewriting one big file. On start the data is read back from the database.
 *
 * How changes are noticed: the store's data is wrapped in a tracking proxy. Any assignment or
 * delete anywhere under a record (a user, a conversation, a channel...) marks that record as changed,
 * so no code that edits the data has to remember to say so. Messages and channel posts are not
 * tracked (there can be millions, and they are scanned constantly): the few places that add, remove or
 * change one say so with store._touchList() / store._touchMsg(). The test suite checks none is missed.
 *
 * Tables:
 *   docs(coll, id, data jsonb)               one row per user / conversation / channel / key / setting ...
 *   lists(coll, key, id, pos, data jsonb)    one row per message and per channel post (key = the chat or channel)
 */

const RAW = Symbol('raw');

// How each top-level part of the data is saved.
const DOC_MAPS = new Set(['users', 'archivedUsers', 'conversations', 'media', 'statuses', 'apiKeys', 'webhooks', 'channels', 'admins']); // { id: record }
const LIST_MAPS = new Set(['messages', 'channelPosts']); // { key: [records with an id] }
const SINGLES = new Set(['settings', 'reports', 'audit']); // one value each

const plain = (v) => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === Array.prototype || proto === null;
};

class Tracker {
  constructor(onChange) {
    this.onChange = onChange;
    this.cache = new WeakMap(); // raw object -> proxy
    this.reset();
  }

  reset() {
    this.docs = new Map(); // coll -> Set(id)
    this.lists = new Map(); // coll -> Map(key -> { elems: Set(raw record) })
  }

  /** Take the changes noted so far and start a new batch. */
  take() {
    const out = { docs: this.docs, lists: this.lists };
    this.reset();
    return out;
  }

  /** Put a batch back (a save failed) so it is tried again. */
  restore(batch) {
    for (const [coll, ids] of batch.docs) for (const id of ids) this.markDoc(coll, id, false);
    for (const [coll, keys] of batch.lists) for (const [key, entry] of keys) {
      const mine = this.markList(coll, key, false);
      for (const e of entry.elems) mine.elems.add(e);
    }
  }

  markDoc(coll, id, notify = true) {
    if (!this.docs.has(coll)) this.docs.set(coll, new Set());
    this.docs.get(coll).add(id);
    if (notify) this.onChange();
  }

  markList(coll, key, notify = true) {
    if (!this.lists.has(coll)) this.lists.set(coll, new Map());
    const keys = this.lists.get(coll);
    if (!keys.has(key)) keys.set(key, { elems: new Set() });
    if (notify) this.onChange();
    return keys.get(key);
  }

  markElem(coll, key, elem) {
    this.markList(coll, key, false).elems.add(elem);
    this.onChange();
  }

  /** What a change at `ctx` means for saving. `target` is the raw object that was changed. */
  touch(ctx, target, key) {
    switch (ctx.t) {
      case 'root': // data.settings = ..., data.reports = ...
        if (SINGLES.has(key)) this.markDoc('_', key);
        break;
      case 'docmap': // data.users[id] = ... / delete
        this.markDoc(ctx.coll, key);
        break;
      case 'listmap': // data.messages[convId] = [...] / delete
        this.markList(ctx.coll, key);
        break;
      case 'list': // push, splice, assignment into a list
        this.markList(ctx.coll, ctx.key);
        break;
      case 'doc':
        this.markDoc(ctx.coll, ctx.id);
        break;
      case 'elem': // a field of one message / post changed
        this.markElem(ctx.coll, ctx.key, ctx.elem);
        break;
      default:
        break;
    }
  }

  childCtx(ctx, parent, key, child) {
    switch (ctx.t) {
      case 'root':
        if (DOC_MAPS.has(key)) return { t: 'docmap', coll: key };
        if (LIST_MAPS.has(key)) return { t: 'listmap', coll: key };
        if (SINGLES.has(key)) return { t: 'doc', coll: '_', id: key };
        return { t: 'none' };
      case 'docmap':
        return { t: 'doc', coll: ctx.coll, id: key };
      case 'listmap':
        // The lists themselves (messages, channel posts) are handed out as they are: they can hold millions of
        // records and are scanned a lot. Replacing a whole list is seen here; the store says when it adds to or
        // removes from one (store._touchList) or edits a record in place (store._touchMsg).
        return { t: 'none' };
      default:
        return ctx; // doc, elem: everything below belongs to the same record
    }
  }

  wrap(target, ctx) {
    if (!plain(target) || ctx.t === 'none') return target;
    const cached = this.cache.get(target);
    if (cached) return cached;
    const self = this;
    const proxy = new Proxy(target, {
      get(t, key, receiver) {
        if (key === RAW) return t;
        const value = Reflect.get(t, key, receiver);
        if (typeof key === 'symbol' || !plain(value)) return value;
        return self.wrap(value, self.childCtx(ctx, t, key, value));
      },
      set(t, key, value) {
        const raw = value && value[RAW] ? value[RAW] : value;
        if (t[key] === raw) return true;
        const ok = Reflect.set(t, key, raw);
        self.touch(ctx, t, key);
        return ok;
      },
      deleteProperty(t, key) {
        if (!(key in t)) return true;
        const ok = Reflect.deleteProperty(t, key);
        self.touch(ctx, t, key);
        return ok;
      },
    });
    this.cache.set(target, proxy);
    return proxy;
  }

  /** The store's data, with change tracking switched on. */
  track(rawData) {
    return this.wrap(rawData, { t: 'root' });
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  coll text NOT NULL,
  id   text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (coll, id)
);
CREATE TABLE IF NOT EXISTS lists (
  coll text NOT NULL,
  key  text NOT NULL,
  id   text NOT NULL,
  pos  bigint GENERATED ALWAYS AS IDENTITY,
  data jsonb NOT NULL,
  PRIMARY KEY (coll, key, id)
);
CREATE INDEX IF NOT EXISTS lists_order ON lists (coll, key, pos);
`;

const CHUNK = 500;

/** Rows from the two tables -> the store's data object. */
function assemble(docRows, listRows) {
  const data = {};
  for (const { coll, id, data: d } of docRows) {
    if (coll === '_') data[id] = d;
    else (data[coll] ||= {})[id] = d;
  }
  const persisted = new Map();
  for (const { coll, key, id, data: d } of listRows) {
    ((data[coll] ||= {})[key] ||= []).push(d);
    const k = `${coll}\0${key}`;
    if (!persisted.has(k)) persisted.set(k, new Set());
    persisted.get(k).add(id);
  }
  // A chat or channel with no records yet still has its (empty) list.
  for (const id of Object.keys(data.conversations || {})) (data.messages ||= {})[id] ||= [];
  for (const id of Object.keys(data.channels || {})) (data.channelPosts ||= {})[id] ||= [];
  return { data, persisted };
}

class PgPersistence {
  /**
   * `pool`: a `pg` Pool, or give `url`. `schema`: keep the tables in this schema (tests use one per store).
   * `delayMs`: how long to wait after a change before saving (changes in that time go in one batch).
   */
  constructor({ pool, url, schema = null, delayMs = 150, onError, poolOptions = {} } = {}) {
    if (!pool) {
      const { Pool } = require('pg');
      pool = new Pool({ connectionString: url, max: 4, ...poolOptions, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
      this.ownsPool = true;
    }
    this.pool = pool;
    this.schema = schema;
    this.delayMs = delayMs;
    this.onError = onError || ((err) => console.error('PostgreSQL save failed (will retry):', err.message));
    this.tracker = new Tracker(() => this.schedule());
    this.persisted = new Map(); // `${coll}\0${key}` -> Set of record ids already in the database
    this.timer = null;
    this.running = null;
    this.again = false;
    this.failures = 0;
    this.closed = false;
    this.ready = this.init();
    this.ready.catch(() => {});
    this.stats = { flushes: 0, rows: 0, lastMs: 0, maxMs: 0 };
  }

  async init() {
    if (this.schema) {
      await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    }
    await this.pool.query(SCHEMA);
  }

  /** Read everything back as the store's data object (and remember which list records exist). */
  async load() {
    await this.ready;
    const docs = await this.pool.query('SELECT coll, id, data FROM docs');
    const lists = await this.pool.query('SELECT coll, key, id, data FROM lists ORDER BY coll, key, pos');
    const { data, persisted } = assemble(docs.rows, lists.rows);
    this.persisted = persisted;
    return data;
  }

  /** Called by the store with its raw data; returns the tracked version the store should use. */
  attach(rawData) {
    this.raw = rawData;
    return this.tracker.track(rawData);
  }

  schedule() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** Save everything changed so far. Resolves when the database has it. One save runs at a time; a call that arrives meanwhile is covered by one more pass. */
  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.save();
      } while (this.again);
    })().finally(() => { this.running = null; });
    try {
      await this.running;
      this.failures = 0;
    } catch (err) {
      this.failures += 1;
      this.onError(err);
      // Try again, a little later each time (up to 30 s). The changes are kept meanwhile.
      if (!this.closed) {
        this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, Math.min(30000, 500 * 2 ** this.failures));
        this.timer.unref?.();
      }
      throw err;
    }
    return undefined;
  }

  /** Work out what to write for a batch of changes, from the data as it is now. Changes nothing. */
  plan(batch) {
    const raw = this.raw;
    const docUp = { c: [], i: [], d: [] };
    const docDel = new Map(); // coll -> ids
    for (const [coll, ids] of batch.docs) {
      for (const id of ids) {
        const value = coll === '_' ? raw[id] : raw[coll]?.[id];
        if (value === undefined || value === null) {
          if (!docDel.has(coll)) docDel.set(coll, []);
          docDel.get(coll).push(id);
        } else {
          docUp.c.push(coll); docUp.i.push(id); docUp.d.push(JSON.stringify(value));
        }
      }
    }
    const listUp = { c: [], k: [], i: [], d: [] };
    const listDel = []; // { coll, key, ids }
    const listDrop = []; // { coll, key } the whole list is gone
    const nextPersisted = new Map();
    for (const [coll, keys] of batch.lists) {
      for (const [key, { elems }] of keys) {
        const pk = `${coll}\0${key}`;
        const arr = raw[coll]?.[key];
        if (!arr) {
          listDrop.push({ coll, key });
          nextPersisted.set(pk, null);
          continue;
        }
        const had = this.persisted.get(pk) || new Set();
        const now = new Set();
        for (const rec of arr) {
          now.add(rec.id);
          if (!had.has(rec.id) || elems.has(rec)) {
            listUp.c.push(coll); listUp.k.push(key); listUp.i.push(rec.id); listUp.d.push(JSON.stringify(rec));
          }
        }
        const gone = [...had].filter((id) => !now.has(id));
        if (gone.length) listDel.push({ coll, key, ids: gone });
        nextPersisted.set(pk, now);
      }
    }
    return { docUp, docDel, listUp, listDel, listDrop, nextPersisted };
  }

  /** The plan has been written: remember which list records are now in the database. */
  commit(plan) {
    for (const [pk, set] of plan.nextPersisted) {
      if (set === null) this.persisted.delete(pk);
      else this.persisted.set(pk, set);
    }
  }

  async save() {
    await this.ready;
    const batch = this.tracker.take();
    if (!batch.docs.size && !batch.lists.size) return;
    const t0 = Date.now();
    const plan = this.plan(batch);
    const { docUp, docDel, listUp, listDel, listDrop } = plan;
    let client = null;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      for (const [coll, ids] of docDel) await client.query('DELETE FROM docs WHERE coll = $1 AND id = ANY($2::text[])', [coll, ids]);
      for (let s = 0; s < docUp.i.length; s += CHUNK) {
        await client.query(
          `INSERT INTO docs (coll, id, data)
           SELECT c, i, d::jsonb FROM unnest($1::text[], $2::text[], $3::text[]) AS t(c, i, d)
           ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data`,
          [docUp.c.slice(s, s + CHUNK), docUp.i.slice(s, s + CHUNK), docUp.d.slice(s, s + CHUNK)],
        );
      }
      for (const { coll, key } of listDrop) await client.query('DELETE FROM lists WHERE coll = $1 AND key = $2', [coll, key]);
      for (const { coll, key, ids } of listDel) await client.query('DELETE FROM lists WHERE coll = $1 AND key = $2 AND id = ANY($3::text[])', [coll, key, ids]);
      for (let s = 0; s < listUp.i.length; s += CHUNK) {
        await client.query(
          `INSERT INTO lists (coll, key, id, data)
           SELECT c, k, i, d::jsonb FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS t(c, k, i, d, n)
           ORDER BY n
           ON CONFLICT (coll, key, id) DO UPDATE SET data = EXCLUDED.data`,
          [listUp.c.slice(s, s + CHUNK), listUp.k.slice(s, s + CHUNK), listUp.i.slice(s, s + CHUNK), listUp.d.slice(s, s + CHUNK)],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      this.tracker.restore(batch);
      throw err;
    } finally {
      client?.release();
    }
    this.commit(plan);
    const ms = Date.now() - t0;
    this.stats.flushes += 1;
    this.stats.rows += docUp.i.length + listUp.i.length;
    this.stats.lastMs = ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
  }

  /** Save what is left and release the connections (on shutdown). */
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    try {
      await this.flush();
    } finally {
      if (this.ownsPool) await this.pool.end();
    }
  }

  /** Remove the tables of a throw-away schema (tests). */
  async dropSchema() {
    if (this.schema) await this.pool.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
  }
}

module.exports = { PgPersistence, Tracker, RAW, assemble };
