// Platform admin: system update from a DocBook dist zip: version card, one-step install form, backups.
// Mounted inside the super-admin router (src/modules/admin/web.js), so only platform admins reach it; audited.
//   GET  /admin/updates           current version, install form, backups, update history
//   POST /admin/updates/install   multipart form: the zip + your password → back up, copy, restart
//   POST /admin/updates/restore   a backup id + your password → put that version back, restart
const express = require('express');
const multer = require('multer');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { wrap, form } = require('../../routes/helpers');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const auth = require('../auth/auth.service');
const updater = require('./updater');

const router = express.Router();
const ROOT = () => (process.env.NODE_ENV === 'test' && process.env.DOCBOOK_UPDATE_ROOT) || updater.DEFAULT_ROOT; // tests point this at a scratch copy

const errText = (req, e) => {
  const k = `errors_platformops.${e.code}`;
  const tr = req.t(k, { ...(e.details || {}), entry: e.details && e.details.entry ? String(e.details.entry).slice(0, 120) : '' });
  return tr !== k ? tr : e.message;
};

const render = async (req, res, extra = {}) => {
  const root = ROOT();
  const [[{ v: dbVersion }]] = await knex.raw('SELECT VERSION() AS v');
  const st = updater.status(root);
  res.page('pages/admin/updates', {
    layout: 'admin', title: req.t('updater.title'), current: { version: st.version, node: process.version },
    dist: updater.isDistBuild(root), backups: updater.listBackups(root), log: updater.readLog(root), dbVersion,
    updated: req.query.updated, restored: req.query.restored, maxMb: updater.MAX_ZIP_BYTES / 1048576,
    pageStyles: ['/css/site.css', '/css/platformops.css'], ...extra,
  });
};
router.get('/updates', wrap((req, res) => render(req, res)));

async function confirmPassword(req) {
  const user = await knex('users').where({ id: req.user.id }).first('id', 'password_hash');
  const ok = await auth.verifyPassword(user, String(req.body.password || '')).catch(() => false);
  if (!ok) throw E.validation({ password: 'Current password is incorrect.' });
}

// The zip arrives as a normal multipart form field (no JavaScript needed); CSRF is checked after parsing.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: updater.MAX_ZIP_BYTES, files: 1, fields: 5 } });
const zipFile = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') req.uploadError = new AppError('UPDATE_TOO_BIG', 'The file is too big.', 422, { mb: updater.MAX_ZIP_BYTES / 1048576 });
  else req.uploadError = new AppError('UPDATE_NOT_ZIP', 'The upload could not be read.', 422);
  return next();
});

const failed = async (req, res, e, action) => {
  if (!(e instanceof AppError)) throw e;
  if (e.code !== 'VALIDATION_FAILED') await audit.record(req.ctx, 'platform.update_rejected', { entityType: 'app_update', newValues: { action, code: e.code, entry: e.details && e.details.entry ? String(e.details.entry).slice(0, 190) : undefined } });
  const errors = e.code === 'VALIDATION_FAILED' ? e.details || {} : { [action === 'restore' ? 'backup' : 'file']: errText(req, e) };
  res.status(422);
  return render(req, res, { errors, formError: null, openRestore: action === 'restore' ? String(req.body.backup || '') : null });
};

router.post('/updates/install', zipFile, verifyCsrfAfterUpload, wrap(async (req, res) => {
  try {
    await confirmPassword(req);
    if (req.uploadError) throw req.uploadError;
    const r = updater.install(req.file ? req.file.buffer : null, { root: ROOT(), by: req.user.email, fileName: req.file && req.file.originalname });
    await audit.record(req.ctx, 'platform.update_activated', { entityType: 'app_update', oldValues: { version: r.from }, newValues: { version: r.to, files: r.files, sha256: r.sha256 } });
    updater.restartAfter(res, 1500);
    return res.redirect(`/admin/updates?updated=${encodeURIComponent(r.to)}`);
  } catch (e) { return failed(req, res, e, 'install'); }
}));

router.post('/updates/restore', form(async (req, res) => {
  try {
    await confirmPassword(req);
    const r = updater.restore(req.body.backup, { root: ROOT(), by: req.user.email });
    await audit.record(req.ctx, 'platform.update_rolled_back', { entityType: 'app_update', entityId: String(req.body.backup || '').slice(0, 60), oldValues: { version: r.from }, newValues: { version: r.to } });
    updater.restartAfter(res, 1500);
    return res.redirect(`/admin/updates?restored=${encodeURIComponent(r.to)}`);
  } catch (e) { return failed(req, res, e, 'restore'); }
}, render));

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
const brandUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 3, fields: 10 } })
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
