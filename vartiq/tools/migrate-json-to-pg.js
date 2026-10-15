#!/usr/bin/env node
'use strict';

/**
 * Copy an existing data/db.json into PostgreSQL (one time, when switching a running install).
 *
 *   DATABASE_URL=postgres://user:pass@localhost/vartiq node tools/migrate-json-to-pg.js [path/to/db.json]
 *
 * Stop the app first, and keep db.json (and the data/media folder, which stays where it is) as a backup.
 * The database must be empty; the script refuses to overwrite one that already has users.
 */
const fs = require('fs');
const path = require('path');
const { Store } = require('../server/store');

const DOC_MAPS = ['users', 'archivedUsers', 'sessions', 'conversations', 'media', 'statuses', 'apiKeys', 'webhooks', 'channels', 'admins'];
const LIST_MAPS = ['messages', 'channelPosts'];
const SINGLES = ['settings', 'reports', 'audit'];

async function migrate({ file, databaseUrl, schema, mediaDir }) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const store = await Store.open({ databaseUrl, schema, mediaDir });
  try {
    if (Object.keys(store.data.users).length) throw new Error('The database already has users. Migrate into an empty database.');
    const counts = {};
    for (const coll of DOC_MAPS) {
      for (const [id, value] of Object.entries(raw[coll] || {})) store.data[coll][id] = value;
      counts[coll] = Object.keys(raw[coll] || {}).length;
    }
    for (const coll of LIST_MAPS) {
      let n = 0;
      for (const [key, list] of Object.entries(raw[coll] || {})) { store.data[coll][key] = list; n += list.length; }
      counts[coll] = n;
    }
    for (const name of SINGLES) if (raw[name] !== undefined) store.data[name] = raw[name];
    await store.flush();
    return counts;
  } finally {
    await store.close();
  }
}

module.exports = { migrate };

if (require.main === module) {
  const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'db.json'));
  if (!process.env.DATABASE_URL) {
    console.error('Set DATABASE_URL, e.g. postgres://user:pass@localhost/vartiq');
    process.exit(1);
  }
  migrate({ file, databaseUrl: process.env.DATABASE_URL, mediaDir: process.env.MEDIA_DIR }).then((counts) => {
    console.log('Copied:', Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '));
    console.log('Start the app with DATABASE_URL set. Keep db.json as a backup.');
  }).catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
}
