// Visit page (one appointment): patient header with clinical warnings, previous visits, vital signs (nurse),
// SOAP note + diagnosis (doctor), prescriptions with a printable Rx, and "complete visit".
const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { E } = require('../../core/errors');
const appts = require('./appointments.service');
const clinical = require('./clinical.service');

const router = express.Router();
router.use(canAny('clinical.view', 'vitals.edit', 'frontdesk.use'));

const ASSETS = { pageScripts: ['/js/appointments.js'], pageStyles: ['/css/appointments.css'] };

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

async function renderVisit(req, res, extra = {}) {
  const { ctx } = req;
  const { a, patient } = await load(req);
  const perms = ctx.permissions;
  const clinicalView = perms.has('clinical.view');
  const [consult, rxs, history, meds, invoice] = await Promise.all([
    clinical.consultation(ctx, a.id),
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
  ]);
  const vitals = (consult && consult.vital_signs) || {};
  res.page('pages/clinic/visits/show', {
    title: `${a.patient_name} · ${req.t('visits.title')}`, a, patient, consult, vitals, bmi: bmiOf(vitals), rxs, history, meds, invoice,
    age: patient ? ageOn(patient.date_of_birth, ctx.today) : null, ...ASSETS, ...extra,
  });
}

router.get('/:id(\\d+)', wrap((req, res) => renderVisit(req, res)));

router.post('/:id(\\d+)/vitals', can('vitals.edit'), form(async (req, res) => {
  await clinical.saveVitals(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('visits.vitals_saved'));
  res.redirect(`/app/visits/${req.params.id}#vitals`);
}, (req, res, extra) => renderVisit(req, res, { ...extra, failed: 'vitals' })));

router.post('/:id(\\d+)/note', can('clinical.edit'), form(async (req, res) => {
  await clinical.saveNote(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('visits.note_saved'));
  res.redirect(`/app/visits/${req.params.id}#note`);
}, (req, res, extra) => renderVisit(req, res, { ...extra, failed: 'note' })));

router.post('/:id(\\d+)/prescriptions', can('prescriptions.create'), form(async (req, res) => {
  const rxId = await clinical.prescribe(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('visits.rx_saved'));
  res.redirect(`/app/visits/${req.params.id}?rx=${rxId}#prescriptions`);
}, (req, res, extra) => renderVisit(req, res, { ...extra, failed: 'rx' })));

router.post('/:id(\\d+)/complete', canAny('clinical.edit', 'appointments.manage'), wrap(async (req, res) => {
  const { a } = await load(req);
  if (a.status === 'cancelled') throw E.conflict('APPOINTMENT_CANCELLED', 'This appointment is cancelled.');
  await appts.setStatus(req.ctx, a.id, 'completed');
  if (a.with_doctor) await knex('appointments').where({ id: a.id, business_id: req.ctx.businessId }).update({ with_doctor: false, updated_at: new Date() });
  flash(req, 'success', req.t('visits.completed'));
  res.redirect(`/app/visits/${a.id}`);
}));

router.get('/:id(\\d+)/prescriptions/:rx(\\d+)', can('clinical.view'), wrap(async (req, res) => {
  const { a, patient } = await load(req);
  const rx = await clinical.prescription(req.ctx, Number(req.params.rx));
  if (rx.appointment_id !== a.id) throw E.notFound('Prescription');
  res.page('pages/clinic/visits/prescription', {
    title: `${req.t('visits.rx_title')} · ${a.patient_name}`, printable: true, a, patient, rx, age: patient ? ageOn(patient.date_of_birth, req.ctx.today) : null, ...ASSETS,
  });
}));

module.exports = router;
