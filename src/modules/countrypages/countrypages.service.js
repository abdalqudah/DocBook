// A landing page per country on the platform's site (/sa, /jo…): its own headline and text, the plans in the
// country's currency (the admin's rate from the plans' currency, rounded), how many clinics and drug warehouses of
// that country are on the platform, and sign-up with the country's time zone and currency already chosen.
// Admin → Website → Country pages. Stored in platform_settings "country_pages".
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const options = require('../settings/options');

const KEY = 'country_pages';
const CODES = ['JO', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'EG', 'IQ', 'PS', 'LB']; // shown by default; any other country can be added
const CURRENCY = { JO: 'JOD', SA: 'SAR', AE: 'AED', KW: 'KWD', QA: 'QAR', BH: 'BHD', OM: 'OMR', EG: 'EGP', IQ: 'IQD', PS: 'ILS', LB: 'USD' };
const RATE_FROM_JOD = { JO: 1, SA: 5.29, AE: 5.18, KW: 0.43, QA: 5.13, BH: 0.53, OM: 0.54, EG: 70, IQ: 1850, PS: 5.2, LB: 1.41 }; // starting values only: the admin sets each
const str = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const parse = (v) => { try { return JSON.parse(v || '{}') || {}; } catch { return {}; } };

const isCode = (cc) => options.COUNTRIES.includes(cc);
const defaults = (cc) => ({ on: false, title_ar: '', title_en: '', lead_ar: '', lead_en: '', body_ar: '', body_en: '', currency: CURRENCY[cc] || (options.geoOf(cc) || {}).currency || 'USD', rate: RATE_FROM_JOD[cc] || 1 });
const all = () => cache.remember('cpages:all', async () => {
  const row = await knex('platform_settings').where({ key: KEY }).first('value').catch(() => null);
  const v = parse(row && row.value);
  const codes = [...new Set([...CODES, ...Object.keys(v).filter(isCode)])];
  return Object.fromEntries(codes.map((cc) => [cc, { ...defaults(cc), ...(v[cc] || {}) }]));
}, 30_000);

async function save(ctx, body) {
  const cur = await all();
  const errors = {};
  const out = {};
  // a country added from the list joins the pages
  const added = String(body.add_country || '').toUpperCase();
  if (isCode(added) && !cur[added]) cur[added] = defaults(added);
  Object.keys(cur).forEach((cc) => {
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

/**
 * A plan's price in the page's currency, rounded up to a price ending in 9: 185.15 → 199 (rounded up to 5 / 10 first,
 * then to the 9 of that ten), 1851.5 → 1869, and under 100 to the nearest whole number: 15.05 → 15, 70.5 → 70. The
 * plans' own currency (rate 1) is
 * shown as set.
 */
function convert(amount, rate) {
  const v = Number(amount || 0) * rate;
  if (!v) return 0;
  if (Number(rate) === 1) return Number(amount);
  if (v < 100) return Math.max(1, Math.round(v - 0.001)); // whole numbers, a half rounds down: 70.5 → 70
  const step = v >= 1000 ? 10 : 5;
  const r = Math.ceil(v / step) * step;
  return r - (r % 10) + 9;
}

/**
 * The yearly price in the page's currency: the same number of months as the plan's own yearly price (350 a year for
 * 35 a month → 10 × 199 = 1990), so the saving reads the same in every country; converted on its own otherwise.
 */
function yearlyOf(plan, monthly, rate) {
  const months = Number(plan.price_monthly) > 0 ? Number(plan.price_yearly) / Number(plan.price_monthly) : 0;
  if (!monthly || !months || Number(rate) === 1) return convert(plan.price_yearly, rate);
  return Number((monthly * months).toFixed(1));
}

/** The page for a country code (lowercase in the URL) or null when it is not switched on. */
async function page(cc) {
  const code = String(cc || '').toUpperCase();
  if (!isCode(code)) return null;
  const p = (await all())[code];
  if (!p || !p.on) return null;
  const subs = require('../subscriptions/subscriptions.service'); // eslint-disable-line global-require
  const pricing = require('../site/pricing'); // eslint-disable-line global-require
  const [plans, st] = await Promise.all([subs.listPlans({ activeOnly: true, publicOnly: true }), subs.settings()]);
  const local = plans.map((pl) => { const m = convert(pl.price_monthly, p.rate); return pricing.card({ ...pl, currency: p.currency, price_monthly: m, price_yearly: yearlyOf(pl, m, p.rate) }); });
  const [clinics, warehouses] = await Promise.all([
    knex('businesses').where({ country: code, status: 'active' }).whereNot('kind', 'center_admin').count({ n: '*' }).then((r) => Number(r[0].n)),
    knex('vendors').where({ country: code, status: 'active' }).count({ n: '*' }).then((r) => Number(r[0].n)),
  ]);
  const zone = (options.ZONES.find((z) => z[1] === code) || [])[0] || null;
  return { code, ...p, pricing: { plans: local, trialDays: st.enabled ? Number(st.trialDays) || 0 : 0 }, clinics, warehouses, zone };
}
const enabledCodes = async () => Object.entries(await all()).filter(([, v]) => v.on).map(([cc]) => cc);

module.exports = { KEY, CODES, CURRENCY, all, save, page, convert, yearlyOf, enabledCodes };
