// Public pages for medical reps, drug warehouses and supplier companies (/vendors):
//   GET  /vendors            what they get + how it works
//   GET  /vendors/signup     sign-up (new account) — or, for a signed-in account without a vendor, "register as a rep"
//   POST /vendors/signup     account + vendor (pending) + owner link + specialties in one transaction, then /vendor
//   GET  /vendors/media/:kind/:id/:file   vendor logo / product image / offer image (nosniff; public only when visible to clinics)
// An e-mail that already has an account is not taken over: the person is asked to sign in first and is brought
// back here, where the signed-in variant of the form registers that same account as a rep.
const express = require('express');
const rateLimit = require('express-rate-limit');
const knex = require('../../db/knex');
const config = require('../../config');
const mailer = require('../../core/mailer');
const brand = require('../../config/brand');
const { E } = require('../../core/errors');
const { translator } = require('../../core/i18n');
const { wrap, flash } = require('../../routes/helpers');
const authService = require('../auth/auth.service');
const verify = require('../auth/verify.service');
const { signIn } = require('../auth/session');
const options = require('../settings/options');
const vendors = require('./vendor.service');
const { form } = require('./form');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isTest ? 1000 : 20, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(E.rateLimited()) });

const choices = (req) => ({
  specialtyOptions: vendors.TARGET_SPECIALTIES.map((k) => ({ value: k, label: req.t(`specialties.${k}`) })),
  countryOptions: options.countryOptions(req.locale),
  typeOptions: vendors.TYPES,
});

// ---------------------------------------------------------------- landing
router.get('/', wrap(async (req, res) => {
  const mine = req.user ? await vendors.vendorOfUser(req.user.id) : null;
  res.page('pages/vendors/landing', {
    layout: 'public', title: req.t('vendors.landing_title'), metaDescription: req.t('vendors.landing_lead'), pageStyles: ['/css/vendors.css'], mine,
  });
}));

// ---------------------------------------------------------------- sign-up
const renderSignup = async (req, res, extra = {}) => {
  const mine = req.user ? await vendors.vendorOfUser(req.user.id) : null;
  if (mine) return res.redirect('/vendor');
  return res.page('pages/vendors/signup', {
    layout: 'public', title: req.t('vendors.signup_title'), pageStyles: ['/css/vendors.css'], existing: Boolean(req.user), ...choices(req), ...extra,
  });
};
router.get('/signup', wrap((req, res) => renderSignup(req, res)));

/** Tells platform admins (when e-mail is set up) that a new vendor is waiting for approval. */
async function notifyAdmins(res, vendorId, name) {
  if (!mailer.configured()) return;
  const admins = await knex('users').where({ is_platform_admin: true, status: 'active' }).select('email', 'locale');
  const base = String(res.locals.baseUrl || config.appUrl).replace(/\/+$/, '');
  await Promise.all(admins.map((a) => {
    const t = translator(a.locale || 'ar');
    return mailer.send({
      to: a.email, subject: `${brand.name} — ${t('vendors.mail_admin_subject')}`,
      html: mailer.layout({ locale: a.locale, title: t('vendors.mail_admin_subject'), body: t('vendors.mail_admin_body', { name }), cta: t('vendors.mail_admin_cta'), href: `${base}/admin/vendors/${vendorId}` }),
    }).catch(() => {});
  }));
}

router.post('/signup', limiter, form(async (req, res) => {
  const ctx = { ip: req.ip, userAgent: req.get('user-agent') };
  if (req.user) {
    const vendorId = await vendors.registerExisting(req.user, req.body, { ctx: { ...ctx, userId: req.user.id } });
    await notifyAdmins(res, vendorId, String(req.body.name || '')).catch(() => {});
    flash(req, 'success', req.t('vendors.signup_done'));
    return res.redirect('/vendor');
  }
  if (!config.allowSignup) throw E.forbidden('signup');
  let out;
  try {
    out = await vendors.signup(req.body, { locale: req.locale, ctx });
  } catch (err) {
    if (err.code === 'VENDOR_EMAIL_TAKEN' || err.code === 'EMAIL_TAKEN') req.session.returnTo = '/vendors/signup';
    throw err;
  }
  const user = await authService.findUser(out.userId);
  await verify.send(user, { locale: req.locale }).catch(() => {});
  await notifyAdmins(res, out.vendorId, String(req.body.name || '')).catch(() => {});
  await signIn(req, user);
  delete req.session.returnTo;
  flash(req, 'success', req.t('vendors.signup_done'));
  return res.redirect('/vendor');
}, renderSignup));

// ---------------------------------------------------------------- media
// Ad images (vendors' paid ads shown to doctors): not sensitive, short cache.
router.get('/ad-image/:id(\\d+)', wrap(async (req, res, next) => {
  const f = await require('../vendorbilling/billing.service').adImage(req.params.id); // eslint-disable-line global-require
  if (!f || !f.image) return next();
  res.set({ 'Content-Type': f.image_mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=600', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-site' });
  return res.end(f.image);
}));
router.get('/media/:kind(logo|product|offer)/:id(\\d+)/:file', wrap(async (req, res, next) => {
  const [ver] = String(req.params.file).split('.');
  const f = await vendors.mediaFile(req.params.kind, Number(req.params.id), { userId: req.user && req.user.id, isPlatformAdmin: Boolean(req.user && req.user.is_platform_admin) });
  if (!f) return next();
  const etag = `"${f.version}"`;
  const cache = f.isPublic ? (ver === f.version ? 'public, max-age=31536000, immutable' : 'public, max-age=300') : 'private, max-age=300';
  res.set({
    'Content-Type': f.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': cache, ETag: etag, 'Content-Disposition': 'inline',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", 'Cross-Origin-Resource-Policy': 'same-site',
  });
  if (req.get('if-none-match') === etag) return res.status(304).end();
  res.set('Content-Length', String(f.data.length));
  return res.end(f.data);
}));

module.exports = router;
