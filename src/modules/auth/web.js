const express = require('express');
const rateLimit = require('express-rate-limit');
const knex = require('../../db/knex');
const config = require('../../config');
const mailer = require('../../core/mailer');
const { z, validate, email, password, optionalString } = require('../../core/validate');
const { CURRENCIES } = require('../../core/money');
const { E, AppError } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { form } = require('../settings/form');
const { requireAuth } = require('../../middleware/context');
const authService = require('./auth.service');
const security = require('./security.service');
const verify = require('./verify.service');
const businesses = require('../businesses/business.service');
const centers = require('../center/center.service');
const options = require('../settings/options');
const { signIn, afterLogin, landingFor } = require('./session');

const router = express.Router();
router.use(require('./google.web')); // Sign in with Google (+ res.locals.googleOn for the sign-in pages)
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isTest ? 1000 : 30, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(E.rateLimited()) });

// Clinic fields shared by sign-up and "add a clinic".
const clinicSchema = {
  clinic_name: z.string().trim().min(2, 'Enter the clinic name.').max(160),
  specialty: z.preprocess((v) => (v === '' ? undefined : v), z.string().refine((v) => require('../platformops/clinic-types').visible().includes(v), 'Choose a valid value.').optional()),
  city: optionalString(100),
  currency: z.enum(CURRENCIES, { errorMap: () => ({ message: 'Choose a currency.' }) }),
  timezone: z.enum(options.ZONE_IDS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
};
const clinicFields = (d) => ({ name: d.clinic_name, currency: d.currency, specialty: d.specialty || null, city: d.city || null, timezone: d.timezone, country: options.countryForZone(d.timezone) });
const clinicChoices = (req) => ({ specialtyOptions: require('../platformops/clinic-types').options(req.t), // eslint-disable-line global-require
  currencyOptions: options.currencyOptions(req.t), zoneOptions: options.zoneOptions(req.locale) });

// ---------- Login
const renderLogin = (req, res, extra = {}) => res.page('pages/auth/login', { layout: 'auth', title: req.t('auth.login_title'), ...extra });
router.get('/login', wrap(async (req, res) => {
  // ?preview=1: the installation's own account looks at the sign-in page it is editing.
  if (req.user && !(req.query.preview === '1' && req.user.is_platform_admin)) return res.redirect(req.user.must_change_password ? '/password/new' : await landingFor(req.user.id, req.session.businessId));
  return renderLogin(req, res);
}));
router.post('/login', limiter, form(async (req, res) => {
  const data = validate(z.object({ email: email(), password: z.string().min(1, 'Password is required.') }), req.body);
  const user = await authService.authenticate(data, { ip: req.ip, userAgent: req.get('user-agent') });
  await signIn(req, user);
  if (!req.cookies.db_lang && user.locale) res.cookie('db_lang', user.locale, { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: true, secure: config.isProd });
  return afterLogin(req, res);
}, (req, res, extra) => renderLogin(req, res, extra)));

// ---------- Clinic sign-up: owner account + clinic, then the in-app setup wizard continues
const renderSignup = (req, res, extra = {}) => res.page('pages/auth/signup', { layout: 'auth', wide: true, title: req.t('auth.signup_title'), pageScripts: ['/js/center.js'], pageStyles: ['/css/center.css'], ...clinicChoices(req), ...extra });
router.get('/signup', wrap(async (req, res) => {
  if (!config.allowSignup) return res.redirect('/login');
  if (req.user) return res.redirect(req.query.center ? `/workspaces/center/${encodeURIComponent(req.query.center)}` : '/app');
  // Invited to a medical centre: the new practice joins it.
  const invite = req.query.center ? await centers.inviteByToken(req.query.center) : null;
  return renderSignup(req, res, invite ? { centerInvite: { token: req.query.center, name: (req.locale === 'en' && invite.center.name_en) || invite.center.name, email: invite.email } } : {});
}));
router.post('/signup', limiter, form(async (req, res) => {
  if (!config.allowSignup) throw E.forbidden('signup');
  // A medical centre signs up its administration account: named after the centre (no clinic name of its own).
  if (!req.body.center_token && req.body.account_type === 'center') {
    if (String(req.body.center_name || '').trim().length < 2) throw E.validation({ center_name: 'Required.' });
    req.body.clinic_name = req.body.center_name;
  }
  const data = validate(z.object({
    name: z.string().trim().min(2, 'Enter your full name.').max(160),
    email: email(),
    password: password(),
    ...clinicSchema,
    terms: z.literal('on', { errorMap: () => ({ message: 'Please accept the terms to continue.' }) }),
  }), req.body);
  // Account type: one clinic, or a medical centre (several doctors, each with their own practice account sharing the
  // reception) — the first practice is created and the centre with it; or joining a centre by invitation.
  const invite = req.body.center_token ? await centers.inviteByToken(req.body.center_token) : null;
  if (req.body.center_token && !invite) throw new AppError('CENTER_INVITE_INVALID', 'This invitation is no longer valid.', 410);
  const asCenter = !invite && req.body.account_type === 'center';
  let newBid = null;
  const userId = await knex.transaction(async (trx) => {
    const id = await authService.createUser(trx, { name: data.name, email: data.email, password: data.password, locale: req.locale });
    const bid = await businesses.create(id, clinicFields(data), trx);
    newBid = bid;
    if (asCenter) {
      // The centre's administration: no clinic set-up wizard — it starts on the centre's page (add the doctors).
      await centers.create({ businessId: bid, userId: id }, { name: data.clinic_name }, trx);
      await trx('businesses').where({ id: bid }).update({ kind: 'center_admin', onboarding_completed_at: new Date() });
    }
    if (invite) await centers.accept(id, req.body.center_token, bid, trx);
    return id;
  });
  // Its own database (or its medical centre's) when separate databases are on — src/db/tenant-admin.js.
  await require('../../db/tenant-admin').placeSafely(newBid); // eslint-disable-line global-require
  const user = await authService.findUser(userId);
  await verify.send(user, { locale: req.locale }).catch(() => {});
  await signIn(req, user);
  return res.redirect(asCenter ? '/app/center' : '/app/onboarding');
}, renderSignup));

// ---------- First sign-in with a temporary password: choose your own
// Not behind requireAuth (it sends these accounts here); a signed-in session is still required.
const renderNewPassword = (req, res, extra = {}) => res.page('pages/auth/new-password', { layout: 'auth', title: req.t('auth.newpw_title'), ...extra });
const signedIn = (req, res, next) => (req.user ? next() : res.redirect('/login'));
router.get('/password/new', signedIn, wrap(async (req, res) => {
  if (!req.user.must_change_password) return res.redirect('/app/settings/security');
  return renderNewPassword(req, res);
}));
router.post('/password/new', signedIn, limiter, form(async (req, res) => {
  if (!req.user.must_change_password) return res.redirect('/app/settings/security');
  await authService.replaceTemporaryPassword({ userId: req.user.id, sessionId: req.sessionID, ip: req.ip, userAgent: req.get('user-agent') }, { password: req.body.password, confirm: req.body.password_confirm });
  flash(req, 'success', req.t('auth.newpw_done'));
  return afterLogin(req, res);
}, renderNewPassword));

// ---------- Forgot / reset password
const renderForgot = (req, res, extra = {}) => res.page('pages/auth/forgot', { layout: 'auth', title: req.t('auth.forgot_title'), sent: false, canEmail: mailer.configured(), ...extra });
router.get('/forgot', (req, res) => renderForgot(req, res));
router.post('/forgot', limiter, form(async (req, res) => {
  const data = validate(z.object({ email: email() }), req.body);
  await security.requestReset(data.email, { ip: req.ip, locale: req.locale });
  return renderForgot(req, res, { sent: true });
}, renderForgot));
const renderReset = async (req, res, extra = {}) => {
  res.set('Referrer-Policy', 'no-referrer');
  const row = await security.findReset(req.params.token);
  const target = row ? await knex('users').where({ id: row.user_id }).first('email') : null;
  return res.page('pages/auth/reset', { layout: 'auth', title: req.t('auth.reset_title'), valid: Boolean(row), resetEmail: target && target.email, token: req.params.token, ...extra });
};
router.get('/reset/:token', wrap((req, res) => renderReset(req, res)));
router.post('/reset/:token', limiter, form(async (req, res) => {
  await security.resetPassword(req.params.token, req.body.password, req.body.password_confirm, { ip: req.ip });
  if (req.session.userId) await new Promise((resolve) => { req.session.regenerate(() => resolve()); });
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
  const role = inv ? await knex('roles').where({ id: inv.role_id }).first('key', 'name', 'is_system') : null;
  const hasAccount = inv ? Boolean(await knex('users').where({ email: inv.email }).first('id')) : false;
  if (inv && hasAccount && !req.user) req.session.returnTo = `/invite/${req.params.token}`; // back here after signing in
  return res.page('pages/auth/invite', { layout: 'auth', title: req.t('auth.invite_title'), inv, role, hasAccount, token: req.params.token, ...extra });
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
    if (existing) {
      req.session.returnTo = `/invite/${req.params.token}`;
      throw E.conflict('INVITE_SIGN_IN', 'You already have an account — sign in first, then open the invitation link again.');
    }
    const data = validate(z.object({ name: z.string().trim().min(2, 'Enter your full name.').max(160), password: password() }), req.body);
    if (req.body.password_confirm !== undefined && req.body.password_confirm !== req.body.password) throw E.validation({ password_confirm: 'Passwords do not match.' });
    const id = await knex.transaction(async (trx) => {
      const uid = await authService.createUser(trx, { name: data.name, email: inv.email, password: data.password, locale: req.locale });
      await trx('users').where({ id: uid }).update({ email_verified_at: new Date() }); // the invitation link proves the address
      await businesses.acceptInvitation(inv, uid, trx);
      return uid;
    });
    user = await authService.findUser(id);
    await signIn(req, user, { businessId: inv.business_id });
  }
  req.session.businessId = inv.business_id;
  delete req.session.returnTo;
  flash(req, 'success', req.t('auth.invite_joined', { business: inv.business_name }));
  return res.redirect(await landingFor(user.id, inv.business_id));
}, renderInvite));

// ---------- Logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('db.sid'); res.redirect('/login'); });
});

// ---------- Clinics (add / switch) — used by the sidebar switcher
const renderNewWs = (req, res, extra = {}) => res.page('pages/auth/new-workspace', { layout: 'auth', title: req.t('workspaces.new_title'), ...clinicChoices(req), ...extra });
router.get('/workspaces/new', requireAuth, (req, res) => renderNewWs(req, res));
router.post('/workspaces/new', requireAuth, form(async (req, res) => {
  const data = validate(z.object(clinicSchema), req.body);
  const id = await knex.transaction((trx) => businesses.create(req.user.id, clinicFields(data), trx));
  await require('../../db/tenant-admin').placeSafely(id); // eslint-disable-line global-require -- its own database when they are on
  req.session.businessId = id;
  return res.redirect('/app/onboarding');
}, renderNewWs));
// ---------- Joining a medical centre by invitation: open a new practice in it, or bring a clinic you own
const renderJoin = async (req, res, invite, extra = {}) => {
  const owned = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').join('businesses as b', 'b.id', 'm.business_id')
    .where({ 'm.user_id': req.user.id, 'r.key': 'owner', 'b.status': 'active' }).whereNull('b.center_id').select('b.id', 'b.name');
  return res.page('pages/auth/center-join', { layout: 'auth', title: req.t('center.join_title'), invite, owned, token: req.params.token, pageStyles: ['/css/center.css'], pageScripts: ['/js/center.js'], ...clinicChoices(req), ...extra });
};
router.get('/workspaces/center/:token', wrap(async (req, res) => {
  const invite = await centers.inviteByToken(req.params.token);
  if (!req.user) {
    if (!invite) return res.page('pages/auth/center-join', { layout: 'auth', title: req.t('center.join_title'), invite: null });
    req.session.returnTo = `/workspaces/center/${req.params.token}`;
    return res.redirect(`/signup?center=${encodeURIComponent(req.params.token)}`);
  }
  if (!invite) return res.page('pages/auth/center-join', { layout: 'auth', title: req.t('center.join_title'), invite: null });
  return renderJoin(req, res, invite);
}));
router.post('/workspaces/center/:token', requireAuth, wrap(async (req, res) => {
  const invite = await centers.inviteByToken(req.params.token);
  if (!invite) return res.page('pages/auth/center-join', { layout: 'auth', title: req.t('center.join_title'), invite: null });
  try {
    let bid;
    if (req.body.mode === 'existing') {
      bid = Number(req.body.business_id) || 0;
      await centers.accept(req.user.id, req.params.token, bid);
      // Its data joins the centre's database (the shared reception and cash screen work across its practices).
      await require('../../db/tenant-admin').intoCenter(bid).catch((e) => console.error('[db] joining the centre database failed:', e.message)); // eslint-disable-line global-require, no-console
    } else {
      const data = validate(z.object(clinicSchema), req.body);
      bid = await knex.transaction(async (trx) => {
        const id = await businesses.create(req.user.id, clinicFields(data), trx);
        await centers.accept(req.user.id, req.params.token, id, trx);
        return id;
      });
      await require('../../db/tenant-admin').placeSafely(bid); // eslint-disable-line global-require -- in the centre's database
    }
    req.session.businessId = bid;
    await knex('users').where({ id: req.user.id }).update({ last_business_id: bid });
    flash(req, 'success', req.t('center.joined', { center: invite.center.name }));
    return res.redirect(req.body.mode === 'existing' ? '/app/center' : '/app/onboarding');
  } catch (err) {
    if (!(err instanceof AppError) || err.status >= 500) throw err;
    res.status(err.status === 403 ? 403 : 422);
    const errors = err.code === 'VALIDATION_FAILED' ? err.details || {} : {};
    return renderJoin(req, res, invite, { errors, old: req.body, formError: { message: err.code === 'VALIDATION_FAILED' ? req.t('errors.VALIDATION_FAILED') : (req.t(`center.err.${err.code}`) !== `center.err.${err.code}` ? req.t(`center.err.${err.code}`) : err.message) } });
  }
}));

router.post('/workspaces/switch', requireAuth, wrap(async (req, res) => {
  const id = Number(req.body.business_id);
  if (!(await businesses.isMember(req.user.id, id))) throw E.forbidden('workspace');
  req.session.businessId = id;
  await knex('users').where({ id: req.user.id }).update({ last_business_id: id });
  res.redirect(await landingFor(req.user.id, id));
}));

// The branch the member works in (clinics with branches): '' all, 'main', or one of this clinic's branches.
router.post('/workspaces/branch', requireAuth, wrap(async (req, res) => {
  const b = Number(req.session.businessId) || 0;
  const v = String(req.body.branch || '');
  const ok = v === '' || v === 'main' || (/^\d+$/.test(v) && await knex('clinic_branches').where({ business_id: b, id: Number(v) }).first('id'));
  if (!ok || !(await businesses.isMember(req.user.id, b))) throw E.forbidden('branch');
  // a member tied to a branch (Team) cannot switch
  const m = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.business_id': b, 'm.user_id': req.user.id }).first('m.work_branch', 'r.key');
  if (m && m.work_branch && m.key !== 'owner') throw E.forbidden('branch');
  req.session.workBranch = { ...(req.session.workBranch || {}), [b]: v };
  const back = String(req.body.return_to || '');
  res.redirect(/^\/app(\/[\w\-/]*)?$/.test(back.split('?')[0]) && !back.startsWith('//') ? back.split('?')[0] : '/app/appointments');
}));

module.exports = router;
