// Public: pick a time with a counsellor (/book/schedule), manage a booking by its private link, courses with
// registration, events with QR tickets, certificate verification.
const express = require('express');
const QRCode = require('qrcode');
const knex = require('../../db/knex');
const config = require('../../config');
const fmt = require('../../core/format');
const limits = require('../../middleware/limits');
const { ah } = require('../../core/http');
const { E } = require('../../core/errors');
const { validate, z, reqStr, str, optEmail, phone } = require('../../core/validate');
const { markdown } = require('../../core/markdown');
const capture = require('../site/capture');
const nav = require('../site/nav');
const footer = require('../site/footer');
const scheduling = require('./scheduling');
const appointments = require('./appointments.service');
const courses = require('./courses.service');
const eventsSvc = require('./events.service');

nav.add({ key: 'events', href: '/events', order: 50 });
footer.add('students', { href: '/courses', label: 'site.nav.courses' });
footer.add('company', { href: '/events', label: 'site.nav.events' });

const router = express.Router();
const L = (req, row, f) => (req.locale === 'ar' ? row[`${f}_ar`] || row[`${f}_en`] : row[`${f}_en`] || row[`${f}_ar`]) || '';
const contactSchema = z.object({
  first_name: reqStr(80), last_name: str(80), email: optEmail(), phone: phone(), notes: str(2000), consent_contact: z.literal('1', { errorMap: () => ({ message: 'Required.' }) }),
}).refine((d) => d.email || d.phone, { message: 'Enter an email or a phone number.', path: ['email'] });

// ------------------------------------------------------------------ Scheduler
router.get('/book/schedule', ah(async (req, res) => {
  const types = await knex('appointment_types as t').where({ 't.is_active': true, 't.is_public': true }).whereExists(knex('appointment_type_staff').whereRaw('type_id = t.id')).orderBy('position');
  if (types.length === 1) return res.redirect(`/book/schedule/${types[0].slug}`);
  return res.page('pages/site/schedule-types', { layout: 'public', title: req.t('booking.pick_service'), types, seo: { title: req.t('booking.pick_service'), canonical: `${config.appUrl}/book/schedule` } });
}));

async function typeBySlug(slug) {
  const t = await knex('appointment_types').where({ slug, is_active: true, is_public: true }).first();
  if (!t) throw E.notFound('Appointment type');
  return t;
}

router.get('/book/schedule/:slug', ah(async (req, res) => {
  const type = await typeBySlug(req.params.slug);
  const employeeId = /^\d+$/.test(req.query.with || '') ? Number(req.query.with) : null;
  const tz = res.locals.fmt.tz;
  const today = fmt.zonedDate(new Date(), tz);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') && req.query.from >= today ? req.query.from : today;
  const { slots, staff } = await scheduling.slots(type.id, { fromDate: from, days: 7, employeeId });
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const d = fmt.toDateInput(new Date(new Date(`${from}T12:00:00Z`).getTime() + i * 86400_000));
    days.push({ date: d, slots: slots.filter((s) => fmt.zonedDate(s.start, tz) === d) });
  }
  res.page('pages/site/schedule', {
    layout: 'public', title: L(req, type, 'name'), type, staff, days, employeeId, from,
    prev: from > today ? fmt.toDateInput(new Date(new Date(`${from}T12:00:00Z`).getTime() - 7 * 86400_000)) : null, next: fmt.toDateInput(new Date(new Date(`${from}T12:00:00Z`).getTime() + 7 * 86400_000)),
    seo: { title: L(req, type, 'name'), noindex: Object.keys(req.query).length > 0, canonical: `${config.appUrl}/book/schedule/${type.slug}` },
  });
}));

router.get('/book/schedule/:slug/confirm', ah(async (req, res) => {
  const type = await typeBySlug(req.params.slug);
  const start = new Date(String(req.query.start || ''));
  if (Number.isNaN(start.getTime())) return res.redirect(`/book/schedule/${type.slug}`);
  const emp = await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('e.id', Number(req.query.with)).first('e.id', 'u.name', 'e.job_title');
  if (!emp) return res.redirect(`/book/schedule/${type.slug}`);
  return res.page('pages/site/schedule-confirm', { layout: 'public', title: req.t('booking.confirm_title'), type, start, emp, old: {}, errors: {}, seo: { noindex: true } });
}));

router.post('/book/schedule/:slug/confirm', limits.publicForm, ah(async (req, res) => {
  const type = await typeBySlug(req.params.slug);
  if (capture.isBot(req)) return res.redirect('/book/thanks');
  const start = new Date(String(req.body.start || ''));
  const emp = await knex('employees as e').join('users as u', 'u.id', 'e.user_id').leftJoin('branches as b', 'b.id', 'e.branch_id').where('e.id', Number(req.body.with)).first('e.id', 'u.name', 'e.job_title', 'b.timezone as tz');
  if (Number.isNaN(start.getTime()) || !emp) return res.redirect(`/book/schedule/${type.slug}`);
  try {
    const d = validate(contactSchema, req.body);
    // Check the time is still free before recording the enquiry; booking re-checks under a lock.
    const free = await scheduling.slots(type.id, { fromDate: fmt.zonedDate(start, emp.tz || 'UTC'), days: 1, employeeId: emp.id });
    if (!free.slots.some((x) => x.start.getTime() === start.getTime())) throw E.conflict('SLOT_TAKEN', 'This time is no longer available.');
    const { lead } = await capture.submit(req, 'consultation', { first_name: d.first_name, last_name: d.last_name, email: d.email, phone: d.phone, message: d.notes, preferred_locale: req.locale, interest_type: 'general', interest_ref: type.name_en });
    const appt = await appointments.book({ userId: req.user ? req.user.id : null, ip: req.ip }, {
      typeId: type.id, employeeId: emp.id, start, mode: req.body.mode, leadId: lead.id, studentId: lead.student_id || null, via: 'website',
      contact: { name: [d.first_name, d.last_name].filter(Boolean).join(' '), email: d.email, phone: d.phone }, notes: d.notes,
    });
    return res.redirect(`/appointments/${appt.manage_token}?booked=1`);
  } catch (e) {
    if (e.code === 'VALIDATION_FAILED') { res.status(422); return res.page('pages/site/schedule-confirm', { layout: 'public', title: req.t('booking.confirm_title'), type, start, emp, old: req.body, errors: e.details, seo: { noindex: true } }); }
    if (['SLOT_TAKEN', 'SLOT_BUSY', 'SLOT_TOO_SOON'].includes(e.code)) {
      res.status(409);
      return res.page('pages/site/schedule-confirm', { layout: 'public', title: req.t('booking.confirm_title'), type, start, emp, old: req.body, errors: {}, taken: true, seo: { noindex: true } });
    }
    throw e;
  }
}));

// ------------------------------------------------------------------ Manage a booking (private link)
router.get('/appointments/:token', ah(async (req, res) => {
  const a = await appointments.byToken(req.params.token);
  if (!a) throw E.notFound('Appointment');
  const tz = res.locals.fmt.tz;
  let resched = null;
  if (req.query.reschedule === '1' && ['scheduled', 'confirmed'].includes(a.status)) {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : fmt.zonedDate(new Date(), tz);
    const { slots } = await scheduling.slots(a.type_id, { fromDate: from, days: 7, employeeId: a.employee_id });
    resched = { from, slots, next: fmt.toDateInput(new Date(new Date(`${from}T12:00:00Z`).getTime() + 7 * 86400_000)) };
  }
  res.page('pages/site/appointment', { layout: 'public', title: req.t('booking.your_booking'), a, resched, booked: req.query.booked === '1', token: req.params.token, seo: { noindex: true } });
}));

router.get('/appointments/:token/calendar.ics', ah(async (req, res) => {
  const a = await appointments.byToken(req.params.token);
  if (!a) throw E.notFound();
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="gec-appointment.ics"' });
  res.send(scheduling.ics({ uid: `${a.ref}@gec`, start: a.start_at, end: a.end_at, title: a.type_en, description: a.meeting_url || '', location: a.mode === 'online' ? 'Online' : (a.location || ''), url: `${config.appUrl}/appointments/${req.params.token}` }));
}));

router.post('/appointments/:token/cancel', limits.publicForm, ah(async (req, res) => {
  await appointments.cancelByToken(req.params.token, req.body.reason);
  res.redirect(`/appointments/${req.params.token}`);
}));

router.post('/appointments/:token/reschedule', limits.publicForm, ah(async (req, res) => {
  const a = await appointments.byToken(req.params.token);
  if (!a) throw E.notFound();
  try {
    const n = await appointments.reschedule({ userId: null, ip: req.ip }, a, { start: req.body.start, via: 'website' });
    return res.redirect(`/appointments/${n.manage_token}?booked=1`);
  } catch (e) {
    if (['SLOT_TAKEN', 'SLOT_BUSY', 'SLOT_TOO_SOON', 'NOT_RESCHEDULABLE'].includes(e.code)) {
      req.session.flash = [{ type: 'error', message: req.t(`errors.${e.code}`) }];
      return res.redirect(`/appointments/${req.params.token}?reschedule=1`);
    }
    throw e;
  }
}));

// ------------------------------------------------------------------ Courses
router.get('/courses', ah(async (req, res) => {
  const rows = await knex('courses').where({ is_active: true }).orderByRaw('start_date IS NULL, start_date');
  res.page('pages/site/courses', { layout: 'public', title: req.t('courses.title'), rows, seo: { title: req.t('courses.title'), description: req.t('courses.lead'), canonical: `${config.appUrl}/courses` } });
}));

router.get('/courses/registration/:token', ah(async (req, res) => {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(req.params.token)) throw E.notFound();
  const r = await knex('course_registrations as r').join('courses as c', 'c.id', 'r.course_id').where('r.manage_token', req.params.token).first('r.*', 'c.name_en', 'c.name_ar', 'c.slug', 'c.start_date', 'c.end_date', 'c.cancellable', 'c.location', 'c.mode');
  if (!r) throw E.notFound();
  res.page('pages/site/course-registration', { layout: 'public', title: L(req, r, 'name'), r, token: req.params.token, seo: { noindex: true } });
}));
router.post('/courses/registration/:token/cancel', limits.publicForm, ah(async (req, res) => {
  await courses.cancelByToken(req.params.token);
  res.redirect(`/courses/registration/${req.params.token}`);
}));

router.get('/courses/:slug', ah(async (req, res) => {
  const c = await knex('courses').where({ slug: req.params.slug, is_active: true }).first();
  if (!c) throw E.notFound('Course');
  const seats = await courses.seatsTaken(c.id);
  const sessions = await knex('course_sessions').where({ course_id: c.id }).orderBy('starts_at');
  res.page('pages/site/course', { layout: 'public', title: L(req, c, 'name'), c, seats, sessions, md: markdown, old: {}, errors: {}, seo: { title: L(req, c, 'seo_title') || L(req, c, 'name'), description: L(req, c, 'seo_description') || require('../../core/markdown').excerpt(L(req, c, 'description')), canonical: `${config.appUrl}/courses/${c.slug}`, image: c.image } }); // eslint-disable-line global-require
}));

const regSchema = z.object({ name: reqStr(160), email: optEmail(), phone: phone(), consent_contact: z.literal('1', { errorMap: () => ({ message: 'Required.' }) }) }).refine((d) => d.email || d.phone, { message: 'Enter an email or a phone number.', path: ['email'] });

router.post('/courses/:slug', limits.publicForm, ah(async (req, res) => {
  const c = await knex('courses').where({ slug: req.params.slug, is_active: true }).first();
  if (!c) throw E.notFound('Course');
  if (capture.isBot(req)) return res.redirect(`/courses/${c.slug}`);
  try {
    const d = validate(regSchema, req.body);
    const parts = d.name.trim().split(/\s+/);
    const { lead } = await capture.submit(req, 'course_inquiry', { first_name: parts[0], last_name: parts.slice(1).join(' ') || null, email: d.email, phone: d.phone, preferred_locale: req.locale, interest_type: 'course', interest_ref: c.name_en });
    const { registration } = await courses.register({ userId: req.user ? req.user.id : null }, c.id, { name: d.name, email: d.email, phone: d.phone, leadId: lead.id, studentId: lead.student_id || null });
    return res.redirect(`/courses/registration/${registration.manage_token}?new=1`);
  } catch (e) {
    if (e.code === 'REGISTRATION_CLOSED') { req.session.flash = [{ type: 'error', message: req.t('errors.REGISTRATION_CLOSED') }]; return res.redirect(`/courses/${c.slug}`); }
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return res.page('pages/site/course', { layout: 'public', title: L(req, c, 'name'), c, seats: await courses.seatsTaken(c.id), sessions: [], md: markdown, old: req.body, errors: e.details, seo: { noindex: true } });
  }
}));

// ------------------------------------------------------------------ Events
router.get('/events', ah(async (req, res) => {
  const now = new Date();
  const upcoming = await knex('events').where({ is_active: true }).whereRaw('COALESCE(ends_at, starts_at) >= ?', [now]).orderBy('starts_at');
  const past = await knex('events').where({ is_active: true }).whereRaw('COALESCE(ends_at, starts_at) < ?', [now]).orderBy('starts_at', 'desc').limit(6);
  res.page('pages/site/events', { layout: 'public', title: req.t('events.title'), upcoming, past, seo: { title: req.t('events.title'), description: req.t('events.lead'), canonical: `${config.appUrl}/events` } });
}));

router.get('/events/:slug', ah(async (req, res) => {
  const ev = await knex('events').where({ slug: req.params.slug, is_active: true }).first();
  if (!ev) throw E.notFound('Event');
  const seats = await eventsSvc.seatsTaken(ev.id);
  const parse = (v) => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v || '[]'); } catch { return []; } })());
  ev.speakers_en = parse(ev.speakers_en); ev.speakers_ar = parse(ev.speakers_ar);
  delete ev.meeting_url; // only on tickets
  res.page('pages/site/event', { layout: 'public', title: L(req, ev, 'title'), ev, seats, md: markdown, old: {}, errors: {}, seo: {
    title: L(req, ev, 'seo_title') || L(req, ev, 'title'), description: L(req, ev, 'seo_description') || require('../../core/markdown').excerpt(L(req, ev, 'description')), canonical: `${config.appUrl}/events/${ev.slug}`, image: ev.image, // eslint-disable-line global-require
    jsonld: { '@context': 'https://schema.org', '@type': 'Event', name: L(req, ev, 'title'), startDate: new Date(ev.starts_at).toISOString(), endDate: ev.ends_at ? new Date(ev.ends_at).toISOString() : undefined,
      eventAttendanceMode: ev.is_virtual ? 'https://schema.org/OnlineEventAttendanceMode' : 'https://schema.org/OfflineEventAttendanceMode', location: ev.is_virtual ? { '@type': 'VirtualLocation', url: `${config.appUrl}/events/${ev.slug}` } : { '@type': 'Place', name: L(req, ev, 'location') || 'GEC' },
      organizer: { '@type': 'Organization', name: res.locals.branding.legal_name, url: config.appUrl } },
  } });
}));

router.post('/events/:slug', limits.publicForm, ah(async (req, res) => {
  const ev = await knex('events').where({ slug: req.params.slug, is_active: true }).first();
  if (!ev) throw E.notFound('Event');
  if (capture.isBot(req)) return res.redirect(`/events/${ev.slug}`);
  try {
    const d = validate(regSchema, req.body);
    const parts = d.name.trim().split(/\s+/);
    const { lead } = await capture.submit(req, 'event', { first_name: parts[0], last_name: parts.slice(1).join(' ') || null, email: d.email, phone: d.phone, preferred_locale: req.locale, interest_type: 'event', interest_ref: ev.title_en });
    const { registration } = await eventsSvc.register({ userId: null }, ev.id, { name: d.name, email: d.email, phone: d.phone, leadId: lead.id, studentId: lead.student_id || null });
    return res.redirect(`/tickets/${registration.ticket_token}?new=1`);
  } catch (e) {
    if (e.code === 'REGISTRATION_CLOSED') { req.session.flash = [{ type: 'error', message: req.t('errors.REGISTRATION_CLOSED') }]; return res.redirect(`/events/${ev.slug}`); }
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return res.page('pages/site/event', { layout: 'public', title: L(req, ev, 'title'), ev: { ...ev, speakers_en: [], speakers_ar: [] }, seats: await eventsSvc.seatsTaken(ev.id), md: markdown, old: req.body, errors: e.details, seo: { noindex: true } });
  }
}));

router.get('/tickets/:token', ah(async (req, res) => {
  const r = await eventsSvc.byToken(req.params.token);
  if (!r) throw E.notFound('Ticket');
  const checkinUrl = `${config.appUrl}/staff/events/checkin/${r.ticket_token}`;
  const svg = await QRCode.toString(checkinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0a0f0c', light: '#ffffff' } });
  res.page('pages/site/ticket', { layout: 'public', title: L(req, r, 'title'), r, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, isNew: req.query.new === '1', seo: { noindex: true } });
}));
router.post('/tickets/:token/cancel', limits.publicForm, ah(async (req, res) => {
  await eventsSvc.cancelByToken(req.params.token);
  res.redirect(`/tickets/${req.params.token}`);
}));

// ------------------------------------------------------------------ Certificates
router.get('/certificates/:no', ah(async (req, res) => {
  const c = await courses.certificate(req.params.no);
  res.status(c ? 200 : 404).page('pages/site/certificate', { layout: 'public', title: req.t('courses.certificate'), c, no: req.params.no, seo: { noindex: true } });
}));

module.exports = router;
