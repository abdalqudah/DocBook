// Platform admin: in-app update from a dist zip (worker: platformops). Mounted inside the super-admin router
// (src/modules/admin/web.js), so only platform admins reach it; every action is audited with business_id NULL.
//   GET  /admin/updates            current version, staged upload, backups
//   POST /admin/updates/upload     raw zip body (sent by platformops.js with the CSRF token in a header)
//   POST /admin/updates/activate   back up + copy the staged build over the app + restart
//   POST /admin/updates/rollback   restore the latest backup + restart
//   POST /admin/updates/discard    delete the staged upload
const express = require('express');
const audit = require('../../core/audit');
const { AppError } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const updater = require('./updater');

const router = express.Router();
const ROOT = () => (process.env.NODE_ENV === 'test' && process.env.DOCBOOK_UPDATE_ROOT) || updater.DEFAULT_ROOT; // tests point this at a scratch copy

const page = (req, res, data = {}) => res.page('pages/admin/updates', {
  layout: 'admin', title: req.t('updater.title'), st: updater.status(ROOT()), compare: updater.compareVersions,
  pageStyles: ['/css/site.css', '/css/platformops.css'], pageScripts: ['/js/platformops.js'], ...data,
});
const errText = (req, e) => {
  const k = `errors_platformops.${e.code}`;
  const tr = req.t(k, { ...(e.details || {}), entry: e.details && e.details.entry ? String(e.details.entry).slice(0, 120) : '' });
  return tr !== k ? tr : e.message;
};

router.get('/updates', wrap(async (req, res) => page(req, res)));

const rawZip = (req, res, next) => express.raw({ type: () => true, limit: updater.MAX_ZIP_BYTES + 1024 })(req, res, (err) => {
  if (err && err.type === 'entity.too.large') { req.uploadError = new AppError('UPDATE_TOO_BIG', 'The file is too big.', 413, { mb: updater.MAX_ZIP_BYTES / 1048576 }); return next(); }
  return next(err);
});
router.post('/updates/upload', rawZip, wrap(async (req, res) => {
  const wantsJson = String(req.get('accept') || '').includes('application/json');
  let error = null; let staged = null;
  try {
    if (req.uploadError) throw req.uploadError;
    if (!updater.isDistBuild(ROOT())) throw new AppError('UPDATE_SOURCE_BUILD', 'Updates are available only in the installed dist build.', 409);
    staged = updater.stage(Buffer.isBuffer(req.body) ? req.body : null, { root: ROOT(), by: req.ctx.userId });
    await audit.record(req.ctx, 'platform.update_staged', { entityType: 'app_update', entityId: staged.id, newValues: { version: staged.version, from: staged.from, files: staged.files, bytes: staged.zipBytes } });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    error = errText(req, e);
    await audit.record(req.ctx, 'platform.update_rejected', { entityType: 'app_update', newValues: { code: e.code, entry: e.details && e.details.entry ? String(e.details.entry).slice(0, 190) : undefined } });
  }
  if (wantsJson) return res.status(error ? 422 : 201).json(error ? { error } : { data: { id: staged.id, version: staged.version }, message: req.t('updater.staged', { v: staged.version }) });
  flash(req, error ? 'error' : 'success', error || req.t('updater.staged', { v: staged.version }));
  return res.redirect('/admin/updates');
}));

const act = (fn) => wrap(async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', errText(req, e));
    res.redirect('/admin/updates');
  }
});

router.post('/updates/activate', act(async (req, res) => {
  if (String(req.body.confirm_name || '').trim() !== String((updater.status(ROOT()).staged || {}).version || '\0')) {
    flash(req, 'error', req.t('updater.confirm_mismatch'));
    return res.redirect('/admin/updates');
  }
  const r = updater.activate({ root: ROOT(), by: req.ctx.userId });
  await audit.record(req.ctx, 'platform.update_activated', { entityType: 'app_update', entityId: r.backup, oldValues: { version: r.from }, newValues: { version: r.to } });
  updater.restartAfter(res);
  return res.page('pages/admin/updates-restarting', { layout: 'admin', title: req.t('updater.restarting_title'), r, kind: 'activate', pageStyles: ['/css/site.css', '/css/platformops.css'], pageScripts: ['/js/platformops.js'] });
}));

router.post('/updates/rollback', act(async (req, res) => {
  const r = updater.rollback({ root: ROOT() });
  await audit.record(req.ctx, 'platform.update_rolled_back', { entityType: 'app_update', entityId: r.backup, oldValues: { version: r.from }, newValues: { version: r.to } });
  updater.restartAfter(res);
  return res.page('pages/admin/updates-restarting', { layout: 'admin', title: req.t('updater.restarting_title'), r, kind: 'rollback', pageStyles: ['/css/site.css', '/css/platformops.css'], pageScripts: ['/js/platformops.js'] });
}));

router.post('/updates/discard', act(async (req, res) => {
  const s = updater.discard(ROOT());
  await audit.record(req.ctx, 'platform.update_discarded', { entityType: 'app_update', entityId: s.id, oldValues: { version: s.version } });
  flash(req, 'success', req.t('updater.discarded'));
  res.redirect('/admin/updates');
}));

module.exports = router;
