// Custom domains: a clinic's verified domain (e.g. book.myclinic.com) serves its public page and online booking.
//   /            → the clinic page          (internally /<slug>)
//   /book…       → online booking           (internally /<slug>/book…)
//   /about…      → a website page; /doctors the doctors (see site/clean-urls.js)
//   /logo        → the clinic logo
//   /<slug>/…    → the same pages under their usual address (links inside the pages keep working)
// Everything else — the staff sign-in, /app, /admin, sign-up… — is sent to the main DocBook address, so
// logins and their cookies only ever live on APP_URL. Only exact, verified host names are honoured;
// any other Host header falls through to the normal app.
const config = require('../config');
const domains = require('../modules/branding/domain.service');
const clean = require('../modules/site/clean-urls');

const mainBase = () => config.appUrl.replace(/\/+$/, '');

function hostOf(req) {
  // req.hostname follows `trust proxy` (X-Forwarded-Host behind the proxy, else Host).
  return String(req.hostname || '').toLowerCase().replace(/\.$/, '');
}

async function customDomain(req, res, next) {
  let site;
  try { site = await domains.clinicForHost(hostOf(req)); } catch { site = null; }
  if (!site) return next();
  // An alias (www ↔ bare form) answers with a permanent redirect to the clinic's main domain, same path.
  if (site.redirectTo) return res.redirect(301, `${req.protocol}://${site.redirectTo}${req.originalUrl}`);
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
  // short addresses (/about, /doctors…); old long ones redirect, links are written short
  const done = await clean.serve(req, res, slug);
  if (done === 'done') return undefined;
  if (done === 'rewritten') return next();
  if (p === '/') { req.url = `/${slug}${q}`; return next(); }
  if (p === '/articles' || p.startsWith('/articles/')) { req.url = `/${slug}${p}${q}`; return next(); } // website: the doctors' articles
  if (p === '/book' || p.startsWith('/book/')) { req.url = `/${slug}${p}${q}`; return next(); }
  if (p === '/logo') { req.url = `/${slug}/logo${q}`; return next(); }
  if (p === '/favicon.ico') { req.url = `/${slug}/favicon${q}`; return next(); } // the clinic's own browser icon (or the platform's)
  if (p.startsWith('/doctors/')) { req.url = `/${slug}${p}${q}`; return next(); } // website: a doctor's page
  if (p.startsWith('/p/')) { req.url = `/${slug}${p}${q}`; return next(); } // website: another page
  if (p.startsWith('/fonts/')) { req.url = `/${slug}${p}${q}`; return next(); } // website: the clinic's fonts
  if (p.startsWith(`/m/${slug}/`)) return next(); // the page's public images (same origin — the page's CSP allows only 'self')
  if (p === `/${slug}`) return res.redirect(302, `/${q}`);
  if (p.startsWith(`/${slug}/book`) || p.startsWith(`/${slug}/doctors/`) || p.startsWith(`/${slug}/p/`) || p.startsWith(`/${slug}/fonts/`) || p.startsWith(`/${slug}/articles`) || p === `/${slug}/doctors` || p === `/${slug}/logo` || p === `/${slug}/favicon` || p === `/${slug}/theme.css`) return next();
  if (p === '/robots.txt' || p === '/sitemap.xml' || p === '/llms.txt') { req.url = `/${slug}${p}${q}`; return next(); } // the clinic's own crawl files
  // Anything else belongs to the main address.
  return toMain(req.originalUrl);
}

module.exports = { customDomain };
