// Lab & imaging orders, referral letters, the patient's files, the clinic's list of tests and the clinical report.
// Mounted at /app (src/routes/app.js) before the visit pages, like the certificates panel:
//   GET  /visits/:id                       → res.locals.ordersPanel for the visit page (then next())
//   POST /visits/:id/orders | /referrals   → write one from the visit
//   GET  /orders/:id, /referrals/:id       → the document (?print=1 on the clinic letterhead)
//   POST /orders/:id/status                → done (with a result note) / cancelled / reopened
//   POST /patients/:id/files               → scanned papers & results (multipart; CSRF checked after parsing)
//   GET  /patients/:id/files/:fid          → the file itself (never cached, sandboxed)
//   /clinic/orders-catalog                 → the clinic's list of lab tests and imaging studies
//   GET  /reports/clinical                 → orders, referrals, files, messages and insured visits for a period
const express = require('express');
const multer = require('multer');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { wrap, form, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const { AppError } = require('../../core/errors');
const lib = require('../clinic/records.lib');
const privacy = require('../clinicalplus/privacy.service');
const svc = require('./orders.service');

const router = express.Router();
const WRITE = ['clinical.edit', 'prescriptions.create'];

/** Clinical records restricted for this member (record privacy) → 404-like refusal, as the visit page does. */
async function clinicalAllowed(req, patientId) {
  const acc = await privacy.access(req.ctx, { patientId });
  return Boolean(acc && acc.clinical);
}

const errText = (req, e) => {
  const code = e.code || 'VALIDATION_FAILED';
  const field = e.details && Object.values(e.details)[0];
  for (const k of [`orders.err.${code}`, `orders.err.${field}`, `errors.${code}`]) { const tr = req.t(k); if (tr !== k) return tr; }
  return e.message;
};

// ---------------------------------------------------------------- visit page panel
router.get('/visits/:id(\\d+)', wrap(async (req, res, next) => {
  const perms = req.ctx.permissions;
  if (!perms.has('clinical.view')) return next();
  const id = Number(req.params.id);
  const a = await knex('appointments').where({ id, business_id: req.ctx.businessId }).first('id', 'patient_id', 'doctor_id', 'appointment_type', 'status');
  if (!a || !a.patient_id || a.appointment_type === 'blocked' || (req.ctx.ownDoctorId && a.doctor_id !== req.ctx.ownDoctorId)) return next();
  if (!(await clinicalAllowed(req, a.patient_id))) return next();
  const canWrite = WRITE.some((p) => perms.has(p)) && a.status !== 'cancelled';
  if (canWrite) await svc.seed(req.ctx.businessId);
  const [catalog, orders, referrals] = await Promise.all([
    canWrite ? svc.catalog(req.ctx.businessId, { activeOnly: true }) : [], svc.ordersForVisit(req.ctx, id), svc.referralsForVisit(req.ctx, id),
  ]);
  res.locals.ordersPanel = { visitId: id, patientId: a.patient_id, catalog, orders, referrals, canWrite, open: req.query.panel || null };
  return next();
}));

const visitWrite = (fn, okKey) => [canAny(...WRITE), wrap(async (req, res) => {
  const id = Number(req.params.id);
  try {
    const a = await knex('appointments').where({ id, business_id: req.ctx.businessId }).first('patient_id');
    if (a && a.patient_id && !(await clinicalAllowed(req, a.patient_id))) throw new AppError('RECORD_RESTRICTED', 'Restricted.', 403);
    const newId = await fn(req, id);
    flash(req, 'success', req.t(okKey));
    return res.redirect(`/app/visits/${id}?${okKey.includes('referral') ? 'referral' : 'order'}=${newId}#orders`);
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', errText(req, e));
    return res.redirect(`/app/visits/${id}?panel=${okKey.includes('referral') ? 'referral' : 'order'}#orders`);
  }
})];
router.post('/visits/:id(\\d+)/orders', ...visitWrite((req, id) => svc.createOrder(req.ctx, id, req.body), 'orders.order_saved'));
router.post('/visits/:id(\\d+)/referrals', ...visitWrite((req, id) => svc.createReferral(req.ctx, id, req.body), 'orders.referral_saved'));

// ---------------------------------------------------------------- documents
const docPage = (view, load) => [can('clinical.view'), wrap(async (req, res) => {
  const doc = await load(req.ctx, Number(req.params.id));
  if (doc.patient_id && !(await clinicalAllowed(req, doc.patient_id))) throw new AppError('RECORD_RESTRICTED', 'Restricted.', 403);
  await privacy.log(req.ctx, { patientId: doc.patient_id, what: view, access: 'full' }).catch(() => {});
  res.page(`pages/orders/${view}`, { title: req.t(`orders.${view}_title`), doc, age: lib.ageOf(doc.date_of_birth, req.ctx.today), printable: true, pageStyles: ['/css/appointments.css'] });
})];
router.get('/orders/:id(\\d+)', ...docPage('order', svc.getOrder));
router.get('/referrals/:id(\\d+)', ...docPage('referral', svc.getReferral));

router.post('/orders/:id(\\d+)/status', canAny('clinical.edit', 'prescriptions.create', 'patients.edit'), wrap(async (req, res) => {
  const o = await svc.getOrder(req.ctx, Number(req.params.id));
  try {
    await svc.setOrderStatus(req.ctx, o.id, req.body);
    flash(req, 'success', req.t('orders.status_saved'));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', errText(req, e));
  }
  const back = String(req.body._return || '');
  res.redirect(/^\/app\/(visits|patients|orders)\/\d+[^\s]*$/.test(back) ? back : `/app/orders/${o.id}`);
}));

// ---------------------------------------------------------------- patient files
const upload = multer({ storage: multer.memoryStorage(), limits: { files: svc.MAX_FILES, fileSize: svc.MAX_FILE_BYTES + 1, fields: 20, fieldSize: 10_000 } });
const parseUpload = (req, res, next) => upload.array('files', svc.MAX_FILES)(req, res, (err) => {
  if (err && err.code && String(err.code).startsWith('LIMIT_')) { req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_BIG' : 'FILE_TOO_MANY'; req.body = req.body || {}; return next(); }
  return next(err);
});
const filesHref = (pid) => `/app/patients/${pid}?tab=orders#files`;

router.post('/patients/:id(\\d+)/files', canAny('clinical.edit', 'prescriptions.create', 'patients.edit'), parseUpload, verifyCsrfAfterUpload, wrap(async (req, res) => {
  const pid = Number(req.params.id);
  try {
    if (req.uploadError) throw new AppError(req.uploadError, 'Upload refused.', 422);
    const ids = await svc.addFiles(req.ctx, pid, req.files, req.body);
    flash(req, 'success', req.t('orders.files_added', { n: ids.length }));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 404) throw e;
    flash(req, 'error', errText(req, e));
  }
  const back = String(req.body._return || '');
  res.redirect(/^\/app\/(visits|patients)\/\d+[^\s]*$/.test(back) ? back : filesHref(pid));
}));

router.get('/patients/:id(\\d+)/files/:fid(\\d+)', can('clinical.view'), wrap(async (req, res) => {
  const pid = Number(req.params.id);
  if (!(await clinicalAllowed(req, pid))) throw new AppError('RECORD_RESTRICTED', 'Restricted.', 403);
  const f = await svc.fileOf(req.ctx, pid, Number(req.params.fid));
  const inline = req.query.download !== '1';
  res.set({
    'Content-Type': f.mime, 'Content-Length': String(f.data.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="file-${f.id}.${f.name.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
  });
  await privacy.log(req.ctx, { patientId: pid, what: 'file', access: 'full' }).catch(() => {});
  await audit.record(req.ctx, 'patient_file.opened', { entityType: 'patient', entityId: pid, newValues: { file_id: f.id } });
  return res.end(f.data);
}));

router.post('/patients/:id(\\d+)/files/:fid(\\d+)/delete', canAny('clinical.edit', 'patients.edit'), wrap(async (req, res) => {
  const pid = Number(req.params.id);
  await svc.removeFile(req.ctx, pid, Number(req.params.fid));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(filesHref(pid));
}));

// ---------------------------------------------------------------- the clinic's list of tests
const CATALOG = '/app/clinic/orders-catalog';
const catalogGate = canAny('settings.manage', 'clinical.edit');
async function renderCatalog(req, res, extra = {}) {
  const rows = await svc.catalog(req.ctx.businessId);
  const kind = svc.KINDS.includes(req.query.kind) ? req.query.kind : 'lab';
  res.page('pages/orders/catalog', { title: req.t('orders.catalog_title'), rows, kind, kinds: svc.KINDS, errors: {}, formError: null, old: {}, ...extra });
}
const rerenderCatalog = (req, res, extra) => renderCatalog(req, res, { ...extra, openDialog: true, formAction: req.originalUrl });
router.get('/clinic/orders-catalog', catalogGate, wrap((req, res) => renderCatalog(req, res)));
router.post('/clinic/orders-catalog', catalogGate, form(async (req, res) => { await svc.saveItem(req.ctx, null, req.body); flash(req, 'success', req.t('orders.item_saved')); res.redirect(`${CATALOG}?kind=${req.body.kind === 'imaging' ? 'imaging' : 'lab'}`); }, rerenderCatalog));
router.post('/clinic/orders-catalog/starter', catalogGate, wrap(async (req, res) => {
  const added = await svc.seed(req.ctx.businessId);
  if (added) await audit.record(req.ctx, 'order_catalog.starter_added', { entityType: 'order_catalog' });
  flash(req, 'success', req.t(added ? 'orders.starter_done' : 'orders.starter_exists'));
  res.redirect(CATALOG);
}));
router.post('/clinic/orders-catalog/:id(\\d+)', catalogGate, form(async (req, res) => { await svc.saveItem(req.ctx, Number(req.params.id), req.body); flash(req, 'success', req.t('common.updated')); res.redirect(`${CATALOG}?kind=${req.body.kind === 'imaging' ? 'imaging' : 'lab'}`); }, rerenderCatalog));
router.post('/clinic/orders-catalog/:id(\\d+)/delete', catalogGate, wrap(async (req, res) => { await svc.removeItem(req.ctx, Number(req.params.id)); flash(req, 'success', req.t('common.deleted')); res.redirect(CATALOG); }));

// ---------------------------------------------------------------- clinical report
router.get('/reports/clinical', can('reports.view'), can('clinical.view'), wrap(async (req, res) => {
  const range = lib.resolveRange(req.query, req.ctx.today);
  const { from, to } = range;
  const [data, messages, insured] = await Promise.all([
    svc.report(req.ctx, from, to),
    knex('message_log').where({ business_id: req.ctx.businessId, status: 'sent' }).where('created_at', '>=', `${from} 00:00:00`).where('created_at', '<=', `${to} 23:59:59`)
      .groupBy('stage', 'channel').select('stage', 'channel').count({ n: '*' }),
    (() => {
      const q = knex('appointments as a').join('patients as p', 'p.id', 'a.patient_id').leftJoin('insurance_providers as ip', 'ip.id', 'p.insurance_provider_id')
        .where({ 'a.business_id': req.ctx.businessId, 'a.status': 'completed' }).whereNotNull('p.insurance_provider_id')
        .whereBetween('a.appointment_date', [from, to]).groupBy('ip.name').select('ip.name').count({ n: '*' }).countDistinct({ patients: 'a.patient_id' }).orderBy('n', 'desc');
      if (req.ctx.ownDoctorId) q.where('a.doctor_id', req.ctx.ownDoctorId);
      return q;
    })(),
  ]);
  const msg = {};
  for (const m of messages) {
    const kind = /^reminder/.test(m.stage) ? 'reminder' : m.stage;
    msg[kind] = msg[kind] || { total: 0 };
    msg[kind][m.channel] = (msg[kind][m.channel] || 0) + Number(m.n);
    msg[kind].total += Number(m.n);
  }
  res.page('pages/orders/report', {
    title: req.t('orders.report_title'), range, data, messages: msg, insured: insured.map((r) => ({ name: r.name, visits: Number(r.n), patients: Number(r.patients) })),
    printable: true,
  });
}));

module.exports = router;
