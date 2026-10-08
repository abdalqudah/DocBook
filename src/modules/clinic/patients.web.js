// Patients: searchable register, profile with visit timeline, add / edit / delete.
// A doctor login limited to its own schedule (ctx.ownDoctorId) only sees patients it has booked at least once.
// The clinic's record-privacy rule (clinicalplus/privacy.service) decides whether the clinical parts of the
// profile open for this member; every profile view is written to the record-access log.
const express = require('express');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const exporter = require('../../core/exporter');
const { AppError, E } = require('../../core/errors');
const { wrap, form, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const appts = require('./appointments.service');
const clinical = require('./clinical.service');
const lib = require('./records.lib');
const icd = require('../clinicalplus/icd.service');
const privacy = require('../clinicalplus/privacy.service');
const payParts = require('./payment-parts');

const router = express.Router();
router.use(can('patients.view'));

const PAGE_SCRIPTS = ['/js/records.js'];
const PAGE_STYLES = ['/css/records.css'];
const SHOW_STYLES = ['/css/records.css', '/css/clinicalplus.css'];

function listQuery(ctx, query) {
  const q = knex('patients').leftJoin('insurance_providers as ip', function j() { this.on('ip.id', 'patients.insurance_provider_id').andOn('ip.business_id', 'patients.business_id'); })
    .where('patients.business_id', ctx.businessId);
  if (query.q && String(query.q).trim()) {
    const term = lib.likeTerm(query.q);
    q.andWhere((w) => {
      ['full_name', 'name_en', 'phone', 'phone2', 'email', 'national_id', 'insurance_number', 'file_number'].forEach((c) => w.orWhere(`patients.${c}`, 'like', term));
      lib.nameMatch(w, 'patients.full_name', query.q);
      // The previous system's patient id / number (exact).
      const raw = String(query.q).trim().slice(0, 64);
      w.orWhere('patients.legacy_patient_id', raw).orWhere('patients.legacy_patient_number', raw);
    });
  }
  // Patients moved to another clinic of the owner stay here as an archive, shown only when asked for.
  if (query.moved === '1') q.whereNotNull('patients.transferred_at'); else q.whereNull('patients.transferred_at');
  if (query.insurance === 'none') q.whereNull('patients.insurance_provider_id');
  else if (/^\d+$/.test(query.insurance || '')) q.where('patients.insurance_provider_id', Number(query.insurance));
  applyFilters(q, query, ctx);
  lib.scopePatientsToDoctor(q, ctx.ownDoctorId);
  const visitScope = ctx.ownDoctorId ? knex.raw(' AND a.doctor_id = ?', [ctx.ownDoctorId]).toString() : '';
  q.select('patients.*', 'ip.name as insurance_name',
    knex.raw(`(SELECT COUNT(*) FROM appointments a WHERE a.patient_id = patients.id AND a.status = 'completed'${visitScope}) as visits`),
    knex.raw(`(SELECT MAX(a.appointment_date) FROM appointments a WHERE a.patient_id = patients.id AND a.status = 'completed'${visitScope}) as last_visit`),
    knex.raw(`(SELECT MIN(a.appointment_date) FROM appointments a WHERE a.patient_id = patients.id AND a.appointment_date >= ? AND a.status IN ('pending','confirmed') AND a.appointment_type <> 'blocked'${visitScope}) as next_visit`, [ctx.today]));
  // Sort: the chosen column, in the chosen direction (each column has its natural default).
  const SORTS = { name: ['patients.full_name', 'asc'], last: [knex.raw('last_visit'), 'desc'], created: ['patients.created_at', 'desc'],
    file: [knex.raw('CAST(patients.file_number AS UNSIGNED)'), 'asc'], dob: ['patients.date_of_birth', 'asc'], visits: [knex.raw('visits'), 'desc'] };
  const [col, natural] = SORTS[query.sort] || SORTS.created;
  q.orderBy(col, query.dir === 'asc' || query.dir === 'desc' ? query.dir : natural);
  q.orderBy('patients.id', 'desc');
  return q;
}

// The advanced filters of the patients list (all optional; each value is checked before it reaches the query).
const FILTER_KEYS = ['file', 'name', 'gender', 'mobile', 'email', 'group', 'nationality', 'note', 'category', 'from', 'to', 'city', 'month', 'manager', 'referral', 'blood', 'tag'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function applyFilters(q, f, ctx = {}) {
  const text = (v) => String(v || '').trim().slice(0, 80);
  const like = (v) => lib.likeTerm(v);
  const profile = require('./patient-profile'); // eslint-disable-line global-require
  if (text(f.file)) q.where('patients.file_number', 'like', `${text(f.file).replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
  if (text(f.name)) q.andWhere((w) => { lib.nameMatch(w, 'patients.full_name', text(f.name)); w.orWhere('patients.name_en', 'like', like(f.name)); });
  if (['male', 'female'].includes(f.gender)) q.where('patients.gender', f.gender);
  const digits = String(f.mobile || '').replace(/[^0-9]/g, '');
  if (digits.length >= 3) q.andWhere((w) => w.where('patients.phone', 'like', `%${digits}%`).orWhere('patients.phone2', 'like', `%${digits}%`));
  if (text(f.email)) q.where('patients.email', 'like', like(f.email));
  if (/^\d+$/.test(f.group || '')) q.whereExists(function g() { this.select(knex.raw(1)).from('patient_group_members as m').whereRaw('m.patient_id = patients.id').where('m.group_id', Number(f.group)); });
  if (f.group === 'none') q.whereNotExists(function g() { this.select(knex.raw(1)).from('patient_group_members as m').whereRaw('m.patient_id = patients.id'); });
  if (profile.COUNTRIES.includes(f.nationality)) q.where('patients.nationality', f.nationality);
  if (text(f.note)) q.andWhere((w) => w.where('patients.notes', 'like', like(f.note)).orWhere('patients.important_note', 'like', like(f.note)));
  if (f.category === 'standard') q.andWhere((w) => w.whereNull('patients.category').orWhere('patients.category', 'standard'));
  else if (profile.CATEGORIES.includes(f.category)) q.where('patients.category', f.category);
  // Days of the clinic's calendar (created_at is stored in UTC).
  const tz = ctx.timezone || 'Asia/Amman';
  const { zonedToUtc } = require('../attendance/attendance.service'); // eslint-disable-line global-require
  const dayAfter = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  if (ISO_DAY.test(f.from || '') && !Number.isNaN(Date.parse(f.from))) q.where('patients.created_at', '>=', zonedToUtc(f.from, '00:00', tz));
  if (ISO_DAY.test(f.to || '') && !Number.isNaN(Date.parse(f.to))) q.where('patients.created_at', '<', zonedToUtc(dayAfter(f.to), '00:00', tz));
  if (text(f.city)) q.andWhere((w) => w.where('patients.city', 'like', like(f.city)).orWhere('patients.area', 'like', like(f.city)));
  if (/^(?:[1-9]|1[0-2])$/.test(f.month || '')) q.whereRaw('MONTH(patients.date_of_birth) = ?', [Number(f.month)]);
  if (/^\d+$/.test(f.manager || '')) q.where('patients.case_manager_id', Number(f.manager));
  if (profile.REFERRAL.includes(f.referral)) q.where('patients.referral_source', f.referral);
  if (profile.BLOOD.includes(f.blood)) q.where('patients.blood_group', f.blood);
  if (f.tag === 'important') q.whereNotNull('patients.important_note').whereNot('patients.important_note', '');
  if (f.tag === 'allergy') q.whereNotNull('patients.allergies').whereNot('patients.allergies', '');
  if (f.tag === 'no_reminders') q.where('patients.messaging_opt_out', true);
  if (f.tag === 'discount') q.where('patients.discount_percent', '>', 0);
}

/** What the patient form needs for its fuller profile (choices, team, groups, last file number). */
async function profileLocals(req, patientId = null) {
  const profile = require('./patient-profile'); // eslint-disable-line global-require
  const [managers, groups, mine, last] = await Promise.all([profile.managers(req.ctx.businessId), profile.groups(req.ctx.businessId),
    patientId ? profile.groupsOf(req.ctx.businessId, patientId) : [], profile.lastFileNumber(req.ctx.businessId)]);
  return { pp: { choices: profile.choices(req.t, req.locale), managers, groups, mine: mine.map((g) => g.id), last } };
}

async function render(req, res, extra = {}) {
  const [{ rows, meta }, insurance] = await Promise.all([
    lib.paginate(listQuery(req.ctx, req.query), { page: req.query.page, perPage: 25 }),
    clinical.activeInsurance(req.ctx),
  ]);
  const filtered = ['q', 'insurance', 'moved', ...FILTER_KEYS].some((k) => req.query[k] && req.query[k] !== 'all');
  // Moving / sharing patients to another clinic of the owner (patienttransfer): offered when there is one.
  const transfer = req.ctx.permissions.has('data.manage') ? await require('../patienttransfer/transfer.service').targets(req.ctx) : []; // eslint-disable-line global-require
  const advanced = FILTER_KEYS.some((k) => req.query[k] && req.query[k] !== 'all');
  res.page('pages/clinic/patients/index', {
    title: req.t('patients.title'), rows, meta, insurance, filtered, advanced, ageOf: (d) => lib.ageOf(d, req.ctx.today), transferTargets: transfer,
    movedView: req.query.moved === '1',
    fl: await (async () => { const profile = require('./patient-profile'); return { choices: profile.choices(req.t, req.locale), groups: await profile.groups(req.ctx.businessId), managers: await profile.managers(req.ctx.businessId) }; })(), // eslint-disable-line global-require
    ...(req.ctx.permissions.has('patients.create') ? await profileLocals(req) : { pp: null }),
    pageScripts: transfer.length ? [...PAGE_SCRIPTS, '/js/patient-transfer.js'] : PAGE_SCRIPTS, pageStyles: PAGE_STYLES, ...extra,
  });
}

router.get('/', wrap((req, res) => render(req, res)));

// The patient list (same search and filter as the screen) on the clinic letterhead.
router.get('/print', wrap(async (req, res) => {
  const rows = await listQuery(req.ctx, req.query).limit(2000);
  res.page('pages/clinic/patients/print-list', { title: req.t('prints.patient_list'), rows, capped: rows.length >= 2000, ageOf: (d) => lib.ageOf(d, req.ctx.today), printable: true });
}));

// ---------------------------------------------------------------- every patient's file in one ZIP (patientexport/bulk.service.js)
const bulk = require('../patientexport/bulk.service');
const bulkPage = (req, res) => res.page('pages/clinic/patients/export-all', {
  title: req.t('patient_export.bulk.title'), exports: bulk.list(req.ctx.businessId), pageScripts: ['/js/patient-export.js'], pageStyles: PAGE_STYLES,
  imports: req.ctx.permissions.has('data.manage') ? require('../patientexport/import.service').list(req.ctx.businessId) : null, // eslint-disable-line global-require
  importMaxMb: Math.round((Number(process.env.PATIENT_IMPORT_MAX_MB) || 4096)),
});
router.get('/export-all', can('data.export'), wrap(async (req, res) => bulkPage(req, res)));
router.get('/export-all/status', can('data.export'), wrap(async (req, res) => {
  const run = bulk.list(req.ctx.businessId).find((x) => x.state === 'running');
  res.set('Cache-Control', 'no-store');
  return res.json(run ? { state: 'running', done: run.done || 0, total: run.total || 0 } : { state: 'idle' });
}));
router.post('/export-all', can('data.export'), wrap(async (req, res) => {
  try {
    await bulk.start(req.ctx, req.locale);
    flash(req, 'success', req.t('patient_export.bulk.started'));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', req.t(`patient_export.bulk.err.${e.code}`) !== `patient_export.bulk.err.${e.code}` ? req.t(`patient_export.bulk.err.${e.code}`) : e.message);
  }
  return res.redirect('/app/patients/export-all');
}));
router.get('/export-all/:name', can('data.export'), wrap(async (req, res) => {
  const { file } = bulk.fileOf(req.ctx.businessId, req.params.name);
  await audit.record(req.ctx, 'patients.export_downloaded', { entityType: 'patient_export', entityId: null, newValues: { file: req.params.name } });
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  return res.download(file, req.params.name);
}));
router.post('/export-all/:name/delete', can('data.export'), wrap(async (req, res) => {
  await bulk.removeOne(req.ctx, req.params.name);
  flash(req, 'success', req.t('patient_export.bulk.deleted'));
  return res.redirect('/app/patients/export-all');
}));

// ---------------------------------------------------------------- importing exported files (patientexport/import.service.js)
const importer = require('../patientexport/import.service');
const multer = require('multer');
const fsx = require('fs');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const IMPORT_MAX = (Number(process.env.PATIENT_IMPORT_MAX_MB) || 4096) * 1024 * 1024;
const importUpload = (req, res, next) => {
  const dir = require('path').join(importer.dirOf(req.ctx.businessId), 'incoming'); // eslint-disable-line global-require
  fsx.mkdirSync(dir, { recursive: true, mode: 0o700 });
  multer({ dest: dir, limits: { fileSize: IMPORT_MAX, files: 1, fields: 5 } }).single('file')(req, res, (err) => {
    if (err) { req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'IMPORT_TOO_BIG' : 'IMPORT_BAD_FILE'; req.body = req.body || {}; }
    next();
  });
};
const dropUpload = (req) => { if (req.file) { try { fsx.unlinkSync(req.file.path); } catch { /* gone */ } } };
const importErr = (req, e) => { const k = `patient_export.import.err.${e.code}`; return req.t(k) !== k ? req.t(k) : e.message; };
router.post('/import', can('data.manage'), importUpload, (req, res, next) => verifyCsrfAfterUpload(req, res, (err) => { if (err) dropUpload(req); next(err); }), wrap(async (req, res) => {
  try {
    if (req.uploadError) throw new AppError(req.uploadError, 'Upload refused.', 422);
    if (!req.file) throw new AppError('IMPORT_BAD_FILE', 'Choose a file.', 422);
    const a = await importer.analyze(req.ctx, req.file.path);
    return res.redirect(`/app/patients/import/${a.token}`);
  } catch (e) {
    dropUpload(req);
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', importErr(req, e));
    return res.redirect('/app/patients/export-all#import');
  }
}));
router.get('/import-status', can('data.manage'), wrap(async (req, res) => {
  const run = importer.list(req.ctx.businessId).find((x) => x.state === 'running');
  res.set('Cache-Control', 'no-store');
  return res.json(run ? { state: 'running', done: run.done || 0, total: run.total || 0 } : { state: 'idle' });
}));
router.get('/import/:token', can('data.manage'), wrap(async (req, res) => {
  const imp = importer.get(req.ctx.businessId, req.params.token);
  if (imp.state !== 'ready') return res.redirect('/app/patients/export-all#import');
  const doctors = await knex('doctors').where({ business_id: req.ctx.businessId }).orderBy('full_name').select('id', 'full_name');
  return res.page('pages/clinic/patients/import', { title: req.t('patient_export.import.title'), imp, doctors, pageStyles: PAGE_STYLES });
}));
router.post('/import/:token', can('data.manage'), wrap(async (req, res) => {
  try {
    await importer.start(req.ctx, req.params.token, req.body);
    flash(req, 'success', req.t('patient_export.import.started'));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', importErr(req, e));
  }
  return res.redirect('/app/patients/export-all#import');
}));
router.post('/import/:token/cancel', can('data.manage'), wrap(async (req, res) => {
  importer.cancel(req.ctx, req.params.token);
  return res.redirect('/app/patients/export-all#import');
}));

router.get('/export', can('data.export'), wrap(async (req, res) => {
  const rows = await listQuery(req.ctx, req.query).limit(20000);
  const t = req.t;
  exporter.send(req, res, {
    name: t('patients.title'),
    header: [t('patients.full_name'), t('common.phone'), t('common.email'), t('patients.dob'), t('patients.gender'), t('patients.national_id'),
      t('patients.insurance'), t('patients.insurance_number'), t('patients.allergies'), t('patients.chronic'), t('patients.visits'), t('patients.last_visit'), t('common.created_at')],
    rows: rows.map((r) => [r.full_name, r.phone || '', r.email || '', r.date_of_birth || '', r.gender ? t(`patients.genders.${r.gender}`) : '', r.national_id || '',
      r.insurance_name || '', r.insurance_number || '', r.allergies || '', r.chronic_conditions || '', Number(r.visits) || 0, r.last_visit || '', r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '']),
  });
}));

const rerenderNew = (req, res, extra) => render(req, res, { ...extra, openDialog: 'patient-dialog' });
router.post('/', can('patients.create'), form(async (req, res) => {
  const id = await appts.savePatient(req.ctx, null, req.body);
  flash(req, 'success', req.t('patients.saved'));
  res.redirect(`/app/patients/${id}`);
}, rerenderNew));

// ---------------------------------------------------------------- one patient
async function loadPatient(req) {
  const id = Number(req.params.id);
  const q = knex('patients').leftJoin('insurance_providers as ip', function j() { this.on('ip.id', 'patients.insurance_provider_id').andOn('ip.business_id', 'patients.business_id'); })
    .where({ 'patients.business_id': req.ctx.businessId, 'patients.id': id }).first('patients.*', 'ip.name as insurance_name');
  lib.scopePatientsToDoctor(q, req.ctx.ownDoctorId);
  const p = await q;
  if (!p) throw E.notFound('Patient');
  return p;
}

/** Visit-centred timeline: each appointment carries its diagnosis, prescriptions and invoice. */
function buildTimeline(tl, perms, ownDoctorId, clinicalAllowed = true, codes = new Map()) {
  const showClinical = perms.has('clinical.view') && clinicalAllowed;
  const showBilling = perms.has('billing.view');
  const mine = (r) => !ownDoctorId || r.doctor_id === ownDoctorId;
  const appointments = tl.appointments.filter(mine);
  const byAppt = new Map(appointments.map((a) => [a.id, { kind: 'visit', appt: a, consultation: null, prescriptions: [], invoice: null, codes: showClinical ? codes.get(a.id) || [] : [], sortKey: `${a.appointment_date} ${a.appointment_time}` }]));
  const loose = [];
  const stamp = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');
  if (showClinical) {
    tl.consultations.filter(mine).forEach((c) => { const v = byAppt.get(c.appointment_id); if (v) v.consultation = c; else if (c.diagnosis) loose.push({ kind: 'diagnosis', row: c, sortKey: stamp(c.created_at) }); });
    tl.prescriptions.filter(mine).forEach((rx) => {
      const items = clinical.parseJson(rx.items, []);
      const row = { ...rx, items };
      const v = byAppt.get(rx.appointment_id); if (v) v.prescriptions.push(row); else loose.push({ kind: 'prescription', row, sortKey: stamp(rx.created_at) });
    });
  }
  if (showBilling) {
    tl.invoices.forEach((inv) => { const v = byAppt.get(inv.appointment_id); if (v && !v.invoice) v.invoice = inv; else loose.push({ kind: 'invoice', row: inv, sortKey: stamp(inv.created_at) }); });
  }
  return [...byAppt.values(), ...loose].sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
}

async function renderShow(req, res, extra = {}) {
  const p = await loadPatient(req);
  const access = await privacy.access(req.ctx, { patientId: p.id });
  const canAudit = req.ctx.permissions.has('audit.view');
  // "Last opened by" (owners / audit.view) — read before this view is logged.
  const lastOpened = canAudit ? await knex('record_access_log as l').leftJoin('users as u', 'u.id', 'l.user_id')
    .where({ 'l.business_id': req.ctx.businessId, 'l.patient_id': p.id }).orderBy('l.id', 'desc').limit(5)
    .select('l.created_at', 'l.what', 'l.access', 'l.user_id', 'u.name as user_name') : [];
  await privacy.log(req.ctx, { patientId: p.id, what: 'patient', access: privacy.levelOf(access) });
  const tl = await appts.timeline(req.ctx, p.id);
  if (tl.invoices && tl.invoices.length) await payParts.attach(req.ctx.businessId, tl.invoices); // how each invoice was paid (parts)
  const clinicalOk = req.ctx.permissions.has('clinical.view') && access.clinical;
  const codes = clinicalOk ? await icd.diagnosesByAppointment(req.ctx.businessId, tl.appointments.map((a) => a.id)) : new Map();
  const mine = (r) => !req.ctx.ownDoctorId || r.doctor_id === req.ctx.ownDoctorId;
  const apptsMine = tl.appointments.filter(mine);
  const today = req.ctx.today;
  const completed = apptsMine.filter((a) => a.status === 'completed');
  const stats = {
    visits: completed.length,
    noShows: apptsMine.filter((a) => a.status === 'no_show').length,
    cancelled: apptsMine.filter((a) => a.status === 'cancelled').length,
    totalPaid: tl.invoices.reduce((s, i) => s + Number(i.amount || 0), 0),
    invoices: tl.invoices.length,
    lastVisit: completed.filter((a) => a.appointment_date <= today).map((a) => a.appointment_date).sort().pop() || null,
  };
  const upcoming = apptsMine.filter((a) => a.appointment_date >= today && ['pending', 'confirmed'].includes(a.status))
    .sort((a, b) => `${a.appointment_date} ${a.appointment_time}`.localeCompare(`${b.appointment_date} ${b.appointment_time}`));
  const latestDiagnosis = clinicalOk ? ((tl.consultations.filter(mine).find((c) => c.diagnosis) || {}).diagnosis || null) : null;
  const timeline = buildTimeline(tl, req.ctx.permissions, req.ctx.ownDoctorId, access.clinical, codes);
  // Patient workspace tabs (redesign 3.9): one address, ?tab=…; a tab shows only to members who may see its records.
  const perms = req.ctx.permissions;
  const surgeriesOn = (perms.has('clinical.view') || perms.has('appointments.manage')) && (typeof res.locals.moduleOn !== 'function' || res.locals.moduleOn('surgeries'));
  const tabs = ['overview', clinicalOk || (perms.has('clinical.view') && !access.clinical) ? 'clinical' : null, 'appointments', surgeriesOn ? 'surgeries' : null, clinicalOk ? 'prescriptions' : null,
    clinicalOk ? 'orders' : null, perms.has('certificates.view') || clinicalOk ? 'documents' : null, perms.has('billing.view') ? 'billing' : null, 'timeline',
    // Legacy Records: what was brought from the previous system (legacy/records.service), for those who see the record.
    clinicalOk && (p.legacy_patient_id || await knex('legacy_patients').where({ business_id: req.ctx.businessId, patient_id: p.id }).first('id')
      || await knex('patient_attachments').where({ business_id: req.ctx.businessId, patient_id: p.id }).first('id')) ? 'legacy' : null].filter(Boolean);
  const tab = tabs.includes(req.query.tab) ? req.query.tab : 'overview';
  const byDateDesc = (a, b) => `${b.appointment_date} ${b.appointment_time}`.localeCompare(`${a.appointment_date} ${a.appointment_time}`);
  const prescriptions = clinicalOk ? timeline.flatMap((e) => (e.kind === 'visit' ? e.prescriptions.map((rx) => ({ ...rx, appt: e.appt })) : e.kind === 'prescription' ? [e.row] : [])) : [];
  let certificates = [];
  if (tab === 'documents' && perms.has('certificates.view')) {
    const q = knex('certificates').where({ business_id: req.ctx.businessId, patient_id: p.id }).orderBy('issued_at', 'desc').limit(100)
      .select('id', 'doc_type', 'serial', 'issued_at', 'revoked_at', 'doctor_name', 'doctor_name_en', 'appointment_id', 'doctor_id');
    if (req.ctx.ownDoctorId) q.where('doctor_id', req.ctx.ownDoctorId);
    certificates = await q;
  }
  // Tests, referrals and the patient's files (modules/orders) — loaded only on their tab.
  let orderTab = null;
  if (tab === 'orders') {
    const orders = require('../orders/orders.service'); // eslint-disable-line global-require
    const [ol, rl, fl] = await Promise.all([orders.ordersForPatient(req.ctx, p.id), orders.referralsForPatient(req.ctx, p.id), orders.filesForPatient(req.ctx, p.id)]);
    orderTab = { orders: ol, referrals: rl, files: fl };
  }
  // Other clinics of the owner this patient is known in (shared / moved) — patienttransfer.
  const tsvc = require('../patienttransfer/transfer.service'); // eslint-disable-line global-require
  const transferLinks = await tsvc.linksOf(req.ctx.businessId, p.id);
  const movedTo = p.transferred_at ? transferLinks.find((l) => l.kind === 'moved_to') || { other_name: null } : null;
  const canTransfer = perms.has('data.manage') && (await tsvc.targets(req.ctx)).length > 0;
  const legacy = tab === 'legacy' ? await require('../legacy/records.service').forPatient(req.ctx.businessId, p.id) : null; // eslint-disable-line global-require
  if (legacy) await privacy.log(req.ctx, { patientId: p.id, what: 'legacy_records', access: privacy.levelOf(access) });
  // Surgeries (Patients → Surgeries): the tab lists them all, the overview shows the coming ones.
  const surgeries = surgeriesOn ? await require('../surgeries/surgeries.service').forPatient(req.ctx, p.id) : []; // eslint-disable-line global-require
  const unpaid = perms.has('billing.view') ? apptsMine.filter((a) => a.payment_status !== 'paid' && (a.status === 'completed' || a.checked_in) && a.appointment_date <= today && !['cancelled', 'no_show'].includes(a.status)) : [];
  const profile = require('./patient-profile'); // eslint-disable-line global-require
  const [ppGroups, ppPhoto, ppPeople] = await Promise.all([profile.groupsOf(req.ctx.businessId, p.id), profile.hasPhoto(req.ctx.businessId, p.id),
    knex('users').whereIn('id', [p.case_manager_id, p.updated_by].filter(Boolean)).select('id', 'name')]);
  const nameOf = (uid) => (ppPeople.find((u) => u.id === uid) || {}).name || null;
  res.page('pages/clinic/patients/show', {
    pprofile: { groups: ppGroups, photo: ppPhoto, manager: nameOf(p.case_manager_id), updatedBy: nameOf(p.updated_by), choices: profile.choices(req.t, req.locale) },
    tab, tabs, prescriptions, certificates, orderTab, legacy, transferLinks, movedTo, canTransfer, unpaid, surgeries, surgeriesOn, canSurgery: perms.has('appointments.manage') || Boolean(req.ctx.ownDoctorId && perms.has('clinical.edit')), allAppointments: apptsMine.slice().sort(byDateDesc),
    reportVisits: clinicalOk ? timeline.filter((e) => e.kind === 'visit' && e.consultation).map((e) => e.appt) : [],
    title: p.full_name, patient: p, stats, upcoming, latestDiagnosis, access, lastOpened, icdTitle: (r) => icd.titleOf(r, req.locale),
    timeline, invoices: tl.invoices.filter(mine),
    age: lib.ageOf(p.date_of_birth, today), wa: lib.waNumber(p.phone), statusTone: lib.STATUS_TONE,
    pageScripts: tab === 'legacy' ? [...PAGE_SCRIPTS, '/js/legacy-import.js'] : PAGE_SCRIPTS, pageStyles: tab === 'legacy' ? [...SHOW_STYLES, '/css/legacy.css'] : SHOW_STYLES, ...extra,
  });
}
router.get('/:id(\\d+)', wrap((req, res) => renderShow(req, res)));

// Patient file summary on the clinic letterhead: details, allergies and chronic conditions, then — for members who
// may read the clinical record — visits with diagnoses, prescriptions, tests and referrals.
router.get('/:id(\\d+)/summary', wrap(async (req, res) => {
  const p = await loadPatient(req);
  const access = await privacy.access(req.ctx, { patientId: p.id });
  const clinicalOk = req.ctx.permissions.has('clinical.view') && access.clinical;
  await privacy.log(req.ctx, { patientId: p.id, what: 'summary', access: privacy.levelOf(access) });
  const tl = await appts.timeline(req.ctx, p.id);
  const mine = (r) => !req.ctx.ownDoctorId || r.doctor_id === req.ctx.ownDoctorId;
  const visits = tl.appointments.filter(mine).filter((a) => a.status === 'completed').slice(0, 60);
  let clinicalData = null;
  if (clinicalOk) {
    const codes = await icd.diagnosesByAppointment(req.ctx.businessId, visits.map((a) => a.id));
    const consult = new Map(tl.consultations.filter(mine).map((c) => [c.appointment_id, c]));
    const orders = require('../orders/orders.service'); // eslint-disable-line global-require
    const [ol, rl] = await Promise.all([orders.ordersForPatient(req.ctx, p.id), orders.referralsForPatient(req.ctx, p.id)]);
    const vitals = tl.consultations.filter(mine).map((c) => ({ at: c.created_at, v: clinical.parseJson(c.vital_signs, {}) })).find((x) => x.v && Object.values(x.v).some(Boolean)) || null;
    clinicalData = {
      visits: visits.map((a) => ({ ...a, consultation: consult.get(a.id) || null, codes: codes.get(a.id) || [] })),
      prescriptions: tl.prescriptions.filter(mine).slice(0, 30).map((rx) => ({ ...rx, items: clinical.parseJson(rx.items, []) })),
      orders: ol.slice(0, 30), referrals: rl.slice(0, 30), vitals,
    };
  }
  res.page('pages/clinic/patients/summary', {
    title: p.full_name, patient: p, age: lib.ageOf(p.date_of_birth, req.ctx.today), visits, clinicalData, icdTitle: (r) => icd.titleOf(r, req.locale),
    upcoming: tl.appointments.filter(mine).filter((a) => a.appointment_date >= req.ctx.today && ['pending', 'confirmed'].includes(a.status)).slice(0, 10),
    printable: true,
  });
}));

// The whole file as one ZIP (summary PDF, every paper as PDF, the stored files, data.json) — patientexport/export.service.js.
router.post('/:id(\\d+)/export', canAny('clinical.view', 'data.export'), wrap(async (req, res) => {
  const out = await require('../patientexport/export.service').build(req.ctx, Number(req.params.id), req.locale); // eslint-disable-line global-require
  res.set({
    'Content-Type': 'application/zip', 'Content-Length': String(out.buffer.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename="${out.filename}"`,
  });
  return res.end(out.buffer);
}));

async function renderEdit(req, res, extra = {}) {
  const p = await loadPatient(req);
  const insurance = await clinical.activeInsurance(req.ctx);
  // Keep a provider that was deactivated after being assigned, so saving doesn't silently drop it.
  if (p.insurance_provider_id && !insurance.some((i) => i.id === p.insurance_provider_id) && p.insurance_name) insurance.push({ id: p.insurance_provider_id, name: p.insurance_name });
  res.page('pages/clinic/patients/edit', { title: req.t('patients.edit'), patient: p, insurance, ...(await profileLocals(req, p.id)), hasPhoto: await require('./patient-profile').hasPhoto(req.ctx.businessId, p.id), // eslint-disable-line global-require
    pageScripts: PAGE_SCRIPTS, pageStyles: PAGE_STYLES, ...extra });
}
router.get('/:id(\\d+)/edit', can('patients.edit'), wrap((req, res) => renderEdit(req, res)));
router.post('/:id(\\d+)/edit', can('patients.edit'), form(async (req, res) => {
  const p = await loadPatient(req);
  await appts.savePatient(req.ctx, p.id, req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(`/app/patients/${p.id}`);
}, renderEdit));

// Patient photo: shown on the file to whoever can open it; set or removed by those who edit patients.
const photoUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 + 1, files: 1, fields: 4 } }).single('photo');
router.get('/:id(\\d+)/photo', wrap(async (req, res) => {
  const p = await loadPatient(req);
  const ph = await require('./patient-profile').photoOf(req.ctx.businessId, p.id); // eslint-disable-line global-require
  if (!ph) return res.status(404).end();
  res.set({ 'Content-Type': ph.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  return res.end(ph.data);
}));
router.post('/:id(\\d+)/photo', can('patients.edit'), (req, res, next) => photoUpload(req, res, (err) => {
  if (err) { flash(req, 'error', req.t('pprofile.photo_too_big')); return res.redirect(`/app/patients/${Number(req.params.id)}/edit`); }
  return next();
}), require('../../middleware/web').verifyCsrfAfterUpload, wrap(async (req, res) => {
  const p = await loadPatient(req);
  const profile = require('./patient-profile'); // eslint-disable-line global-require
  try {
    if (req.body.remove === '1') await profile.removePhoto(req.ctx, p.id);
    else await profile.setPhoto(req.ctx, p.id, req.file);
    flash(req, 'success', req.t('common.updated'));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', req.t(`pprofile.photo_errors.${e.code}`));
  }
  res.redirect(`/app/patients/${p.id}/edit`);
}));

router.post('/:id(\\d+)/delete', can('patients.delete'), form(async (req, res) => {
  const p = await loadPatient(req);
  const w = { business_id: req.ctx.businessId, patient_id: p.id };
  const [[inv], [rx], [notes], [ords], [refs], [files]] = await Promise.all([
    knex('invoices').where(w).count({ n: '*' }), knex('prescriptions').where(w).count({ n: '*' }), knex('consultations').where(w).count({ n: '*' }),
    knex('medical_orders').where(w).count({ n: '*' }), knex('referrals').where(w).count({ n: '*' }), knex('patient_files').where(w).count({ n: '*' }),
  ]);
  if (Number(inv.n) > 0) throw new AppError('PATIENT_HAS_INVOICES', 'This patient has invoices.', 409);
  if (Number(rx.n) + Number(notes.n) + Number(ords.n) + Number(refs.n) + Number(files.n) > 0) throw new AppError('PATIENT_HAS_RECORDS', 'This patient has clinical records.', 409);
  await knex.transaction(async (trx) => {
    await trx('patients').where({ id: p.id, business_id: req.ctx.businessId }).del(); // appointments keep their name snapshot (FK: SET NULL)
    const { business_id: _b, created_at: _c, updated_at: _u, insurance_name: _i, ...snapshot } = p;
    await audit.record(req.ctx, 'patient.deleted', { entityType: 'patient', entityId: p.id, oldValues: snapshot }, trx);
  });
  flash(req, 'success', req.t('patients.deleted'));
  res.redirect('/app/patients');
}, (req, res, extra) => {
  if (extra.formError) flash(req, 'error', req.t(`errors_records.${extra.formError.code}`) !== `errors_records.${extra.formError.code}` ? req.t(`errors_records.${extra.formError.code}`) : extra.formError.message);
  return res.redirect(`/app/patients/${req.params.id}`);
}));

router.listQuery = listQuery; // the same search and filters for "transfer all matching" (patienttransfer)
module.exports = router;
