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
  { id: 'calls', group: 'Messaging', label: 'Voice & video calls', description: 'Starting and joining calls.' },
  { id: 'callRecording', group: 'Messaging', label: 'Call recording', description: 'Asking to record a call. Recording only starts when everyone in the call agrees, and is saved on the requester\'s own device. Off: the Record button is hidden and requests are refused (stopping always works).' },
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

const IDS = FEATURES.map((f) => f.id);
/** Features an administrator has to switch on. */
const OFF_BY_DEFAULT = ['developerApi'];

/** Settings an administrator can change besides the on/off switches. */
const DEFAULT_SETTINGS = {
  // Everything is on, except the developer tools: API keys and webhooks are restricted
  // (web app and mobile) until an administrator switches them on.
  features: Object.fromEntries(IDS.map((id) => [id, !OFF_BY_DEFAULT.includes(id)])),
  limits: { freeChatLocks: 3, freeHiddenChats: 1, channelsPerOwner: 10, catalogueMax: 100 },
  prices: {}, // plan id -> price override
  announcement: '',
  maintenance: { on: false, message: 'We are making improvements and will be back soon.' },
  minClientVersion: '',
};

const LIMIT_RANGES = { freeChatLocks: [0, 1000], freeHiddenChats: [0, 1000], channelsPerOwner: [1, 1000], catalogueMax: [1, 10000] };

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
  if (patch.prices !== undefined) {
    for (const [plan, v] of Object.entries(patch.prices || {})) {
      if (!['daily', 'monthly', 'yearly'].includes(plan)) throw bad(`Unknown plan "${plan}"`);
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
