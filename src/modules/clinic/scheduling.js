// ============================================================================
// Availability engine — ported from DocBook's server/scheduling.ts.
// One engine serves staff booking, public online booking, time blocks and follow-ups:
//   • a doctor's working hours per weekday: one or more shifts plus breaks
//   • doctor days off
//   • appointment length = custom duration › service duration › doctor slot length
//   • candidate slots step by the doctor's slot length; a slot is free when it does not overlap a break
//     or any non-cancelled appointment (real interval overlap, using each booking's own length)
//   • dates before "today in the clinic's time zone" are refused; today's past times are skipped
// The pure functions are unit-tested (test/scheduling.test.js); availableSlots() adds the database reads.
// ============================================================================
const knex = require('../../db/knex');
const lock = require('../../db/lock');
const { AppError, E } = require('../../core/errors');

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MIN_BLOCK_MINUTES = 5;
const MAX_BLOCK_MINUTES = 480;

const timeToMinutes = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const minutesToTime = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;
const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

/** Accepts DocBook's day shapes: { enabled, shifts:[…], breaks:[…] } or the older { start, end }. */
function normalizeDayConfig(raw) {
  if (!raw || raw.enabled === false) return { enabled: false, shifts: [], breaks: [] };
  const shifts = Array.isArray(raw.shifts) && raw.shifts.length
    ? raw.shifts.filter((s) => s && isTime(s.start) && isTime(s.end) && timeToMinutes(s.end) > timeToMinutes(s.start))
    : (isTime(raw.start) && isTime(raw.end) ? [{ start: raw.start, end: raw.end }] : []);
  const breaks = Array.isArray(raw.breaks) ? raw.breaks.filter((b) => b && isTime(b.start) && isTime(b.end)) : [];
  return { enabled: shifts.length > 0, shifts, breaks };
}

/** Weekday key of a YYYY-MM-DD date (calendar arithmetic, independent of the server's time zone). */
const dayKeyOf = (date) => DAY_KEYS[new Date(`${date}T00:00:00Z`).getUTCDay()];

/** Today's date and minutes-since-midnight in the clinic's time zone. */
function clinicNow(timezone, at = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: hour * 60 + Number(p.minute) };
}

/**
 * Pure slot computation.
 * @param {object} o
 *   workingHours  doctor.working_hours object
 *   slotStep      doctor slot length (minutes) — the step between candidate start times
 *   duration      length of the appointment being booked (minutes)
 *   date          'YYYY-MM-DD'
 *   dayOff        true when the doctor is off that date
 *   booked        [{ time: 'HH:MM', duration }] non-cancelled appointments/blocks of that doctor on that date
 *   today, nowMinutes   the clinic's current date and time
 */
function computeSlots({ workingHours, slotStep = 30, duration = 30, date, dayOff = false, booked = [], today, nowMinutes = 0 }) {
  if (!isDate(date)) throw new AppError('INVALID_DATE', 'Invalid date.', 422);
  if (today && date < today) throw new AppError('DATE_IN_PAST', 'This date has passed.', 422);
  if (dayOff) return [];
  const day = normalizeDayConfig(workingHours ? workingHours[dayKeyOf(date)] : null);
  if (!day.enabled) return [];
  const step = Math.max(5, Number(slotStep) || 30);
  const len = Math.max(5, Number(duration) || step);
  const blocking = booked.map((b) => { const s = timeToMinutes(b.time); return { start: s, end: s + (Number(b.duration) || step) }; });
  const out = [];
  for (const shift of day.shifts) {
    const shiftEnd = timeToMinutes(shift.end);
    for (let start = timeToMinutes(shift.start); start + len <= shiftEnd; start += step) {
      const end = start + len;
      if (day.breaks.some((b) => overlaps(start, end, timeToMinutes(b.start), timeToMinutes(b.end)))) continue; // eslint-disable-line no-continue
      if (blocking.some((b) => overlaps(start, end, b.start, b.end))) continue; // eslint-disable-line no-continue
      if (date === today && start <= nowMinutes) continue; // eslint-disable-line no-continue
      out.push(minutesToTime(start));
    }
  }
  return [...new Set(out)].sort();
}

// ---------------------------------------------------------------- database-backed
async function appointmentLength(trx, businessId, doctor, serviceId, override) {
  if (override && !serviceId) {
    const d = Number(override);
    if (!Number.isInteger(d) || d < MIN_BLOCK_MINUTES || d > MAX_BLOCK_MINUTES) throw E.validation({ duration_minutes: 'Enter a valid duration.' });
    return d;
  }
  if (serviceId) {
    const svc = await trx('services').where({ id: serviceId, business_id: businessId, is_active: true }).first('id', 'doctor_id', 'duration_minutes');
    if (!svc) throw E.validation({ service_id: 'Choose a valid value.' });
    if (svc.doctor_id && svc.doctor_id !== doctor.id) throw new AppError('SERVICE_NOT_FOR_DOCTOR', 'This service is not offered by this doctor.', 422, { service_id: 'This service is not offered by this doctor.' });
    return svc.duration_minutes || doctor.slot_duration_minutes || 30;
  }
  return doctor.slot_duration_minutes || 30;
}

/**
 * Free start times for a doctor on a date.
 * @param {{ businessId, timezone, doctorId, date, serviceId?, durationOverride?, excludeAppointmentId?, workingHours?, slotStep? }} req
 */
async function availableSlots(req, trx = knex) {
  const doctor = await trx('doctors').where({ id: req.doctorId, business_id: req.businessId, is_active: true }).first('id', 'working_hours', 'slot_duration_minutes');
  if (!doctor) throw E.validation({ doctor_id: 'Choose a valid value.' });
  const duration = await appointmentLength(trx, req.businessId, doctor, req.serviceId, req.durationOverride);
  const { date: today, minutes: nowMinutes } = clinicNow(req.timezone);
  const off = await trx('doctor_days_off').where({ business_id: req.businessId, doctor_id: doctor.id, off_date: req.date }).first('id');
  const q = trx('appointments as a').leftJoin('services as s', 's.id', 'a.service_id')
    .where({ 'a.doctor_id': doctor.id, 'a.appointment_date': req.date }).whereNot('a.status', 'cancelled')
    .select('a.appointment_time as time', trx.raw('COALESCE(a.duration_minutes, s.duration_minutes, ?) as duration', [doctor.slot_duration_minutes || 30]));
  if (req.excludeAppointmentId) q.whereNot('a.id', req.excludeAppointmentId);
  const booked = await q;
  const wh = typeof doctor.working_hours === 'string' ? JSON.parse(doctor.working_hours) : doctor.working_hours;
  // Online consultations pass their own weekly windows and step (req.workingHours / req.slotStep); every
  // appointment of the doctor — in the clinic or online — still blocks, so the two can never overlap.
  return computeSlots({ workingHours: req.workingHours || wh, slotStep: req.slotStep || doctor.slot_duration_minutes, duration, date: req.date, dayOff: Boolean(off), booked, today, nowMinutes });
}

/**
 * Runs `fn(trx)` while holding a MySQL named lock for the doctor+date+time, after re-checking the slot is
 * still free — so two people confirming the same slot at the same instant can never both succeed.
 */
async function withSlot(req, fn) {
  const name = `appt_${req.businessId}_${req.doctorId}_${req.date}_${req.time}`.slice(0, 64);
  // the lock outlives the transaction: the next request for this slot reads only after this one has committed
  return lock.withLock(name, () => knex.transaction(async (trx) => {
    const slots = await availableSlots(req, trx);
    if (!slots.includes(req.time)) throw new AppError('SLOT_TAKEN', 'This time is no longer available. Choose another time.', 409, { appointment_time: 'This time is no longer available.' });
    return fn(trx);
  }));
}

/** Default week: Sat–Thu 09:00–17:00, Friday off, no break (a break is added only when the clinic or doctor chooses one). */
function defaultWorkingHours() {
  const day = { enabled: true, shifts: [{ start: '09:00', end: '17:00' }], breaks: [] };
  return Object.fromEntries(DAY_KEYS.map((k) => [k, k === 'fri' ? { enabled: false, shifts: [], breaks: [] } : structuredClone(day)]));
}

/**
 * Parses the working-hours editor form (wh[<day>][enabled|s1|e1|extra|s2|e2|break|bs|be]) into DocBook's shape. The second
 * period and the break count only when their own box is ticked (extra / break), so an empty or leftover time never
 * blocks a booking. Older forms without those boxes keep their meaning.
 */
function parseWorkingHoursForm(body) {
  const src = body.wh || {};
  const on = (d, k) => (d[k] === undefined ? undefined : [].concat(d[k]).pop() === '1');
  return Object.fromEntries(DAY_KEYS.map((k) => {
    const d = src[k] || {};
    const extra = on(d, 'extra'); const brk = on(d, 'break');
    const pairs = extra === false ? [[d.s1, d.e1]] : [[d.s1, d.e1], [d.s2, d.e2]];
    const shifts = pairs.filter(([s, e]) => isTime(s) && isTime(e) && timeToMinutes(e) > timeToMinutes(s)).map(([start, end]) => ({ start, end }));
    const breaks = brk !== false && isTime(d.bs) && isTime(d.be) && timeToMinutes(d.be) > timeToMinutes(d.bs) ? [{ start: d.bs, end: d.be }] : [];
    return [k, { enabled: d.enabled === '1' && shifts.length > 0, shifts, breaks }];
  }));
}

module.exports = {
  DAY_KEYS, MIN_BLOCK_MINUTES, MAX_BLOCK_MINUTES, timeToMinutes, minutesToTime, overlaps, isTime, isDate, normalizeDayConfig, dayKeyOf, clinicNow,
  computeSlots, availableSlots, withSlot, appointmentLength, defaultWorkingHours, parseWorkingHoursForm,
};
