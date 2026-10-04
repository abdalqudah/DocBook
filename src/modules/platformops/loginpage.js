// The sign-in page's own words and look (Platform admin → Sign-in page, or the clinic's Settings → Sign-in page for the
// installation's own account). Empty fields keep the built-in text. In a single clinic / centre installation the page
// takes the clinic's colours and logo (src/config/edition.js).
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const edition = require('../../config/edition');

const KEY = 'login_page';
const STYLES = ['color', 'dark', 'light'];
const TEXTS = ['title', 'lead', 'side_title', 'side_text', 'point_1', 'point_2', 'point_3'];
const LIMITS = { title: 80, lead: 240, side_title: 120, side_text: 400, point_1: 120, point_2: 120, point_3: 120 };

const defaults = () => ({ style: edition.single ? 'color' : 'dark', show_points: true });

async function get() {
  return cache.remember('platform:login_page', async () => {
    const row = await knex.main('platform_settings').where({ key: KEY }).first('value').catch(() => null);
    let v = {};
    try { v = row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) || {} : {}; } catch { v = {}; }
    const out = { ...defaults(), ...v };
    if (!STYLES.includes(out.style)) out.style = defaults().style;
    return out;
  }, 30_000);
}

async function save(ctx, input) {
  const value = { style: STYLES.includes(input.style) ? input.style : defaults().style, show_points: input.show_points === '1' };
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
  return b ? { slug: b.slug, name: b.name, name_en: b.name_en, color: b.color || null, logo: Boolean(b.logo_mime) } : null;
}

/** Locals for the pages drawn in the sign-in layout. */
async function middleware(req, res, next) {
  try {
    // One clinic / centre without BRAND_NAME: the product carries the clinic's current name (Settings → Clinic).
    if (edition.single && !(process.env.BRAND_NAME || '').trim()) {
      const c = await clinicOf();
      if (c) res.locals.brandName = (req.locale === 'en' && c.name_en) || c.name;
    }
    if (req.path.startsWith('/app') || req.path.startsWith('/admin/') || req.method !== 'GET') return next();
    const [lp, clinic] = await Promise.all([get(), clinicOf()]);
    const loc = req.locale === 'en' ? 'en' : 'ar';
    res.locals.loginPage = { ...lp, text: (k, fallback) => lp[`${k}_${loc}`] || req.t(fallback) }; // each language its own text (else the built-in one)
    res.locals.authClinic = clinic;
    return next();
  } catch (e) { return next(e); }
}

module.exports = { get, save, middleware, clinicOf, STYLES, TEXTS, LIMITS };
