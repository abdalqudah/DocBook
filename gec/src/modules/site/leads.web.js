// Public lead forms: free consultation request (/book) and contact (/contact). Every submission becomes a CRM lead.
const express = require('express');
const limits = require('../../middleware/limits');
const { ah } = require('../../core/http');
const { validate, z, reqStr, str, optEmail, phone, list, oneOf } = require('../../core/validate');
const ref = require('../catalog/reference');
const capture = require('./capture');
const nav = require('./nav');
const features = require('./features');
const footer = require('./footer');

features.enable('book');
nav.add({ key: 'contact', href: '/contact', order: 90 });
footer.add('company', { href: '/contact', label: 'site.nav.contact' });
footer.add('students', { href: '/book', label: 'site.book_consultation' });

const router = express.Router();

const consultSchema = z.object({
  first_name: reqStr(80), last_name: str(80), email: optEmail(), phone: phone(), whatsapp: phone(),
  residence_country: z.preprocess((v) => (v ? String(v).toUpperCase() : undefined), z.enum(ref.ISO).optional()),
  interest_countries: list(6), interest_degree: oneOf(ref.DEGREES), interest_field: str(120),
  interest_intake: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}$/).optional()),
  budget_range: oneOf(ref.BUDGETS.map((b) => b[0])), education_level: oneOf(ref.EDUCATION_LEVELS),
  message: str(3000), contact_time: oneOf(['morning', 'afternoon', 'evening', 'any']), consent_contact: z.literal('1', { errorMap: () => ({ message: 'Required.' }) }),
}).refine((d) => d.email || d.phone || d.whatsapp, { message: 'Enter an email or a phone number.', path: ['email'] });

async function bookPage(req, res, extra = {}) {
  const prefill = {
    interest_countries: req.query.destination ? [String(req.query.destination)] : [],
    interest_degree: req.query.degree || '', interest_field: req.query.field || '',
    message: req.query.about ? `${req.t('book.interested_in')}: ${String(req.query.about).slice(0, 200)}` : '',
  };
  res.page('pages/site/book', {
    layout: 'public', title: req.t('book.title'),
    seo: { title: req.t('book.title'), description: req.t('book.lead'), canonical: `${res.locals.appUrl}/book` },
    destinations: await ref.destinationOptions(req.locale), old: { ...prefill, ...(extra.old || {}) }, errors: extra.errors || {},
    utm: Object.fromEntries(capture.UTM.map((k) => [k, req.query[`utm_${k}`] || ''])), about: req.query.about || '', ...extra,
  });
}

router.get('/book', ah((req, res) => bookPage(req, res)));
router.post('/book', limits.publicForm, ah(async (req, res) => {
  if (capture.isBot(req)) return res.redirect('/book/thanks');
  try {
    const d = validate(consultSchema, req.body);
    const about = req.body.about ? String(req.body.about).slice(0, 190) : null;
    const message = [d.message, d.contact_time && d.contact_time !== 'any' ? `${req.t('book.contact_time')}: ${req.t(`book.time_${d.contact_time}`)}` : null].filter(Boolean).join('\n');
    await capture.submit(req, 'consultation', { ...d, message, preferred_locale: req.locale, interest_type: about ? 'program' : 'general', interest_ref: about });
    return res.redirect('/book/thanks');
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return bookPage(req, res, { old: req.body, errors: e.details, step: Object.keys(e.details).some((k) => ['first_name', 'email', 'phone', 'whatsapp'].includes(k)) ? 1 : 3 });
  }
}));
router.get('/book/thanks', ah(async (req, res) => {
  res.page('pages/site/thanks', { layout: 'public', title: req.t('book.thanks_title'), seo: { noindex: true }, kind: 'book' });
}));

// ---- Contact
const contactSchema = z.object({
  name: reqStr(160), email: optEmail(), phone: phone(), subject: str(160), message: reqStr(4000), consent_contact: z.literal('1', { errorMap: () => ({ message: 'Required.' }) }),
}).refine((d) => d.email || d.phone, { message: 'Enter an email or a phone number.', path: ['email'] });

async function contactPage(req, res, extra = {}) {
  const knex = require('../../db/knex'); // eslint-disable-line global-require
  const offices = await knex('branches').where({ is_active: true }).orderBy('id');
  res.page('pages/site/contact', { layout: 'public', title: req.t('contact.title'), seo: { title: req.t('contact.title'), description: req.t('contact.lead'), canonical: `${res.locals.appUrl}/contact` }, offices, old: extra.old || {}, errors: extra.errors || {}, sent: extra.sent || false });
}
router.get('/contact', ah((req, res) => contactPage(req, res, { sent: req.query.sent === '1' })));
router.post('/contact', limits.publicForm, ah(async (req, res) => {
  if (capture.isBot(req)) return res.redirect('/contact?sent=1');
  try {
    const d = validate(contactSchema, req.body);
    const parts = d.name.trim().split(/\s+/);
    await capture.submit(req, 'contact_form', { first_name: parts[0], last_name: parts.slice(1).join(' ') || null, email: d.email, phone: d.phone, message: [d.subject, d.message].filter(Boolean).join('\n\n'), preferred_locale: req.locale, interest_type: 'general' });
    return res.redirect('/contact?sent=1');
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return contactPage(req, res, { old: req.body, errors: e.details });
  }
}));

module.exports = router;
