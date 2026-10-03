// /app/marketplace — offers, products and vendors that reps & warehouses target at the clinic's specialty.
// A professional catalog: no carts or payments. Staff with vendors.manage / supplies.manage can link a vendor as a
// supplier and add a product to the clinic's supplies.
const express = require('express');
const { wrap, form, flash, back } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { clinicNow } = require('../clinic/scheduling');
const svc = require('./market.service');
const billing = require('../vendorbilling/billing.service');

const router = express.Router();
router.use(can('vendors.view'));
router.use((req, res, next) => { req.ctx.today = req.ctx.today || clinicNow(req.ctx.timezone).date; next(); });

const canLink = (req) => req.ctx.permissions.has('vendors.manage') || req.ctx.permissions.has('supplies.manage');
function needLink(req, res, next) { return canLink(req) ? next() : next(new AppError('PERMISSION_DENIED', 'You do not have permission to perform this action.', 403)); }

/** Translates this module's own error codes (errors_market.*) before the shared form helper sees them. */
const localize = (fn) => async (req, res, next) => {
  try { return await fn(req, res, next); } catch (e) {
    if (e instanceof AppError) { const k = `errors_market.${e.code}`; const tr = req.t(k); if (tr !== k) e.message = tr; }
    throw e;
  }
};

const assets = { pageScripts: ['/js/market.js'], pageStyles: ['/css/market.css', '/css/vbill.css'] };

function common(req, res) {
  const own = svc.clinicSpecialty(req.business);
  const loc = req.locale === 'en';
  return {
    ...assets,
    ownSpecialty: own,
    specialtyOptions: svc.TARGETABLE,
    canLink: canLink(req),
    L: (ar, en) => (loc && en ? en : ar || en || ''),
    specialtyLabel: (k) => req.t(`specialties.${k}`),
  };
}

async function render(req, res, extra = {}) {
  const tab = ['offers', 'products', 'vendors'].includes(req.query.tab) ? req.query.tab : 'offers';
  const data = { title: req.t('nav.marketplace'), tab, ...common(req, res), ...extra };
  const specialty = req.query.specialty;
  data.filterSpecialty = svc.effectiveSpecialty(req.business, specialty);
  if (tab === 'offers') {
    data.offers = await svc.offers(req.ctx, req.business, { specialty, vendor: req.query.vendor, show: req.query.show });
    data.showDismissed = req.query.show === 'dismissed';
    data.sponsored = await billing.adsFor(req.business, { limit: 2 }).catch(() => []);
  } else if (tab === 'products') {
    const { rows, meta } = await svc.products(req.ctx, req.business, { specialty, q: req.query.q, vendor: req.query.vendor, page: req.query.page });
    data.products = rows; data.meta = meta;
    data.vendorOptions = await svc.vendorOptions(req.business, specialty);
  } else {
    data.vendors = await svc.vendors(req.ctx, req.business, { specialty, q: req.query.q });
  }
  data.newCount = await svc.newOffersCount(req.ctx, req.business);
  data.filtered = ['q', 'vendor', 'specialty'].some((k) => req.query[k] && req.query[k] !== 'all');
  res.page('pages/marketplace/index', data);
}

router.get('/', wrap((req, res) => render(req, res)));
// A sponsored ad was clicked: count it, then open the linked offer (or the vendor's page).
router.get('/ad/:id(\\d+)', wrap(async (req, res) => {
  const ad = await billing.adClick(req.params.id);
  if (!ad) return res.redirect('/app/marketplace');
  return res.redirect(ad.offer_id ? `/app/marketplace/offers/${ad.offer_id}` : `/app/marketplace/vendors/${ad.vendor_id}`);
}));

// Images (logo / product / offer) of active vendors, for the catalog.
router.get('/img/:kind(vendor|product|offer)/:id(\\d+)', wrap(async (req, res) => {
  const img = await svc.image(req.params.kind, req.params.id);
  if (!img || !img.data) return res.status(404).end();
  res.set('Content-Type', /^image\/(png|jpe?g|webp|gif)$/.test(img.mime || '') ? img.mime : 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=600');
  res.set('X-Content-Type-Options', 'nosniff');
  return res.send(img.data);
}));

router.get('/offers/:id(\\d+)', wrap(async (req, res) => {
  const o = await svc.offer(req.ctx, req.business, req.params.id);
  res.page('pages/marketplace/offer', { title: o.title, o, supplierLinked: await svc.supplierFor(req.ctx, o.vendor_id), ...common(req, res) });
}));

router.post('/offers/:id(\\d+)/dismiss', can('vendors.manage'), wrap(async (req, res) => {
  const undo = req.body.undo === '1';
  await svc.setDismissed(req.ctx, req.business, req.params.id, !undo);
  flash(req, 'success', req.t(undo ? 'market.offer_restored' : 'market.offer_dismissed'));
  res.redirect(undo ? `/app/marketplace/offers/${req.params.id}` : '/app/marketplace');
}));

router.get('/products/:id(\\d+)', wrap(async (req, res) => renderProduct(req, res)));

async function renderProduct(req, res, extra = {}) {
  const p = await svc.product(req.ctx, req.business, req.params.id);
  res.page('pages/marketplace/product', { title: req.locale === 'en' && p.name_en ? p.name_en : p.name, p, supplierLinked: await svc.supplierFor(req.ctx, p.vendor_id), ...common(req, res), ...extra });
}

router.get('/vendors/:id(\\d+)', wrap(async (req, res) => {
  const v = await svc.vendorPublic(req.params.id);
  if (!v) return res.redirect('/app/marketplace?tab=vendors');
  return res.redirect(`/app/marketplace?tab=products&vendor=${v.id}`);
}));

router.post('/vendors/:id(\\d+)/supplier', needLink, wrap(localize(async (req, res) => {
  const r = await svc.ensureSupplier(req.ctx, req.params.id);
  flash(req, 'success', req.t(r.created ? 'market.supplier_added' : 'market.supplier_exists', { name: r.vendor.name }));
  back(req, res, '/app/marketplace?tab=vendors');
})));

router.post('/products/:id(\\d+)/supplies', needLink, form(localize(async (req, res) => {
  const r = await svc.addToSupplies(req.ctx, req.business, req.params.id, req.body, req.locale);
  flash(req, 'success', req.t(r.created ? 'market.item_added' : 'market.item_exists'));
  res.redirect(req.body._return && /^\/app\/marketplace[/?]?/.test(req.body._return) ? req.body._return : `/app/marketplace/products/${req.params.id}`);
}), (req, res, extra) => renderProduct(req, res, { ...extra, openDialog: 'supply-dialog' })));

module.exports = router;
