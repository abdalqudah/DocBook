// SMS channel. Provider adapter: Twilio Programmable Messaging (REST, no SDK). Credentials come from
// Settings → SMS (encrypted). Without them the channel reports "not connected" — nothing is pretended to be sent.
const crypto = require('crypto');
const config = require('../../config');
const settings = require('../settings/settings.service');
const secrets = require('../../core/secrets');
const { toE164 } = require('./phone');

let testOutbox = null;
const useTestOutbox = (box) => { testOutbox = box; };

async function currentConfig() {
  const s = await settings.get('integration.sms');
  if (!s || !s.enabled || !s.account_sid || !s.auth_token_enc || !s.from_number) return null;
  const token = secrets.decrypt(s.auth_token_enc);
  if (!token) return null;
  return { provider: s.provider || 'twilio', accountSid: s.account_sid, authToken: token, from: s.from_number, defaultCode: s.default_country_code || '' };
}

/** Sends one SMS. Resolves { sent, messageId?, reason?, to }. Never throws for provider errors. */
async function send({ to, body }) {
  const c = await currentConfig();
  if (!c) return { sent: false, reason: 'not_configured' };
  const number = toE164(to, c.defaultCode);
  if (!number) return { sent: false, reason: 'invalid_number' };
  if (testOutbox) { testOutbox.push({ channel: 'sms', to: number, body }); return { sent: true, messageId: `SMtest${testOutbox.length}`, to: number }; }
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: number, From: c.from, Body: String(body).slice(0, 1600), StatusCallback: `${config.appUrl}/hooks/sms/twilio/status` }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { sent: false, reason: String(j.message || `HTTP ${res.status}`).slice(0, 300), to: number };
    return { sent: true, messageId: j.sid, to: number };
  } catch (e) {
    return { sent: false, reason: e.message.slice(0, 300), to: number };
  }
}

/** Twilio request signature: HMAC-SHA1 of the full URL + the POST parameters sorted by name. */
function validSignature(authToken, url, params, signature) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  const a = Buffer.from(expected); const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { send, currentConfig, validSignature, useTestOutbox };
