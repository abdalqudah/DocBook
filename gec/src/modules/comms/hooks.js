// Provider webhooks: WhatsApp Cloud API (verification + inbound messages + delivery statuses) and Twilio SMS
// (inbound + status callbacks). Requests are accepted only with a valid provider signature.
const config = require('../../config');
const hooks = require('../hooks.web');
const settings = require('../settings/settings.service');
const sms = require('./sms');
const whatsapp = require('./whatsapp');
const comms = require('./comms.service');

hooks.get('/whatsapp', async (req, res) => {
  const s = await settings.get('integration.whatsapp');
  if (s && s.verify_token && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === s.verify_token) return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
  return res.sendStatus(403);
});

hooks.post('/whatsapp', async (req, res) => {
  try {
    const c = await whatsapp.currentConfig();
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!c || !whatsapp.validSignature(c.appSecret, raw, req.get('x-hub-signature-256'))) return res.sendStatus(401);
    const payload = JSON.parse(raw.toString('utf8') || '{}');
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        const names = Object.fromEntries((v.contacts || []).map((x) => [x.wa_id, x.profile && x.profile.name]));
        for (const m of v.messages || []) {
          const body = m.type === 'text' ? m.text && m.text.body : `[${m.type}]`;
          await comms.receive({ channel: 'whatsapp', from: `+${m.from}`, name: names[m.from] || null, body, providerMessageId: m.id }); // eslint-disable-line no-await-in-loop
        }
        for (const st of v.statuses || []) await comms.updateStatus(st.id, st.status, st.errors && st.errors[0] && st.errors[0].title); // eslint-disable-line no-await-in-loop
      }
    }
    return res.sendStatus(200);
  } catch (e) {
    console.error('[hooks/whatsapp]', e.message); // eslint-disable-line no-console
    return res.sendStatus(200); // acknowledge so the provider does not retry a payload we cannot parse
  }
});

async function twilioParams(req) {
  const c = await sms.currentConfig();
  const params = Object.fromEntries(new URLSearchParams(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''));
  const url = `${config.appUrl}${req.originalUrl}`;
  return c && sms.validSignature(c.authToken, url, params, req.get('x-twilio-signature')) ? params : null;
}

hooks.post('/sms/twilio', async (req, res) => {
  const p = await twilioParams(req);
  if (!p) return res.sendStatus(401);
  await comms.receive({ channel: 'sms', from: p.From, body: p.Body, providerMessageId: p.MessageSid });
  return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

hooks.post('/sms/twilio/status', async (req, res) => {
  const p = await twilioParams(req);
  if (!p) return res.sendStatus(401);
  const map = { delivered: 'delivered', sent: 'sent', failed: 'failed', undelivered: 'failed', read: 'read' };
  await comms.updateStatus(p.MessageSid, map[p.MessageStatus], p.ErrorCode ? `Error ${p.ErrorCode}` : null);
  return res.sendStatus(204);
});

module.exports = hooks;
