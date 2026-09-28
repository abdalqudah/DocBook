const express = require('express');
const rateLimit = require('express-rate-limit');
const knex = require('../../db/knex');
const config = require('../../config');
const { z, validate, email, password } = require('../../core/validate');
const { CURRENCIES } = require('../../core/money');
const { E } = require('../../core/errors');
const { wrap, form, flash } = require('../../routes/helpers');
const { requireAuth } = require('../../middleware/context');
const authService = require('./auth.service');
const security = require('./security.service');
const verify = require('./verify.service');
const businesses = require('../businesses/business.service');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isTest ? 1000 : 30, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(E.rateLimited()) });

const { signIn, afterLogin } = require('./session');

// ---------- Login
const renderLogin = (req, res, extra = {}) => res.page('pages/auth/login', { layout: 'auth', title: req.t('auth.login_title'), ...extra });
router.get('/login', (req, res) => (req.user ? res.redirect('/app') : renderLogin(req, res)));
router.post('/login', limiter, form(async (req, res) => {
  const data = validate(z.object({ email: email(), password: z.string().min(1, 'Password is required.') }), req.body);
  const user = await authService.authenticate(data, { ip: req.ip, userAgent: req.get('user-agent') });
  await signIn(req, user);
  if (!req.cookies.db_lang && user.locale) res.cookie('db_lang', user.locale, { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: true, secure: config.isProd });
  return afterLogin(req, res);
}, (req, res, extra) => renderLogin(req, res, extra)));

// ---------- Sign-up: account → business → currency (then the in-app setup wizard continues)
const renderSignup = (req, res, extra = {}) => res.page('pages/auth/signup', { layout: 'auth', wide: true, title: req.t('auth.signup_title'), currencies: CURRENCIES, ...extra });
router.get('/signup', (req, res) => {
  if (!config.allowSignup) return res.redirect('/login');
  return req.user ? res.redirect('/app') : renderSignup(req, res);
});
router.post('/signup', limiter, form(async (req, res) => {
  if (!config.allowSignup) throw E.forbidden('signup');
  const data = validate(z.object({
    name: z.string().trim().min(2, 'Enter your full name.').max(160),
    email: email(),
    password: password(),
    business_name: z.string().trim().min(2, 'Enter your business name.').max(160),
    currency: z.enum(CURRENCIES, { errorMap: () => ({ message: 'Choose a currency.' }) }),
    industry: z.string().trim().max(60).optional(),
    terms: z.literal('on', { errorMap: () => ({ message: 'Please accept the terms to continue.' }) }),
  }), req.body);
  const userId = await knex.transaction(async (trx) => {
    const id = await authService.createUser(trx, { name: data.name, email: data.email, password: data.password, locale: req.locale });
    await businesses.create(id, { name: data.business_name, currency: data.currency, specialty: data.industry }, trx);
    return id;
  });
  const user = await authService.findUser(userId);
  await verify.send(user, { locale: req.locale }).catch(() => {});
  await signIn(req, user);
  return res.redirect('/app/onboarding');
}, (req, res, extra) => renderSignup(req, res, { ...extra, step: extra.errors && (extra.errors.business_name || extra.errors.currency) ? 1 : 0 })));

// ---------- Forgot / reset password
const renderForgot = (req, res, extra = {}) => res.page('pages/auth/forgot', { layout: 'auth', title: req.t('auth.forgot_title'), sent: false, canEmail: require('../../core/mailer').configured(), ...extra }); // eslint-disable-line global-require
router.get('/forgot', (req, res) => renderForgot(req, res));
router.post('/forgot', limiter, form(async (req, res) => {
  const data = validate(z.object({ email: email() }), req.body);
  await security.requestReset(data.email, { ip: req.ip, locale: req.locale });
  return renderForgot(req, res, { sent: true });
}, renderForgot));
const renderReset = async (req, res, extra = {}) => {
  res.set('Referrer-Policy', 'no-referrer');
  return res.page('pages/auth/reset', { layout: 'auth', title: req.t('auth.reset_title'), valid: Boolean(await security.findReset(req.params.token)), token: req.params.token, ...extra });
};
router.get('/reset/:token', wrap((req, res) => renderReset(req, res)));
router.post('/reset/:token', limiter, form(async (req, res) => {
  await security.resetPassword(req.params.token, req.body.password, req.body.password_confirm, { ip: req.ip });
  flash(req, 'success', req.t('auth.reset_done'));
  return res.redirect('/login');
}, renderReset));

// ---------- E-mail verification
router.get('/verify-email/:token', wrap(async (req, res) => {
  try {
    await verify.confirm(req.params.token);
    flash(req, 'success', req.t('verify.done'));
    return res.redirect(req.user ? '/app' : '/login');
  } catch (e) {
    if (e.code !== 'VERIFY_INVALID') throw e;
    res.status(404);
    return res.page('pages/auth/message', { layout: 'auth', title: req.t('verify.title'), heading: req.t('verify.invalid_title'), text: req.t('verify.invalid_text'), cta: { href: '/login', label: req.t('auth.login') } });
  }
}));
router.post('/verify-email/resend', requireAuth, wrap(async (req, res) => {
  try { await verify.send(req.user, { locale: req.locale }); flash(req, 'success', req.t('verify.resent', { email: req.user.email })); } catch (e) { flash(req, 'error', e.message); }
  res.redirect(req.get('referer') || '/app');
}));

// ---------- Invitations
const renderInvite = async (req, res, extra = {}) => {
  const inv = await businesses.findInvitation(req.params.token);
  res.set('Referrer-Policy', 'no-referrer');
  return res.page('pages/auth/invite', { layout: 'auth', title: req.t('auth.invite_title'), inv, token: req.params.token, ...extra });
};
router.get('/invite/:token', wrap((req, res) => renderInvite(req, res)));
router.post('/invite/:token', limiter, form(async (req, res) => {
  const inv = await businesses.findInvitation(req.params.token);
  if (!inv) throw E.notFound('Invitation');
  let user = req.user;
  if (user) {
    if (user.email.toLowerCase() !== inv.email.toLowerCase()) throw E.conflict('INVITE_OTHER_EMAIL', 'This invitation was sent to a different e-mail address.');
    await businesses.acceptInvitation(inv, user.id);
  } else {
    const existing = await knex('users').where({ email: inv.email }).first();
    if (existing) throw E.conflict('INVITE_SIGN_IN', 'You already have an account — sign in first, then open the invitation link again.');
    const data = validate(z.object({ name: z.string().trim().min(2, 'Enter your full name.').max(160), password: password() }), req.body);
    const id = await knex.transaction(async (trx) => {
      const uid = await authService.createUser(trx, { name: data.name, email: inv.email, password: data.password, locale: req.locale });
      await trx('users').where({ id: uid }).update({ email_verified_at: new Date() }); // the invitation link proves the address
      await businesses.acceptInvitation(inv, uid, trx);
      return uid;
    });
    user = await authService.findUser(id);
    await signIn(req, user);
  }
  req.session.businessId = inv.business_id;
  flash(req, 'success', req.t('auth.invite_joined', { business: inv.business_name }));
  return res.redirect('/app');
}, renderInvite));

// ---------- Logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('db.sid'); res.redirect('/login'); });
});

// ---------- Workspaces (create / switch) — used by the sidebar switcher
const renderNewWs = (req, res, extra = {}) => res.page('pages/auth/new-workspace', { layout: 'auth', title: req.t('workspaces.new_title'), currencies: CURRENCIES, ...extra });
router.get('/workspaces/new', requireAuth, (req, res) => renderNewWs(req, res));
router.post('/workspaces/new', requireAuth, form(async (req, res) => {
  const data = validate(z.object({ name: z.string().trim().min(2, 'Enter your business name.').max(160), currency: z.enum(CURRENCIES), industry: z.string().trim().max(60).optional() }), req.body);
  const id = await knex.transaction((trx) => businesses.create(req.user.id, data, trx));
  req.session.businessId = id;
  return res.redirect('/app/onboarding');
}, renderNewWs));
router.post('/workspaces/switch', requireAuth, wrap(async (req, res) => {
  const id = Number(req.body.business_id);
  if (!(await businesses.isMember(req.user.id, id))) throw E.forbidden('workspace');
  req.session.businessId = id;
  await knex('users').where({ id: req.user.id }).update({ last_business_id: id });
  res.redirect('/app');
}));

module.exports = router;
