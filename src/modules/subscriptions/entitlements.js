// Plan entitlements (DocBook 2.0 redesign 4.2): one registry of what a subscription plan can include. Plans store
// their values in subscription_plans.features (JSON) under these keys; the platform admin's plan form is drawn from
// this list; features are checked by KEY — never by plan name.
//   type bool  — included or not
//   type int   — a limit (null = no limit)
//   type list  — the allowed values of `options` ('*' = all)
// `fallback`: the value when a plan does not say (a plan saved before the key existed). `forExisting`: the value the
// migration writes into plans that existed when the key was added — chosen so no clinic loses what it had.
// While subscriptions are off, for a trial without a plan and for a comped clinic, everything is included (full()).
const { TEMPLATES } = require('../website/catalog');

const REGISTRY = [
  // Clinic features (the original keys — unchanged names).
  { key: 'online_consultations', type: 'bool', group: 'clinic', fallback: false },
  { key: 'online_payments', type: 'bool', group: 'clinic', fallback: false },
  { key: 'reminders', type: 'bool', group: 'clinic', fallback: false },
  { key: 'ai_assistant', type: 'bool', group: 'clinic', fallback: false },
  { key: 'specialty_modules', type: 'bool', group: 'clinic', fallback: false },
  { key: 'data_sync', type: 'bool', group: 'clinic', fallback: false },
  // Branches: how many the plan allows (1 = the main branch only; empty = no limit). The price for 2, 3 … branches is
  // set next to the plan's price (branch-pricing.js); the clinic chooses how many it pays for.
  { key: 'clinic.max_branches', type: 'int', group: 'clinic', fallback: 1, forExisting: 1 },
  // Website. The standard clinic page, online booking and basic search tags are never gated.
  { key: 'website.builder', type: 'bool', group: 'website', fallback: false, forExisting: true },
  { key: 'website.templates', type: 'list', group: 'website', options: TEMPLATES, fallback: ['general'], forExisting: '*' },
  { key: 'website.custom_domain', type: 'bool', group: 'website', fallback: false, forExisting: true }, // every clinic could connect one before
  { key: 'website.clinic_email', type: 'bool', group: 'website', fallback: false, forExisting: false },
  { key: 'website.analytics', type: 'bool', group: 'website', fallback: false, forExisting: false },
  { key: 'website.advanced_seo', type: 'bool', group: 'website', fallback: false, forExisting: false },
  { key: 'website.max_pages', type: 'int', group: 'website', fallback: 0, forExisting: null },
  { key: 'website.white_label', type: 'bool', group: 'website', fallback: false, forExisting: false }, // hide "clinic page by …" in the footer
  // Limits.
  { key: 'media.storage_mb', type: 'int', group: 'limits', fallback: null, forExisting: null },
  { key: 'limits.max_patients', type: 'int', group: 'limits', fallback: null, forExisting: null },
];
const byKey = new Map(REGISTRY.map((e) => [e.key, e]));
const KEYS = REGISTRY.map((e) => e.key);
const GROUPS = [...new Set(REGISTRY.map((e) => e.group))];

/** Everything included (no plan applies). */
const full = (e) => (e.type === 'bool' ? true : e.type === 'int' ? null : '*');

/** A plan's stored value for `key`, normalised to its type (the fallback when the plan does not say). */
function valueIn(features, key) {
  const e = byKey.get(key);
  if (!e) throw new Error(`Unknown entitlement: ${key}`);
  if (!features) return full(e); // no plan applies
  if (!Object.prototype.hasOwnProperty.call(features, key)) return e.fallback;
  const v = features[key];
  if (e.type === 'bool') return v === true;
  if (e.type === 'int') return v === null || v === undefined || v === '' ? null : Math.max(0, Math.floor(Number(v)) || 0);
  if (v === '*') return '*';
  return Array.isArray(v) ? v.filter((x) => e.options.includes(x)) : e.fallback;
}

/** Is `value` allowed by a list entitlement's value ('*' or an array)? */
const allows = (listValue, value) => listValue === '*' || (Array.isArray(listValue) && listValue.includes(value));
/** Is a count within an int entitlement (null = no limit)? */
const within = (limit, count) => limit === null || count < limit;

/** Reads a plan form (f_<key> for yes/no, n_<key> for limits, l_<key>[] + l_<key>_all for lists) into a features object. */
function fromForm(input) {
  const out = {};
  for (const e of REGISTRY) {
    if (e.type === 'bool') out[e.key] = input[`f_${e.key}`] === '1' || input[`f_${e.key}`] === 'on' || Boolean(input.features && input.features[e.key] === true);
    else if (e.type === 'int') {
      const raw = input[`n_${e.key}`];
      out[e.key] = raw === undefined || raw === null || String(raw).trim() === '' ? null : Math.max(0, Math.min(1_000_000, Math.floor(Number(raw)) || 0));
    } else {
      const all = input[`l_${e.key}_all`] === '1' || input[`l_${e.key}_all`] === 'on';
      out[e.key] = all ? '*' : [].concat(input[`l_${e.key}`] || []).map(String).filter((x) => e.options.includes(x));
    }
  }
  return out;
}

module.exports = { REGISTRY, KEYS, GROUPS, byKey, full, valueIn, allows, within, fromForm };
