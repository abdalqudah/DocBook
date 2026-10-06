// Availability engine: free slots for an appointment type from each counsellor's weekly hours (in their branch's
// time zone), minus time off, minus existing appointments (with the buffer), honouring minimum notice and how far
// ahead people may book. Booking re-checks the slot under a per-employee database lock, so two people can never
// take the same time.
const knex = require('../../db/knex');
const fmt = require('../../core/format');
const { E } = require('../../core/errors');

const STEP_MIN = 15;
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

async function eligibleEmployees(type, employeeId = null) {
  const q = knex('appointment_type_staff as ts').join('employees as e', 'e.id', 'ts.employee_id').join('users as u', 'u.id', 'e.user_id')
    .leftJoin('branches as b', 'b.id', 'e.branch_id').where('ts.type_id', type.id).where('u.status', 'active')
    .select('e.id', 'u.name', 'e.branch_id', 'e.photo', 'e.job_title', knex.raw("COALESCE(b.timezone, 'UTC') AS tz"));
  if (employeeId) q.where('e.id', employeeId);
  return q;
}

/** Busy intervals (UTC ms) for employees between two instants, including each appointment's type buffer. */
async function busy(employeeIds, from, to) {
  if (!employeeIds.length) return new Map();
  const rows = await knex('appointments as a').join('appointment_types as t', 't.id', 'a.type_id').whereIn('a.employee_id', employeeIds)
    .whereNotIn('a.status', ['cancelled', 'rescheduled']).where('a.start_at', '<', to).where('a.end_at', '>', new Date(from.getTime() - 3 * 3600_000))
    .select('a.employee_id', 'a.start_at', 'a.end_at', 't.buffer_min');
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.employee_id)) map.set(r.employee_id, []);
    map.get(r.employee_id).push([new Date(r.start_at).getTime(), new Date(r.end_at).getTime() + (r.buffer_min || 0) * 60000]);
  });
  return map;
}

/**
 * Free slots: [{ start: Date, end: Date, employeeId, employeeName }] for `days` days from `fromDate` (YYYY-MM-DD).
 * With employeeId, only that counsellor; otherwise any eligible counsellor (one entry per start time, the least
 * busy counsellor first). `staff: true` ignores minimum notice and the public booking window.
 */
async function slots(typeId, { fromDate, days = 7, employeeId = null, now = new Date(), staff: staffView = false } = {}) {
  const type = await knex('appointment_types').where({ id: typeId, is_active: true }).first();
  if (!type) throw E.notFound('Appointment type');
  const staff = await eligibleEmployees(type, employeeId);
  if (!staff.length) return { type, slots: [], staff: [] };
  // Staff may book inside the notice period and beyond the public booking window.
  const earliest = staffView ? now : new Date(now.getTime() + type.min_notice_hours * 3600_000);
  const latest = staffView ? new Date(now.getTime() + 3 * 365 * 86400_000) : new Date(now.getTime() + type.max_days_ahead * 86400_000);
  const startDay = fromDate && /^\d{4}-\d{2}-\d{2}$/.test(fromDate) ? fromDate : fmt.zonedDate(now, staff[0].tz);
  const ids = staff.map((s) => s.id);
  const rangeFrom = fmt.zonedToUtc(`${startDay}T00:00`, 'UTC');
  const rangeTo = new Date(rangeFrom.getTime() + (days + 1) * 86400_000);
  const [hours, exceptions, booked] = await Promise.all([
    knex('availability').whereIn('employee_id', ids),
    knex('availability_exceptions').whereIn('employee_id', ids).whereBetween('date', [startDay, fmt.toDateInput(rangeTo)]),
    busy(ids, rangeFrom, rangeTo),
  ]);
  const step = type.duration_min >= 30 ? 30 : STEP_MIN;
  const load = new Map(ids.map((id) => [id, (booked.get(id) || []).length]));
  const out = new Map(); // start ms → slot
  for (let d = 0; d < days; d += 1) {
    const day = fmt.toDateInput(new Date(rangeFrom.getTime() + d * 86400_000));
    for (const s of staff) {
      const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
      const exc = exceptions.find((x) => x.employee_id === s.id && fmt.toDateInput(x.date) === day);
      let windows = hours.filter((h) => h.employee_id === s.id && h.weekday === weekday).map((h) => [toMin(h.start_time), toMin(h.end_time)]);
      if (exc) windows = exc.is_off ? [] : [[toMin(exc.start_time || '00:00'), toMin(exc.end_time || '00:00')]];
      for (const [wStart, wEnd] of windows) {
        for (let m = wStart; m + type.duration_min <= wEnd; m += step) {
          const local = `${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
          const start = fmt.zonedToUtc(local, s.tz);
          const end = new Date(start.getTime() + type.duration_min * 60000);
          if (start < earliest || start > latest) continue; // eslint-disable-line no-continue
          const blockEnd = end.getTime() + type.buffer_min * 60000;
          const clash = (booked.get(s.id) || []).some(([bs, be]) => start.getTime() < be && blockEnd > bs);
          if (clash) continue; // eslint-disable-line no-continue
          const key = start.getTime();
          const prev = out.get(key);
          if (!prev || load.get(s.id) < load.get(prev.employeeId)) out.set(key, { start, end, employeeId: s.id, employeeName: s.name, tz: s.tz });
        }
      }
    }
  }
  return { type, staff, slots: [...out.values()].sort((a, b) => a.start - b.start) };
}

/** Throws unless `employeeId` is free for [start, start + duration + buffer] (call inside the lock). */
async function assertFree(trx, type, employeeId, start, { ignoreId = null } = {}) {
  const end = new Date(start.getTime() + type.duration_min * 60000);
  const blockEnd = new Date(end.getTime() + type.buffer_min * 60000);
  const clash = await trx('appointments as a').join('appointment_types as t', 't.id', 'a.type_id').where('a.employee_id', employeeId)
    .whereNotIn('a.status', ['cancelled', 'rescheduled']).modify((q) => { if (ignoreId) q.whereNot('a.id', ignoreId); })
    .where('a.start_at', '<', blockEnd).whereRaw('DATE_ADD(a.end_at, INTERVAL t.buffer_min MINUTE) > ?', [start]).first('a.id');
  if (clash) throw E.conflict('SLOT_TAKEN', 'This time was just booked. Please choose another time.');
  return end;
}

/** Runs `fn(trx)` holding a MySQL named lock for the employee's calendar. */
async function withCalendarLock(employeeId, fn) {
  return knex.transaction(async (trx) => {
    const [[{ got }]] = await trx.raw('SELECT GET_LOCK(?, 10) AS got', [`gec_cal_${employeeId}`]);
    if (got !== 1) throw E.conflict('SLOT_BUSY', 'The calendar is busy. Please try again.');
    try { return await fn(trx); } finally { await trx.raw('SELECT RELEASE_LOCK(?)', [`gec_cal_${employeeId}`]); }
  });
}

/** A minimal iCalendar file for "add to calendar". */
function ics({ uid, start, end, title, description = '', location = '', url = '' }) {
  const d = (x) => new Date(x).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escTxt = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GEC//Appointments//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${uid}`, `DTSTAMP:${d(new Date())}`, `DTSTART:${d(start)}`, `DTEND:${d(end)}`, `SUMMARY:${escTxt(title)}`, `DESCRIPTION:${escTxt(description)}`,
    location ? `LOCATION:${escTxt(location)}` : null, url ? `URL:${url}` : null, 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
}

module.exports = { slots, assertFree, withCalendarLock, eligibleEmployees, ics, STEP_MIN };
