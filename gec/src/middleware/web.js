// View locals (translation, formatting, helpers), CSRF protection and flash messages.
// Illustrated covers in public/img/covers (scripts/build-covers.js), by destination or country.
const COVER_KEYS = ['uk', 'usa', 'canada', 'australia', 'germany', 'ireland', 'campus', 'hero', 'scholarship'];
const COVER_BY_COUNTRY = { GB: 'uk', US: 'usa', CA: 'canada', AU: 'australia', DE: 'germany', IE: 'ireland' };
const coverKey = (v) => (COVER_KEYS.includes(v) ? v : COVER_BY_COUNTRY[String(v || '').toUpperCase()] || 'campus');
const config = require('../config');
const fmt = require('../core/format');
const { translator, resolveLocale, has, loc } = require('../core/i18n');
const { randomToken, safeEqual } = require('../core/tokens');
const { E } = require('../core/errors');
const settings = require('../modules/settings/settings.service');
const siteNav = require('../modules/site/nav');
const siteFeatures = require('../modules/site/features');
const siteFooter = require('../modules/site/footer');
const ref = require('../modules/catalog/reference');
const { activityText } = require('../modules/crm/activity-text');

const ASSET_V = (() => {
  const fs = require('fs'); // eslint-disable-line global-require
  const path = require('path'); // eslint-disable-line global-require
  const h = require('crypto').createHash('sha1'); // eslint-disable-line global-require
  const root = path.join(__dirname, '..', '..', 'public');
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1)).forEach((e) => {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f); else if (/\.(css|js|svg)$/.test(e.name)) { h.update(e.name); h.update(fs.readFileSync(f)); }
    });
  };
  walk(root);
  return h.digest('hex').slice(0, 10);
})();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function locals(req, res, next) {
  try {
    const locale = resolveLocale(req);
    if (req.query.lang && config.locales.includes(req.query.lang)) {
      res.cookie('gec_lang', req.query.lang, { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: true, secure: config.isProd });
    }
    const t = translator(locale);
    req.t = t;
    req.locale = locale;
    if (req.session && !req.session.csrf) req.session.csrf = randomToken(24);
    const [branding, company] = await Promise.all([settings.get('branding'), settings.get('company')]);
    const general = await settings.get('general');
    const currency = general.default_currency || 'USD';
    const tz = general.timezone || 'UTC';
    Object.assign(res.locals, {
      t,
      locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      L: (row, field) => loc(row, field, locale),
      label: (group, key) => (key === null || key === undefined || key === '' ? '—' : has(locale, `${group}.${key}`) ? t(`${group}.${key}`) : String(key)),
      branding,
      company,
      csrfToken: req.session?.csrf,
      currentUser: req.user || null,
      staff: req.staff || null,
      can: req.can || (() => false),
      path: req.path,
      fullPath: req.originalUrl,
      query: req.query,
      flash: req.session?.flash || [],
      appUrl: config.appUrl,
      assetV: ASSET_V,
      fmt: {
        date: (v, o) => fmt.formatDate(v, locale, o, tz),
        dateTime: (v) => fmt.formatDateTime(v, locale, tz),
        time: (v) => fmt.formatTime(v, locale, tz),
        tz,
        money: (a, c, d) => fmt.formatMoney(a, c || currency, locale, d),
        number: (n, d) => fmt.formatNumber(n, locale, d),
        pct: (n, d) => fmt.formatPercent(n, locale, d),
        relative: (v) => fmt.relative(v, locale),
        dateInput: fmt.toDateInput,
        dateTimeInput: (v) => fmt.toZonedInput(v, tz),
      },
      esc,
      icon: (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true" focusable="false"><use href="/icons.svg?v=${ASSET_V}#i-${name}"></use></svg>`,
      initials: (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase(),
      json: (v) => JSON.stringify(v ?? null).replace(/</g, '\\u003c'),
      qs: (patch) => { const u = new URLSearchParams(req.query); Object.entries(patch).forEach(([k, v]) => (v === null || v === undefined || v === '' ? u.delete(k) : u.set(k, v))); const s = u.toString(); return s ? `?${s}` : '?'; },
      langUrl: (lang) => { const u = new URL(req.originalUrl, 'http://x'); u.searchParams.set('lang', lang); return u.pathname + u.search; },
      errors: {},
      old: {},
      seo: null,
      activityText: (a) => activityText(a, t, locale),
      fullName: (p) => [p && p.first_name, p && p.last_name].filter(Boolean).join(' ') || '—',
      // Photo with an illustrated cover underneath (shows when there is no photo or it cannot load).
      cover: (img, key) => { const safe = (u) => String(u || '').replace(/["'()\\\s]/g, encodeURIComponent); const art = `url('/img/covers/${COVER_KEYS.includes(key) ? key : 'campus'}.svg')`; return `background-image:${img && /^(https?:\/\/|\/)/.test(img) ? `url('${safe(img)}'),` : ''}${art}`; },
      coverKey,
      ref: {
        country: (c) => ref.countryName(c, locale),
        flag: ref.flag,
        month: (ym) => ref.monthLabel(ym, locale),
        countries: () => ref.countries(locale),
        DEGREES: ref.DEGREES, FIELDS: ref.FIELDS, EDUCATION_LEVELS: ref.EDUCATION_LEVELS, BUDGETS: ref.BUDGETS, STUDY_MODES: ref.STUDY_MODES,
        intakes: ref.intakeOptions,
      },
      site: await (async () => { const c = await require('../modules/cms/nav').load(); return { nav: c.header || siteNav.LINKS, features: siteFeatures, footer: c.footer || siteFooter.columns() }; })(), // eslint-disable-line global-require
    });
    if (req.session) req.session.flash = [];
    next();
  } catch (e) { next(e); }
}

function flash(req, type, message) {
  if (req.session) req.session.flash = [...(req.session.flash || []), { type, message }];
}

// Multipart bodies are parsed by their own route (multer), so their token can only be checked after parsing. Only
// routes registered with allowMultipart() may receive them; any other multipart POST is refused outright, so a
// cross-site multipart form can never reach a handler without a token check.
const MULTIPART_ROUTES = [];
const allowMultipart = (re) => { MULTIPART_ROUTES.push(re); };
const tokenValid = (req, sent) => Boolean(req.session?.csrf && sent && safeEqual(sent, req.session.csrf));

function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/hooks/')) return next(); // provider webhooks: verified by signature in their module
  if (/^\/u\/[A-Za-z0-9_-]{20,40}$/.test(req.path)) return next(); // one-click unsubscribe from mail apps: the private token is the proof
  if (req.is('multipart/form-data')) {
    if (MULTIPART_ROUTES.some((re) => re.test(req.path))) { req.csrfDeferred = true; return next(); }
    return next(E.csrf());
  }
  if (!tokenValid(req, req.body?._csrf || req.get('x-csrf-token'))) return next(E.csrf());
  return next();
}

function verifyCsrfAfterUpload(req, res, next) {
  if (!req.csrfDeferred) return next();
  return tokenValid(req, req.body?._csrf || req.get('x-csrf-token')) ? next() : next(E.csrf());
}

module.exports = { locals, flash, csrf, verifyCsrfAfterUpload, allowMultipart, esc, ASSET_V };
