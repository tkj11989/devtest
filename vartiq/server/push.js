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
function createPush({ store, isOnline, featureOn = () => true, subject = () => undefined, vapid = {}, sender, extraHosts = (process.env.PUSH_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean), minGapMs = 10 * 1000 }) {
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
        await send(sub, payload, { ttl, urgency, topic });
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
      }
      const who = namesFor(conv, msg, to);
      if (!who.generic) {
        convId = conv.id;
        tag = `c-${conv.id}`;
        if (prefs.preview) {
          const what = LABEL[msg.type] || 'New message';
          if (who.group) {
            title = who.group;
            body = msg.type === 'call' ? `${who.sender}: ${body}` : `${who.sender}: ${what}`;
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
