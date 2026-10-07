// Rep visits: a clinic reserves weekly windows for medical reps (clinic-wide or per doctor); active vendors book a
// slot in those windows. The clinic confirms / declines / marks done / cancels.
//   • a doctor's visit can use that doctor's own windows and the clinic-wide ones; a clinic-wide visit (no doctor)
//     only the clinic-wide windows
//   • a slot is free when no other live visit (requested / confirmed / done) of the same doctor (or of the clinic when
//     no doctor) overlaps it, the doctor is not off that day, and the time has not passed (clinic time zone)
//   • booking holds a MySQL named lock for clinic+doctor+date+time and re-checks the slot — no double booking
// Patients and patient appointments are never read here: reps only see the rep windows' availability.
const knex = require('../../db/knex');
const lock = require('../../db/lock');
const cross = require('../../db/cross');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const { AppError, E } = require('../../core/errors');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');
const scheduling = require('../clinic/scheduling');
const notifications = require('../notifications/notification.service');
const billing = require('../vendorbilling/billing.service');
const pnotify = require('../platformnotify/notify.service');

const { DAY_KEYS, timeToMinutes, minutesToTime, overlaps, isTime, isDate, dayKeyOf, clinicNow } = scheduling;
const LIVE = ['requested', 'confirmed', 'done'];
const STATUSES = ['requested', 'confirmed', 'declined', 'cancelled', 'done'];
const MAX_DAYS_AHEAD = 90;

const err = (code, message, status = 422, details) => new AppError(code, message, status, details);

// ---------------------------------------------------------------- pure slot computation
/**
 * @param {object} o
 *   windows   [{ weekday, start_time, end_time, slot_minutes, doctor_id }] active windows usable for this booking
 *   date      'YYYY-MM-DD'
 *   booked    [{ time, duration }] live visits of the same doctor (or clinic) that day
 *   dayOff    the doctor is off that day
 *   today, nowMinutes   the clinic's current date / time
 * @returns [{ time, minutes }] free start times with their length
 */
function computeRepSlots({ windows = [], date, booked = [], dayOff = false, today, nowMinutes = 0 }) {
  if (!isDate(date)) throw err('INVALID_DATE', 'Invalid date.');
  if (today && date < today) throw err('DATE_IN_PAST', 'This date has passed.');
  if (dayOff) return [];
  const day = dayKeyOf(date);
  const blocking = booked.map((b) => { const s = timeToMinutes(b.time); return { start: s, end: s + (Number(b.duration) || 15) }; });
  const out = new Map();
  windows.filter((w) => w.weekday === day && isTime(w.start_time) && isTime(w.end_time)).forEach((w) => {
    const len = Math.min(60, Math.max(10, Number(w.slot_minutes) || 15));
    const end = timeToMinutes(w.end_time);
    for (let s = timeToMinutes(w.start_time); s + len <= end; s += len) {
      if (date === today && s <= nowMinutes) continue; // eslint-disable-line no-continue
      if (blocking.some((b) => overlaps(s, s + len, b.start, b.end))) continue; // eslint-disable-line no-continue
      const t = minutesToTime(s);
      if (!out.has(t)) out.set(t, { time: t, minutes: len });
    }
  });
  return [...out.values()].sort((a, b) => (a.time < b.time ? -1 : 1));
}

// ---------------------------------------------------------------- clinic settings & windows
async function settings(businessId) {
  return knex('businesses').where({ id: businessId }).first('id', 'rep_visits_enabled', 'rep_visits_auto_confirm', 'rep_requests_off');
}

async function saveSettings(ctx, input) {
  const on = (v) => v === '1' || v === 'on' || v === true;
  const before = await settings(ctx.businessId);
  const row = { rep_visits_enabled: on(input.rep_visits_enabled), rep_visits_auto_confirm: on(input.rep_visits_auto_confirm), rep_requests_off: !on(input.rep_requests) };
  await knex('businesses').where({ id: ctx.businessId }).update(row);
  const { oldValues, newValues, changed } = audit.diff(before, row);
  if (changed) await audit.record(ctx, 'rep_visits.settings_updated', { entityType: 'business', entityId: ctx.businessId, oldValues, newValues });
}

const windows = (businessId) => knex('rep_visit_slots as w').leftJoin('doctors as d', 'd.id', 'w.doctor_id').where('w.business_id', businessId)
  .select('w.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.color as doctor_color')
  .orderByRaw(`FIELD(w.weekday, ${DAY_KEYS.map(() => '?').join(',')})`, DAY_KEYS).orderBy('w.start_time');

async function saveWindow(ctx, id, input) {
  const d = validate(z.object({
    doctor_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
    weekday: z.enum(DAY_KEYS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
    start_time: z.string().refine(isTime, 'Enter a valid time.'),
    end_time: z.string().refine(isTime, 'Enter a valid time.'),
    slot_minutes: z.coerce.number({ invalid_type_error: 'Enter a number.' }).int('Choose a valid value.').min(10, 'Choose a valid value.').max(60, 'Choose a valid value.'),
  }), input);
  if (timeToMinutes(d.end_time) - timeToMinutes(d.start_time) < d.slot_minutes) throw E.validation({ end_time: 'Choose a valid value.' });
  if (d.doctor_id && !(await knex('doctors').where({ id: d.doctor_id, business_id: ctx.businessId }).first('id'))) throw E.validation({ doctor_id: 'Choose a valid value.' });
  const row = { doctor_id: d.doctor_id || null, weekday: d.weekday, start_time: d.start_time, end_time: d.end_time, slot_minutes: d.slot_minutes, is_active: true };
  // Windows of the same owner (doctor / clinic) on the same weekday must not overlap.
  const same = await knex('rep_visit_slots').where({ business_id: ctx.businessId, weekday: d.weekday }).andWhere((q) => (d.doctor_id ? q.where('doctor_id', d.doctor_id) : q.whereNull('doctor_id')))
    .modify((q) => { if (id) q.whereNot('id', id); });
  if (same.some((w) => overlaps(timeToMinutes(d.start_time), timeToMinutes(d.end_time), timeToMinutes(w.start_time), timeToMinutes(w.end_time)))) {
    throw err('REP_WINDOW_OVERLAP', 'This window overlaps another window for the same doctor on that day.', 422, { start_time: 'Choose a valid value.' });
  }
  if (id) {
    const before = await knex('rep_visit_slots').where({ id, business_id: ctx.businessId }).first();
    if (!before) throw E.notFound('Window');
    await knex('rep_visit_slots').where({ id }).update({ ...row, updated_at: new Date() });
    const { oldValues, newValues } = audit.diff(before, row);
    await audit.record(ctx, 'rep_window.updated', { entityType: 'rep_visit_slot', entityId: id, oldValues, newValues });
    return id;
  }
  const [newId] = await knex('rep_visit_slots').insert({ ...row, business_id: ctx.businessId });
  await audit.record(ctx, 'rep_window.created', { entityType: 'rep_visit_slot', entityId: newId, newValues: row });
  return newId;
}

async function removeWindow(ctx, id) {
  const before = await knex('rep_visit_slots').where({ id, business_id: ctx.businessId }).first();
  if (!before) throw E.notFound('Window');
  await knex('rep_visit_slots').where({ id }).delete();
  await audit.record(ctx, 'rep_window.deleted', { entityType: 'rep_visit_slot', entityId: id, oldValues: before });
}

// ---------------------------------------------------------------- availability (database)
// Two ways a rep reaches a clinic:
//   'slots'   — the clinic turned rep visits on and reserved weekly windows: exact free times, as before;
//   'request' — any other clinic that is open to reps (rep visits on, or listed in the public directory, and rep
//               requests not turned off): the rep sees the doctors' working hours and suggests a date and time;
//               the clinic confirms or declines. Never more than what the clinic's public page already shows.
const hasWindow = function e() { this.select(knex.raw('1')).from('rep_visit_slots as w').whereRaw('w.business_id = b.id').andWhere('w.is_active', true); };
function openToReps(query) {
  return query.where('b.status', 'active').andWhere((w) => w
    .where((x) => x.where('b.rep_visits_enabled', true).whereExists(hasWindow))
    .orWhere((x) => x.where('b.rep_requests_off', false).whereNotNull('b.onboarding_completed_at').andWhere((y) => y.where('b.rep_visits_enabled', true).orWhere('b.directory_listed', true))));
}

/** Active doctors with their working hours (request mode: every active doctor of the clinic). */
// Doctors live in each clinic's own database (src/db/tenant.js): gathered from each.
const allDoctors = (businessIds) => cross.gatherFor(businessIds, (ids) => knex('doctors').whereIn('business_id', ids).andWhere('is_active', true)
  .select('id', 'business_id', 'full_name', 'full_name_en', 'specialization', 'specialization_en', 'working_hours').orderBy('sort_order').orderBy('id'));

/** Clinics a rep can reach (see openToReps), each with its mode and doctors. */
async function bookableClinics({ q, specialty } = {}) {
  const query = openToReps(knex('businesses as b'))
    .select('b.id', 'b.name', 'b.name_en', 'b.city', 'b.specialty', 'b.rep_visits_enabled', knex.raw('EXISTS (SELECT 1 FROM rep_visit_slots w WHERE w.business_id = b.id AND w.is_active = 1) AS has_windows'))
    .orderBy('b.name').limit(100);
  if (q && String(q).trim()) {
    const s = `%${String(q).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    query.andWhere((w) => w.where('b.name', 'like', s).orWhere('b.name_en', 'like', s).orWhere('b.city', 'like', s));
  }
  if (specialty) query.whereIn('b.specialty', require('../specialty/catalogue').KEYS.filter((k) => require('../specialty/catalogue').lineage(k).includes(specialty))); // eslint-disable-line global-require
  const rows = await query;
  if (!rows.length) return rows;
  rows.forEach((r) => { r.mode = r.rep_visits_enabled && Number(r.has_windows) ? 'slots' : 'request'; });
  const slotIds = rows.filter((r) => r.mode === 'slots').map((r) => r.id);
  const reqIds = rows.filter((r) => r.mode === 'request').map((r) => r.id);
  const [docs, all] = await Promise.all([slotIds.length ? bookableDoctors(slotIds) : [], reqIds.length ? allDoctors(reqIds) : []]);
  rows.forEach((r) => { r.doctors = (r.mode === 'slots' ? docs : all).filter((d) => d.business_id === r.id); });
  return rows;
}

/** Active doctors a rep can book at these clinics (own windows, or any doctor when the clinic has clinic-wide windows). */
async function bookableDoctors(businessIds) {
  const wins = await knex('rep_visit_slots').whereIn('business_id', businessIds).andWhere('is_active', true).select('business_id', 'doctor_id');
  const wide = new Set(wins.filter((w) => !w.doctor_id).map((w) => w.business_id));
  const own = new Set(wins.filter((w) => w.doctor_id).map((w) => w.doctor_id));
  const docs = await cross.gatherFor(businessIds, (ids) => knex('doctors').whereIn('business_id', ids).andWhere('is_active', true)
    .select('id', 'business_id', 'full_name', 'full_name_en', 'specialization', 'specialization_en').orderBy('sort_order').orderBy('id'));
  return docs.filter((d) => wide.has(d.business_id) || own.has(d.id));
}

/**
 * Clinics (of `businessIds`) that added this vendor as a supplier. Only those share their contact details
 * (address, map, phone, e-mail) with the vendor; every other clinic shows its name, city and doctors only.
 */
async function linkedClinics(vendorId, businessIds) {
  const ids = [...new Set(businessIds.map(Number).filter(Boolean))];
  if (!vendorId || !ids.length) return new Set();
  return new Set((await cross.gatherFor(ids, (list) => knex('suppliers').where({ vendor_id: vendorId }).whereIn('business_id', list).pluck('business_id'))).map(Number));
}

/** A bookable clinic (only what a rep may see) or null. */
async function clinicForRep(businessId, vendorId = null) {
  const b = await openToReps(knex('businesses as b').where('b.id', Number(businessId) || 0))
    .first('b.id', 'b.name', 'b.name_en', 'b.city', 'b.specialty', 'b.address', 'b.map_url', 'b.timezone', 'b.rep_visits_auto_confirm', 'b.email', 'b.rep_visits_enabled', 'b.default_working_hours');
  if (!b) return null;
  b.isSupplier = vendorId ? (await linkedClinics(vendorId, [b.id])).has(b.id) : false;
  if (vendorId && !b.isSupplier) { b.address = null; b.map_url = null; } // contact details: suppliers only
  const windows = b.rep_visits_enabled ? await knex('rep_visit_slots').where({ business_id: b.id, is_active: true }).select('doctor_id') : [];
  b.mode = windows.length ? 'slots' : 'request';
  if (b.mode === 'slots') {
    b.doctors = await bookableDoctors([b.id]);
    b.hasClinicWide = windows.some((w) => !w.doctor_id);
  } else {
    b.doctors = (await allDoctors([b.id])).map((d) => ({ ...d, hours: hoursOf(d.working_hours) }));
    b.hasClinicWide = false;
  }
  return b;
}

/** A working-hours JSON as { sun: [{ start, end }] … } (enabled days only, breaks left out). */
function hoursOf(raw) {
  let wh = raw;
  if (typeof raw === 'string') { try { wh = JSON.parse(raw); } catch { wh = null; } }
  const out = {};
  for (const k of DAY_KEYS) {
    const day = scheduling.normalizeDayConfig(wh && wh[k]);
    if (day.enabled) out[k] = day.shifts.map((x) => ({ start: x.start, end: x.end }));
  }
  return out;
}

async function freeSlots({ businessId, doctorId = null, date, timezone }, trx = knex) {
  const { date: today, minutes: nowMinutes } = clinicNow(timezone);
  if (isDate(date) && date > addDays(today, MAX_DAYS_AHEAD)) throw err('REP_DATE_TOO_FAR', 'Choose a date within the next 90 days.');
  const wins = await trx('rep_visit_slots').where({ business_id: businessId, is_active: true })
    .andWhere((q) => (doctorId ? q.where('doctor_id', doctorId).orWhereNull('doctor_id') : q.whereNull('doctor_id')));
  const dayOff = doctorId ? Boolean(await trx('doctor_days_off').where({ business_id: businessId, doctor_id: doctorId, off_date: date }).first('id')) : false;
  const booked = await trx('rep_visits').where({ business_id: businessId, visit_date: date }).whereIn('status', LIVE)
    .andWhere((q) => (doctorId ? q.where('doctor_id', doctorId) : q.whereNull('doctor_id'))).select('visit_time as time', 'duration_minutes as duration');
  return computeRepSlots({ windows: wins, date, booked, dayOff, today, nowMinutes });
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- booking (vendor side)
/**
 * @param vctx   { vendorId, userId, ip, userAgent }
 * @param vendor the vendor row (status must be 'active')
 */
async function book(vctx, vendor, input) {
  if (!vendor || vendor.status !== 'active') throw err('VENDOR_NOT_ACTIVE', 'Your account is waiting for approval. You can book visits once it is approved.', 403);
  await billing.assertCan(vendor.id, 'request'); // subscription / monthly request limit (when reps billing is on)
  const target = await clinicForRep(Number(input && input.business_id) || 0);
  if (target && target.mode === 'request') return requestVisit(vctx, vendor, input, target);
  const d = validate(z.object({
    business_id: z.coerce.number({ invalid_type_error: 'Choose a valid value.' }).int().positive('Choose a valid value.'),
    doctor_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
    visit_date: z.string().refine(isDate, 'Enter a valid date.'),
    visit_time: z.string({ required_error: 'Choose a valid value.' }).refine(isTime, 'Choose a valid value.'),
    purpose: z.string({ required_error: 'Required.' }).trim().min(3, 'Required.').max(300, 'Too large.'),
    products: optionalString(2000),
  }), { ...input, products: [].concat(input.products || []).join(',') });
  const clinic = await clinicForRep(d.business_id);
  if (!clinic) throw E.notFound('Clinic');
  if (d.doctor_id && !clinic.doctors.some((doc) => doc.id === d.doctor_id)) throw E.validation({ doctor_id: 'Choose a valid value.' });
  if (!d.doctor_id && !clinic.hasClinicWide) throw E.validation({ doctor_id: 'Choose a valid value.' });
  // Products the rep will present: only the vendor's own active products.
  const ids = (d.products || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
  const prods = ids.length ? await knex('vendor_products').where({ vendor_id: vendor.id, is_active: true }).whereIn('id', ids).pluck('name') : [];
  let purpose = d.purpose;
  if (prods.length) purpose = `${purpose}\n— ${prods.join('، ')}`;
  purpose = purpose.slice(0, 500);

  const name = `rep_${clinic.id}_${d.doctor_id || 0}_${d.visit_date}_${d.visit_time}`.slice(0, 64);
  const status = clinic.rep_visits_auto_confirm ? 'confirmed' : 'requested';
  // the lock outlives the transaction: a second rep for this slot reads only after this visit is committed
  const id = await lock.withLock(name, () => knex.transaction(async (trx) => {
    const free = await freeSlots({ businessId: clinic.id, doctorId: d.doctor_id || null, date: d.visit_date, timezone: clinic.timezone }, trx);
    const slot = free.find((s) => s.time === d.visit_time);
    if (!slot) throw new AppError('SLOT_TAKEN', 'This time is no longer available. Choose another time.', 409, { visit_time: 'This time is no longer available.' });
    const [newId] = await trx('rep_visits').insert({
      business_id: clinic.id, doctor_id: d.doctor_id || null, vendor_id: vendor.id, user_id: vctx.userId, visit_date: d.visit_date, visit_time: d.visit_time,
      duration_minutes: slot.minutes, purpose, status,
    });
    await audit.record({ businessId: clinic.id, userId: vctx.userId, ip: vctx.ip, userAgent: vctx.userAgent }, 'rep_visit.requested',
      { entityType: 'rep_visit', entityId: newId, newValues: { vendor_id: vendor.id, doctor_id: d.doctor_id || null, visit_date: d.visit_date, visit_time: d.visit_time, status } }, trx);
    return newId;
  }));

  await tellClinic(clinic, vendor, { id, status, doctorId: d.doctor_id, date: d.visit_date, time: d.visit_time, purpose: d.purpose });
  return { id, status };
}

/**
 * A visit REQUEST at a suggested date and time (clinics without rep windows): the time must fall inside the doctor's
 * working hours that day, not on a day off and not in the past; one live request per rep, doctor and day. The clinic
 * always decides (never confirmed automatically).
 */
async function requestVisit(vctx, vendor, input, clinic) {
  const d = validate(z.object({
    doctor_id: z.coerce.number({ invalid_type_error: 'Choose a valid value.' }).int().positive('Choose a valid value.'),
    visit_date: z.string().refine(isDate, 'Enter a valid date.'),
    visit_time: z.string({ required_error: 'Choose a valid value.' }).refine(isTime, 'Choose a valid value.'),
    purpose: z.string({ required_error: 'Required.' }).trim().min(3, 'Required.').max(300, 'Too large.'),
    products: optionalString(2000),
  }), { ...input, products: [].concat(input.products || []).join(',') });
  const doc = clinic.doctors.find((x) => x.id === d.doctor_id);
  if (!doc) throw E.validation({ doctor_id: 'Choose a valid value.' });
  const { date: today, minutes: nowMinutes } = clinicNow(clinic.timezone);
  if (d.visit_date < today || (d.visit_date === today && timeToMinutes(d.visit_time) <= nowMinutes)) throw E.validation({ visit_date: 'Choose a date and time in the future.' });
  if (d.visit_date > addDays(today, MAX_DAYS_AHEAD)) throw err('REP_DATE_TOO_FAR', 'Choose a date within the next 90 days.');
  const shifts = doc.hours[dayKeyOf(d.visit_date)] || [];
  const t = timeToMinutes(d.visit_time);
  if (!shifts.some((x) => t >= timeToMinutes(x.start) && t + 15 <= timeToMinutes(x.end))) throw E.validation({ visit_time: 'Choose a time within the doctor\'s working hours.' });
  if (await knex('doctor_days_off').where({ business_id: clinic.id, doctor_id: doc.id, off_date: d.visit_date }).first('id')) throw E.validation({ visit_date: 'The doctor is off that day.' });
  const dup = await knex('rep_visits').where({ business_id: clinic.id, vendor_id: vendor.id, doctor_id: doc.id, visit_date: d.visit_date }).whereIn('status', ['requested', 'confirmed']).first('id');
  if (dup) throw err('REP_ALREADY_REQUESTED', 'You already have a request with this doctor on that day.', 409);
  const ids = (d.products || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
  const prods = ids.length ? await knex('vendor_products').where({ vendor_id: vendor.id, is_active: true }).whereIn('id', ids).pluck('name') : [];
  const purpose = (prods.length ? `${d.purpose}\n— ${prods.join('، ')}` : d.purpose).slice(0, 500);
  const [id] = await knex('rep_visits').insert({
    business_id: clinic.id, doctor_id: doc.id, vendor_id: vendor.id, user_id: vctx.userId, visit_date: d.visit_date, visit_time: d.visit_time,
    duration_minutes: 15, purpose, status: 'requested', flexible: true,
  });
  await audit.record({ businessId: clinic.id, userId: vctx.userId, ip: vctx.ip, userAgent: vctx.userAgent }, 'rep_visit.requested',
    { entityType: 'rep_visit', entityId: id, newValues: { vendor_id: vendor.id, doctor_id: doc.id, visit_date: d.visit_date, visit_time: d.visit_time, status: 'requested', flexible: true } });
  await tellClinic(clinic, vendor, { id, status: 'requested', doctorId: doc.id, date: d.visit_date, time: d.visit_time, purpose: d.purpose });
  return { id, status: 'requested' };
}

/** Tell the clinic (staff who manage reps, and the doctor concerned). Text is bilingual: notifications are stored once. */
async function tellClinic(clinic, vendor, { id, status, doctorId, date, time, purpose }) {
  const d = { visit_date: date, visit_time: time, purpose };
  const doc = doctorId ? clinic.doctors.find((x) => x.id === doctorId) : null;
  const title = status === 'confirmed' ? `زيارة مندوب مؤكدة · Rep visit confirmed — ${vendor.name}` : `طلب زيارة مندوب · Rep visit request — ${vendor.name}`;
  const body = `${d.visit_date} ${d.visit_time}${doc ? ` · ${doc.full_name}` : ''}`;
  await notifications.notify(clinic.id, { permission: 'vendors.manage', type: 'rep_visit.requested', title, body, link: '/app/rep-visits', dedupeKey: `repv:${id}` });
  if (doc) {
    const m = await knex('memberships').where({ business_id: clinic.id, doctor_id: doc.id, status: 'active' }).first('user_id');
    if (m) await notifications.notify(clinic.id, { userId: m.user_id, type: 'rep_visit.requested', title, body, link: '/app/rep-visits', dedupeKey: `repv:${id}:doc` });
  }
  if (clinic.email) {
    mailer.send({ to: clinic.email, subject: `${vendor.name} — ${d.visit_date} ${d.visit_time}`,
      html: mailer.layout({ locale: 'ar', title, body: `${vendor.name}: ${body}. ${d.purpose}` }) }).catch(() => {});
  }
  return { id, status };
}

const vendorVisitsQuery = (vendorId) => knex('rep_visits as r').join('businesses as b', 'b.id', 'r.business_id').leftJoin('doctors as d', function j() { this.on('d.id', 'r.doctor_id').andOn('d.business_id', 'r.business_id'); })
  .where('r.vendor_id', vendorId)
  .select('r.id', 'r.visit_date', 'r.visit_time', 'r.duration_minutes', 'r.purpose', 'r.status', 'r.clinic_note', 'r.created_at',
    'r.business_id', 'r.doctor_id', 'b.name as clinic_name', 'b.name_en as clinic_name_en', 'b.city as clinic_city', 'b.address as clinic_address', 'b.map_url as clinic_map_url', 'b.timezone',
    'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en')
  .orderBy('r.visit_date', 'desc').orderBy('r.visit_time', 'desc').limit(200);
/** The vendor's visits; a clinic's address and map link once the clinic confirmed the visit or added the vendor as a supplier. */
async function vendorVisits(vendorId) {
  const rows = await cross.fillDoctors(await vendorVisitsQuery(vendorId));
  const linked = await linkedClinics(vendorId, rows.map((r) => r.business_id));
  // The address and map: for suppliers, and for a visit the clinic confirmed (the rep has to find the clinic).
  rows.forEach((r) => {
    r.isSupplier = linked.has(Number(r.business_id));
    r.showAddress = r.isSupplier || ['confirmed', 'done'].includes(r.status);
    if (!r.showAddress) { r.clinic_address = null; r.clinic_map_url = null; }
  });
  return rows;
}

async function cancelByVendor(vctx, id) {
  const v = await knex('rep_visits').where({ id: Number(id) || 0, vendor_id: vctx.vendorId }).first();
  if (!v) throw E.notFound('Visit');
  if (!['requested', 'confirmed'].includes(v.status)) throw err('REP_VISIT_STATE', 'This visit can no longer be changed.', 409);
  await knex('rep_visits').where({ id: v.id }).update({ status: 'cancelled', updated_at: new Date() });
  await audit.record({ businessId: v.business_id, userId: vctx.userId, ip: vctx.ip, userAgent: vctx.userAgent }, 'rep_visit.cancelled_by_vendor',
    { entityType: 'rep_visit', entityId: v.id, oldValues: { status: v.status }, newValues: { status: 'cancelled' } });
  const vendor = await knex('vendors').where({ id: v.vendor_id }).first('name');
  await notifications.notify(v.business_id, { permission: 'vendors.manage', type: 'rep_visit.cancelled', title: `ألغى المندوب الزيارة · Rep cancelled — ${vendor.name}`, body: `${v.visit_date} ${v.visit_time}`, link: '/app/rep-visits?tab=past', dedupeKey: `repv:${v.id}:vcancel` });
}

// ---------------------------------------------------------------- clinic side
function clinicVisits(ctx, { tab = 'requests', today }) {
  const q = knex('rep_visits as r').join('vendors as v', 'v.id', 'r.vendor_id').leftJoin('doctors as d', 'd.id', 'r.doctor_id')
    .leftJoin('users as u', 'u.id', 'r.user_id')
    .where('r.business_id', ctx.businessId)
    .select('r.*', 'v.name as vendor_name', 'v.name_en as vendor_name_en', 'v.type as vendor_type', 'v.phone as vendor_phone', 'v.whatsapp as vendor_whatsapp', 'v.email as vendor_email',
      'u.name as rep_name', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.color as doctor_color');
  if (ctx.ownDoctorId) q.andWhere('r.doctor_id', ctx.ownDoctorId);
  if (tab === 'requests') q.andWhere('r.status', 'requested').andWhere('r.visit_date', '>=', today).orderBy('r.visit_date').orderBy('r.visit_time');
  else if (tab === 'upcoming') q.andWhere('r.status', 'confirmed').andWhere('r.visit_date', '>=', today).orderBy('r.visit_date').orderBy('r.visit_time');
  else q.andWhere((w) => w.where('r.visit_date', '<', today).orWhereIn('r.status', ['declined', 'cancelled', 'done'])).orderBy('r.visit_date', 'desc').orderBy('r.visit_time', 'desc').limit(200);
  return q;
}

async function counts(ctx, today) {
  const base = () => { const q = knex('rep_visits').where({ business_id: ctx.businessId }).andWhere('visit_date', '>=', today); if (ctx.ownDoctorId) q.andWhere('doctor_id', ctx.ownDoctorId); return q; };
  const [[{ r }], [{ u }]] = await Promise.all([base().where('status', 'requested').count({ r: 'id' }), base().where('status', 'confirmed').count({ u: 'id' })]);
  return { requests: Number(r), upcoming: Number(u) };
}

const TRANSITIONS = { confirm: [['requested'], 'confirmed'], decline: [['requested', 'confirmed'], 'declined'], done: [['confirmed'], 'done'], cancel: [['requested', 'confirmed'], 'cancelled'] };

/** Clinic decision on a visit. Allowed for vendors.manage, or the doctor the visit is with. */
async function decide(ctx, id, action, note) {
  const tr = TRANSITIONS[action];
  if (!tr) throw E.notFound('Action');
  const v = await knex('rep_visits').where({ id: Number(id) || 0, business_id: ctx.businessId }).first();
  if (!v) throw E.notFound('Visit');
  if (ctx.ownDoctorId && v.doctor_id !== ctx.ownDoctorId) throw E.notFound('Visit');
  const allowed = ctx.permissions.has('vendors.manage') || (ctx.doctorId && v.doctor_id === ctx.doctorId);
  if (!allowed) throw E.forbidden('vendors.manage');
  if (!tr[0].includes(v.status)) throw err('REP_VISIT_STATE', 'This visit can no longer be changed.', 409);
  const cleanNote = note ? String(note).trim().slice(0, 500) : null;
  const row = { status: tr[1], decided_by: ctx.userId, updated_at: new Date() };
  if (cleanNote) row.clinic_note = cleanNote;
  await knex('rep_visits').where({ id: v.id }).update(row);
  await audit.record(ctx, `rep_visit.${tr[1]}`, { entityType: 'rep_visit', entityId: v.id, oldValues: { status: v.status }, newValues: { status: tr[1], clinic_note: cleanNote } });
  if (['confirmed', 'declined', 'cancelled'].includes(tr[1])) {
    const vendor = await knex('vendors').where({ id: v.vendor_id }).first('name', 'email');
    const clinic = await knex('businesses').where({ id: ctx.businessId }).first('name');
    const words = { confirmed: 'تم تأكيد زيارتك · Your visit is confirmed', declined: 'تعذّر قبول زيارتك · Your visit was declined', cancelled: 'أُلغيت زيارتك · Your visit was cancelled' };
    // Sent from the clinic's own mailbox (its address visible) only to a vendor it added as a supplier.
    const viaClinic = (await linkedClinics(v.vendor_id, [ctx.businessId])).has(Number(ctx.businessId));
    await pnotify.vendor(v.vendor_id, `visit_${tr[1]}`, { clinic: clinic.name, date: v.visit_date, time: String(v.visit_time).slice(0, 5), note: cleanNote || '' }, { link: '/vendor/visits', severity: tr[1] === 'confirmed' ? 'success' : 'warning' });
    if (vendor && vendor.email) {
      mailer.send({ ...(viaClinic ? { businessId: ctx.businessId, kind: 'suppliers' } : {}), to: vendor.email, subject: `${clinic.name} — ${v.visit_date} ${v.visit_time}`,
        html: mailer.layout({ locale: 'ar', title: words[tr[1]], body: `${clinic.name} · ${v.visit_date} ${v.visit_time}${cleanNote ? ` — ${cleanNote}` : ''}` }) }).catch(() => {});
    }
  }
  return tr[1];
}

module.exports = {
  LIVE, STATUSES, MAX_DAYS_AHEAD, computeRepSlots, settings, saveSettings, windows, saveWindow, removeWindow, bookableClinics, clinicForRep, freeSlots, openToReps, linkedClinics,
  book, vendorVisits, cancelByVendor, clinicVisits, counts, decide, addDays,
};
