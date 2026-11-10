'use strict';

/**
 * The business assistant ("bot"): answers customers automatically from rules the business typed in. No code, no AI:
 * the business decides every word.
 *
 *   rules      keywords -> reply ("price", "cost" -> the price list)
 *   menu       "menu" shows a numbered list; the customer answers with a number
 *   handoff    "agent" / "human" -> a message, and the bot stays quiet in that chat for a while
 *   fallback   what to say when nothing matched (at most once every 6 hours per chat; off by default)
 *
 * It only reads messages that are not end-to-end encrypted (the app sends plain text to a business that has the assistant on,
 * and says so in the chat), and it answers only what a customer wrote: never an automatic message, never a voice note.
 */

const MAX_RULES = 100;
const MAX_KEYWORDS = 10;
const MAX_KEYWORD = 40;
const MAX_REPLY = 1000;
const MAX_MENU_ITEMS = 9;
const MAX_LABEL = 60;
const PAUSE_HOURS = [1, 4, 8, 24, 72];

const DEFAULT_BOT = () => ({
  enabled: false,
  onlyWhenClosed: false,
  rules: [],
  menu: { enabled: false, keywords: ['menu', 'help'], intro: 'How can we help? Reply with a number:', items: [] },
  handoff: { enabled: false, keywords: ['agent', 'human', 'person'], reply: 'A person from our team will reply as soon as they can.', pauseHours: 8 },
  fallback: { enabled: false, text: '' },
});

/** Lower-case words, with marks kept (so Indian-language words stay whole); punctuation and spacing do not matter. */
const tokens = (text) => String(text ?? '').normalize('NFC').toLocaleLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);

/** Do the words of `keyword` appear next to each other, in order, in `words`? */
function hasPhrase(words, keyword) {
  const k = tokens(keyword);
  if (!k.length) return false;
  for (let i = 0; i + k.length <= words.length; i++) {
    if (k.every((w, j) => words[i + j] === w)) return true;
  }
  return false;
}

const anyKeyword = (words, list) => (list || []).some((k) => hasPhrase(words, k));

/** The numbered menu as one message. */
const menuText = (bot) => [bot.menu.intro, ...bot.menu.items.map((it, i) => `${i + 1}. ${it.label}`)].filter(Boolean).join('\n');

/**
 * What the bot says to `text`, or null. `afterMenu`: the last thing the bot said in this chat (in the last day) was the menu, so a
 * bare number picks an item. `fallbackOk`: the fallback has not been sent in this chat lately.
 * Returns { kind: 'rule' | 'menu' | 'item' | 'handoff' | 'fallback', auto: 'bot' | 'bot-menu', text, pauseHours? }.
 */
function answer(bot, text, { afterMenu = false, fallbackOk = true } = {}) {
  if (!bot?.enabled) return null;
  const words = tokens(text);
  if (!words.length) return null;
  if (bot.handoff.enabled && anyKeyword(words, bot.handoff.keywords)) {
    return { kind: 'handoff', auto: 'bot', text: bot.handoff.reply, pauseHours: bot.handoff.pauseHours };
  }
  if (bot.menu.enabled && bot.menu.items.length) {
    if (afterMenu && words.length === 1 && /^\d{1,2}$/.test(words[0])) {
      const item = bot.menu.items[Number(words[0]) - 1];
      if (item) return { kind: 'item', auto: 'bot', text: item.reply };
    }
    if (anyKeyword(words, bot.menu.keywords)) return { kind: 'menu', auto: 'bot-menu', text: menuText(bot) };
  }
  for (const rule of bot.rules) {
    if (anyKeyword(words, rule.keywords)) return { kind: 'rule', auto: 'bot', text: rule.reply };
  }
  if (bot.fallback.enabled && bot.fallback.text && fallbackOk) return { kind: 'fallback', auto: 'bot', text: bot.fallback.text };
  return null;
}

const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'invalid_request' });

/** Check what the business typed and return the clean configuration. `maxRules` is the free or Premium limit. */
function normalise(input, { maxRules = 5 } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const str = (v, max, what) => {
    const t = String(v ?? '').trim();
    if (t.length > max) throw bad(`${what} is too long (at most ${max} characters)`);
    return t;
  };
  const words = (list, what) => {
    if (!Array.isArray(list)) throw bad(`${what}: give a list of words`);
    const out = [];
    for (const raw of list) {
      const t = str(raw, MAX_KEYWORD, `${what}: a keyword`);
      if (!t) continue;
      if (!tokens(t).length) throw bad(`${what}: "${t}" has no letters or numbers`);
      if (!out.some((x) => tokens(x).join(' ') === tokens(t).join(' '))) out.push(t);
    }
    if (out.length > MAX_KEYWORDS) throw bad(`${what}: at most ${MAX_KEYWORDS} keywords`);
    return out;
  };

  const bot = DEFAULT_BOT();
  bot.enabled = !!src.enabled;
  bot.onlyWhenClosed = !!src.onlyWhenClosed;

  const rules = Array.isArray(src.rules) ? src.rules : [];
  if (rules.length > Math.min(maxRules, MAX_RULES)) throw Object.assign(bad(`You can have ${Math.min(maxRules, MAX_RULES)} rules`), { premiumLimit: true });
  bot.rules = rules.map((r, i) => {
    const keywords = words(r?.keywords, `Rule ${i + 1}`);
    const reply = str(r?.reply, MAX_REPLY, `Rule ${i + 1}: the reply`);
    if (!keywords.length) throw bad(`Rule ${i + 1} needs at least one keyword`);
    if (!reply) throw bad(`Rule ${i + 1} needs a reply`);
    return { id: String(r?.id || `r${i + 1}`).slice(0, 20), keywords, reply };
  });

  const menu = src.menu || {};
  const items = Array.isArray(menu.items) ? menu.items : [];
  if (items.length > MAX_MENU_ITEMS) throw bad(`The menu can have at most ${MAX_MENU_ITEMS} items`);
  bot.menu = {
    enabled: !!menu.enabled,
    keywords: menu.keywords === undefined ? bot.menu.keywords : words(menu.keywords, 'Menu keywords'),
    intro: menu.intro === undefined ? bot.menu.intro : str(menu.intro, 200, 'The menu introduction'),
    items: items.map((it, i) => {
      const label = str(it?.label, MAX_LABEL, `Menu item ${i + 1}: the label`);
      const reply = str(it?.reply, MAX_REPLY, `Menu item ${i + 1}: the reply`);
      if (!label || !reply) throw bad(`Menu item ${i + 1} needs a label and a reply`);
      return { label, reply };
    }),
  };
  if (bot.menu.enabled && !bot.menu.items.length) throw bad('Add at least one menu item, or turn the menu off');
  if (bot.menu.enabled && !bot.menu.keywords.length) throw bad('Give at least one word that shows the menu (for example "menu")');

  const h = src.handoff || {};
  const pauseHours = h.pauseHours === undefined ? bot.handoff.pauseHours : Number(h.pauseHours);
  if (!PAUSE_HOURS.includes(pauseHours)) throw bad(`The assistant can stay quiet for ${PAUSE_HOURS.join(', ')} hours`);
  bot.handoff = {
    enabled: !!h.enabled,
    keywords: h.keywords === undefined ? bot.handoff.keywords : words(h.keywords, 'Hand-over words'),
    reply: h.reply === undefined ? bot.handoff.reply : str(h.reply, MAX_REPLY, 'The hand-over message'),
    pauseHours,
  };
  if (bot.handoff.enabled && (!bot.handoff.keywords.length || !bot.handoff.reply)) throw bad('Hand-over needs a word to ask for a person and a message');

  const f = src.fallback || {};
  bot.fallback = { enabled: !!f.enabled, text: str(f.text, MAX_REPLY, 'The fallback message') };
  if (bot.fallback.enabled && !bot.fallback.text) throw bad('The fallback message needs text');

  if (bot.enabled && !bot.rules.length && !bot.menu.enabled && !bot.handoff.enabled && !bot.fallback.enabled) {
    throw bad('Add at least one rule, the menu or hand-over before turning the assistant on');
  }
  return bot;
}

module.exports = { answer, normalise, tokens, menuText, DEFAULT_BOT, PAUSE_HOURS, MAX_RULES, MAX_MENU_ITEMS, MAX_REPLY };
