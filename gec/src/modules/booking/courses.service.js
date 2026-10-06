// Courses and training (IELTS preparation, English, SOP workshops…): registrations with capacity and wait-list,
// payment status, sessions with attendance, and certificates that anyone can verify.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const events = require('../../core/events');
const { E } = require('../../core/errors');
const { randomToken, shortCode } = require('../../core/tokens');
const people = require('../crm/people');
const activity = require('../crm/activity.service');

const ACTIVE = ['pending', 'confirmed', 'completed'];

async function seatsTaken(courseId) {
  const [{ n }] = await knex('course_registrations').where({ course_id: courseId }).whereIn('status', ACTIVE).count({ n: '*' });
  return Number(n);
}

async function register(ctx, courseId, { name, email, phone, studentId = null, leadId = null }) {
  const course = await knex('courses').where({ id: courseId, is_active: true }).first();
  if (!course) throw E.notFound('Course');
  if (!course.registration_open) throw E.conflict('REGISTRATION_CLOSED', 'Registration for this course is closed.');
  const mail = email ? String(email).toLowerCase() : null;
  if (mail) {
    const existing = await knex('course_registrations').where({ course_id: courseId, email: mail }).whereNot('status', 'cancelled').first();
    if (existing) return { registration: existing, existing: true };
  }
  const full = course.capacity && (await seatsTaken(courseId)) >= course.capacity;
  const free = !course.price;
  const row = {
    ref: await people.newRef('course_registrations', 'C'), course_id: courseId, student_id: studentId, lead_id: leadId, name, email: mail, phone: phone || null,
    status: full ? 'waitlist' : (free ? 'confirmed' : 'pending'), payment_status: free ? 'free' : 'unpaid', amount: course.price || null, currency: course.currency, manage_token: randomToken(24),
  };
  const [id] = await knex('course_registrations').insert(row);
  const registration = await knex('course_registrations').where({ id }).first();
  await activity.log({ leadId, studentId }, { type: 'course', title: 'course_registered', meta: { course_en: course.name_en, course_ar: course.name_ar, status: row.status }, actorId: ctx.userId || null, shareable: true });
  await audit.record(ctx, 'course.registered', { entityType: 'course_registration', entityId: id, newValues: { course_id: courseId, status: row.status } });
  await events.emit('course.registered', { registration, course, by: ctx.userId || null });
  return { registration, existing: false };
}

async function setStatus(ctx, regId, status) {
  if (!['pending', 'confirmed', 'waitlist', 'cancelled', 'completed'].includes(status)) throw E.validation({ status: 'Choose a valid option.' });
  const r = await knex('course_registrations').where({ id: regId }).first();
  if (!r) throw E.notFound();
  await knex('course_registrations').where({ id: regId }).update({ status, updated_at: new Date() });
  await audit.record(ctx, 'course.registration_status', { entityType: 'course_registration', entityId: regId, oldValues: { status: r.status }, newValues: { status } });
  // a freed seat goes to the first person on the wait-list
  if (status === 'cancelled' && ACTIVE.includes(r.status)) {
    const next = await knex('course_registrations').where({ course_id: r.course_id, status: 'waitlist' }).orderBy('id').first();
    if (next) {
      const course = await knex('courses').where({ id: r.course_id }).first('price');
      await knex('course_registrations').where({ id: next.id }).update({ status: course.price ? 'pending' : 'confirmed', updated_at: new Date() });
      await events.emit('course.promoted', { registrationId: next.id });
    }
  }
}

async function setPayment(ctx, regId, paymentStatus) {
  if (!['unpaid', 'paid', 'refunded', 'free'].includes(paymentStatus)) throw E.validation({ payment_status: 'Choose a valid option.' });
  const r = await knex('course_registrations').where({ id: regId }).first();
  if (!r) throw E.notFound();
  const upd = { payment_status: paymentStatus, updated_at: new Date() };
  if (paymentStatus === 'paid' && r.status === 'pending') upd.status = 'confirmed';
  await knex('course_registrations').where({ id: regId }).update(upd);
  await audit.record(ctx, 'course.payment_status', { entityType: 'course_registration', entityId: regId, oldValues: { payment_status: r.payment_status }, newValues: upd });
}

async function cancelByToken(token) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(token || ''))) throw E.notFound();
  const r = await knex('course_registrations as r').join('courses as c', 'c.id', 'r.course_id').where('r.manage_token', token).first('r.*', 'c.cancellable', 'c.start_date');
  if (!r || r.status === 'cancelled') throw E.notFound();
  if (!r.cancellable || (r.start_date && new Date(r.start_date) <= new Date())) throw E.conflict('NOT_CANCELLABLE', 'This registration can no longer be cancelled online. Please contact us.');
  await setStatus({ userId: null }, r.id, 'cancelled');
  return r;
}

async function saveAttendance(ctx, sessionId, presentIds) {
  const s = await knex('course_sessions').where({ id: sessionId }).first();
  if (!s) throw E.notFound();
  const regs = await knex('course_registrations').where({ course_id: s.course_id }).whereIn('status', ['confirmed', 'completed']).select('id');
  await knex.transaction(async (trx) => {
    await trx('course_attendance').where({ session_id: sessionId }).del();
    const rows = regs.map((r) => ({ session_id: sessionId, registration_id: r.id, present: presentIds.includes(r.id) }));
    if (rows.length) await trx('course_attendance').insert(rows);
  });
  await audit.record(ctx, 'course.attendance', { entityType: 'course_session', entityId: sessionId, newValues: { present: presentIds.length, total: regs.length } });
}

/** Marks a registration completed and issues a certificate number (verifiable at /certificates/:no). */
async function issueCertificate(ctx, regId) {
  const r = await knex('course_registrations').where({ id: regId }).first();
  if (!r || !['confirmed', 'completed'].includes(r.status)) throw E.validation({ status: 'Only confirmed registrations can receive a certificate.' });
  if (r.certificate_no) return r.certificate_no;
  const no = `GEC-${new Date().getUTCFullYear()}-${shortCode(6)}`;
  await knex('course_registrations').where({ id: regId }).update({ status: 'completed', certificate_no: no, certificate_issued_at: new Date(), updated_at: new Date() });
  await activity.log({ leadId: r.lead_id, studentId: r.student_id }, { type: 'course', title: 'certificate_issued', meta: { no }, actorId: ctx.userId, shareable: true });
  await audit.record(ctx, 'course.certificate_issued', { entityType: 'course_registration', entityId: regId, newValues: { certificate_no: no } });
  return no;
}

async function certificate(no) {
  if (!/^GEC-\d{4}-[A-Z0-9]{6}$/.test(String(no || ''))) return null;
  return knex('course_registrations as r').join('courses as c', 'c.id', 'r.course_id').where('r.certificate_no', no)
    .first('r.name', 'r.certificate_no', 'r.certificate_issued_at', 'c.name_en', 'c.name_ar', 'c.start_date', 'c.end_date', 'c.instructor_name');
}

module.exports = { register, setStatus, setPayment, cancelByToken, saveAttendance, issueCertificate, certificate, seatsTaken };
