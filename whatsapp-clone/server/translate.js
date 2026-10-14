'use strict';

/**
 * Translating received messages into the language a person picks for a chat.
 *
 * Messages are end-to-end encrypted, so the server cannot translate them itself: the app
 * decrypts a message on the device and, only for chats where the person turned translation
 * on, sends its text here, to be translated by a translation service and handed straight
 * back. Texts are not stored or logged. The person is told this before they turn it on.
 *
 * Gateway contract (any service behind a small relay: Google Cloud Translation, DeepL,
 * Azure Translator, AWS Translate, LibreTranslate…): `POST $TRANSLATE_WEBHOOK_URL` with JSON
 *   { action: "translate", target: "hi", texts: ["…", "…"] }
 *     -> { translations: [{ text: "…", detected: "en" }, …] }   (same order and length)
 * and `Authorization: Bearer $TRANSLATE_WEBHOOK_TOKEN` when set.
 * `TRANSLATE_SANDBOX=1` fakes it for development: it labels each text "[hi] …".
 */

const LANGUAGES = [
  ['en', 'English', 'English'], ['hi', 'Hindi', 'हिन्दी'], ['bn', 'Bengali', 'বাংলা'], ['ta', 'Tamil', 'தமிழ்'],
  ['te', 'Telugu', 'తెలుగు'], ['mr', 'Marathi', 'मराठी'], ['gu', 'Gujarati', 'ગુજરાતી'], ['kn', 'Kannada', 'ಕನ್ನಡ'],
  ['ml', 'Malayalam', 'മലയാളം'], ['pa', 'Punjabi', 'ਪੰਜਾਬੀ'], ['ur', 'Urdu', 'اردو'], ['ne', 'Nepali', 'नेपाली'],
  ['es', 'Spanish', 'Español'], ['fr', 'French', 'Français'], ['de', 'German', 'Deutsch'], ['pt', 'Portuguese', 'Português'],
  ['it', 'Italian', 'Italiano'], ['nl', 'Dutch', 'Nederlands'], ['ru', 'Russian', 'Русский'], ['ar', 'Arabic', 'العربية'],
  ['tr', 'Turkish', 'Türkçe'], ['id', 'Indonesian', 'Bahasa Indonesia'], ['th', 'Thai', 'ไทย'], ['vi', 'Vietnamese', 'Tiếng Việt'],
  ['zh', 'Chinese', '中文'], ['ja', 'Japanese', '日本語'], ['ko', 'Korean', '한국어'],
].map(([code, name, native]) => ({ code, name, native }));

const CODES = new Set(LANGUAGES.map((l) => l.code));
const MAX_TEXTS = 30;
const MAX_CHARS = 4000;

class TranslateError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createTranslator({ gateway = null, sandbox = false, perMinute = 120 } = {}) {
  const available = !!(gateway || sandbox);
  const usage = new Map(); // user -> [timestamps of texts]

  const isLanguage = (code) => CODES.has(code);

  async function translate(user, target, texts) {
    if (!available) throw new TranslateError(503, 'translation_unavailable', 'Translation is not available right now');
    if (!isLanguage(target)) throw new TranslateError(400, 'invalid_request', 'Unknown language');
    if (!Array.isArray(texts) || !texts.length || texts.length > MAX_TEXTS || texts.some((t) => typeof t !== 'string' || !t || t.length > MAX_CHARS)) {
      throw new TranslateError(400, 'invalid_request', `Send 1 to ${MAX_TEXTS} texts of up to ${MAX_CHARS} characters`);
    }
    const now = Date.now();
    const recent = (usage.get(user) || []).filter((t) => t > now - 60 * 1000);
    if (recent.length + texts.length > perMinute) throw new TranslateError(429, 'rate_limited', 'Translating too fast. Try again in a moment.');
    for (let i = 0; i < texts.length; i++) recent.push(now);
    usage.set(user, recent);

    if (!gateway) return texts.map((text) => ({ text: `[${target}] ${text}`, detected: 'en' }));
    let result;
    try {
      result = await gateway({ action: 'translate', target, texts });
    } catch (err) {
      console.error('Translation gateway failed:', err.message); // never the texts
      throw new TranslateError(502, 'translation_failed', 'The translation service is not answering. Try again.');
    }
    const list = result?.translations;
    if (!Array.isArray(list) || list.length !== texts.length || list.some((x) => typeof x?.text !== 'string')) {
      throw new TranslateError(502, 'translation_failed', 'The translation service answered incorrectly');
    }
    return list.map((x) => ({ text: x.text, detected: typeof x.detected === 'string' ? x.detected.toLowerCase().split('-')[0] : null }));
  }

  return { available, sandbox: !gateway && sandbox, languages: LANGUAGES, isLanguage, translate, TranslateError };
}

function createTranslateGateway(env = process.env) {
  if (!env.TRANSLATE_WEBHOOK_URL) return null;
  return async (body) => {
    const res = await fetch(env.TRANSLATE_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.TRANSLATE_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.TRANSLATE_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`gateway answered ${res.status}`);
    return res.json();
  };
}

module.exports = { createTranslator, createTranslateGateway, TranslateError, LANGUAGES };
