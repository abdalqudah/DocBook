// Addresses the payment provider calls (mounted in src/app.js BEFORE the body parsers, sessions and CSRF):
//   POST /pay/callback/paytabs/:pid   PayTabs server → DocBook (JSON, "Signature" header over the raw body)
//   POST /pay/return/paytabs/:pid     the patient's browser, sent back by PayTabs (form post with a signature)
// Neither is trusted on its own: both end in a server-side query to PayTabs (payments.service.verify).
// Everything else under /pay goes on to the normal routers (next()).
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const pay = require('./payments.service');

const router = express.Router();
const limiter = rateLimit({ windowMs: 60_000, limit: config.isTest ? 5000 : 120, standardHeaders: true, legacyHeaders: false });
const raw = express.raw({ type: () => true, limit: '64kb' });
const env = (req) => ({ ip: req.ip, userAgent: req.get('user-agent'), baseUrl: require('../../middleware/web').publicBase(req) }); // eslint-disable-line global-require

router.post('/callback/paytabs/:pid', limiter, raw, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const out = await pay.paytabsCallback(req.params.pid, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.get('signature') || '', env(req));
    return res.status(out.ok ? 200 : out.status).json({ ok: out.ok, ...(out.result ? { result: out.result } : {}) });
  } catch (e) {
    console.error('[payments] PayTabs callback:', e.message); // eslint-disable-line no-console
    return res.status(503).json({ ok: false }); // PayTabs retries failed callbacks
  }
});

/** Where the patient goes after the provider: back to their consultation page with the verified result. */
async function backToPatient(res, payment, result) {
  if (!payment) return res.status(404).type('text/plain').send('Not found');
  const { forAppointment } = require('../telehealth/telehealth.service'); // eslint-disable-line global-require
  const { token } = await forAppointment({ businessId: payment.business_id, locale: 'ar', permissions: new Set() }, payment.appointment_id);
  const r = ['paid', 'already'].includes(result) ? 'paid' : result === 'pending' ? 'pending' : 'failed';
  return res.redirect(303, `/c/${token}?pay=${r}`);
}

router.post('/return/paytabs/:pid', limiter, express.urlencoded({ extended: false, limit: '32kb' }), async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  try {
    const out = await pay.paytabsReturn(req.params.pid, req.body || {}, env(req));
    return await backToPatient(res, out.payment, out.result);
  } catch (e) {
    console.error('[payments] PayTabs return:', e.message); // eslint-disable-line no-console
    return res.status(500).type('text/plain').send('Something went wrong. Please open your booking link again.');
  }
});

// Card payments to the platform (clinic subscriptions, rep plans and ads) — same checks, platform PayTabs profile.
router.post('/platform/callback/:pid', limiter, raw, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const out = await require('../platformpay/platformpay.service').callback(req.params.pid, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.get('signature') || ''); // eslint-disable-line global-require
    return res.status(out.ok ? 200 : out.status).json({ ok: out.ok, ...(out.result ? { result: out.result } : {}) });
  } catch (e) {
    console.error('[platform pay] callback:', e.message); // eslint-disable-line no-console
    return res.status(503).json({ ok: false });
  }
});
router.post('/platform/return/:pid', limiter, express.urlencoded({ extended: false, limit: '32kb' }), async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const ppay = require('../platformpay/platformpay.service'); // eslint-disable-line global-require
  try {
    const out = await ppay.returned(req.params.pid, req.body || {});
    if (!out.payment) return res.status(404).type('text/plain').send('Not found');
    return res.redirect(303, ppay.backUrl(out.payment, out.result));
  } catch (e) {
    console.error('[platform pay] return:', e.message); // eslint-disable-line no-console
    return res.status(500).type('text/plain').send('Something went wrong. Please open your billing page again.');
  }
});

module.exports = router;
module.exports.backToPatient = backToPatient;
