// Specialty records data layer: clinic settings, patient access (tenant + a doctor's own patients), dental chart,
// child growth, pregnancy follow-up, and the small summaries shown on the visit / patient pages.
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { z, validate, optionalString, isoDate, emptyToUndefined } = require('../../core/validate');
const { E, AppError } = require('../../core/errors');
const appts = require('../clinic/appointments.service');
const lib = require('../clinic/records.lib');
const dental = require('./dental');
const growth = require('./growth');
const preg = require('./pregnancy');

const MODULES = ['dental', 'growth', 'pregnancy'];
// Which modules a specialty turns on by default. General / multi-specialty / other / not set → all three.
const BY_SPECIALTY = { dentistry: ['dental'], paediatrics: ['growth'], obgyn: ['pregnancy'] };
const ALL_BY_DEFAULT = new Set(['general', 'multi', 'other', '', null, undefined]);
function defaultModules(specialty) {
  if (BY_SPECIALTY[specialty]) return BY_SPECIALTY[specialty];
  return ALL_BY_DEFAULT.has(specialty) ? MODULES : [];
}

const parseJson = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || d); } catch { return d; } };
const nOrNull = (v) => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------- settings
async function settings(business) {
  const row = await cache.remember(`spec:${business.id}`, async () => (await knex('specialty_settings').where({ business_id: business.id }).first()) || false, 60_000);
  const defaults = defaultModules(business.specialty);
  const on = {};
  MODULES.forEach((m) => {
    const v = row ? row[`${m}_enabled`] : null;
    on[m] = v === null || v === undefined ? defaults.includes(m) : Boolean(v);
  });
  return { ...on, any: MODULES.some((m) => on[m]), defaults, explicit: Boolean(row), schedule: preg.normaliseSchedule(row ? row.pregnancy_schedule : null), customSchedule: Boolean(row && row.pregnancy_schedule) };
}

const scheduleItem = z.object({
  key: z.string().trim().regex(/^[a-z0-9_]{1,40}$/, 'Choose a valid value.'),
  label: optionalString(120),
  from: z.coerce.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(4, 'Too small.').max(42, 'Too large.'),
  to: z.coerce.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(4, 'Too small.').max(42, 'Too large.'),
  rhNeg: z.preprocess((v) => v === '1' || v === 'on' || v === true, z.boolean()),
});

async function saveSettings(ctx, business, input) {
  const bool = (v) => v === '1' || v === 'on' || v === true;
  const patch = { dental_enabled: bool(input.dental), growth_enabled: bool(input.growth), pregnancy_enabled: bool(input.pregnancy) };
  let schedule = null;
  if (input.reset_schedule !== '1') {
    const raw = Array.isArray(input.items) ? input.items : Object.values(input.items || {});
    const defaults = new Set(preg.DEFAULT_SCHEDULE.map((i) => i.key));
    const items = [];
    const errors = {};
    raw.forEach((r, i) => {
      if (!r || r.remove === '1') return;
      if (!defaults.has(r.key) && !String(r.label || '').trim()) { if (String(r.from || '').trim() || String(r.to || '').trim()) errors[`items.${i}.label`] = 'Required.'; return; }
      const res = scheduleItem.safeParse({ ...r, key: r.key || `c${Date.now().toString(36)}${i}` });
      if (!res.success) { errors[`items.${i}.${res.error.issues[0].path.join('.')}`] = res.error.issues[0].message; return; }
      if (res.data.to < res.data.from) { errors[`items.${i}.to`] = 'Too small.'; return; }
      items.push({ ...res.data, label: res.data.label || '' });
    });
    if (Object.keys(errors).length) throw E.validation(errors);
    items.sort((a, b) => a.from - b.from || a.to - b.to);
    const same = JSON.stringify(items) === JSON.stringify(preg.DEFAULT_SCHEDULE.map((i) => ({ key: i.key, label: '', from: i.from, to: i.to, rhNeg: Boolean(i.rhNeg) })));
    schedule = items.length && !same ? JSON.stringify(items) : null;
  }
  patch.pregnancy_schedule = schedule;
  const before = await knex('specialty_settings').where({ business_id: ctx.businessId }).first();
  if (before) await knex('specialty_settings').where({ id: before.id }).update({ ...patch, updated_by: ctx.userId, updated_at: new Date() });
  else await knex('specialty_settings').insert({ business_id: ctx.businessId, ...patch, updated_by: ctx.userId });
  cache.forgetPrefix(`spec:${ctx.businessId}`);
  const { oldValues, newValues } = audit.diff(before || {}, patch);
  await audit.record(ctx, 'specialty.settings_updated', { entityType: 'clinic', entityId: ctx.businessId, oldValues, newValues });
}

// ---------------------------------------------------------------- access
/** The patient, scoped to the clinic — and, for a doctor limited to their own schedule, to patients they have treated/booked. */
async function patientFor(ctx, id) {
  const q = knex('patients').where({ 'patients.business_id': ctx.businessId, 'patients.id': Number(id) }).first('patients.*');
  lib.scopePatientsToDoctor(q, ctx.ownDoctorId);
  const p = await q;
  if (!p) throw E.notFound('Patient');
  return p;
}

/** The visit a record is made from (must be this patient's, and within a doctor's scope) + its vital signs. */
async function visitFor(ctx, patient, apptId) {
  if (!apptId || !/^\d+$/.test(String(apptId))) return null;
  let a;
  try { a = await appts.get(ctx, Number(apptId)); } catch (e) { if (e.status === 404) return null; throw e; }
  if (a.patient_id !== patient.id || a.appointment_type === 'blocked') return null;
  const c = await knex('consultations').where({ business_id: ctx.businessId, appointment_id: a.id }).first('vital_signs');
  return { ...a, vitals: c ? parseJson(c.vital_signs, {}) : {} };
}

/** Doctor recorded on an entry: the visit's doctor, else the signed-in user's own doctor profile. */
const doctorOf = (ctx, visit) => (visit ? visit.doctor_id : ctx.doctorId) || null;

const ageDays = (patient, date) => (patient.date_of_birth && lib.isIso(patient.date_of_birth) ? growth.daysBetween(patient.date_of_birth, date) : null);

/** Is the module relevant to this patient (beyond being switched on)? */
function relevance(patient, today) {
  const days = ageDays(patient, today);
  return {
    dental: true,
    growth: days === null || days <= growth.MAX_DAY + 365, // children (WHO charts cover 0–5 y; a year of margin for follow-up)
    pregnancy: patient.gender === 'female' && (days === null || (days >= 10 * 365 && days <= 60 * 365)),
  };
}

// ---------------------------------------------------------------- dental
async function dentalData(ctx, patient) {
  const [entries, plan, services] = await Promise.all([
    knex('dental_entries as e').leftJoin('doctors as d', 'd.id', 'e.doctor_id').leftJoin('users as u', 'u.id', 'e.created_by')
      .where({ 'e.business_id': ctx.businessId, 'e.patient_id': patient.id }).orderBy([{ column: 'e.entry_date', order: 'desc' }, { column: 'e.id', order: 'desc' }])
      .select('e.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'u.name as user_name'),
    knex('dental_plan_items as i').leftJoin('services as s', 's.id', 'i.service_id').leftJoin('doctors as d', 'd.id', 'i.doctor_id')
      .where({ 'i.business_id': ctx.businessId, 'i.patient_id': patient.id })
      .orderByRaw("FIELD(i.status, 'planned', 'done', 'cancelled')").orderBy('i.id')
      .select('i.*', 's.name as service_name', 's.name_en as service_name_en', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en'),
    knex('services').where({ business_id: ctx.businessId, is_active: true }).orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('id', 'name', 'name_en', 'price', 'doctor_id'),
  ]);
  return { entries, plan, services, state: dental.chartState(entries) };
}

async function addDentalEntry(ctx, patient, input, visit) {
  const d = dental.validateEntry(input, ctx.today);
  const row = { business_id: ctx.businessId, patient_id: patient.id, ...d, appointment_id: visit ? visit.id : null, doctor_id: doctorOf(ctx, visit), created_by: ctx.userId };
  const [id] = await knex('dental_entries').insert(row);
  await audit.record(ctx, 'dental.entry_added', { entityType: 'patient', entityId: patient.id, newValues: { entry_id: id, ...d } });
  return id;
}

async function voidDentalEntry(ctx, patient, entryId) {
  const e = await knex('dental_entries').where({ id: Number(entryId), business_id: ctx.businessId, patient_id: patient.id }).first();
  if (!e) throw E.notFound('Entry');
  if (e.voided_at) return;
  await knex('dental_entries').where({ id: e.id }).update({ voided_at: new Date(), voided_by: ctx.userId, updated_at: new Date() });
  await audit.record(ctx, 'dental.entry_removed', { entityType: 'patient', entityId: patient.id, oldValues: { entry_id: e.id, tooth: e.tooth, condition: e.condition, surfaces: e.surfaces, entry_date: e.entry_date } });
}

const planSchema = z.object({
  procedure_name: optionalString(190),
  service_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  tooth: z.preprocess(emptyToUndefined, z.coerce.number().int().refine(dental.isTooth, 'Choose a tooth.').optional()),
  price: z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : Number(String(v).replace(/,/g, ''))),
    z.number({ invalid_type_error: 'Enter a number.' }).finite('Enter a number.').min(0, 'Must be zero or more.').max(1e9, 'Too large.').optional()),
  notes: optionalString(1000),
});

async function addPlanItem(ctx, patient, input, visit) {
  const d = validate(planSchema, input);
  let service = null;
  if (d.service_id) {
    service = await knex('services').where({ id: d.service_id, business_id: ctx.businessId }).first('id', 'name', 'price');
    if (!service) throw E.validation({ service_id: 'Choose a valid value.' });
  }
  const name = d.procedure_name || (service && service.name);
  if (!name) throw E.validation({ procedure_name: 'Required.' });
  const { surfaces, bad } = dental.parseSurfaces(input.surfaces);
  if (bad.length) throw E.validation({ surfaces: 'Choose a valid value.' });
  const row = {
    business_id: ctx.businessId, patient_id: patient.id, tooth: d.tooth || null, surfaces: d.tooth && surfaces.length ? surfaces.join(',') : null, procedure_name: name,
    service_id: service ? service.id : null, price: d.price !== undefined ? d.price : (service ? service.price : null), status: 'planned',
    doctor_id: doctorOf(ctx, visit), notes: d.notes || null, created_by: ctx.userId,
  };
  const [id] = await knex('dental_plan_items').insert(row);
  await audit.record(ctx, 'dental.plan_added', { entityType: 'patient', entityId: patient.id, newValues: { item_id: id, procedure_name: name, tooth: row.tooth, price: row.price } });
  return id;
}

async function setPlanStatus(ctx, patient, itemId, status, visit) {
  if (!['planned', 'done', 'cancelled'].includes(status)) throw E.validation({ status: 'Choose a valid value.' });
  const item = await knex('dental_plan_items').where({ id: Number(itemId), business_id: ctx.businessId, patient_id: patient.id }).first();
  if (!item) throw E.notFound('Plan item');
  const patch = { status, done_on: status === 'done' ? (visit ? visit.appointment_date : ctx.today) : null, appointment_id: status === 'done' && visit ? visit.id : (status === 'done' ? item.appointment_id : null), updated_at: new Date() };
  await knex('dental_plan_items').where({ id: item.id }).update(patch);
  await audit.record(ctx, 'dental.plan_status', { entityType: 'patient', entityId: patient.id, oldValues: { item_id: item.id, status: item.status }, newValues: { item_id: item.id, status } });
}

async function deletePlanItem(ctx, patient, itemId) {
  const item = await knex('dental_plan_items').where({ id: Number(itemId), business_id: ctx.businessId, patient_id: patient.id }).first();
  if (!item) throw E.notFound('Plan item');
  await knex('dental_plan_items').where({ id: item.id }).del();
  await audit.record(ctx, 'dental.plan_deleted', { entityType: 'patient', entityId: patient.id, oldValues: { item_id: item.id, procedure_name: item.procedure_name, tooth: item.tooth, status: item.status, price: item.price } });
}

// ---------------------------------------------------------------- growth
const num = (min, max) => z.preprocess(emptyToUndefined, z.coerce.number({ invalid_type_error: 'Enter a number.' }).min(min, 'Too small.').max(max, 'Too large.').optional());
const growthSchema = z.object({
  measured_on: isoDate(), weight_kg: num(0.3, 150), length_cm: num(30, 200), head_cm: num(20, 70),
  position: z.preprocess(emptyToUndefined, z.enum(['lying', 'standing']).optional()), notes: optionalString(1000),
});

async function growthData(ctx, patient) {
  const rows = await knex('growth_measurements as g').leftJoin('users as u', 'u.id', 'g.created_by')
    .where({ 'g.business_id': ctx.businessId, 'g.patient_id': patient.id }).orderBy([{ column: 'g.measured_on', order: 'asc' }, { column: 'g.id', order: 'asc' }])
    .select('g.*', 'u.name as user_name');
  const measurements = rows.map((r) => ({
    ...r,
    a: growth.assess({ dob: patient.date_of_birth, gender: patient.gender, date: r.measured_on, weightKg: nOrNull(r.weight_kg), lengthCm: nOrNull(r.length_cm), headCm: nOrNull(r.head_cm), position: r.position }),
  }));
  // Visits of this child with weight/height in the vital signs that are not in the growth log yet.
  const logged = new Set(rows.map((r) => r.appointment_id).filter(Boolean));
  const vq = knex('consultations as c').join('appointments as a', 'a.id', 'c.appointment_id')
    .where({ 'c.business_id': ctx.businessId, 'a.patient_id': patient.id }).whereNotNull('c.vital_signs')
    .orderBy('a.appointment_date', 'desc').limit(30).select('a.id', 'a.appointment_date', 'c.vital_signs');
  if (ctx.ownDoctorId) vq.where('a.doctor_id', ctx.ownDoctorId);
  const fromVisits = (await vq).map((v) => ({ id: v.id, date: v.appointment_date, vit: parseJson(v.vital_signs, {}) }))
    .filter((v) => !logged.has(v.id) && (Number(v.vit.weightKg) > 0 || Number(v.vit.heightCm) > 0) && !rows.some((r) => r.measured_on === v.date));
  return { measurements, fromVisits };
}

async function addMeasurement(ctx, patient, input, visit) {
  const d = validate(growthSchema, { ...input, measured_on: input.measured_on || ctx.today });
  if (!d.weight_kg && !d.length_cm && !d.head_cm) throw E.validation({ weight_kg: 'Required.' });
  if (d.measured_on > ctx.today) throw E.validation({ measured_on: 'The date cannot be in the future.' });
  if (patient.date_of_birth && d.measured_on < patient.date_of_birth) throw E.validation({ measured_on: 'The date is before the date of birth.' });
  const row = {
    business_id: ctx.businessId, patient_id: patient.id, measured_on: d.measured_on, weight_kg: d.weight_kg ?? null, length_cm: d.length_cm ?? null, head_cm: d.head_cm ?? null,
    position: d.length_cm ? (d.position || null) : null, notes: d.notes || null, appointment_id: visit ? visit.id : null, created_by: ctx.userId,
  };
  const [id] = await knex('growth_measurements').insert(row);
  await audit.record(ctx, 'growth.measurement_added', { entityType: 'patient', entityId: patient.id, newValues: { measurement_id: id, measured_on: row.measured_on, weight_kg: row.weight_kg, length_cm: row.length_cm, head_cm: row.head_cm } });
  return id;
}

async function deleteMeasurement(ctx, patient, id) {
  const m = await knex('growth_measurements').where({ id: Number(id), business_id: ctx.businessId, patient_id: patient.id }).first();
  if (!m) throw E.notFound('Measurement');
  await knex('growth_measurements').where({ id: m.id }).del();
  await audit.record(ctx, 'growth.measurement_deleted', { entityType: 'patient', entityId: patient.id, oldValues: { measurement_id: m.id, measured_on: m.measured_on, weight_kg: m.weight_kg, length_cm: m.length_cm, head_cm: m.head_cm } });
}

// ---------------------------------------------------------------- pregnancy
const intOpt = (min, max) => z.preprocess(emptyToUndefined, z.coerce.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(min, 'Too small.').max(max, 'Too large.').optional());
const pregSchema = z.object({
  dating_method: z.enum(['lmp', 'scan'], { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  lmp: z.preprocess(emptyToUndefined, isoDate().optional()),
  scan_date: z.preprocess(emptyToUndefined, isoDate().optional()),
  gravida: intOpt(1, 30), para: intOpt(0, 30),
  blood_group: z.preprocess(emptyToUndefined, z.enum(preg.BLOOD_GROUPS).optional()),
  rh: z.preprocess(emptyToUndefined, z.enum(['pos', 'neg']).optional()),
  notes: optionalString(3000),
});

/** Validates the dating part and returns the stored fields (lmp / scan, EDD). */
function datingOf(input, today) {
  const d = validate(pregSchema, input);
  const out = { dating_method: d.dating_method, lmp: d.lmp || null, scan_date: null, scan_ga_days: null };
  if (d.dating_method === 'lmp') {
    if (!d.lmp) throw E.validation({ lmp: 'Required.' });
    if (d.lmp > today) throw E.validation({ lmp: 'The date cannot be in the future.' });
    out.edd = preg.eddFromLmp(d.lmp);
  } else {
    if (!d.scan_date) throw E.validation({ scan_date: 'Required.' });
    if (d.scan_date > today) throw E.validation({ scan_date: 'The date cannot be in the future.' });
    const ga = preg.parseGa(input.scan_ga_weeks, input.scan_ga_days);
    if (ga === null || ga < 28 || ga > 300) throw E.validation({ scan_ga_weeks: 'Enter the weeks (and days) at the scan.' });
    out.scan_date = d.scan_date; out.scan_ga_days = ga;
    out.edd = preg.eddFromScan(d.scan_date, ga);
  }
  if (preg.gaDaysOn(out.edd, today) > 44 * 7) throw E.validation({ [d.dating_method === 'lmp' ? 'lmp' : 'scan_date']: 'This date is too far in the past for an ongoing pregnancy.' });
  if (d.gravida !== undefined && d.para !== undefined && d.para >= d.gravida) throw E.validation({ para: 'Para cannot be more than previous pregnancies.' });
  const flags = (Array.isArray(input.risk_flags) ? input.risk_flags : [input.risk_flags]).filter((f) => preg.RISK_FLAGS.includes(f));
  return { ...out, gravida: d.gravida ?? null, para: d.para ?? null, blood_group: d.blood_group || null, rh: d.rh || null, risk_flags: flags.length ? flags.join(',') : null, notes: d.notes || null };
}

async function pregnancies(ctx, patient) {
  return knex('pregnancies as p').leftJoin('doctors as d', 'd.id', 'p.doctor_id')
    .where({ 'p.business_id': ctx.businessId, 'p.patient_id': patient.id }).orderBy([{ column: 'p.status', order: 'asc' }, { column: 'p.edd', order: 'desc' }])
    .select('p.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en');
}

async function pregnancyFor(ctx, patient, id) {
  const p = await knex('pregnancies').where({ id: Number(id), business_id: ctx.businessId, patient_id: patient.id }).first();
  if (!p) throw E.notFound('Pregnancy');
  return p;
}

async function startPregnancy(ctx, patient, input, visit) {
  if (patient.gender !== 'female') throw new AppError('NOT_FEMALE', 'Pregnancy follow-up is for female patients.', 409);
  const data = datingOf(input, ctx.today);
  return knex.transaction(async (trx) => {
    const open = await trx('pregnancies').where({ business_id: ctx.businessId, patient_id: patient.id, status: 'active' }).forUpdate().first('id');
    if (open) throw new AppError('PREGNANCY_OPEN', 'This patient already has an ongoing pregnancy.', 409);
    const [id] = await trx('pregnancies').insert({ business_id: ctx.businessId, patient_id: patient.id, status: 'active', ...data, doctor_id: doctorOf(ctx, visit), created_by: ctx.userId });
    await audit.record(ctx, 'pregnancy.started', { entityType: 'patient', entityId: patient.id, newValues: { pregnancy_id: id, ...data } }, trx);
    return id;
  });
}

async function updatePregnancy(ctx, patient, id, input) {
  const p = await pregnancyFor(ctx, patient, id);
  const data = datingOf(input, p.status === 'active' ? ctx.today : (p.outcome_date || ctx.today));
  await knex('pregnancies').where({ id: p.id }).update({ ...data, updated_at: new Date() });
  const { oldValues, newValues } = audit.diff(p, data);
  await audit.record(ctx, 'pregnancy.updated', { entityType: 'patient', entityId: patient.id, oldValues: { pregnancy_id: p.id, ...oldValues }, newValues });
}

const closeSchema = z.object({
  outcome: z.enum(preg.OUTCOMES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  outcome_date: isoDate(),
  delivery_mode: z.preprocess(emptyToUndefined, z.enum(preg.DELIVERY_MODES).optional()),
  baby_weight_kg: num(0.2, 7),
  outcome_notes: optionalString(3000),
});

async function closePregnancy(ctx, patient, id, input) {
  const p = await pregnancyFor(ctx, patient, id);
  if (p.status !== 'active') throw new AppError('PREGNANCY_CLOSED', 'This pregnancy is already closed.', 409);
  const d = validate(closeSchema, input);
  if (d.outcome_date > ctx.today) throw E.validation({ outcome_date: 'The date cannot be in the future.' });
  const start = preg.addDays(p.edd, -preg.TERM_DAYS);
  if (d.outcome_date < start) throw E.validation({ outcome_date: 'The date is before the start of the pregnancy.' });
  const birth = ['live_birth', 'stillbirth'].includes(d.outcome);
  const patch = {
    status: 'closed', outcome: d.outcome, outcome_date: d.outcome_date, delivery_mode: birth ? (d.delivery_mode || null) : null,
    baby_weight_kg: birth ? (d.baby_weight_kg ?? null) : null, outcome_notes: d.outcome_notes || null, closed_at: new Date(), updated_at: new Date(),
  };
  await knex('pregnancies').where({ id: p.id }).update(patch);
  await audit.record(ctx, 'pregnancy.closed', { entityType: 'patient', entityId: patient.id, newValues: { pregnancy_id: p.id, outcome: d.outcome, outcome_date: d.outcome_date, delivery_mode: patch.delivery_mode, baby_weight_kg: patch.baby_weight_kg } });
}

async function reopenPregnancy(ctx, patient, id) {
  const p = await pregnancyFor(ctx, patient, id);
  if (p.status === 'active') return;
  const open = await knex('pregnancies').where({ business_id: ctx.businessId, patient_id: patient.id, status: 'active' }).first('id');
  if (open) throw new AppError('PREGNANCY_OPEN', 'This patient already has an ongoing pregnancy.', 409);
  await knex('pregnancies').where({ id: p.id }).update({ status: 'active', outcome: null, outcome_date: null, delivery_mode: null, baby_weight_kg: null, closed_at: null, updated_at: new Date() });
  await audit.record(ctx, 'pregnancy.reopened', { entityType: 'patient', entityId: patient.id, oldValues: { pregnancy_id: p.id, outcome: p.outcome, outcome_date: p.outcome_date } });
}

const ancSchema = z.object({
  visit_date: isoDate(), weight_kg: num(25, 250),
  bp: z.preprocess(emptyToUndefined, z.string().trim().regex(/^\d{2,3}\/\d{2,3}$/, 'Use the form 120/80.').optional()),
  fundal_height_cm: num(5, 50), fhr: intOpt(50, 240),
  presentation: z.preprocess(emptyToUndefined, z.enum(preg.PRESENTATIONS).optional()),
  oedema: z.preprocess(emptyToUndefined, z.enum(preg.OEDEMA).optional()),
  urine_protein: z.preprocess(emptyToUndefined, z.enum(preg.URINE).optional()),
  urine_glucose: z.preprocess(emptyToUndefined, z.enum(preg.URINE).optional()),
  notes: optionalString(3000),
});

async function antenatalVisits(ctx, pregnancyIds) {
  if (!pregnancyIds.length) return [];
  return knex('antenatal_visits as v').leftJoin('users as u', 'u.id', 'v.created_by').where('v.business_id', ctx.businessId).whereIn('v.pregnancy_id', pregnancyIds)
    .orderBy([{ column: 'v.visit_date', order: 'desc' }, { column: 'v.id', order: 'desc' }]).select('v.*', 'u.name as user_name');
}

async function addAntenatalVisit(ctx, patient, pregId, input, visit) {
  const p = await pregnancyFor(ctx, patient, pregId);
  const d = validate(ancSchema, { ...input, visit_date: input.visit_date || ctx.today });
  if (d.visit_date > ctx.today) throw E.validation({ visit_date: 'The date cannot be in the future.' });
  if (d.visit_date < preg.addDays(p.edd, -preg.TERM_DAYS)) throw E.validation({ visit_date: 'The date is before the start of the pregnancy.' });
  const row = { business_id: ctx.businessId, pregnancy_id: p.id, ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === undefined ? null : v])), appointment_id: visit ? visit.id : null, created_by: ctx.userId };
  const [id] = await knex('antenatal_visits').insert(row);
  await audit.record(ctx, 'pregnancy.visit_added', { entityType: 'patient', entityId: patient.id, newValues: { pregnancy_id: p.id, visit_id: id, visit_date: d.visit_date } });
  return id;
}

async function deleteAntenatalVisit(ctx, patient, pregId, visitId) {
  const p = await pregnancyFor(ctx, patient, pregId);
  const v = await knex('antenatal_visits').where({ id: Number(visitId), business_id: ctx.businessId, pregnancy_id: p.id }).first();
  if (!v) throw E.notFound('Visit');
  await knex('antenatal_visits').where({ id: v.id }).del();
  const { business_id: _b, created_at: _c, updated_at: _u, ...snapshot } = v;
  await audit.record(ctx, 'pregnancy.visit_deleted', { entityType: 'patient', entityId: patient.id, oldValues: snapshot });
}

async function checksFor(ctx, pregnancyId) {
  const rows = await knex('pregnancy_checks').where({ business_id: ctx.businessId, pregnancy_id: pregnancyId }).select('check_key', 'done_on');
  return Object.fromEntries(rows.map((r) => [r.check_key, r.done_on]));
}

async function setCheck(ctx, patient, pregId, key, done, doneOn, schedule) {
  const p = await pregnancyFor(ctx, patient, pregId);
  if (!schedule.some((i) => i.key === key)) throw E.validation({ key: 'Choose a valid value.' });
  if (done) {
    const date = doneOn && preg.isIso(doneOn) && doneOn <= ctx.today ? doneOn : ctx.today;
    await knex('pregnancy_checks').insert({ business_id: ctx.businessId, pregnancy_id: p.id, check_key: key, done_on: date, created_by: ctx.userId }).onConflict(['pregnancy_id', 'check_key']).merge({ done_on: date, updated_at: new Date() });
  } else {
    await knex('pregnancy_checks').where({ business_id: ctx.businessId, pregnancy_id: p.id, check_key: key }).del();
  }
  await audit.record(ctx, done ? 'pregnancy.check_done' : 'pregnancy.check_undone', { entityType: 'patient', entityId: patient.id, newValues: { pregnancy_id: p.id, check: key } });
}

// ---------------------------------------------------------------- panel summary
/** What the visit / patient page panels show. Returns null when nothing should render. */
async function summary(ctx, business, patient) {
  if (!ctx.permissions.has('clinical.view') || !patient) return null;
  const s = await settings(business);
  if (!s.any) return null;
  const rel = relevance(patient, ctx.today);
  const out = { patientId: patient.id, modules: [] };
  if (s.dental && rel.dental) {
    const [[{ n: planned }], [{ n: entries }]] = await Promise.all([
      knex('dental_plan_items').where({ business_id: ctx.businessId, patient_id: patient.id, status: 'planned' }).count({ n: '*' }),
      knex('dental_entries').where({ business_id: ctx.businessId, patient_id: patient.id }).whereNull('voided_at').count({ n: '*' }),
    ]);
    out.modules.push({ key: 'dental', planned: Number(planned), entries: Number(entries) });
  }
  if (s.growth && rel.growth) {
    const last = await knex('growth_measurements').where({ business_id: ctx.businessId, patient_id: patient.id }).whereNotNull('weight_kg')
      .orderBy([{ column: 'measured_on', order: 'desc' }, { column: 'id', order: 'desc' }]).first();
    const a = last ? growth.assess({ dob: patient.date_of_birth, gender: patient.gender, date: last.measured_on, weightKg: nOrNull(last.weight_kg) }) : null;
    out.modules.push({ key: 'growth', last: last ? { date: last.measured_on, weight: nOrNull(last.weight_kg), p: a && a.wfa.p } : null });
  }
  if (s.pregnancy && rel.pregnancy) {
    const active = await knex('pregnancies').where({ business_id: ctx.businessId, patient_id: patient.id, status: 'active' }).first();
    let due = 0;
    if (active) {
      const status = preg.scheduleStatus(s.schedule, { edd: active.edd, rh: active.rh, today: ctx.today, done: await checksFor(ctx, active.id) });
      due = status.filter((i) => i.status === 'overdue').length;
    }
    out.modules.push({ key: 'pregnancy', active: active ? { id: active.id, edd: active.edd, ga: preg.gaDaysOn(active.edd, ctx.today), overdue: due } : null });
  }
  return out.modules.length ? out : null;
}

module.exports = {
  MODULES, defaultModules, settings, saveSettings, patientFor, visitFor, relevance, ageDays,
  dentalData, addDentalEntry, voidDentalEntry, addPlanItem, setPlanStatus, deletePlanItem,
  growthData, addMeasurement, deleteMeasurement,
  pregnancies, pregnancyFor, datingOf, startPregnancy, updatePregnancy, closePregnancy, reopenPregnancy, antenatalVisits, addAntenatalVisit, deleteAntenatalVisit, checksFor, setCheck,
  summary,
};
