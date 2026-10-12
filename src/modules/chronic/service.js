// Chronic disease tracking — data layer: a patient's chronic conditions, readings entered between visits, the vital
// signs saved with visits (consultations.vital_signs) read as readings too, the measures with their targets
// (latest value, change, out of range), the clinic-wide list with the "follow-up overdue" flag, and the clinic setting.
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { z, validate, optionalString, isoDate, emptyToUndefined } = require('../../core/validate');
const { E } = require('../../core/errors');
const lib = require('../clinic/records.lib');
const branchesSvc = require('../clinic/branches.service');

const CONDITIONS = ['diabetes', 'hypertension', 'asthma_copd', 'heart', 'kidney', 'thyroid', 'obesity', 'other'];
// Kinds of reading: unit and the accepted range (blood pressure: systolic, diastolic).
const KINDS = {
  bp: { unit: 'mmHg', range: [50, 300], range2: [20, 200] },
  glucose: { unit: 'mg/dL', range: [10, 1000] },
  hba1c: { unit: '%', range: [2, 20] },
  weight: { unit: 'kg', range: [0.5, 400] },
  height: { unit: 'cm', range: [20, 260] },
  pulse: { unit: 'bpm', range: [20, 250] },
  spo2: { unit: '%', range: [40, 100] },
  temperature: { unit: '°C', range: [30, 45] },
  peak_flow: { unit: 'L/min', range: [30, 1000] },
};
const KIND_KEYS = Object.keys(KINDS);
const GLUCOSE_CONTEXTS = ['fasting', 'random', 'post_meal'];
const DEFAULT_OVERDUE_DAYS = 90;
// The visit's vital signs (clinical.service vitalsSchema) → kinds of reading.
const VITAL_KEYS = { weightKg: 'weight', heightCm: 'height', temperatureC: 'temperature', pulseBpm: 'pulse', spo2: 'spo2', bloodSugar: 'glucose' };

const parseJson = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || d); } catch { return d; } };
const nOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const dayMs = 86_400_000;
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs);

// ---------------------------------------------------------------- settings
const settings = (businessId) => cache.remember(`chronic:${businessId}`, async () => {
  const r = await knex('chronic_settings').where({ business_id: businessId }).first('overdue_days');
  return { overdueDays: r ? Number(r.overdue_days) : DEFAULT_OVERDUE_DAYS };
}, 60_000);

async function saveSettings(ctx, input) {
  const d = validate(z.object({ overdue_days: z.coerce.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(7, 'Too small.').max(730, 'Too large.') }), input);
  const before = await settings(ctx.businessId);
  const now = new Date();
  await knex('chronic_settings').insert({ business_id: ctx.businessId, overdue_days: d.overdue_days, updated_by: ctx.userId, created_at: now, updated_at: now })
    .onConflict('business_id').merge({ overdue_days: d.overdue_days, updated_by: ctx.userId, updated_at: now });
  cache.forgetPrefix(`chronic:${ctx.businessId}`);
  await audit.record(ctx, 'chronic.settings_updated', { entityType: 'business', entityId: ctx.businessId, oldValues: { overdue_days: before.overdueDays }, newValues: { overdue_days: d.overdue_days } });
}

// ---------------------------------------------------------------- conditions
const conditionsOf = (ctx, patientId) => knex('patient_conditions').where({ business_id: ctx.businessId, patient_id: patientId })
  .orderBy([{ column: 'started_on', order: 'asc' }, { column: 'id', order: 'asc' }]).select('id', 'condition_key', 'label', 'started_on', 'note', 'created_at');

const conditionSchema = z.object({
  condition_key: z.enum(CONDITIONS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  label: optionalString(120),
  started_on: z.preprocess(emptyToUndefined, isoDate().optional()),
  note: optionalString(500),
});

async function addCondition(ctx, patient, input) {
  const d = validate(conditionSchema, input);
  if (d.condition_key === 'other' && !d.label) throw E.validation({ label: 'Required.' });
  if (d.started_on && d.started_on > ctx.today) throw E.validation({ started_on: 'The date cannot be in the future.' });
  const label = d.condition_key === 'other' ? d.label : null;
  const same = knex('patient_conditions').where({ business_id: ctx.businessId, patient_id: patient.id, condition_key: d.condition_key });
  if (label) same.where('label', label);
  if (await same.first('id')) throw E.validation({ condition_key: 'Already recorded.' });
  const row = { business_id: ctx.businessId, patient_id: patient.id, condition_key: d.condition_key, label, started_on: d.started_on || null, note: d.note || null, created_by: ctx.userId };
  const [id] = await knex('patient_conditions').insert(row);
  await audit.record(ctx, 'chronic.condition_added', { entityType: 'patient', entityId: patient.id, newValues: { condition_id: id, condition: d.condition_key, label, started_on: row.started_on } });
  return id;
}

async function removeCondition(ctx, patient, id) {
  const c = await knex('patient_conditions').where({ id: Number(id) || 0, business_id: ctx.businessId, patient_id: patient.id }).first();
  if (!c) throw E.notFound('Condition');
  await knex('patient_conditions').where({ id: c.id }).del();
  await audit.record(ctx, 'chronic.condition_removed', { entityType: 'patient', entityId: patient.id, oldValues: { condition_id: c.id, condition: c.condition_key, label: c.label, started_on: c.started_on, note: c.note } });
}

// ---------------------------------------------------------------- readings
const num = (min, max) => z.preprocess(emptyToUndefined, z.coerce.number({ invalid_type_error: 'Enter a number.' }).min(min, 'Too small.').max(max, 'Too large.'));
const readingSchema = z.object({
  kind: z.enum(KIND_KEYS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  value: z.preprocess(emptyToUndefined, z.string({ required_error: 'Required.' }).trim().max(20)),
  context: z.preprocess(emptyToUndefined, z.enum(GLUCOSE_CONTEXTS, { errorMap: () => ({ message: 'Choose a valid value.' }) }).optional()),
  measured_on: isoDate(),
  measured_time: z.preprocess(emptyToUndefined, z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a valid time.').optional()),
  note: optionalString(500),
});

/** Validates a reading: blood pressure is typed "120/80"; every other kind is one number. */
function parseReading(input, today) {
  const d = validate(readingSchema, { ...input, measured_on: input.measured_on || today });
  if (d.measured_on > today) throw E.validation({ measured_on: 'The date cannot be in the future.' });
  const k = KINDS[d.kind];
  let value; let value2 = null;
  if (d.kind === 'bp') {
    const m = /^(\d{2,3}(?:\.\d+)?)\s*\/\s*(\d{2,3}(?:\.\d+)?)$/.exec(d.value);
    if (!m) throw E.validation({ value: 'Use the form 120/80.' });
    value = validate(z.object({ v: num(...k.range) }), { v: m[1] }).v;
    value2 = validate(z.object({ v: num(...k.range2) }), { v: m[2] }).v;
    if (value2 >= value) throw E.validation({ value: 'Use the form 120/80.' });
  } else {
    try { value = validate(z.object({ value: num(...k.range) }), { value: d.value.replace(',', '.') }).value; } catch (e) { throw E.validation({ value: Object.values(e.details || {})[0] || 'Enter a number.' }); }
  }
  return {
    kind: d.kind, value, value2, context: d.kind === 'glucose' ? (d.context || 'random') : null, unit: k.unit,
    measured_on: d.measured_on, measured_time: d.measured_time || null, note: d.note || null,
  };
}

async function addReading(ctx, patient, input) {
  const r = parseReading(input || {}, ctx.today);
  const [id] = await knex('patient_readings').insert({ business_id: ctx.businessId, patient_id: patient.id, ...r, entered_by: ctx.userId });
  await audit.record(ctx, 'chronic.reading_added', { entityType: 'patient', entityId: patient.id, newValues: { reading_id: id, kind: r.kind, value: r.value, value2: r.value2, context: r.context, measured_on: r.measured_on } });
  return id;
}

async function removeReading(ctx, patient, id) {
  const r = await knex('patient_readings').where({ id: Number(id) || 0, business_id: ctx.businessId, patient_id: patient.id }).first();
  if (!r) throw E.notFound('Reading');
  await knex('patient_readings').where({ id: r.id }).del();
  await audit.record(ctx, 'chronic.reading_removed', { entityType: 'patient', entityId: patient.id, oldValues: { reading_id: r.id, kind: r.kind, value: r.value, value2: r.value2, context: r.context, measured_on: r.measured_on } });
}

/** One visit's vital signs as readings (source 'visit'). */
function vitalsAsReadings(v, base) {
  const out = [];
  const bp = /^(\d{2,3})\/(\d{2,3})$/.exec(String(v.bloodPressure || '').trim());
  if (bp) out.push({ ...base, kind: 'bp', value: Number(bp[1]), value2: Number(bp[2]), unit: KINDS.bp.unit });
  Object.entries(VITAL_KEYS).forEach(([key, kind]) => {
    const n = nOrNull(v[key]);
    if (n !== null && n > 0) out.push({ ...base, kind, value: n, value2: null, context: kind === 'glucose' ? 'random' : null, unit: KINDS[kind].unit });
  });
  return out;
}

/** Vital signs saved with this patient's visits (a doctor login: its own visits only). */
async function visitReadings(ctx, patientId) {
  const q = knex('consultations as c').leftJoin('appointments as a', 'a.id', 'c.appointment_id')
    .where({ 'c.business_id': ctx.businessId, 'c.patient_id': patientId }).whereNotNull('c.vital_signs')
    .select('c.appointment_id', 'c.vital_signs', 'c.created_at', 'a.appointment_date', 'a.appointment_time');
  if (ctx.ownDoctorId) q.where('c.doctor_id', ctx.ownDoctorId);
  const rows = await q;
  return rows.flatMap((c) => {
    const on = c.appointment_date || new Date(c.created_at).toISOString().slice(0, 10);
    return vitalsAsReadings(parseJson(c.vital_signs, {}) || {}, { id: null, source: 'visit', appointment_id: c.appointment_id, measured_on: on, measured_time: c.appointment_time ? String(c.appointment_time).slice(0, 5) : null, note: null, context: null });
  });
}

/** All the patient's readings — entered and from visits — oldest first. */
async function readingsOf(ctx, patientId) {
  const [manual, visits] = await Promise.all([
    knex('patient_readings as r').leftJoin('users as u', 'u.id', 'r.entered_by').where({ 'r.business_id': ctx.businessId, 'r.patient_id': patientId })
      .select('r.id', 'r.kind', 'r.value', 'r.value2', 'r.context', 'r.unit', 'r.measured_on', 'r.measured_time', 'r.note', 'u.name as entered_by_name'),
    visitReadings(ctx, patientId),
  ]);
  const all = [...manual.map((r) => ({ ...r, source: 'manual', value: Number(r.value), value2: nOrNull(r.value2) })), ...visits];
  return all.sort((a, b) => `${a.measured_on} ${a.measured_time || '00:00'}`.localeCompare(`${b.measured_on} ${b.measured_time || '00:00'}`) || (a.source === 'visit' ? -1 : 1));
}

// ---------------------------------------------------------------- measures and targets
const STRICT_BP = ['diabetes', 'kidney', 'heart', 'hypertension'];
/**
 * Targets of each measure for this patient. A target is { lo, hi, strict } (strict: the value must stay below hi);
 * lo / hi may be null. Blood pressure: < 130/80 with diabetes, hypertension, heart or kidney disease, else < 140/90.
 */
function targetsFor(conditionKeys, heightCm) {
  const strictBp = conditionKeys.some((k) => STRICT_BP.includes(k));
  const h = heightCm ? heightCm / 100 : null;
  return {
    sys: { lo: 90, hi: strictBp ? 130 : 140, strict: true },
    dia: { lo: 60, hi: strictBp ? 80 : 90, strict: true },
    fasting: { lo: 80, hi: 130 },
    random: { lo: 70, hi: 180, strict: true },
    hba1c: { lo: null, hi: 7, strict: true },
    weight: h ? { lo: Math.round(18.5 * h * h * 10) / 10, hi: Math.round(25 * h * h * 10) / 10, strict: true } : null,
    bmi: { lo: 18.5, hi: 25, strict: true },
    pulse: { lo: 60, hi: 100 },
    spo2: { lo: 95, hi: null },
    temperature: { lo: 36.1, hi: 37.5 },
    peak_flow: null,
  };
}
const isOut = (t, v) => Boolean(t) && v !== null && ((t.lo !== null && v < t.lo) || (t.hi !== null && (t.strict ? v >= t.hi : v > t.hi)));

// Charts, in order: each draws one or two series from the readings.
const MEASURES = [
  { key: 'bp', kinds: ['bp'], series: [{ key: 'sys', target: 'sys', pick: (r) => r.value }, { key: 'dia', target: 'dia', cls: 's2', pick: (r) => r.value2 }], digits: 0 },
  { key: 'glucose', kinds: ['glucose'], series: [{ key: 'fasting', target: 'fasting', pick: (r) => (r.context === 'fasting' ? r.value : null) }, { key: 'random', target: 'random', cls: 's2', pick: (r) => (r.context !== 'fasting' ? r.value : null) }], digits: 0 },
  { key: 'hba1c', kinds: ['hba1c'], series: [{ key: 'hba1c', target: 'hba1c', pick: (r) => r.value }], digits: 1 },
  { key: 'weight', kinds: ['weight'], series: [{ key: 'weight', target: 'weight', pick: (r) => r.value }], digits: 1 },
  { key: 'bmi', kinds: ['weight'], series: [{ key: 'bmi', target: 'bmi', pick: (r) => r.bmi }], digits: 1, needsHeight: true },
  { key: 'pulse', kinds: ['pulse'], series: [{ key: 'pulse', target: 'pulse', pick: (r) => r.value }], digits: 0 },
  { key: 'spo2', kinds: ['spo2'], series: [{ key: 'spo2', target: 'spo2', pick: (r) => r.value }], digits: 0 },
  { key: 'temperature', kinds: ['temperature'], series: [{ key: 'temperature', target: 'temperature', pick: (r) => r.value }], digits: 1 },
  { key: 'peak_flow', kinds: ['peak_flow'], series: [{ key: 'peak_flow', target: 'peak_flow', pick: (r) => r.value }], digits: 0 },
];

/**
 * The patient's measures: for each chart the points of its series (with out-of-range marks), the target, the latest
 * value and the change from the one before. Height for the BMI: the latest height recorded (entered or at a visit).
 */
function measures(readings, conditionKeys) {
  const heights = readings.filter((r) => r.kind === 'height');
  const heightCm = heights.length ? heights[heights.length - 1].value : null;
  const targets = targetsFor(conditionKeys, heightCm);
  const withBmi = readings.map((r) => (r.kind === 'weight' && heightCm ? { ...r, bmi: Math.round((r.value / ((heightCm / 100) ** 2)) * 10) / 10 } : r));
  const out = [];
  MEASURES.forEach((m) => {
    if (m.needsHeight && !heightCm) return;
    const rows = withBmi.filter((r) => m.kinds.includes(r.kind));
    if (!rows.length) return;
    const series = m.series.map((s) => {
      const t = targets[s.target];
      const points = rows.map((r) => ({ r, v: s.pick(r) })).filter((p) => p.v !== null && p.v !== undefined)
        .map((p) => ({ on: p.r.measured_on, time: p.r.measured_time, v: p.v, out: isOut(t, p.v), source: p.r.source }));
      const last = points[points.length - 1] || null;
      const prev = points[points.length - 2] || null;
      return { key: s.key, cls: s.cls || '', target: t, points, last, prev, change: last && prev ? Math.round((last.v - prev.v) * 100) / 100 : null };
    }).filter((s) => s.points.length);
    if (!series.length) return;
    const lastRow = rows[rows.length - 1];
    out.push({ key: m.key, digits: m.digits, unit: m.key === 'bmi' ? 'kg/m²' : KINDS[m.kinds[0]].unit, series, lastOn: lastRow.measured_on, outNow: series.some((s) => s.last && s.last.out && s.last.on === lastRow.measured_on) });
  });
  return { list: out, heightCm, targets };
}

/** Everything the Tracking tab shows. */
async function trackingOf(ctx, patient) {
  const [conditions, readings] = await Promise.all([conditionsOf(ctx, patient.id), readingsOf(ctx, patient.id)]);
  return { conditions, readings, ...measures(readings, conditions.map((c) => c.condition_key)) };
}

// ---------------------------------------------------------------- the clinic-wide list
/**
 * Patients with a chronic condition (optionally one condition): their conditions, last reading (entered or at a visit),
 * last visit, and whether follow-up is overdue (no visit and no reading for `overdueDays`).
 */
async function chronicList(ctx, { condition = '', overdueOnly = false } = {}) {
  const { overdueDays } = await settings(ctx.businessId);
  const pq = knex('patients').where('patients.business_id', ctx.businessId)
    .whereExists(function has() {
      this.select(knex.raw('1')).from('patient_conditions as pc').whereRaw('pc.patient_id = patients.id').where('pc.business_id', ctx.businessId);
      if (CONDITIONS.includes(condition)) this.where('pc.condition_key', condition);
    })
    .orderBy('patients.full_name').limit(2000).select('patients.id', 'patients.full_name', 'patients.name_en', 'patients.phone', 'patients.file_number');
  lib.scopePatientsToDoctor(pq, ctx.ownDoctorId);
  branchesSvc.scopePatients(pq, ctx);
  const patients = await pq;
  if (!patients.length) return { rows: [], overdueDays };
  const ids = patients.map((p) => p.id);
  const visitsQ = knex('appointments').where({ business_id: ctx.businessId, status: 'completed' }).whereIn('patient_id', ids).where('appointment_date', '<=', ctx.today)
    .groupBy('patient_id').select('patient_id').max({ last: 'appointment_date' });
  if (ctx.ownDoctorId) visitsQ.where('doctor_id', ctx.ownDoctorId);
  const vitalsQ = knex('consultations as c').leftJoin('appointments as a', 'a.id', 'c.appointment_id').where('c.business_id', ctx.businessId).whereIn('c.patient_id', ids)
    .whereNotNull('c.vital_signs').select('c.patient_id', 'c.vital_signs', 'c.created_at', 'a.appointment_date', 'a.appointment_time');
  if (ctx.ownDoctorId) vitalsQ.where('c.doctor_id', ctx.ownDoctorId);
  const [conds, visits, manual, vitals] = await Promise.all([
    knex('patient_conditions').where({ business_id: ctx.businessId }).whereIn('patient_id', ids).orderBy('id').select('patient_id', 'condition_key', 'label'),
    visitsQ,
    knex('patient_readings').where({ business_id: ctx.businessId }).whereIn('patient_id', ids).orderBy([{ column: 'measured_on', order: 'desc' }, { column: 'measured_time', order: 'desc' }, { column: 'id', order: 'desc' }])
      .select('patient_id', 'kind', 'value', 'value2', 'context', 'unit', 'measured_on', 'measured_time'),
    vitalsQ,
  ]);
  const key = (r) => `${r.measured_on} ${r.measured_time || '00:00'}`;
  const lastReading = new Map();
  const consider = (r) => { const cur = lastReading.get(r.patient_id); if (!cur || key(r) > key(cur)) lastReading.set(r.patient_id, r); };
  manual.forEach((r) => consider({ ...r, value: Number(r.value), value2: nOrNull(r.value2), source: 'manual' }));
  vitals.forEach((c) => {
    const on = c.appointment_date || new Date(c.created_at).toISOString().slice(0, 10);
    const list = vitalsAsReadings(parseJson(c.vital_signs, {}) || {}, { patient_id: c.patient_id, source: 'visit', measured_on: on, measured_time: c.appointment_time ? String(c.appointment_time).slice(0, 5) : null, context: null });
    // one reading per visit stands for it: blood pressure first, else the first value recorded
    if (list.length) consider(list.find((r) => r.kind === 'bp') || list.find((r) => r.kind === 'glucose') || list[0]);
  });
  const lastVisit = new Map(visits.map((v) => [v.patient_id, v.last]));
  const condsBy = new Map();
  conds.forEach((c) => { if (!condsBy.has(c.patient_id)) condsBy.set(c.patient_id, []); condsBy.get(c.patient_id).push(c); });
  let rows = patients.map((p) => {
    const reading = lastReading.get(p.id) || null;
    const visit = lastVisit.get(p.id) || null;
    const last = [visit, reading && reading.measured_on].filter(Boolean).sort().pop() || null;
    const since = last ? daysBetween(last, ctx.today) : null;
    return { patient: p, conditions: condsBy.get(p.id) || [], reading, lastVisit: visit, lastContact: last, daysSince: since, overdue: since === null || since > overdueDays };
  });
  if (overdueOnly) rows = rows.filter((r) => r.overdue);
  rows.sort((a, b) => (Number(b.overdue) - Number(a.overdue)) || ((b.daysSince ?? 1e9) - (a.daysSince ?? 1e9)));
  return { rows, overdueDays };
}

module.exports = {
  CONDITIONS, KINDS, KIND_KEYS, GLUCOSE_CONTEXTS, DEFAULT_OVERDUE_DAYS,
  settings, saveSettings, conditionsOf, addCondition, removeCondition, parseReading, addReading, removeReading, readingsOf, targetsFor, isOut, measures, trackingOf, chronicList, daysBetween,
};
