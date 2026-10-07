// Specialty forms filled for a patient (specialty_records): list, save, remove (kept, voided), trends and the
// latest result of each form for the patient and visit panels. Access is that of the specialty records: the clinic's
// patient (and, for a doctor limited to their own patients, one they treat), clinical.view to read, clinical.edit to write.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const lib = require('../clinic/records.lib');
const forms = require('./forms');
const engine = require('./forms/engine');

const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || d); } catch { return d; } };

/** What the computations know about the patient: sex and age in years. */
function patientInfo(patient, today) {
  return { sex: patient.gender === 'male' || patient.gender === 'female' ? patient.gender : null, ageYears: patient.date_of_birth ? lib.ageOf(patient.date_of_birth, today) : null };
}

/** Values a new form starts with: the patient's age and sex where a field asks for them. */
function prefill(form, patient, today) {
  const p = patientInfo(patient, today);
  const out = {};
  for (const s of form.sections) for (const f of s.fields) if (typeof f.prefill === 'function') { const v = f.prefill(p); if (v !== undefined && v !== null) out[f.k] = v; }
  return out;
}

const row = (r) => ({ ...r, data: parse(r.data, {}), results: parse(r.results, []) });

/** A patient's records: all forms or one, newest first (removed ones last, only when asked). */
async function list(ctx, patient, formKey = null, { voided = false } = {}) {
  const q = knex('specialty_records as r').leftJoin('doctors as d', 'd.id', 'r.doctor_id').leftJoin('users as u', 'u.id', 'r.created_by')
    .where({ 'r.business_id': ctx.businessId, 'r.patient_id': patient.id })
    .orderBy([{ column: 'r.record_date', order: 'desc' }, { column: 'r.id', order: 'desc' }])
    .select('r.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'u.name as user_name');
  if (formKey) q.andWhere('r.form_key', formKey);
  if (!voided) q.whereNull('r.voided_at');
  return (await q).map(row);
}

async function get(ctx, patient, id) {
  const r = await knex('specialty_records as r').leftJoin('doctors as d', 'd.id', 'r.doctor_id').leftJoin('users as u', 'u.id', 'r.created_by')
    .where({ 'r.business_id': ctx.businessId, 'r.patient_id': patient.id, 'r.id': Number(id) })
    .first('r.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'u.name as user_name');
  if (!r) throw E.notFound('Record');
  return row(r);
}

/** Saves a filled form. `visit` (optional) is the appointment it was made from (its doctor and date are used). */
async function create(ctx, patient, form, body, visit, today) {
  const { data, results, level, headline } = engine.read(form, body || {}, patientInfo(patient, today));
  let date = String((body && body.record_date) || '').trim() || (visit ? String(visit.appointment_date).slice(0, 10) : today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw E.validation({ record_date: 'Enter a valid date.' });
  if (date > today) throw E.validation({ record_date: 'The date cannot be in the future.' });
  date = date.slice(0, 10);
  const doctorId = (visit ? visit.doctor_id : ctx.doctorId) || null;
  const [id] = await knex('specialty_records').insert({
    business_id: ctx.businessId, patient_id: patient.id, appointment_id: visit ? visit.id : null, doctor_id: doctorId,
    form_key: form.key, form_version: form.v || 1, record_date: date, data: JSON.stringify(data), results: JSON.stringify(results), headline, level, created_by: ctx.userId,
  });
  await audit.record(ctx, 'specialty.record_added', { entityType: 'patient', entityId: patient.id, newValues: { record_id: id, form: form.key, record_date: date, headline } });
  return id;
}

/** Removes a record from the patient's file; it is kept (voided) with who removed it and why. */
async function voidRecord(ctx, patient, id, reason) {
  const r = await knex('specialty_records').where({ id: Number(id), business_id: ctx.businessId, patient_id: patient.id }).first();
  if (!r) throw E.notFound('Record');
  if (r.voided_at) return;
  const why = String(reason || '').trim().slice(0, 255) || null;
  await knex('specialty_records').where({ id: r.id }).update({ voided_at: new Date(), voided_by: ctx.userId, void_reason: why, updated_at: new Date() });
  await audit.record(ctx, 'specialty.record_removed', { entityType: 'patient', entityId: patient.id, oldValues: { record_id: r.id, form: r.form_key, record_date: r.record_date, headline: r.headline }, newValues: { reason: why } });
}

/** Number series of a form's trended fields over the patient's records (oldest first). */
function trends(form, records) {
  const keys = [];
  for (const s of form.sections) for (const f of s.fields) if (f.trend) {
    if (f.side) engine.SIDES[f.side].forEach(([sd, ar, en]) => keys.push({ key: `${f.k}_${sd}`, ar: `${f.ar} — ${ar}`, en: `${f.en} — ${en}`, unit: f.unit }));
    else keys.push({ key: f.k, ar: f.ar, en: f.en, unit: f.unit });
  }
  const ordered = [...records].reverse();
  return keys.map((k) => ({ ...k, points: ordered.filter((r) => typeof r.data[k.key] === 'number').map((r) => ({ date: String(r.record_date).slice(0, 10), v: r.data[k.key] })) }))
    .filter((s) => s.points.length >= 2);
}

/** The latest record of each form for the panels: { form_key: { id, date, headline, level, results } }. */
async function latest(ctx, patientId, keys) {
  if (!keys.length) return {};
  const rows = await knex('specialty_records').where({ business_id: ctx.businessId, patient_id: patientId }).whereNull('voided_at').whereIn('form_key', keys)
    .orderBy([{ column: 'record_date', order: 'desc' }, { column: 'id', order: 'desc' }]).select('id', 'form_key', 'record_date', 'headline', 'level', 'results');
  const out = {};
  for (const r of rows) {
    if (out[r.form_key]) continue; // eslint-disable-line no-continue
    out[r.form_key] = { id: r.id, date: r.record_date, headline: r.headline, level: r.level, results: parse(r.results, []), count: 0 };
  }
  for (const r of rows) out[r.form_key].count += 1;
  return out;
}

/** Records made from a visit (for the visit page). */
const ofVisit = (ctx, apptId) => knex('specialty_records').where({ business_id: ctx.businessId, appointment_id: apptId }).whereNull('voided_at').select('id', 'form_key', 'headline', 'level');

/** The forms on the clinic's list, the visit's doctor's own specialty first. */
async function formsFor(ctx, settings, doctorId) {
  let first = [];
  if (doctorId) {
    const d = await knex('doctors').where({ id: doctorId, business_id: ctx.businessId }).first('specialty_key');
    if (d && d.specialty_key) first = forms.forSpecialty(d.specialty_key).filter((k) => settings.forms.includes(k));
  }
  return [...first, ...settings.forms.filter((k) => !first.includes(k))].map((k) => ({ form: forms.get(k), mine: first.includes(k) }));
}

module.exports = { patientInfo, prefill, list, get, create, voidRecord, trends, latest, ofVisit, formsFor };
