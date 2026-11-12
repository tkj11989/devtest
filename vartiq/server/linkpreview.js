'use strict';

/**
 * Link previews: the sender's app asks the server for the title, description and a small picture of a web page, and attaches
 * them to the message it sends. The recipient never contacts the website, so the website cannot see who read the message.
 *
 * Safety: only http/https on the usual ports, the address is checked at connect time (no private networks, no DNS rebinding),
 * at most 3 redirects, a few seconds, a small download, and only HTML (and a small JPEG/PNG/WebP/GIF picture).
 */

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const { isPrivateAddress } = require('./webhooks');

const MAX_PAGE = 300 * 1024;
const MAX_IMAGE = 60 * 1024; // a picture bigger than this is left out (the message stays small)
const MAX_REDIRECTS = 3;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
  if (e[0] === '#') {
    const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
  }
  return ENTITIES[e.toLowerCase()] ?? all;
});

/** The first http(s) link in a text, or null. */
function firstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return null;
  return m[0].replace(/[.,;:!?)\]}]+$/, '');
}

/** Is this URL one we may fetch (public web, http/https, ports 80/443/8080/8443, no credentials)? */
function allowedUrl(raw, anyPort = false) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
  if (!anyPort && u.port && !['80', '443', '8080', '8443'].includes(u.port)) return null;
  if (u.hostname === 'localhost' || u.hostname.endsWith('.local') || u.hostname.endsWith('.internal')) return null;
  return u;
}

function createLinkPreviewer({ allowPrivate = false, timeoutMs = 5000, fetchOverride } = {}) {
  /** GET with a size cap and a connect-time address check. Resolves { status, headers, body, url }. */
  const get = (url, { max, accept }) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const lookup = (host, opts, cb) => dns.lookup(host, opts, (err, address, family) => {
      if (err) return cb(err);
      const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
      if (!allowPrivate && list.some(isPrivateAddress)) return cb(new Error('private address'));
      return cb(null, address, family);
    });
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) return reject(new Error('private address'));
    const req = (u.protocol === 'https:' ? https : http).request({
      hostname: host, port: u.port || undefined, path: `${u.pathname}${u.search}`, method: 'GET', lookup, timeout: timeoutMs,
      headers: { 'User-Agent': 'VartiQ-LinkPreview/1.0 (+link preview for a chat message)', Accept: accept, 'Accept-Language': 'en' },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > max) { res.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url, truncated: true }); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url }));
      res.on('error', reject);
      res.on('close', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url, truncated: true }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });

  async function fetchFollow(url, opts) {
    let current = url;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const u = allowedUrl(current, allowPrivate);
      if (!u) throw new Error('link not allowed');
      const res = await (fetchOverride || get)(u.href, opts);
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        current = new URL(res.headers.location, u).href;
        continue;
      }
      return res;
    }
    throw new Error('too many redirects');
  }

  const meta = (html, names) => {
    for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
      const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (!key || !names.includes(key.toLowerCase())) continue;
      const val = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
      if (val) return decode(val);
    }
    return '';
  };

  /** { url, title, description?, site?, image? } for a page, or null when there is nothing worth showing. */
  async function preview(rawUrl) {
    const first = allowedUrl(rawUrl, allowPrivate);
    if (!first) return null;
    let res;
    try {
      res = await fetchFollow(first.href, { max: MAX_PAGE, accept: 'text/html,application/xhtml+xml' });
    } catch { return null; }
    if (res.status < 200 || res.status >= 300 || !/html/i.test(String(res.headers['content-type'] || ''))) return null;
    const html = res.body.toString('utf8');
    const head = html.slice(0, html.search(/<\/head>/i) > 0 ? html.search(/<\/head>/i) : 150000);
    const title = clip(decode(meta(head, ['og:title', 'twitter:title']) || (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''), 140);
    if (!title) return null;
    const out = { url: res.url, title };
    const description = clip(decode(meta(head, ['og:description', 'twitter:description', 'description'])), 240);
    if (description) out.description = description;
    const site = clip(decode(meta(head, ['og:site_name'])) || new URL(res.url).hostname.replace(/^www\./, ''), 60);
    if (site) out.site = site;
    const img = meta(head, ['og:image', 'og:image:url', 'twitter:image']);
    if (img) {
      try {
        const ir = await fetchFollow(new URL(img, res.url).href, { max: MAX_IMAGE + 1, accept: 'image/*' });
        const type = String(ir.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ir.status === 200 && !ir.truncated && ir.body.length <= MAX_IMAGE && IMAGE_TYPES.includes(type)) {
          out.image = `data:${type};base64,${ir.body.toString('base64')}`;
        }
      } catch { /* no picture */ }
    }
    return out;
  }

  return { preview, anyPort: allowPrivate, allowed: (raw) => allowedUrl(raw, allowPrivate) };
}

/** A preview a client attached to a message, checked and cut to size; null if it is not acceptable. */
function cleanPreview(p, anyPort = false) {
  if (!p || typeof p !== 'object') return null;
  const u = allowedUrl(String(p.url || ''), anyPort);
  const title = clip(p.title, 140);
  if (!u || !title) return null;
  const out = { url: u.href.slice(0, 2000), title };
  if (p.description) out.description = clip(p.description, 240);
  if (p.site) out.site = clip(p.site, 60);
  if (typeof p.image === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(p.image) && p.image.length <= Math.ceil(MAX_IMAGE * 4 / 3) + 40) out.image = p.image;
  return out;
}

module.exports = { createLinkPreviewer, cleanPreview, firstUrl, allowedUrl, MAX_IMAGE };
