// Rep visits: a clinic reserves weekly windows for medical reps (clinic-wide or per doctor); active vendors book a
// slot in those windows. The clinic confirms / declines / marks done / cancels.
//   • a doctor's visit can use that doctor's own windows and the clinic-wide ones; a clinic-wide visit (no doctor)
//     only the clinic-wide windows
//   • a slot is free when no other live visit (requested / confirmed / done) of the same doctor (or of the clinic when
//     no doctor) overlaps it, the doctor is not off that day, and the time has not passed (clinic time zone)
//   • booking holds a MySQL named lock for clinic+doctor+date+time and re-checks the slot — no double booking
// Patients and patient appointments are never read here: reps only see the rep windows' availability.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const { AppError, E } = require('../../core/errors');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');
const scheduling = require('../clinic/scheduling');
const notifications = require('../notifications/notification.service');

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
  return knex('businesses').where({ id: businessId }).first('id', 'rep_visits_enabled', 'rep_visits_auto_confirm');
}

async function saveSettings(ctx, input) {
  const on = (v) => v === '1' || v === 'on' || v === true;
  const before = await settings(ctx.businessId);
  const row = { rep_visits_enabled: on(input.rep_visits_enabled), rep_visits_auto_confirm: on(input.rep_visits_auto_confirm) };
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
/** Clinics a rep can book: rep visits enabled, clinic active, at least one active window. */
async function bookableClinics({ q, specialty } = {}) {
  const query = knex('businesses as b').where({ 'b.rep_visits_enabled': true, 'b.status': 'active' })
    .whereExists(function e() { this.select(knex.raw('1')).from('rep_visit_slots as w').whereRaw('w.business_id = b.id').andWhere('w.is_active', true); })
    .select('b.id', 'b.name', 'b.name_en', 'b.city', 'b.specialty').orderBy('b.name').limit(60);
  if (q && String(q).trim()) {
    const s = `%${String(q).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    query.andWhere((w) => w.where('b.name', 'like', s).orWhere('b.name_en', 'like', s).orWhere('b.city', 'like', s));
  }
  if (specialty) query.andWhere('b.specialty', specialty);
  const rows = await query;
  if (!rows.length) return rows;
  const docs = await bookableDoctors(rows.map((r) => r.id));
  rows.forEach((r) => { r.doctors = docs.filter((d) => d.business_id === r.id); });
  return rows;
}

/** Active doctors a rep can book at these clinics (own windows, or any doctor when the clinic has clinic-wide windows). */
async function bookableDoctors(businessIds) {
  const wins = await knex('rep_visit_slots').whereIn('business_id', businessIds).andWhere('is_active', true).select('business_id', 'doctor_id');
  const wide = new Set(wins.filter((w) => !w.doctor_id).map((w) => w.business_id));
  const own = new Set(wins.filter((w) => w.doctor_id).map((w) => w.doctor_id));
  const docs = await knex('doctors').whereIn('business_id', businessIds).andWhere('is_active', true)
    .select('id', 'business_id', 'full_name', 'full_name_en', 'specialization', 'specialization_en').orderBy('sort_order').orderBy('id');
  return docs.filter((d) => wide.has(d.business_id) || own.has(d.id));
}

/** A bookable clinic (only what a rep may see) or null. */
async function clinicForRep(businessId) {
  const b = await knex('businesses').where({ id: Number(businessId) || 0, rep_visits_enabled: true, status: 'active' })
    .first('id', 'name', 'name_en', 'city', 'specialty', 'address', 'map_url', 'timezone', 'rep_visits_auto_confirm', 'email');
  if (!b) return null;
  b.doctors = await bookableDoctors([b.id]);
  b.hasClinicWide = Boolean(await knex('rep_visit_slots').where({ business_id: b.id, is_active: true }).whereNull('doctor_id').first('id'));
  return b;
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
  const id = await knex.transaction(async (trx) => {
    const [[{ got }]] = await trx.raw('SELECT GET_LOCK(?, 10) AS got', [name]);
    if (Number(got) !== 1) throw new AppError('SLOT_BUSY', 'The system is busy — please try again.', 409);
    try {
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
    } finally {
      await trx.raw('SELECT RELEASE_LOCK(?)', [name]);
    }
  });

  // Tell the clinic (staff who manage reps, and the doctor concerned). Text is bilingual: notifications are stored once.
  const doc = d.doctor_id ? clinic.doctors.find((x) => x.id === d.doctor_id) : null;
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

const vendorVisits = (vendorId) => knex('rep_visits as r').join('businesses as b', 'b.id', 'r.business_id').leftJoin('doctors as d', 'd.id', 'r.doctor_id')
  .where('r.vendor_id', vendorId)
  .select('r.id', 'r.visit_date', 'r.visit_time', 'r.duration_minutes', 'r.purpose', 'r.status', 'r.clinic_note', 'r.created_at',
    'b.name as clinic_name', 'b.name_en as clinic_name_en', 'b.city as clinic_city', 'b.address as clinic_address', 'b.map_url as clinic_map_url', 'b.timezone',
    'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en')
  .orderBy('r.visit_date', 'desc').orderBy('r.visit_time', 'desc').limit(200);

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
    if (vendor && vendor.email) {
      mailer.send({ businessId: ctx.businessId, kind: 'suppliers', to: vendor.email, subject: `${clinic.name} — ${v.visit_date} ${v.visit_time}`,
        html: mailer.layout({ locale: 'ar', title: words[tr[1]], body: `${clinic.name} · ${v.visit_date} ${v.visit_time}${cleanNote ? ` — ${cleanNote}` : ''}` }) }).catch(() => {});
    }
  }
  return tr[1];
}

module.exports = {
  LIVE, STATUSES, MAX_DAYS_AHEAD, computeRepSlots, settings, saveSettings, windows, saveWindow, removeWindow, bookableClinics, clinicForRep, freeSlots,
  book, vendorVisits, cancelByVendor, clinicVisits, counts, decide, addDays,
};
