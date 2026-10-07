// Clinic types (specialties) offered to clinics — in sign-up, onboarding and the clinic's settings — managed by the
// platform admin (/admin/clinic-types): built-in types can be hidden, and the admin adds new ones with an Arabic and
// an English name and the website template a new clinic of that type starts from. Stored in platform_settings
// "clinic_types" = { hidden: [key], custom: [{ key, ar, en, template }] }.
// A clinic that already has a hidden type keeps it (it stays valid and shown for that clinic).
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { dictionaries } = require('../../core/i18n');
const { E } = require('../../core/errors');

const KEY = 'clinic_types';
const BUILTIN = require('../specialty/catalogue').KEYS;
const MAX_CUSTOM = 60;
let state = { hidden: [], custom: [], at: 0 };

const clean = (v, max) => String(v || '').replace(/[\u0000-\u001F\u007F<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Names of the admin's types join the translations, so every t('specialties.<key>') shows them. */
function inject() {
  for (const c of state.custom) {
    for (const l of ['ar', 'en']) {
      if (!dictionaries[l]) continue; // eslint-disable-line no-continue
      dictionaries[l].specialties = dictionaries[l].specialties || {};
      dictionaries[l].specialties[c.key] = (l === 'en' ? c.en : c.ar) || c.ar || c.en;
    }
  }
}

function parse(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  v = v && typeof v === 'object' ? v : {};
  const custom = (Array.isArray(v.custom) ? v.custom : []).filter((c) => c && /^c_[a-z0-9]{4,20}$/.test(c.key) && (c.ar || c.en)).slice(0, MAX_CUSTOM)
    .map((c) => ({ key: c.key, ar: clean(c.ar, 60), en: clean(c.en, 60), template: typeof c.template === 'string' ? c.template : 'general' }));
  return { hidden: (Array.isArray(v.hidden) ? v.hidden : []).filter((k) => BUILTIN.includes(k)), custom };
}

/** Reads the list (cached for a minute). */
async function load(force = false) {
  if (!force && Date.now() - state.at < 60_000) return state;
  const row = await knex('platform_settings').where({ key: KEY }).first('value').catch(() => null);
  state = { ...parse(row && row.value), at: Date.now() };
  inject();
  return state;
}

const keys = () => [...BUILTIN, ...state.custom.map((c) => c.key)];
const valid = (key) => keys().includes(key);
const visible = () => keys().filter((k) => !state.hidden.includes(k));

/** Options for a select: the visible types, plus the clinic's current one when it is hidden. */
function options(t, current = null) {
  const list = visible();
  if (current && valid(current) && !list.includes(current)) list.push(current);
  return list.map((k) => ({ value: k, label: t(`specialties.${k}`) }));
}

/** The website template a new site of this type starts from (null = by the built-in mapping). */
function template(key) {
  const c = state.custom.find((x) => x.key === key);
  return c ? c.template : null;
}

async function save(ctx, input, { templates }) {
  const hidden = [].concat(input.hidden || []).filter((k) => BUILTIN.includes(k));
  const rows = Array.isArray(input.custom) ? input.custom : (input.custom && typeof input.custom === 'object' ? Object.values(input.custom) : []);
  const custom = [];
  // A type clinics use is never removed (it can be hidden from new clinics instead).
  const inUse = new Set(await knex('businesses').whereNotNull('specialty').distinct().pluck('specialty'));
  for (const r of rows) {
    if (!r || ([].concat(r.remove || []).pop() === '1' && !inUse.has(r.key))) continue; // eslint-disable-line no-continue
    const ar = clean(r.ar, 60); const en = clean(r.en, 60);
    if (!ar && !en) continue; // eslint-disable-line no-continue
    const key = /^c_[a-z0-9]{4,20}$/.test(r.key || '') ? r.key : `c_${require('crypto').randomBytes(4).toString('hex')}`; // eslint-disable-line global-require
    custom.push({ key, ar: ar || en, en: en || ar, template: templates.includes(r.template) ? r.template : 'general' });
  }
  if (custom.length > MAX_CUSTOM) throw E.validation({ custom: 'Too many types.' });
  if (BUILTIN.every((k) => hidden.includes(k)) && !custom.length) throw E.validation({ hidden: 'Keep at least one clinic type.' });
  const before = await load(true);
  const value = JSON.stringify({ hidden, custom });
  await knex('platform_settings').insert({ key: KEY, value }).onConflict('key').merge({ value, updated_at: new Date() });
  await audit.record(ctx, 'platform.clinic_types_changed', { entityType: 'platform_settings', entityId: KEY, oldValues: { hidden: before.hidden, custom: before.custom.map((c) => c.key) }, newValues: { hidden, custom: custom.map((c) => c.key) } });
  await load(true);
  return state;
}

/** Express middleware: keeps the list fresh for the request (validation and select options are synchronous). */
const middleware = (req, res, next) => { load().then(() => next(), next); };

module.exports = { BUILTIN, KEY, load, keys, valid, visible, options, template, save, middleware, get state() { return state; } };
