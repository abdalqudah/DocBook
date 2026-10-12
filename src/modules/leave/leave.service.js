// Staff leave (/app/leave): every staff member asks for leave from their own account — annual, sick, unpaid or other,
// from one date to another or a half day, with a reason. Anyone holding leave.manage (owner and clinic manager by
// default) approves or rejects with an optional note, or records leave for someone directly (approved at once). The
// person who asked can cancel while the request is pending; a manager can also cancel an approved leave.
//
// Days are counted on the clinic's open weekdays: the clinic hours (Clinic → Working hours) → else the attendance
// working days → else every day of the week. A request stays inside one calendar year (balances are per year).
// Balance: the clinic's yearly allowance (annual / sick, 14 days each by default) or the person's own allowance;
// pending requests are held against it so two requests cannot overspend it.
//
// Ties into the rest: approved leave shows as "on leave" instead of absent in attendance (daysMap), unpaid leave of
// an employee linked to a login is shown on that month's salary line and can be added as a draft deduction
// (unpaidDays / addPayrollDeduction). Approvers are notified of a new request, the requester of the decision.
// Every request, decision, cancellation and setting change is audited.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { translator } = require('../../core/i18n');
const notifications = require('../notifications/notification.service');

const KINDS = ['annual', 'sick', 'unpaid', 'other'];
const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
const LIMITED = ['annual', 'sick']; // kinds with a yearly allowance
const DEFAULTS = { annual: 14, sick: 14 };
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEK_ORDER = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MANAGE = 'leave.manage';

const isDate = (d) => DATE.test(String(d || '')) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const dayKey = (date) => DAY_KEYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
function shiftDay(d, n) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
const listDates = (from, to) => { const out = []; for (let d = from; d <= to; d = shiftDay(d, 1)) out.push(d); return out; };
const dateOf = (v) => (typeof v === 'string' ? v.slice(0, 10) : v instanceof Date ? v.toISOString().slice(0, 10) : null);
const num = (v) => Math.round(Number(v || 0) * 10) / 10;
const parse = (v) => { try { const o = typeof v === 'string' ? JSON.parse(v) : v; return o && typeof o === 'object' ? o : null; } catch { return null; } };
const monthBounds = (month) => {
  const [y, m] = month.split('-').map(Number);
  return [`${month}-01`, `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`];
};

// ---------------------------------------------------------------- working days
/** The weekdays the clinic is open (['sat', …]), or null when the clinic has not set any hours (every day counts). */
async function openDays(businessId) {
  const [biz, att] = await Promise.all([
    knex('businesses').where({ id: businessId }).first('default_working_hours'),
    knex('attendance_settings').where({ business_id: businessId }).first('work_days', 'work_start', 'work_end'),
  ]);
  const week = parse(biz && biz.default_working_hours);
  if (week && Object.keys(week).length) {
    const open = WEEK_ORDER.filter((k) => week[k] && week[k].enabled);
    if (open.length) return open;
  }
  if (att && att.work_start && att.work_end && att.work_days) {
    const open = WEEK_ORDER.filter((d) => String(att.work_days).split(',').includes(d));
    if (open.length) return open;
  }
  return null;
}

/** Working days between two dates (both included) for a set of open weekdays; a half day counts 0.5. */
function countDays(from, to, open, halfDay = false) {
  const n = listDates(from, to).filter((d) => !open || open.includes(dayKey(d))).length;
  return halfDay ? (n ? 0.5 : 0) : n;
}

// ---------------------------------------------------------------- allowances
async function settings(businessId) {
  const row = await knex('staff_leave_settings').where({ business_id: businessId }).first();
  return { annualDays: row ? num(row.annual_days) : DEFAULTS.annual, sickDays: row ? num(row.sick_days) : DEFAULTS.sick };
}

const allowanceValue = (v, field, errors, { optional = false } = {}) => {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (s === '') { if (!optional) errors[field] = 'Required.'; return null; }
  const n = Number(s);
  if (!Number.isFinite(n)) { errors[field] = 'Enter a number.'; return null; }
  if (n < 0) { errors[field] = 'Must be zero or more.'; return null; }
  if (n > 365 || Math.round(n * 2) !== n * 2) { errors[field] = n > 365 ? 'Too large.' : 'Enter a number.'; return null; }
  return n;
};

/** The clinic's yearly allowance: { annual_days, sick_days } (0–365, halves allowed). */
async function saveSettings(ctx, input = {}) {
  const errors = {};
  const annual = allowanceValue(input.annual_days, 'annual_days', errors);
  const sick = allowanceValue(input.sick_days, 'sick_days', errors);
  if (Object.keys(errors).length) throw E.validation(errors);
  const before = await settings(ctx.businessId);
  const now = new Date();
  await knex('staff_leave_settings').insert({ business_id: ctx.businessId, annual_days: annual, sick_days: sick, updated_by: ctx.userId, updated_at: now })
    .onConflict('business_id').merge({ annual_days: annual, sick_days: sick, updated_by: ctx.userId, updated_at: now });
  const d = audit.diff({ annual_days: before.annualDays, sick_days: before.sickDays }, { annual_days: annual, sick_days: sick });
  if (d.changed) await audit.record(ctx, 'leave.settings_updated', { entityType: 'staff_leave_settings', entityId: ctx.businessId, oldValues: d.oldValues, newValues: d.newValues });
  return settings(ctx.businessId);
}

/** Own allowances: Map userId → { annual, sick } (null = the clinic's). */
async function ownAllowances(businessId) {
  const rows = await knex('staff_leave_allowances').where({ business_id: businessId });
  return new Map(rows.map((r) => [r.user_id, { annual: r.annual_days === null ? null : num(r.annual_days), sick: r.sick_days === null ? null : num(r.sick_days) }]));
}

/** A staff member's own yearly allowance; both empty = back to the clinic's. */
async function saveAllowance(ctx, userId, input = {}) {
  const uid = Number(userId);
  const member = Number.isInteger(uid) && uid > 0 && await knex('memberships').where({ business_id: ctx.businessId, user_id: uid }).first('id');
  if (!member) throw E.notFound('Staff member');
  const errors = {};
  const annual = allowanceValue(input.annual_days, 'annual_days', errors, { optional: true });
  const sick = allowanceValue(input.sick_days, 'sick_days', errors, { optional: true });
  if (Object.keys(errors).length) throw E.validation(errors);
  const before = await knex('staff_leave_allowances').where({ business_id: ctx.businessId, user_id: uid }).first();
  if (annual === null && sick === null) {
    if (before) await knex('staff_leave_allowances').where({ id: before.id }).del();
  } else if (before) {
    await knex('staff_leave_allowances').where({ id: before.id }).update({ annual_days: annual, sick_days: sick, updated_by: ctx.userId, updated_at: new Date() });
  } else {
    await knex('staff_leave_allowances').insert({ business_id: ctx.businessId, user_id: uid, annual_days: annual, sick_days: sick, updated_by: ctx.userId });
  }
  await audit.record(ctx, 'leave.allowance_saved', {
    entityType: 'staff_leave_allowance', entityId: uid,
    oldValues: before ? { annual_days: before.annual_days === null ? null : num(before.annual_days), sick_days: before.sick_days === null ? null : num(before.sick_days) } : undefined,
    newValues: { user_id: uid, annual_days: annual, sick_days: sick },
  });
}

/**
 * Used / pending / remaining days of a year per person: Map userId → { annual: { allowance, used, pending, remaining },
 * sick: {…}, unpaid: { used, pending }, other: { used, pending } }.
 */
async function balances(businessId, year, userIds = null) {
  const [set, own, rows] = await Promise.all([
    settings(businessId), ownAllowances(businessId),
    knex('staff_leave_requests').where({ business_id: businessId }).whereIn('status', ['pending', 'approved'])
      .where('from_date', '>=', `${year}-01-01`).where('from_date', '<=', `${year}-12-31`)
      .modify((q) => { if (userIds) q.whereIn('user_id', userIds.length ? userIds : [0]); })
      .select('user_id', 'kind', 'status', 'days'),
  ]);
  const ids = userIds || [...new Set([...rows.map((r) => r.user_id), ...own.keys()])];
  const out = new Map();
  const blank = (uid) => {
    const mine = own.get(uid) || {};
    const allowance = { annual: mine.annual ?? set.annualDays, sick: mine.sick ?? set.sickDays };
    const b = { ownAllowance: own.has(uid) };
    for (const k of KINDS) b[k] = { allowance: LIMITED.includes(k) ? allowance[k] : null, used: 0, pending: 0, remaining: null };
    return b;
  };
  for (const uid of ids) out.set(uid, blank(uid));
  for (const r of rows) {
    if (!out.has(r.user_id)) out.set(r.user_id, blank(r.user_id));
    const b = out.get(r.user_id)[r.kind];
    if (!b) continue; // eslint-disable-line no-continue
    if (r.status === 'approved') b.used = num(b.used + Number(r.days));
    else b.pending = num(b.pending + Number(r.days));
  }
  for (const b of out.values()) for (const k of LIMITED) b[k].remaining = num(b[k].allowance - b[k].used);
  return out;
}

// ---------------------------------------------------------------- reading
const baseQuery = (businessId) => knex('staff_leave_requests as l')
  .join('users as u', 'u.id', 'l.user_id')
  .leftJoin('users as d', 'd.id', 'l.decided_by')
  .leftJoin('users as c', 'c.id', 'l.created_by')
  .where('l.business_id', businessId)
  .select('l.*', 'u.name as user_name', 'd.name as decided_by_name', 'c.name as created_by_name');
const shape = (r) => ({ ...r, from_date: dateOf(r.from_date), to_date: dateOf(r.to_date), days: num(r.days), half_day: Boolean(r.half_day) });

/** Requests of the clinic (branch staff only for a member working in one branch); filters: userId, status, year. */
async function list(ctx, { userId, status, year, limit = 500 } = {}) {
  const q = baseQuery(ctx.businessId).orderBy('l.from_date', 'desc').orderBy('l.id', 'desc').limit(limit);
  if (userId) q.where('l.user_id', Number(userId));
  else q.whereIn('l.user_id', knex('memberships as m').where('m.business_id', ctx.businessId).modify((s) => require('../clinic/branches.service').scopeMembers(s, ctx)).select('m.user_id')); // eslint-disable-line global-require
  if (STATUSES.includes(status)) q.where('l.status', status);
  if (/^\d{4}$/.test(String(year || ''))) q.where('l.from_date', '>=', `${year}-01-01`).where('l.from_date', '<=', `${year}-12-31`);
  return (await q).map(shape);
}

async function get(ctx, id) {
  const r = await baseQuery(ctx.businessId).where('l.id', Number(id)).first();
  if (!r) throw E.notFound('Leave request');
  return shape(r);
}

/**
 * Approved leave per person and day between two dates: Map `${userId}:${date}` → { id, kind, half }.
 * Every calendar day of the leave is listed (attendance only shows it on a planned working day).
 */
async function daysMap(businessId, from, to) {
  const rows = await knex('staff_leave_requests').where({ business_id: businessId, status: 'approved' })
    .where('from_date', '<=', to).where('to_date', '>=', from).select('id', 'user_id', 'kind', 'from_date', 'to_date', 'half_day');
  const map = new Map();
  for (const r of rows) {
    const a = dateOf(r.from_date) < from ? from : dateOf(r.from_date);
    const b = dateOf(r.to_date) > to ? to : dateOf(r.to_date);
    for (const d of listDates(a, b)) map.set(`${r.user_id}:${d}`, { id: r.id, kind: r.kind, half: Boolean(r.half_day) });
  }
  return map;
}

/** Who is on leave in a month, by date (open days only): [{ date, people: [{ user_id, name, kind, half, id }] }]. */
async function calendar(ctx, month) {
  const [from, to] = monthBounds(month);
  const [rows, open] = await Promise.all([
    baseQuery(ctx.businessId).where('l.status', 'approved').where('l.from_date', '<=', to).where('l.to_date', '>=', from)
      .whereIn('l.user_id', knex('memberships as m').where('m.business_id', ctx.businessId).modify((s) => require('../clinic/branches.service').scopeMembers(s, ctx)).select('m.user_id')) // eslint-disable-line global-require
      .orderBy('u.name'),
    openDays(ctx.businessId),
  ]);
  const days = [];
  for (const date of listDates(from, to)) {
    if (open && !open.includes(dayKey(date))) continue; // eslint-disable-line no-continue
    const people = rows.map(shape).filter((r) => r.from_date <= date && r.to_date >= date)
      .map((r) => ({ id: r.id, user_id: r.user_id, name: r.user_name, kind: r.kind, half: r.half_day }));
    if (people.length) days.push({ date, people });
  }
  return { month, days, people: new Set(rows.map((r) => r.user_id)).size };
}

/** Approved unpaid leave days in a month per person (open days, halves counted): Map userId → days. */
async function unpaidDays(businessId, month, userIds = null) {
  const [from, to] = monthBounds(month);
  const [rows, open] = await Promise.all([
    knex('staff_leave_requests').where({ business_id: businessId, status: 'approved', kind: 'unpaid' })
      .where('from_date', '<=', to).where('to_date', '>=', from)
      .modify((q) => { if (userIds) q.whereIn('user_id', userIds.length ? userIds : [0]); })
      .select('user_id', 'from_date', 'to_date', 'half_day'),
    openDays(businessId),
  ]);
  const out = new Map();
  for (const r of rows) {
    const a = dateOf(r.from_date) < from ? from : dateOf(r.from_date);
    const b = dateOf(r.to_date) > to ? to : dateOf(r.to_date);
    out.set(r.user_id, num((out.get(r.user_id) || 0) + countDays(a, b, open, Boolean(r.half_day))));
  }
  return out;
}

/** Unpaid leave days of a month per staff employee linked to a login: Map employeeId → days. */
async function unpaidByEmployee(businessId, month, employeeIds) {
  if (!employeeIds.length) return new Map();
  const links = await knex('staff_employees as e').join('memberships as m', 'm.id', 'e.membership_id')
    .where('e.business_id', businessId).whereIn('e.id', employeeIds).select('e.id', 'm.user_id');
  if (!links.length) return new Map();
  const days = await unpaidDays(businessId, month, links.map((l) => l.user_id));
  return new Map(links.filter((l) => days.get(l.user_id)).map((l) => [l.id, days.get(l.user_id)]));
}

// ---------------------------------------------------------------- requests
/** Validates kind / dates / half day / reason → { kind, from, to, half, reason, days }. */
async function parseRequest(ctx, input, { reasonRequired = true } = {}) {
  const errors = {};
  const kind = String(input.kind || '');
  const from = String(input.from_date || '').trim();
  const half = input.half_day === true || input.half_day === '1' || input.half_day === 'on';
  const to = half ? from : (String(input.to_date || '').trim() || from);
  const reason = String(input.reason || '').trim();
  if (!KINDS.includes(kind)) errors.kind = 'Choose a valid value.';
  if (!isDate(from)) errors.from_date = 'Enter a valid date.';
  if (!isDate(to)) errors.to_date = 'Enter a valid date.';
  else if (isDate(from) && (to < from || to.slice(0, 4) !== from.slice(0, 4))) errors.to_date = 'Enter a valid date.'; // one calendar year at a time
  if (reasonRequired && !reason) errors.reason = 'Required.';
  if (reason.length > 500) errors.reason = 'Too large.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const days = countDays(from, to, await openDays(ctx.businessId), half);
  if (!days) throw new AppError('LEAVE_NO_WORKING_DAYS', 'The clinic is closed on every day of this period.', 422);
  return { kind, from, to, half, reason: reason || null, days };
}

async function activeMember(businessId, userId) {
  return knex('memberships').where({ business_id: businessId, user_id: Number(userId), status: 'active' }).first('id');
}

/** Another pending / approved leave of the same person in these dates. */
async function checkOverlap(trx, businessId, userId, from, to) {
  const other = await trx('staff_leave_requests').where({ business_id: businessId, user_id: userId }).whereIn('status', ['pending', 'approved'])
    .where('from_date', '<=', to).where('to_date', '>=', from).first('id');
  if (other) throw new AppError('LEAVE_OVERLAP', 'There is already a leave request in these dates.', 409);
}

async function checkBalance(businessId, userId, d) {
  if (!LIMITED.includes(d.kind)) return;
  const b = (await balances(businessId, d.from.slice(0, 4), [userId])).get(userId)[d.kind];
  if (d.days > num(b.remaining - b.pending)) throw new AppError('LEAVE_BALANCE', 'Not enough leave days left this year.', 409, { remaining: num(b.remaining - b.pending) });
}

const both = (key, vars) => { const ar = translator('ar')(key, vars); const en = translator('en')(key, vars); return ar === en ? en : `${ar} · ${en}`; };
const kindText = (k) => ({ ar: translator('ar')(`leave.kinds.${k}`), en: translator('en')(`leave.kinds.${k}`) });
async function nameOf(userId) { return ((await knex('users').where({ id: userId }).first('name')) || {}).name || ''; }
const periodText = (r) => (r.from === r.to ? r.from : `${r.from} → ${r.to}`);

/** A staff member asks for leave (own account). Pending until someone with leave.manage decides. */
async function request(ctx, input = {}) {
  if (!(await activeMember(ctx.businessId, ctx.userId))) throw new AppError('LEAVE_NOT_MEMBER', 'Your account is not an active staff member of this clinic.', 403);
  const d = await parseRequest(ctx, input);
  await checkBalance(ctx.businessId, ctx.userId, d);
  const id = await knex.transaction(async (trx) => {
    await trx('memberships').where({ business_id: ctx.businessId, user_id: ctx.userId }).forUpdate().first('id'); // one request at a time per person
    await checkOverlap(trx, ctx.businessId, ctx.userId, d.from, d.to);
    const [newId] = await trx('staff_leave_requests').insert({
      business_id: ctx.businessId, user_id: ctx.userId, kind: d.kind, from_date: d.from, to_date: d.to, half_day: d.half, days: d.days, reason: d.reason, status: 'pending', created_by: ctx.userId,
    });
    await audit.record(ctx, 'leave.requested', { entityType: 'staff_leave_request', entityId: newId, newValues: { user_id: ctx.userId, kind: d.kind, from_date: d.from, to_date: d.to, half_day: d.half, days: d.days, reason: d.reason } }, trx);
    return newId;
  });
  const name = await nameOf(ctx.userId);
  const k = kindText(d.kind);
  await notifications.notify(ctx.businessId, {
    permission: MANAGE, type: 'leave.requested', title: both('leave.n_requested_title', { name }),
    body: `${k.ar} · ${k.en} — ${periodText(d)} (${d.days})`, link: '/app/leave?tab=requests', dedupeKey: `leave:${id}:req`,
  }).catch((err) => console.error('[leave] notify:', err.message)); // eslint-disable-line no-console
  return id;
}

/** A manager records leave for someone (approved at once; the allowance is not enforced, it is shown on the balance). */
async function record(ctx, input = {}) {
  if (!ctx.permissions || !ctx.permissions.has(MANAGE)) throw E.forbidden(MANAGE);
  const uid = Number(input.user_id);
  if (!Number.isInteger(uid) || uid <= 0 || !(await activeMember(ctx.businessId, uid))) throw E.validation({ user_id: 'Required.' });
  const d = await parseRequest(ctx, input, { reasonRequired: false });
  const now = new Date();
  const id = await knex.transaction(async (trx) => {
    await checkOverlap(trx, ctx.businessId, uid, d.from, d.to);
    const [newId] = await trx('staff_leave_requests').insert({
      business_id: ctx.businessId, user_id: uid, kind: d.kind, from_date: d.from, to_date: d.to, half_day: d.half, days: d.days, reason: d.reason,
      status: 'approved', decided_by: ctx.userId, decided_at: now, created_by: ctx.userId,
    });
    await audit.record(ctx, 'leave.recorded', { entityType: 'staff_leave_request', entityId: newId, newValues: { user_id: uid, kind: d.kind, from_date: d.from, to_date: d.to, half_day: d.half, days: d.days, reason: d.reason, status: 'approved' } }, trx);
    return newId;
  });
  if (uid !== ctx.userId) {
    const k = kindText(d.kind);
    await notifications.notify(ctx.businessId, {
      userId: uid, type: 'leave.recorded', title: both('leave.n_recorded_title'), body: `${k.ar} · ${k.en} — ${periodText(d)} (${d.days})`,
      link: '/app/leave', severity: 'info', dedupeKey: `leave:${id}:rec`,
    }).catch((err) => console.error('[leave] notify:', err.message)); // eslint-disable-line no-console
  }
  return id;
}

/** Approve or reject a pending request (leave.manage), with an optional note. The requester is notified. */
async function decide(ctx, id, decision, note) {
  if (!ctx.permissions || !ctx.permissions.has(MANAGE)) throw E.forbidden(MANAGE);
  if (!['approve', 'reject'].includes(decision)) throw E.validation({ decision: 'Choose a valid value.' });
  const text = String(note || '').trim();
  if (text.length > 500) throw E.validation({ note: 'Too large.' });
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const r = await knex.transaction(async (trx) => {
    const row = await trx('staff_leave_requests').where({ id: Number(id), business_id: ctx.businessId }).forUpdate().first();
    if (!row) throw E.notFound('Leave request');
    if (row.status !== 'pending') throw new AppError('LEAVE_NOT_PENDING', 'This request has already been decided or cancelled.', 409);
    await trx('staff_leave_requests').where({ id: row.id }).update({ status, decided_by: ctx.userId, decided_at: new Date(), decision_note: text || null, updated_at: new Date() });
    await audit.record(ctx, `leave.${status}`, { entityType: 'staff_leave_request', entityId: row.id, oldValues: { status: 'pending' }, newValues: { user_id: row.user_id, kind: row.kind, from_date: dateOf(row.from_date), to_date: dateOf(row.to_date), days: num(row.days), status, note: text || null } }, trx);
    return shape(row);
  });
  const k = kindText(r.kind);
  await notifications.notify(ctx.businessId, {
    userId: r.user_id, type: `leave.${status}`, title: both(`leave.n_${status}_title`),
    body: `${k.ar} · ${k.en} — ${periodText({ from: r.from_date, to: r.to_date })}${text ? ` — ${text}` : ''}`,
    link: '/app/leave', severity: status === 'approved' ? 'success' : 'warning', dedupeKey: `leave:${r.id}:${status}`,
  }).catch((err) => console.error('[leave] notify:', err.message)); // eslint-disable-line no-console
  return { ...r, status };
}

/** The requester cancels a pending request; someone with leave.manage may also cancel an approved one. */
async function cancel(ctx, id) {
  const manager = Boolean(ctx.permissions && ctx.permissions.has(MANAGE));
  return knex.transaction(async (trx) => {
    const row = await trx('staff_leave_requests').where({ id: Number(id), business_id: ctx.businessId }).forUpdate().first();
    if (!row) throw E.notFound('Leave request');
    const own = row.user_id === ctx.userId;
    if (!own && !manager) throw E.notFound('Leave request');
    const allowed = row.status === 'pending' ? (own || manager) : row.status === 'approved' && manager;
    if (!allowed) throw new AppError('LEAVE_NOT_PENDING', 'This request has already been decided or cancelled.', 409);
    await trx('staff_leave_requests').where({ id: row.id }).update({ status: 'cancelled', updated_at: new Date(), ...(own && row.status === 'pending' ? {} : { decided_by: ctx.userId, decided_at: new Date() }) });
    await audit.record(ctx, 'leave.cancelled', { entityType: 'staff_leave_request', entityId: row.id, oldValues: { status: row.status }, newValues: { user_id: row.user_id, kind: row.kind, from_date: dateOf(row.from_date), to_date: dateOf(row.to_date), status: 'cancelled' } }, trx);
    return shape({ ...row, status: 'cancelled' });
  });
}

// ---------------------------------------------------------------- payroll
/**
 * Adds the month's unpaid leave as a deduction on a draft salary line (payroll.manage): base salary ÷ 30 × days,
 * with a clear reason. Once per line (source = 'leave'); removing it on the payroll page allows adding it again.
 */
async function addPayrollDeduction(ctx, lineId) {
  if (!ctx.permissions || !ctx.permissions.has('payroll.manage')) throw E.forbidden('payroll.manage');
  const staff = require('../finance/staff.service'); // eslint-disable-line global-require
  const line = await staff.getLine(ctx, Number(lineId));
  if (line.status === 'paid') throw new AppError('LINE_PAID', 'This salary is already paid. Reopen it first.', 409);
  const days = (await unpaidByEmployee(ctx.businessId, line.period, [line.employee_id])).get(line.employee_id) || 0;
  if (!days) throw new AppError('LEAVE_NO_UNPAID', 'There is no approved unpaid leave in this month.', 409);
  const exists = await knex('staff_payroll_adjustments').where({ line_id: line.id, source: 'leave' }).first('id');
  if (exists) throw new AppError('LEAVE_DEDUCTION_EXISTS', 'The unpaid leave of this month is already deducted.', 409);
  const amount = Math.round((Number(line.base_salary) / 30) * days * 100) / 100;
  if (!(amount > 0)) throw new AppError('LEAVE_NO_SALARY', 'This salary line has no base salary to deduct from.', 409);
  const reason = translator(ctx.locale || 'ar')('leave.deduction_reason', { n: days, month: line.period });
  const [adjId] = await knex('staff_payroll_adjustments').insert({ business_id: ctx.businessId, line_id: line.id, type: 'deduction', amount, reason, source: 'leave', created_by: ctx.userId });
  const after = await staff.recompute(line.id);
  await audit.record(ctx, 'staff.adjustment_added', { entityType: 'staff_payroll_line', entityId: line.id, newValues: { period: line.period, employee: line.employee_name, type: 'deduction', amount, reason, source: 'leave', days, net_pay: Number(after.net_pay) } });
  return { id: adjId, amount, days };
}

module.exports = {
  KINDS, STATUSES, LIMITED, DEFAULTS, MANAGE, openDays, countDays, settings, saveSettings, ownAllowances, saveAllowance, balances,
  list, get, daysMap, calendar, unpaidDays, unpaidByEmployee, request, record, decide, cancel, addPayrollDeduction, monthBounds, shiftDay,
};
