'use strict';

/**
 * Everything an administrator can switch on or off. Turning a feature off blocks it on the
 * server for every client (the web app and mobile apps alike) and hides it in the apps, which
 * read `GET /api/v1/config`. It never deletes data, and it never traps people: anything
 * that only *removes* protection (unlocking a chat, unhiding, turning translation off) keeps working.
 */
const FEATURES = [
  { id: 'registration', group: 'Accounts', label: 'New sign-ups', description: 'People can create new accounts. Off: only existing users can log in.' },
  { id: 'groups', group: 'Messaging', label: 'Group chats', description: 'Creating new group chats.' },
  { id: 'voiceMessages', group: 'Messaging', label: 'Voice messages', description: 'Recording and sending voice messages.' },
  { id: 'disappearing', group: 'Messaging', label: 'Disappearing messages', description: 'Setting auto-delete timers on chats.' },
  { id: 'push', group: 'Messaging', label: 'Push notifications', description: 'Notifications on people\'s devices for new messages and calls when the app is closed. Off: no notifications are sent and nobody can turn them on (turning them off always works).' },
  { id: 'polls', group: 'Messaging', label: 'Polls', description: 'Creating polls in chats. Off: no new polls can be made or voted on (existing ones stay visible).' },
  { id: 'events', group: 'Messaging', label: 'Events', description: 'Creating events (date, place, replies, reminders) in chats. Off: no new events or replies (existing ones stay visible).' },
  { id: 'location', group: 'Messaging', label: 'Location sharing', description: 'Sharing a location, once or live, in a chat. Off: the buttons are hidden and live updates are refused (stopping a share always works).' },
  { id: 'calls', group: 'Messaging', label: 'Voice & video calls', description: 'Starting and joining calls.' },
  { id: 'callRecording', group: 'Messaging', label: 'Call recording', description: 'Asking to record a call. Recording only starts when everyone in the call agrees, and is saved on the requester\'s own device. Off: the Record button is hidden and requests are refused (stopping always works).' },
  { id: 'appearance', group: 'Social', label: 'Personalisation', description: 'Changing the colour theme, app icon and avatar shape (Premium options). Off: everyone sees the default look.' },
  { id: 'profilePhotos', group: 'Social', label: 'Profile photos', description: 'Uploading and showing profile photos (2 for a free account, 5 with Premium by default). Off: photos are hidden everywhere and cannot be added; removing always works.' },
  { id: 'status', group: 'Social', label: 'Status updates', description: 'Posting, viewing and replying to status updates.' },
  { id: 'channels', group: 'Social', label: 'Public channels', description: 'Creating, finding, following and posting in channels.' },
  { id: 'profileViews', group: 'Social', label: 'Who viewed my profile', description: 'Recording and showing profile views.' },
  { id: 'translation', group: 'Social', label: 'Message translation', description: 'Translating received messages (sends text to the translation service).' },
  { id: 'chatLock', group: 'Privacy', label: 'Chat lock', description: 'Locking more chats. Unlocking and removing locks always work.' },
  { id: 'hideChat', group: 'Privacy', label: 'Hide chat', description: 'Hiding more chats. Unhiding and opening hidden chats always work.' },
  { id: 'business', group: 'Business', label: 'Business profiles', description: 'Creating or editing business profiles (and their auto replies).' },
  { id: 'catalogue', group: 'Business', label: 'Product catalogue', description: 'Editing and viewing product catalogues.' },
  { id: 'premium', group: 'Money', label: 'Premium subscriptions', description: 'Buying Premium (existing Premium keeps working until it ends).' },
  { id: 'verification', group: 'Money', label: 'Identity verification (KYC)', description: 'Starting new identity verifications for the Verified badge.' },
  { id: 'developerApi', group: 'Developers', label: 'Developer API', description: 'API keys and webhooks. Restricted by default: off hides it in the web and mobile apps, blocks creating keys and webhooks, and stops API-key access.' },
];

const { DEFAULT_LEGAL, FIELD_LIMITS } = require('./legal');
const PLAN_IDS = Object.keys(require('./payments').DEFAULT_PLANS);
const IDS = FEATURES.map((f) => f.id);
/** Features an administrator has to switch on. */
const OFF_BY_DEFAULT = ['developerApi'];

/** Settings an administrator can change besides the on/off switches. */
const DEFAULT_SETTINGS = {
  // Everything is on, except the developer tools: API keys and webhooks are restricted
  // (web app and mobile) until an administrator switches them on.
  features: Object.fromEntries(IDS.map((id) => [id, !OFF_BY_DEFAULT.includes(id)])),
  limits: { freeChatLocks: 3, freeHiddenChats: 1, channelsPerOwner: 10, catalogueMax: 100, minAge: 8, freeProfilePhotos: 2, premiumProfilePhotos: 5, freePollOptions: 6, premiumPollOptions: 12, maxGroupMembers: 256 },
  prices: {}, // plan id -> price override
  disabledPlans: [], // plans nobody can buy right now
  announcement: '',
  maintenance: { on: false, message: 'We are making improvements and will be back soon.' },
  minClientVersion: '',
  legal: { ...DEFAULT_LEGAL }, // company details printed in the Terms and Privacy Notice (Admin → Settings → Legal)
};

const LIMIT_RANGES = { freeChatLocks: [0, 1000], freeHiddenChats: [0, 1000], channelsPerOwner: [1, 1000], catalogueMax: [1, 10000], minAge: [5, 17], freeProfilePhotos: [1, 10], premiumProfilePhotos: [1, 10], freePollOptions: [2, 20], premiumPollOptions: [2, 20], maxGroupMembers: [3, 1000] };

/** Merge a settings patch into `current`, validating everything. Returns the new settings and what changed. */
function applySettings(current, patch) {
  const next = JSON.parse(JSON.stringify(current));
  const changes = [];
  const bad = (msg) => Object.assign(new Error(msg), { status: 400, code: 'invalid_request' });
  const set = (path, obj, key, value) => {
    if (JSON.stringify(obj[key]) !== JSON.stringify(value)) {
      changes.push(`${path}: ${JSON.stringify(obj[key])} → ${JSON.stringify(value)}`);
      obj[key] = value;
    }
  };
  if (patch.features !== undefined) {
    if (!patch.features || typeof patch.features !== 'object') throw bad('features must be an object');
    for (const [id, on] of Object.entries(patch.features)) {
      if (!IDS.includes(id)) throw bad(`Unknown feature "${id}"`);
      if (typeof on !== 'boolean') throw bad(`features.${id} must be true or false`);
      set(`feature ${id}`, next.features, id, on);
    }
  }
  if (patch.limits !== undefined) {
    for (const [k, v] of Object.entries(patch.limits || {})) {
      if (!LIMIT_RANGES[k]) throw bad(`Unknown limit "${k}"`);
      const [lo, hi] = LIMIT_RANGES[k];
      if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`limits.${k} must be a whole number from ${lo} to ${hi}`);
      set(`limit ${k}`, next.limits, k, v);
    }
  }
  if (next.limits.premiumPollOptions < next.limits.freePollOptions) throw bad('limits.premiumPollOptions cannot be lower than freePollOptions');
  if (next.limits.premiumProfilePhotos < next.limits.freeProfilePhotos) throw bad('limits.premiumProfilePhotos cannot be lower than freeProfilePhotos');
  if (patch.prices !== undefined) {
    for (const [plan, v] of Object.entries(patch.prices || {})) {
      if (!PLAN_IDS.includes(plan)) throw bad(`Unknown plan "${plan}"`);
      if (v === null) {
        if (plan in next.prices) {
          changes.push(`price ${plan}: ${next.prices[plan]} → default`);
          delete next.prices[plan];
        }
        continue;
      }
      if (typeof v !== 'number' || !(v > 0) || v > 1e7 || Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) throw bad(`prices.${plan} must be a positive amount with at most 2 decimals`);
      set(`price ${plan}`, next.prices, plan, v);
    }
  }
  if (patch.disabledPlans !== undefined) {
    const list = patch.disabledPlans;
    if (!Array.isArray(list) || list.some((p) => !PLAN_IDS.includes(p))) throw bad(`disabledPlans must be a list of plan ids (${PLAN_IDS.join(', ')})`);
    if (new Set(list).size >= PLAN_IDS.length) throw bad('At least one plan must stay available');
    set('disabled plans', next, 'disabledPlans', [...new Set(list)].sort());
  }
  if (patch.announcement !== undefined) {
    if (typeof patch.announcement !== 'string' || patch.announcement.length > 300) throw bad('announcement must be text of up to 300 characters');
    set('announcement', next, 'announcement', patch.announcement.trim());
  }
  if (patch.maintenance !== undefined) {
    const m = patch.maintenance || {};
    if (m.on !== undefined) {
      if (typeof m.on !== 'boolean') throw bad('maintenance.on must be true or false');
      set('maintenance on', next.maintenance, 'on', m.on);
    }
    if (m.message !== undefined) {
      if (typeof m.message !== 'string' || !m.message.trim() || m.message.length > 300) throw bad('maintenance.message must be text of up to 300 characters');
      set('maintenance message', next.maintenance, 'message', m.message.trim());
    }
  }
  if (patch.minClientVersion !== undefined) {
    const v = String(patch.minClientVersion || '').trim();
    if (v && !/^\d+(\.\d+){0,2}$/.test(v)) throw bad('minClientVersion must look like 1.2.0');
    set('minClientVersion', next, 'minClientVersion', v);
  }
  if (patch.legal !== undefined) {
    const l = patch.legal || {};
    next.legal = { ...DEFAULT_LEGAL, ...(next.legal || {}) };
    for (const [k, v] of Object.entries(l)) {
      if (!(k in DEFAULT_LEGAL)) throw bad(`Unknown legal setting "${k}"`);
      if (k === 'backupDays' || k === 'responseDays') {
        if (!Number.isInteger(v) || v < 1 || v > 365) throw bad(`legal.${k} must be a whole number of days from 1 to 365`);
      } else if (k === 'requireForLegacy') {
        if (typeof v !== 'boolean') throw bad('legal.requireForLegacy must be true or false');
      } else {
        if (typeof v !== 'string' || v.trim().length > FIELD_LIMITS[k]) throw bad(`legal.${k} must be text of up to ${FIELD_LIMITS[k]} characters`);
        if ((k === 'contactEmail' || k === 'grievanceEmail') && v.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) throw bad(`legal.${k} must be an email address`);
      }
      set(`legal ${k}`, next.legal, k, typeof v === 'string' ? v.trim() : v);
    }
  }
  return { settings: next, changes };
}

/** True when version `a` is older than `b` (both like "1.2.3"). */
function versionLess(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

module.exports = { FEATURES, IDS, OFF_BY_DEFAULT, DEFAULT_SETTINGS, applySettings, versionLess };
