// Clinic modules on/off, invoice template and sample data (worker: platformops). Mounted at '/' inside /app.
//   GET/POST /app/settings/modules        optional areas on/off                         (settings.manage)
//   GET/POST /app/settings/invoice        invoice print template + next invoice number  (settings.manage)
//   POST     /app/settings/demo/add       add the sample data                           (settings.manage | data.manage)
//   POST     /app/settings/demo/remove    remove the sample data (type-to-confirm)      (settings.manage | data.manage)
// Service categories live in src/modules/clinic/services.web.js (/app/services/categories).
const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash, back } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const settings = require('../settings/common');
const ops = require('./ops.service');
const demo = require('./demo.service');

const router = express.Router();
const ASSETS = { pageStyles: ['/css/admin.css', '/css/platformops.css'], pageScripts: ['/js/admin.js', '/js/platformops.js'] };

// ---------------------------------------------------------------- modules
async function renderModules(req, res, extra = {}) {
  const st = await ops.state(req.business);
  return settings.render(req, res, 'modules', 'modules', { st, core: ops.CORE, ...ASSETS, ...extra });
}
router.get('/settings/modules', can('settings.manage'), wrap((req, res) => renderModules(req, res)));
router.post('/settings/modules', can('settings.manage'), form(async (req, res) => {
  const r = await ops.saveModules(req.ctx, req.business, req.body);
  flash(req, 'success', req.t(r.turnedOff.length || r.turnedOn.length ? 'modules_cfg.saved' : 'modules_cfg.saved_same'));
  res.redirect('/app/settings/modules');
}, renderModules));

// ---------------------------------------------------------------- invoice template
async function renderInvoice(req, res, extra = {}) {
  const tpl = await ops.invoiceTemplate(req.ctx.businessId);
  const b = await knex('businesses').where({ id: req.ctx.businessId }).first('invoice_next_number', 'tax_number');
  const [{ top }] = await knex('invoices').where({ business_id: req.ctx.businessId }).max({ top: 'invoice_number' });
  const last = await knex('invoices').where({ business_id: req.ctx.businessId }).orderBy('id', 'desc').first('id');
  return settings.render(req, res, 'invoice', 'invoice_template', {
    tpl, nextNumber: Number(b.invoice_next_number), lastIssued: top ? Number(top) : null, taxNumber: b.tax_number || '', sampleId: last ? last.id : null,
    papers: ops.PAPERS, fields: ops.FIELDS, places: ops.PLACES, logoSizes: ops.LOGO_SIZES, billingOn: !(await ops.state(req.business)).off.has('billing'), ...ASSETS, ...extra,
  });
}
router.get('/settings/invoice', can('settings.manage'), wrap((req, res) => renderInvoice(req, res)));
router.post('/settings/invoice', can('settings.manage'), form(async (req, res) => {
  try {
    await ops.saveInvoiceTemplate(req.ctx, req.body);
  } catch (e) {
    if (e instanceof AppError && e.code === 'INVOICE_NUMBER_DOWN') {
      res.status(422);
      return renderInvoice(req, res, { errors: { next_number: req.t('errors_platformops.INVOICE_NUMBER_DOWN', { n: e.details.current }) }, old: req.body });
    }
    throw e;
  }
  flash(req, 'success', req.t('invoice_tpl.saved'));
  return res.redirect('/app/settings/invoice');
}, renderInvoice));

// ---------------------------------------------------------------- sample data
const demoGuard = canAny('settings.manage', 'data.manage');
router.post('/settings/demo/add', demoGuard, wrap(async (req, res) => {
  try {
    const r = await demo.add(req.ctx, { locale: req.locale });
    flash(req, 'success', req.t('demo.added', { doctors: r.doctors || 0, patients: r.patients || 0, appointments: r.appointments || 0 }));
  } catch (e) {
    if (!(e instanceof AppError) || e.code !== 'DEMO_EXISTS') throw e;
    flash(req, 'info', req.t('errors_platformops.DEMO_EXISTS'));
  }
  back(req, res, '/app/settings/data');
}));
router.post('/settings/demo/remove', demoGuard, wrap(async (req, res) => {
  const typed = ([].concat(req.body.confirm_name || '').map((x) => String(x).trim()).find(Boolean) || '').toLowerCase(); // the no-JS form sends a visible field too
  const words = [req.t('demo.confirm_word'), 'remove', 'حذف'].map((w) => String(w).toLowerCase());
  if (!words.includes(typed)) {
    flash(req, 'error', req.t('demo.confirm_mismatch', { word: req.t('demo.confirm_word') }));
    return back(req, res, '/app/settings/data');
  }
  const r = await demo.remove(req.ctx);
  const n = Object.values(r.removed).reduce((a, x) => a + x, 0);
  flash(req, 'success', r.kept ? req.t('demo.removed_kept', { n, kept: r.kept }) : req.t('demo.removed', { n }));
  return back(req, res, '/app/settings/data');
}));

module.exports = router;
