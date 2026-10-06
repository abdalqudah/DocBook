// Staff: agenda, booking for a lead / student with live free slots, appointment detail, availability,
// course registrations with sessions / attendance / certificates, event registrations with check-in.
const express = require('express');
const knex = require('../../db/knex');
const fmt = require('../../core/format');
const audit = require('../../core/audit');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { safeBack } = require('../../middleware/errors');
const { ah, idParam } = require('../../core/http');
const { validate, z, str } = require('../../core/validate');
const { E } = require('../../core/errors');
const { toCsv } = require('../../core/csv');
const nav = require('../staff/nav');
const registry = require('../staff/registry');
const dashboard = require('../staff/dashboard');
const settingsWeb = require('../settings/web');
const tabs = require('../crm/tabs');
const leads = require('../crm/leads.service');
const students = require('../crm/students.service');
const people = require('../crm/people');
const scheduling = require('./scheduling');
const appointments = require('./appointments.service');
const courses = require('./courses.service');
const eventsSvc = require('./events.service');
const admin = require('./admin');
require('./handlers');

nav.add('engagement', { key: 'appointments', href: '/staff/appointments', icon: 'calendar-check', perms: ['appointments.view'] }, { before: 'tasks' });
nav.add('engagement', { key: 'courses', href: '/staff/courses', icon: 'book-marked', perms: ['courses.manage'] });
nav.add('engagement', { key: 'events', href: '/staff/events', icon: 'ticket', perms: ['events.manage'] });
settingsWeb.addSection({ key: 'appointment_types', icon: 'calendar-days', href: '/staff/appointment-types', perms: ['settings.manage'] });
registry.addAction({ key: 'appointment', icon: 'calendar-check', href: '/staff/appointments/new', perms: ['appointments.manage'] });

registry.addAttention(async (req) => {
  if (!req.can('appointments.view')) return [];
  const start = new Date(); const end = new Date(); end.setUTCHours(23, 59, 59, 999);
  const rows = await appointments.list(req.staff, { from: new Date(start.getTime() - 3600_000), to: end, mine: req.staff.employee.dataScope === 'own' });
  return rows.filter((a) => ['scheduled', 'confirmed'].includes(a.status)).map((a) => ({
    kind: 'appointment', icon: 'calendar-check', tone: 'brand', title: req.t('attention.appointment_today', { type: req.locale === 'ar' ? a.type_ar || a.type_en : a.type_en, name: people.fullName({ first_name: a.student_first || a.lead_first || a.contact_name, last_name: a.student_last || a.lead_last }) }),
    sub: `${fmt.formatTime(a.start_at, req.locale, req.res.locals.fmt.tz)} · ${a.employee_name || ''}`, href: `/staff/appointments/${a.id}`, chip: req.t('common.today'), due: a.start_at,
  }));
});
dashboard.page.kpis.push(async (req) => {
  if (!req.can('appointments.view')) return [];
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [{ n }] = await appointments.base(req.staff).where('a.start_at', '>=', monthStart).where('a.status', 'completed').count({ n: '*' });
  return [{ key: 'consultations', label: req.t('kpi.consultations'), value: Number(n), href: '/staff/appointments' }];
});
tabs.add({ key: 'appointments', icon: 'calendar-check', perms: ['appointments.view'], order: 15, view: 'pages/staff/booking/tab-appointments',
  load: async (req, s) => ({ s, list: await appointments.base(req.staff).where((w) => w.where('a.student_id', s.id).orWhereIn('a.lead_id', knex('leads').where({ student_id: s.id }).select('id'))).select(appointments.COLS).orderBy('a.start_at', 'desc').limit(50) }) });

const router = express.Router();

// ------------------------------------------------------------- Agenda
router.get('/appointments', can('appointments.view'), ah(async (req, res) => {
  const tz = res.locals.fmt.tz;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : fmt.zonedDate(new Date(), tz);
  const days = req.query.range === 'day' ? 1 : 7;
  const from = fmt.zonedToUtc(`${day}T00:00`, tz);
  const to = new Date(from.getTime() + days * 86400_000);
  const rows = await appointments.list(req.staff, { from, to, status: req.query.status, employee: req.query.employee, mine: req.query.mine === '1' });
  const groups = [];
  rows.forEach((a) => { const k = fmt.zonedDate(a.start_at, tz); let g = groups.find((x) => x.day === k); if (!g) { g = { day: k, items: [] }; groups.push(g); } g.items.push(a); });
  res.page('pages/staff/booking/agenda', {
    layout: 'staff', title: req.t('nav.appointments'), groups, day, days, prev: fmt.toDateInput(new Date(from.getTime() - days * 86400_000)), next: fmt.toDateInput(to),
    employeesList: await admin.employeesOptions(), statuses: appointments.STATUSES,
  });
}));

router.get('/appointments/new', can('appointments.manage'), ah(async (req, res) => {
  const types = await knex('appointment_types').where({ is_active: true }).orderBy('position');
  const type = types.find((t) => String(t.id) === String(req.query.type)) || types[0] || null;
  const lead = req.query.lead_id ? await leads.get(req.staff, idParam(req.query.lead_id)) : null;
  const student = req.query.student_id ? await students.get(req.staff, idParam(req.query.student_id)) : null;
  const tz = res.locals.fmt.tz;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : fmt.zonedDate(new Date(), tz);
  const data = type ? await scheduling.slots(type.id, { fromDate: date, days: 1, employeeId: req.query.employee ? Number(req.query.employee) : null, staff: true }) : { slots: [], staff: [] };
  const upcoming = data.slots.filter((s) => s.start > new Date());
  res.page('pages/staff/booking/new', { layout: 'staff', narrow: true, title: req.t('booking.new_appointment'), types, type, lead, student, date, slots: upcoming, staffList: data.staff, prevDay: fmt.toDateInput(new Date(new Date(`${date}T12:00:00Z`).getTime() - 86400_000)), nextDay: fmt.toDateInput(new Date(new Date(`${date}T12:00:00Z`).getTime() + 86400_000)) });
}));

router.post('/appointments', can('appointments.manage'), ah(async (req, res) => {
  const d = validate(z.object({ type_id: z.coerce.number().int().positive(), employee_id: z.coerce.number().int().positive(), start: z.string().min(10), mode: z.enum(['online', 'in_person']).optional(),
    lead_id: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()), student_id: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
    notes: str(2000), meeting_url: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().max(500).optional()) }), req.body);
  if (d.lead_id) await leads.get(req.staff, d.lead_id);
  if (d.student_id) await students.get(req.staff, d.student_id);
  try {
    const a = await appointments.book(req.ctx, { typeId: d.type_id, employeeId: d.employee_id, start: d.start, mode: d.mode, leadId: d.lead_id || null, studentId: d.student_id || null, notes: d.notes, meetingUrl: d.meeting_url, via: 'staff' });
    flash(req, 'ok', req.t('booking.booked'));
    return res.redirect(`/staff/appointments/${a.id}`);
  } catch (e) {
    if (e.code === 'SLOT_TAKEN' || e.code === 'SLOT_BUSY') { flash(req, 'error', req.t(`errors.${e.code}`)); return res.redirect(safeBack(req, '/staff/appointments/new')); }
    throw e;
  }
}));

router.get('/appointments/availability', can('appointments.view'), ah(async (req, res) => {
  const empId = req.query.employee && req.can('settings.manage') ? idParam(req.query.employee) : req.staff.employee.id;
  const emp = await knex('employees as e').join('users as u', 'u.id', 'e.user_id').leftJoin('branches as b', 'b.id', 'e.branch_id').where('e.id', empId).first('e.id', 'u.name', 'b.timezone');
  if (!emp) throw E.notFound();
  res.page('pages/staff/booking/availability', {
    layout: 'staff', narrow: true, title: req.t('booking.availability'), emp, hours: await knex('availability').where({ employee_id: empId }).orderBy('weekday').orderBy('start_time'),
    exceptions: await knex('availability_exceptions').where({ employee_id: empId }).where('date', '>=', fmt.today()).orderBy('date'), employeesList: req.can('settings.manage') ? await admin.employeesOptions() : [],
    typesFor: await knex('appointment_type_staff as ts').join('appointment_types as t', 't.id', 'ts.type_id').where('ts.employee_id', empId).select('t.name_en', 't.name_ar'),
  });
}));

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
router.post('/appointments/availability', can('appointments.view'), ah(async (req, res) => {
  const empId = req.body.employee && req.can('settings.manage') ? idParam(req.body.employee) : req.staff.employee.id;
  const rows = [];
  for (let wd = 0; wd < 7; wd += 1) {
    const starts = [].concat(req.body[`start_${wd}`] || []);
    const ends = [].concat(req.body[`end_${wd}`] || []);
    starts.forEach((s, i) => { const e = ends[i]; if (HHMM.test(s || '') && HHMM.test(e || '') && s < e) rows.push({ employee_id: empId, weekday: wd, start_time: s, end_time: e }); });
  }
  await knex.transaction(async (trx) => { await trx('availability').where({ employee_id: empId }).del(); if (rows.length) await trx('availability').insert(rows); });
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.body.off_date || '')) {
    await knex('availability_exceptions').insert({ employee_id: empId, date: req.body.off_date, is_off: !(HHMM.test(req.body.off_start || '') && HHMM.test(req.body.off_end || '')), start_time: HHMM.test(req.body.off_start || '') ? req.body.off_start : null, end_time: HHMM.test(req.body.off_end || '') ? req.body.off_end : null, note: String(req.body.off_note || '').slice(0, 190) || null });
  }
  const remove = [].concat(req.body.remove_exception || []).map(Number).filter(Boolean);
  if (remove.length) await knex('availability_exceptions').where({ employee_id: empId }).whereIn('id', remove).del();
  await audit.record(req.ctx, 'availability.updated', { entityType: 'employee', entityId: empId, newValues: { windows: rows.length } });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect(`/staff/appointments/availability${empId !== req.staff.employee.id ? `?employee=${empId}` : ''}`);
}));

router.get('/appointments/:id', can('appointments.view'), ah(async (req, res) => {
  const a = await appointments.get(req.staff, idParam(req.params.id));
  const tz = res.locals.fmt.tz;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : fmt.zonedDate(new Date(Math.max(Date.now(), new Date(a.start_at).getTime())), tz);
  const resched = req.query.reschedule === '1' ? await scheduling.slots(a.type_id, { fromDate: date, days: 1, employeeId: a.employee_id, staff: true }) : null;
  res.page('pages/staff/booking/appointment', { layout: 'staff', narrow: true, title: `${a.ref}`, a, resched, date, statuses: appointments.STATUSES });
}));

router.post('/appointments/:id/status', can('appointments.manage'), ah(async (req, res) => {
  await appointments.setStatus(req.ctx, req.staff, idParam(req.params.id), String(req.body.status), { reason: req.body.reason });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect(safeBack(req, `/staff/appointments/${req.params.id}`));
}));

router.post('/appointments/:id', can('appointments.manage'), ah(async (req, res) => {
  const d = validate(z.object({ meeting_url: z.preprocess((v) => (v === '' ? null : v), z.string().url('Enter a full address starting with https://').max(500).nullable()), notes: str(2000), location: str(255) }), req.body);
  await appointments.update(req.ctx, req.staff, idParam(req.params.id), { meetingUrl: d.meeting_url, notes: d.notes || null, location: d.location || null });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect(`/staff/appointments/${req.params.id}`);
}));

router.post('/appointments/:id/reschedule', can('appointments.manage'), ah(async (req, res) => {
  const a = await appointments.get(req.staff, idParam(req.params.id));
  try {
    const n = await appointments.reschedule(req.ctx, a, { start: req.body.start, via: 'staff' });
    flash(req, 'ok', req.t('booking.rescheduled'));
    return res.redirect(`/staff/appointments/${n.id}`);
  } catch (e) {
    if (['SLOT_TAKEN', 'SLOT_BUSY', 'NOT_RESCHEDULABLE'].includes(e.code)) { flash(req, 'error', req.t(`errors.${e.code}`)); return res.redirect(`/staff/appointments/${a.id}?reschedule=1`); }
    throw e;
  }
}));

// ------------------------------------------------------------- Courses: registrations, sessions, attendance, certificates
/** The course, if this staff member may see its registrants (see admin.canSeeRegistrants). */
async function courseFor(req, id) {
  const course = await knex('courses').where({ id }).first();
  if (!course) throw E.notFound();
  if (!admin.canSeeRegistrants(req.staff, course, 'instructor_id')) throw E.notFound();
  return course;
}

router.get('/courses/:id/registrations', can('courses.manage'), ah(async (req, res) => {
  const course = await courseFor(req, idParam(req.params.id));
  const regs = await knex('course_registrations').where({ course_id: course.id }).orderBy('created_at');
  const sessions = await knex('course_sessions').where({ course_id: course.id }).orderBy('starts_at');
  const att = await knex('course_attendance').whereIn('session_id', sessions.map((s) => s.id));
  if (req.query.format === 'csv') {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="course-${course.slug}.csv"` });
    return res.send(toCsv(['ref', 'name', 'email', 'phone', 'status', 'payment_status', 'certificate_no', 'created_at'].map((k) => ({ key: k })), regs));
  }
  return res.page('pages/staff/booking/course-registrations', { layout: 'staff', title: course.name_en, course, regs, sessions, att, seats: await courses.seatsTaken(course.id) });
}));

router.post('/courses/:id/sessions', can('courses.manage'), ah(async (req, res) => {
  const course = await courseFor(req, idParam(req.params.id));
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(req.body.starts_at || '')) throw E.validation({ starts_at: 'Enter a valid date and time.' });
  await knex('course_sessions').insert({ course_id: course.id, starts_at: fmt.zonedToUtc(req.body.starts_at, res.locals.fmt.tz), topic: String(req.body.topic || '').slice(0, 190) || null });
  res.redirect(`/staff/courses/${course.id}/registrations`);
}));

router.post('/courses/sessions/:sid/attendance', can('courses.manage'), ah(async (req, res) => {
  const present = [].concat(req.body.present || []).map(Number).filter(Boolean);
  const session = await knex('course_sessions').where({ id: idParam(req.params.sid) }).first();
  if (!session) throw E.notFound();
  await courseFor(req, session.course_id);
  await courses.saveAttendance(req.ctx, session.id, present);
  flash(req, 'ok', req.t('common.saved'));
  res.redirect(safeBack(req, '/staff/courses'));
}));

router.post('/courses/registrations/:rid', can('courses.manage'), ah(async (req, res) => {
  const rid = idParam(req.params.rid);
  const reg = await knex('course_registrations').where({ id: rid }).first();
  if (!reg) throw E.notFound();
  await courseFor(req, reg.course_id);
  if (req.body.status) await courses.setStatus(req.ctx, rid, String(req.body.status));
  if (req.body.payment_status) await courses.setPayment(req.ctx, rid, String(req.body.payment_status));
  if (req.body.certificate === '1') await courses.issueCertificate(req.ctx, rid);
  flash(req, 'ok', req.t('common.saved'));
  res.redirect(safeBack(req, '/staff/courses'));
}));

// ------------------------------------------------------------- Events: registrations and check-in
router.get('/events/:id/registrations', can('events.manage'), ah(async (req, res) => {
  const ev = await knex('events').where({ id: idParam(req.params.id) }).first();
  if (!ev || !admin.canSeeRegistrants(req.staff, ev, 'organizer_id')) throw E.notFound();
  const regs = await knex('event_registrations').where({ event_id: ev.id }).orderBy('created_at');
  if (req.query.format === 'csv') {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="event-${ev.slug}.csv"` });
    return res.send(toCsv(['name', 'email', 'phone', 'status', 'checked_in_at', 'created_at'].map((k) => ({ key: k })), regs));
  }
  return res.page('pages/staff/booking/event-registrations', { layout: 'staff', title: ev.title_en, ev, regs });
}));

router.get('/events/checkin/:token', can('events.manage'), ah(async (req, res) => {
  const r = await eventsSvc.byToken(req.params.token);
  res.page('pages/staff/booking/checkin', { layout: 'staff', narrow: true, title: req.t('booking.check_in'), r, token: req.params.token, done: null });
}));
router.post('/events/checkin/:token', can('events.manage'), ah(async (req, res) => {
  const result = await eventsSvc.checkIn(req.ctx, req.params.token);
  res.page('pages/staff/booking/checkin', { layout: 'staff', narrow: true, title: req.t('booking.check_in'), r: result.registration, token: req.params.token, done: result.already ? 'already' : 'ok' });
}));
router.post('/events/checkin', can('events.manage'), ah(async (req, res) => {
  const m = /([A-Za-z0-9_-]{16,40})\/?$/.exec(String(req.body.code || '').trim());
  return res.redirect(m ? `/staff/events/checkin/${m[1]}` : safeBack(req, '/staff/events'));
}));

// Resource CRUD last, so the specific routes above win over /:id.
router.use('/appointment-types', admin.appointmentTypes.router);
router.use('/courses', admin.courses.router);
router.use('/events', admin.events.router);

module.exports = router;
