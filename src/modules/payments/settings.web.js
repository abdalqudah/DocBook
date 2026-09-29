// Settings → Online payments (/app/settings/payments): the clinic's card gateway for payment before
// confirmation (PayTabs or HyperPay), test or live, credentials (stored encrypted, never shown again), how long an
// unpaid online booking keeps its time, "test connection", and the addresses to give the provider.
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { publicBase } = require('../../middleware/web');
const { render } = require('../settings/common');
const pay = require('./payments.service');

const router = express.Router();
router.use(can('settings.manage'));

const errText = (req, e) => { for (const k of [`errors_payments.${e.code}`, `errors.${e.code}`]) { const s = req.t(k); if (s !== k) return s; } return e.message; };

async function page(req, res, extra = {}) {
  const b = req.business;
  const gw = await pay.gatewayView(req.ctx.businessId);
  const base = publicBase(req);
  return render(req, res, '../payments/settings', 'payments', {
    title: req.t('settings.nav_payments'), b, gw, base, regions: pay.REGIONS, providers: pay.PROVIDERS,
    urls: {
      paytabsCallback: `${base}/pay/callback/paytabs/…`, paytabsReturn: `${base}/pay/return/paytabs/…`, hyperpayReturn: `${base}/pay/return/hyperpay/…`, domain: base,
    },
    https: /^https:\/\//.test(base),
    pageScripts: ['/js/admin.js', '/js/payments.js'], pageStyles: ['/css/admin.css', '/css/payments.css'],
    ...extra,
  });
}

router.get('/', wrap((req, res) => page(req, res)));

router.post('/', form(async (req, res) => {
  await pay.saveGateway(req.ctx, req.body);
  flash(req, 'success', req.t('payments.settings.saved'));
  res.redirect('/app/settings/payments');
}, (req, res, extra) => page(req, res, extra)));

router.post('/test', wrap(async (req, res) => {
  try {
    const r = await pay.testGateway(req.ctx, req.business.currency);
    flash(req, r.ok ? 'success' : 'error', r.ok ? req.t('payments.settings.test_ok') : req.t('payments.settings.test_failed', { message: r.message || '—' }));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 && e.status !== 502) throw e;
    flash(req, 'error', errText(req, e));
  }
  res.redirect('/app/settings/payments#test');
}));

module.exports = router;
