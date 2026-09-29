// Patients: searchable register, profile with visit timeline, add / edit / delete.
// A doctor login limited to its own schedule (ctx.ownDoctorId) only sees patients it has booked at least once.
const express = require('express');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const exporter = require('../../core/exporter');
const { AppError, E } = require('../../core/errors');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const appts = require('./appointments.service');
const clinical = require('./clinical.service');
const lib = require('./records.lib');

const router = express.Router();
router.use(can('patients.view'));

const PAGE_SCRIPTS = ['/js/records.js'];
const PAGE_STYLES = ['/css/records.css'];

function listQuery(ctx, query) {
  const q = knex('patients').leftJoin('insurance_providers as ip', 'ip.id', 'patients.insurance_provider_id')
    .where('patients.business_id', ctx.businessId);
  if (query.q && String(query.q).trim()) {
    const term = lib.likeTerm(query.q);
    q.andWhere((w) => ['full_name', 'phone', 'email', 'national_id', 'insurance_number'].forEach((c) => w.orWhere(`patients.${c}`, 'like', term)));
  }
  if (query.insurance === 'none') q.whereNull('patients.insurance_provider_id');
  else if (/^\d+$/.test(query.insurance || '')) q.where('patients.insurance_provider_id', Number(query.insurance));
  lib.scopePatientsToDoctor(q, ctx.ownDoctorId);
  const visitScope = ctx.ownDoctorId ? knex.raw(' AND a.doctor_id = ?', [ctx.ownDoctorId]).toString() : '';
  q.select('patients.*', 'ip.name as insurance_name',
    knex.raw(`(SELECT COUNT(*) FROM appointments a WHERE a.patient_id = patients.id AND a.status = 'completed'${visitScope}) as visits`),
    knex.raw(`(SELECT MAX(a.appointment_date) FROM appointments a WHERE a.patient_id = patients.id AND a.status = 'completed'${visitScope}) as last_visit`),
    knex.raw(`(SELECT MIN(a.appointment_date) FROM appointments a WHERE a.patient_id = patients.id AND a.appointment_date >= ? AND a.status IN ('pending','confirmed') AND a.appointment_type <> 'blocked'${visitScope}) as next_visit`, [ctx.today]));
  const sort = { name: [['patients.full_name', 'asc']], last: [[knex.raw('last_visit'), 'desc']], created: [['patients.created_at', 'desc']] }[query.sort] || [['patients.created_at', 'desc']];
  sort.forEach(([c, d]) => q.orderBy(c, d));
  q.orderBy('patients.id', 'desc');
  return q;
}

async function render(req, res, extra = {}) {
  const [{ rows, meta }, insurance] = await Promise.all([
    lib.paginate(listQuery(req.ctx, req.query), { page: req.query.page, perPage: 25 }),
    clinical.activeInsurance(req.ctx),
  ]);
  const filtered = ['q', 'insurance'].some((k) => req.query[k] && req.query[k] !== 'all');
  res.page('pages/clinic/patients/index', {
    title: req.t('patients.title'), rows, meta, insurance, filtered, ageOf: (d) => lib.ageOf(d, req.ctx.today),
    pageScripts: PAGE_SCRIPTS, pageStyles: PAGE_STYLES, ...extra,
  });
}

router.get('/', wrap((req, res) => render(req, res)));

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
  const q = knex('patients').leftJoin('insurance_providers as ip', 'ip.id', 'patients.insurance_provider_id')
    .where({ 'patients.business_id': req.ctx.businessId, 'patients.id': id }).first('patients.*', 'ip.name as insurance_name');
  lib.scopePatientsToDoctor(q, req.ctx.ownDoctorId);
  const p = await q;
  if (!p) throw E.notFound('Patient');
  return p;
}

/** Visit-centred timeline: each appointment carries its diagnosis, prescriptions and invoice. */
function buildTimeline(tl, perms, ownDoctorId) {
  const showClinical = perms.has('clinical.view');
  const showBilling = perms.has('billing.view');
  const mine = (r) => !ownDoctorId || r.doctor_id === ownDoctorId;
  const appointments = tl.appointments.filter(mine);
  const byAppt = new Map(appointments.map((a) => [a.id, { kind: 'visit', appt: a, consultation: null, prescriptions: [], invoice: null, sortKey: `${a.appointment_date} ${a.appointment_time}` }]));
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
  const tl = await appts.timeline(req.ctx, p.id);
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
  const latestDiagnosis = req.ctx.permissions.has('clinical.view') ? ((tl.consultations.filter(mine).find((c) => c.diagnosis) || {}).diagnosis || null) : null;
  res.page('pages/clinic/patients/show', {
    title: p.full_name, patient: p, stats, upcoming, latestDiagnosis,
    timeline: buildTimeline(tl, req.ctx.permissions, req.ctx.ownDoctorId),
    age: lib.ageOf(p.date_of_birth, today), wa: lib.waNumber(p.phone), statusTone: lib.STATUS_TONE,
    pageScripts: PAGE_SCRIPTS, pageStyles: PAGE_STYLES, ...extra,
  });
}
router.get('/:id(\\d+)', wrap((req, res) => renderShow(req, res)));

async function renderEdit(req, res, extra = {}) {
  const p = await loadPatient(req);
  const insurance = await clinical.activeInsurance(req.ctx);
  // Keep a provider that was deactivated after being assigned, so saving doesn't silently drop it.
  if (p.insurance_provider_id && !insurance.some((i) => i.id === p.insurance_provider_id) && p.insurance_name) insurance.push({ id: p.insurance_provider_id, name: p.insurance_name });
  res.page('pages/clinic/patients/edit', { title: req.t('patients.edit'), patient: p, insurance, pageScripts: PAGE_SCRIPTS, pageStyles: PAGE_STYLES, ...extra });
}
router.get('/:id(\\d+)/edit', can('patients.edit'), wrap((req, res) => renderEdit(req, res)));
router.post('/:id(\\d+)/edit', can('patients.edit'), form(async (req, res) => {
  const p = await loadPatient(req);
  await appts.savePatient(req.ctx, p.id, req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(`/app/patients/${p.id}`);
}, renderEdit));

router.post('/:id(\\d+)/delete', can('patients.delete'), form(async (req, res) => {
  const p = await loadPatient(req);
  const w = { business_id: req.ctx.businessId, patient_id: p.id };
  const [[inv], [rx], [notes]] = await Promise.all([
    knex('invoices').where(w).count({ n: '*' }), knex('prescriptions').where(w).count({ n: '*' }), knex('consultations').where(w).count({ n: '*' }),
  ]);
  if (Number(inv.n) > 0) throw new AppError('PATIENT_HAS_INVOICES', 'This patient has invoices.', 409);
  if (Number(rx.n) + Number(notes.n) > 0) throw new AppError('PATIENT_HAS_RECORDS', 'This patient has clinical records.', 409);
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

module.exports = router;
