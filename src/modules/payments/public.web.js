// The patient's payment pages (/pay/…, public, noindex; the unguessable payment id is the only key):
//   GET /pay/:pid                     PayTabs: "continue to the secure payment page" (auto-redirect with JS)
//                                     HyperPay: the COPYandPAY card widget (their script + frames allowed on this page only)
//   GET /pay/return/hyperpay/:pid     HyperPay sends the browser back here (?id=<checkout id>) → verified on the server
// PayTabs' callback and return are in hooks.web.js (they must bypass CSRF and need the raw body).
const { siteLook } = require('../site/portal.web');
const express = require('express');
const rateLimit = require('express-rate-limit');
const knex = require('../../db/knex');
const config = require('../../config');
const { wrap } = require('../../routes/helpers');
const { publicBase } = require('../../middleware/web');
const businesses = require('../businesses/business.service');
const pay = require('./payments.service');
const { backToPatient } = require('./hooks.web');

const router = express.Router();
const limiter = rateLimit({ windowMs: 10 * 60_000, limit: config.isTest ? 5000 : 120, standardHeaders: true, legacyHeaders: false });
const env = (req) => ({ ip: req.ip, userAgent: req.get('user-agent'), baseUrl: publicBase(req) });

/** CSP for the HyperPay widget page: their script, frames, XHR and styles — only on this page. */
function widgetCsp(res, origin) {
  const cur = String(res.getHeader('Content-Security-Policy') || '');
  if (!cur) return;
  const drop = /^(script-src|style-src|frame-src|connect-src|img-src|form-action|font-src)\b/;
  const csp = cur.split(';').map((s) => s.trim()).filter((s) => s && !drop.test(s));
  csp.push(`script-src 'self' ${origin}`, `style-src 'self' 'unsafe-inline' ${origin}`, `frame-src ${origin}`, `connect-src 'self' ${origin}`,
    `img-src 'self' data: ${origin}`, `font-src 'self' ${origin}`, `form-action 'self' ${origin} https:`); // 3-D Secure pages of the card issuer
  res.setHeader('Content-Security-Policy', csp.join('; '));
}

// Which clinic's database has this payment (src/db/tenant.js).
router.param('pid', require('../../db/tenant').byParam('pay', (pid) => (pay.PUBLIC_ID_RE.test(pid) ? pay.byPublicId(pid) : null)));

router.get('/return/hyperpay/:pid', limiter, wrap(async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const out = await pay.hyperpayReturn(req.params.pid, String(req.query.id || ''), env(req));
  return backToPatient(res, out.payment, out.result);
}));

router.get('/:pid', limiter, wrap(async (req, res, next) => {
  if (!pay.PUBLIC_ID_RE.test(req.params.pid)) return next();
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  const p = await pay.byPublicId(req.params.pid);
  if (!p) return next();
  const clinic = await businesses.get(p.business_id);
  if (!clinic || clinic.status !== 'active') return next();
  if (p.status !== 'initiated') return backToPatient(res, p, p.status === 'paid' ? 'paid' : 'failed');
  if (Date.now() - new Date(p.created_at).getTime() > pay.PAGE_LIFETIME_MIN * 60_000) return backToPatient(res, p, 'failed');
  const a = await knex('appointments').where({ id: p.appointment_id }).first('patient_name', 'appointment_date', 'appointment_time');
  const en = req.locale === 'en';
  res.locals.currency = p.currency;
  const common = {
    layout: 'public', title: req.t('payments.patient.redirect_title'), noindex: true, hideBookCta: true, p, a,
    clinic: { ...clinic, displayName: (en && clinic.name_en) || clinic.name },
    ...(await siteLook(req, res, clinic, ['/css/telehealth.css', '/css/payments.css'])),
  };
  if (p.provider === 'paytabs') {
    let url = null;
    try { url = JSON.parse(p.raw_result || '{}').redirect_url || null; } catch { url = null; }
    const gw = await pay.gateway(p.business_id);
    const client = pay.clientOf(gw, p.currency);
    if (!url || !client || !url.startsWith(`${client.base}/`)) return backToPatient(res, p, 'failed'); // only the provider's own page
    return res.page('pages/payments/redirect', { ...common, redirectUrl: url, pageScripts: ['/js/payments.js'] });
  }
  const gw = await pay.gateway(p.business_id);
  const client = pay.clientOf(gw, p.currency);
  if (!client || gw.provider !== 'hyperpay') return backToPatient(res, p, 'failed');
  widgetCsp(res, client.base);
  return res.page('pages/payments/widget', {
    ...common, title: req.t('payments.patient.widget_title'), widgetUrl: client.widgetUrl(p.provider_ref), brands: client.brands[p.brand || 'card'],
    shopperResultUrl: `${publicBase(req)}/pay/return/hyperpay/${p.public_id}`, testMode: gw.mode !== 'live',
    wpwl: { locale: req.locale === 'en' ? 'en' : 'ar', style: 'plain', brandDetection: true, showCVVHint: true, paymentTarget: '_top' },
  });
}));

module.exports = router;
