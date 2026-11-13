/*
 * Scam shield: looks at a message that arrives (and at one you are about to send) for the tricks used in common scams in India,
 * and warns. It runs ON THE DEVICE after a message is decrypted, so it works in end-to-end encrypted chats and nothing is sent
 * anywhere. It only warns: it never blocks, deletes or reports by itself.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScamShield = api;
}(typeof self !== 'undefined' ? self : globalThis, () => {
  'use strict';

  /** Brand word -> the real domains. A link that uses the brand in its name but is not one of these is a lookalike. */
  const BRANDS = {
    sbi: ['sbi.co.in', 'onlinesbi.sbi', 'sbi.bank.in', 'sbicard.com', 'sbilife.co.in'],
    hdfc: ['hdfcbank.com', 'hdfc.com', 'hdfcsec.com', 'hdfclife.com'],
    icici: ['icicibank.com', 'icicidirect.com', 'icicilombard.com'],
    axis: ['axisbank.com'],
    kotak: ['kotak.com'],
    pnb: ['pnbindia.in', 'netpnb.com'],
    paytm: ['paytm.com', 'paytm.in', 'paytmbank.com'],
    phonepe: ['phonepe.com'],
    gpay: ['pay.google.com'],
    irctc: ['irctc.co.in'],
    epfo: ['epfindia.gov.in', 'epfindia.com'],
    uidai: ['uidai.gov.in'],
    incometax: ['incometax.gov.in', 'incometaxindia.gov.in'],
    npci: ['npci.org.in'],
    amazon: ['amazon.in', 'amazon.com', 'amzn.in', 'amzn.to'],
    flipkart: ['flipkart.com', 'fkrt.it'],
    jio: ['jio.com', 'ril.com'],
    airtel: ['airtel.in', 'airtel.com'],
    bsnl: ['bsnl.co.in'],
    indiapost: ['indiapost.gov.in'],
    fedex: ['fedex.com'],
    dhl: ['dhl.com'],
  };
  const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'cutt.ly', 'rb.gy', 'is.gd', 'shorturl.at', 'tiny.cc', 'ow.ly', 'rebrand.ly', 'bl.ink', 'lnkd.in', 'goo.gl']);
  const RISKY_TLDS = new Set(['xyz', 'top', 'click', 'link', 'live', 'icu', 'cyou', 'buzz', 'rest', 'gq', 'tk', 'ml', 'cf', 'ga', 'work', 'support', 'cfd', 'sbs']);

  const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+|[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|in|net|org|co|xyz|top|click|link|live|icu|cyou|buzz|rest|gq|tk|ml|cf|ga|work|support|cfd|sbs|info|biz|me|app)(?:\/[^\s<>"']*)?)/gi;

  /** Every web address in the text: { url, host }. */
  function linksIn(text) {
    const out = [];
    for (const raw of String(text || '').match(URL_RE) || []) {
      const clean = raw.replace(/[.,;:!?)\]}]+$/, '');
      if (/@/.test(clean) && !/^https?:\/\//i.test(clean)) continue; // an email address
      try {
        const u = new URL(/^https?:\/\//i.test(clean) ? clean : `http://${clean}`);
        out.push({ url: u.href, host: u.hostname.toLowerCase().replace(/^www\./, ''), path: u.pathname + u.search });
      } catch { /* not a link */ }
    }
    return out;
  }

  const registrable = (host) => host.split('.').slice(-2).join('.');
  const isOfficial = (host, domains) => domains.some((d) => host === d || host.endsWith(`.${d}`));

  /** Why this link is suspicious: array of { points, why }. */
  function judgeLink(l) {
    const out = [];
    const host = l.host;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) out.push({ points: 4, why: 'a link that goes to a bare number address, not a website name' });
    if (host.split('.').some((p) => p.startsWith('xn--'))) out.push({ points: 3, why: 'a link with look-alike letters (it may imitate a real site)' });
    if (/\.apk(\?|$)/i.test(l.path)) out.push({ points: 4, why: 'a link that installs an app file (.apk). Fake apps steal money and OTPs' });
    if (SHORTENERS.has(host) || SHORTENERS.has(registrable(host))) out.push({ points: 1, why: 'a shortened link that hides where it goes' });
    const tld = host.split('.').pop();
    const labels = host.split('.');
    for (const [brand, domains] of Object.entries(BRANDS)) {
      if (isOfficial(host, domains)) continue;
      const token = new RegExp(`(^|[.-])${brand}(bank|card|kyc|care|login|secure|update|support|pay|refund|help|verify|india|online|[0-9]*)([.-]|$)`);
      if (labels.some((p) => token.test(p)) || token.test(host)) {
        out.push({ points: 4, why: `a link that uses the name “${brand.toUpperCase()}” but is not their website (${registrable(host)})` });
        break;
      }
    }
    if (RISKY_TLDS.has(tld) && !out.length) out.push({ points: 1, why: `a link to an unusual address (.${tld})` });
    return out;
  }

  /** [regex, points, why] over lower-cased text. */
  const PHRASES = [
    [/\b(share|send|tell|give|bhejo|batao|dedo)\b[^.\n]{0,25}\b(otp|pin|cvv|password|passcode)\b|\b(otp|pin|cvv)\b[^.\n]{0,20}\b(share|send|bhej|batao)|ओटीपी|\bupi pin\b/, 4, 'asks you for an OTP, PIN or password. No bank or company ever asks for these'],
    [/\b(kyc|pan|aadhaar|aadhar)\b[^.\n]{0,40}\b(expire|expired|update|suspend|block|blocked|pending|verify)\b|\b(account|card|sim|number)\b[^.\n]{0,30}\b(will be|has been|is)\s*(blocked|suspended|closed|deactivated)\b/, 3, 'says your account will be blocked unless you act now (a common trick)'],
    [/\b(anydesk|teamviewer|quicksupport|rustdesk|airdroid|screen ?share|remote access)\b/, 4, 'asks you to install a remote-control app. Scammers use these to empty bank accounts'],
    [/\b(scan|click)\b[^.\n]{0,30}\b(qr|link)\b[^.\n]{0,40}\b(receive|get|claim|refund|cashback|money)\b|\bcollect request\b|\bapprove\b[^.\n]{0,20}\b(request|collect)\b[^.\n]{0,30}\b(receive|refund)\b/, 4, 'tells you to scan or approve something to RECEIVE money. Receiving money never needs your PIN or a scan'],
    [/\b(lottery|lucky draw|you (have )?won|congratulations[^.\n]{0,30}\bwon\b|prize money|kbc|jackpot|free gift|gift card)\b/, 3, 'says you won a prize or gift'],
    [/\b(work from home|part[- ]time job|earn)\b[^.\n]{0,50}(₹|rs\.?|inr|\$)\s?\d|\b(daily|per day)\b[^.\n]{0,20}(₹|rs\.?)\s?\d{3,}|task(s)? (and|to) earn|like (and|&) (earn|subscribe)/, 3, 'offers easy money for little work (a common job scam)'],
    [/\b(guaranteed|assured)\b[^.\n]{0,20}\b(returns?|profit|income)\b|\bdouble your (money|investment)\b|\bcrypto\b[^.\n]{0,40}\b(profit|returns?|invest)\b|\binvest\b[^.\n]{0,40}\b(daily|weekly)\b[^.\n]{0,15}\b(profit|returns?)\b/, 3, 'promises guaranteed profit (an investment scam)'],
    [/\b(cbi|customs|narcotics|police|ed|enforcement directorate|trai|cyber ?crime)\b[^.\n]{0,60}\b(arrest|warrant|case|parcel|illegal|fir)\b|\bdigital arrest\b/, 4, 'claims to be police or an agency and threatens arrest (the “digital arrest” scam)'],
    [/\b(electricity|power|gas)\b[^.\n]{0,30}\b(disconnect|cut|connection)\b[^.\n]{0,30}\b(tonight|today|9 ?pm|immediately)\b/, 3, 'threatens to cut a service tonight unless you pay or call'],
    [/\b(send|transfer|pay)\b[^.\n]{0,25}\b(money|₹|rs\.?|amount)\b[^.\n]{0,40}\b(urgent|urgently|immediately|right now|emergency|asap)\b|\b(urgent|emergency)\b[^.\n]{0,40}\b(send|transfer|pay)\b[^.\n]{0,20}\b(money|₹|rs\.?|amount)\b|\bi am in trouble\b[^.\n]{0,40}\bmoney\b/, 3, 'asks you to send money urgently'],
    [/\b(refund|cashback)\b[^.\n]{0,40}\b(link|click|apply|claim)\b/, 2, 'offers a refund or cashback if you click a link'],
    [/\b(parcel|courier|package)\b[^.\n]{0,50}\b(held|stuck|returned|customs|fee|pay)\b/, 2, 'says a parcel is stuck and asks you to pay or click'],
  ];

  /**
   * Judge one received message. `ctx.firstContact`: nobody in this chat has been written to by you yet (strangers are riskier).
   * Returns { level: 'none' | 'warn' | 'danger', reasons: [text, …], links: [url, …] }.
   */
  function assess(text, ctx = {}) {
    const t = String(text || '');
    if (t.length < 6 || t.length > 4000) return { level: 'none', reasons: [], links: [] };
    // Advice such as "never share your OTP" is not a request.
    const lower = t.normalize('NFC').toLowerCase().replace(/\b(never|don'?t|do not|dont|mat|kabhi na)\b[^.\n]{0,25}\b(share|send|tell|give|bhejo|batao)\b[^.\n]{0,40}/g, ' ');
    const found = [];
    for (const [re, points, why] of PHRASES) if (re.test(lower)) found.push({ points, why });
    const links = linksIn(t);
    for (const l of links) found.push(...judgeLink(l));
    // A link plus a pressure phrase is worse than either alone.
    if (links.length && found.some((f) => f.points >= 3 && !/link/.test(f.why))) found.push({ points: 1, why: '' });
    let score = found.reduce((s, f) => s + f.points, 0);
    if (score && ctx.firstContact) score += 1; // a stranger writing first
    const reasons = found.filter((f) => f.why).sort((a, b) => b.points - a.points).map((f) => f.why);
    const level = score >= 4 ? 'danger' : score >= 3 ? 'warn' : 'none';
    return { level, reasons: reasons.slice(0, 3), links: links.map((l) => l.url) };
  }

  /** Something you are about to send that you should think twice about: { why } or null. */
  function assessOutgoing(text) {
    const t = String(text || '');
    const lower = t.toLowerCase();
    if (/\b(otp|one[- ]time (password|code)|verification code|ओटीपी)\b/.test(lower) && /\b\d{4,8}\b/.test(t)) return { why: 'a one-time code (OTP)' };
    if (/\b(cvv|pin)\b[^.\n]{0,15}\b\d{3,6}\b|\b\d{3,6}\b[^.\n]{0,10}\b(cvv|pin)\b/.test(lower)) return { why: 'a PIN or card security code' };
    if (/\b(?:\d[ -]?){15,16}\b/.test(t.replace(/\s{2,}/g, ' ')) && luhn(t.replace(/\D/g, '').slice(0, 19))) return { why: 'a card number' };
    if (/\b\d{4}\s?\d{4}\s?\d{4}\b/.test(t) && /\b(aadhaar|aadhar|uid)\b/i.test(t)) return { why: 'an Aadhaar number' };
    return null;
  }

  function luhn(digits) {
    if (!/^\d{13,19}$/.test(digits)) return false;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum % 10 === 0;
  }

  return { assess, assessOutgoing, linksIn, judgeLink, BRANDS };
}));
