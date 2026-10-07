// Staff attendance for clinics: doctors, nurses, receptionists and accountants clock in and out.
//
// QR attendance screen: a tablet at reception shows a QR code that changes every 10 seconds. The code is a
// short-lived token "<clinicId>.<step>.<signature>" where step = the current 10-second window and signature =
// HMAC-SHA256 of the clinic and step with a key derived from the server secret — it cannot be guessed, is bound
// to one clinic and expires by itself. Any number of staff can scan the same code; a scanned code is accepted
// for its own window and the two before it (up to 30 seconds) so a slow phone camera still gets through.
// After a valid scan the phone gets a short ticket in its session (3 minutes) to tap "Clock in" / "Clock out".
//
// Records: one row per shift (clock_in → clock_out), server time, with the IP and browser of each tap. A person
// may have several shifts a day (morning + evening clinics). The toggle looks at the open shift (no clock-out,
// started within the last 16 hours).
// Working hours ("the plan") decide late / absent / overtime, computed when read (so a corrected record or a
// changed plan is reflected everywhere): the person's own hours (attendance_schedules) → a linked doctor's
// working hours and days off → the clinic's default hours (attendance_settings) → no plan (only what was recorded).
const crypto = require('crypto');
const QRCode = require('qrcode');
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { clinicNow } = require('../clinic/scheduling');

const STEP_MS = 10_000;
const GRACE_STEPS = 2; // a scanned code is accepted for up to 30 seconds
const TICKET_MS = 3 * 60_000; // time to tap the button (or sign in) after a valid scan
const OPEN_SHIFT_MS = 16 * 3600_000; // an open shift older than this is a forgotten clock-out
const MAX_SHIFT_MINUTES = 24 * 60;

const stepOf = (now = Date.now()) => Math.floor(now / STEP_MS);
const qrKey = () => crypto.createHmac('sha256', config.sessionSecret).update('docbook:attendance-qr:v1').digest();
const sign = (businessId, step) => crypto.createHmac('sha256', qrKey()).update(`${Number(businessId)}:${Number(step)}`).digest('hex').slice(0, 20);

/** The token shown in the QR code right now. */
function issueToken(businessId, now = Date.now()) {
  const step = stepOf(now);
  return { token: `${Number(businessId)}.${step}.${sign(businessId, step)}`, step, expiresIn: Math.max(1, Math.ceil(((step + 1) * STEP_MS - now) / 1000)) };
}

/** Checks a scanned token. Returns { businessId, step } or throws QR_INVALID / QR_EXPIRED. */
function verifyToken(raw, now = Date.now()) {
  const m = /^(\d{1,10})\.(\d{1,15})\.([a-f0-9]{20})$/.exec(String(raw || '').trim());
  if (!m) throw new AppError('QR_INVALID', 'This QR code is not valid. Scan the code on the attendance screen.', 400);
  const businessId = Number(m[1]);
  const step = Number(m[2]);
  const expected = sign(businessId, step);
  if (!crypto.timingSafeEqual(Buffer.from(m[3]), Buffer.from(expected))) throw new AppError('QR_INVALID', 'This QR code is not valid. Scan the code on the attendance screen.', 400);
  const current = stepOf(now);
  if (step > current || current - step > GRACE_STEPS) throw new AppError('QR_EXPIRED', 'This code has changed. Scan the code currently on the screen.', 410);
  return { businessId, step };
}

/** The QR code (SVG, colours from the page) and its link for the attendance screen. base = the site's real address. */
async function currentQr(businessId, base, now = Date.now()) {
  const { token, expiresIn } = issueToken(businessId, now);
  const url = `${String(base).replace(/\/+$/, '')}/app/attendance/scan?t=${token}`;
  const raw = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  // Drop the library's fixed colours: the page paints the modules with its own theme tokens.
  const svg = raw.replace(/<path[^>]*fill="#[0-9a-f]{6,8}"[^>]*\/>/i, '').replace(/stroke="#[0-9a-f]{6,8}"/i, 'stroke="currentColor"')
    .replace('<svg ', `<svg role="img" aria-label="QR" `);
  return { svg, url, expiresIn, stepSeconds: STEP_MS / 1000 };
}

// ---------------------------------------------------------------- time helpers (clinic time zone)
function partsIn(tz, d) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, sec: Number(p.second) };
}
const localDate = (tz, d) => (d ? partsIn(tz, new Date(d)).date : null);
const localTime = (tz, d) => (d ? partsIn(tz, new Date(d)).time : null);

/** Clinic-local date + 'HH:MM' → the UTC instant. */
function zonedToUtc(date, time, tz) {
  const [y, mo, da] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wanted = Date.UTC(y, mo - 1, da, h, mi);
  let guess = wanted;
  for (let i = 0; i < 2; i += 1) {
    const p = partsIn(tz, new Date(guess));
    const [py, pmo, pda] = p.date.split('-').map(Number);
    const [ph, pmi] = p.time.split(':').map(Number);
    guess += wanted - Date.UTC(py, pmo - 1, pda, ph, pmi, p.sec);
  }
  return new Date(guess);
}

const minutesOf = (r) => (r.clock_in && r.clock_out ? Math.max(0, Math.round((new Date(r.clock_out) - new Date(r.clock_in)) / 60000)) : 0);
const monthBounds = (month) => {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, '0')}`];
};

// ---------------------------------------------------------------- settings
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEK_ORDER = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const span = (start, end) => { const a = toMin(start); let b = toMin(end); if (b <= a) b += 1440; return b - a; };
const dayKey = (date) => DAY_KEYS[new Date(`${date}T00:00:00Z`).getUTCDay()];

async function settings(businessId) {
  const row = await knex('attendance_settings').where({ business_id: businessId }).first();
  const workDays = row && row.work_days ? String(row.work_days).split(',').filter((d) => DAY_KEYS.includes(d)) : [];
  const hasPlan = Boolean(row && row.work_start && row.work_end && workDays.length);
  return {
    qrOnly: Boolean(row && row.qr_only),
    sameNetwork: Boolean(row && row.same_network),
    workDays,
    workStart: row && row.work_start ? row.work_start : null,
    workEnd: row && row.work_end ? row.work_end : null,
    grace: row && row.late_grace_minutes !== undefined && row.late_grace_minutes !== null ? Number(row.late_grace_minutes) : 15,
    planSince: row && row.plan_since ? (typeof row.plan_since === 'string' ? row.plan_since.slice(0, 10) : localDate('UTC', row.plan_since)) : null,
    hasPlan,
  };
}

/**
 * Saves the clinic's attendance rules. Only the keys given change:
 *   qrOnly, sameNetwork (booleans); workDays (['sat',…]), workStart / workEnd ('HH:MM', both empty = no plan), grace (0–120 min).
 */
async function saveSettings(ctx, input = {}) {
  const before = await settings(ctx.businessId);
  const patch = {};
  const errors = {};
  if ('qrOnly' in input) patch.qr_only = Boolean(input.qrOnly);
  if ('sameNetwork' in input) patch.same_network = Boolean(input.sameNetwork);
  if ('workStart' in input || 'workEnd' in input || 'workDays' in input) {
    const start = String(input.workStart || '').trim();
    const end = String(input.workEnd || '').trim();
    const days = [...new Set([].concat(input.workDays || []).map(String))].filter((d) => DAY_KEYS.includes(d));
    if (start || end) {
      if (!TIME.test(start)) errors.work_start = 'Enter a valid time.';
      if (!TIME.test(end)) errors.work_end = 'Enter a valid time.';
      if (!errors.work_start && !errors.work_end && start === end) errors.work_end = 'Enter a valid time.';
      if (!days.length) errors.work_days = 'Required.';
    }
    patch.work_start = start || null;
    patch.work_end = end || null;
    patch.work_days = start && end ? WEEK_ORDER.filter((d) => days.includes(d)).join(',') : null;
    // Absences count from the day the clinic starts tracking hours, never backwards.
    if (start && end && !before.hasPlan) patch.plan_since = clinicNow(ctx.timezone || 'UTC').date;
    if (!(start && end)) patch.plan_since = null;
  }
  if ('grace' in input) {
    const g = Number(input.grace);
    if (!Number.isInteger(g) || g < 0 || g > 120) errors.late_grace_minutes = 'Enter a valid number.';
    else patch.late_grace_minutes = g;
  }
  if (Object.keys(errors).length) throw E.validation(errors);
  const exists = await knex('attendance_settings').where({ business_id: ctx.businessId }).first('business_id');
  if (exists) await knex('attendance_settings').where({ business_id: ctx.businessId }).update({ ...patch, updated_by: ctx.userId, updated_at: new Date() });
  else await knex('attendance_settings').insert({ business_id: ctx.businessId, ...patch, updated_by: ctx.userId });
  const after = await settings(ctx.businessId);
  const pick = (x) => ({ qr_only: x.qrOnly, same_network: x.sameNetwork, work_days: x.workDays.join(','), work_start: x.workStart, work_end: x.workEnd, late_grace_minutes: x.grace });
  const d = audit.diff(pick(before), pick(after));
  if (d.changed) await audit.record(ctx, 'attendance.settings_updated', { entityType: 'attendance_settings', entityId: ctx.businessId, oldValues: d.oldValues, newValues: d.newValues });
  return after;
}

// ---------------------------------------------------------------- personal working hours
const parseDays = (v) => { try { const o = typeof v === 'string' ? JSON.parse(v) : v; return o && typeof o === 'object' ? o : {}; } catch { return {}; } };

async function schedules(businessId) {
  const rows = await knex('attendance_schedules').where({ business_id: businessId });
  return new Map(rows.map((r) => [r.user_id, parseDays(r.days)]));
}

/** input: { days: ['sat',…], start, end } (same hours on the chosen days) or { <day>_start, <day>_end } per day. */
async function saveSchedule(ctx, userId, input = {}) {
  const member = await knex('memberships').where({ business_id: ctx.businessId, user_id: Number(userId) }).first('id');
  if (!member) throw E.notFound('Staff member');
  const errors = {};
  const days = {};
  const chosen = [].concat(input.days || []).map(String).filter((d) => DAY_KEYS.includes(d));
  for (const d of chosen) {
    const start = String(input[`${d}_start`] || input.start || '').trim();
    const end = String(input[`${d}_end`] || input.end || '').trim();
    if (!TIME.test(start)) errors[`${d}_start`] = 'Enter a valid time.';
    else if (!TIME.test(end) || start === end) errors[`${d}_end`] = 'Enter a valid time.';
    else days[d] = { start, end };
  }
  if (!chosen.length) errors.days = 'Required.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const before = await knex('attendance_schedules').where({ business_id: ctx.businessId, user_id: Number(userId) }).first();
  const json = JSON.stringify(days);
  if (before) await knex('attendance_schedules').where({ id: before.id }).update({ days: json, updated_by: ctx.userId, updated_at: new Date() });
  else await knex('attendance_schedules').insert({ business_id: ctx.businessId, user_id: Number(userId), days: json, updated_by: ctx.userId });
  await audit.record(ctx, 'attendance.schedule_saved', { entityType: 'attendance_schedule', entityId: Number(userId), oldValues: before ? { days: parseDays(before.days) } : undefined, newValues: { user_id: Number(userId), days } });
}

async function removeSchedule(ctx, userId) {
  const before = await knex('attendance_schedules').where({ business_id: ctx.businessId, user_id: Number(userId) }).first();
  if (!before) return;
  await knex('attendance_schedules').where({ id: before.id }).del();
  await audit.record(ctx, 'attendance.schedule_removed', { entityType: 'attendance_schedule', entityId: Number(userId), oldValues: { days: parseDays(before.days) } });
}

/**
 * Loads everything needed to know each person's planned hours between two dates and returns
 * planFor(userId, date) → { start, end, minutes, source } | 'off' | null (no plan).
 */
async function planner(businessId, from, to) {
  const [set, own, links, first, biz] = await Promise.all([
    settings(businessId), schedules(businessId),
    knex('memberships as m').leftJoin('doctors as d', function onD() { this.on('d.id', 'm.doctor_id').andOn('d.business_id', 'm.business_id'); })
      .where('m.business_id', businessId).select('m.user_id', 'm.doctor_id', 'm.created_at', 'd.working_hours'),
    knex('attendance_records').where({ business_id: businessId }).min({ d: 'work_date' }).first(),
    knex('businesses').where({ id: businessId }).first('timezone'),
  ]);
  const tz = (biz && biz.timezone) || 'UTC';
  const firstRecord = first && first.d ? (typeof first.d === 'string' ? first.d.slice(0, 10) : localDate('UTC', first.d)) : null;
  // Tracking starts when the clinic set its hours (or, without clinic hours, at its first attendance record).
  const clinicSince = set.planSince || firstRecord || clinicNow(tz).date;
  const joined = new Map(links.map((l) => [l.user_id, l.created_at ? localDate(tz, l.created_at) : null]));
  /** First day on which a missing clock-in can count as an absence for this person. */
  const sinceFor = (userId) => { const j = joined.get(userId); return j && j > clinicSince ? j : clinicSince; };
  const doctorOf = new Map(links.filter((l) => l.doctor_id && l.working_hours).map((l) => [l.user_id, { id: l.doctor_id, wh: parseDays(l.working_hours) }]));
  const offRows = doctorOf.size ? await knex('doctor_days_off').where({ business_id: businessId }).whereBetween('off_date', [from, to]).select('doctor_id', 'off_date') : [];
  const daysOff = new Set(offRows.map((r) => `${r.doctor_id}:${typeof r.off_date === 'string' ? r.off_date : localDate('UTC', r.off_date)}`));
  function planFor(userId, date) {
    const k = dayKey(date);
    if (own.has(userId)) {
      const d = own.get(userId)[k];
      return d && TIME.test(d.start) && TIME.test(d.end) ? { start: d.start, end: d.end, minutes: span(d.start, d.end), source: 'own' } : 'off';
    }
    if (doctorOf.has(userId)) {
      const doc = doctorOf.get(userId);
      if (daysOff.has(`${doc.id}:${date}`)) return 'off';
      const d = doc.wh[k];
      const shifts = d && d.enabled && Array.isArray(d.shifts) ? d.shifts.filter((x) => TIME.test(x.start) && TIME.test(x.end)) : [];
      if (!shifts.length) return 'off';
      const start = shifts.map((x) => x.start).sort()[0];
      const end = shifts.map((x) => x.end).sort().slice(-1)[0];
      const breaks = Array.isArray(d.breaks) ? d.breaks.filter((x) => TIME.test(x.start) && TIME.test(x.end)).reduce((s, x) => s + span(x.start, x.end), 0) : 0;
      return { start, end, minutes: Math.max(0, shifts.reduce((s, x) => s + span(x.start, x.end), 0) - breaks), source: 'doctor' };
    }
    if (set.hasPlan) return set.workDays.includes(k) ? { start: set.workStart, end: set.workEnd, minutes: span(set.workStart, set.workEnd), source: 'clinic' } : 'off';
    return null;
  }
  return { planFor, sinceFor, settings: set };
}

/**
 * Status of one person on one day from the plan and the day's shifts.
 * present | late | absent | not_yet | off | no_record (no plan and nothing recorded) — plus minutes late / overtime.
 */
function dayStatus(plan, shifts, date, now, grace, since = null) {
  const worked = shifts.reduce((s, r) => s + r.minutes, 0);
  const first = shifts.length ? shifts.map((r) => r.inTime).sort()[0] : null;
  const planned = plan && plan !== 'off' ? plan.minutes : 0;
  const out = { plan, worked, firstIn: first, lateMinutes: 0, overtime: 0 };
  if (shifts.length) {
    if (plan && plan !== 'off') {
      const late = toMin(first) - toMin(plan.start);
      if (late > grace) out.lateMinutes = late;
    }
    const closed = shifts.every((r) => r.clock_out);
    if (closed && (plan === 'off' || planned)) out.overtime = Math.max(0, worked - planned);
    return { ...out, status: out.lateMinutes ? 'late' : 'present' };
  }
  if (plan === 'off') return { ...out, status: 'off' };
  if (!plan || (since && date < since)) return { ...out, status: 'no_record' };
  if (date > now.date || (date === now.date && now.minutes < toMin(plan.start) + grace)) return { ...out, status: 'not_yet' };
  return { ...out, status: 'absent' };
}

// ---------------------------------------------------------------- clocking
const openShiftQuery = (trx, businessId, userId, now) => trx('attendance_records')
  .where({ business_id: businessId, user_id: userId }).whereNull('clock_out').where('clock_in', '>=', new Date(now - OPEN_SHIFT_MS))
  .orderBy('clock_in', 'desc');

/** The person's open shift, if any (clocked in within the last 16 hours and not out yet). */
async function openShift(businessId, userId, now = Date.now()) {
  return (await openShiftQuery(knex, businessId, userId, now).first()) || null;
}

/**
 * Clock in or out (toggle on the open shift), with the server's time.
 * @param opts.method  'button' (own page) or 'qr' (scanned at the attendance screen)
 * @param opts.expect  'in' | 'out' — what the button showed; a double tap does not undo the first one
 * @param opts.offNetwork  the scan came from another network than the door screen (kept on the record for managers)
 * When the clinic records attendance by QR only, the button is refused.
 */
async function toggle(ctx, { method = 'button', expect, offNetwork = false, now = Date.now() } = {}) {
  if (!['button', 'qr'].includes(method)) throw E.validation({ method: 'Choose a valid value.' });
  if (method === 'button' && (await settings(ctx.businessId)).qrOnly) {
    throw new AppError('ATTENDANCE_QR_ONLY', 'Your clinic records attendance by scanning the QR code on the attendance screen.', 409);
  }
  const member = await knex('memberships').where({ business_id: ctx.businessId, user_id: ctx.userId, status: 'active' }).first('id');
  if (!member) throw new AppError('ATTENDANCE_NOT_MEMBER', 'Your account is not an active staff member of this clinic.', 403);
  const tz = ctx.timezone || 'UTC';
  const at = new Date(now);
  const ip = ctx.ip ? String(ctx.ip).slice(0, 64) : null;
  const ua = ctx.userAgent ? String(ctx.userAgent).slice(0, 255) : null;
  return knex.transaction(async (trx) => {
    // Serialise taps of the same person (two phones, double taps).
    await trx('memberships').where({ id: member.id }).forUpdate().first('id');
    const open = await openShiftQuery(trx, ctx.businessId, ctx.userId, now).first();
    const action = open ? 'out' : 'in';
    if (expect && ['in', 'out'].includes(expect) && expect !== action) {
      throw new AppError(expect === 'in' ? 'ATTENDANCE_ALREADY_IN' : 'ATTENDANCE_ALREADY_OUT', expect === 'in' ? 'You are already clocked in.' : 'You are already clocked out.', 409);
    }
    if (open) {
      await trx('attendance_records').where({ id: open.id }).update({ clock_out: at, out_method: method, out_ip: ip, out_user_agent: ua, updated_at: at, ...(offNetwork ? { off_network: true } : {}) });
      return { action, id: open.id, at, minutes: minutesOf({ clock_in: open.clock_in, clock_out: at }) };
    }
    const [id] = await trx('attendance_records').insert({
      business_id: ctx.businessId, user_id: ctx.userId, work_date: localDate(tz, at), clock_in: at, in_method: method, in_ip: ip, in_user_agent: ua, off_network: Boolean(offNetwork), created_at: at, updated_at: at,
    });
    return { action, id, at, minutes: 0 };
  });
}

// ---------------------------------------------------------------- reading
/** Active and former members of the clinic (for names, roles and filters). */
async function staff(businessId) {
  return knex('memberships as m').join('users as u', 'u.id', 'm.user_id').join('roles as r', 'r.id', 'm.role_id')
    .where('m.business_id', businessId)
    .select('m.user_id', 'm.status', 'm.job_title', 'u.name', 'u.email', 'r.id as role_id', 'r.key as role_key', 'r.name as role_name', 'r.is_system')
    .orderBy('u.name');
}

/** Records of the clinic in a date range, optionally for one person / role. */
async function records(ctx, { from, to, userId, roleId } = {}) {
  const q = knex('attendance_records as a')
    .join('users as u', 'u.id', 'a.user_id')
    .leftJoin('memberships as m', function onM() { this.on('m.user_id', 'a.user_id').andOn('m.business_id', 'a.business_id'); })
    .leftJoin('roles as r', 'r.id', 'm.role_id')
    .leftJoin('users as c', 'c.id', 'a.corrected_by')
    .where('a.business_id', ctx.businessId)
    .select('a.*', 'u.name as user_name', 'r.key as role_key', 'r.name as role_name', 'r.is_system', 'c.name as corrected_by_name')
    .orderBy('a.work_date', 'desc').orderBy('a.clock_in', 'desc');
  if (from) q.where('a.work_date', '>=', from);
  if (to) q.where('a.work_date', '<=', to);
  if (userId) q.where('a.user_id', Number(userId));
  if (roleId) q.where('m.role_id', Number(roleId));
  const rows = await q;
  const tz = ctx.timezone || 'UTC';
  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    inTime: localTime(tz, r.clock_in),
    outTime: localTime(tz, r.clock_out),
    outDate: localDate(tz, r.clock_out),
    minutes: minutesOf(r),
    isOpen: !r.clock_out && now - new Date(r.clock_in).getTime() < OPEN_SHIFT_MS,
    missingOut: !r.clock_out && now - new Date(r.clock_in).getTime() >= OPEN_SHIFT_MS,
  }));
}

/** One person's month, grouped by day. */
async function myMonth(ctx, month) {
  const [from, to] = monthBounds(month);
  const rows = (await records(ctx, { from, to, userId: ctx.userId })).reverse();
  const days = [];
  for (const r of rows) {
    let d = days.find((x) => x.date === r.work_date);
    if (!d) { d = { date: r.work_date, shifts: [], minutes: 0 }; days.push(d); }
    d.shifts.push(r);
    d.minutes += r.minutes;
  }
  days.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { days, totalMinutes: days.reduce((s, d) => s + d.minutes, 0), dayCount: days.length, openCount: rows.filter((r) => r.missingOut).length };
}

/** Per-person totals for a list of records. */
function totalsByPerson(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, { user_id: r.user_id, name: r.user_name, role_key: r.role_key, role_name: r.role_name, is_system: r.is_system, days: new Set(), minutes: 0, shifts: 0, missingOut: 0, open: false, firstIn: null, lastOut: null });
    const p = map.get(r.user_id);
    p.days.add(r.work_date);
    p.minutes += r.minutes;
    p.shifts += 1;
    if (r.missingOut) p.missingOut += 1;
    if (r.isOpen) p.open = true;
    if (!p.firstIn || r.inTime < p.firstIn) p.firstIn = r.inTime;
    if (r.outTime && (!p.lastOut || r.outTime > p.lastOut)) p.lastOut = r.outTime;
  }
  return [...map.values()].map((p) => ({ ...p, dayCount: p.days.size })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// ---------------------------------------------------------------- board, timesheet, monthly report
const listDates = (from, to) => { const out = []; for (let d = from; d <= to; d = shiftDay(d, 1)) out.push(d); return out; };
function shiftDay(d, n) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
const byUserDate = (rows) => {
  const m = new Map();
  for (const r of rows) { const k = `${r.user_id}:${r.work_date}`; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  for (const list of m.values()) list.sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in));
  return m;
};
/** Staff shown on a board / report: active members matching the filters, plus anyone who has records in the period. */
function people(allStaff, rows, { userId, roleId } = {}) {
  const withRows = new Set(rows.map((r) => r.user_id));
  return allStaff.filter((s) => (s.status === 'active' || withRows.has(s.user_id)) && (!userId || s.user_id === Number(userId)) && (!roleId || s.role_id === Number(roleId)));
}

/** Today's (or one day's) board: every staff member with status, first in, last out, hours, late minutes. */
async function board(ctx, date, filters = {}) {
  const tz = ctx.timezone || 'UTC';
  const [rows, allStaff, { planFor, sinceFor, settings: set }] = await Promise.all([records(ctx, { from: date, to: date, ...filters }), staff(ctx.businessId), planner(ctx.businessId, date, date)]);
  const now = clinicNow(tz);
  const map = byUserDate(rows);
  const list = people(allStaff, rows, filters).map((p) => {
    const shifts = map.get(`${p.user_id}:${date}`) || [];
    const st = dayStatus(planFor(p.user_id, date), shifts, date, now, set.grace, sinceFor(p.user_id));
    const outs = shifts.filter((r) => r.clock_out).map((r) => r.outTime);
    return { ...p, shifts, ...st, isIn: shifts.some((r) => r.isOpen), missingOut: shifts.some((r) => r.missingOut), lastOut: outs.length ? outs[outs.length - 1] : null };
  });
  const count = (fn) => list.filter(fn).length;
  const summary = {
    present: count((p) => p.status === 'present' || p.status === 'late'), late: count((p) => p.status === 'late'), absent: count((p) => p.status === 'absent'),
    not_yet: count((p) => p.status === 'not_yet'), off: count((p) => p.status === 'off'), no_record: count((p) => p.status === 'no_record'), in_now: count((p) => p.isIn),
    minutes: list.reduce((s, p) => s + p.worked, 0),
  };
  return { date, rows: list, records: rows, summary, settings: set, hasAnyPlan: list.some((p) => p.plan !== null) };
}

function sumDays(days) {
  const t = { present: 0, late: 0, lateMinutes: 0, absent: 0, off: 0, worked: 0, overtime: 0, planned: 0, missingOut: 0, shifts: 0 };
  for (const d of days) {
    if (d.status === 'present' || d.status === 'late') t.present += 1;
    if (d.status === 'late') { t.late += 1; t.lateMinutes += d.lateMinutes; }
    if (d.status === 'absent') t.absent += 1;
    if (d.status === 'off') t.off += 1;
    t.worked += d.worked;
    t.overtime += d.overtime;
    if (d.plan && d.plan !== 'off' && d.status !== 'not_yet' && d.status !== 'no_record') t.planned += d.plan.minutes;
    t.missingOut += d.shifts.filter((r) => r.missingOut).length;
    t.shifts += d.shifts.length;
  }
  return t;
}

/** One person's month, every day with its status. */
async function timesheet(ctx, userId, month) {
  const [from, to] = monthBounds(month);
  const tz = ctx.timezone || 'UTC';
  const [rows, allStaff, { planFor, sinceFor, settings: set }] = await Promise.all([records(ctx, { from, to, userId }), staff(ctx.businessId), planner(ctx.businessId, from, to)]);
  const person = allStaff.find((s) => s.user_id === Number(userId));
  if (!person) throw E.notFound('Staff member');
  const now = clinicNow(tz);
  const map = byUserDate(rows);
  const days = listDates(from, to).map((date) => {
    const shifts = map.get(`${person.user_id}:${date}`) || [];
    return { date, shifts, future: date > now.date, ...dayStatus(planFor(person.user_id, date), shifts, date, now, set.grace, sinceFor(person.user_id)) };
  });
  return { person, month, days, totals: sumDays(days.filter((d) => !d.future)), settings: set, hasAnyPlan: days.some((d) => d.plan !== null) };
}

/** Monthly report: one line per staff member (days present, hours, late days, absences, overtime, missing clock-outs). */
async function monthReport(ctx, month, filters = {}) {
  const [from, to] = monthBounds(month);
  const tz = ctx.timezone || 'UTC';
  const [rows, allStaff, { planFor, sinceFor, settings: set }] = await Promise.all([records(ctx, { from, to, ...filters }), staff(ctx.businessId), planner(ctx.businessId, from, to)]);
  const now = clinicNow(tz);
  const map = byUserDate(rows);
  const dates = listDates(from, to < now.date ? to : now.date);
  const list = people(allStaff, rows, filters).map((p) => {
    const since = sinceFor(p.user_id);
    const days = dates.map((date) => ({ date, shifts: map.get(`${p.user_id}:${date}`) || [], ...dayStatus(planFor(p.user_id, date), map.get(`${p.user_id}:${date}`) || [], date, now, set.grace, since) }));
    return { ...p, ...sumDays(days), isIn: rows.some((r) => r.user_id === p.user_id && r.isOpen) };
  });
  const total = (k) => list.reduce((s, p) => s + p[k], 0);
  return { month, rows: list, records: rows, totals: { worked: total('worked'), late: total('late'), absent: total('absent'), overtime: total('overtime'), people: list.filter((p) => p.present).length }, settings: set };
}

/** The last clock-ins / clock-outs of today for the door screen: first name + initial, action and time. */
async function feed(businessId, tz, limit = 6) {
  const today = clinicNow(tz || 'UTC').date;
  const since = zonedToUtc(today, '00:00', tz || 'UTC');
  const rows = await knex('attendance_records as a').join('users as u', 'u.id', 'a.user_id')
    .where('a.business_id', businessId).where((w) => w.where('a.clock_in', '>=', since).orWhere('a.clock_out', '>=', since))
    .select('a.clock_in', 'a.clock_out', 'u.name').orderBy('a.updated_at', 'desc').limit(limit * 2);
  const short = (name) => { const p = String(name || '').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0] || '—'; };
  const events = [];
  for (const r of rows) {
    if (new Date(r.clock_in) >= since) events.push({ name: short(r.name), action: 'in', at: new Date(r.clock_in) });
    if (r.clock_out && new Date(r.clock_out) >= since) events.push({ name: short(r.name), action: 'out', at: new Date(r.clock_out) });
  }
  return events.sort((a, b) => b.at - a.at).slice(0, limit).map((e) => ({ name: e.name, action: e.action, time: localTime(tz || 'UTC', e.at), initials: e.name.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase() }));
}

// ---------------------------------------------------------------- corrections (attendance.manage)
async function getRecord(ctx, id) {
  const r = await knex('attendance_records').where({ id: Number(id), business_id: ctx.businessId }).first();
  if (!r) throw E.notFound('Attendance record');
  return r;
}

/** Validates a manual entry / correction (clinic-local date + HH:MM, reason required) → UTC instants. */
function parseEntry(ctx, input) {
  const errors = {};
  const date = String(input.work_date || '').trim();
  const inT = String(input.clock_in || '').trim();
  const outT = String(input.clock_out || '').trim();
  const reason = String(input.reason || '').trim();
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) errors.work_date = 'Enter a valid date.';
  if (!TIME.test(inT)) errors.clock_in = 'Enter a valid time.';
  if (outT && !TIME.test(outT)) errors.clock_out = 'Enter a valid time.';
  if (!reason) errors.reason = 'Required.';
  else if (reason.length > 500) errors.reason = 'Too large.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const tz = ctx.timezone || 'UTC';
  if (date > clinicNow(tz).date) throw E.validation({ work_date: 'Enter a valid date.' });
  const clockIn = zonedToUtc(date, inT, tz);
  let clockOut = null;
  if (outT) {
    clockOut = zonedToUtc(date, outT, tz);
    if (clockOut <= clockIn) clockOut = new Date(clockOut.getTime() + 86_400_000); // ends after midnight
    if ((clockOut - clockIn) / 60000 > MAX_SHIFT_MINUTES) throw E.validation({ clock_out: 'Enter a valid time.' });
  }
  if (clockOut && clockOut.getTime() > Date.now() + 60_000) throw E.validation({ clock_out: 'Enter a valid time.' });
  if (clockIn.getTime() > Date.now() + 60_000) throw E.validation({ clock_in: 'Enter a valid time.' });
  return { date, clockIn, clockOut, reason };
}

/**
 * Corrects a record's times (clinic-local date + HH:MM). A reason is required; the change is audited
 * with the old and new values.
 */
async function correct(ctx, id, input) {
  const before = await getRecord(ctx, id);
  const { date, clockIn, clockOut, reason } = parseEntry(ctx, input);
  const now = new Date();
  const changes = {
    work_date: date, clock_in: clockIn, clock_out: clockOut,
    ...(before.clock_in.getTime() !== clockIn.getTime() ? { in_method: 'manual' } : {}),
    ...((before.clock_out ? before.clock_out.getTime() : null) !== (clockOut ? clockOut.getTime() : null) ? { out_method: clockOut ? 'manual' : null } : {}),
    correction_reason: reason, corrected_by: ctx.userId, corrected_at: now, updated_at: now,
  };
  await knex.transaction(async (trx) => {
    await trx('attendance_records').where({ id: before.id }).update(changes);
    await audit.record(ctx, 'attendance.corrected', {
      entityType: 'attendance_record', entityId: before.id,
      oldValues: { user_id: before.user_id, work_date: before.work_date, clock_in: before.clock_in, clock_out: before.clock_out },
      newValues: { user_id: before.user_id, work_date: date, clock_in: clockIn, clock_out: clockOut, reason },
    }, trx);
  });
}

/** A manager records a shift that was never clocked (forgot the phone, screen off…). Reason required, audited. */
async function addManual(ctx, input) {
  const userId = Number(input.user_id);
  const member = Number.isInteger(userId) && userId > 0 && await knex('memberships').where({ business_id: ctx.businessId, user_id: userId }).first('id');
  if (!member) throw E.validation({ user_id: 'Required.' });
  const { date, clockIn, clockOut, reason } = parseEntry(ctx, input);
  const overlap = await knex('attendance_records').where({ business_id: ctx.businessId, user_id: userId })
    .where('clock_in', '<', clockOut || new Date(clockIn.getTime() + 60_000))
    .where((w) => w.whereNull('clock_out').orWhere('clock_out', '>', clockIn)).first('id');
  if (overlap) throw new AppError('ATTENDANCE_OVERLAP', 'This person already has a shift at that time. Correct that shift instead.', 409);
  const now = new Date();
  const id = await knex.transaction(async (trx) => {
    const [newId] = await trx('attendance_records').insert({
      business_id: ctx.businessId, user_id: userId, work_date: date, clock_in: clockIn, clock_out: clockOut, in_method: 'manual', out_method: clockOut ? 'manual' : null,
      correction_reason: reason, corrected_by: ctx.userId, corrected_at: now, created_at: now, updated_at: now,
    });
    await audit.record(ctx, 'attendance.added', { entityType: 'attendance_record', entityId: newId, newValues: { user_id: userId, work_date: date, clock_in: clockIn, clock_out: clockOut, reason } }, trx);
    return newId;
  });
  return id;
}

async function remove(ctx, id) {
  const before = await getRecord(ctx, id);
  await knex.transaction(async (trx) => {
    await trx('attendance_records').where({ id: before.id }).del();
    await audit.record(ctx, 'attendance.deleted', {
      entityType: 'attendance_record', entityId: before.id,
      oldValues: { user_id: before.user_id, work_date: before.work_date, clock_in: before.clock_in, clock_out: before.clock_out, in_method: before.in_method, out_method: before.out_method },
    }, trx);
  });
}

module.exports = { zonedToUtc,
  STEP_MS, GRACE_STEPS, TICKET_MS, OPEN_SHIFT_MS, DAY_KEYS, WEEK_ORDER, stepOf, issueToken, verifyToken, currentQr,
  settings, saveSettings, schedules, saveSchedule, removeSchedule, planner, dayStatus,
  openShift, toggle, staff, records, myMonth, totalsByPerson, board, timesheet, monthReport, feed,
  getRecord, correct, addManual, remove, localDate, localTime, zonedToUtc, minutesOf, monthBounds, shiftDay,
};
