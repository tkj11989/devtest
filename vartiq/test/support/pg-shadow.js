'use strict';

/**
 * Checks that PostgreSQL saving notices every change, without needing a database.
 *
 * Every store made during the test run gets a "shadow database" (plain Maps). After EVERY store method call, the
 * changes the store has noted are applied to the shadow exactly as they would be written to PostgreSQL. At the
 * end of each test file the shadow is rebuilt into data and compared with the store's real data. A change
 * that was made but never noticed shows up as a difference.
 *
 *   node --test --require ./test/support/pg-shadow.js test/*.test.js
 */
const { after } = require('node:test');
const assert = require('node:assert');
const { Store } = require('../../server/store');
const { PgPersistence, assemble } = require('../../server/pg');

const noPool = { query: async () => ({ rows: [] }), connect: async () => { throw new Error('no database in shadow mode'); }, end: async () => {} };
const entries = [];

class Shadow {
  constructor() {
    this.docs = new Map(); // `${coll}\0${id}` -> json
    this.lists = new Map(); // `${coll}\0${key}` -> Map(id -> json)
  }

  apply(p) {
    const batch = p.tracker.take();
    if (!batch.docs.size && !batch.lists.size) return;
    const plan = p.plan(batch);
    for (const [coll, ids] of plan.docDel) for (const id of ids) this.docs.delete(`${coll}\0${id}`);
    plan.docUp.i.forEach((id, n) => this.docs.set(`${plan.docUp.c[n]}\0${id}`, plan.docUp.d[n]));
    for (const { coll, key } of plan.listDrop) this.lists.delete(`${coll}\0${key}`);
    for (const { coll, key, ids } of plan.listDel) for (const id of ids) this.lists.get(`${coll}\0${key}`)?.delete(id);
    plan.listUp.i.forEach((id, n) => {
      const lk = `${plan.listUp.c[n]}\0${plan.listUp.k[n]}`;
      if (!this.lists.has(lk)) this.lists.set(lk, new Map());
      this.lists.get(lk).set(id, plan.listUp.d[n]);
    });
    p.commit(plan);
  }

  data() {
    const docRows = [...this.docs].map(([k, json]) => { const [coll, id] = k.split('\0'); return { coll, id, data: JSON.parse(json) }; });
    const listRows = [];
    for (const [k, items] of this.lists) {
      const [coll, key] = k.split('\0');
      for (const [id, json] of items) listRows.push({ coll, key, id, data: JSON.parse(json) });
    }
    return assemble(docRows, listRows).data;
  }
}

Store.defaultPersistence = () => {
  const p = new PgPersistence({ pool: noPool });
  p.schedule = () => {}; // nothing to write
  const shadow = new Shadow();
  entries.push({ p, shadow });
  return p;
};

// After every store method: apply what was noticed.
for (const name of Object.getOwnPropertyNames(Store.prototype)) {
  const fn = Store.prototype[name];
  if (typeof fn !== 'function' || name === 'constructor') continue;
  Store.prototype[name] = function wrapped(...args) {
    const result = fn.apply(this, args);
    if (this.pg && this.pg.shadow) this.pg.shadow.apply(this.pg);
    return result;
  };
}
const origDefault = Store.defaultPersistence;
Store.defaultPersistence = (store) => {
  const p = origDefault(store);
  p.shadow = entries[entries.length - 1].shadow;
  return p;
};

function normal(data) {
  const out = JSON.parse(JSON.stringify(data));
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (v === null || (Array.isArray(v) && !v.length) || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete out[key];
  }
  for (const coll of ['messages', 'channelPosts']) for (const k of Object.keys(out[coll] || {})) if (!out[coll][k].length) delete out[coll][k];
  return out;
}

after(() => {
  const problems = [];
  entries.forEach(({ p, shadow }, i) => {
    shadow.apply(p);
    try {
      assert.deepStrictEqual(normal(shadow.data()), normal(p.raw));
    } catch (err) {
      problems.push(`store #${i + 1}: ${String(err.message).slice(0, 1200)}`);
    }
  });
  if (problems.length) {
    console.error(`\nPOSTGRES SHADOW CHECK FAILED (${problems.length} of ${entries.length} stores):\n${problems.slice(0, 3).join('\n---\n')}`);
    process.exitCode = 1;
    throw new Error('a change was not noticed by PostgreSQL saving');
  }
  console.log(`PostgreSQL shadow check: ${entries.length} stores, every change noticed`);
});
