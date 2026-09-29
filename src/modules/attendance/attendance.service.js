// Staff attendance for clinics: doctors, nurses, receptionists and accountants clock in and out.
//
// QR attendance screen: a tablet at reception shows a QR code that changes every 10 seconds. The code is a
// short-lived token "<clinicId>.<step>.<signature>" where step = the current 10-second window and signature =
// HMAC-SHA256 of the clinic and step with a key derived from the server secret — it cannot be guessed, is bound
// to one clinic and expires by itself. Any number of staff can scan the same code; a scanned code is accepted
// for its own window and the two before it (up to 30 seconds) so a slow phone camera still gets through.
// After a valid scan the phone gets a short ticket in its session (3 minutes) to tap "Clock in" / "Clock out".
//
// Records: one row per shift (clock_in → clock_out), server time, with the IP and browser of each tap.
// The toggle looks at the person's open shift (no clock-out, started within the last 16 hours).
// Late / absent is not computed: DocBook has no staff shift plan, so the pages show only what was recorded.
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
async function settings(businessId) {
  const row = await knex('attendance_settings').where({ business_id: businessId }).first();
  return { qrOnly: Boolean(row && row.qr_only) };
}

async function saveSettings(ctx, { qrOnly }) {
  const before = await settings(ctx.businessId);
  const value = Boolean(qrOnly);
  const exists = await knex('attendance_settings').where({ business_id: ctx.businessId }).first('business_id');
  if (exists) await knex('attendance_settings').where({ business_id: ctx.businessId }).update({ qr_only: value, updated_by: ctx.userId, updated_at: new Date() });
  else await knex('attendance_settings').insert({ business_id: ctx.businessId, qr_only: value, updated_by: ctx.userId });
  if (before.qrOnly !== value) await audit.record(ctx, 'attendance.settings_updated', { entityType: 'attendance_settings', entityId: ctx.businessId, oldValues: { qr_only: before.qrOnly }, newValues: { qr_only: value } });
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
 * When the clinic records attendance by QR only, the button is refused.
 */
async function toggle(ctx, { method = 'button', expect, now = Date.now() } = {}) {
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
      await trx('attendance_records').where({ id: open.id }).update({ clock_out: at, out_method: method, out_ip: ip, out_user_agent: ua, updated_at: at });
      return { action, id: open.id, at, minutes: minutesOf({ clock_in: open.clock_in, clock_out: at }) };
    }
    const [id] = await trx('attendance_records').insert({
      business_id: ctx.businessId, user_id: ctx.userId, work_date: localDate(tz, at), clock_in: at, in_method: method, in_ip: ip, in_user_agent: ua, created_at: at, updated_at: at,
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

// ---------------------------------------------------------------- corrections (attendance.manage)
async function getRecord(ctx, id) {
  const r = await knex('attendance_records').where({ id: Number(id), business_id: ctx.businessId }).first();
  if (!r) throw E.notFound('Attendance record');
  return r;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Corrects a record's times (clinic-local date + HH:MM). A reason is required; the change is audited
 * with the old and new values.
 */
async function correct(ctx, id, input) {
  const before = await getRecord(ctx, id);
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

module.exports = {
  STEP_MS, GRACE_STEPS, TICKET_MS, OPEN_SHIFT_MS, stepOf, issueToken, verifyToken, currentQr,
  settings, saveSettings, openShift, toggle, staff, records, myMonth, totalsByPerson, getRecord, correct, remove,
  localDate, localTime, zonedToUtc, minutesOf, monthBounds,
};
