// View locals, CSRF protection, flash messages and theme/locale for server-rendered pages.
const { translator, resolveLocale, has } = require('../core/i18n');
const { randomToken, safeEqual } = require('../core/tokens');
const { E } = require('../core/errors');
const fmt = require('../core/format');
const config = require('../config');
const brand = require('../config/brand');

// Cache key of /css, /js and icons.svg (cached 7 days in production): the version plus a fingerprint of the files, so
// an update that changes them is fetched at once even when the version number stays the same.
const ASSET_V = (() => {
  const fs = require('fs'); // eslint-disable-line global-require
  const path = require('path'); // eslint-disable-line global-require
  const crypto = require('crypto'); // eslint-disable-line global-require
  const root = path.join(__dirname, '..', '..', 'public');
  const h = crypto.createHash('sha1');
  const walk = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    names.sort((a, b) => (a.name < b.name ? -1 : 1)).forEach((e) => {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f); else if (/\.(css|js|svg)$/.test(e.name)) { h.update(e.name); h.update(fs.readFileSync(f)); }
    });
  };
  ['css', 'js'].forEach((d) => walk(path.join(root, d)));
  try { h.update(fs.readFileSync(path.join(root, 'icons.svg'))); } catch { /* no icons */ }
  return `${require('../../package.json').version}-${h.digest('hex').slice(0, 8)}`; // eslint-disable-line global-require
})();
// The site's real public address. APP_URL wins when it is a real address; when it is missing or still
// "localhost" (a common set-up slip), links use the address the browser actually opened. The host comes from
// X-Forwarded-Host only when Express trusts the proxy (TRUST_PROXY), and must look like a host name.
const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(u || '');
const isLocalHost = (h) => /^(localhost|127\.|0\.0\.0\.0|\[::1\]|::1$)/i.test(h || '');
function requestHost(req) {
  // X-Forwarded-Host only from the hosting's own proxy (a local / private address in front of the app) — never from a
  // visitor talking to the app directly, who could otherwise make e-mailed links point to their own site.
  const peer = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  const viaLocalProxy = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(peer) || peer === '::1' || /^f[cd]/i.test(peer);
  const host = req.app && req.app.enabled('trust proxy') && viaLocalProxy && req.get('x-forwarded-host') ? String(req.get('x-forwarded-host')).split(',')[0].trim() : req.get('host');
  return /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(host || '') ? host.toLowerCase() : null;
}
function publicBase(req) {
  const configured = process.env.APP_URL ? config.appUrl.replace(/\/+$/, '') : '';
  const host = requestHost(req);
  if (configured && (!isLocalUrl(configured) || !host)) return configured;
  return host ? `${req.protocol === 'https' ? 'https' : 'http'}://${host}` : config.appUrl.replace(/\/+$/, '');
}

/**
 * Address that a PHONE can open (attendance QR). When the site is opened as localhost/127.0.0.1 — e.g. the
 * clinic runs DocBook on the reception PC — a phone cannot reach "localhost" (it means the phone itself), so the
 * server's own network (LAN) address with the same port is used instead.
 * Returns { base, via: 'site' | 'lan' | 'local' } — 'local' means no reachable address could be found.
 */
function phoneBase(req) {
  const base = publicBase(req);
  if (!isLocalUrl(base)) return { base, via: 'site' };
  const u = new URL(base);
  const nets = Object.values(require('os').networkInterfaces()).flat() // eslint-disable-line global-require
    .filter((n) => n && n.family === 'IPv4' && !n.internal && !/^169\.254\./.test(n.address));
  const lan = nets.find((n) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address)) || nets[0];
  if (!lan) return { base, via: 'local' };
  return { base: `${u.protocol}//${lan.address}${u.port ? `:${u.port}` : ''}`, via: 'lan' };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function locals(req, res, next) {
  const locale = resolveLocale(req);
  if (req.query.lang && config.locales.includes(req.query.lang)) {
    res.cookie('db_lang', req.query.lang, { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: true, secure: config.isProd });
  }
  const t = translator(locale);
  req.t = t;
  req.locale = locale;
  if (req.session && !req.session.csrf) req.session.csrf = randomToken(24);
  const cookieTheme = req.cookies?.db_theme;
  const theme = ['light', 'dark'].includes(cookieTheme) ? cookieTheme : (req.user && ['light', 'dark'].includes(req.user.theme) && !cookieTheme ? req.user.theme : 'system');
  const cur = () => res.locals.currency || 'USD';
  Object.assign(res.locals, {
    t,
    // Translates an enum value (category, status…) and falls back to the raw value for custom entries.
    label: (group, key) => (key === null || key === undefined || key === '' ? '—' : has(locale, `${group}.${key}`) ? t(`${group}.${key}`) : String(key)),
    locale,
    dir: locale === 'ar' ? 'rtl' : 'ltr',
    theme,
    sidebarMini: req.cookies?.db_sb === 'mini', // the member folded the sidebar to icons (desktop)
    brand,
    brandName: brand.name,
    edition: require('../config/edition'), // eslint-disable-line global-require -- one clinic / centre: no sign-up or platform links
    tagline: brand.tagline[locale] || brand.tagline.en,
    csrfToken: req.session?.csrf,
    currentUser: req.user || null,
    baseUrl: publicBase(req),
    path: req.path,
    fullPath: req.originalUrl,
    query: req.query,
    flash: req.session?.flash || [],
    fmt: {
      date: (v, o) => fmt.formatDate(v, locale, o, (res.locals.business && res.locals.business.timezone) || null), // timestamps in the clinic's zone
      month: (k) => fmt.formatMonth(k, locale),
      money: (a, c) => fmt.formatMoney(a, c || cur(), locale),
      amount: (a, c) => fmt.formatAmount(a, c || cur(), locale),
      compact: (a, c) => fmt.formatCompact(a, c || cur(), locale),
      number: (n, d) => fmt.formatNumber(n, locale, d),
      pct: (n, d) => fmt.formatPercent(n, locale, d),
      dateInput: fmt.toDateInput,
    },
    today: fmt.today(),
    thisMonth: fmt.currentMonth(),
    assetV: ASSET_V,
    appVersion: ASSET_V.split('-')[0],
    escapeHtml: esc,
    icon: (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="/icons.svg?v=${ASSET_V}#i-${name}"></use></svg>`,
    initials: (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase(),
    roleName: (r) => (r && (r.is_system || r.is_system === 1) ? t(`roles.${r.role_key || r.key}`) : (r && (r.role_name || r.name)) || '—'),
    json: (v) => JSON.stringify(v).replace(/</g, '\\u003c'),
    errors: {},
    old: {},
    formError: null,
    unreadNotifications: 0,
    can: () => false,
    canAny: () => false,
  });
  if (req.session) req.session.flash = [];
  res.locals.langUrl = (lang) => {
    const url = new URL(req.originalUrl, 'http://x');
    url.searchParams.set('lang', lang);
    return url.pathname + url.search;
  };
  next();
}

function flash(req, type, message) {
  req.session.flash = [...(req.session.flash || []), { type, message }];
}

// Multipart bodies are only parsed by these routes; their token is checked after parsing.
const MULTIPART_ROUTES = [/^\/app\/settings\/appearance\/(logo|logo-square|favicon)\/?$/, /^\/admin\/branding\/?$/, /^\/app\/settings\/data\/(restore|import)\/?$/, /^\/app\/[a-z-]+\/import\/?$/,
  /^\/vendor\/(profile\/logo|products|products\/\d+|offers|offers\/\d+|ads)\/?$/, // vendor portal images (and ads)
  /^\/[a-z0-9-]+\/book\/online\/?$/, // online-consultation booking (optional medical files)
  /^\/app\/settings\/signatures\/(stamp|doctors\/\d+\/upload)\/?$/, // doctor signature / clinic stamp images
  /^\/app\/settings\/media\/upload\/?$/, // clinic media library uploads
  /^\/app\/patients\/\d+\/files\/?$/, // scanned papers and results in the patient's file
  /^\/app\/patients\/\d+\/photo\/?$/, // the patient's photo
  /^\/app\/chat\/\d+\/upload\/?$/, // images and documents in the staff chat
  /^\/app\/mail\/send\/?$/, // a member's own e-mail with attachments
  /^\/app\/website\/fonts\/?$/, // website fonts (Theme & brand)
  /^\/app\/articles\/images\/?$/, // images of a doctor's article
  /^\/app\/settings\/account\/photo\/?$/, // My account: my photo
  /^\/app\/website\/import\/?$/, // Website → Import content (a .zip of pages and pictures)
  /^\/admin\/updates\/install\/?$/, // platform admin: system update package (zip)
  /^\/app\/settings\/system-update\/install\/?$/, // the same, from the clinic settings of the installation's own account
  /^\/admin\/clinics\/restore\/?$/]; // platform admin: a clinic's backup file

const tokenValid = (req, sent) => Boolean(req.session?.csrf && sent && safeEqual(sent, req.session.csrf));

function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.is('multipart/form-data')) {
    if (MULTIPART_ROUTES.some((r) => r.test(req.path))) { req.csrfDeferred = true; return next(); }
    return next(E.csrf());
  }
  if (!tokenValid(req, req.body?._csrf || req.get('x-csrf-token'))) return next(E.csrf());
  return next();
}

function verifyCsrfAfterUpload(req, res, next) {
  if (!req.csrfDeferred) return next();
  return tokenValid(req, req.body?._csrf || req.get('x-csrf-token')) ? next() : next(E.csrf());
}

module.exports = { locals, flash, csrf, verifyCsrfAfterUpload, publicBase, phoneBase, isLocalUrl, isLocalHost };
