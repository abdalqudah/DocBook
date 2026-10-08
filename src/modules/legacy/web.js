// Legacy Patient Recovery (Clinic → Import Center → Clinica): the wizard (patients file, attachment ZIPs, preview,
// START IMPORT), the progress dashboard, the error log (retry / ignore / details), the final report (CSV / JSON) and
// the recovery list (link an old file to a patient, or make a patient of it). Only members with data.manage (the
// clinic's owner / admin) reach it; the medical staff read the result on the patient's "Legacy Records" tab.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const knex = require('../../db/knex');
const csv = require('../../core/csv');
const { AppError } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can, ownerOnly } = require('../../middleware/context');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const svc = require('./import.service');
const records = require('./records.service');

const router = express.Router();
router.use(can('data.manage'));

const BASE = '/app/import/legacy-clinica';
const PAGE = { pageStyles: ['/css/legacy.css'], pageScripts: ['/js/legacy-import.js'] };
const MAX = (Number(process.env.LEGACY_IMPORT_MAX_MB) || 8192) * 1024 * 1024;
const wantsJson = (req) => /json/.test(req.get('accept') || '') || req.xhr;
const errText = (req, e) => { const k = `legacy.err.${e.code}`; return req.t(k) !== k ? req.t(k) : e.message; };

router.get('/', wrap(async (req, res) => {
  const [current, history, [{ n }]] = await Promise.all([svc.currentJob(req.ctx.businessId), svc.jobs(req.ctx.businessId),
    knex('legacy_patients').where({ business_id: req.ctx.businessId }).count({ n: '*' })]);
  const promotion = await require('./promote.service').progress(req.ctx.businessId); // eslint-disable-line global-require
  const purge = await require('./purge.service').preview(req.ctx.businessId); // eslint-disable-line global-require
  const rs = require('./remote.service'); // eslint-disable-line global-require
  const remote = await rs.progress(req.ctx.businessId);
  res.page('pages/legacy/center', { title: req.t('legacy.title'), current, history, legacyCount: Number(n), promotion, purge, remote, remoteSignIn: rs.pendingQuestion(req.ctx.businessId), ...PAGE });
}));

// Imported treatments → the patients' own files (treatment plan with the doctors) — for imports made before this
// was part of the import, and again after the clinic adds its doctors. Runs in the background; safe to run again.
// Remove everything that came from Clinica (to import again cleanly) — the owner only, typed confirmation.
router.post('/purge', ownerOnly, wrap(async (req, res) => {
  const word = String(req.body.confirm || '').trim();
  if (!['حذف', 'DELETE', 'delete'].includes(word)) { flash(req, 'error', req.t('legacy.purge_type')); return res.redirect(BASE); }
  require('./purge.service').start(req.ctx); // eslint-disable-line global-require
  flash(req, 'success', req.t('legacy.purge_started'));
  return res.redirect(BASE);
}));

// Direct pull from Clinica (the files the first extraction missed): the owner signs in to Clinica here; the password
// stays in memory while the pull runs (remote.service).
// Step 1: open Clinica's sign-in page (its question, if it asks one, is shown to the owner to answer).
router.post('/remote/prepare', ownerOnly, wrap(async (req, res) => {
  try { await require('./remote.service').prepare(req.ctx, { baseUrl: req.body.base_url }); } catch (e) { flash(req, 'error', e.details ? Object.values(e.details).join(' ') : errText(req, e)); } // eslint-disable-line global-require
  res.redirect(`${BASE}#remote`);
}));
// Step 2: the owner's sign-in (and answer) → the pull starts.
router.post('/remote/start', ownerOnly, wrap(async (req, res) => {
  try {
    await require('./remote.service').start(req.ctx, { baseUrl: req.body.base_url, username: req.body.username, password: req.body.password, captcha: req.body.captcha }); // eslint-disable-line global-require
    flash(req, 'success', req.t('legacy.remote_started'));
  } catch (e) {
    flash(req, 'error', e.details ? Object.values(e.details).join(' ') : errText(req, e));
  }
  res.redirect(`${BASE}#remote`);
}));
router.post('/remote/stop', ownerOnly, wrap(async (req, res) => {
  await require('./remote.service').stop(req.ctx); // eslint-disable-line global-require
  flash(req, 'success', req.t('legacy.remote_stopped'));
  res.redirect(`${BASE}#remote`);
}));
router.get('/remote/status', ownerOnly, wrap(async (req, res) => { res.json(await require('./remote.service').progress(req.ctx.businessId) || {}); })); // eslint-disable-line global-require

router.post('/promote', wrap(async (req, res) => {
  await require('./promote.service').start(req.ctx); // eslint-disable-line global-require
  await require('../../core/audit').record(req.ctx, 'legacy.promote_started', { entityType: 'business', entityId: req.ctx.businessId }); // eslint-disable-line global-require
  flash(req, 'success', req.t('legacy.promote_started'));
  res.redirect(BASE);
}));
router.get('/promote/status', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await require('./promote.service').progress(req.ctx.businessId)); // eslint-disable-line global-require
}));

// The doctors of the Clinica data: which doctor here each name is (or a new doctor, or none), and who did the
// treatments that have no doctor.
router.get('/doctors', wrap(async (req, res) => {
  const { list, doctors, branches, groups } = await require('./promote.service').doctorNames(req.ctx.businessId); // eslint-disable-line global-require
  res.page('pages/legacy/doctors', { title: req.t('legacy.doc_title'), list, doctors, branches, groups, ...PAGE });
}));
router.post('/doctors', wrap(async (req, res) => {
  const keys = [].concat(req.body.key || []);
  const entries = keys.map((k, i) => ({ key: String(k), action: [].concat(req.body.action || [])[i], doctor_id: [].concat(req.body.doctor_id || [])[i] }));
  const gkeys = [].concat(req.body.group_key || []);
  const groups = gkeys.map((k, i) => ({ key: String(k), branch_id: [].concat(req.body.group_branch || [])[i] }));
  await require('./promote.service').saveDoctorMap(req.ctx, entries, groups); // eslint-disable-line global-require
  flash(req, 'success', req.t('legacy.doc_saved'));
  res.redirect(BASE);
}));

router.post('/jobs', wrap(async (req, res) => {
  const job = await svc.openJob(req.ctx);
  res.redirect(`${BASE}/jobs/${job.id}`);
}));

router.get('/jobs/:id(\\d+)', wrap(async (req, res) => {
  const s = await svc.summary(req.ctx.businessId, req.params.id);
  const ef = { level: ['error', 'warning'].includes(req.query.level) ? req.query.level : '', status: ['open', 'ignored', 'resolved'].includes(req.query.estatus) ? req.query.estatus : '', code: /^[A-Z_]{2,40}$/.test(req.query.code || '') ? req.query.code : '' };
  const eq = knex('import_errors').where({ job_id: s.job.id });
  if (ef.level) eq.where('level', ef.level);
  if (ef.status) eq.where('status', ef.status);
  if (ef.code) eq.where('error_code', ef.code);
  const page = Math.max(1, Number(req.query.epage) || 1);
  const [[{ n }], errors, codes] = await Promise.all([eq.clone().count({ n: '*' }), eq.clone().orderBy('id', 'desc').limit(50).offset((page - 1) * 50),
    knex('import_errors').where({ job_id: s.job.id }).distinct('error_code').orderBy('error_code').pluck('error_code')]);
  res.page('pages/legacy/job', {
    title: req.t('legacy.title'), s, recon: svc.reconciliation(s.job), errors, errorTotal: Number(n), errorPage: page, errorPages: Math.max(1, Math.ceil(Number(n) / 50)), ef, codes,
    maxMb: Math.round(MAX / 1048576), ...PAGE,
  });
}));

/** Live state for the dashboard (polled while something runs). */
router.get('/jobs/:id(\\d+)/status', wrap(async (req, res) => {
  const s = await svc.summary(req.ctx.businessId, req.params.id);
  res.set('Cache-Control', 'no-store');
  res.json({
    status: s.job.status, stage: s.job.stage, progress: s.progress, processed: s.job.processed, total: s.job.total, success: s.job.success, failed: s.job.failed, skipped: s.job.skipped,
    patients: s.patients, files: s.files, errors: s.errors, warnings: s.warnings, analyzing: s.zips.analyzing + (s.patientsFile && ['uploaded', 'analyzing'].includes(s.patientsFile.status) ? 1 : 0),
  });
}));

const upload = (req, res, next) => {
  const dir = path.join(svc.ROOT, String(Number(req.ctx.businessId)), 'incoming');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  multer({ dest: dir, limits: { fileSize: MAX, files: 1, fields: 4 } }).single('file')(req, res, (err) => {
    if (err) { req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'IMPORT_TOO_BIG' : 'IMPORT_BAD_FILE'; req.body = req.body || {}; }
    next();
  });
};
const drop = (req) => { if (req.file) fs.rmSync(req.file.path, { force: true }); };
router.post('/jobs/:id(\\d+)/upload', upload, (req, res, next) => verifyCsrfAfterUpload(req, res, (err) => { if (err) drop(req); next(err); }), wrap(async (req, res) => {
  try {
    if (req.uploadError) throw new AppError(req.uploadError, 'Upload refused.', 422);
    if (!req.file) throw new AppError('IMPORT_BAD_FILE', 'Choose a file.', 422);
    const kind = /\.json$/i.test(req.file.originalname || '') ? 'patients_json' : 'attachments_zip';
    const b = await svc.addUpload(req.ctx, req.params.id, req.file, kind);
    if (wantsJson(req)) return res.json({ ok: true, batch: { id: b.id, name: b.original_name, status: b.status, error: b.error } });
    flash(req, b.status === 'duplicate' ? 'warning' : 'success', req.t(b.status === 'duplicate' ? 'legacy.flash_duplicate' : 'legacy.flash_uploaded', { name: b.original_name }));
  } catch (e) {
    drop(req);
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    if (wantsJson(req)) return res.status(e.status || 422).json({ ok: false, code: e.code, message: errText(req, e) });
    flash(req, 'error', errText(req, e));
  }
  return res.redirect(`${BASE}/jobs/${Number(req.params.id)}`);
}));

const act = (fn, okKey) => wrap(async (req, res) => {
  try {
    await fn(req);
    if (okKey) flash(req, 'success', req.t(okKey));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', errText(req, e));
  }
  const back = String(req.body.return_to || '');
  res.redirect(back.startsWith(`${BASE}/`) ? back : `${BASE}/jobs/${Number(req.params.id)}`);
});
router.post('/jobs/:id(\\d+)/batches/:bid(\\d+)/delete', act((req) => svc.removeBatch(req.ctx, req.params.id, req.params.bid), 'legacy.flash_removed'));
router.post('/jobs/:id(\\d+)/start', act((req) => svc.start(req.ctx, req.params.id), 'legacy.flash_started'));
router.post('/jobs/:id(\\d+)/rematch', act((req) => svc.rematchJob(req.ctx, req.params.id, req.body.match_manual === undefined ? {} : { matchManual: req.body.match_manual === '1' }), 'legacy.flash_rematched'));
router.post('/jobs/:id(\\d+)/cancel', act((req) => svc.cancel(req.ctx, req.params.id), 'legacy.flash_cancelled'));
router.post('/jobs/:id(\\d+)/resume', act((req) => svc.resume(req.ctx, req.params.id), 'legacy.flash_resumed'));
router.post('/jobs/:id(\\d+)/errors/:eid(\\d+)/retry', act((req) => svc.retryError(req.ctx, req.params.id, req.params.eid), 'legacy.flash_retry'));
router.post('/jobs/:id(\\d+)/errors/:eid(\\d+)/ignore', act((req) => svc.ignoreError(req.ctx, req.params.id, req.params.eid), null));

// ---------------------------------------------------------------- final report
router.get('/jobs/:id(\\d+)/report.json', wrap(async (req, res) => {
  const r = await svc.report(req.ctx.businessId, req.params.id);
  const { job } = r.summary;
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `attachment; filename="legacy-import-${job.id}.json"`);
  res.json({
    job: { id: job.id, source: svc.SOURCE, status: job.status, started_at: job.started_at, completed_at: job.completed_at, total: job.total, processed: job.processed, success: job.success, failed: job.failed, skipped: job.skipped },
    reconciliation: r.reconciliation,
    batches: r.summary.batches.map((b) => ({ kind: b.kind, name: b.original_name, size: Number(b.size), sha256: b.sha256, batch: b.batch_no, of: b.batch_total, status: b.status, entries: b.entries, valid: b.valid_files, invalid: b.invalid_files, error: b.error })),
    missing_batches: r.summary.zips.missing,
    items: r.items, errors: r.errors,
  });
}));
router.get('/jobs/:id(\\d+)/report.csv', wrap(async (req, res) => {
  const r = await svc.report(req.ctx.businessId, req.params.id);
  const rows = [];
  r.reconciliation.forEach((x) => rows.push(['reconciliation', x.key, '', '', '', x.source, x.system ?? '', x.difference ?? '', '']));
  r.items.forEach((i) => rows.push([i.kind, i.ref, i.legacy_patient_id || '', i.legacy_patient_number || '', i.display_name || '', i.match || '', i.status, i.target_id || '', i.message || '']));
  r.errors.forEach((e) => rows.push([`error:${e.level}`, e.file || '', e.legacy_patient_id || '', e.stage, e.error_code, e.status, e.message, '', e.created_at ? new Date(e.created_at).toISOString() : '']));
  csv.send(res, `legacy-import-${r.summary.job.id}.csv`, ['section', 'ref / key', 'legacy_patient_id', 'legacy_patient_number / stage', 'name / code', 'match / source', 'status / system', 'patient / difference', 'message / time'], rows);
}));

// ---------------------------------------------------------------- recovery
router.get('/recovery', wrap(async (req, res) => {
  const status = ['matched', 'unmatched'].includes(req.query.status) ? req.query.status : '';
  const list = await records.recoveryList(req.ctx.businessId, { q: req.query.q, status, page: req.query.page });
  res.page('pages/legacy/recovery', { title: req.t('legacy.recovery'), list, q: String(req.query.q || '').slice(0, 100), status, ...PAGE });
}));
router.post('/recovery/:ref(\\d+)/link', wrap(async (req, res) => {
  try {
    const pid = await svc.linkPatient(req.ctx, req.params.ref, req.body.patient_id);
    flash(req, 'success', req.t('legacy.flash_linked'));
    return res.redirect(`/app/patients/${pid}`);
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', e.code === 'VALIDATION_FAILED' ? req.t('legacy.err.PATIENT_INVALID') : errText(req, e));
    return res.redirect(`${BASE}/recovery`);
  }
}));
router.post('/recovery/:ref(\\d+)/create', wrap(async (req, res) => {
  try {
    const pid = await svc.createFromLegacy(req.ctx, req.params.ref);
    flash(req, 'success', req.t('legacy.flash_recovered'));
    return res.redirect(`/app/patients/${pid}`);
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', errText(req, e));
    return res.redirect(`${BASE}/recovery`);
  }
}));

module.exports = router;
