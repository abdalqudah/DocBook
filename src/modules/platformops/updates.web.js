// System update from the ready update zip: version card, one-step install form, backups, history. Audited.
// Two places, the same page: Platform admin → Updates (/admin/updates) and, for the installation's own account
// (users.is_platform_admin), the clinic's Settings → System update (/app/settings/system-update).
//   GET  <base>             current version, install form, backups, update history
//   POST <base>/install     multipart form: the zip + your password → back up, copy, restart
//   POST <base>/restore     a backup id + your password → put that version back, restart
//   POST <base>/database    bring the database structure up to date now
const multer = require('multer');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { wrap, form, flash } = require('../../routes/helpers');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const auth = require('../auth/auth.service');
const updater = require('./updater');

const ROOT = () => (process.env.NODE_ENV === 'test' && process.env.DOCBOOK_UPDATE_ROOT) || updater.DEFAULT_ROOT; // tests point this at a scratch copy

/** The update pages on `router` at `path` (its full address `base`), drawn in `layout`. */
function mount(router, { path = '/updates', base = '/admin/updates', layout = 'admin' } = {}) {
  // The system's version and database structure belong to the main database (even when opened from a clinic's settings).
  router.use(path, (req, res, next) => require('../../db/tenant').run(null, () => next())); // eslint-disable-line global-require
  const errText = (req, e) => {
    const k = `errors_platformops.${e.code}`;
    const tr = req.t(k, { ...(e.details || {}), entry: e.details && e.details.entry ? String(e.details.entry).slice(0, 120) : '' });
    return tr !== k ? tr : e.message;
  };

  const render = async (req, res, extra = {}) => {
    const root = ROOT();
    const [[{ v: dbVersion }]] = await knex.raw('SELECT VERSION() AS v');
    const st = updater.status(root);
    // Database changes: brought up to date by themselves (start, every 5 minutes, on a missing table); shown here.
    const auto = require('../../db/auto'); // eslint-disable-line global-require
    let pendingDb = [];
    try { pendingDb = await auto.ensureLatest({ reason: 'admin page' }).then(() => auto.pending()); } catch (e) { pendingDb = ['error']; }
    const [[{ n: appliedDb }]] = await knex.raw('SELECT COUNT(*) AS n FROM knex_migrations');
    res.page('pages/admin/updates', {
      updBase: base,
      pendingDb, appliedDb: Number(appliedDb), lastDbRun: auto.lastRun(),
      layout, title: req.t('updater.title'), current: { version: st.version, node: process.version },
      dist: updater.isDistBuild(root) || updater.isOwnSource(root), fromSource: !updater.isDistBuild(root), backups: updater.listBackups(root), log: updater.readLog(root), dbVersion,
      updated: req.query.updated, restored: req.query.restored, maxMb: updater.MAX_ZIP_BYTES / 1048576,
      pageStyles: ['/css/site.css', '/css/platformops.css'], ...extra,
    });
  };
  router.get(path, wrap((req, res) => render(req, res)));
  router.post(`${path}/database`, wrap(async (req, res) => {
    const applied = await require('../../db/auto').ensureLatest({ reason: 'admin' }); // eslint-disable-line global-require
    await audit.record(req.ctx, 'platform.database_updated', { entityType: 'app_update', newValues: { applied: applied.length } });
    flash(req, 'success', applied.length ? req.t('updater.db_applied', { n: applied.length }) : req.t('updater.db_uptodate'));
    res.redirect(base);
  }));

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

  router.post(`${path}/install`, zipFile, verifyCsrfAfterUpload, wrap(async (req, res) => {
    try {
      await confirmPassword(req);
      if (req.uploadError) throw req.uploadError;
      const r = updater.install(req.file ? req.file.buffer : null, { root: ROOT(), by: req.user.email, fileName: req.file && req.file.originalname });
      await audit.record(req.ctx, 'platform.update_activated', { entityType: 'app_update', oldValues: { version: r.from }, newValues: { version: r.to, files: r.files, sha256: r.sha256 } });
      updater.restartAfter(res, 1500);
      return res.redirect(`${base}?updated=${encodeURIComponent(r.to)}`);
    } catch (e) { return failed(req, res, e, 'install'); }
  }));

  router.post(`${path}/restore`, form(async (req, res) => {
    try {
      await confirmPassword(req);
      const r = updater.restore(req.body.backup, { root: ROOT(), by: req.user.email });
      await audit.record(req.ctx, 'platform.update_rolled_back', { entityType: 'app_update', entityId: String(req.body.backup || '').slice(0, 60), oldValues: { version: r.from }, newValues: { version: r.to } });
      updater.restartAfter(res, 1500);
      return res.redirect(`${base}?restored=${encodeURIComponent(r.to)}`);
    } catch (e) { return failed(req, res, e, 'restore'); }
  }, render));

}

module.exports = { mount };
