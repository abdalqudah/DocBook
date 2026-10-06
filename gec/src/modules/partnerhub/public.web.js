// Public "For universities" page: what the partnership gives a university and the request form. A request goes
// to GEC's partnerships team; once approved, the contact gets a partner-portal account.
const express = require('express');
const limits = require('../../middleware/limits');
const { ah } = require('../../core/http');
const { validate, z } = require('../../core/validate');
const ref = require('../catalog/reference');
const footer = require('../site/footer');
const svc = require('./service');

footer.add('company', { href: '/for-universities', label: 'partnerp.for_universities' });

const router = express.Router();
const opt = (n) => z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(n).optional());
const schema = z.object({
  university_name: z.string().trim().min(3, 'Enter the university name.').max(190),
  country_code: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^[A-Z]{2}$/).optional()),
  city: opt(120),
  website: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(255).regex(/^https?:\/\//, 'Use a full web address (https://…).').optional()),
  contact_name: z.string().trim().min(2, 'Enter your name.').max(160),
  job_title: opt(120),
  email: z.string().trim().toLowerCase().email('Enter a valid work e-mail.').max(190),
  phone: opt(40),
  message: opt(3000),
  consent: z.literal('1', { errorMap: () => ({ message: 'Please accept so we can contact you.' }) }),
});

async function show(req, res, extra = {}) {
  res.page('pages/site/for-universities', {
    layout: 'public', title: req.t('partnerp.public_title'), heroPage: false,
    seo: { title: req.t('partnerp.public_title'), description: req.t('partnerp.public_lead'), canonical: `${res.locals.appUrl}/for-universities` },
    countries: ref.countries(req.locale), old: extra.old || {}, errors: extra.errors || {}, sent: extra.sent || false,
  });
}
router.get('/for-universities', ah((req, res) => show(req, res, { sent: req.query.sent === '1' })));
router.post('/for-universities', limits.publicForm, ah(async (req, res) => {
  // Honeypot: company_url (the form has a real "website" field, so capture.isBot does not fit here).
  if (req.body && req.body.company_url) return res.redirect('/for-universities?sent=1#apply');
  try {
    const { consent, ...d } = validate(schema, req.body); // eslint-disable-line no-unused-vars
    await svc.apply({ userId: null, ip: req.ip }, d);
    return res.redirect('/for-universities?sent=1#apply');
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return show(req, res, { old: req.body, errors: e.details });
  }
}));

module.exports = router;
