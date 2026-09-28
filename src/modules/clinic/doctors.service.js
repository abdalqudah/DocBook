// Doctors (bilingual profiles, fees, schedule, days off) and clinic services.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { repo } = require('../../core/crud');
const { z, validate, money, isoDate, optionalString, emptyToUndefined } = require('../../core/validate');
const { E } = require('../../core/errors');
const scheduling = require('./scheduling');

const doctors = repo({ table: 'doctors', entity: 'doctor', searchable: ['full_name', 'full_name_en', 'specialization', 'phone', 'email'], filters: { active: (q, v) => q.where('doctors.is_active', v === 'yes' ? 1 : 0) }, sortable: { name: 'full_name', order: 'sort_order' }, defaultSort: ['sort_order', 'asc'] });
const services = repo({ table: 'services', entity: 'service', searchable: ['name', 'name_en'], filters: { doctor: 'doctor_id' }, sortable: { name: 'name', price: 'price' }, defaultSort: ['sort_order', 'asc'] });

const bool = () => z.preprocess((v) => v === '1' || v === 'on' || v === true || v === 1, z.boolean());
const int = (min, max) => z.preprocess((v) => (v === '' || v === undefined ? undefined : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(min, 'Too small.').max(max, 'Too large.'));
const email = () => z.preprocess(emptyToUndefined, z.string().trim().email('Enter a valid email address.').max(190).optional());

const doctorSchema = z.object({
  full_name: z.string().trim().min(1, 'Required.').max(190),
  full_name_en: optionalString(190), specialization: optionalString(190), specialization_en: optionalString(190),
  bio: optionalString(5000), bio_en: optionalString(5000), education: optionalString(3000), education_en: optionalString(3000),
  phone: optionalString(40), whatsapp: optionalString(40), email: email(), license_number: optionalString(100),
  slot_duration_minutes: int(5, 240), consultation_fee: money(), show_consultation_fee: bool(), base_salary: money(), is_active: bool(),
  sort_order: z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(v)), z.number().int().min(0).max(9999)),
  color: z.preprocess(emptyToUndefined, z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()),
});

async function saveDoctor(ctx, id, input) {
  const d = validate(doctorSchema, input);
  const row = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === undefined ? null : v]));
  if (input.wh) row.working_hours = JSON.stringify(scheduling.parseWorkingHoursForm(input));
  if (id) { await doctors.update(ctx, id, row); return id; }
  if (!row.working_hours) row.working_hours = JSON.stringify(scheduling.defaultWorkingHours());
  return doctors.create(ctx, row);
}

const parseWh = (v) => (typeof v === 'string' ? JSON.parse(v || 'null') : v) || {};

async function listActive(ctx) {
  const q = knex('doctors').where({ business_id: ctx.businessId, is_active: true }).orderBy([{ column: 'sort_order' }, { column: 'full_name' }]);
  return q;
}

async function daysOff(ctx, doctorId) {
  return knex('doctor_days_off').where({ business_id: ctx.businessId, doctor_id: doctorId }).where('off_date', '>=', new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)).orderBy('off_date');
}

async function addDayOff(ctx, doctorId, input) {
  const d = validate(z.object({ off_date: isoDate(), reason: optionalString(255) }), input);
  await doctors.get(ctx, doctorId);
  await knex('doctor_days_off').insert({ business_id: ctx.businessId, doctor_id: doctorId, off_date: d.off_date, reason: d.reason || null }).onConflict(['doctor_id', 'off_date']).ignore();
  await audit.record(ctx, 'doctor.day_off_added', { entityType: 'doctor', entityId: doctorId, newValues: d });
}

async function removeDayOff(ctx, doctorId, id) {
  const n = await knex('doctor_days_off').where({ id, doctor_id: doctorId, business_id: ctx.businessId }).del();
  if (!n) throw E.notFound('Day off');
  await audit.record(ctx, 'doctor.day_off_removed', { entityType: 'doctor', entityId: doctorId, oldValues: { id } });
}

const serviceSchema = z.object({
  name: z.string().trim().min(1, 'Required.').max(190), name_en: optionalString(190), description: optionalString(3000), description_en: optionalString(3000),
  price: money(), show_price: bool(), duration_minutes: int(5, 480), is_active: bool(),
  doctor_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  sort_order: z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(v)), z.number().int().min(0).max(9999)),
});

async function saveService(ctx, id, input) {
  const d = validate(serviceSchema, input);
  if (d.doctor_id) await doctors.get(ctx, d.doctor_id);
  const row = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === undefined ? null : v]));
  if (id) { await services.update(ctx, id, row); return id; }
  return services.create(ctx, row);
}

/** Services a doctor can perform: their own plus clinic-wide ones (no doctor). */
const servicesFor = (ctx, doctorId) => knex('services').where({ business_id: ctx.businessId, is_active: true })
  .andWhere((q) => { q.whereNull('doctor_id'); if (doctorId) q.orWhere('doctor_id', doctorId); }).orderBy([{ column: 'sort_order' }, { column: 'name' }]);

module.exports = { doctors, services, saveDoctor, saveService, listActive, daysOff, addDayOff, removeDayOff, servicesFor, parseWh };
