/*
 * The Android app (a Capacitor shell around this web app). Everything here does nothing in an ordinary browser.
 *
 * Browsers get notifications through Web Push; inside the app there is no browser push service, so the app registers a Firebase
 * Cloud Messaging token instead and the server sends the same small wake-ups to it. The shell also needs a few things a browser
 * does by itself: the Back button, opening the right chat when a notification is tapped, and saving a file (a blob download does
 * not work inside a WebView, so the file is written to the cache and handed to the share sheet).
 */
window.createNative = function createNative(options) {
  'use strict';

  const { emit, openChat, hasChat, toast, flagKey, storage, onBack } = options;
  const cap = window.Capacitor;
  const isNative = !!cap?.isNativePlatform?.();
  const plugin = (name) => cap?.Plugins?.[name];
  const platform = () => (cap?.getPlatform?.() === 'ios' ? 'ios' : 'android');

  let started = false;

  const tokenFlag = () => storage.get(flagKey());
  const isOn = () => String(tokenFlag() || '').startsWith('fcm:');

  /** Ask for permission, make the channels, get this device's token and give it to the server. */
  async function enable() {
    const push = plugin('PushNotifications');
    if (!push) throw new Error('Notifications are not available in this version of the app. Update the app.');
    const perm = await push.requestPermissions();
    if (perm.receive !== 'granted') throw new Error('Notifications were not allowed. You can allow them in Android Settings, Apps, VartiQ, Notifications.');
    try {
      await push.createChannel({ id: 'messages', name: 'Messages', description: 'New messages', importance: 4, visibility: 0, vibration: true });
      await push.createChannel({ id: 'calls', name: 'Calls', description: 'Incoming calls', importance: 5, visibility: 0, vibration: true, lights: true });
    } catch { /* channels exist or are not supported */ }
    const token = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The phone did not give a notification token. Check your internet connection and try again.')), 20000);
      push.addListener('registration', (t) => { clearTimeout(timer); resolve(t.value); });
      push.addListener('registrationError', (e) => { clearTimeout(timer); reject(new Error(e?.error || 'Could not register for notifications')); });
      push.register();
    });
    await emit('push:subscribe', { fcmToken: token, platform: platform(), userAgent: `VartiQ app (${platform()})` });
    storage.set(flagKey(), `fcm:${token}`);
  }

  async function disable() {
    const flag = tokenFlag();
    if (flag) await emit('push:unsubscribe', { endpoint: flag }).catch(() => {});
    storage.del(flagKey());
    try { await plugin('PushNotifications')?.unregister?.(); } catch { /* ignore */ }
  }

  /** After sign-in: if this account turned notifications on here, make sure the server has the current token. */
  async function resync() {
    if (!isNative || !isOn()) return;
    try { await enable(); } catch { storage.del(flagKey()); }
  }

  /** Wire up the shell once: notification taps and the Back button. */
  function start() {
    if (!isNative || started) return;
    started = true;
    const push = plugin('PushNotifications');
    // Tapping a notification opens its chat.
    push?.addListener?.('pushNotificationActionPerformed', (a) => {
      const convId = a?.notification?.data?.convId;
      if (convId && hasChat(convId)) openChat(convId);
    });
    // The Android Back button: close what is open, else leave the chat, else send the app to the background.
    const app = plugin('App');
    app?.addListener?.('backButton', () => { if (!onBack()) app.minimizeApp?.(); });
  }

  /** Save a file the way Android wants it: write it to the cache and open the share sheet (Save to Drive, Files, WhatsApp ...). */
  async function saveFile(blob, name) {
    const fs = plugin('Filesystem');
    const share = plugin('Share');
    if (!isNative || !fs || !share) return false;
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(new Error('Could not read the file'));
      r.readAsDataURL(blob);
    });
    const safe = String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'file';
    const written = await fs.writeFile({ path: `shared/${Date.now()}-${safe}`, data, directory: 'CACHE', recursive: true });
    await share.share({ title: safe, url: written.uri, dialogTitle: 'Save or share' });
    return true;
  }

  return { isNative, isOn, enable, disable, resync, start, saveFile };
};
