// Production-like server for the load test: separate process, own data dir, real rate limits, proxy headers trusted.
const path = require('path');
const { createApp } = require('../server');
const { Store } = require('../server/store');
(async () => {
  const dir = process.env.LOAD_DIR || require('os').tmpdir() + '/vartiq-load';
  require('fs').mkdirSync(dir, { recursive: true });
  const store = process.env.DATABASE_URL
    ? await Store.open({ databaseUrl: process.env.DATABASE_URL, schema: process.env.LOAD_SCHEMA, mediaDir: path.join(dir, 'media') })
    : new Store({ file: path.join(dir, 'db.json') });
  const app = createApp({ store, admin: { username: 'root', password: 'correct-horse-battery' }, trustProxy: 'loopback', publicUrl: 'http://localhost:3400' });
  app.server.listen(3400, '127.0.0.1', () => console.log('ready'));
})();
