'use strict';

/**
 * Spam checks that run when someone sends a message. They count what an account does in short periods; the words of an
 * encrypted message are never seen (the same-text rule works only on messages the server can read, such as API chats).
 *
 *   new chats    more than 20 chats in an hour with people who have not written back
 *   same text    the same words (8+ characters) to 5 different such chats or groups within 10 minutes
 *
 * A stopped message is not sent and the person is told to wait. Each stop is remembered on the account; three in a day
 * limit starting new chats for 24 hours (see Store.flagSpam). Counters live in memory only.
 */

const NEW_CHATS_PER_HOUR = 20;
const SAME_TEXT_CHATS = 5;
const SAME_TEXT_WINDOW_MS = 10 * 60 * 1000;
const HOUR = 3600 * 1000;

const sigOf = (text) => String(text || '').normalize('NFC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

function createSpamGuard({ store }) {
  const log = new Map(); // username -> [{ ts, convId, sig }]

  /** Throws { reason } when this message looks like spam; otherwise records it. `text` is '' for messages the server cannot read. */
  function check(me, conv, text, now = Date.now()) {
    if (!conv) return;
    const other = conv.type === 'direct' ? conv.members.find((m) => m !== me) : null;
    const written = other ? (store.data.messages[conv.id] || []).some((m) => m.from === other && m.type !== 'system') : false;
    if (written) return; // a conversation the other person joined in is not cold outreach
    const mine = (log.get(me) || []).filter((e) => now - e.ts < HOUR);
    const sig = sigOf(text);
    const entry = { ts: now, convId: conv.id, sig: sig.length >= 8 ? sig : '' };
    const chats = new Set(mine.map((e) => e.convId));
    chats.add(conv.id);
    let reason = null;
    if (chats.size > NEW_CHATS_PER_HOUR) reason = 'many new chats';
    else if (entry.sig) {
      const same = new Set(mine.filter((e) => e.sig === entry.sig && now - e.ts < SAME_TEXT_WINDOW_MS).map((e) => e.convId));
      same.add(conv.id);
      if (same.size >= SAME_TEXT_CHATS + 1) reason = 'same text to many chats';
    }
    if (reason) {
      store.flagSpam(me, reason, now);
      return { reason };
    }
    mine.push(entry);
    log.set(me, mine);
    return null;
  }

  return { check, forget: (u) => log.delete(u) };
}

module.exports = { createSpamGuard, NEW_CHATS_PER_HOUR, SAME_TEXT_CHATS };
