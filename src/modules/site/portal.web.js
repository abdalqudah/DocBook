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
const seo = require('./seo.service');

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
  // The specialty as words in the visitor's language (the setting stores a key such as "dentistry").
  if (req.res && req.res.locals) req.res.locals.faviconHref = businesses.faviconPath(b, `/${b.slug}`); // the clinic's browser icon on its pages
  // Dark mode turned off on the clinic's published site: every public page of the clinic stays light.
  if (req.res && req.res.locals) {
    const pub = await require('../website/site.service').publicState(b.id); // eslint-disable-line global-require
    req.res.locals.siteLight = Boolean(pub.doc && pub.doc.header && pub.doc.header.dark_mode === false);
  }
  const specialtyLabel = b.specialty ? ((k) => { const v = req.t(k); return v === k ? b.specialty : v; })(`specialties.${b.specialty}`) : '';
  return {
    ...b,
    specialtyKey: b.specialty || null,
    specialty: specialtyLabel,
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

/** Clinic-wide price display: 'site' (website pages, search data) or 'booking' (the booking pages). On unless turned off. */
const pricesShown = (clinic, where = 'site') => {
  const v = clinic && clinic[where === 'booking' ? 'prices_on_booking' : 'prices_on_site'];
  return v === undefined || v === null || Boolean(Number(v));
};

const doctorView = (req, prices = true) => (d) => {
  const en = req.locale === 'en';
  const bio = (en ? d.bio_en || d.bio : d.bio || d.bio_en) || '';
  return {
    id: d.id, name: (en && d.full_name_en) || d.full_name, specialty: (en ? d.specialization_en || d.specialization : d.specialization || d.specialization_en) || '',
    fee: prices && d.show_consultation_fee ? Number(d.consultation_fee) || 0 : null, color: d.color && theme.HEX.test(d.color) ? d.color : null,
    bio: bio.length > 180 ? `${bio.slice(0, 177).trim()}…` : bio, slot: d.slot_duration_minutes, online: Boolean(d.online_enabled),
    branchId: d.branch_id || null, // null = main branch
  };
};
const listDoctors = async (req, clinic, where = 'site') => {
  const [rows, photos] = await Promise.all([
    knex('doctors').where({ business_id: clinic.id, is_active: true }).orderBy([{ column: 'sort_order' }, { column: 'full_name' }])
      .select('id', 'full_name', 'full_name_en', 'specialization', 'specialization_en', 'bio', 'bio_en', 'consultation_fee', 'show_consultation_fee', 'color', 'slot_duration_minutes', 'online_enabled', 'branch_id'),
    require('../integrations/media.service').publicDoctorPhotos(clinic), // eslint-disable-line global-require
  ]);
  return rows.map(doctorView(req, pricesShown(clinic, where))).map((d) => ({ ...d, photo: photos[d.id] || null })); // photo: public media-library URL (or null)
};
// Services with their (active) category, if any — the pages group them by category (platformops).
const listServices = async (req, clinic, where = 'site') => (await knex('services as s').leftJoin('service_categories as c', function j() { this.on('c.id', 's.category_id').andOn('c.business_id', 's.business_id').andOnVal('c.is_active', true); })
  .where({ 's.business_id': clinic.id, 's.is_active': true })
  .orderBy([{ column: 's.sort_order' }, { column: 's.name' }])
  .select('s.id', 's.doctor_id', 's.name', 's.name_en', 's.description', 's.description_en', 's.price', 's.show_price', 's.duration_minutes', 'c.id as category_id', 'c.name as category_name', 'c.name_en as category_name_en', 'c.sort_order as category_sort'))
  .map((s) => ({
    id: s.id, doctorId: s.doctor_id, name: (req.locale === 'en' && s.name_en) || s.name,
    description: (req.locale === 'en' ? s.description_en || s.description : s.description || s.description_en) || '',
    price: s.show_price && pricesShown(clinic, where) ? Number(s.price) || 0 : null, duration: s.duration_minutes,
    category: s.category_id ? { id: s.category_id, name: (req.locale === 'en' && s.category_name_en) || s.category_name, sort: s.category_sort } : null,
  }));

const roleLabel = (req, m) => (m.is_system ? req.t(`roles.${m.role_key}`) : m.role_name);
const membershipOf = (userId, businessId) => knex('memberships as m').join('roles as r', 'r.id', 'm.role_id')
  .where({ 'm.user_id': userId, 'm.business_id': businessId, 'm.status': 'active' }).first('r.key as role_key', 'r.name as role_name', 'r.is_system');

// ---------------------------------------------------------------- clinic page
/** Renders a website document (the published version, or the draft in the member-only preview). */
async function renderSite(req, res, clinic, doc, { preview = false, page = null } = {}) {
  const site = require('../website/render'); // eslint-disable-line global-require
  const data = await site.locals(req, clinic, doc, { preview, portal: { listDoctors, listServices }, page });
  res.locals.siteLight = Boolean(doc.header && doc.header.dark_mode === false); // the draft's own choice in the preview
  data.wsSite.whiteLabel = await require('../platformops/ops.service').entitled(clinic, 'website.white_label'); // eslint-disable-line global-require
  res.locals.currency = clinic.currency;
  clinic.reviews = data.reviewsSummary;
  const L = (v) => (v && (v[req.locale] || v[req.locale === 'en' ? 'ar' : 'en'])) || '';
  const sub = data.page && data.page.key !== 'home' ? data.page : null;
  const title = sub ? `${L(sub.seo && sub.seo.title) || L(sub.title)} · ${clinic.displayName}` : (L(doc.seo && doc.seo.title) || clinic.displayName);
  const description = (sub && L(sub.seo && sub.seo.description)) || L(doc.seo && doc.seo.description) || clinic.aboutText || [clinic.specialty, clinic.city].filter(Boolean).join(' · ');
  const share = doc.seo && doc.seo.image ? data.img(doc.seo.image) : null;
  let seoHead = null;
  if (!preview) {
    // Facts for search engines and AI assistants: services and prices, FAQ of this page, social profiles.
    const shownPage = data.page || doc.pages[0];
    const other = req.locale === 'en' ? 'ar' : 'en';
    const faq = shownPage.sections.filter((x) => x.type === 'faq' && x.visible)
      .flatMap((x) => ((x.content[req.locale] && x.content[req.locale].items && x.content[req.locale].items.length) ? x.content[req.locale].items : ((x.content[other] && x.content[other].items) || [])));
    const services = data.services.length ? data.services : await listServices(req, clinic);
    const sameAs = Object.values((doc.footer && doc.footer.social) || {}).filter(Boolean);
    seoHead = await seo.head(req, res, {
      kind: 'clinic', clinic, doctors: data.doctors.length ? data.doctors : await listDoctors(req, clinic), title, description, shareImage: share ? share.url : null, hide: Boolean(doc.seo && doc.seo.hide),
      ws: { seo: doc.seo, faq, services, sameAs, path: sub ? `/${clinic.slug}/p/${sub.slug}` : null, pageName: sub ? L(sub.title) : null },
    });
  }
  res.locals.wsConnections = await require('../website/marketing.service').get(clinic.id); // eslint-disable-line global-require -- Website → Connections
  const fav = doc.brand && doc.brand.faviconMediaId ? data.img(doc.brand.faviconMediaId) : null;
  return res.page('pages/portal/site', {
    layout: 'public', title, pageTitle: title, metaDescription: description.slice(0, 160), seoHead, noindex: preview, clinic, ...data,
    bodyClass: `ws-body ws-theme-${doc.theme}`, faviconHref: fav ? fav.url : res.locals.faviconHref, // the website's own icon, else the clinic's
    pageStyles: [...clinicStyles(clinic).filter((h) => !h.endsWith('/theme.css')), '/css/website.css', preview ? '/app/website/preview/theme.css' : `/${clinic.slug}/theme.css`, '/css/telehealth.css'],
  });
}

// The classic clinic page (clinics that never published from the website builder see exactly this, as before).
async function renderClassic(req, res, clinic) {
  const [doctors, services, member] = await Promise.all([
    listDoctors(req, clinic), listServices(req, clinic), req.user ? membershipOf(req.user.id, clinic.id) : null,
  ]);
  const doctorNames = Object.fromEntries(doctors.map((d) => [d.id, d.name]));
  res.locals.currency = clinic.currency;
  clinic.reviews = await require('../reviews/reviews.service').publicSummary(clinic.id); // eslint-disable-line global-require -- verified reviews: page section + JSON-LD
  clinic.media = await require('../integrations/media.service').publicPage(clinic, req.locale); // eslint-disable-line global-require -- cover + gallery from the media library
  // Search tags and schema.org MedicalClinic + Physician data; the clinic's own pixels only after its visitors accept.
  const seoHead = await seo.head(req, res, { kind: 'clinic', clinic, doctors, title: clinic.displayName, description: clinic.aboutText || [clinic.specialty, clinic.city].filter(Boolean).join(' · ') });
  return res.page('pages/portal/home', {
    layout: 'public', title: clinic.displayName, pageTitle: clinic.displayName, metaDescription: clinic.aboutText.slice(0, 160), seoHead,
    clinic, doctors, services, doctorNames, member, memberRole: member ? roleLabel(req, member) : null,
    roles: PORTAL_ROLES, pageStyles: [...clinicStyles(clinic), '/css/telehealth.css'],
  });
}

router.get('/:slug', wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  require('../website/stats').hit(req, clinic, 'home'); // eslint-disable-line global-require -- first-party daily counter, no cookies
  const state = await require('../website/site.service').publicState(clinic.id); // eslint-disable-line global-require
  if (state.status === 'live' && state.doc) return renderSite(req, res, clinic, state.doc);
  if (state.status === 'unpublished') {
    // Taken down by the clinic: its name, contact and the booking button stay (printed QR codes and reminder links).
    return res.page('pages/portal/offline', { layout: 'public', title: clinic.displayName, pageTitle: clinic.displayName, noindex: true, clinic, pageStyles: [...clinicStyles(clinic), '/css/website.css'] });
  }
  return renderClassic(req, res, clinic);
}));

// ---------------------------------------------------------------- the clinic for search engines and AI assistants
// /<slug>/llms.txt (also /llms.txt on the clinic's own domain), and on its own domain robots.txt and sitemap.xml.
async function crawlContext(req, res) {
  const clinic = await loadClinic(req);
  if (!clinic) return null;
  const st = await require('../website/site.service').publicState(clinic.id); // eslint-disable-line global-require
  const doc = st.status === 'live' ? st.doc : null;
  const s = await seo.get();
  const base = seo.baseUrl(req, s);
  const custom = res.locals.customDomain && res.locals.customDomain.slug === clinic.slug;
  const siteBase = custom ? `${req.protocol}://${res.locals.customDomain.host}` : `${base}/${clinic.slug}`;
  return { clinic, doc, s, base, siteBase, custom };
}
router.get('/:slug/llms.txt', wrap(async (req, res, next) => {
  const c = await crawlContext(req, res);
  if (!c) return next();
  if (c.doc && c.doc.seo && c.doc.seo.ai && c.doc.seo.ai.bots === 'block') return next(); // the clinic opted out of AI assistants
  const [doctors, services, reviews] = await Promise.all([listDoctors(req, c.clinic), listServices(req, c.clinic), require('../reviews/reviews.service').publicSummary(c.clinic.id)]); // eslint-disable-line global-require
  const text = seo.clinicLlms({ clinic: c.clinic, doc: c.doc, doctors, services, reviews, base: c.base, siteBase: c.siteBase });
  return res.set('Cache-Control', 'public, max-age=1800').type('text/plain; charset=utf-8').send(text);
}));
router.get('/:slug/robots.txt', wrap(async (req, res, next) => {
  const c = await crawlContext(req, res);
  if (!c || !c.custom) return next();
  const sd = (c.doc && c.doc.seo) || {};
  return res.set('Cache-Control', 'public, max-age=3600').type('text/plain; charset=utf-8')
    .send(seo.clinicRobots({ siteBase: c.siteBase, slugPrefix: '', blockAi: sd.ai && sd.ai.bots === 'block', hide: Boolean(sd.hide) }));
}));
router.get('/:slug/sitemap.xml', wrap(async (req, res, next) => {
  const c = await crawlContext(req, res);
  if (!c || !c.custom) return next();
  const doctors = await listDoctors(req, c.clinic);
  return res.set('Cache-Control', 'public, max-age=3600').type('application/xml; charset=utf-8').send(seo.clinicSitemap({ siteBase: c.siteBase, doc: c.doc, doctors, at: c.clinic.updated_at }));
}));

// Another page of the published website: /<slug>/p/<page>.
router.get('/:slug/p/:page([a-z0-9-]{1,40})', wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  const state = await require('../website/site.service').publicState(clinic.id); // eslint-disable-line global-require
  if (state.status !== 'live' || !state.doc) return next();
  const page = state.doc.pages.find((p) => p.key !== 'home' && p.slug === req.params.page);
  if (!page) return next();
  return renderSite(req, res, clinic, state.doc, { page });
}));

// A doctor's own page (website): photo, specialty, full bio, their services, rating, and booking with them.
router.get('/:slug/doctors/:id(\\d{1,10})', wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  const [doctors, services] = await Promise.all([listDoctors(req, clinic), listServices(req, clinic)]);
  const d = doctors.find((x) => x.id === Number(req.params.id));
  if (!d) return next();
  require('../website/stats').hit(req, clinic, 'doctor'); // eslint-disable-line global-require
  const full = await knex('doctors').where({ business_id: clinic.id, id: d.id }).first('bio', 'bio_en');
  d.bioFull = (req.locale === 'en' ? full.bio_en || full.bio : full.bio || full.bio_en) || '';
  clinic.reviews = await require('../reviews/reviews.service').publicSummary(clinic.id); // eslint-disable-line global-require
  res.locals.currency = clinic.currency;
  const title = `${d.name} · ${clinic.displayName}`;
  const seoHead = await seo.head(req, res, { kind: 'clinic', clinic, doctors: [d], title, description: [d.specialty, d.bioFull].filter(Boolean).join(' · ').slice(0, 160) });
  const state = await require('../website/site.service').publicState(clinic.id); // eslint-disable-line global-require
  return res.page('pages/portal/doctor', {
    layout: 'public', title, pageTitle: title, seoHead, clinic, d, services: services.filter((x) => !x.doctorId || x.doctorId === d.id),
    bodyClass: state.doc ? `ws-body ws-theme-${state.doc.theme}` : '',
    pageStyles: [...clinicStyles(clinic).filter((h) => !h.endsWith('/theme.css')), '/css/website.css', `/${clinic.slug}/theme.css`],
  });
}));

// Public logo (the /app/logo route is for members only).
// The clinic's browser icon (its logo or an uploaded icon); the platform's icon otherwise.
router.get('/:slug/favicon', wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  const f = await businesses.faviconFile(clinic.id);
  if (!f) return res.redirect(302, '/favicon.svg');
  res.set(require('../../core/images').headers(f.mime, 'public, max-age=604800')); // eslint-disable-line global-require
  return res.send(f.data);
}));

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
  const state = await require('../website/site.service').publicState(clinic.id); // eslint-disable-line global-require
  if (state.status === 'live' && state.doc) {
    const fonts = await require('../website/fonts.service').list(clinic.id); // eslint-disable-line global-require
    return res.send(require('../website/render').css(state.doc, clinic, { fonts, fontUrl: (f) => `/${clinic.slug}/fonts/${f.id}.${f.format}?v=${f.sha.slice(0, 10)}` })); // eslint-disable-line global-require
  }
  return res.send(theme.businessCss(clinic.color));
}));

// A font the clinic uploaded for its website (same origin; the file was checked to be a font when uploaded).
router.get('/:slug/fonts/:id(\\d{1,10}).:ext(woff2|woff|ttf|otf)', wrap(async (req, res, next) => {
  const clinic = await loadClinic(req);
  if (!clinic) return next();
  const fontsSvc = require('../website/fonts.service'); // eslint-disable-line global-require
  const f = await fontsSvc.file(clinic.id, Number(req.params.id));
  if (!f || f.format !== req.params.ext) return next();
  res.set({ 'Content-Type': fontsSvc.MIME[f.format], 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-site', 'Content-Security-Policy': "default-src 'none'" });
  return res.send(f.data);
}));

// ---------------------------------------------------------------- staff sign-in
const roleFrom = (v) => (PORTAL_ROLES.some((r) => r.key === v) ? v : null);

async function renderLogin(req, res, clinic, extra = {}) {
  const as = roleFrom(req.query.as || (req.body && req.body.as));
  const member = req.user ? await membershipOf(req.user.id, clinic.id) : null;
  return res.page('pages/portal/login', {
    layout: 'public', title: req.t('portal.login_title', { clinic: clinic.displayName }), clinic, roles: PORTAL_ROLES, as,
    member, memberRole: member ? roleLabel(req, member) : null, hideBookCta: true, noindex: true, pageStyles: clinicStyles(clinic), ...extra,
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
module.exports.pricesShown = pricesShown;
module.exports.renderSite = renderSite;
