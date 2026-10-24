const config = require('../config');

// Phone numbers are stored as 10-digit Indian mobiles; providers want E.164.
const toE164 = (phone) => `+91${phone}`;

const providers = {
  async console(phone, message) {
    console.log(`[SMS -> ${toE164(phone)}] ${message}`);
  },

  async twilio(phone, message) {
    const { accountSid, authToken, from } = config.twilio;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: toE164(phone), From: from, Body: message }),
    });
    if (!res.ok) throw new Error(`Twilio SMS failed: ${res.status} ${await res.text()}`);
  },

  // MSG91 (India) requires DLT-approved templates; the message text is passed
  // as the template variable `message`.
  async msg91(phone, message, kind) {
    const { authKey, senderId, otpTemplateId, bookingTemplateId } = config.msg91;
    const res = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: { authkey: authKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template_id: kind === 'otp' ? otpTemplateId : bookingTemplateId,
        sender: senderId,
        recipients: [{ mobiles: `91${phone}`, message }],
      }),
    });
    if (!res.ok) throw new Error(`MSG91 SMS failed: ${res.status} ${await res.text()}`);
  },
};

async function sendSms(phone, message, kind = 'info') {
  const send = providers[config.smsProvider];
  if (!send) throw new Error(`Unknown SMS_PROVIDER "${config.smsProvider}"`);
  return send(phone, message, kind);
}

module.exports = { sendSms };
