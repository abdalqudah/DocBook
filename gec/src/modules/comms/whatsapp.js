// WhatsApp channel. Provider adapter: WhatsApp Business Cloud API (Meta Graph API). Credentials come from
// Settings → WhatsApp (encrypted). WhatsApp only allows free-text messages within 24 hours of the person's last
// message; outside that window Meta requires an approved template, and the API error is shown to the sender.
// Without credentials staff can still use "Open in WhatsApp" (wa.me click-to-chat), which is logged as manual.
const crypto = require('crypto');
const settings = require('../settings/settings.service');
const secrets = require('../../core/secrets');
const { toE164 } = require('./phone');

const GRAPH = 'https://graph.facebook.com/v21.0';
let testOutbox = null;
const useTestOutbox = (box) => { testOutbox = box; };

async function currentConfig() {
  const s = await settings.get('integration.whatsapp');
  if (!s || !s.enabled || !s.phone_number_id || !s.access_token_enc) return null;
  const token = secrets.decrypt(s.access_token_enc);
  if (!token) return null;
  return { phoneNumberId: s.phone_number_id, token, appSecret: s.app_secret_enc ? secrets.decrypt(s.app_secret_enc) : null, verifyToken: s.verify_token || null, defaultCode: s.default_country_code || '' };
}

async function send({ to, body }) {
  const c = await currentConfig();
  if (!c) return { sent: false, reason: 'not_configured' };
  const number = toE164(to, c.defaultCode);
  if (!number) return { sent: false, reason: 'invalid_number' };
  if (testOutbox) { testOutbox.push({ channel: 'whatsapp', to: number, body }); return { sent: true, messageId: `wamid.test${testOutbox.length}`, to: number }; }
  try {
    const res = await fetch(`${GRAPH}/${encodeURIComponent(c.phoneNumberId)}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: number.slice(1), type: 'text', text: { preview_url: true, body: String(body).slice(0, 4096) } }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { sent: false, reason: String((j.error && j.error.message) || `HTTP ${res.status}`).slice(0, 300), to: number };
    return { sent: true, messageId: j.messages && j.messages[0] && j.messages[0].id, to: number };
  } catch (e) {
    return { sent: false, reason: e.message.slice(0, 300), to: number };
  }
}

/** X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). */
function validSignature(appSecret, rawBody, header) {
  if (!appSecret || !header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected); const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** wa.me click-to-chat link (works without any API account). */
function chatLink(phone, text, defaultCode = '') {
  const n = toE164(phone, defaultCode);
  return n ? `https://wa.me/${n.slice(1)}${text ? `?text=${encodeURIComponent(text)}` : ''}` : null;
}

module.exports = { send, currentConfig, validSignature, chatLink, useTestOutbox };
