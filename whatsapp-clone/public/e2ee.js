/*
 * End-to-end encryption for ChatApp messages (scheme v1). Runs in the browser and in Node (tests).
 *
 * Each device owns a P-256 key pair; the private key never leaves it. To send, the sender
 *   1. makes a random 256-bit content key and encrypts the message JSON with AES-256-GCM,
 *   2. for every recipient device (its own devices included) wraps the content key with
 *      AES-256-GCM under a key from HKDF-SHA-256 over TWO ECDH secrets:
 *        - one-time key x recipient device key  (fresh keys for every message)
 *        - sender device key x recipient device key (proves who sent it: the server can't forge it)
 *   3. binds everything to the chat with AAD "convId|sender|senderDeviceId", so the server
 *      cannot move a ciphertext to another chat or attribute it to someone else.
 * The server only ever sees ciphertext, public keys, and who talks to whom.
 */
(function (root, factory) {
  const api = factory(root.crypto || (typeof require === 'function' ? require('crypto').webcrypto : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.E2EE = api;
}(typeof self !== 'undefined' ? self : globalThis, (webcrypto) => {
  'use strict';

  const subtle = webcrypto.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const EC = { name: 'ECDH', namedCurve: 'P-256' };

  const toB64u = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromB64u = (s) => {
    const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  };
  const random = (n) => webcrypto.getRandomValues(new Uint8Array(n));
  const aad = (convId, from, sd) => enc.encode(`${convId}|${from}|${sd}`);

  /** A new device key pair. The private key is not extractable. */
  async function generateDevice() {
    const pair = await subtle.generateKey(EC, false, ['deriveBits']);
    const publicKey = toB64u(await subtle.exportKey('raw', pair.publicKey));
    return { privateKey: pair.privateKey, publicKey };
  }

  const importPublic = (b64) => subtle.importKey('raw', fromB64u(b64), EC, false, []);

  /** HKDF(DH(a, R) || DH(b, R)) -> AES-GCM key that wraps the content key for device `deviceId`. */
  async function wrapKeyFor(privA, privB, remotePublic, deviceId) {
    const [d1, d2] = await Promise.all([
      subtle.deriveBits({ name: 'ECDH', public: remotePublic }, privA, 256),
      subtle.deriveBits({ name: 'ECDH', public: remotePublic }, privB, 256),
    ]);
    const ikm = new Uint8Array(64);
    ikm.set(new Uint8Array(d1), 0);
    ikm.set(new Uint8Array(d2), 32);
    const hk = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('chatapp-e2ee-v1'), info: enc.encode(`wrap|${deviceId}`) },
      hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  }

  /**
   * Encrypt for a chat.
   *  - `device`: { id, privateKey } this device
   *  - `recipients`: [{ id, publicKey }] every device of every member (this device included)
   *  - `payload`: JSON-able message content, e.g. { t: 'hello' }
   *  - `media`: optional bytes (a voice recording) to encrypt with the same content key
   * Returns { envelope, media } (media = encrypted bytes or undefined).
   */
  async function encrypt({ device, convId, from, recipients, payload, media }) {
    const ck = random(32);
    const key = await subtle.importKey('raw', ck, 'AES-GCM', false, ['encrypt']);
    const ad = aad(convId, from, device.id);
    const iv = random(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, enc.encode(JSON.stringify(payload)));
    const envelope = { v: 1, sd: device.id, iv: toB64u(iv), ct: toB64u(ct), eph: '', w: {} };
    let encryptedMedia;
    if (media) {
      const mi = random(12);
      encryptedMedia = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: mi, additionalData: ad }, key, media));
      envelope.mi = toB64u(mi);
    }
    const eph = await subtle.generateKey(EC, false, ['deriveBits']);
    envelope.eph = toB64u(await subtle.exportKey('raw', eph.publicKey));
    for (const r of recipients) {
      const wk = await wrapKeyFor(eph.privateKey, device.privateKey, await importPublic(r.publicKey), r.id);
      const wiv = random(12);
      const k = await subtle.encrypt({ name: 'AES-GCM', iv: wiv, additionalData: ad }, wk, ck);
      envelope.w[r.id] = { iv: toB64u(wiv), k: toB64u(k) };
    }
    return { envelope, media: encryptedMedia };
  }

  /**
   * Decrypt a received envelope.
   *  - `device`: { id, privateKey } this device
   *  - `senderDevices`: the sender's registered devices [{ id, publicKey }] (from the key directory)
   * Returns { payload, media } or throws.
   */
  async function decrypt({ device, convId, from, envelope, senderDevices, media }) {
    const wrap = envelope.w?.[device.id];
    if (!wrap) throw new Error('not encrypted for this device');
    const sender = senderDevices.find((d) => d.id === envelope.sd);
    if (!sender) throw new Error('unknown sending device');
    const ad = aad(convId, from, envelope.sd);
    const eph = await importPublic(envelope.eph);
    // Same two secrets as the sender, from the other side.
    const [d1, d2] = await Promise.all([
      subtle.deriveBits({ name: 'ECDH', public: eph }, device.privateKey, 256),
      subtle.deriveBits({ name: 'ECDH', public: await importPublic(sender.publicKey) }, device.privateKey, 256),
    ]);
    const ikm = new Uint8Array(64);
    ikm.set(new Uint8Array(d1), 0);
    ikm.set(new Uint8Array(d2), 32);
    const hk = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    const wk = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('chatapp-e2ee-v1'), info: enc.encode(`wrap|${device.id}`) },
      hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    const ck = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(wrap.iv), additionalData: ad }, wk, fromB64u(wrap.k));
    const key = await subtle.importKey('raw', ck, 'AES-GCM', false, ['decrypt']);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(envelope.iv), additionalData: ad }, key, fromB64u(envelope.ct));
    let plain;
    if (media) plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(envelope.mi), additionalData: ad }, key, media));
    return { payload: JSON.parse(dec.decode(pt)), media: plain };
  }

  /**
   * A number two people can compare in person or over a call: the same on both phones when
   * nobody has tampered with the key directory. `a`/`b`: { username, devices: [{ keyId }] }.
   */
  async function safetyNumber(a, b) {
    const side = (x) => `${x.username}:${x.devices.map((d) => d.keyId).sort().join(',')}`;
    const text = [side(a), side(b)].sort().join('|');
    let n = BigInt(`0x${[...new Uint8Array(await subtle.digest('SHA-256', enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('')}`);
    const groups = [];
    for (let i = 0; i < 12; i++) {
      groups.push(String(n % 100000n).padStart(5, '0'));
      n /= 100000n;
    }
    return groups.join(' ');
  }

  // ---------- browser: keep this device's key, register it, and use it ----------

  /** IndexedDB holds the (non-extractable) private key, so it survives reloads but never leaves the device. */
  const keyStore = {
    open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('chatapp-e2ee', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('keys');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async get(name) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const r = db.transaction('keys').objectStore('keys').get(name);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => reject(r.error);
      });
    },
    async put(name, value) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('keys', 'readwrite');
        tx.objectStore('keys').put(value, name);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },
  };

  /**
   * The app's encryption helper. `emit(event, payload)` talks to the server.
   * `ready` is false when this browser can't keep a key (then messages go unencrypted and say so).
   */
  function createClient({ emit, username, deviceName }) {
    const keyCache = new Map(); // convId -> { keys: { user: [devices] }, at }
    let device = null; // { id, privateKey }
    const client = {
      get ready() { return !!device; },
      get deviceId() { return device?.id || null; },

      /** Make or load this device's key and make sure the server knows its public half. */
      async init() {
        try {
          if (!webcrypto?.subtle || typeof indexedDB === 'undefined') return false;
          const { devices } = await emit('e2ee:devices');
          let saved = await keyStore.get(username);
          if (saved && !devices.some((d) => d.id === saved.id && d.publicKey === saved.publicKey)) saved = null; // removed elsewhere
          if (!saved) {
            const fresh = await generateDevice();
            const { device: registered } = await emit('e2ee:register', { name: deviceName, publicKey: fresh.publicKey });
            saved = { id: registered.id, publicKey: fresh.publicKey, privateKey: fresh.privateKey };
            await keyStore.put(username, saved);
          }
          device = { id: saved.id, privateKey: saved.privateKey, publicKey: saved.publicKey };
          return true;
        } catch (err) {
          console.warn('Encryption is not available:', err.message);
          device = null;
          return false;
        }
      },

      forget() {
        keyCache.clear();
      },

      /** Someone's devices changed: drop cached keys. */
      invalidate() {
        keyCache.clear();
      },

      async keysFor(convId, { refresh = false } = {}) {
        if (refresh || !keyCache.has(convId)) keyCache.set(convId, (await emit('e2ee:keys', { convId })).keys);
        return keyCache.get(convId);
      },

      /** True when every member has at least one device (otherwise someone could not read the message). */
      async canEncrypt(convId) {
        if (!device) return false;
        const keys = await this.keysFor(convId);
        return Object.values(keys).every((list) => list.length > 0);
      },

      /** Encrypt `payload` (and optional audio bytes) for a chat. */
      async encrypt(conv, payload, media, { refresh = false } = {}) {
        const keys = await this.keysFor(conv.id, { refresh });
        const recipients = Object.values(keys).flat().map((d) => ({ id: d.id, publicKey: d.publicKey }));
        return encrypt({ device, convId: conv.id, from: username, recipients, payload, media });
      },

      /** Decrypt a message from the server; `media` is the downloaded ciphertext of a voice message. */
      async decrypt(msg, media) {
        const attempt = async (refresh) => {
          const keys = await this.keysFor(msg.convId, { refresh });
          return decrypt({ device, convId: msg.convId, from: msg.from, envelope: msg.e2ee, senderDevices: keys[msg.from] || [], media });
        };
        try {
          return await attempt(false);
        } catch (err) {
          // The sender may have added a device since we cached the directory.
          return attempt(true);
        }
      },
    };
    return client;
  }

  return { generateDevice, encrypt, decrypt, safetyNumber, createClient, toB64u, fromB64u };
}));
