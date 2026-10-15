'use strict';

/**
 * Run the whole test suite with every store backed by PostgreSQL, and at the end of each test file check
 * that what was saved to the database is exactly what is in memory:
 *
 *   TEST_DATABASE_URL=postgres://vartiq:vartiq@localhost/vartiq_test \
 *     node --test --require ./test/support/pg-preload.js test/
 *
 * Each store gets its own schema, removed afterwards.
 */
const { after } = require('node:test');
const assert = require('node:assert');
const { Store } = require('../../server/store');
const { PgPersistence } = require('../../server/pg');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL');

const entries = [];
const errors = [];
let n = 0;
const POOL = { max: 2, idleTimeoutMillis: 300 };

Store.defaultPersistence = () => {
  const schema = `t_${process.pid}_${++n}`;
  const p = new PgPersistence({ url, schema, poolOptions: POOL, onError: (e) => errors.push(e) });
  entries.push({ p, schema });
  return p;
};

/** The saved form of the data: JSON, with empty lists left out (the database does not keep those). */
function normal(data) {
  const out = JSON.parse(JSON.stringify(data));
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (v === null || (Array.isArray(v) && !v.length) || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete out[key];
  }
  for (const coll of ['messages', 'channelPosts']) {
    for (const k of Object.keys(out[coll] || {})) if (!out[coll][k].length) delete out[coll][k];
  }
  return out;
}

after(async () => {
  const problems = [];
  for (const { p, schema } of entries) {
    try {
      await p.flush();
      const reader = new PgPersistence({ url, schema, poolOptions: POOL });
      const loaded = await reader.load();
      assert.deepStrictEqual(normal(loaded), normal(p.raw), `data saved in ${schema} differs from memory`);
      await reader.pool.end();
    } catch (err) {
      problems.push(`${schema}: ${String(err.message).slice(0, 1500)}`);
    }
  }
  const cleaner = new PgPersistence({ url, poolOptions: POOL });
  for (const { schema } of entries) await cleaner.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await cleaner.pool.end();
  for (const { p } of entries) await p.close().catch(() => {});
  if (errors.length) problems.push(`save errors: ${errors.slice(0, 3).map((e) => e.message).join('; ')}`);
  if (problems.length) {
    console.error(`\nPOSTGRES VERIFY FAILED (${problems.length}):\n${problems.slice(0, 5).join('\n')}`);
    process.exitCode = 1;
    throw new Error('PostgreSQL copy differs from memory');
  }
  console.log(`PostgreSQL verify: ${entries.length} stores saved and re-read identical`);
});
