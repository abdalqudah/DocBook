// One clinic or one medical centre on its own domain (APP_EDITION=clinic | center, src/config/edition.js):
//   /                        the clinic's (or centre's) website            (internally /<slug>)
//   /book… /doctors/… /p/… /articles…  its booking and website pages     (internally /<slug>/…)
//   /admin                   the management (sign-in, then the clinic's pages under /app)
//   /admin/…                 no platform pages: the system's own (update, sign-in page, maintenance) are in Settings
//   /<doctor's clinic>/…     a centre's doctors keep their own websites
// The many-clinics pages (sign-up, clinic directory, pricing, reps' portal) lead home.
const edition = require('../config/edition');
const cache = require('../core/cache');

const SITE = [/^\/book(\/|$)/, /^\/doctors\//, /^\/p\//, /^\/fonts\//, /^\/articles(\/|$)/, /^\/(robots\.txt|sitemap\.xml|llms\.txt|logo|logo-square)$/];
const AWAY = [/^\/(pricing|features|clinics|vendors|vendor|reps|join|marketplace)(\/|$)/, /^\/blog(\/|$)/];

/** The address (slug) of the installation's clinic (or centre's administration account). */
function mainSlug() {
  return cache.remember('edition:slug', async () => {
    const knex = require('../db/knex'); // eslint-disable-line global-require
    const q = knex.main('businesses').whereNot('status', 'deleted').whereNotNull('slug').orderBy('id');
    const row = edition.center ? await q.where({ kind: 'center_admin' }).first('slug') : await q.whereNot('kind', 'center_admin').whereNull('center_id').first('slug');
    return row ? row.slug : null;
  }, 60_000);
}

async function route(req, res, next) {
  if (!edition.single) return next();
  try {
    const p = req.path;
    const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    if (p === '/admin' || p === '/admin/') return res.redirect(302, '/app');
    // No platform admin pages: the system's own pages (update, sign-in page, maintenance) are in Settings.
    if (p.startsWith('/admin/')) return req.method === 'GET' || req.method === 'HEAD' ? res.redirect(302, '/app/settings') : res.status(404).end();
    if (p === '/signup') return res.redirect(302, '/login');
    if (AWAY.some((re) => re.test(p))) return res.redirect(302, '/');
    const slug = await mainSlug();
    if (!slug) return next();
    if (p === '/') { req.url = `/${slug}${q}`; return next(); }
    if (p === '/favicon.ico') { req.url = `/${slug}/favicon${q}`; return next(); }
    if (SITE.some((re) => re.test(p))) { req.url = `/${slug}${p}${q}`; return next(); }
    if (p === `/${slug}` || p === `/${slug}/`) return res.redirect(302, `/${q}`);
    return next();
  } catch (e) { return next(e); }
}

module.exports = { route, mainSlug };
