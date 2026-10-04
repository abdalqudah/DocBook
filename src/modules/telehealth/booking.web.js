// Public booking of an ONLINE consultation: /<slug>/book/online. Progressive enhancement like the in-clinic
// booking — without JavaScript "Show free times" reloads the page (GET) with the times; with JavaScript the
// patient's time zone is detected and the times load from /<slug>/book/online/slots, shown in the patient's
// time AND the clinic's time. The form is multipart (optional medical files); the CSRF token is checked after
// parsing. Same anti-abuse as the in-clinic booking: rate limit, honeypot, CSRF, max pending per phone.
const { siteLook } = require('../site/portal.web');
const express = require('express');
const uploads = require('../../core/uploads');
const rateLimit = require('express-rate-limit');
const knex = require('../../db/knex');
const config = require('../../config');
const { z, validate, isoDate } = require('../../core/validate');
const { AppError } = require('../../core/errors');
const { wrap } = require('../../routes/helpers');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const { translateMessage } = require('../../core/i18n');
const scheduling = require('../clinic/scheduling');
const { loadClinic } = require('../site/portal.web');
const tele = require('./telehealth.service');
const countries = require('./countries');

const router = express.Router();
const HORIZON_DAYS = 60;
const MAX_PENDING_PER_PHONE = 3;

const bookLimiter = rateLimit({ windowMs: 60 * 60_000, limit: config.isTest ? 1000 : 10, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => { req.bookingLimited = true; next(); } });
const slotsLimiter = rateLimit({ windowMs: 10 * 60_000, limit: config.isTest ? 5000 : 300, standardHeaders: true, legacyHeaders: false, handler: (req, res) => res.status(429).json({ data: [], error: req.t('booking.rate_limited') }) });
const upload = uploads.memory({ limits: { files: tele.MAX_FILES + 1, fileSize: tele.MAX_FILE_BYTES + 1, fields: 40, fieldSize: 20_000, parts: 60 } }); // photos → small WebP

const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const range = (clinic) => { const today = scheduling.clinicNow(clinic.timezone).date; return { min: today, max: addDays(today, HORIZON_DAYS) }; };
const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const zoneOf = (v, clinic) => (tele.isZone(String(v || '')) ? String(v) : clinic.timezone);

const publicCtx = (req, clinic) => ({
  businessId: clinic.id, timezone: clinic.timezone, currency: clinic.currency, userId: null, permissions: new Set(),
  ip: req.ip, userAgent: req.get('user-agent'), locale: req.locale,
});

async function freeTimes(req, clinic, { doctorId, date, tz }) {
  const { min, max } = range(clinic);
  if (!doctorId || !scheduling.isDate(date)) return { slots: [], error: null };
  if (date < min || date > max) return { slots: [], error: req.t('booking.date_range', { n: HORIZON_DAYS }) };
  try {
    const slots = await tele.onlineSlots(clinic, doctorId, date);
    return { slots: tele.slotsInZone(slots, date, clinic.timezone, tz), error: null };
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    const tr = req.t(`errors.${err.code}`);
    return { slots: [], error: tr !== `errors.${err.code}` ? tr : req.t('booking.slots_error') };
  }
}

async function renderOnline(req, res, clinic, extra = {}) {
  const doctors = clinic.booking_enabled ? await tele.onlineDoctors(clinic, req.locale) : [];
  if (!clinic.booking_enabled || !doctors.length) {
    return res.page('pages/portal/unavailable', { layout: 'public', title: req.t('telehealth.unavailable_title'), clinic, hideBookCta: !clinic.booking_enabled, ...(await siteLook(req, res, clinic)) });
  }
  const src = { ...req.query, ...(req.method === 'POST' ? req.body : {}), ...(extra.old || {}) };
  if (src.doctor && !/^\d+$/.test(String(src.doctor))) { const portal = require('../site/portal.web'); const f = portal.doctorByRef(await portal.listDoctors(req, clinic), src.doctor); src.doctor = f ? String(f.id) : ''; } // eslint-disable-line global-require -- ?doctor=<name address>
  const docId = idOf(src.doctor_id || src.doctor);
  const sel = {
    doctor: doctors.some((d) => d.id === docId) ? docId : (doctors.length === 1 ? doctors[0].id : null),
    date: scheduling.isDate(src.appointment_date || src.date) ? (src.appointment_date || src.date) : null,
    time: scheduling.isTime(src.appointment_time) ? src.appointment_time : null,
    tz: zoneOf(src.patient_timezone || src.tz, clinic),
    tzGiven: tele.isZone(String(src.patient_timezone || src.tz || '')),
  };
  const { min, max } = range(clinic);
  if (!sel.date) sel.date = min;
  const { slots, error: slotsError } = await freeTimes(req, clinic, { doctorId: sel.doctor, date: sel.date, tz: sel.tz });
  if (sel.time && !slots.some((s) => s.time === sel.time)) sel.time = null;
  res.locals.currency = clinic.currency;
  res.set('Cache-Control', 'no-store');
  return res.page('pages/portal/book-online', {
    layout: 'public', title: req.t('telehealth.book_title'), pageTitle: `${req.t('telehealth.book_title')} · ${clinic.displayName}`,
    clinic, doctors, sel, slots, slotsError, minDate: min, maxDate: max, hideBookCta: true, noindex: false,
    zones: tele.zoneOptions(), countryOptions: countries.options(req.locale), settings: tele.clinicSettings(clinic, req.locale),
    maxFiles: tele.MAX_FILES, ...(await siteLook(req, res, clinic, ['/css/telehealth.css'])), pageScripts: ['/js/telehealth.js'],
    errors: {}, formError: null, old: {}, ...extra,
  });
}

router.get('/:slug/book/online', wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  if (clinic.kind === 'center_admin') return require('../center/site.web').centerBook(req, res, clinic, { online: true }); // eslint-disable-line global-require
  const { website, _csrf, ...kept } = req.query; // eslint-disable-line no-unused-vars
  return renderOnline(req, res, clinic, { old: kept });
}));

router.get('/:slug/book/online/slots', slotsLimiter, wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  res.set('Cache-Control', 'no-store');
  if (!clinic.booking_enabled || !clinic.online_enabled) return res.status(404).json({ data: [], error: req.t('telehealth.unavailable_title') });
  const { slots, error } = await freeTimes(req, clinic, { doctorId: idOf(req.query.doctor), date: String(req.query.date || ''), tz: zoneOf(req.query.tz, clinic) });
  return res.json(error ? { data: slots, error } : { data: slots });
}));

const schema = z.object({
  doctor_id: z.coerce.number({ invalid_type_error: 'Choose a valid value.' }).int().positive('Choose a valid value.'),
  appointment_date: isoDate(),
  appointment_time: z.string({ required_error: 'Enter a valid time.' }).trim().refine(scheduling.isTime, 'Enter a valid time.'),
  patient_timezone: z.string({ required_error: 'Choose a valid value.' }).trim().refine(tele.isZone, 'Choose a valid value.'),
  patient_name: z.string({ required_error: 'Required.' }).trim().min(2, 'Required.').max(120),
  patient_country: z.string({ required_error: 'Choose a valid value.' }).trim().toUpperCase().refine(countries.isCountry, 'Choose a valid value.'),
  phone_code: z.string().trim().max(4).optional(),
  phone_number: z.string({ required_error: 'Required.' }).trim().min(1, 'Required.').max(30),
  patient_email: z.string({ required_error: 'Required.' }).trim().toLowerCase().min(1, 'Required.').email('Enter a valid email address.').max(190),
  reason: z.string({ required_error: 'Required.' }).trim().min(3, 'Required.').max(2000),
});

/** Multer errors (too many / too large files) become a normal form error. */
const parseUpload = (req, res, next) => upload.array('files', tele.MAX_FILES + 1)(req, res, (err) => {
  if (err) {
    req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'TELE_FILE_TOO_BIG' : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 'TELE_TOO_MANY_FILES' : 'TELE_UPLOAD';
    req.body = req.body || {};
  }
  next();
});

// Over the limit: refused before any uploaded file is read into memory.
const limitFirst = (req, res, next) => bookLimiter(req, res, () => (req.bookingLimited ? res.status(429).send(req.t('booking.rate_limited')) : next()));
router.post('/:slug/book/online', limitFirst, parseUpload, verifyCsrfAfterUpload, wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  if (!clinic.booking_enabled || !clinic.online_enabled) return renderOnline(req, res, clinic);
  if (req.body.website) return res.redirect(`/${clinic.slug}/book/online`); // honeypot
  const old = { ...req.body };
  const fail = (status, message, errors = {}) => { res.status(status); return renderOnline(req, res, clinic, { formError: { code: 'BOOKING', message }, errors, old }); };
  if (req.bookingLimited) return fail(429, req.t('booking.rate_limited'));
  if (req.uploadError) return fail(422, req.t(`errors_telehealth.${req.uploadError}`), { files: req.t(`errors_telehealth.${req.uploadError}`) });

  let d;
  try {
    d = validate(schema, req.body);
  } catch (err) {
    if (err.code !== 'VALIDATION_FAILED') throw err;
    const errors = Object.fromEntries(Object.entries(err.details || {}).map(([k, v]) => [k, translateMessage(req.locale, v)]));
    if (errors.appointment_time) errors.appointment_time = req.t('booking.choose_time_first');
    if (errors.patient_timezone) errors.patient_timezone = req.t('errors_telehealth.invalid_zone');
    if (errors.phone_number) errors.phone_number = req.t('errors_telehealth.invalid_phone');
    return fail(422, req.t('errors.VALIDATION_FAILED'), errors);
  }
  const phone = tele.normalizePhone(d.phone_code, d.phone_number);
  if (!phone) return fail(422, req.t('errors.VALIDATION_FAILED'), { phone_number: req.t('errors_telehealth.invalid_phone') });
  const { min, max } = range(clinic);
  if (d.appointment_date < min || d.appointment_date > max) return fail(422, req.t('errors.VALIDATION_FAILED'), { appointment_date: req.t('booking.date_range', { n: HORIZON_DAYS }) });

  let files;
  try { files = tele.checkFiles(req.files); } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return fail(422, req.t(`errors_telehealth.${err.code}`), { files: req.t(`errors_telehealth.${err.code}`) });
  }

  const [{ n }] = await knex('appointments').where({ business_id: clinic.id, patient_phone: phone, source: 'website', status: 'pending' })
    .where('appointment_date', '>=', min).count({ n: '*' });
  if (Number(n) >= MAX_PENDING_PER_PHONE) return fail(409, req.t('booking.too_many', { n: MAX_PENDING_PER_PHONE }));

  let booked;
  try {
    booked = await tele.bookOnline(publicCtx(req, clinic), clinic, {
      doctor_id: d.doctor_id, appointment_date: d.appointment_date, appointment_time: d.appointment_time, patient_name: d.patient_name,
      patient_phone: phone, patient_email: d.patient_email, patient_country: d.patient_country, patient_timezone: d.patient_timezone, reason: d.reason,
    }, files);
  } catch (err) {
    if (!(err instanceof AppError) || ![409, 422].includes(err.status)) throw err;
    const tr = req.t(`errors.${err.code}`);
    const message = tr !== `errors.${err.code}` ? tr : req.t('errors.VALIDATION_FAILED');
    const errors = err.code === 'SLOT_TAKEN' ? { appointment_time: message } : Object.fromEntries(Object.entries(err.details || {}).map(([k, v]) => [k, translateMessage(req.locale, v)]));
    if (err.code === 'SLOT_TAKEN') delete old.appointment_time;
    return fail(err.status, message, errors);
  }
  // "Received" e-mail (with payment instructions when payment comes first) — only when e-mail is set up.
  const row = await tele.byToken(booked.token);
  tele.sendPatientMail('received', row, clinic, booked.token, require('../../middleware/web').publicBase(req)) // eslint-disable-line global-require
    .then((sent) => (sent ? knex('online_consultations').where({ id: row.id }).update({ received_sent_at: new Date() }) : null))
    .catch((e) => console.error('[telehealth] e-mail failed:', e.message)); // eslint-disable-line no-console
  return res.redirect(303, `/c/${booked.token}?new=1`);
}));

module.exports = router;
