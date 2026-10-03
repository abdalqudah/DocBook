// Visit page (one appointment): patient header with clinical warnings, previous visits, vital signs (nurse),
// SOAP note + diagnosis with ICD-10 codes (doctor), prescriptions with a printable Rx, the consultation timer and
// "complete visit". The clinic's record-privacy rule (clinicalplus/privacy.service) decides whether the clinical
// sections open for this member; every page view is written to the record-access log.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { AppError, E } = require('../../core/errors');
const appts = require('./appointments.service');
const clinical = require('./clinical.service');
const icd = require('../clinicalplus/icd.service');
const timer = require('../clinicalplus/timer.service');
const privacy = require('../clinicalplus/privacy.service');
const dflow = require('./dflow.service');

const router = express.Router();
router.use(canAny('clinical.view', 'vitals.edit', 'frontdesk.use'));

const ASSETS = { pageScripts: ['/js/appointments.js', '/js/clinicalplus.js', '/js/dflow.js'], pageStyles: ['/css/appointments.css', '/css/clinicalplus.css', '/css/dflow.css'] };
const PRINT_ASSETS = { pageScripts: ['/js/appointments.js', '/js/clinicalplus.js'], pageStyles: ['/css/appointments.css', '/css/clinicalplus.css'] };

/** Whole years between a date of birth and the clinic's today. */
function ageOn(dob, today) {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(String(dob))) return null;
  const [y, m, d] = String(dob).split('-').map(Number);
  const [ty, tm, td] = String(today).split('-').map(Number);
  let age = ty - y;
  if (tm < m || (tm === m && td < d)) age -= 1;
  return age >= 0 ? age : null;
}

function bmiOf(v) {
  const w = Number(v && v.weightKg); const h = Number(v && v.heightCm) / 100;
  return w > 0 && h > 0 ? Math.round((w / (h * h)) * 10) / 10 : null;
}

async function load(req) {
  const { ctx } = req;
  const a = await appts.get(ctx, Number(req.params.id)); // enforces a doctor's own-schedule scope
  if (a.appointment_type === 'blocked') throw E.notFound('Appointment');
  const patient = a.patient_id
    ? await knex('patients as p').leftJoin('insurance_providers as i', 'i.id', 'p.insurance_provider_id').where({ 'p.business_id': ctx.businessId, 'p.id': a.patient_id })
      .first('p.*', 'i.name as insurance_name')
    : null;
  return { a, patient };
}

/** The privacy rule for this visit; throws RECORD_RESTRICTED when `need` (clinical | vitals) is not granted. */
async function accessFor(req, a, need) {
  const acc = await privacy.access(req.ctx, { appointment: a });
  if (need === 'clinical' && !acc.clinical) throw new AppError('RECORD_RESTRICTED', 'This clinical record is restricted.', 403);
  if (need === 'vitals' && !acc.clinical && !acc.vitals) throw new AppError('RECORD_RESTRICTED', 'This clinical record is restricted.', 403);
  return acc;
}

/** Who the doctor sees after this visit: someone already sent in, else the longest waiting, else the next booked one. */
async function nextPatientOf(ctx, a) {
  const rows = await knex('appointments').where({ business_id: ctx.businessId, doctor_id: a.doctor_id, appointment_date: ctx.today })
    .whereNot('id', a.id).whereNot('appointment_type', 'blocked').whereIn('status', ['pending', 'confirmed'])
    .orderBy('appointment_time').select('id', 'patient_name', 'appointment_time', 'checked_in', 'with_doctor', 'arrived_at');
  const byArrival = (x, y) => String(x.arrived_at || '').localeCompare(String(y.arrived_at || ''));
  return rows.find((r) => r.with_doctor) || rows.filter((r) => r.checked_in).sort(byArrival)[0] || rows[0] || null;
}

async function renderVisit(req, res, extra = {}) {
  const { ctx } = req;
  const { a, patient } = await load(req);
  const perms = ctx.permissions;
  const access = await privacy.access(ctx, { appointment: a });
  const clinicalView = perms.has('clinical.view') && access.clinical;
  if (extra.logView) await privacy.log(ctx, { patientId: a.patient_id, appointmentId: a.id, what: 'visit', access: privacy.levelOf(access) });
  const [consult, rxs, history, meds, invoice, diagnoses, timerRow] = await Promise.all([
    clinicalView || access.vitals ? clinical.consultation(ctx, a.id) : null,
    clinicalView ? clinical.prescriptionsFor(ctx, a.id) : [],
    clinicalView && a.patient_id
      ? knex('consultations as c').join('appointments as ap', 'ap.id', 'c.appointment_id').leftJoin('doctors as d', 'd.id', 'c.doctor_id')
        .where({ 'c.business_id': ctx.businessId, 'c.patient_id': a.patient_id }).whereNot('c.appointment_id', a.id)
        .modify((q) => { if (ctx.ownDoctorId) q.where('ap.doctor_id', ctx.ownDoctorId); })
        .orderBy([{ column: 'ap.appointment_date', order: 'desc' }, { column: 'ap.appointment_time', order: 'desc' }]).limit(5)
        .select('c.diagnosis', 'c.assessment', 'ap.id as appointment_id', 'ap.appointment_date', 'ap.appointment_time', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en')
      : [],
    perms.has('prescriptions.create') ? clinical.activeMedications(ctx) : [],
    knex('invoices').where({ business_id: ctx.businessId, appointment_id: a.id }).first('id', 'invoice_number'),
    clinicalView ? icd.listFor(ctx.businessId, a.id) : [],
    // A patient already in the room (sent in before the timer started on its own): the timer starts now.
    clinicalView ? (async () => {
      const t = await timer.get(ctx.businessId, a.id);
      if (t || !a.with_doctor || a.appointment_date !== ctx.today || !['pending', 'confirmed'].includes(a.status) || a.doctor_finished_at || !perms.has('clinical.edit')) return t;
      return timer.start(ctx, a);
    })() : null,
  ]);
  // Doctor journey: the bill the doctor sets ("amount to collect"), the next patient (after finishing) and a
  // confirmation after "Finish visit & send to reception" (?done=1).
  const canFinish = perms.has('clinical.edit') || perms.has('appointments.manage');
  const [bill, nextUp] = await Promise.all([
    canFinish ? dflow.billFor(ctx, a.id) : null,
    a.doctor_id && a.appointment_date === ctx.today ? nextPatientOf(ctx, a) : null,
  ]);
  const historyCodes = history.length ? await icd.diagnosesByAppointment(ctx.businessId, history.map((h) => h.appointment_id)) : new Map();
  const vitals = (consult && consult.vital_signs) || {};
  // Online consultation: link, patient's time zone, reason and files, and the doctor's side of the video call.
  const online = await require('../telehealth/web').panelData(req, a, { res }); // eslint-disable-line global-require
  res.page('pages/clinic/visits/show', {
    title: `${a.patient_name} · ${req.t('visits.title')}`, a, patient, consult, vitals, bmi: bmiOf(vitals), rxs, history, meds, invoice,
    age: patient ? ageOn(patient.date_of_birth, ctx.today) : null, ...ASSETS, online,
    access, diagnoses, historyCodes, bill, nextUp, canFinish, justFinished: req.query.done === '1' && a.status === 'completed',
    printRxId: Number(req.query.print) || null, timerView: timer.view(timerRow), icdTitle: (r) => icd.titleOf(r, req.locale),
    ...(online ? { pageScripts: [...ASSETS.pageScripts, '/js/telehealth.js'], pageStyles: [...ASSETS.pageStyles, '/css/telehealth.css'] } : {}), ...extra,
  });
}

router.get('/:id(\\d+)', wrap((req, res) => renderVisit(req, res, { logView: true })));

// Business errors of the privacy rule go back to the page as a message (the form helper handles 409/422 only).
const restricted = (fn) => wrap(async (req, res, next) => {
  try { return await fn(req, res, next); } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'RECORD_RESTRICTED') throw err;
    flash(req, 'error', req.t('errors_clinicalplus.RECORD_RESTRICTED'));
    return res.redirect(`/app/visits/${req.params.id}`);
  }
});

router.post('/:id(\\d+)/vitals', can('vitals.edit'), restricted(async (req, res, next) => { await accessFor(req, (await load(req)).a, 'vitals'); next(); }), form(async (req, res) => {
  await clinical.saveVitals(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('visits.vitals_saved'));
  res.redirect(`/app/visits/${req.params.id}#vitals`);
}, (req, res, extra) => renderVisit(req, res, { ...extra, failed: 'vitals' })));

router.post('/:id(\\d+)/note', can('clinical.edit'), restricted(async (req, res, next) => { await accessFor(req, (await load(req)).a, 'clinical'); next(); }), form(async (req, res) => {
  const { a } = await load(req);
  // ICD-10 codes travel with the note (the field is only on the form when the codes block was rendered).
  const codes = req.body.icd_present === '1' ? await icd.resolveCodes(req.ctx.businessId, req.body.icd_codes) : null;
  await clinical.saveNote(req.ctx, a.id, req.body);
  if (codes) await icd.saveDiagnoses(req.ctx, a, codes, req.body.icd_primary);
  flash(req, 'success', req.t('visits.note_saved'));
  res.redirect(`/app/visits/${req.params.id}#note`);
}, (req, res, extra) => {
  const bad = extra.formError && extra.formError.details && extra.formError.details.icd_codes;
  if (bad) extra.errors = { ...extra.errors, icd_codes: req.t('icd.err_unknown', { codes: bad }) };
  return renderVisit(req, res, { ...extra, failed: 'note' });
}));

router.post('/:id(\\d+)/prescriptions', can('prescriptions.create'), restricted(async (req, res, next) => { await accessFor(req, (await load(req)).a, 'clinical'); next(); }), form(async (req, res) => {
  const rxId = await clinical.prescribe(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('visits.rx_saved'));
  res.redirect(`/app/visits/${req.params.id}?rx=${rxId}#prescriptions`);
}, (req, res, extra) => renderVisit(req, res, { ...extra, failed: 'rx' })));

router.post('/:id(\\d+)/complete', canAny('clinical.edit', 'appointments.manage'), wrap(async (req, res) => {
  const { a } = await load(req);
  if (a.status === 'cancelled') throw E.conflict('APPOINTMENT_CANCELLED', 'This appointment is cancelled.');
  await appts.setStatus(req.ctx, a.id, 'completed');
  await timer.stop(req.ctx, a); // finishing the visit ends a running consultation timer (no-op otherwise)
  if (a.with_doctor) await knex('appointments').where({ id: a.id, business_id: req.ctx.businessId }).update({ with_doctor: false, updated_at: new Date() });
  flash(req, 'success', req.t('visits.completed'));
  res.redirect(`/app/visits/${a.id}`);
}));

// ---------------------------------------------------------------- doctor journey (dflow.service)
/** What the member may write on this visit: the note needs clinical.edit, the quick prescription prescriptions.create,
 *  both only when the record-privacy rule opens the clinical record. */
async function clinicalRights(req, a) {
  const perms = req.ctx.permissions;
  if (!perms.has('clinical.edit') && !perms.has('prescriptions.create')) return { note: false, rx: false };
  const acc = await privacy.access(req.ctx, { appointment: a });
  return { note: perms.has('clinical.edit') && acc.clinical, rx: perms.has('prescriptions.create') && acc.clinical };
}
const dflowRerender = (req, res, extra) => {
  const bad = extra.formError && extra.formError.details && extra.formError.details.icd_codes;
  if (bad) extra.errors = { ...extra.errors, icd_codes: req.t('icd.err_unknown', { codes: bad }) };
  if (extra.formError && extra.formError.code === 'VISIT_NO_SHOW') extra.formError = { ...extra.formError, message: req.t('errors_dflow.VISIT_NO_SHOW') };
  return renderVisit(req, res, { ...extra, failed: 'dflow' });
};

// Finish visit & send to reception: note + quick prescription + amount to collect, one click.
router.post('/:id(\\d+)/finish', canAny('clinical.edit', 'appointments.manage'), form(async (req, res) => {
  const { a } = await load(req);
  const rights = await clinicalRights(req, a);
  const r = await dflow.finish(req.ctx, a.id, req.body, rights);
  const print = req.body.print_rx === '1' && r.rxId ? `&print=${r.rxId}` : '';
  flash(req, 'success', req.t('dflow.sent_flash', { amount: res.locals.fmt.money(r.total) }));
  res.redirect(`/app/visits/${a.id}?done=1${print}`);
}, dflowRerender));

// Save the note + prescription without finishing.
router.post('/:id(\\d+)/save', canAny('clinical.edit', 'prescriptions.create'), form(async (req, res) => {
  const { a } = await load(req);
  const rights = await clinicalRights(req, a);
  if (!rights.note && !rights.rx) { flash(req, 'error', req.t('errors_clinicalplus.RECORD_RESTRICTED')); return res.redirect(`/app/visits/${a.id}`); }
  await dflow.saveDraft(req.ctx, a.id, req.body, rights);
  flash(req, 'success', req.t('dflow.saved'));
  return res.redirect(`/app/visits/${a.id}?saved=1#note`);
}, dflowRerender));

// "Start visit" (My day): the patient goes into the room and the consultation timer starts; then the visit opens.
router.post('/:id(\\d+)/start', can('clinical.edit'), wrap(async (req, res) => {
  const { a } = await load(req);
  const acc = await privacy.access(req.ctx, { appointment: a });
  await dflow.start(req.ctx, a.id, { timer: acc.clinical });
  res.redirect(`/app/visits/${a.id}`);
}));

router.get('/:id(\\d+)/prescriptions/:rx(\\d+)', can('clinical.view'), restricted(async (req, res) => {
  const { a, patient } = await load(req);
  await accessFor(req, a, 'clinical');
  const rx = await clinical.prescription(req.ctx, Number(req.params.rx));
  if (rx.appointment_id !== a.id) throw E.notFound('Prescription');
  const diagnoses = await icd.listFor(req.ctx.businessId, a.id); // for the Rx sheet (ICD-10 codes of the visit)
  res.page('pages/clinic/visits/prescription', {
    title: `${req.t('visits.rx_title')} · ${a.patient_name}`, printable: true, a, patient, rx, age: patient ? ageOn(patient.date_of_birth, req.ctx.today) : null, ...PRINT_ASSETS,
    diagnoses, icdTitle: (r) => icd.titleOf(r, req.locale),
  });
}));

module.exports = router;
