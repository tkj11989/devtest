#!/usr/bin/env node
'use strict';

/**
 * Example integration: a bot that answers every message it receives.
 *
 * Note: the developer API is off by default; an administrator must enable it first
 * (Admin dashboard → Features → Developer API).
 *
 * It shows the pieces another platform needs:
 *   1. authenticate with an API key,
 *   2. register a webhook and verify each delivery's signature,
 *   3. call the REST API to reply (with an Idempotency-Key, so webhook retries
 *      never send a reply twice).
 *
 * Usage (no dependencies, Node 18+):
 *   # in the app: Profile → Developer → Create key, for the account the bot uses
 *   WEBHOOKS_ALLOW_PRIVATE=1 npm start            # let the server call localhost
 *   CHATAPP_API_KEY=cak_... node examples/echo-bot.js
 *
 * Env: CHATAPP_URL (default http://localhost:3000), CHATAPP_API_KEY (required),
 *      PORT (default 4000), PUBLIC_URL (where the chat server can reach this bot;
 *      default http://localhost:PORT).
 */

const http = require('http');
const crypto = require('crypto');

const BASE = (process.env.CHATAPP_URL || 'http://localhost:3000').replace(/\/$/, '') + '/api/v1';
const KEY = process.env.CHATAPP_API_KEY;
const PORT = Number(process.env.PORT) || 4000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const MAX_SKEW_SECONDS = 5 * 60;

if (!KEY) {
  console.error('Set CHATAPP_API_KEY (create one in the app under Profile → Developer).');
  process.exit(1);
}

async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data?.error?.message || res.status}`);
  return data;
}

/** Check X-VartiQ-Signature = sha256=HMAC(secret, "<timestamp>.<raw body>") and that the timestamp is recent. */
function verify(secret, headers, raw) {
  const ts = headers['x-vartiq-timestamp'];
  const sig = headers['x-vartiq-signature'] || '';
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_SECONDS) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

async function main() {
  const { user } = await api('GET', '/me');
  console.log(`Signed in as @${user.username}`);

  const { webhook, secret } = await api('POST', '/webhooks', {
    url: `${PUBLIC_URL}/webhook`,
    events: ['message:new'],
    description: 'echo-bot example',
  });
  console.log(`Webhook ${webhook.id} → ${webhook.url}`);

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook') return res.writeHead(404).end();
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      if (!verify(secret, req.headers, raw)) return res.writeHead(401).end();
      res.writeHead(204).end(); // acknowledge quickly; do the work afterwards

      const { event, data } = JSON.parse(raw);
      const m = data.message;
      if (event !== 'message:new' || m.from === user.username || m.type) return; // only text from others
      const convId = encodeURIComponent(m.convId);
      try {
        await api('POST', `/conversations/${convId}/read`);
        await api('POST', `/conversations/${convId}/messages`,
          { text: `🤖 You said: "${m.masked ? '(masked message)' : m.text}"` },
          { 'Idempotency-Key': `echo-${m.id}` });
        console.log(`Replied to @${m.from}`);
      } catch (err) {
        console.error(err.message);
      }
    });
  });
  server.listen(PORT, () => console.log(`Listening for webhooks on :${PORT}. Send this account a message!`));

  const stop = async () => {
    server.close();
    await api('DELETE', `/webhooks/${webhook.id}`).catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
