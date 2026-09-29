// Inbound provider webhooks — mounted in src/app.js BEFORE the body parsers, session and CSRF check, because
// providers post without a session and the WhatsApp signature is computed over the raw body.
//   GET  /hooks/whatsapp/<key>   Meta verification (hub.mode=subscribe, hub.verify_token, hub.challenge)
//   POST /hooks/whatsapp/<key>   messages & statuses, signed with X-Hub-Signature-256 (the clinic's app secret)
//   GET|POST /hooks/sms/<key>    generic SMS replies: from/From/sender/msisdn + text/Text/Body/body/message
// <key> is a random per-clinic value shown in Settings → Messaging. Only STOP / START replies, the "Confirm"
// quick-reply button and delivery statuses are acted on; message texts are never stored.
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const knex = require('../../db/knex');
const msg = require('./messaging.service');

const router = express.Router();
const limiter = rateLimit({ windowMs: 60_000, limit: config.isTest ? 5000 : 600, standardHeaders: true, legacyHeaders: false });
router.use(limiter);

const safe = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error('[messaging] webhook failed:', err.message); // eslint-disable-line no-console
  if (!res.headersSent) res.status(500).json({ ok: false });
});

router.get('/whatsapp/:key', safe(async (req, res) => {
  const cfg = await msg.configByHook('wa_hook_key', req.params.key);
  if (!cfg || req.query['hub.mode'] !== 'subscribe' || !cfg.wa_verify_token || String(req.query['hub.verify_token'] || '') !== cfg.wa_verify_token) return res.sendStatus(403);
  await knex('clinic_messaging').where({ business_id: cfg.business_id }).update({ wa_verified_at: new Date() });
  return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
}));

router.post('/whatsapp/:key', express.raw({ type: '*/*', limit: '1mb' }), safe(async (req, res) => {
  const cfg = await msg.configByHook('wa_hook_key', req.params.key);
  if (!cfg) return res.sendStatus(404);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!msg.validSignature(cfg, raw, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.sendStatus(400); }
  await msg.handleWhatsApp(cfg, payload);
  return res.sendStatus(200);
}));

const pick = (o, keys) => { for (const k of keys) if (o && o[k]) return String(o[k]); return ''; };
const smsHook = safe(async (req, res) => {
  const cfg = await msg.configByHook('sms_inbound_key', req.params.key);
  if (!cfg) return res.sendStatus(404);
  const src = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  await msg.handleSmsReply(cfg, pick(src, ['from', 'From', 'sender', 'msisdn', 'Sender']), pick(src, ['text', 'Text', 'Body', 'body', 'message', 'Message']));
  return res.status(200).json({ ok: true });
});
router.get('/sms/:key', smsHook);
router.post('/sms/:key', express.urlencoded({ extended: false, limit: '64kb' }), express.json({ limit: '64kb' }), smsHook);

module.exports = router;
