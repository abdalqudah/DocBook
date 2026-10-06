// Sign-in, sign-out and password reset for both portals: students at /login, staff at /staff/login.
const express = require('express');
const auth = require('./auth.service');
const email = require('../comms/email');
const limits = require('../../middleware/limits');
const { flash } = require('../../middleware/web');
const { validate, z, password } = require('../../core/validate');
const { AppError } = require('../../core/errors');
const { translator } = require('../../core/i18n');
const { requireStaff } = require('../../middleware/auth');
const { ah } = require('../../core/http');
const knex = require('../../db/knex');
const audit = require('../../core/audit');

const router = express.Router();


const PORTALS = {
  student: { base: '', login: '/login', home: '/portal', view: 'student' },
  staff: { base: '/staff', login: '/staff/login', home: '/staff', view: 'staff' },
  partner: { base: '/partner', login: '/partner/login', home: '/partner', view: 'partner' },
};

const sso = require('./sso');

function loginPage(portal) {
  return ah(async (req, res) => {
    if (req.user && req.user.kind === portal) return res.redirect(PORTALS[portal].home);
    return res.page('pages/auth/login', { layout: 'auth', title: req.t('auth.sign_in'), portal, emailValue: req.query.email || '', sso: await sso.available(portal) });
  });
}

/** Lands a freshly authenticated user in their portal (same rules as the password sign-in). */
async function landUser(req, res, user, portal) {
  const p = PORTALS[portal];
  await auth.startSession(req, user);
  await knex('users').where({ id: user.id }).update({ last_login_at: new Date(), failed_logins: 0, locked_until: null });
  if (portal === 'student') await require('../portal/account').afterSignIn(req, user); // eslint-disable-line global-require
  const to = req.session.returnTo;
  delete req.session.returnTo;
  if (portal === 'staff' && user.must_change_password && user.password_hash) return res.redirect('/staff/password');
  if (to && to.startsWith(`${p.base}/`) && !to.startsWith('//')) return res.redirect(to);
  if (portal === 'student' && to && to.startsWith('/portal')) return res.redirect(to);
  return res.redirect(p.home);
}

// ---- Google / Microsoft sign-in
const settingsHome = (u) => (u.kind === 'staff' ? '/staff/account' : '/portal/settings');
router.get('/auth/:provider/start', limits.login, ah(async (req, res) => {
  const portal = req.query.portal === 'staff' ? 'staff' : 'student';
  return res.redirect(await sso.begin(req, req.params.provider, { portal }));
}));
router.post('/auth/:provider/connect', ah(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  return res.redirect(await sso.begin(req, req.params.provider, { portal: req.user.kind, mode: 'link' }));
}));
router.post('/auth/:provider/disconnect', ah(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  try {
    await sso.disconnect({ userId: req.user.id, ip: req.ip }, req.user.id, req.params.provider);
    flash(req, 'ok', req.t('sso.disconnected'));
  } catch (e) { if (!(e instanceof AppError)) throw e; flash(req, 'error', req.t(`errors.${e.code}`)); }
  return res.redirect(settingsHome(req.user));
}));
router.get('/auth/:provider/callback', limits.login, ah(async (req, res) => {
  const pending = req.session.sso || {};
  const portal = pending.portal === 'staff' ? 'staff' : 'student';
  const ctx = { userId: null, ip: req.ip, visitorId: req.session.visitorId };
  try {
    const { flow, claims } = await sso.complete(req, req.params.provider, req.query);
    if (flow.mode === 'link') {
      if (!req.user || req.user.id !== flow.userId) throw new AppError('SSO_STATE', 'This sign-in link expired. Please try again.', 400);
      await sso.connect({ userId: req.user.id, ip: req.ip }, req.user.id, claims);
      flash(req, 'ok', req.t('sso.connected', { provider: req.t(`sso.${claims.provider}`) }));
      return res.redirect(settingsHome(req.user));
    }
    const user = await sso.resolveUser(ctx, claims, portal);
    await audit.record({ userId: user.id, ip: req.ip }, 'auth.login', { entityType: 'user', entityId: user.id, newValues: { portal, method: claims.provider } });
    return await landUser(req, res, user, portal);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    await audit.record(ctx, 'auth.sso_failed', { entityType: 'user', entityId: null, newValues: { provider: req.params.provider, code: e.code } });
    if (pending.mode === 'link' && req.user) { flash(req, 'error', req.t(`errors.${e.code}`)); return res.redirect(settingsHome(req.user)); }
    res.status(e.status >= 400 && e.status < 500 ? e.status : 400);
    return res.page('pages/auth/login', { layout: 'auth', title: req.t('auth.sign_in'), portal, emailValue: '', sso: await sso.available(portal), formError: req.t(`errors.${e.code}`) });
  }
}));

function doLogin(portal) {
  return ah(async (req, res) => {
    const p = PORTALS[portal];
    try {
      const user = await auth.authenticate({ email: req.body.email, password: req.body.password, portal, ip: req.ip });
      await auth.startSession(req, user);
      if (portal === 'student') await require('../portal/account').afterSignIn(req, user); // eslint-disable-line global-require
      const to = req.session.returnTo;
      delete req.session.returnTo;
      if (portal === 'staff' && user.must_change_password) return res.redirect('/staff/password');
      if (to && to.startsWith(`${p.base}/`) && !to.startsWith('//')) return res.redirect(to);
      if (portal === 'student' && to && to.startsWith('/portal')) return res.redirect(to);
      return res.redirect(p.home);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      res.status(e.status === 429 ? 429 : 401);
      return res.page('pages/auth/login', { layout: 'auth', title: req.t('auth.sign_in'), portal, emailValue: String(req.body.email || ''), formError: req.t(`errors.${e.code}`, e.details || {}) });
    }
  });
}

function logout(portal) {
  return ah(async (req, res) => {
    await auth.endSession(req);
    res.redirect(PORTALS[portal].login);
  });
}

function forgotPage(portal) {
  return (req, res) => res.page('pages/auth/forgot', { layout: 'auth', title: req.t('auth.forgot_title'), portal, sent: false });
}

function doForgot(portal) {
  return ah(async (req, res) => {
    const r = await auth.createReset(req.body.email, portal);
    if (r) {
      const t = translator(r.user.locale || req.locale);
      const html = await email.layout({ locale: r.user.locale || req.locale, title: t('auth.reset_mail_subject'), body: t('auth.reset_mail_body', { minutes: auth.RESET_MINUTES }), cta: t('auth.reset_mail_cta'), href: r.link });
      email.send({ to: r.user.email, subject: t('auth.reset_mail_subject'), html }).catch((e) => console.error('[mail] reset:', e.message)); // eslint-disable-line no-console
    }
    // Same answer whether or not the address exists.
    res.page('pages/auth/forgot', { layout: 'auth', title: req.t('auth.forgot_title'), portal, sent: true });
  });
}

function resetPage(portal) {
  return ah(async (req, res) => {
    const row = await auth.findReset(req.params.token);
    res.page('pages/auth/reset', { layout: 'auth', title: req.t('auth.reset_title'), portal, valid: Boolean(row), token: req.params.token });
  });
}

function doReset(portal) {
  return ah(async (req, res) => {
    try {
      if (req.body.password !== req.body.password_confirm) throw new AppError('VALIDATION_FAILED', 'Passwords do not match.', 422, { password_confirm: 'Passwords do not match.' });
      const { pw } = validate(z.object({ pw: password() }), { pw: req.body.password });
      await auth.resetPassword(req.params.token, pw, { ip: req.ip });
      flash(req, 'ok', req.t('auth.reset_done'));
      return res.redirect(PORTALS[portal].login);
    } catch (e) {
      if (e.code !== 'VALIDATION_FAILED') throw e;
      res.status(422);
      return res.page('pages/auth/reset', { layout: 'auth', title: req.t('auth.reset_title'), portal, valid: true, token: req.params.token, errors: { password: e.details.pw || e.details.password, password_confirm: e.details.password_confirm } });
    }
  });
}

// ---- Students
router.get('/login', loginPage('student'));
router.post('/login', limits.login, doLogin('student'));
router.post('/logout', logout('student'));
router.get('/forgot', forgotPage('student'));
router.post('/forgot', limits.reset, doForgot('student'));
router.get('/reset/:token', resetPage('student'));
router.post('/reset/:token', limits.reset, doReset('student'));

// ---- Staff
router.get('/staff/login', loginPage('staff'));
router.post('/staff/login', limits.login, doLogin('staff'));
router.post('/staff/logout', logout('staff'));
router.get('/staff/forgot', forgotPage('staff'));
router.post('/staff/forgot', limits.reset, doForgot('staff'));
router.get('/staff/reset/:token', resetPage('staff'));
router.post('/staff/reset/:token', limits.reset, doReset('staff'));

// First sign-in with a temporary password: choose a new one.
// ---- University partners
router.get('/partner/login', loginPage('partner'));
router.post('/partner/login', limits.login, doLogin('partner'));
router.post('/partner/logout', logout('partner'));
router.get('/partner/forgot', forgotPage('partner'));
router.post('/partner/forgot', limits.reset, doForgot('partner'));
router.get('/partner/reset/:token', resetPage('partner'));
router.post('/partner/reset/:token', limits.reset, doReset('partner'));

router.get('/staff/password', requireStaff, (req, res) => res.page('pages/auth/new-password', { layout: 'auth', title: req.t('auth.new_password_title') }));
router.post('/staff/password', requireStaff, ah(async (req, res) => {
  try {
    if (req.body.password !== req.body.password_confirm) throw new AppError('VALIDATION_FAILED', 'Passwords do not match.', 422, { password_confirm: 'Passwords do not match.' });
    const { pw } = validate(z.object({ pw: password() }), { pw: req.body.password });
    await auth.changePassword(req.ctx, req.user.id, req.body.current_password, pw, req.sessionID);
    flash(req, 'ok', req.t('auth.password_changed'));
    return res.redirect('/staff');
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return res.page('pages/auth/new-password', { layout: 'auth', title: req.t('auth.new_password_title'), errors: { ...e.details, password: e.details.pw || e.details.password } });
  }
}));

module.exports = router;
