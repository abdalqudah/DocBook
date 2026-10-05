// Study cost calculator: yearly cost of studying in up to three destinations, from each destination's cost profile
// (editable in the catalogue), optional program tuition, accommodation choice and expected scholarship; shown in any
// currency. Estimates only — the page and every saved estimate say so.
const knex = require('../../db/knex');
const money = require('./money');
const { randomToken } = require('../../core/tokens');

const ITEMS = ['tuition', 'accommodation', 'food', 'transport', 'insurance', 'visa', 'flights', 'other'];
const HOUSING = { campus: 1.1, shared: 0.8, private: 1.25, homestay: 1 };

function profile(d) {
  let p = d.cost_profile;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
  const living = d.living_month_min || d.living_month_max ? ((Number(d.living_month_min) || Number(d.living_month_max)) + (Number(d.living_month_max) || Number(d.living_month_min))) / 2 * 12 : null;
  return {
    tuition: (p && p.tuition) || (d.tuition_min && d.tuition_max ? Math.round((Number(d.tuition_min) + Number(d.tuition_max)) / 2) : Number(d.tuition_min) || 0),
    accommodation: (p && p.accommodation) || (living ? Math.round(living * 0.55) : 0),
    food: (p && p.food) || (living ? Math.round(living * 0.25) : 0),
    transport: (p && p.transport) || (living ? Math.round(living * 0.08) : 0),
    insurance: (p && p.insurance) || 0, visa: (p && p.visa) || 0, flights: (p && p.flights) || 0, other: (p && p.other) || (living ? Math.round(living * 0.12) : 0),
  };
}

/**
 * input: { destinations: [slug], currency, housing, scholarship (yearly, in `currency`), years, tuitionOverride: { slug: amount in destination currency } }
 * Returns rows per destination with yearly items and totals in `currency`.
 */
async function calculate(input) {
  const currency = String(input.currency || 'USD').toUpperCase();
  const slugs = [].concat(input.destinations || []).slice(0, 3);
  const dests = slugs.length ? await knex('destinations').whereIn('slug', slugs).where({ is_active: true }) : [];
  const years = Math.max(1, Math.min(6, Number(input.years) || 1));
  const factor = HOUSING[input.housing] || 1;
  const rows = [];
  for (const d of slugs.map((s) => dests.find((x) => x.slug === s)).filter(Boolean)) {
    const base = profile(d);
    const override = input.tuitionOverride && Number(input.tuitionOverride[d.slug]);
    if (override > 0) base.tuition = override;
    base.accommodation = Math.round(base.accommodation * factor);
    const items = {};
    for (const k of ITEMS) items[k] = await money.convert(base[k] || 0, d.currency, currency); // eslint-disable-line no-await-in-loop
    const gross = ITEMS.reduce((s, k) => s + (items[k] || 0), 0);
    const scholarship = Math.min(gross, Math.max(0, Number(input.scholarship) || 0));
    rows.push({ slug: d.slug, name_en: d.name_en, name_ar: d.name_ar, country_code: d.country_code, sourceCurrency: d.currency, items, gross, scholarship, net: gross - scholarship, total: (gross - scholarship) * years, years });
  }
  return { currency, rows, years, housing: input.housing || 'shared' };
}

async function saveEstimate(result, { studentId = null, leadId = null, userId = null, title = null, note = null } = {}) {
  const token = randomToken(12).replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  const [id] = await knex('cost_estimates').insert({ token, student_id: studentId, lead_id: leadId, created_by: userId, title, note, currency: result.currency, items: JSON.stringify(result) });
  return { id, token };
}

async function byToken(token) {
  if (!/^[A-Za-z0-9]{6,32}$/.test(String(token || ''))) return null;
  const row = await knex('cost_estimates').where({ token }).first();
  if (!row) return null;
  return { ...row, result: typeof row.items === 'string' ? JSON.parse(row.items) : row.items };
}

module.exports = { calculate, saveEstimate, byToken, ITEMS, HOUSING, profile };
