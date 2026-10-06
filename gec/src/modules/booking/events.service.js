// Events (fairs, webinars, open days, information sessions): registration with capacity and wait-list, a QR ticket,
// check-in at the door, reminders and follow-up. Every registrant becomes (or updates) a CRM lead.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const events = require('../../core/events');
const { E } = require('../../core/errors');
const { randomToken } = require('../../core/tokens');
const activity = require('../crm/activity.service');

async function seatsTaken(eventId) {
  const [{ n }] = await knex('event_registrations').where({ event_id: eventId }).whereIn('status', ['registered', 'attended']).count({ n: '*' });
  return Number(n);
}

async function register(ctx, eventId, { name, email, phone, leadId = null, studentId = null }) {
  const ev = await knex('events').where({ id: eventId, is_active: true }).first();
  if (!ev) throw E.notFound('Event');
  if (!ev.registration_open || new Date(ev.ends_at || ev.starts_at) < new Date()) throw E.conflict('REGISTRATION_CLOSED', 'Registration for this event is closed.');
  const mail = email ? String(email).toLowerCase() : null;
  if (mail) {
    const existing = await knex('event_registrations').where({ event_id: eventId, email: mail }).first();
    if (existing && existing.status !== 'cancelled') return { registration: existing, existing: true };
    if (existing) await knex('event_registrations').where({ id: existing.id }).del();
  }
  const full = ev.capacity && (await seatsTaken(eventId)) >= ev.capacity;
  const [id] = await knex('event_registrations').insert({ event_id: eventId, lead_id: leadId, student_id: studentId, name, email: mail, phone: phone || null, ticket_token: randomToken(20), status: full ? 'waitlist' : 'registered' });
  const registration = await knex('event_registrations').where({ id }).first();
  await activity.log({ leadId, studentId }, { type: 'event', title: 'event_registered', meta: { event_en: ev.title_en, event_ar: ev.title_ar, status: registration.status }, actorId: ctx.userId || null, shareable: true });
  await audit.record(ctx, 'event.registered', { entityType: 'event_registration', entityId: id, newValues: { event_id: eventId, status: registration.status } });
  await events.emit('event.registered', { registration, event: ev });
  return { registration, existing: false };
}

async function byToken(token) {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(String(token || ''))) return null;
  return knex('event_registrations as r').join('events as e', 'e.id', 'r.event_id').where('r.ticket_token', token)
    .first('r.*', 'e.title_en', 'e.title_ar', 'e.starts_at', 'e.ends_at', 'e.is_virtual', 'e.location_en', 'e.location_ar', 'e.meeting_url', 'e.slug');
}

/** Door check-in from the QR code. Returns { registration, already }. */
async function checkIn(ctx, token) {
  const r = await byToken(token);
  if (!r) throw E.notFound('Ticket');
  if (r.status === 'cancelled') throw E.conflict('TICKET_CANCELLED', 'This ticket was cancelled.');
  if (r.status === 'attended') return { registration: r, already: true };
  await knex('event_registrations').where({ id: r.id }).update({ status: 'attended', checked_in_at: new Date(), checked_in_by: ctx.userId, updated_at: new Date() });
  await activity.log({ leadId: r.lead_id, studentId: r.student_id }, { type: 'event', title: 'event_attended', meta: { event_en: r.title_en, event_ar: r.title_ar }, actorId: ctx.userId, shareable: true });
  await audit.record(ctx, 'event.checked_in', { entityType: 'event_registration', entityId: r.id });
  await events.emit('event.attended', { registration: r });
  return { registration: { ...r, status: 'attended' }, already: false };
}

async function cancelByToken(token) {
  const r = await byToken(token);
  if (!r || r.status === 'cancelled') throw E.notFound();
  await knex('event_registrations').where({ id: r.id }).update({ status: 'cancelled', updated_at: new Date() });
  const next = await knex('event_registrations').where({ event_id: r.event_id, status: 'waitlist' }).orderBy('id').first();
  if (next) { await knex('event_registrations').where({ id: next.id }).update({ status: 'registered' }); await events.emit('event.promoted', { registrationId: next.id }); }
  return r;
}

module.exports = { register, byToken, checkIn, cancelByToken, seatsTaken };
