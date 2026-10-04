// Platform admin pages of platformops: system update (updates.web.js), clinic types, platform branding.
// Mounted inside the super-admin router (src/modules/admin/web.js), so only platform admins reach it; audited.
const express = require('express');
const knex = require('../../db/knex');
const { AppError } = require('../../core/errors');
const { wrap, form } = require('../../routes/helpers');
const uploads = require('../../core/uploads');
const audit = require('../../core/audit');
const { verifyCsrfAfterUpload } = require('../../middleware/web');

const router = express.Router();
require('./updates.web').mount(router, { path: '/updates', base: '/admin/updates', layout: 'admin' });
require('./loginpage.web').mount(router, { path: '/login-page', base: '/admin/login-page', layout: 'admin' });
// ---------------------------------------------------------------- clinic types offered to clinics
const clinicTypes = require('./clinic-types');
const { TEMPLATES } = require('../website/catalog');
const { flash } = require('../../routes/helpers');
const { translateMessage } = require('../../core/i18n');

router.get('/clinic-types', wrap(async (req, res) => {
  const st = await clinicTypes.load(true);
  const used = Object.fromEntries((await knex('businesses').whereNotNull('specialty').groupBy('specialty').select('specialty').count({ n: '*' })).map((r) => [r.specialty, Number(r.n)]));
  res.page('pages/admin/clinic-types', { layout: 'admin', title: req.t('clinic_types.title'), st, builtin: clinicTypes.BUILTIN, used, templates: TEMPLATES, pageStyles: ['/css/admin.css'] });
}));
router.post('/clinic-types', wrap(async (req, res) => {
  try {
    const shown = [].concat(req.body.shown || []);
    await clinicTypes.save(req.ctx, { hidden: clinicTypes.BUILTIN.filter((k) => !shown.includes(k)), custom: [...[].concat(Object.values(req.body.custom || {})), ...(req.body.new && (req.body.new.ar || req.body.new.en) ? [req.body.new] : [])] }, { templates: TEMPLATES });
    flash(req, 'success', req.t('clinic_types.saved'));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    const first = e.details && Object.values(e.details).find((v) => typeof v === 'string');
    flash(req, 'error', first ? translateMessage(req.locale, first) : e.message);
  }
  res.redirect('/admin/clinic-types');
}));

// ---------------------------------------------------------------- platform branding (logo, logo on dark, browser icon)
const branding = require('./branding');
const brandUpload = uploads.memory({ limits: { fileSize: 1024 * 1024, files: 3, fields: 10 }, maxSide: 1200, skip: ['favicon'] }) // logos → small WebP (the icon stays as sent)
  .fields(branding.KEYS.map((name) => ({ name, maxCount: 1 })));
router.get('/branding', wrap(async (req, res) => {
  const st = await branding.load();
  res.page('pages/admin/branding', { layout: 'admin', title: req.t('branding_admin.title'), st, keys: branding.KEYS, pageStyles: ['/css/admin.css'] });
}));
router.post('/branding', (req, res, next) => brandUpload(req, res, (err) => { if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'too_big' : 'invalid'; next(); }), verifyCsrfAfterUpload, wrap(async (req, res) => {
  if (req.uploadError) { flash(req, 'error', req.t(`branding_admin.${req.uploadError}`)); return res.redirect('/admin/branding'); }
  const files = Object.fromEntries(Object.entries(req.files || {}).map(([k, v]) => [k, v[0] && v[0].buffer]).filter(([, b]) => b && b.length));
  const r = await branding.save(req.ctx, { files, remove: [].concat(req.body.remove || []), showName: [].concat(req.body.show_name || []).pop() === '1' });
  if (r.invalid) flash(req, 'error', req.t('branding_admin.invalid_one', { what: req.t(`branding_admin.k.${r.invalid}`) }));
  else flash(req, 'success', req.t('branding_admin.saved'));
  return res.redirect('/admin/branding');
}));

module.exports = router;
