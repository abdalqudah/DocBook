// Vendor portal: subscription & invoices (/vendor/billing) and paid ads to doctors (/vendor/ads).
const express = require('express');
const multer = require('multer');
const knex = require('../../db/knex');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const { wrap, flash } = require('../../routes/helpers');
const { form, codeText } = require('../vendors/form');
const vendors = require('../vendors/vendor.service');
const ppay = require('../platformpay/platformpay.service');
const billing = require('./billing.service');

const billingRouter = express.Router();
const adsRouter = express.Router();
const page = (res, view, data) => res.page(`pages/vendor/${view}`, { layout: 'vendor', pageStyles: ['/css/vendors.css', '/css/vbill.css'], ...data });

/** How to pay the platform: bank / CliQ / wallet details and whether cards (PayTabs) are on. */
const payTo = () => ppay.methods();

// ---------------------------------------------------------------- billing
const renderBilling = async (req, res, extra = {}) => {
  const [st, plans, invoices, pay] = await Promise.all([billing.state(req.vendor.id), billing.plans({ activeOnly: true, publicOnly: true }), billing.invoices(req.vendor.id), payTo()]);
  page(res, 'billing', { title: req.t('vbill.nav_billing'), st, plans, invoices, pay, methods: billing.METHODS.filter((m) => m !== 'card'), payResult: ['paid', 'pending', 'failed'].includes(req.query.pay) ? req.query.pay : null, errors: {}, ...extra });
};
billingRouter.get('/', wrap((req, res) => renderBilling(req, res)));
billingRouter.post('/choose', form(async (req, res) => {
  await billing.choosePlan(req.vendorCtx, req.body.plan_id, req.body.cycle);
  flash(req, 'success', req.t('vbill.invoice_created'));
  res.redirect('/vendor/billing#invoices');
}, renderBilling));
billingRouter.post('/invoices/:id(\\d+)/report', form(async (req, res) => {
  await billing.reportPayment(req.vendorCtx, req.params.id, req.body);
  flash(req, 'success', req.t('vbill.payment_reported'));
  res.redirect('/vendor/billing#invoices');
}, renderBilling));

billingRouter.post('/invoices/:id(\\d+)/card', wrap(async (req, res) => {
  try {
    const r = await ppay.start('vendor', { vendorId: req.vendor.id, invoiceId: req.params.id, userId: req.user.id, baseUrl: require('../../middleware/web').publicBase(req), lang: req.locale, customer: { name: req.vendor.name, email: req.user.email } }); // eslint-disable-line global-require
    return res.page('pages/platformpay/go', { layout: 'auth', title: req.t('ppay.go_title'), ...r, back: '/vendor/billing#invoices', noindex: true, pageScripts: ['/js/payments.js'] });
  } catch (e) {
    if (!e.code || (e.status >= 500 && e.code !== 'PAY_PROVIDER_ERROR' && e.code !== 'PAY_PROVIDER_UNREACHABLE')) throw e;
    flash(req, 'error', req.t(`ppay.err.${e.code}`) !== `ppay.err.${e.code}` ? req.t(`ppay.err.${e.code}`) : req.t('ppay.err.generic'));
    return res.redirect('/vendor/billing#invoices');
  }
}));

// ---------------------------------------------------------------- ads
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: vendors.IMAGE_MAX_BYTES, files: 1, fields: 100 } });
const imageUpload = (req, res, next) => upload.single('image')(req, res, (err) => { if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'too_big' : 'invalid'; next(); });
const specialtyOptions = (req) => vendors.TARGET_SPECIALTIES.map((k) => ({ value: k, label: req.t(`specialties.${k}`) }));

adsRouter.get('/', wrap(async (req, res) => {
  const [ads, st] = await Promise.all([billing.vendorAds(req.vendor.id), billing.state(req.vendor.id)]);
  ads.forEach((a) => { a.ctr = a.impressions ? Math.round((a.clicks / a.impressions) * 1000) / 10 : 0; });
  page(res, 'ads', { title: req.t('vbill.nav_ads'), ads, st });
}));
const renderNewAd = async (req, res, extra = {}) => {
  const [st, s, offers] = await Promise.all([billing.state(req.vendor.id), billing.settings(),
    knex('vendor_offers').where({ vendor_id: req.vendor.id, status: 'published' }).orderBy('published_at', 'desc').select('id', 'title', 'title_en')]);
  const freeLeft = st.enabled ? Math.max(0, (st.limits.adDays || 0) - st.usage.freeAdDays) : 0;
  page(res, 'ad-form', {
    title: req.t('vbill.ad_new'), st, s, offers, freeLeft, specialtyOptions: specialtyOptions(req), today: st.today,
    defaultSpecialties: (await vendors.getProfile(req.vendor.id)).specialties, pageScripts: ['/js/vbill.js'], errors: {}, ...extra,
  });
};
adsRouter.get('/new', wrap((req, res) => renderNewAd(req, res)));
adsRouter.post('/', imageUpload, verifyCsrfAfterUpload, form(async (req, res) => {
  if (req.vendor.status !== 'active') { flash(req, 'info', req.t('vbill.err.VENDOR_NOT_ACTIVE')); return res.redirect('/vendor/ads'); }
  const img = vendors.checkImage(req.file, 'image', req.uploadError);
  const out = await billing.createAd(req.vendorCtx, req.body, img);
  flash(req, 'success', req.t(out.price > 0 ? 'vbill.ad_created_pay' : 'vbill.ad_created_free'));
  return res.redirect(out.price > 0 ? '/vendor/billing#invoices' : '/vendor/ads');
}, renderNewAd));
adsRouter.post('/:id(\\d+)/cancel', wrap(async (req, res) => {
  await billing.cancelAd(req.vendorCtx, req.params.id);
  flash(req, 'success', req.t('vbill.ad_cancelled'));
  res.redirect('/vendor/ads');
}));

module.exports = { billingRouter, adsRouter, codeText };
