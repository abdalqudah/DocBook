// Clinical records: consultations (SOAP notes + vital signs), prescriptions, medication list, insurance providers.
// Nurses record vital signs (vitals.edit); doctors write the SOAP note, diagnosis and prescriptions (clinical.edit / prescriptions.create).
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { repo } = require('../../core/crud');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');
const { E } = require('../../core/errors');
const appts = require('./appointments.service');

const num = (min, max) => z.preprocess(emptyToUndefined, z.coerce.number({ invalid_type_error: 'Enter a number.' }).min(min, 'Too small.').max(max, 'Too large.').optional());
const vitalsSchema = z.object({
  weightKg: num(0.5, 400), heightCm: num(20, 260), temperatureC: num(30, 45), pulseBpm: num(20, 250), spo2: num(40, 100),
  bloodPressure: z.preprocess(emptyToUndefined, z.string().trim().regex(/^\d{2,3}\/\d{2,3}$/, 'Use the form 120/80.').optional()),
  respiratoryRate: num(4, 80), bloodSugar: num(10, 1000),
});
const soapSchema = z.object({ subjective: optionalString(10000), objective: optionalString(10000), assessment: optionalString(10000), plan_text: optionalString(10000), diagnosis: optionalString(2000) });

const parseJson = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || d); } catch { return d; } };

async function consultation(ctx, apptId) {
  const c = await knex('consultations').where({ business_id: ctx.businessId, appointment_id: apptId }).first();
  return c ? { ...c, vital_signs: parseJson(c.vital_signs, {}) } : null;
}

async function upsert(ctx, apptId, patch, action) {
  const a = await appts.get(ctx, apptId); // also enforces a doctor's own-schedule scope
  const existing = await knex('consultations').where({ business_id: ctx.businessId, appointment_id: a.id }).first('id');
  if (existing) await knex('consultations').where({ id: existing.id }).update({ ...patch, updated_at: new Date() });
  else await knex('consultations').insert({ business_id: ctx.businessId, appointment_id: a.id, doctor_id: a.doctor_id, patient_id: a.patient_id, patient_name: a.patient_name, patient_phone: a.patient_phone, ...patch });
  await audit.record(ctx, action, { entityType: 'appointment', entityId: a.id, newValues: Object.fromEntries(Object.keys(patch).map((k) => [k, k === 'vital_signs' ? patch[k] : '[updated]'])) });
}

/**
 * Vital signs (and, when the form carries it, the chief complaint) — recorded by the nurse or reception while the
 * patient waits, or on the visit screen. Anyone with vitals.edit may write both; the doctor's SOAP note is separate.
 */
async function saveVitals(ctx, apptId, input) {
  const v = validate(vitalsSchema, input);
  const clean = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
  const patch = { vital_signs: JSON.stringify(clean), vitals_by: ctx.userId };
  if (input && Object.prototype.hasOwnProperty.call(input, 'chief_complaint')) {
    patch.chief_complaint = validate(z.object({ chief_complaint: optionalString(1000) }), { chief_complaint: input.chief_complaint }).chief_complaint || null;
  }
  await upsert(ctx, apptId, patch, 'consultation.vitals');
}

async function saveNote(ctx, apptId, input) {
  const d = validate(soapSchema, input);
  await upsert(ctx, apptId, Object.fromEntries(Object.entries(d).map(([k, x]) => [k, x || null])), 'consultation.note');
}

// ---------------------------------------------------------------- prescriptions
const itemSchema = z.object({ medicationName: z.string().trim().min(1, 'Required.').max(190), dosage: optionalString(120), frequency: optionalString(120), duration: optionalString(120), instructions: optionalString(500) });

async function prescribe(ctx, apptId, input) {
  const a = await appts.get(ctx, apptId);
  const raw = Array.isArray(input.items) ? input.items : Object.values(input.items || {});
  const items = raw.filter((i) => i && String(i.medicationName || '').trim());
  const d = validate(z.object({ items: z.array(itemSchema).min(1, 'Add at least one item.'), diagnosis: optionalString(2000), notes: optionalString(3000) }), { ...input, items });
  const [rxId] = await knex('prescriptions').insert({
    business_id: ctx.businessId, appointment_id: a.id, doctor_id: a.doctor_id, patient_id: a.patient_id, patient_name: a.patient_name, patient_phone: a.patient_phone,
    diagnosis: d.diagnosis || null, items: JSON.stringify(d.items), notes: d.notes || null, created_by: ctx.userId,
  });
  await audit.record(ctx, 'prescription.created', { entityType: 'prescription', entityId: rxId, newValues: { appointment_id: a.id, items: d.items.length } });
  return rxId;
}

async function prescription(ctx, rxId) {
  const q = knex('prescriptions as p').leftJoin('doctors as d', 'd.id', 'p.doctor_id').where({ 'p.business_id': ctx.businessId, 'p.id': rxId })
    .first('p.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.specialization', 'd.specialization_en', 'd.license_number');
  const rx = await q;
  if (!rx || (ctx.ownDoctorId && rx.doctor_id !== ctx.ownDoctorId)) throw E.notFound('Prescription');
  return { ...rx, items: parseJson(rx.items, []) };
}

const prescriptionsFor = (ctx, apptId) => knex('prescriptions').where({ business_id: ctx.businessId, appointment_id: apptId }).orderBy('created_at', 'desc')
  .then((rows) => rows.map((r) => ({ ...r, items: parseJson(r.items, []) })));

// ---------------------------------------------------------------- medications (DocBook starter list) & insurance
const STARTER_MEDICATIONS = ['Paracetamol', 'Ibuprofen', 'Amoxicillin', 'Amoxicillin/Clavulanic Acid', 'Metronidazole', 'Azithromycin', 'Diclofenac', 'Mefenamic Acid', 'Chlorhexidine Mouthwash', 'Cetirizine'];
const medications = repo({ table: 'medications', entity: 'medication', searchable: ['name', 'category'], defaultSort: ['sort_order', 'asc'] });
const insurance = repo({ table: 'insurance_providers', entity: 'insurance_provider', searchable: ['name'], defaultSort: ['sort_order', 'asc'] });

async function seedMedications(businessId, trx = knex) {
  const [{ n }] = await trx('medications').where({ business_id: businessId }).count({ n: '*' });
  if (Number(n) > 0) return;
  await trx('medications').insert(STARTER_MEDICATIONS.map((name, i) => ({ business_id: businessId, name, sort_order: i })));
}

async function activeMedications(ctx) {
  await seedMedications(ctx.businessId);
  return knex('medications').where({ business_id: ctx.businessId, is_active: true }).orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('id', 'name', 'category');
}

const bool = () => z.preprocess((v) => v === '1' || v === 'on' || v === true, z.boolean());
async function saveMedication(ctx, mid, input) {
  const d = validate(z.object({ name: z.string().trim().min(1, 'Required.').max(190), category: optionalString(100), country: optionalString(100), is_active: bool() }), input);
  const row = { ...d, category: d.category || null, country: d.country || null };
  if (mid) { await medications.update(ctx, mid, row); return mid; }
  return medications.create(ctx, row);
}
async function saveInsurance(ctx, iid, input) {
  const d = validate(z.object({ name: z.string().trim().min(1, 'Required.').max(190), coverage_percent: z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(v)), z.number().min(0, 'Must be between 0 and 100.').max(100, 'Must be between 0 and 100.')), is_active: bool() }), input);
  if (iid) { await insurance.update(ctx, iid, d); return iid; }
  return insurance.create(ctx, d);
}
const activeInsurance = (ctx) => knex('insurance_providers').where({ business_id: ctx.businessId, is_active: true }).orderBy([{ column: 'sort_order' }, { column: 'name' }]);

/** Coded (ICD-10) diagnoses of one visit, primary first — see src/modules/clinicalplus/icd.service.js. */
const diagnosesFor = (businessId, appointmentId) => require('../clinicalplus/icd.service').diagnosesFor(businessId, appointmentId); // eslint-disable-line global-require

module.exports = { diagnosesFor, consultation, saveVitals, saveNote, prescribe, prescription, prescriptionsFor, medications, insurance, seedMedications, activeMedications, saveMedication, saveInsurance, activeInsurance, parseJson };
