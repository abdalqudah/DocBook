// Vendor portal (/vendor) for medical reps, drug warehouses and supplier companies. Mounted behind
// middleware/vendor.requireVendor (req.vendor, req.vendorCtx). Visits (/vendor/visits) and purchase orders
// (/vendor/orders) are separate routers rendered in the same layout ('vendor').
// Pending vendors can prepare everything; nothing reaches clinics and offers stay drafts until approval.
const express = require('express');
const multer = require('multer');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { z, validate, password } = require('../../core/validate');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const { wrap, flash } = require('../../routes/helpers');
const authService = require('../auth/auth.service');
const verify = require('../auth/verify.service');
const options = require('../settings/options');
const { CURRENCIES } = require('../../core/money');
const vendors = require('./vendor.service');
const billing = require('../vendorbilling/billing.service');
const { form, message, codeText } = require('./form');
const { E } = require('../../core/errors');

const router = express.Router();

router.use((req, res, next) => {
  req.vendorCtx.sessionId = req.sessionID;
  res.locals.vendorToday = vendors.todayFor(req.vendor);
  next();
});

const page = (res, view, data) => res.page(`pages/vendor/${view}`, { layout: 'vendor', ...data });
const specialtyOptions = (req) => vendors.TARGET_SPECIALTIES.map((k) => ({ value: k, label: req.t(`specialties.${k}`) }));
const today = (req) => vendors.todayFor(req.vendor);

// Multipart (image) forms: parsed here, CSRF token checked after parsing (routes listed in middleware/web MULTIPART_ROUTES).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: vendors.IMAGE_MAX_BYTES, files: 1, fields: 200 } });
const imageUpload = (field) => (req, res, next) => upload.single(field)(req, res, (err) => {
  if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'too_big' : 'invalid';
  next();
});

// ---------------------------------------------------------------- dashboard
router.get('/', wrap(async (req, res) => {
  const d = await vendors.dashboard(req.vendorCtx, today(req));
  const profile = await vendors.getProfile(req.vendor.id);
  const verifyNeeded = verify.required() && !verify.isVerified(req.user);
  page(res, 'dashboard', { title: req.t('vendor_portal.nav_dashboard'), ...d, profile, verifyNeeded });
}));

// ---------------------------------------------------------------- profile
const renderProfile = async (req, res, extra = {}) => {
  const v = await vendors.getProfile(req.vendor.id);
  page(res, 'profile', {
    title: req.t('vendor_portal.nav_profile'), v, specialtyOptions: specialtyOptions(req), countryOptions: options.countryOptions(req.locale), logoError: null, ...extra,
  });
};
router.get('/profile', wrap((req, res) => renderProfile(req, res)));
router.post('/profile', form(async (req, res) => {
  await vendors.updateProfile(req.vendorCtx, req.body);
  flash(req, 'success', req.t('vendor_portal.saved'));
  res.redirect('/vendor/profile');
}, renderProfile));
router.post('/profile/logo', imageUpload('logo'), verifyCsrfAfterUpload, wrap(async (req, res) => {
  try {
    const img = vendors.checkImage(req.file, 'logo', req.uploadError);
    if (!img) { flash(req, 'error', message(req.locale, 'Choose an image first.')); return res.redirect('/vendor/profile'); }
    await vendors.setLogo(req.vendorCtx, img);
    flash(req, 'success', req.t('vendor_portal.logo_saved'));
  } catch (err) {
    if (err.code !== 'VALIDATION_FAILED') throw err;
    flash(req, 'error', message(req.locale, err.details.logo));
  }
  return res.redirect('/vendor/profile');
}));
router.post('/profile/logo/delete', wrap(async (req, res) => {
  await vendors.setLogo(req.vendorCtx, null);
  flash(req, 'success', req.t('vendor_portal.logo_removed'));
  res.redirect('/vendor/profile');
}));

// ---------------------------------------------------------------- products
router.get('/products', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const status = ['active', 'inactive'].includes(req.query.status) ? req.query.status : '';
  const { rows, meta } = await vendors.listProducts(req.vendorCtx, { q, status, page: req.query.page });
  page(res, 'products', { title: req.t('vendor_portal.nav_products'), rows, meta, q, status });
}));

const renderProduct = async (req, res, extra = {}) => {
  const p = req.params.id ? await vendors.ownProduct(req.vendorCtx, Number(req.params.id)) : null;
  page(res, 'product-form', {
    title: req.t(p ? 'vendor_portal.product_edit' : 'vendor_portal.product_new'), p,
    specialtyOptions: specialtyOptions(req), currencies: CURRENCIES, defaultSpecialties: p ? p.specialties : (await vendors.getProfile(req.vendor.id)).specialties, ...extra,
  });
};
router.get('/products/new', wrap((req, res) => renderProduct(req, res)));
router.get('/products/:id(\\d+)', wrap((req, res) => renderProduct(req, res)));
const saveProduct = form(async (req, res) => {
  const id = req.params.id ? Number(req.params.id) : null;
  if (id) await vendors.ownProduct(req.vendorCtx, id);
  const img = vendors.checkImage(req.file, 'image', req.uploadError);
  await vendors.saveProduct(req.vendorCtx, id, req.body, img);
  flash(req, 'success', req.t(id ? 'vendor_portal.product_saved' : 'vendor_portal.product_created'));
  res.redirect('/vendor/products');
}, renderProduct);
router.post('/products', imageUpload('image'), verifyCsrfAfterUpload, saveProduct);
router.post('/products/:id(\\d+)', imageUpload('image'), verifyCsrfAfterUpload, saveProduct);
router.post('/products/:id(\\d+)/toggle', wrap(async (req, res) => {
  const p = await vendors.ownProduct(req.vendorCtx, Number(req.params.id));
  await vendors.setProductActive(req.vendorCtx, p.id, !p.is_active);
  flash(req, 'success', req.t(p.is_active ? 'vendor_portal.product_hidden' : 'vendor_portal.product_shown'));
  res.redirect(req.body._return && String(req.body._return).startsWith('/vendor/') ? req.body._return : '/vendor/products');
}));
router.post('/products/:id(\\d+)/delete', wrap(async (req, res) => {
  await vendors.deleteProduct(req.vendorCtx, Number(req.params.id));
  flash(req, 'success', req.t('vendor_portal.product_deleted'));
  res.redirect('/vendor/products');
}));

// ---------------------------------------------------------------- offers
router.get('/offers', wrap(async (req, res) => {
  const status = vendors.OFFER_STATUSES.includes(req.query.status) ? req.query.status : '';
  const { rows, counts } = await vendors.listOffers(req.vendorCtx, { status });
  page(res, 'offers', { title: req.t('vendor_portal.nav_offers'), rows, counts, status, todayStr: today(req) });
}));

const renderOffer = async (req, res, extra = {}) => {
  const o = req.params.id ? await vendors.ownOffer(req.vendorCtx, Number(req.params.id)) : null;
  page(res, 'offer-form', {
    title: req.t(o ? 'vendor_portal.offer_edit' : 'vendor_portal.offer_new'), o,
    specialtyOptions: specialtyOptions(req), products: await vendors.productChoices(req.vendorCtx),
    defaultSpecialties: o ? o.specialties : (await vendors.getProfile(req.vendor.id)).specialties,
    clinicChoices: await vendors.offerClinicChoices(), maxClinics: await billing.maxOfferClinics(req.vendor.id), pageScripts: ['/js/vbill.js'], pageStyles: ['/css/vendors.css', '/css/vbill.css'], ...extra,
  });
};
router.get('/offers/new', wrap((req, res) => renderOffer(req, res)));
router.get('/offers/:id(\\d+)', wrap((req, res) => renderOffer(req, res)));
const saveOffer = form(async (req, res) => {
  const id = req.params.id ? Number(req.params.id) : null;
  if (id) await vendors.ownOffer(req.vendorCtx, id);
  const img = vendors.checkImage(req.file, 'image', req.uploadError);
  const out = await vendors.saveOffer(req.vendorCtx, id, req.body, img, { publish: req.body.intent === 'publish', vendorStatus: req.vendor.status, today: today(req) });
  if (out.publishBlocked) flash(req, 'info', req.t('vendor_portal.saved_as_draft_pending'));
  else flash(req, 'success', req.t(out.status === 'published' && req.body.intent === 'publish' ? 'vendor_portal.offer_published' : 'vendor_portal.offer_saved'));
  res.redirect('/vendor/offers');
}, renderOffer);
router.post('/offers', imageUpload('image'), verifyCsrfAfterUpload, saveOffer);
router.post('/offers/:id(\\d+)', imageUpload('image'), verifyCsrfAfterUpload, saveOffer);

const STATUS_ACTIONS = { publish: 'published', archive: 'archived', unpublish: 'draft' };
for (const [name, next] of Object.entries(STATUS_ACTIONS)) {
  router.post(`/offers/:id(\\d+)/${name}`, wrap(async (req, res) => {
    try {
      await vendors.setOfferStatus(req.vendorCtx, Number(req.params.id), next, { vendorStatus: req.vendor.status, today: today(req) });
      flash(req, 'success', req.t(`vendor_portal.offer_${name}_done`));
    } catch (err) {
      if (!['VENDOR_NOT_APPROVED', 'OFFER_ENDED', 'OFFER_NO_SPECIALTY', 'OFFER_NO_CLINICS'].includes(err.code) && !/^VENDOR_(LIMIT|SUB)_/.test(err.code)) throw err;
      flash(req, err.code === 'VENDOR_NOT_APPROVED' ? 'info' : 'error', codeText(req, err));
    }
    res.redirect('/vendor/offers');
  }));
}
router.post('/offers/:id(\\d+)/duplicate', wrap(async (req, res) => {
  const id = await vendors.duplicateOffer(req.vendorCtx, Number(req.params.id));
  flash(req, 'success', req.t('vendor_portal.offer_duplicated'));
  res.redirect(`/vendor/offers/${id}`);
}));
router.post('/offers/:id(\\d+)/delete', wrap(async (req, res) => {
  await vendors.deleteOffer(req.vendorCtx, Number(req.params.id));
  flash(req, 'success', req.t('vendor_portal.offer_deleted'));
  res.redirect('/vendor/offers');
}));

// ---------------------------------------------------------------- account (name / password)
const renderAccount = (req, res, extra = {}) => page(res, 'account', { title: req.t('vendor_portal.nav_account'), me: req.user, ...extra });
router.get('/account', (req, res) => renderAccount(req, res));
router.post('/account', form(async (req, res) => {
  const d = validate(z.object({
    name: z.string().trim().min(2, 'Enter your full name.').max(160),
    locale: z.enum(['ar', 'en'], { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  }), req.body);
  await knex('users').where({ id: req.user.id }).update({ name: d.name, locale: d.locale, updated_at: new Date() });
  await audit.record({ ...req.vendorCtx, businessId: null }, 'vendor.account_updated', { entityType: 'user', entityId: req.user.id, oldValues: { name: req.user.name, locale: req.user.locale }, newValues: { name: d.name, locale: d.locale } });
  res.cookie('db_lang', d.locale, { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: true });
  flash(req, 'success', req.t('vendor_portal.saved'));
  res.redirect('/vendor/account');
}, renderAccount));
router.post('/account/password', form(async (req, res) => {
  const d = validate(z.object({
    current_password: z.string().min(1, 'Password is required.'),
    new_password: password(),
    new_password_confirm: z.string(),
  }), req.body);
  if (d.new_password !== d.new_password_confirm) throw E.validation({ new_password_confirm: 'Passwords do not match.' });
  await authService.changePassword({ ...req.vendorCtx, businessId: null, sessionId: req.sessionID }, { currentPassword: d.current_password, newPassword: d.new_password });
  flash(req, 'success', req.t('vendor_portal.password_changed'));
  res.redirect('/vendor/account');
}, (req, res, extra) => renderAccount(req, res, { ...extra, pwForm: true })));

module.exports = router;
