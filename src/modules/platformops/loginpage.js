// The sign-in page's own words and look (Platform admin → Sign-in page, or the clinic's Settings → Sign-in page for the
// installation's own account). Empty fields keep the built-in text. In a single clinic / centre installation the page
// takes the clinic's colours and logo (src/config/edition.js).
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const edition = require('../../config/edition');

const KEY = 'login_page';
const STYLES = ['color', 'dark', 'light'];
const NAME_MODES = ['beside', 'below', 'hidden']; // the clinic's name next to its logo, under it, or not shown
const TEXTS = ['title', 'lead', 'side_title', 'side_text', 'point_1', 'point_2', 'point_3'];
const LIMITS = { title: 80, lead: 240, side_title: 120, side_text: 400, point_1: 120, point_2: 120, point_3: 120 };

const defaults = () => ({ style: edition.single ? 'color' : 'dark', show_points: true, name_mode: 'beside' });

async function get() {
  return cache.remember('platform:login_page', async () => {
    const row = await knex.main('platform_settings').where({ key: KEY }).first('value').catch(() => null);
    let v = {};
    try { v = row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) || {} : {}; } catch { v = {}; }
    const out = { ...defaults(), ...v };
    if (!STYLES.includes(out.style)) out.style = defaults().style;
    if (!NAME_MODES.includes(out.name_mode)) out.name_mode = 'beside';
    return out;
  }, 30_000);
}

async function save(ctx, input) {
  const value = { style: STYLES.includes(input.style) ? input.style : defaults().style, show_points: input.show_points === '1', name_mode: NAME_MODES.includes(input.name_mode) ? input.name_mode : 'beside' };
  for (const k of TEXTS) for (const l of ['ar', 'en']) value[`${k}_${l}`] = String(input[`${k}_${l}`] || '').trim().replace(/\s+/g, ' ').slice(0, LIMITS[k]); // eslint-disable-line no-restricted-syntax
  await knex.main('platform_settings').insert({ key: KEY, value: JSON.stringify(value) }).onConflict('key').merge({ value: JSON.stringify(value), updated_at: new Date() });
  cache.forgetPrefix('platform:login_page');
  await audit.record({ ...ctx, businessId: null }, 'platform.login_page_saved', { entityType: 'platform', newValues: { style: value.style } });
  return value;
}

/** The installation's clinic for the sign-in page (single clinic / centre): its address, name, logo, colour. */
async function clinicOf() {
  if (!edition.single) return null;
  const slug = await require('../../middleware/edition').mainSlug(); // eslint-disable-line global-require
  if (!slug) return null;
  // The clinic's own cache: refreshed as soon as its name, colour or logo changes (Settings).
  const b = await require('../businesses/business.service').bySlug(slug); // eslint-disable-line global-require
  if (!b) return null;
  // The website's look (Website → Theme & brand): dark mode off, and the logo made for dark backgrounds.
  const tenant = require('../../db/tenant'); // eslint-disable-line global-require
  const look = await cache.remember(`edition:look:${b.id}`, () => tenant.runFor(b.id, async () => {
    const l = await require('../website/site.service').look(b.id); // eslint-disable-line global-require
    // The brand's own images (served by /<slug>/brand/… even before the site is published).
    const pub = async (id, kind) => { const m = id ? await knex('clinic_media').where({ business_id: b.id, id }).first('id', 'sha') : null; return m ? `/${b.slug}/brand/${kind}?v=${m.sha}` : null; };
    return { light: l.light, primary: l.primary, logoDark: await pub(l.logoDarkMediaId, 'logo-dark'), siteFavicon: await pub(l.faviconMediaId, 'favicon') };
  }), 30_000).catch(() => ({ light: false, primary: null, logoDark: null, siteFavicon: null }));
  // The browser icon of every page: Settings → Appearance, else the website's icon, else the logo (never the built-in mark).
  const businesses = require('../businesses/business.service'); // eslint-disable-line global-require
  const favicon = businesses.faviconPath(b, `/${b.slug}`) || look.siteFavicon
    || (b.logo_square_mime ? `/${b.slug}/logo-square?v=${b.logo_square_version}` : b.logo_mime ? `/${b.slug}/logo?v=${b.logo_version}` : null);
  return { slug: b.slug, name: b.name, name_en: b.name_en, logo: Boolean(b.logo_mime), logoVersion: b.logo_version, ...look, color: b.color || look.primary || null, favicon };
}

/** Locals for the pages drawn in the sign-in layout. */
async function middleware(req, res, next) {
  try {
    // One clinic / centre without BRAND_NAME: the product carries the clinic's current name (Settings → Clinic).
    if (edition.single) {
      const c = await clinicOf();
      if (c && !(process.env.BRAND_NAME || '').trim()) res.locals.brandName = (req.locale === 'en' && c.name_en) || c.name;
      if (c && c.favicon) res.locals.editionFavicon = c.favicon; // pages without an icon of their own (sign-in, app, site)
    }
    if (req.path.startsWith('/app') || req.path.startsWith('/admin/') || req.method !== 'GET') return next();
    const [lp, clinic] = await Promise.all([get(), clinicOf()]);
    const loc = req.locale === 'en' ? 'en' : 'ar';
    res.locals.loginPage = { ...lp, text: (k, fallback) => lp[`${k}_${loc}`] || req.t(fallback) }; // each language its own text (else the built-in one)
    res.locals.authClinic = clinic;
    return next();
  } catch (e) { return next(e); }
}

module.exports = { get, save, middleware, clinicOf, STYLES, NAME_MODES, TEXTS, LIMITS };
