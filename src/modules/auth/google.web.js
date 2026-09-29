// Sign in with Google: /auth/google (start) and /auth/google/callback. Mounted by auth/web.js.
// Also sets res.locals.googleOn so the sign-in pages (main login and the clinic staff login) show the button.
const express = require('express');
const rateLimit = require('express-rate-limit');
const knex = require('../../db/knex');
const config = require('../../config');
const { AppError, E } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const businesses = require('../businesses/business.service');
const { PORTAL_ROLES } = require('../rbac/permissions');
const google = require('./google.service');
const { signIn, afterLogin, landingFor } = require('./session');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isTest ? 1000 : 30, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(E.rateLimited()) });

/** Translated text for a Google/identity error code. */
function errorText(req, err) {
  for (const key of [`errors_identity.${err.code}`, `errors.${err.code}`]) {
    const s = req.t(key);
    if (s !== key) return s;
  }
  return err.message;
}

// The sign-in button shows only when the platform admin configured Google.
router.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  return google.enabled().then((on) => { res.locals.googleOn = on; next(); }, () => { res.locals.googleOn = false; next(); });
});

/** Google sends the browser back to APP_URL, so the flow has to start there (the session cookie is per host). */
function appHostRedirect(req) {
  if (!process.env.APP_URL) return null;
  let appHost;
  try { appHost = new URL(config.appUrl).host.toLowerCase(); } catch { return null; }
  return String(req.get('host') || '').toLowerCase() === appHost ? null : `${google.appBase()}${req.originalUrl}`;
}

const portalLoginUrl = (p) => (p && p.portal ? `/${p.portal}/login${p.as ? `?as=${encodeURIComponent(p.as)}` : ''}` : '/login');

router.get('/auth/google', limiter, wrap(async (req, res) => {
  const elsewhere = appHostRedirect(req);
  if (elsewhere) return res.redirect(elsewhere);
  const portal = String(req.query.portal || '');
  if (req.user && !portal) return res.redirect(req.user.must_change_password ? '/password/new' : await landingFor(req.user.id, req.session.businessId));
  try {
    const { url, pending } = await google.start({ intent: 'login', portal, as: req.query.as });
    req.session.googleAuth = pending;
    return req.session.save(() => res.redirect(url));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    flash(req, 'error', errorText(req, err));
    return res.redirect(portalLoginUrl({ portal: /^[a-z0-9-]{2,40}$/.test(portal) ? portal : '' }));
  }
}));

// Linking (Settings → Security): only right after the password was confirmed there.
router.get('/auth/google/link', limiter, wrap(async (req, res) => {
  const ok = req.session.googleLinkOk;
  delete req.session.googleLinkOk;
  if (!req.user) return res.redirect('/login');
  if (!ok || ok.userId !== req.user.id || Date.now() - ok.at > 5 * 60_000) return res.redirect('/app/settings/security#google');
  try {
    const { url, pending } = await google.start({ intent: 'link' });
    req.session.googleAuth = { ...pending, userId: req.user.id };
    return req.session.save(() => res.redirect(url));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    flash(req, 'error', errorText(req, err));
    return res.redirect('/app/settings/security');
  }
}));

router.get('/auth/google/callback', limiter, wrap(async (req, res) => {
  const pending = req.session.googleAuth;
  delete req.session.googleAuth; // one use only
  const ctx = { ip: req.ip, userAgent: req.get('user-agent') };

  // Linking from Settings → Security (the signed-in user started it after confirming their password).
  if (pending && pending.intent === 'link') {
    try {
      if (!req.user || req.user.id !== pending.userId) throw new AppError('GOOGLE_STATE', 'This sign-in link has expired or was opened in another browser. Please start again.', 400);
      const g = await google.verify(pending, req.query);
      await google.link({ ...ctx, businessId: req.session.businessId || null }, req.user.id, g);
      flash(req, 'success', req.t('identity.google_linked_done', { email: g.email }));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      flash(req, 'error', errorText(req, err));
    }
    return res.redirect(req.user ? '/app/settings/security' : '/login');
  }

  const clinic = pending && pending.portal ? await businesses.bySlug(pending.portal) : null;
  const backTo = portalLoginUrl(pending);
  try {
    const g = await google.verify(pending, req.query);
    if (pending.portal && (!clinic || clinic.status !== 'active')) throw E.notFound('Clinic');
    const user = await google.resolve(g, ctx);
    let membership = null;
    if (clinic) {
      // Same rule as the password form on /<slug>/login: the account must work at THIS clinic.
      membership = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id')
        .where({ 'm.user_id': user.id, 'm.business_id': clinic.id, 'm.status': 'active' }).first('r.key as role_key', 'r.name as role_name', 'r.is_system');
      if (!membership) throw new AppError('PORTAL_NOT_MEMBER', 'This account is not a staff member of this clinic.', 403);
    }
    await signIn(req, user, clinic ? { businessId: clinic.id } : {});
    if (!req.cookies.db_lang && user.locale) res.cookie('db_lang', user.locale, { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: true, secure: config.isProd });
    if (!clinic) return afterLogin(req, res);
    delete req.session.returnTo;
    await knex('users').where({ id: user.id }).update({ last_business_id: clinic.id });
    const chosen = PORTAL_ROLES.some((r) => r.key === pending.as) ? pending.as : null;
    if (chosen && !(chosen === membership.role_key || (chosen === 'clinic_manager' && membership.role_key === 'owner'))) {
      const actual = membership.is_system ? req.t(`roles.${membership.role_key}`) : membership.role_name;
      flash(req, 'info', req.t('portal.role_mismatch', { actual, chosen: req.t(`roles.${chosen}`) }));
    }
    // Temporary passwords are still replaced first.
    if (user.must_change_password) return res.redirect('/password/new');
    return res.redirect(await landingFor(user.id, clinic.id));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    const message = err.code === 'PORTAL_NOT_MEMBER' ? req.t('portal.not_member') : errorText(req, err);
    if (clinic) { flash(req, 'error', message); return res.redirect(backTo); }
    res.status(err.status >= 500 ? 502 : (err.status || 400));
    return res.page('pages/auth/login', { layout: 'auth', title: req.t('auth.login_title'), formError: { code: err.code, message } });
  }
}));

module.exports = router;
module.exports.errorText = errorText;
module.exports.appHostRedirect = appHostRedirect;
