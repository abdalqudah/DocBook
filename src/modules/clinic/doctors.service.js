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
  phone: optionalString(40), whatsapp: optionalString(40), email: email(), license_number: optionalString(100), room: optionalString(20),
  slot_duration_minutes: int(5, 240), consultation_fee: money(), show_consultation_fee: bool(), base_salary: money(), is_active: bool(),
  bank_name: optionalString(120), iban: optionalString(60),
  sort_order: z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(v)), z.number().int().min(0).max(9999)),
  color: z.preprocess(emptyToUndefined, z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()),
});

async function clinicWeekOf(businessId) {
  const b = await require('../../db/knex')('businesses').where({ id: businessId }).first('default_working_hours'); // eslint-disable-line global-require
  const w = b ? parseWh(b.default_working_hours || 'null') : null;
  return w && Object.keys(w).length ? w : null;
}

async function saveDoctor(ctx, id, input) {
  const d = validate(doctorSchema, input);
  const row = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === undefined ? null : v]));
  if (!('room' in (input || {}))) delete row.room; // forms that do not show the room (setup, API) keep it
  ['bank_name', 'iban'].forEach((k) => { if (!(k in (input || {}))) delete row[k]; }); // only the doctor form carries the bank details
  if (row.iban) row.iban = String(row.iban).replace(/[\s-]+/g, '').toUpperCase();
  // Social-media profiles (only the doctor form carries them).
  if (input && input.social_form) {
    const { links, errors } = require('./doctor-social').parse(input); // eslint-disable-line global-require
    if (Object.keys(errors).length) throw E.validation(errors);
    row.social_links = Object.keys(links).length ? JSON.stringify(links) : null;
  }
  // Full profile for the website (only the doctor form carries it).
  if (input && input.profile_form) { const prof = require('./doctor-profile'); row.profile = prof.toStore(prof.fromForm(input)); } // eslint-disable-line global-require
  // Hours: the clinic's usual week (kept in step when the clinic changes it) or the doctor's own.
  const clinicWeek = await clinicWeekOf(ctx.businessId);
  const mode = input.hours_mode === 'clinic' || input.hours_mode === 'custom' ? input.hours_mode : (id ? null : (clinicWeek ? 'clinic' : 'custom'));
  if (mode) row.hours_mode = mode;
  if (mode === 'clinic') row.working_hours = JSON.stringify(clinicWeek || scheduling.defaultWorkingHours());
  else if (input.wh) row.working_hours = JSON.stringify(scheduling.parseWorkingHoursForm(input));
  // Branch (only sent when the clinic runs branches): '' = main branch; an id must be an active branch of this clinic.
  let branchMoved = false;
  if (input.branch_form) {
    const branches = require('./branches.service'); // eslint-disable-line global-require
    row.branch_id = await branches.check(ctx.businessId, input.branch_id);
    if (id) { const cur = await knex('doctors').where({ id, business_id: ctx.businessId }).first('branch_id'); branchMoved = Boolean(cur) && (cur.branch_id || null) !== row.branch_id; }
  }
  // Online consultations section of the doctor form (validated before anything is saved).
  const tele = input.online_form ? require('../telehealth/telehealth.service') : null; // eslint-disable-line global-require
  const online = tele ? tele.parseDoctorOnline(input) : null;
  if (id) {
    await doctors.update(ctx, id, row);
  } else {
    if (!row.working_hours) row.working_hours = JSON.stringify(scheduling.defaultWorkingHours());
    id = await doctors.create(ctx, row); // eslint-disable-line no-param-reassign
  }
  if (online) await tele.applyDoctorOnline(ctx, id, online);
  // A doctor moving to another branch takes their upcoming appointments along (the visit is where the doctor is).
  if (branchMoved) {
    const today = ctx.today || scheduling.clinicNow(ctx.timezone || 'Asia/Amman').date;
    const moved = await knex('appointments').where({ business_id: ctx.businessId, doctor_id: id }).where('appointment_date', '>=', today)
      .whereNotIn('status', ['cancelled', 'completed', 'no_show']).update({ branch_id: row.branch_id, updated_at: new Date() });
    await audit.record(ctx, 'doctor.branch_changed', { entityType: 'doctor', entityId: id, newValues: { branch_id: row.branch_id, upcoming_appointments_moved: moved } });
  }
  // Photo from the media library (the form sends photo_form so a cleared photo is saved as "none").
  if (input.photo_form) await require('../integrations/media.service').setDoctorPhoto(ctx, id, input.photo_media_id); // eslint-disable-line global-require
  return id;
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
  price: money(), show_price: bool(), // empty = no fixed time (the appointment takes the doctor's usual length)
  duration_minutes: z.preprocess((v) => (v === '' || v === undefined || v === null ? undefined : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(5, 'Too small.').max(480, 'Too large.').optional()), is_active: bool(),
  doctor_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  sort_order: z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(v)), z.number().int().min(0).max(9999)),
});

async function saveService(ctx, id, input) {
  const d = validate(serviceSchema, input);
  if (d.doctor_id) await doctors.get(ctx, d.doctor_id);
  const row = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === undefined ? null : v]));
  // "Show on the website" is only on the Services form (site_field=1); other forms leave it as it is.
  if (input && input.site_field === '1') row.show_on_site = ['1', 'on', true].includes(input.show_on_site);
  if (id) { await services.update(ctx, id, row); return id; }
  return services.create(ctx, row);
}

/** Services a doctor can perform: their own plus clinic-wide ones (no doctor). */
const servicesFor = (ctx, doctorId) => knex('services').where({ business_id: ctx.businessId, is_active: true })
  .andWhere((q) => { q.whereNull('doctor_id'); if (doctorId) q.orWhere('doctor_id', doctorId); }).orderBy([{ column: 'sort_order' }, { column: 'name' }]);

// ---------------------------------------------------------------- My profile (the doctor's own login)
// A doctor linked to their login edits their own public profile and their own services — never another doctor's,
// and never what the clinic decides (name, fee, hours, appointment length, active, branch, pay).
const ownProfileSchema = z.object({
  specialization: optionalString(190), specialization_en: optionalString(190),
  bio: optionalString(5000), bio_en: optionalString(5000), education: optionalString(3000), education_en: optionalString(3000),
});
const myDoctorId = (ctx) => { if (!ctx.doctorId) throw E.forbidden(); return ctx.doctorId; };

async function saveOwnProfile(ctx, input) {
  const id = myDoctorId(ctx);
  const d = validate(ownProfileSchema, input);
  const row = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === undefined ? null : v]));
  const { links, errors } = require('./doctor-social').parse(input || {}); // eslint-disable-line global-require
  if (Object.keys(errors).length) throw E.validation(errors);
  row.social_links = Object.keys(links).length ? JSON.stringify(links) : null;
  const prof = require('./doctor-profile'); // eslint-disable-line global-require
  row.profile = prof.toStore(prof.fromForm(input || {}));
  await doctors.update(ctx, id, row); // audited (doctor.updated)
  await audit.record(ctx, 'doctor.own_profile_saved', { entityType: 'doctor', entityId: id });
}

/** The doctor's own services (active or not). */
const ownServices = (ctx) => knex('services').where({ business_id: ctx.businessId, doctor_id: myDoctorId(ctx) }).orderBy([{ column: 'is_active', order: 'desc' }, { column: 'sort_order' }, { column: 'name' }]);

async function ownServiceRow(ctx, id) {
  const row = await knex('services').where({ id, business_id: ctx.businessId, doctor_id: myDoctorId(ctx) }).first();
  if (!row) throw E.notFound('Service');
  return row;
}

/** A service of the doctor's own: always theirs (doctor_id is never taken from the form). */
async function saveOwnService(ctx, id, input) {
  const me = myDoctorId(ctx);
  if (id) await ownServiceRow(ctx, id);
  const body = { ...(input || {}), doctor_id: String(me) };
  if (id && body.sort_order === undefined) body.sort_order = String((await ownServiceRow(ctx, id)).sort_order || 0);
  return saveService(ctx, id, body);
}

async function removeOwnService(ctx, id) {
  await ownServiceRow(ctx, id);
  await services.remove(ctx, id);
}

module.exports = { saveOwnProfile, ownServices, saveOwnService, removeOwnService, doctors, services, saveDoctor, saveService, listActive, daysOff, addDayOff, removeDayOff, servicesFor, parseWh };
