// A landing page per country on the platform's site (/in/sa, /in/jo…): its own headline and text, the plans in the
// country's currency (the admin's rate from the plans' currency, rounded), how many clinics and drug warehouses of
// that country are on the platform, and sign-up with the country's time zone and currency already chosen.
// Admin → Website → Country pages. Stored in platform_settings "country_pages".
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const options = require('../settings/options');

const KEY = 'country_pages';
const CODES = ['JO', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'EG', 'IQ', 'PS', 'LB'];
const CURRENCY = { JO: 'JOD', SA: 'SAR', AE: 'AED', KW: 'KWD', QA: 'QAR', BH: 'BHD', OM: 'OMR', EG: 'EGP', IQ: 'IQD', PS: 'ILS', LB: 'USD' };
const RATE_FROM_JOD = { JO: 1, SA: 5.29, AE: 5.18, KW: 0.43, QA: 5.13, BH: 0.53, OM: 0.54, EG: 70, IQ: 1850, PS: 5.2, LB: 1.41 }; // starting values only: the admin sets each
const str = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const parse = (v) => { try { return JSON.parse(v || '{}') || {}; } catch { return {}; } };

const defaults = (cc) => ({ on: false, title_ar: '', title_en: '', lead_ar: '', lead_en: '', body_ar: '', body_en: '', currency: CURRENCY[cc], rate: RATE_FROM_JOD[cc] });
const all = () => cache.remember('cpages:all', async () => {
  const row = await knex('platform_settings').where({ key: KEY }).first('value').catch(() => null);
  const v = parse(row && row.value);
  return Object.fromEntries(CODES.map((cc) => [cc, { ...defaults(cc), ...(v[cc] || {}) }]));
}, 30_000);

async function save(ctx, body) {
  const cur = await all();
  const errors = {};
  const out = {};
  CODES.forEach((cc) => {
    const k = (f) => body[`${cc}_${f}`];
    const rate = Number(String(k('rate') ?? cur[cc].rate).replace(/,/g, ''));
    const currency = str(k('currency') ?? cur[cc].currency, 3).toUpperCase();
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1e6) errors[`${cc}_rate`] = 'Enter the rate (e.g. 5.29).';
    if (!/^[A-Z]{3}$/.test(currency)) errors[`${cc}_currency`] = 'Enter a 3-letter currency code.';
    out[cc] = {
      on: [].concat(k('on') ?? []).map(String).includes('1'), rate, currency,
      title_ar: str(k('title_ar'), 160), title_en: str(k('title_en'), 160), lead_ar: str(k('lead_ar'), 400), lead_en: str(k('lead_en'), 400),
      body_ar: str(k('body_ar'), 8000), body_en: str(k('body_en'), 8000),
    };
  });
  if (Object.keys(errors).length) throw E.validation(errors);
  const value = JSON.stringify(out);
  await knex('platform_settings').insert({ key: KEY, value }).onConflict('key').merge({ value, updated_at: new Date() });
  cache.forgetPrefix('cpages:');
  await audit.record(ctx, 'platform.country_pages_saved', { entityType: 'platform', entityId: KEY, newValues: { on: CODES.filter((cc) => out[cc].on) } });
}

/** A plan's price in the page's currency, rounded to a clean figure. */
function convert(amount, rate) {
  const v = Number(amount || 0) * rate;
  if (!v) return 0;
  const step = v >= 1000 ? 10 : v >= 100 ? 5 : 1;
  return Math.ceil(v / step) * step;
}

/** The page for a country code (lowercase in the URL) or null when it is not switched on. */
async function page(cc) {
  const code = String(cc || '').toUpperCase();
  if (!CODES.includes(code)) return null;
  const p = (await all())[code];
  if (!p.on) return null;
  const subs = require('../subscriptions/subscriptions.service'); // eslint-disable-line global-require
  const pricing = require('../site/pricing'); // eslint-disable-line global-require
  const [plans, st] = await Promise.all([subs.listPlans({ activeOnly: true, publicOnly: true }), subs.settings()]);
  const local = plans.map((pl) => pricing.card({ ...pl, currency: p.currency, price_monthly: convert(pl.price_monthly, p.rate), price_yearly: convert(pl.price_yearly, p.rate) }));
  const [clinics, warehouses] = await Promise.all([
    knex('businesses').where({ country: code, status: 'active' }).whereNot('kind', 'center_admin').count({ n: '*' }).then((r) => Number(r[0].n)),
    knex('vendors').where({ country: code, status: 'active' }).count({ n: '*' }).then((r) => Number(r[0].n)),
  ]);
  const zone = (options.ZONES.find((z) => z[1] === code) || [])[0] || null;
  return { code, ...p, pricing: { plans: local, trialDays: st.enabled ? Number(st.trialDays) || 0 : 0 }, clinics, warehouses, zone };
}
const enabledCodes = async () => Object.entries(await all()).filter(([, v]) => v.on).map(([cc]) => cc);

module.exports = { KEY, CODES, CURRENCY, all, save, page, convert, enabledCodes };
