// Platform branding set by the platform admin (/admin/branding): the product logo (and a version for dark mode), the
// browser icon, and whether the product name shows next to the logo. Images live in platform_assets; the choice in
// platform_settings ('branding'). Without uploads everything stays as in src/config/brand.js (the built-in mark).
// The middleware lays these over res.locals.brand, so every page, layout and the logo partial follow.
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const images = require('../../core/images');
const brand = require('../../config/brand');

const KEYS = ['logo', 'logo_dark', 'favicon'];
const SETTING = 'branding';
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const parse = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v) || {}; } catch { return {}; } };

/** { assets: { logo: { version, mime } … }, showName } — cached for a minute (busted on save). */
const load = () => cache.remember('platform:branding', async () => {
  const [rows, row] = await Promise.all([
    knex('platform_assets').whereIn('key', KEYS).select('key', 'mime', 'version'),
    knex('platform_settings').where({ key: SETTING }).first('value'),
  ]);
  const s = parse(row && row.value);
  return { assets: Object.fromEntries(rows.map((r) => [r.key, { version: r.version, mime: r.mime }])), showName: s.show_name !== false };
}, 60_000);

/** The brand object for the pages: config values with the admin's uploads laid over. */
function brandFor(st) {
  const a = st.assets;
  const url = (k) => `/brand/${k}?v=${a[k].version}`;
  return {
    ...brand,
    logo: a.logo ? url('logo') : brand.logo,
    logoOnDark: a.logo_dark ? url('logo_dark') : (a.logo ? null : brand.logoOnDark),
    favicon: a.favicon ? url('favicon') : brand.favicon,
    showName: st.showName,
  };
}

const middleware = (req, res, next) => {
  load().then((st) => { res.locals.brand = brandFor(st); next(); }, next);
};

/** Serves an uploaded platform image (public: the login page, landing page and clinic pages use them). */
async function serve(req, res, next) {
  if (!KEYS.includes(req.params.key)) return next();
  const r = await knex('platform_assets').where({ key: req.params.key }).first('mime', 'data');
  if (!r) return req.params.key === 'favicon' ? res.redirect(302, '/favicon.svg') : res.status(404).end();
  res.set(images.headers(r.mime, 'public, max-age=604800'));
  return res.send(r.data);
}

/**
 * Saves the admin's choices: new images ({ logo, logo_dark, favicon } buffers, type checked here), images to remove,
 * and showName. Returns the list of problems (a key whose file is not an accepted image); nothing is saved then.
 */
async function save(ctx, { files = {}, remove = [], showName }) {
  const checked = {};
  for (const k of KEYS) {
    if (!files[k]) continue; // eslint-disable-line no-continue
    const mime = images.sniff(files[k], k === 'favicon' ? images.ICON_TYPES : LOGO_TYPES);
    if (!mime) return { invalid: k };
    checked[k] = { data: files[k], mime };
  }
  const before = await load();
  await knex.transaction(async (trx) => {
    for (const [k, f] of Object.entries(checked)) {
      await trx('platform_assets').insert({ key: k, mime: f.mime, data: f.data, version: 1, updated_at: new Date() }) // eslint-disable-line no-await-in-loop
        .onConflict('key').merge({ mime: f.mime, data: f.data, version: trx.raw('version + 1'), updated_at: new Date() });
    }
    const gone = remove.filter((k) => KEYS.includes(k) && !checked[k]);
    if (gone.length) await trx('platform_assets').whereIn('key', gone).del();
    const value = JSON.stringify({ show_name: showName !== false });
    await trx('platform_settings').insert({ key: SETTING, value }).onConflict('key').merge({ value });
    await audit.record({ ...ctx, businessId: null }, 'platform.branding_updated', { entityType: 'platform', entityId: null,
      oldValues: { images: Object.keys(before.assets), show_name: before.showName },
      newValues: { uploaded: Object.keys(checked), removed: gone, show_name: showName !== false } }, trx);
  });
  cache.forgetPrefix('platform:branding');
  return { invalid: null };
}

module.exports = { KEYS, load, brandFor, middleware, serve, save };
