// Public routes of the student side: sign up, confirm the e-mail address, and the AI study advisor.
const express = require('express');
const limits = require('../../middleware/limits');
const { ah } = require('../../core/http');
const { validate, z, reqStr, str, email: emailField, password } = require('../../core/validate');
const auth = require('../auth/auth.service');
const capture = require('../site/capture');
const account = require('./account');
const advisor = require('../ai/advisor.service');
const provider = require('../ai/provider');

const nav = require('../site/nav');

nav.add({ key: 'advisor', href: '/advisor', order: 45, more: true });
const router = express.Router();

router.get('/register', ah(async (req, res) => {
  if (req.user && req.user.kind === 'student') return res.redirect('/portal');
  return res.page('pages/auth/register', { layout: 'auth', title: req.t('portal.register_title'), old: { email: req.query.email || '' }, errors: {}, sso: await require('../auth/sso').available('student') }); // eslint-disable-line global-require
}));

router.post('/register', limits.register, ah(async (req, res) => {
  if (capture.isBot(req)) return res.page('pages/auth/register-sent', { layout: 'auth', title: req.t('portal.check_email'), sent: true });
  try {
    if (req.body.password !== req.body.password_confirm) throw Object.assign(new Error('mismatch'), { code: 'VALIDATION_FAILED', details: { password_confirm: req.t('portal.passwords_differ') } });
    const d = validate(z.object({ first_name: reqStr(80), last_name: str(80), email: emailField(), password: password(), terms: z.literal('1', { errorMap: () => ({ message: 'Required.' }) }) }), req.body);
    const r = await account.register({ ip: req.ip }, { firstName: d.first_name, lastName: d.last_name, address: d.email, password: d.password, locale: req.locale, consentMarketing: req.body.consent_marketing === '1' });
    return res.page('pages/auth/register-sent', { layout: 'auth', title: req.t('portal.check_email'), sent: r.sent, address: d.email });
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return res.page('pages/auth/register', { layout: 'auth', title: req.t('portal.register_title'), old: { ...req.body, password: '', password_confirm: '' }, errors: e.details || {} });
  }
}));

router.get('/verify/:token', ah(async (req, res) => {
  const user = await account.verify({ ip: req.ip }, req.params.token, { visitorId: req.visitor ? req.visitor.id : null });
  if (!user) return res.status(404).page('pages/auth/verify-failed', { layout: 'auth', title: req.t('portal.verify_failed') });
  await auth.startSession(req, user);
  await account.afterSignIn(req, user);
  return res.redirect('/portal/profile/personal?welcome=1');
}));

// ------------------------------------------------------------------ AI study advisor
router.get('/advisor', ah(async (req, res) => {
  res.page('pages/site/advisor', { layout: 'public', pageScripts: ['/js/advisor.js'], title: req.t('advisor.title'), aiConnected: !!(await provider.currentConfig()), seo: { title: req.t('advisor.title'), description: req.t('advisor.lead') } });
}));

router.post('/advisor/ask', limits.advisor, ah(async (req, res) => {
  const d = validate(z.object({ question: reqStr(1000) }), req.body);
  const student = req.user && req.user.kind === 'student' ? await account.studentOf(req) : null;
  const history = Array.isArray(req.session.advisor) ? req.session.advisor : [];
  const out = await advisor.ask({ question: d.question, locale: req.locale, student, history, userId: req.user ? req.user.id : null, sessionKey: req.sessionID });
  if (out.mode === 'ai') req.session.advisor = [...history, { role: 'user', text: d.question }, { role: 'assistant', text: out.text }].slice(-8);
  res.json({ ok: true, ...out });
}));

module.exports = router;
