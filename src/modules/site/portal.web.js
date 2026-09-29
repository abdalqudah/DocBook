// Clinic portal (the earlier company portal, adapted to clinics): docbook/<slug> is the clinic's
// own public page — details, doctors, services, the online-booking button — and its staff entrance:
// choose a role → sign in on a page branded with the clinic → land on that role's screen.
// Mounted LAST (after /app, /admin and the auth routes) so it never shadows a platform path.
const express = require('express');
const rateLimit = require('express-rate-limit');
const knex = require('../../db/knex');
const config = require('../../config');
const theme = require('../branding/theme');
const { z, validate, email } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { translateMessage } = require('../../core/i18n');
const businesses = require('../businesses/business.service');
const authService = require('../auth/auth.service');
const { signIn, landingFor } = require('../auth/session');
const { PORTAL_ROLES } = require('../rbac/permissions');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isTest ? 1000 : 30, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(E.rateLimited()) });

// ---------------------------------------------------------------- helpers shared with the booking pages
const SAFE_MAP = /^https:\/\/[^\s<>"']+$/i;

/** The clinic row for /<slug> with the texts in the visitor's language (null for unknown or suspended clinics). */
async function loadClinic(req) {
  const b = await businesses.bySlug(req.params.slug);
  if (!b || b.status !== 'active') return null;
  const en = req.locale === 'en';
  const digits = (v) => String(v || '').replace(/[^0-9]/g, '');
  return {
    ...b,
    displayName: (en && b.name_en) || b.name,
    otherName: en ? (b.name_en ? b.name : null) : b.name_en,
    aboutText: (en ? b.about_en || b.about : b.about || b.about_en) || '',
    telHref: b.phone ? `tel:${String(b.phone).replace(/[^0-9+]/g, '')}` : null,
    waHref: digits(b.whatsapp) ? `https://wa.me/${digits(b.whatsapp)}` : null,
    mapHref: b.map_url && SAFE_MAP.test(b.map_url) ? b.map_url : null,
  };
}

/** Page styles for a clinic page: the site stylesheet plus the clinic's own brand colour (when it set one). */
const clinicStyles = (clinic) => ['/css/site.css', ...(clinic.color && theme.HEX.test(clinic.color) ? [`/${clinic.slug}/theme.css`] : [])];

const doctorView = (req) => (d) => {
  const en = req.locale === 'en';
  const bio = (en ? d.bio_en || d.bio : d.bio || d.bio_en) || '';
  return {
    id: d.id, name: (en && d.full_name_en) || d.full_name, specialty: (en ? d.specialization_en || d.specialization : d.specialization || d.specialization_en) || '',
    fee: d.show_consultation_fee ? Number(d.consultation_fee) || 0 : null, color: d.color && theme.HEX.test(d.color) ? d.color : null,
    bio: bio.length > 180 ? `${bio.slice(0, 177).trim()}…` : bio, slot: d.slot_duration_minutes,
  };
};
const listDoctors = async (req, clinic) => (await knex('doctors').where({ business_id: clinic.id, is_active: true })
  .orderBy([{ column: 'sort_order' }, { column: 'full_name' }])
  .select('id', 'full_name', 'full_name_en', 'specialization', 'specialization_en', 'bio', 'bio_en', 'consultation_fee', 'show_consultation_fee', 'color', 'slot_duration_minutes'))
  .map(doctorView(req));
const listServices = async (req, clinic) => (await knex('services').where({ business_id: clinic.id, is_active: true })
  .orderBy([{ column: 'sort_order' }, { column: 'name' }])
  .select('id', 'doctor_id', 'name', 'name_en', 'description', 'description_en', 'price', 'show_price', 'duration_minutes'))
  .map((s) => ({
    id: s.id, doctorId: s.doctor_id, name: (req.locale === 'en' && s.name_en) || s.name,
    description: (req.locale === 'en' ? s.description_en || s.description : s.description || s.description_en) || '',
    price: s.show_price ? Number(s.price) || 0 : null, duration: s.duration_minutes,
  }));

const roleLabel = (req, m) => (m.is_system ? req.t(`roles.${m.role_key}`) : m.role_name);
const membershipOf = (userId, businessId) => knex('memberships as m').join('roles as r', 'r.id', 'm.role_id')
  .where({ 'm.user_id': userId, 'm.business_id': businessId, 'm.status': 'active' }).first('r.key as role_key', 'r.name as role_name', 'r.is_system');

// ---------------------------------------------------------------- clinic page
router.get('/:slug', wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  const [doctors, services, member] = await Promise.all([
    listDoctors(req, clinic), listServices(req, clinic), req.user ? membershipOf(req.user.id, clinic.id) : null,
  ]);
  const doctorNames = Object.fromEntries(doctors.map((d) => [d.id, d.name]));
  res.locals.currency = clinic.currency;
  return res.page('pages/portal/home', {
    layout: 'public', title: clinic.displayName, pageTitle: clinic.displayName, metaDescription: clinic.aboutText.slice(0, 160),
    clinic, doctors, services, doctorNames, member, memberRole: member ? roleLabel(req, member) : null,
    roles: PORTAL_ROLES, pageStyles: clinicStyles(clinic),
  });
}));

// Public logo (the /app/logo route is for members only).
router.get('/:slug/logo', wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  const row = await businesses.logo(clinic.id);
  if (!row || !row.logo) return res.status(404).end();
  res.set({ 'Content-Type': row.logo_mime, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  return res.send(row.logo);
}));

// The clinic's brand colour for its public pages.
router.get('/:slug/theme.css', wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  return res.send(theme.businessCss(clinic.color));
}));

// ---------------------------------------------------------------- staff sign-in
const roleFrom = (v) => (PORTAL_ROLES.some((r) => r.key === v) ? v : null);

async function renderLogin(req, res, clinic, extra = {}) {
  const as = roleFrom(req.query.as || (req.body && req.body.as));
  const member = req.user ? await membershipOf(req.user.id, clinic.id) : null;
  return res.page('pages/portal/login', {
    layout: 'public', title: req.t('portal.login_title', { clinic: clinic.displayName }), clinic, roles: PORTAL_ROLES, as,
    member, memberRole: member ? roleLabel(req, member) : null, hideBookCta: true, pageStyles: clinicStyles(clinic), ...extra,
  });
}

router.get('/:slug/login', wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  res.set('Referrer-Policy', 'same-origin');
  return renderLogin(req, res, clinic);
}));

router.post('/:slug/login', loginLimiter, wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  const fail = (status, message, errors = {}) => { res.status(status); return renderLogin(req, res, clinic, { formError: { code: 'LOGIN', message }, errors, old: { email: req.body.email } }); };
  let user;
  try {
    const data = validate(z.object({ email: email(), password: z.string().min(1, 'Password is required.') }), req.body);
    user = await authService.authenticate(data, { ip: req.ip, userAgent: req.get('user-agent') });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.code === 'VALIDATION_FAILED') {
      return fail(422, req.t('errors.VALIDATION_FAILED'), Object.fromEntries(Object.entries(err.details || {}).map(([k, v]) => [k, translateMessage(req.locale, v)])));
    }
    const translated = req.t(`errors.${err.code}`);
    return fail(err.status || 401, translated !== `errors.${err.code}` ? translated : req.t('errors.INVALID_CREDENTIALS'));
  }
  // The password was right, but the account must work at THIS clinic.
  const m = await membershipOf(user.id, clinic.id);
  if (!m) return fail(403, req.t('portal.not_member'));
  await signIn(req, user, { businessId: clinic.id });
  delete req.session.returnTo;
  await knex('users').where({ id: user.id }).update({ last_business_id: clinic.id });
  if (!req.cookies.db_lang && user.locale) res.cookie('db_lang', user.locale, { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: true, secure: config.isProd });
  const chosen = roleFrom(req.body.as);
  const same = !chosen || chosen === m.role_key || (chosen === 'clinic_manager' && m.role_key === 'owner');
  if (!same) flash(req, 'info', req.t('portal.role_mismatch', { actual: roleLabel(req, m), chosen: req.t(`roles.${chosen}`) }));
  return res.redirect(await landingFor(user.id, clinic.id));
}));

// Already signed in and a member: open this clinic (a form post, so another site cannot switch someone's clinic with a link).
router.post('/:slug/enter', wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  if (!req.user || !(await membershipOf(req.user.id, clinic.id))) return res.redirect(`/${clinic.slug}/login`);
  req.session.businessId = clinic.id;
  await knex('users').where({ id: req.user.id }).update({ last_business_id: clinic.id });
  return res.redirect(await landingFor(req.user.id, clinic.id));
}));

module.exports = router;
module.exports.loadClinic = loadClinic;
module.exports.clinicStyles = clinicStyles;
module.exports.listDoctors = listDoctors;
module.exports.listServices = listServices;
