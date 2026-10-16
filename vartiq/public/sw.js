'use strict';

/**
 * VartiQ service worker: shows notifications for push messages and opens the app when one is tapped.
 * It does not cache anything and does not run the app offline.
 *
 * A push says who and what kind ("Asha: New message", "Incoming video call"), never the message itself.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const call = data.kind === 'call';
  const options = {
    body: clip(data.body, 140) || 'New message',
    tag: clip(data.tag, 80) || 'vartiq',
    renotify: true,
    icon: '/app-icons/icon-192.png',
    badge: '/app-icons/icon-32.png',
    timestamp: Date.now(),
    requireInteraction: call,
    vibrate: call ? [300, 150, 300, 150, 300] : [120],
    data: { convId: clip(data.convId, 80) || null, kind: clip(data.kind, 20), callId: clip(data.callId, 40) || null },
  };
  event.waitUntil((async () => {
    // The app is open and in front: it already shows the message itself (calls always ring).
    if (!call) {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (open.some((c) => c.visibilityState === 'visible' && c.focused)) return;
    }
    await self.registration.showNotification(clip(data.title, 80) || 'VartiQ', options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { convId } = event.notification.data || {};
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = open.find((c) => 'focus' in c);
    if (target) {
      await target.focus();
      if (convId) target.postMessage({ type: 'open-chat', convId });
      return;
    }
    await self.clients.openWindow(convId ? `/?open=${encodeURIComponent(convId)}` : '/');
  })());
});

// The browser replaced the subscription (keys rotated or expired): tell the app so it can save the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of open) c.postMessage({ type: 'push-resubscribe' });
  })());
});
