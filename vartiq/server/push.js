'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Push notifications (Web Push, RFC 8030/8291/8292).
 *
 * A browser that allows notifications gives the app a push subscription; we keep it on the account and, when something
 * arrives for a person who is not connected, send a small encrypted wake-up through the browser maker's push service
 * (Google, Mozilla, Apple, Microsoft). What is sent says who and what kind ("Asha: New message", "Incoming video call"),
 * never the message itself. People choose what they get (messages, calls, whether the sender's name is shown), and
 * chats that are locked or hidden only ever show "New message".
 *
 * Native apps (the Android app) cannot use Web Push, so they register a Firebase Cloud Messaging (FCM) token instead; it is kept in
 * the same list (as `fcm:<token>`) and the same small wake-ups are sent through Google's FCM HTTP v1 API, signed with a service
 * account (FCM_SERVICE_ACCOUNT, a path to the JSON file from the Firebase console).
 *
 * The push service address comes from the person's browser, so the server only sends to the known push services
 * (otherwise a person could make the server call any address they like).
 */

const ALLOWED_HOSTS = [
  /(^|\.)googleapis\.com$/, // Chrome, Edge, Android (FCM)
  /(^|\.)push\.services\.mozilla\.com$/, // Firefox
  /(^|\.)push\.apple\.com$/, // Safari, iOS home-screen apps
  /(^|\.)notify\.windows\.com$/, // Edge on Windows
];

/** Is this an https address of a known push service? (`extraHosts`: more host names, from PUSH_ALLOWED_HOSTS.) */
function allowedEndpoint(endpoint, extraHosts = []) {
  let u;
  try {
    u = new URL(String(endpoint));
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  if (String(endpoint).length > 1000) return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((re) => re.test(host)) || extraHosts.includes(host);
}

const B64U = /^[A-Za-z0-9_-]+$/;
const b64bytes = (s, n) => typeof s === 'string' && B64U.test(s) && Buffer.from(s, 'base64url').length === n;

/** The VAPID key pair that identifies this server to push services: from the environment, a file, or made new. */
function loadVapid({ publicKey, privateKey, file } = {}, webpush) {
  publicKey = publicKey || process.env.VAPID_PUBLIC_KEY;
  privateKey = privateKey || process.env.VAPID_PRIVATE_KEY;
  if (publicKey && privateKey) return { publicKey, privateKey };
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.publicKey && saved.privateKey) return saved;
    } catch { /* not there yet */ }
  }
  const keys = webpush.generateVAPIDKeys();
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
    } catch (err) {
      console.error('Could not save the push keys (notifications will stop working after a restart):', err.message);
    }
  }
  return keys;
}

/**
 * Options:
 *   store, isOnline   the data store, and "is this person connected right now?"
 *   featureOn         () => boolean, is the "push" feature switched on?
 *   subject           () => the contact address sent to push services (a mailto: or https: address)
 *   vapid             { publicKey, privateKey, file }
 *   sender            async (subscription, payload, options) => void, replaces the real sending (tests)
 *   extraHosts        more allowed push-service host names
 */
function createPush({ store, isOnline, featureOn = () => true, subject = () => undefined, vapid = {}, sender, fcm = {}, extraHosts = (process.env.PUSH_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean), minGapMs = 10 * 1000 }) {
  let webpush;
  let keys;
  const web = () => {
    if (!webpush) webpush = require('web-push');
    return webpush;
  };
  const vapidKeys = () => {
    if (!keys) keys = loadVapid(vapid, web());
    return keys;
  };

  const send = sender || (async (sub, payload, options) => {
    const subj = options.subject || subject() || process.env.PUSH_SUBJECT || 'mailto:admin@localhost.invalid';
    const k = vapidKeys();
    return web().sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload,
      { TTL: options.ttl, urgency: options.urgency, topic: options.topic, vapidDetails: { subject: subj, publicKey: k.publicKey, privateKey: k.privateKey } },
    );
  });

  // ---------- native apps: Firebase Cloud Messaging (HTTP v1) ----------

  let account = null; // the service account: { project_id, client_email, private_key }
  const loadAccount = () => {
    if (account !== null) return account || null;
    account = false;
    try {
      const raw = fcm.serviceAccount ?? (process.env.FCM_SERVICE_ACCOUNT_JSON || (process.env.FCM_SERVICE_ACCOUNT ? fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT, 'utf8') : null));
      const sa = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (sa?.project_id && sa?.client_email && sa?.private_key) account = sa;
    } catch (err) {
      console.error('Could not read the FCM service account (native notifications are off):', err.message);
    }
    return account || null;
  };
  /** Can this server send to native apps? (A fake sender counts, for tests.) */
  const fcmAvailable = () => !!(fcm.sender || loadAccount());

  let accessToken = null; // { value, until }
  const googleToken = async () => {
    if (accessToken && accessToken.until > Date.now() + 60 * 1000) return accessToken.value;
    const sa = loadAccount();
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = b64({ alg: 'RS256', typ: 'JWT' });
    const claims = b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
    const signature = require('crypto').createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key, 'base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw Object.assign(new Error(`FCM sign-in failed: ${body.error_description || body.error || res.status}`), { statusCode: 500 });
    accessToken = { value: body.access_token, until: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
    return accessToken.value;
  };

  /** The FCM message for one wake-up: a notification the system shows by itself, plus the data the app uses when it is tapped. */
  const fcmMessage = (token, data, { ttl, urgency }) => ({
    token,
    notification: { title: String(data.title || 'VartiQ'), body: String(data.body || '') },
    data: Object.fromEntries(Object.entries(data).filter(([k, v]) => v !== undefined && !['title', 'body'].includes(k)).map(([k, v]) => [k, String(v)])),
    android: {
      priority: urgency === 'high' ? 'HIGH' : 'NORMAL',
      ttl: `${Math.max(1, Math.round(ttl))}s`,
      notification: { channel_id: data.kind === 'call' ? 'calls' : 'messages', ...(data.tag ? { tag: String(data.tag) } : {}) },
    },
  });

  const sendFcm = async (sub, data, options) => {
    const token = String(sub.endpoint).slice(4);
    const message = fcmMessage(token, data, options);
    if (fcm.sender) return fcm.sender(sub, message);
    const sa = loadAccount();
    if (!sa) throw Object.assign(new Error('FCM is not set up on this server'), { statusCode: 503 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await googleToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (res.ok) return undefined;
      if (res.status === 401 && attempt === 0) { accessToken = null; continue; }
      const body = await res.json().catch(() => ({}));
      const code = body?.error?.details?.find?.((d) => d.errorCode)?.errorCode || body?.error?.status;
      // A token the app no longer has: forget it (like a gone Web Push subscription).
      throw Object.assign(new Error(`FCM ${res.status} ${code || ''}`.trim()), { statusCode: res.status === 404 || code === 'UNREGISTERED' ? 410 : res.status });
    }
    return undefined;
  };

  const lastSent = new Map(); // user|key -> time, so a burst of messages is one notification
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [k, t] of lastSent) if (t < cutoff) lastSent.delete(k);
  }, 60 * 1000);
  sweep.unref();

  /** Send one wake-up to every device of `username`. Gone subscriptions are forgotten. Never throws. */
  async function deliver(username, data, { ttl = 3600, urgency = 'normal', topic } = {}) {
    const subs = store.pushSubs(username);
    if (!subs.length) return 0;
    const payload = JSON.stringify({ v: 1, ...data });
    let ok = 0;
    await Promise.all(subs.map(async (sub) => {
      try {
        if (sub.fcm) await sendFcm(sub, data, { ttl, urgency });
        else await send(sub, payload, { ttl, urgency, topic });
        ok += 1;
      } catch (err) {
        if (err?.statusCode === 404 || err?.statusCode === 410) store.removePushSub(username, sub.endpoint);
        else console.warn(`Push to ${username} failed: ${err?.statusCode || ''} ${err?.message || err}`.trim());
      }
    }));
    return ok;
  }

  const enabled = () => !!featureOn();

  const namesFor = (conv, msg, to) => {
    const sender = store.publicUser(msg.from)?.displayName || msg.from;
    // Locked and hidden chats never say who wrote or what it was about.
    if (store.isChatLocked(to, conv.id) || store.isChatHidden(to, conv.id)) return { generic: true };
    return { sender, group: conv.type === 'group' ? conv.name : null };
  };

  const LABEL = { voice: 'Voice message', location: 'Location', poll: 'Poll', event: 'Event' };

  return {
    enabled,
    /** Could a notification wake this person's device for a call? (Lets a call ring someone whose app is closed.) */
    canWake: (u) => enabled() && !store.isClosed(u) && store.pushSubs(u).length > 0 && store.pushPrefs(u).calls,
    allowedEndpoint: (e) => allowedEndpoint(e, extraHosts),
    publicKey: () => vapidKeys().publicKey,

    /** Validate and save a browser's subscription for `username`. */
    subscribe(username, subscription, userAgent) {
      const bad = (m) => Object.assign(new Error(m), { status: 400, code: 'invalid_request' });
      const endpoint = subscription?.endpoint;
      if (!allowedEndpoint(endpoint, extraHosts)) throw bad('That is not a push address from a supported browser service');
      const { p256dh, auth } = subscription.keys || {};
      if (!b64bytes(p256dh, 65) || !b64bytes(auth, 16)) throw bad('The subscription keys are not valid');
      store.addPushSub(username, { endpoint, p256dh, auth }, userAgent);
      return store.pushSubs(username).length;
    },

    /** Is native-app notification sending set up on this server? */
    fcmAvailable,

    /** Save the FCM token of the Android (or iPhone) app for `username`. */
    subscribeNative(username, { token, platform } = {}, userAgent) {
      const bad = (m) => Object.assign(new Error(m), { status: 400, code: 'invalid_request' });
      if (!fcmAvailable()) throw Object.assign(new Error('Notifications for the app are not set up on this server'), { status: 503, code: 'unavailable' });
      if (typeof token !== 'string' || !/^[A-Za-z0-9_:.\-]{50,4096}$/.test(token)) throw bad('That is not a valid device token');
      store.addPushSub(username, { endpoint: `fcm:${token}`, fcm: true, platform: ['android', 'ios'].includes(platform) ? platform : 'android' }, userAgent);
      return store.pushSubs(username).length;
    },

    /** A message reached `to` while they are not connected. */
    message(to, conv, msg) {
      if (!enabled() || isOnline(to) || store.isClosed(to) || !store.pushSubs(to).length) return;
      const prefs = store.pushPrefs(to);
      let title = 'VartiQ';
      let body = 'New message';
      let tag = 'msg';
      let convId;
      if (msg.type === 'call') {
        if (msg.call?.status !== 'missed' || !prefs.calls) return;
        body = `Missed ${msg.call.kind === 'video' ? 'video' : 'voice'} call`;
      } else {
        if (!prefs.messages) return;
        if (msg.type === 'system') return;
        if (store.isMuted(to, conv.id) && !msg.mentions?.includes(to)) return; // a muted chat makes no sound, except for @mentions
      }
      const who = namesFor(conv, msg, to);
      if (!who.generic) {
        convId = conv.id;
        tag = `c-${conv.id}`;
        if (prefs.preview) {
          const what = msg.type === 'media' ? ({ image: 'Photo', video: 'Video', file: 'Document' }[msg.media?.kind] || 'File') : (LABEL[msg.type] || 'New message');
          if (who.group) {
            title = who.group;
            body = msg.type === 'call' ? `${who.sender}: ${body}` : msg.mentions?.includes(to) ? `${who.sender} mentioned you` : `${who.sender}: ${what}`;
          } else {
            title = who.sender;
            if (msg.type !== 'call') body = what;
          }
        }
      }
      // A burst of messages from one chat is one notification.
      const key = `${to}|${tag}`;
      const now = Date.now();
      if (msg.type !== 'call' && now - (lastSent.get(key) || 0) < minGapMs) return;
      lastSent.set(key, now);
      deliver(to, { kind: msg.type === 'call' ? 'missed' : 'message', title, body, tag, ...(convId ? { convId } : {}) }, { topic: undefined }).catch(() => {});
    },

    /** An event the person said yes or maybe to (or made) is about to start. */
    reminder(to, conv, msg) {
      if (!enabled() || isOnline(to) || store.isClosed(to) || !store.pushSubs(to).length || !store.pushPrefs(to).messages) return;
      const generic = store.isChatLocked(to, conv.id) || store.isChatHidden(to, conv.id);
      const detail = !generic && store.pushPrefs(to).preview;
      deliver(to, {
        kind: 'reminder',
        title: detail ? msg.event.title : 'VartiQ',
        body: detail ? 'Starting soon' : 'An event is about to start',
        tag: `event-${msg.id}`,
        ...(generic ? {} : { convId: conv.id }),
      }, { ttl: 3600 }).catch(() => {});
    },

    /** Someone is calling `to`. (Wakes the app; the call itself rings once the app is open.) */
    call(to, conv, call, caller) {
      if (!enabled() || isOnline(to) || store.isClosed(to) || !store.pushSubs(to).length) return;
      const prefs = store.pushPrefs(to);
      if (!prefs.calls) return;
      const generic = store.isChatLocked(to, conv.id) || store.isChatHidden(to, conv.id);
      const name = !generic && prefs.preview ? (store.publicUser(caller)?.displayName || caller) : null;
      const kind = call.kind === 'video' ? 'video' : 'voice';
      deliver(to, {
        kind: 'call',
        title: name || 'VartiQ',
        body: `Incoming ${kind} call`,
        tag: `call-${call.id}`,
        callId: call.id,
        ...(generic ? {} : { convId: conv.id }),
      }, { ttl: 30, urgency: 'high' }).catch(() => {});
    },

    /** A test notification to all of `username`'s devices (the Settings button). */
    async test(username) {
      return deliver(username, { kind: 'test', title: 'VartiQ', body: 'Notifications are on for this device.', tag: 'test' }, { ttl: 60 });
    },

    stop() { clearInterval(sweep); },
    _deliver: deliver,
  };
}

module.exports = { createPush, allowedEndpoint, ALLOWED_HOSTS };
