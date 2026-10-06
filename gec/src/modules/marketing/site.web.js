// Public newsletter pages: sign-up (footer form), confirmation (a button, so mail scanners that open links do
// not confirm on someone's behalf) and the private manage / unsubscribe link.
const express = require('express');
const limits = require('../../middleware/limits');
const { ah } = require('../../core/http');
const { validate, z } = require('../../core/validate');
const ref = require('../catalog/reference');
const svc = require('./newsletter');

const router = express.Router();
const page = (req, res, state, extra = {}) => res.page('pages/site/newsletter', { layout: 'public', title: req.t('newsletter.title'), state, seo: { noindex: true }, ...extra });
const schema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid e-mail address.').max(190),
  name: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(160).optional()),
  interests: z.preprocess((v) => [].concat(v || []).filter((c) => /^[A-Z]{2}$/.test(c)).slice(0, 10), z.array(z.string())),
  degree: z.preprocess((v) => (ref.DEGREES.includes(v) ? v : undefined), z.string().optional()),
  consent: z.literal('1', { errorMap: () => ({ message: 'Please tick the box to subscribe.' }) }),
  from: z.preprocess((v) => String(v || '').replace(/[^a-z0-9/_-]/gi, '').slice(0, 60), z.string()),
});

router.get('/newsletter', (req, res) => page(req, res, req.query.sent === '1' ? 'sent' : 'form', { old: {}, errors: {} }));
router.post('/newsletter', limits.publicForm, ah(async (req, res) => {
  if (req.body && req.body.website) return res.redirect('/newsletter?sent=1'); // honeypot
  try {
    const d = validate(schema, req.body);
    await svc.subscribe({ ip: req.ip }, { email: d.email, name: d.name, locale: req.locale, interests: d.interests, degree: d.degree, source: d.from || 'website', utm: req.visitor ? { utm_source: req.visitor.utm_source, utm_medium: req.visitor.utm_medium, utm_campaign: req.visitor.utm_campaign } : {}, consentText: req.t('newsletter.consent') });
    return res.redirect('/newsletter?sent=1');
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return page(req, res, 'form', { old: req.body, errors: e.details });
  }
}));

router.get('/newsletter/confirm/:token', ah(async (req, res) => {
  const s = await svc.byConfirmToken(req.params.token);
  if (!s) return page(req, res.status(404), 'invalid');
  return page(req, res, 'confirm', { token: req.params.token });
}));
router.post('/newsletter/confirm/:token', ah(async (req, res) => {
  const s = await svc.confirm({ ip: req.ip }, req.params.token);
  if (!s) return page(req, res.status(404), 'invalid');
  const fresh = await require('../../db/knex')('newsletter_subscribers').where({ id: s.id }).first('manage_token'); // eslint-disable-line global-require
  return page(req, res, 'confirmed', { manage: fresh.manage_token });
}));

router.get('/newsletter/manage/:token', ah(async (req, res) => {
  const s = await svc.byManageToken(req.params.token);
  if (!s) return page(req, res.status(404), 'invalid');
  return page(req, res, s.status === 'unsubscribed' ? 'unsubscribed' : 'manage', { token: req.params.token, sub: s });
}));
router.post('/newsletter/manage/:token', ah(async (req, res) => {
  const s = await svc.byManageToken(req.params.token);
  if (!s) return page(req, res.status(404), 'invalid');
  await svc.unsubscribeSubscriber(s.id);
  return page(req, res, 'unsubscribed', { token: req.params.token });
}));

module.exports = router;
