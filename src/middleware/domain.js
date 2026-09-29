// Custom domains: a clinic's verified domain (e.g. book.myclinic.com) serves its public page and online booking.
//   /            → the clinic page          (internally /<slug>)
//   /book…       → online booking           (internally /<slug>/book…)
//   /logo        → the clinic logo
//   /<slug>/…    → the same pages under their usual address (links inside the pages keep working)
// Everything else — the staff sign-in, /app, /admin, sign-up… — is sent to the main DocBook address, so
// logins and their cookies only ever live on APP_URL. Only exact, verified host names are honoured;
// any other Host header falls through to the normal app.
const config = require('../config');
const domains = require('../modules/branding/domain.service');

const mainBase = () => config.appUrl.replace(/\/+$/, '');

function hostOf(req) {
  // req.hostname follows `trust proxy` (X-Forwarded-Host behind the proxy, else Host).
  return String(req.hostname || '').toLowerCase().replace(/\.$/, '');
}

async function customDomain(req, res, next) {
  let site;
  try { site = await domains.clinicForHost(hostOf(req)); } catch { site = null; }
  if (!site) return next();
  const { slug } = site;
  const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const p = req.path;
  const toMain = (path) => res.redirect(302, `${mainBase()}${path}`);
  res.locals.customDomain = { host: hostOf(req), slug };
  res.set('X-Robots-Tag', 'index, follow');

  // Staff sign-in happens on the main address (the clinic's own staff login page there).
  if (p === '/login' || p === `/${slug}/login` || p === `/${slug}/enter` || p === '/staff') {
    const as = typeof req.query.as === 'string' && /^[a-z_]{2,30}$/.test(req.query.as) ? `?as=${req.query.as}` : '';
    return toMain(`/${slug}/login${as}`);
  }
  if (p === '/') { req.url = `/${slug}${q}`; return next(); }
  if (p === '/book' || p.startsWith('/book/')) { req.url = `/${slug}${p}${q}`; return next(); }
  if (p === '/logo') { req.url = `/${slug}/logo${q}`; return next(); }
  if (p === `/${slug}`) return res.redirect(302, `/${q}`);
  if (p.startsWith(`/${slug}/book`) || p === `/${slug}/logo` || p === `/${slug}/theme.css`) return next();
  if (p === '/robots.txt') return res.type('text/plain').send('User-agent: *\nAllow: /\n');
  // Anything else belongs to the main address.
  return toMain(req.originalUrl);
}

module.exports = { customDomain };
