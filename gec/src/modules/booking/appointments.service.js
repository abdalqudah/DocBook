// Appointments: booking from the website, the student portal or by staff; confirm, complete, no-show, cancel and
// reschedule; every change lands on the lead / student timeline and moves the lead pipeline where it fits.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const events = require('../../core/events');
const { E } = require('../../core/errors');
const { randomToken } = require('../../core/tokens');
const { scope } = require('../rbac/rbac.service');
const activity = require('../crm/activity.service');
const people = require('../crm/people');
const scheduling = require('./scheduling');

const STATUSES = ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show', 'rescheduled'];

function base(staff) {
  const q = knex('appointments as a').join('appointment_types as t', 't.id', 'a.type_id')
    .leftJoin('employees as e', 'e.id', 'a.employee_id').leftJoin('users as eu', 'eu.id', 'e.user_id')
    .leftJoin('leads as l', 'l.id', 'a.lead_id').leftJoin('students as s', 's.id', 'a.student_id');
  return staff ? scope(q, staff, { owner: 'a.employee_id', branch: 'a.branch_id' }) : q;
}
const COLS = ['a.*', 't.name_en as type_en', 't.name_ar as type_ar', 't.duration_min', 'eu.name as employee_name',
  'l.first_name as lead_first', 'l.last_name as lead_last', 's.first_name as student_first', 's.last_name as student_last'];

async function list(staff, { from, to, status, employee, mine } = {}) {
  const q = base(staff).select(COLS).orderBy('a.start_at');
  if (from) q.where('a.start_at', '>=', from);
  if (to) q.where('a.start_at', '<', to);
  if (STATUSES.includes(status)) q.where('a.status', status); else q.whereNotIn('a.status', ['cancelled', 'rescheduled']);
  if (/^\d+$/.test(String(employee || ''))) q.where('a.employee_id', Number(employee));
  if (mine) q.where('a.employee_id', staff.employee.id);
  return q.limit(500);
}

async function get(staff, id) {
  const a = await base(staff).where('a.id', id).first(COLS);
  if (!a) throw E.notFound('Appointment');
  return a;
}

async function byToken(token) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(token || ''))) return null;
  return base(null).where('a.manage_token', token).first([...COLS, 't.slug as type_slug', 't.location_text', 't.min_notice_hours']);
}

/**
 * Books a slot. `employeeId` may be null when the visitor chose "any counsellor": the slot engine picked one and
 * passes it with the slot. Returns the appointment row.
 */
async function book(ctx, { typeId, employeeId, start, mode, leadId = null, studentId = null, via = 'staff', contact = {}, notes = null, meetingUrl = null, isDemo = false }) {
  const type = await knex('appointment_types').where({ id: typeId, is_active: true }).first();
  if (!type) throw E.notFound('Appointment type');
  const startAt = new Date(start);
  if (Number.isNaN(startAt.getTime())) throw E.validation({ start: 'Choose a valid time.' });
  if (via !== 'staff') {
    if (startAt < new Date(Date.now() + type.min_notice_hours * 3600_000)) throw E.conflict('SLOT_TOO_SOON', 'This time is too soon. Please choose a later time.');
    if (startAt > new Date(Date.now() + type.max_days_ahead * 86400_000)) throw E.validation({ start: 'Choose a valid time.' });
  }
  const eligible = await scheduling.eligibleEmployees(type, employeeId);
  if (!eligible.length) throw E.validation({ employee_id: 'Choose a valid option.' });
  const emp = eligible[0];
  // Website / portal bookings must fall inside published availability, not only be free.
  if (via !== 'staff') {
    const day = require('../../core/format').zonedDate(startAt, emp.tz); // eslint-disable-line global-require
    const { slots } = await scheduling.slots(type.id, { fromDate: day, days: 1, employeeId: emp.id });
    if (!slots.some((s) => s.start.getTime() === startAt.getTime())) throw E.conflict('SLOT_TAKEN', 'This time is no longer available. Please choose another time.');
  }
  const m = ['online', 'in_person'].includes(mode) ? mode : (type.location_mode === 'in_person' ? 'in_person' : 'online');
  const ref = await people.newRef('appointments', 'M'); // before the lock: the transaction holds its own connection
  const id = await scheduling.withCalendarLock(emp.id, async (trx) => {
    const end = await scheduling.assertFree(trx, type, emp.id, startAt);
    const [newId] = await trx('appointments').insert({
      ref, type_id: type.id, employee_id: emp.id, lead_id: leadId, student_id: studentId, start_at: startAt, end_at: end,
      status: 'scheduled', mode: m, location: m === 'in_person' ? type.location_text : null, meeting_url: meetingUrl,
      contact_name: contact.name || null, contact_email: contact.email || null, contact_phone: contact.phone || null, notes,
      booked_via: via, manage_token: randomToken(24), branch_id: emp.branch_id, created_by: ctx.userId || null, is_demo: isDemo,
    });
    return newId;
  });
  const appt = await knex('appointments').where({ id }).first();
  await activity.log({ leadId, studentId }, { type: 'appointment', title: 'appointment_booked', meta: { ref: appt.ref, type_en: type.name_en, type_ar: type.name_ar, start: appt.start_at, with: emp.name, via }, actorId: ctx.userId || null, shareable: true });
  await audit.record(ctx, 'appointment.booked', { entityType: 'appointment', entityId: id, newValues: { type: type.slug, employee_id: emp.id, start: appt.start_at, via } });
  await events.emit('appointment.booked', { appointment: appt, type, employee: emp, by: ctx.userId || null });
  return appt;
}

async function setStatus(ctx, staff, id, status, { reason = null } = {}) {
  if (!STATUSES.includes(status) || status === 'rescheduled') throw E.validation({ status: 'Choose a valid option.' });
  const a = await get(staff, id);
  if (a.status === status) return;
  await knex('appointments').where({ id }).update({ status, cancel_reason: status === 'cancelled' ? reason : a.cancel_reason, updated_at: new Date() });
  await activity.log({ leadId: a.lead_id, studentId: a.student_id }, { type: 'appointment', title: `appointment_${status}`, meta: { ref: a.ref, type_en: a.type_en, type_ar: a.type_ar, start: a.start_at }, actorId: ctx.userId, shareable: status !== 'no_show' });
  await audit.record(ctx, 'appointment.status_changed', { entityType: 'appointment', entityId: id, oldValues: { status: a.status }, newValues: { status, reason: reason || undefined } });
  await events.emit(`appointment.${status}`, { appointment: { ...a, status }, by: ctx.userId });
}

/** Moves an appointment to a new time (same counsellor unless another is given), keeping the history. */
async function reschedule(ctx, appt, { start, employeeId = null, via = 'staff' }) {
  if (['cancelled', 'rescheduled', 'completed'].includes(appt.status)) throw E.conflict('NOT_RESCHEDULABLE', 'This appointment can no longer be changed.');
  const created = await book(ctx, { typeId: appt.type_id, employeeId: employeeId || appt.employee_id, start, mode: appt.mode, leadId: appt.lead_id, studentId: appt.student_id, via, contact: { name: appt.contact_name, email: appt.contact_email, phone: appt.contact_phone }, notes: appt.notes, meetingUrl: appt.meeting_url });
  await knex('appointments').where({ id: created.id }).update({ rescheduled_from_id: appt.id, manage_token: appt.manage_token && via !== 'staff' ? randomToken(24) : created.manage_token });
  await knex('appointments').where({ id: appt.id }).update({ status: 'rescheduled', manage_token: null, updated_at: new Date() });
  await audit.record(ctx, 'appointment.rescheduled', { entityType: 'appointment', entityId: appt.id, newValues: { new_id: created.id, start } });
  await events.emit('appointment.rescheduled', { from: appt, appointment: created, by: ctx.userId || null });
  return knex('appointments').where({ id: created.id }).first();
}

async function cancelByToken(token, reason) {
  const a = await byToken(token);
  if (!a || ['cancelled', 'rescheduled', 'completed', 'no_show'].includes(a.status)) throw E.notFound('Appointment');
  await knex('appointments').where({ id: a.id }).update({ status: 'cancelled', cancel_reason: reason ? String(reason).slice(0, 255) : 'cancelled by the visitor', updated_at: new Date() });
  await activity.log({ leadId: a.lead_id, studentId: a.student_id }, { type: 'appointment', title: 'appointment_cancelled', meta: { ref: a.ref, type_en: a.type_en, type_ar: a.type_ar, start: a.start_at, by_visitor: true }, shareable: true });
  await events.emit('appointment.cancelled', { appointment: { ...a, status: 'cancelled' }, by: null });
  return a;
}

async function update(ctx, staff, id, { meetingUrl, notes, location }) {
  const a = await get(staff, id);
  const row = {};
  if (meetingUrl !== undefined) row.meeting_url = meetingUrl || null;
  if (notes !== undefined) row.notes = notes || null;
  if (location !== undefined) row.location = location || null;
  await knex('appointments').where({ id }).update({ ...row, updated_at: new Date() });
  await audit.record(ctx, 'appointment.updated', { entityType: 'appointment', entityId: id, oldValues: { meeting_url: a.meeting_url }, newValues: row });
}

/** Appointments starting within `hours` that have not been reminded yet (the reminder job). */
async function dueReminders(hours) {
  const now = new Date();
  return base(null).whereIn('a.status', ['scheduled', 'confirmed']).whereNull('a.reminder_sent_at')
    .where('a.start_at', '>', now).where('a.start_at', '<=', new Date(now.getTime() + hours * 3600_000)).select([...COLS, 'l.email as lead_email', 's.email as student_email', 'l.preferred_locale as lead_locale', 's.preferred_locale as student_locale']);
}

module.exports = { list, get, byToken, book, setStatus, reschedule, cancelByToken, update, dueReminders, STATUSES, base, COLS };
