// Public online booking: docbook/<slug>/book. One page with progressive enhancement — without JavaScript
// the "Show free times" button re-renders the page with the free times; with JavaScript they load from
// /<slug>/book/slots as the patient picks a doctor, service and date. Bookings arrive as pending
// (source "website") and notify the clinic's staff.
const express = require('express');
const rateLimit = require('express-rate-limit');
const knex = require('../../db/knex');
const config = require('../../config');
const { z, validate, isoDate, emptyToUndefined, optionalString } = require('../../core/validate');
const { AppError } = require('../../core/errors');
const { wrap } = require('../../routes/helpers');
const { translateMessage } = require('../../core/i18n');
const scheduling = require('../clinic/scheduling');
const appointments = require('../clinic/appointments.service');
const { loadClinic, clinicStyles, listDoctors, listServices } = require('./portal.web');

const router = express.Router();
const HORIZON_DAYS = 60;
const MAX_PENDING_PER_PHONE = 3;

// 10 booking requests per hour per IP; the free-times endpoint gets a looser limit.
const bookLimiter = rateLimit({ windowMs: 60 * 60_000, limit: config.isTest ? 1000 : 10, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => { req.bookingLimited = true; next(); } });
const slotsLimiter = rateLimit({ windowMs: 10 * 60_000, limit: config.isTest ? 5000 : 300, standardHeaders: true, legacyHeaders: false, handler: (req, res) => res.status(429).json({ data: [], error: req.t('booking.rate_limited') }) });

const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const range = (clinic) => { const today = scheduling.clinicNow(clinic.timezone).date; return { min: today, max: addDays(today, HORIZON_DAYS) }; };
const cleanPhone = (v) => String(v || '').trim().replace(/[\s().-]/g, '');
const PHONE_RE = /^\+?[0-9]{7,15}$/;
const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/** A clinic context for the public booking (no signed-in user). */
const publicCtx = (req, clinic) => ({
  businessId: clinic.id, timezone: clinic.timezone, currency: clinic.currency, userId: null, permissions: new Set(),
  ip: req.ip, userAgent: req.get('user-agent'), locale: req.locale,
});

/** Free times for doctor/date/service in this clinic — or [] with a translated reason. */
async function freeTimes(req, clinic, { doctorId, serviceId, date }) {
  const { min, max } = range(clinic);
  if (!doctorId || !scheduling.isDate(date)) return { slots: [], error: null };
  if (date < min || date > max) return { slots: [], error: req.t('booking.date_range', { n: HORIZON_DAYS }) };
  try {
    const slots = await scheduling.availableSlots({ businessId: clinic.id, timezone: clinic.timezone, doctorId, serviceId: serviceId || undefined, date });
    return { slots, error: null };
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    const tr = req.t(`errors.${err.code}`);
    return { slots: [], error: tr !== `errors.${err.code}` ? tr : req.t('booking.slots_error') };
  }
}

async function renderBook(req, res, clinic, extra = {}) {
  if (!clinic.booking_enabled) {
    return res.page('pages/portal/unavailable', { layout: 'public', title: req.t('booking.unavailable_title'), clinic, hideBookCta: true, pageStyles: clinicStyles(clinic) });
  }
  const [doctors, services, onlineDoctors] = await Promise.all([listDoctors(req, clinic), listServices(req, clinic), require('../telehealth/telehealth.service').onlineDoctors(clinic, req.locale)]); // eslint-disable-line global-require
  const src = { ...req.query, ...(req.method === 'POST' ? req.body : {}), ...(extra.old || {}) };
  const sel = {
    doctor: doctors.some((d) => d.id === idOf(src.doctor_id || src.doctor)) ? idOf(src.doctor_id || src.doctor) : (doctors.length === 1 ? doctors[0].id : null),
    service: idOf(src.service_id || src.service),
    date: scheduling.isDate(src.appointment_date || src.date) ? (src.appointment_date || src.date) : null,
    time: scheduling.isTime(src.appointment_time) ? src.appointment_time : null,
  };
  if (sel.service && !services.some((s) => s.id === sel.service && (!s.doctorId || s.doctorId === sel.doctor))) sel.service = null;
  const { min, max } = range(clinic);
  if (!sel.date) sel.date = min;
  const { slots, error: slotsError } = await freeTimes(req, clinic, { doctorId: sel.doctor, serviceId: sel.service, date: sel.date });
  if (sel.time && !slots.includes(sel.time)) sel.time = null;
  res.locals.currency = clinic.currency;
  return res.page('pages/portal/book', {
    layout: 'public', title: req.t('booking.title'), pageTitle: `${req.t('booking.title')} · ${clinic.displayName}`, clinic, doctors, services, sel, slots, slotsError,
    minDate: min, maxDate: max, hideBookCta: true, pageStyles: [...clinicStyles(clinic), '/css/telehealth.css'], pageScripts: ['/js/site.js'], onlineAvailable: onlineDoctors.length > 0,
    errors: {}, formError: null, old: {}, ...extra,
  });
}

// ---------------------------------------------------------------- pages
router.get('/:slug/book', wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  return renderBook(req, res, clinic);
}));

router.get('/:slug/book/slots', slotsLimiter, wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  res.set('Cache-Control', 'no-store');
  if (!clinic.booking_enabled) return res.status(404).json({ data: [], error: req.t('booking.unavailable_title') });
  const { slots, error } = await freeTimes(req, clinic, { doctorId: idOf(req.query.doctor), serviceId: idOf(req.query.service), date: String(req.query.date || '') });
  return res.json(error ? { data: slots, error } : { data: slots });
}));

const bookingSchema = z.object({
  doctor_id: z.coerce.number({ invalid_type_error: 'Choose a valid value.' }).int().positive('Choose a valid value.'),
  service_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  appointment_date: isoDate(),
  appointment_time: z.string({ required_error: 'Enter a valid time.' }).trim().refine(scheduling.isTime, 'Enter a valid time.'),
  patient_name: z.string({ required_error: 'Required.' }).trim().min(2, 'Required.').max(120),
  patient_phone: z.string({ required_error: 'Required.' }).trim().min(1, 'Required.').max(40),
  patient_email: z.preprocess(emptyToUndefined, z.string().trim().email('Enter a valid email address.').max(190).optional()),
  notes: optionalString(1000),
});

router.post('/:slug/book', (req, res, next) => (req.body && req.body.step === 'slots' ? next() : bookLimiter(req, res, next)), wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  if (!clinic.booking_enabled || req.body.step === 'slots') return renderBook(req, res, clinic);
  // Honeypot: people never see this field; bots fill it. Pretend nothing happened.
  if (req.body.website) return res.redirect(`/${clinic.slug}/book`);
  const fail = (status, message, errors = {}) => { res.status(status); return renderBook(req, res, clinic, { formError: { code: 'BOOKING', message }, errors, old: req.body }); };
  if (req.bookingLimited) return fail(429, req.t('booking.rate_limited'));

  let d;
  try {
    d = validate(bookingSchema, req.body);
  } catch (err) {
    if (err.code !== 'VALIDATION_FAILED') throw err;
    const errors = Object.fromEntries(Object.entries(err.details || {}).map(([k, v]) => [k, translateMessage(req.locale, v)]));
    if (errors.appointment_time) errors.appointment_time = req.t('booking.choose_time_first');
    return fail(422, req.t('errors.VALIDATION_FAILED'), errors);
  }
  const phone = cleanPhone(d.patient_phone);
  if (!PHONE_RE.test(phone)) return fail(422, req.t('errors.VALIDATION_FAILED'), { patient_phone: req.t('booking.invalid_phone') });
  const { min, max } = range(clinic);
  if (d.appointment_date < min || d.appointment_date > max) return fail(422, req.t('errors.VALIDATION_FAILED'), { appointment_date: req.t('booking.date_range', { n: HORIZON_DAYS }) });
  const doctor = await knex('doctors').where({ id: d.doctor_id, business_id: clinic.id, is_active: true }).first('id');
  if (!doctor) return fail(422, req.t('errors.VALIDATION_FAILED'), { doctor_id: translateMessage(req.locale, 'Choose a valid value.') });

  const [{ n }] = await knex('appointments').where({ business_id: clinic.id, patient_phone: phone, source: 'website', status: 'pending' })
    .where('appointment_date', '>=', min).count({ n: '*' });
  if (Number(n) >= MAX_PENDING_PER_PHONE) return fail(409, req.t('booking.too_many', { n: MAX_PENDING_PER_PHONE }));

  let id;
  try {
    id = await appointments.book({ ...publicCtx(req, clinic), channel: require('../discover/channels').current(req, clinic) }, { // eslint-disable-line global-require
      doctor_id: d.doctor_id, service_id: d.service_id, appointment_date: d.appointment_date, appointment_time: d.appointment_time,
      patient_name: d.patient_name, patient_phone: phone, patient_email: d.patient_email, notes: d.notes, appointment_type: 'in_person',
    }, { source: 'website' });
  } catch (err) {
    if (!(err instanceof AppError) || ![409, 422].includes(err.status)) throw err;
    const tr = req.t(`errors.${err.code}`);
    const message = tr !== `errors.${err.code}` ? tr : req.t('errors.VALIDATION_FAILED');
    const errors = err.code === 'SLOT_TAKEN' ? { appointment_time: message } : Object.fromEntries(Object.entries(err.details || {}).map(([k, v]) => [k, translateMessage(req.locale, v)]));
    const old = { ...req.body };
    if (err.code === 'SLOT_TAKEN') delete old.appointment_time; // show fresh free times
    res.status(err.status);
    return renderBook(req, res, clinic, { formError: { code: err.code, message }, errors, old });
  }
  req.session.booked = { businessId: clinic.id, id, at: Date.now() };
  return res.redirect(`/${clinic.slug}/book/done`);
}));

// ---------------------------------------------------------------- confirmation + calendar file
async function lastBooking(req, clinic) {
  const b = req.session && req.session.booked;
  if (!b || b.businessId !== clinic.id || Date.now() - b.at > 24 * 3_600_000) return null;
  return knex('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id')
    .where({ 'a.id': b.id, 'a.business_id': clinic.id })
    .first('a.id', 'a.appointment_date', 'a.appointment_time', 'a.duration_minutes', 'a.status', 'a.patient_name', 'a.patient_phone',
      'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.slot_duration_minutes', 's.name as service_name', 's.name_en as service_name_en', 's.duration_minutes as service_minutes');
}
const localise = (req, a) => ({
  ...a,
  doctor: (req.locale === 'en' && a.doctor_name_en) || a.doctor_name,
  service: (req.locale === 'en' && a.service_name_en) || a.service_name,
  minutes: a.duration_minutes || a.service_minutes || a.slot_duration_minutes || 30,
});

router.get('/:slug/book/done', wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  const a = await lastBooking(req, clinic);
  if (!a) return res.redirect(`/${clinic.slug}/book`);
  return res.page('pages/portal/booked', { layout: 'public', title: req.t('booking.done_title'), clinic, appt: localise(req, a), hideBookCta: true, noindex: true, pageStyles: clinicStyles(clinic) });
}));

/** UTC instant of a wall-clock time in a time zone. */
function zonedToUtc(date, time, tz) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (at) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute)) - at;
  };
  let utc = guess - offset(guess);
  utc = guess - offset(utc);
  return new Date(utc);
}
const icsDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');

router.get('/:slug/book/appointment.ics', wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  const raw = await lastBooking(req, clinic);
  if (!raw) return res.redirect(`/${clinic.slug}/book`);
  const a = localise(req, raw);
  const start = zonedToUtc(a.appointment_date, a.appointment_time, clinic.timezone || 'UTC');
  const end = new Date(start.getTime() + a.minutes * 60_000);
  const host = String(config.appUrl || 'localhost').replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DocBook//Online booking//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:appointment-${a.id}@${host}`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(req.t('booking.ics_summary', { clinic: clinic.displayName }))}`,
    `DESCRIPTION:${icsText([a.doctor, a.service].filter(Boolean).join(' · '))}`,
    ...(clinic.address ? [`LOCATION:${icsText(clinic.address)}`] : []),
    'STATUS:TENTATIVE', 'END:VEVENT', 'END:VCALENDAR',
  ];
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="appointment-${a.appointment_date}.ics"`, 'Cache-Control': 'no-store' });
  return res.send(`${lines.join('\r\n')}\r\n`);
}));

module.exports = router;
