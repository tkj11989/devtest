'use strict';

/**
 * Terms of Use, Privacy Notice and the consents people give at sign-up.
 *
 * The wording describes what VartiQ actually does (it is written from the code, not from a template), but it is
 * NOT legal advice: have a lawyer review the texts, the company details and the retention periods before go-live.
 *
 * Company details (name, address, grievance officer...) are set by an administrator in the dashboard (Settings → Legal)
 * or with LEGAL_* environment variables. Change a text? Raise VERSION: everybody is asked to accept again.
 */

const VERSION = '2026-10-24';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DEFAULT_LEGAL = {
  brand: 'VartiQ',
  company: '',
  address: '',
  contactEmail: '',
  grievanceName: '',
  grievanceEmail: '',
  grievancePhone: '',
  city: '',
  hosting: '',
  providers: '',
  paymentProvider: '',
  backupDays: 30,
  responseDays: 15,
  requireForLegacy: false,
};

const FIELD_LIMITS = { brand: 60, company: 120, address: 300, contactEmail: 120, grievanceName: 80, grievanceEmail: 120, grievancePhone: 30, city: 60, hosting: 120, providers: 500, paymentProvider: 60 };

/** Company details to print: settings first, then LEGAL_* environment variables, then a visible placeholder. */
function details(settings = {}, env = process.env) {
  const s = { ...DEFAULT_LEGAL, ...(settings.legal || {}) };
  const pick = (key, envKey, placeholder) => s[key] || env[envKey] || placeholder;
  return {
    brand: s.brand || 'VartiQ',
    company: pick('company', 'LEGAL_COMPANY', '[Company legal name]'),
    address: pick('address', 'LEGAL_ADDRESS', '[Registered address]'),
    contactEmail: pick('contactEmail', 'LEGAL_CONTACT_EMAIL', '[Contact email]'),
    grievanceName: pick('grievanceName', 'LEGAL_GRIEVANCE_NAME', '[Grievance Officer name]'),
    grievanceEmail: pick('grievanceEmail', 'LEGAL_GRIEVANCE_EMAIL', '[Grievance Officer email]'),
    grievancePhone: s.grievancePhone || env.LEGAL_GRIEVANCE_PHONE || '',
    city: pick('city', 'LEGAL_CITY', '[City]'),
    hosting: pick('hosting', 'LEGAL_HOSTING', '[hosting location]'),
    providers: s.providers || env.LEGAL_PROVIDERS || '',
    paymentProvider: s.paymentProvider || env.LEGAL_PAYMENT_PROVIDER || 'Razorpay', // change it with the payment vendor
    backupDays: s.backupDays || 30,
    responseDays: s.responseDays || 15,
    configured: !!((s.company || env.LEGAL_COMPANY) && (s.address || env.LEGAL_ADDRESS) && (s.grievanceName || env.LEGAL_GRIEVANCE_NAME) && (s.grievanceEmail || env.LEGAL_GRIEVANCE_EMAIL)),
  };
}

/** What a person agrees to. `required` ones are needed to have an account; the others are asked for when the feature is first used. */
const CONSENTS = [
  {
    id: 'terms',
    required: true,
    title: 'Terms of Use and Privacy Notice',
    text: 'I have read and agree to the Terms of Use, and I have read the Privacy Notice. I agree that {brand} may collect and use my mobile number, name and the other information described in the Privacy Notice to create my account and run the service.',
  },
  {
    id: 'translation',
    required: false,
    askAt: 'when you first turn on message translation',
    title: 'Message translation',
    text: 'I agree that, for chats where I turn translation on, the text of messages I receive will be sent from my device to a translation service so it can be translated for me. The text is not stored by {brand}. I can switch this off at any time.',
  },
  {
    id: 'kyc',
    required: false,
    askAt: 'when you first ask to be verified',
    title: 'Identity verification',
    text: 'I agree that the ID number I enter will be sent once to an identity verification service to confirm it. {brand} does not store my ID number or any ID details; it only keeps that my account is verified and when.',
  },
];

const consentItem = (id) => CONSENTS.find((c) => c.id === id);

// ---------- the documents ----------
// A section is { id, title, p: [paragraphs], ul: [items], table: { head, rows } }. {brand} {company} ... are filled in when shown.

function privacyNotice() {
  return [
    {
      title: '1. Who we are',
      p: [
        '{company} ("we", "us") runs {brand}, a messaging and community app. We decide why and how your personal data is used (we are the "data fiduciary" under India\'s Digital Personal Data Protection Act, 2023, "DPDP Act").',
        'Registered address: {address}. Contact: {contactEmail}.',
        'Grievance Officer: {grievanceName}, {grievanceEmail}{grievancePhone}. You can write to this person about anything in this notice (see section 9).',
      ],
    },
    {
      title: '2. What personal data we collect, and why',
      p: ['We collect only what the app needs. The table lists each kind of data, what we use it for, and when we collect it.'],
      table: {
        head: ['Data', 'What we use it for', 'When'],
        rows: [
          ['Mobile number', 'To create your account, send you login codes (OTP), let people who know your number find you, and keep your account secure', 'At sign-up and login'],
          ['Email address (optional for a personal account, required for a business)', 'To send you a code to prove the address is yours, and for a business to show its contact email', 'Only if you give one'],
          ['Browsers you log in on (a name such as "Chrome on Windows" and the time)', 'To show you which browsers are logged in to your account and let you sign them out', 'When you log in on a browser with a passcode'],
          ['Name, username, "about" line', 'To show who you are to the people you chat with', 'At sign-up and when you edit your profile'],
          ['Profile photos you add (a picture and a small thumbnail of each), and who you let see them', 'To show your picture next to your name to the people you choose (everyone, your contacts, or nobody; for people under 18, only people they chat with)', 'When you add a photo'],
          ['Reports about a photo (who reported it, why, when)', 'To review reported photos and keep people safe', 'When someone reports a photo'],
          ['Date of birth', 'To apply our age rules, to know when a young person needs a parent or guardian, and to end the parent\'s controls when the person turns 18', 'At sign-up'],
          ['For people under 18: the name, relationship, mobile number and/or email of a parent or guardian; whether and when they agreed; and what they allow (calls, location sharing, being found by new people, public channels)', 'To ask the parent or guardian for permission, to give them the controls, and to contact them about the account', 'At sign-up, and when the parent or guardian decides'],
          ['Email address (business accounts)', 'To verify a business account and contact it about its account', 'At business sign-up'],
          ['Business details you add: category, opening hours, address, website, greeting and away messages, product catalogue with prices', 'To show your business profile to people who view it (these are visible to them)', 'When you set up a business profile'],
          ['Messages: the text, the sender, the chat, the time, delivery and read status. Voice notes (audio)', 'To deliver your messages and show your chats on all your devices', 'When you send a message'],
          ['Chats you belong to and the members of your groups', 'To deliver messages to the right people', 'When you start or join a chat'],
          ['Status updates (text or photo)', 'To show them to your contacts for 24 hours, then they are removed', 'When you post one'],
          ['Channel posts and channels you create or follow', 'Channels are public: anyone can read them and see who owns them', 'When you create, post to or follow a channel'],
          ['Who viewed your profile and when (last view date only)', 'To show you the people who looked at your profile. Kept for 90 days. You can switch this off, which also erases your list', 'When someone opens your profile, if both of you have the setting on'],
          ['Call history: who, when, call type, how long; whether a call was recorded', 'To show your call history. The call itself is not stored by us', 'During and after a call'],
          ['Device information: a name for each device, and the public encryption key of each device', 'To encrypt your messages for your devices and let you manage them', 'When you first use the app on a device'],
          ['Secret code for locked or hidden chats (stored only as a one-way hash); fingerprint or face unlock credentials (public key only; your fingerprint or face never leaves your device)', 'To protect chats you choose to lock or hide', 'When you turn these on'],
          ['Notification settings of each device you turn notifications on for: an address at your browser maker\'s push service with its keys, a short description of the browser, and what you chose to be notified about', 'To send you a notification for a new message or call when the app is closed. A notification says who and what kind ("Asha: New message", "Incoming video call"), never the message itself', 'When you turn notifications on'],
          ['A location you choose to share: coordinates and how accurate they are. For a live location, only the latest position while you are sharing', 'To show it to the people in the chat you shared it with. We never read your location in the background or when you are not sharing', 'Only when you tap Share location'],
          ['Your settings: theme, translation languages per chat, blocked people, privacy options, language', 'To keep the app the way you set it on all your devices', 'When you change them'],
          ['Verification status (yes or no and the date)', 'To show the Verified badge. We do NOT store your ID number or any ID details (see section 4)', 'After you verify'],
          ['Premium subscription: plan, period, and for each payment the amount, date, and the payment provider\'s payment number (a receipt)', 'To give you Premium features, show your receipts, and keep accounting records. Card, UPI and bank details go to the payment provider ({paymentProvider}) and never reach us', 'When you buy Premium'],
          ['Reports you make about a channel (reporter, channel, reason)', 'To review reports and keep the service safe', 'When you report something'],
          ['Technical and security data: IP address and request details processed by our hosting and network providers; one-time login codes (kept for a few minutes, only as a hash)', 'To deliver the service, prevent abuse and keep it secure', 'Whenever you use the app'],
        ],
      },
      ul: [
        'We do not read your phone\'s contact book and we do not upload it.',
        'We do not sell your personal data.',
      ],
    },
    {
      title: '3. Your messages and end-to-end encryption',
      p: [
        'Messages and voice notes that you type or record in the {brand} web app are end-to-end encrypted. They are encrypted on your device and can only be read on the devices of the people in that chat. Our servers store the encrypted text. Our staff and administrators cannot read it.',
        'Some things are not end-to-end encrypted, and we want you to know which:',
      ],
      ul: [
        'Messages sent through the {brand} developer API (for example by a bot or another platform), and automatic business replies, are stored as readable text.',
        'Public channel posts, status updates, profile and business details, group names, and the names of people in a chat are visible to our servers (and to the people allowed to see them).',
        'Locations you share in the web app are end-to-end encrypted like messages. A location shared through the developer API is stored as readable coordinates.',
        'Profile photos are not end-to-end encrypted: the people you allow can see them, and our moderators can see a photo that has been reported.',
        'If you turn on message translation for a chat, your app sends the text of the messages you receive to a translation service so they can be translated (see section 4).',
        'We can see who talks to whom, when, and how often (this is "metadata"), because the service needs it to deliver messages.',
        'If you lose all your devices and the encryption keys on them, older encrypted messages may no longer be readable by you.',
      ],
    },
    {
      title: '4. Who we share data with',
      p: [
        'We share personal data only as needed to run the service, and only with the following. We do not sell personal data.',
      ],
      ul: [
        'Other users: what the app is designed to show them: your name, "about" line, whether you are online and when you were last seen (you can limit this), your business profile, public channel posts, status updates, and messages you send to them.',
        'Service providers (data processors) who work for us under contract: a text-message and email provider (to send login codes); a cloud hosting and network provider, including a content delivery and security provider such as Cloudflare if we use one; a database provider; a relay (TURN) provider that helps voice and video calls connect when a direct connection is not possible. Call audio and video are encrypted in transit.',
        'An identity verification provider, only if you choose to verify. Your ID number is sent to it once to confirm it, together with the one-time code. {brand} does not store your ID number or any ID details; we keep only that you are verified and when.',
        '{paymentProvider} (our payment provider), only if you buy Premium. You pay on its own page, which handles your card, UPI or bank details; we receive a confirmation with the amount and a payment number, and nothing else about how you paid except the kind of method (for example UPI or card).',
        'The push services of browser makers (Google, Mozilla, Apple, Microsoft), only if you turn notifications on. Notifications pass through the push service of your browser. It can see that a notification was sent to your device and when, but a notification carries no message text.',
        'A map service, only if you tap "Open in map" on a location someone shared: your browser or map app opens with that position, and the map service you use can then see it. {brand} itself loads no maps.',
        'A parent or guardian, if you are under 18: they see your name and username, can switch calls, location sharing, being found by new people and public channels on or off, and can disable or delete your account. They cannot read your messages, which are end-to-end encrypted.',
        'A translation provider, only if you turn translation on for a chat. The text of messages you ask to be translated is sent to it and handed back. {brand} does not store or log these texts.',
        'Authorities, when the law requires it or to protect people from harm, for example an order from a court or a government body.',
        'A buyer or successor, if our business is sold or merged. Your data would stay protected by this notice.',
      ],
    },
    {
      title: '5. Voice and video calls, and call recording',
      p: [
        'Calls go directly between devices where possible, or through a relay server that passes the encrypted media along. We do not record or store calls.',
        'Any person on a call can ask to record it, and recording starts only after every other person on the call has agreed. The recording is made and saved on the device of the person who asked, and it is never sent to us. Please respect other people\'s privacy and the laws that apply to recording.',
      ],
    },
    {
      title: '6. How long we keep data',
      table: {
        head: ['Data', 'How long'],
        rows: [
          ['Account data (profile, settings, contact details)', 'Until you delete your account; then erased within 24 hours'],
          ['Messages and voice notes', 'Until you or the sender delete them, or the chat\'s disappearing-message timer removes them; the content of the messages you sent is erased within 24 hours of deleting your account (see section 7)'],
          ['Status updates', '24 hours'],
          ['Notification settings of a device', 'Until you turn notifications off on that device, log out, or delete your account (and removed at once if the browser says the device is gone)'],
          ['A shared location', 'A location you share once is a message and is kept like one. A live location keeps only the latest position (no trail), and it is erased when the time you chose is up (at most 8 hours) or when you tap Stop sharing; the chat then shows "Live location ended"'],
          ['Profile photos', 'Until you remove them or delete your account (then erased within 24 hours). A photo that was reported and removed by us is deleted too'],
          ['Reports about a photo', 'Until a moderator has decided, then deleted'],
          ['A parent or guardian\'s details (for someone under 18)', 'Until the young person turns 18, when the contact details are erased (we keep only that a parent or guardian agreed, and when), or until the account is deleted'],
          ['Profile-view list', '90 days (only the last view date is kept), or until you switch the setting off'],
          ['Login codes (OTP)', 'A few minutes; kept only as a one-way hash'],
          ['Saved chats on your own device', 'Until you clear them or log out'],
          ['Payment records (amount, date, plan, payment number)', 'As long as the law requires us to keep accounting records, also after you delete your account (without your name or contact details)'],
          ['Basic record of a deleted account: username, registration date, when it was permanently disabled, what you accepted (which version, when), any subscription and verification record. No chats, media or personal data', 'Kept after you delete your account, for as long as needed to prove consent, prevent misuse (for example someone taking over a username) and meet legal and accounting duties'],
          ['Backups', 'Erased data may remain in our backups for up to {backupDays} days, then they are overwritten'],
          ['Security and audit logs', 'For as long as needed to keep the service secure, and as the law requires'],
        ],
      },
    },
    {
      title: '7. Your rights and choices',
      p: ['Under the DPDP Act (and similar laws) you have rights over your personal data. In the app, go to Profile → Privacy and consent:'],
      ul: [
        'Access: see what data we hold about you and download a copy ("Download my data").',
        'Correction: change your name, "about" line and other profile details yourself at any time.',
        'Deleting your account: choose "Delete my account". Your account is permanently disabled and your login stops working immediately. Within 24 hours we erase your chats and messages you sent (including voice notes), photos and other media, and your personal data: profile, mobile number, email, encryption keys and devices, statuses, channels, product catalogue, developer keys and settings. You leave your groups. We keep only a basic inactive record that the account existed (see section 6). Messages other people received remain on their own devices only as far as they already saved them. You can sign up again at any time; that creates a brand-new account with a new registration date and none of the old data.',
        'Withdraw consent: you can withdraw the optional consents (translation, identity verification) at any time. Withdrawing is as easy as giving it. If you withdraw your consent to this notice and the Terms, we can no longer provide the service: delete your account.',
        'Grievance redressal: contact our Grievance Officer (section 9). If you are not satisfied, you may complain to the Data Protection Board of India, once it is in place.',
        'Nomination: you may nominate another person to exercise these rights for you if you die or become unable to.',
      ],
      p2: ['We reply to rights requests within {responseDays} days, or sooner if the law requires.'],
    },
    {
      title: '8. Security, storage and transfers',
      ul: [
        'Connections to {brand} use HTTPS. Messages typed in the web app are end-to-end encrypted. Login codes and secret codes are stored only as one-way hashes.',
        'Access to administration tools is limited to authorised staff, protected by separate sign-in, and every administrator action is recorded in an audit log. Administrators can see account details (name, username, mobile number, email, account status, and counts such as the number of chats) to run and secure the service, and they can suspend accounts or remove reported channels. They cannot read end-to-end encrypted messages.',
        'Your data is stored on servers located in: {hosting}. Our providers may process data in other countries; where they do, we require them to protect it as this notice describes and as the law requires.',
        'If a breach of personal data happens, we will tell the Data Protection Board of India and the people affected, as the law requires.',
      ],
    },
    {
      title: '9. Contact and complaints',
      p: [
        'Grievance Officer: {grievanceName}\nEmail: {grievanceEmail}{grievancePhone}\n{company}, {address}',
        'You can also write to {contactEmail}.',
      ],
    },
    {
      title: '10. Cookies and storage on your device',
      p: [
        'The {brand} web app uses your browser\'s storage only for things the app needs: to keep you logged in, to keep your device\'s encryption key, to remember settings such as your theme, and (if you leave it on) to keep a copy of your chats so they open faster. You can clear this in Profile → Chats on this device, and it is removed when you log out. If you turn on notifications, a small background script (a service worker) is added to your browser so notifications can be shown. Your browser asks you before the app may send notifications or read your location, and you can change both in your browser\'s site settings at any time.',
      ],
    },
    {
      title: '11. Children and young people',
      p: [
        '{brand} is for people aged 8 and over. We ask for your date of birth when you sign up, and we do not create accounts for younger children.',
        'If you are 8 to 17 you must give the name and a mobile number or email of a parent or guardian. We send them a private link. Your account opens when they agree, and until then you cannot use it. We do this because a young person\'s parent or guardian should decide whether and how their child uses the service.',
        'A parent or guardian can, with that link: agree or decline; switch calls, location sharing, being found by new people and public channels on or off; disable your account for a while; or delete it (section 7). By default a young person\'s account does not share location and cannot be found or started chats with by people they are not already chatting with. Parents and guardians cannot read messages.',
        'We never show advertising to anyone, and we do not use children\'s data for tracking or profiling. At 18 the controls end and we erase the parent\'s or guardian\'s contact details.',
        'If you are a parent or guardian and did not agree to this, or the person is not your child, open the link and choose to delete the account, or write to us (section 9).',
      ],
    },
    {
      title: '12. Changes to this notice',
      p: [
        'We will update this notice when our practices change. The version date is at the top. If a change is important, we will tell you in the app and ask you to accept again before you keep using it.',
      ],
    },
  ];
}

function termsOfUse() {
  return [
    {
      title: '1. Agreement',
      p: [
        'These Terms of Use are an agreement between you and {company} ("we", "us") about your use of {brand} (the "service"), including its web app, mobile apps, admin tools and developer API. By creating an account or using the service you agree to these Terms and confirm you have read the Privacy Notice. If you do not agree, do not use the service.',
      ],
    },
    {
      title: '2. Who can use {brand}',
      ul: [
        'You must be at least 8 years old. If you are under 18 you need the permission of a parent or guardian: you give their details when you sign up, we send them a private link, and your account opens when they agree. They can switch some features off (calls, location sharing, being found by new people, public channels), disable the account, or delete it. At 18 these controls end.',
        'You must give a mobile number that you own and can receive codes on. A business account also needs a working email address and a correct business category.',
        'To log in on a browser (a computer), you make a one-time passcode in the app on the phone you signed up on and type it with your mobile number. The passcode lasts 2 minutes and works once. While that phone is logged in, a browser cannot log in with an SMS code. You can sign browsers out in the app.',
        'One person, one account per mobile number. You are responsible for what happens under your account, so keep your login codes, secret codes and devices safe, and tell us if you think someone else has access.',
      ],
    },
    {
      title: '3. How you may use it',
      p: ['You agree not to:'],
      ul: [
        'break the law, or ask or help anyone else to;',
        'send spam, scams, unwanted bulk messages or misleading offers, or use the service to harass, threaten, abuse or exploit anyone;',
        'post or send unlawful content, including content that sexually exploits children, promotes violence or hatred, infringes someone\'s rights, or spreads malware;',
        'pretend to be another person or business, or misuse the Verified badge;',
        'record a call without the agreement of everyone on it, or use any recording unlawfully;',
        'upload a profile photo that shows nudity or sexual content, violence, or a child in a way that could harm them; that you do not have the right to use; or that shows another person without their agreement;',
        'use location sharing to follow, track, stalk or harass anyone, or share another person\'s location without their agreement;',
        'try to break, probe, overload or get around the security of the service, or collect other people\'s data in bulk;',
        'sell or share access to your account.',
      ],
    },
    {
      title: '4. Your content',
      p: [
        'You own what you send and post. You give us the limited permission we need to store it, deliver it and show it to the people you send it to or make it visible to (for example a public channel or a business profile). You are responsible for your content. Content in public channels and business profiles can be seen by anyone who opens them.',
      ],
    },
    {
      title: '5. Channels, business accounts and Verified badge',
      ul: [
        'Channel owners and admins are responsible for what they post. Anyone can report a channel; we may remove content or channels and suspend accounts that break these Terms.',
        'Business accounts must be accurate and lawful: products, prices, hours and contact details must be real. We do not guarantee, endorse or take part in any sale between a business and a customer.',
        'The Verified badge means the account holder completed an identity check with a verification provider. It is not an endorsement of the person, the business or what they say.',
      ],
    },
    {
      title: '6. Premium',
      ul: [
        'Premium is bought in advance for a day, a month or a year. It does not renew by itself; buying again extends it. Prices are shown before you pay and may change for future purchases.',
        'Premium also lets a parent or guardian of a young person under 18 change that person\'s parental controls (calls, location sharing, being found by new people, public channels). Agreeing to a child\'s account, disabling it and deleting it are always free, and a child\'s safe default settings apply without Premium.',
        'Premium lets you keep more profile photos (5 instead of 2 by default) and change your picture automatically every 7 days.',
        'Payments are handled by a payment provider. {brand} never sees your card or bank details.',
        'Refunds: [describe your refund policy here, for example "Premium is not refundable once activated, except where the law requires"]. This is for your lawyer to confirm.',
        'When Premium ends, the extra features stop; your chats and data stay, within the free limits.',
      ],
    },
    {
      title: '7. Calls and recording',
      p: [
        'Voice and video calls depend on your network and device. Emergency calls are not supported; use your phone\'s regular emergency number. Recording a call needs the agreement of everyone on the call, given in the app. You alone are responsible for any recording you make and for how you use it.',
      ],
    },
    {
      title: '8. Developer API',
      p: [
        'The developer API (API keys and webhooks) is off unless an administrator turns it on. If you use it, you are responsible for the software you connect, for keeping your keys secret, and for following these Terms and the law. Messages sent through the API are not end-to-end encrypted.',
      ],
    },
    {
      title: '9. Suspending or ending accounts',
      p: [
        'You may delete your account at any time in the app (Profile \u2192 Privacy and consent). Your account is then permanently disabled: your login stops working at once, and your chats, media and personal data are erased within 24 hours (a basic record that the account existed is kept; see the Privacy Notice). You can sign up again as a new account. We may suspend or end an account, with or without notice, if you break these Terms or the law, if we are required to, or to protect people or the service. We will tell you why where we can.',
      ],
    },
    {
      title: '10. Disclaimers and limits',
      p: [
        'The service is provided "as is" and "as available". We work hard to keep it running and safe, but we cannot promise it will always be available, error-free or that messages will always be delivered. To the fullest extent the law allows, we are not liable for indirect or consequential loss, and our total liability to you for anything connected with the service is limited to [amount: for your lawyer to confirm, for example the amount you paid us in the last 12 months]. Nothing in these Terms limits liability that cannot be limited by law.',
      ],
    },
    {
      title: '11. Changes',
      p: [
        'We may change these Terms or the service. If a change is important, we will tell you in the app and ask you to accept again. If you keep using the service after a change takes effect, that means you accept it.',
      ],
    },
    {
      title: '12. Law and contact',
      p: [
        'These Terms are governed by the laws of India. The courts at {city} have jurisdiction, subject to any rights you have under consumer protection law. Questions: {contactEmail}. Complaints: our Grievance Officer, {grievanceName}, {grievanceEmail}.',
      ],
    },
  ];
}

const DOCS = {
  privacy: { title: 'Privacy Notice', sections: privacyNotice },
  terms: { title: 'Terms of Use', sections: termsOfUse },
};

const fill = (text, d) => String(text)
  .replace(/\{brand\}/g, d.brand)
  .replace(/\{company\}/g, d.company)
  .replace(/\{address\}/g, d.address)
  .replace(/\{contactEmail\}/g, d.contactEmail)
  .replace(/\{grievanceName\}/g, d.grievanceName)
  .replace(/\{grievanceEmail\}/g, d.grievanceEmail)
  .replace(/\{grievancePhone\}/g, d.grievancePhone ? `, phone ${d.grievancePhone}` : '')
  .replace(/\{city\}/g, d.city)
  .replace(/\{hosting\}/g, d.hosting)
  .replace(/\{backupDays\}/g, String(d.backupDays))
  .replace(/\{responseDays\}/g, String(d.responseDays));

/** The document as plain data (for mobile apps): `[{ title, paragraphs, bullets, table }]`. */
function documentData(id, d) {
  const doc = DOCS[id];
  if (!doc) return null;
  return {
    id,
    title: doc.title,
    version: VERSION,
    sections: doc.sections().map((s) => ({
      title: fill(s.title, d),
      paragraphs: [...(s.p || []), ...(s.p2 || [])].map((t) => fill(t, d)),
      bullets: (s.ul || []).map((t) => fill(t, d)),
      table: s.table ? { head: s.table.head, rows: s.table.rows.map((r) => r.map((c) => fill(c, d))) } : null,
    })),
  };
}

const paragraphHtml = (t) => `<p>${esc(t).replace(/\n/g, '<br>')}</p>`;

/** A complete, self-contained HTML page for a document. */
function documentHtml(id, d) {
  const data = documentData(id, d);
  if (!data) return null;
  const body = data.sections.map((s) => {
    const parts = [`<h2>${esc(s.title)}</h2>`];
    if (s.paragraphs.length) parts.push(...s.paragraphs.slice(0, 1).map(paragraphHtml));
    if (s.table) {
      parts.push(`<div class="scroll"><table><thead><tr>${s.table.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${s.table.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    }
    if (s.bullets.length) parts.push(`<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`);
    if (s.paragraphs.length > 1) parts.push(...s.paragraphs.slice(1).map(paragraphHtml));
    return parts.join('\n');
  }).join('\n');
  const other = id === 'privacy' ? ['terms', 'Terms of Use'] : ['privacy', 'Privacy Notice'];
  const setup = d.configured ? '' : '<p class="warn">This page still shows placeholders in [square brackets]. An administrator must fill in the company details (Admin → Settings → Legal) before launch.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(data.title)} · ${esc(d.brand)}</title>
<style>
  :root { --bg: #fff; --text: #0B1A33; --muted: #5B6B82; --line: #E1E8F2; --link: #0558B3; --soft: #F1F5FB; --warn: #B84A00; }
  @media (prefers-color-scheme: dark) { :root { --bg: #07101F; --text: #E6EDF7; --muted: #93A4BE; --line: #1C2C4D; --link: #4DA3FF; --soft: #0C1730; --warn: #FF8A3D; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 820px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 28px; margin: 8px 0 4px; } h2 { font-size: 19px; margin: 28px 0 6px; }
  .meta { color: var(--muted); font-size: 14px; } a { color: var(--link); }
  .scroll { overflow-x: auto; } table { border-collapse: collapse; width: 100%; font-size: 14.5px; margin: 8px 0; }
  th, td { text-align: left; vertical-align: top; padding: 8px 10px; border: 1px solid var(--line); } th { background: var(--soft); }
  .warn { color: var(--warn); border: 1px solid var(--warn); padding: 8px 12px; border-radius: 8px; }
  nav a { margin-right: 14px; }
</style>
</head>
<body>
<main>
<nav><a href="/">← ${esc(d.brand)}</a> <a href="/legal/${other[0]}">${esc(other[1])}</a></nav>
<h1>${esc(data.title)}</h1>
<p class="meta">${esc(d.brand)} · version ${esc(VERSION)} · ${esc(d.company)}</p>
${setup}
${body}
</main>
</body>
</html>`;
}

/** What the sign-up screen and mobile apps need: versions, the consent texts, links, and who is responsible. */
function summary(settings, env = process.env) {
  const d = details(settings, env);
  return {
    version: VERSION,
    company: { name: d.company, address: d.address, contactEmail: d.contactEmail, grievanceOfficer: { name: d.grievanceName, email: d.grievanceEmail, phone: d.grievancePhone || null } },
    configured: d.configured,
    documents: Object.entries(DOCS).map(([id, doc]) => ({ id, title: doc.title, url: `/legal/${id}`, json: `/api/v1/legal/${id}` })),
    consents: CONSENTS.map((c) => ({ id: c.id, required: c.required, title: c.title, text: fill(c.text, d), askAt: c.askAt || null })),
  };
}

module.exports = { VERSION, DEFAULT_LEGAL, FIELD_LIMITS, CONSENTS, consentItem, details, documentData, documentHtml, summary, fill, esc };
