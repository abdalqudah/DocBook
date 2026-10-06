// Staff catalogue management: destinations, universities, programs, scholarships (resource CRUD + CSV import/export).
// Commission information and internal notes are visible only with "catalog.internal" and never on the website.
const express = require('express');
const knex = require('../../db/knex');
const { resource } = require('../../core/resource');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah } = require('../../core/http');
const audit = require('../../core/audit');
const nav = require('../staff/nav');
const registry = require('../staff/registry');
const settingsWeb = require('../settings/web');
const ref = require('./reference');
const money = require('./money');

nav.add('admissions', { key: 'universities', href: '/staff/universities', icon: 'building-2', perms: ['catalog.view'] });
nav.add('admissions', { key: 'programs', href: '/staff/programs', icon: 'book-open', perms: ['catalog.view'] });
nav.add('admissions', { key: 'scholarships', href: '/staff/scholarships', icon: 'award', perms: ['catalog.view'] });
nav.add('admissions', { key: 'destinations', href: '/staff/destinations', icon: 'globe', perms: ['catalog.manage'] });
settingsWeb.addSection({ key: 'currencies', icon: 'coins', href: '/staff/currencies', perms: ['catalog.manage', 'settings.manage'] });

const months = Array.from({ length: 12 }, (_, i) => String(i + 1));
const monthOptions = (req) => months.map((m) => ({ value: m, label: new Intl.DateTimeFormat(req.locale === 'ar' ? 'ar' : 'en', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, Number(m) - 1, 1))) }));
const currencyOptions = async () => (await money.codes()).map((c) => ({ value: c, label: c }));
const destinationOptions = async (req) => (await knex('destinations').orderBy('position')).map((d) => ({ value: String(d.id), label: (req.locale === 'ar' && d.name_ar) || d.name_en }));
const universityOptions = async (req) => (await knex('universities').orderBy('name_en').select('id', 'name_en', 'name_ar')).map((u) => ({ value: String(u.id), label: (req.locale === 'ar' && u.name_ar) || u.name_en }));
const L = (req, row, f) => (req.locale === 'ar' && row[`${f}_ar`]) || row[`${f}_en`];
const intList = (arr) => (arr || []).map(Number).filter((n) => n >= 1 && n <= 12);
const seoFields = [{ name: 'seo_title', type: 'text', bilingual: true, max: 160 }, { name: 'seo_description', type: 'textarea', bilingual: true, max: 300, rows: 2 }];

// ---------------------------------------------------------------- Destinations
const destinations = resource({
  key: 'destinations', table: 'destinations', entity: 'destination', nameField: 'name_en', slugFrom: 'name_en', perms: { view: 'catalog.manage' },
  publicUrl: (r) => `/study/${r.slug}`, defaults: { is_active: true, is_featured: true, currency: 'USD' },
  list: { search: ['name_en', 'name_ar', 'slug'], defaultSort: ['position', 'asc'], columns: [
    { key: 'name', label: 'common.name', render: (r, req) => `${ref.flag(r.country_code)} ${L(req, r, 'name')}` }, { key: 'currency', label: 'catalog.currency' },
    { key: 'tuition', label: 'catalog.tuition', render: (r) => (r.tuition_min ? `${r.tuition_min}–${r.tuition_max || ''} ${r.currency}` : '—') }, { key: 'is_active', label: 'common.status', type: 'bool' }] },
  sections: [
    { key: 'basics', fields: [{ name: 'name', type: 'text', bilingual: true, required: true }, { name: 'slug', type: 'slug', hint: 'catalog.slug_hint' },
      { name: 'country_code', type: 'select', required: true, options: async (req) => ref.countries(req.locale) }, { name: 'position', type: 'int' },
      { name: 'tagline', type: 'text', bilingual: true }, { name: 'intro', type: 'markdown', bilingual: true, rows: 6 }, { name: 'why', type: 'list', bilingual: true, hint: 'catalog.one_per_line' }, { name: 'hero_image', type: 'image' }] },
    { key: 'costs', fields: [{ name: 'currency', type: 'select', required: true, options: currencyOptions }, { name: 'tuition_min', type: 'int' }, { name: 'tuition_max', type: 'int' },
      { name: 'living_month_min', type: 'int' }, { name: 'living_month_max', type: 'int' }, { name: 'cost_profile', type: 'json', hint: 'catalog.cost_profile_hint', rows: 4 }] },
    { key: 'study', fields: [{ name: 'post_study_work', type: 'text', bilingual: true }, { name: 'visa_type', type: 'text' }, { name: 'intakes', type: 'text', bilingual: true }, { name: 'regions', type: 'json', hint: 'catalog.regions_hint', rows: 6 }] },
    { key: 'visibility', fields: [{ name: 'is_featured', type: 'bool' }, { name: 'is_active', type: 'bool' }] },
    { key: 'seo', fields: seoFields },
  ],
});

// ---------------------------------------------------------------- Universities
const universities = resource({
  key: 'universities', table: 'universities', entity: 'university', nameField: 'name_en', slugFrom: 'name_en',
  publicUrl: (r) => `/universities/${r.slug}`, defaults: { is_active: true, currency: 'USD', partner_status: 'none' },
  list: {
    search: ['name_en', 'name_ar', 'city_en', 'city_ar'], defaultSort: ['name_en', 'asc'],
    select: (q) => q.leftJoin('destinations as d', 'd.id', 'universities.destination_id').select('universities.*', 'd.name_en as destination_en', 'd.name_ar as destination_ar',
      knex.raw('(SELECT COUNT(*) FROM programs p WHERE p.university_id = universities.id) AS program_count')),
    filters: [
      { key: 'destination_id', options: destinationOptions, label: 'catalog.destination' },
      { key: 'partner_status', options: ['none', 'prospect', 'active', 'paused', 'ended'], optionLabel: 'catalog.partner', label: 'catalog.partner_status' },
      { key: 'is_active', options: [{ value: '1', label: 'common.enabled' }, { value: '0', label: 'common.disabled' }], label: 'common.status', translate: true },
    ],
    columns: [
      { key: 'name', label: 'common.name', render: (r, req) => L(req, r, 'name'), link: true }, { key: 'city', label: 'common.city', render: (r, req) => [L(req, r, 'city'), L(req, r, 'destination')].filter(Boolean).join(', ') },
      { key: 'program_count', label: 'nav.programs' }, { key: 'ranking_world', label: 'catalog.ranking_world' },
      { key: 'partner_status', label: 'catalog.partner_status', render: (r, req) => req.t(`catalog.partner.${r.partner_status}`) }, { key: 'is_active', label: 'common.status', type: 'bool' }],
  },
  sections: [
    { key: 'basics', fields: [{ name: 'name', type: 'text', bilingual: true, required: true, max: 190 }, { name: 'slug', type: 'slug', hint: 'catalog.slug_hint' },
      { name: 'destination_id', type: 'select', options: destinationOptions }, { name: 'country_code', type: 'select', options: async (req) => ref.countries(req.locale) },
      { name: 'city', type: 'text', bilingual: true }, { name: 'state', type: 'text' }, { name: 'website', type: 'url' },
      { name: 'institution_type', type: 'select', options: ['public', 'private', 'community_college', 'pathway', 'language_school'], optionLabel: 'catalog.type' },
      { name: 'logo', type: 'image' }, { name: 'cover_image', type: 'image' }, { name: 'description', type: 'markdown', bilingual: true, rows: 6 }] },
    { key: 'ranking', fields: [{ name: 'ranking_world', type: 'int' }, { name: 'ranking_national', type: 'int' }, { name: 'ranking_source', type: 'text', hint: 'catalog.ranking_source_hint' }] },
    { key: 'fees', fields: [{ name: 'currency', type: 'select', required: true, options: currencyOptions }, { name: 'tuition_min', type: 'int' }, { name: 'tuition_max', type: 'int' }, { name: 'application_fee', type: 'int' }] },
    { key: 'admission', fields: [{ name: 'admission', type: 'markdown', bilingual: true, rows: 4 }, { name: 'min_ielts', type: 'number', max: 9, step: 0.5 }, { name: 'min_toefl', type: 'int', max: 120 },
      { name: 'min_pte', type: 'int', max: 90 }, { name: 'min_duolingo', type: 'int', max: 160 }, { name: 'intakes', type: 'checks', options: monthOptions },
      { name: 'deadlines', type: 'text', bilingual: true }, { name: 'documents_required', type: 'list', hint: 'catalog.one_per_line' }] },
    { key: 'campus', fields: [{ name: 'campus', type: 'markdown', bilingual: true, rows: 3 }, { name: 'accommodation', type: 'markdown', bilingual: true, rows: 3 }, { name: 'contact_email', type: 'text' }, { name: 'contact_phone', type: 'text' }] },
    { key: 'partnership', internal: true, fields: [{ name: 'partner_status', type: 'select', required: true, options: ['none', 'prospect', 'active', 'paused', 'ended'], optionLabel: 'catalog.partner' },
      { name: 'commission_note', type: 'textarea', internal: true, rows: 3 }, { name: 'internal_notes', type: 'textarea', internal: true, rows: 4 }] },
    { key: 'visibility', fields: [{ name: 'is_featured', type: 'bool' }, { name: 'is_active', type: 'bool' }] },
    { key: 'seo', fields: seoFields },
  ],
  beforeSave: (row) => { if (row.intakes) row.intakes = JSON.stringify(intList(JSON.parse(row.intakes))); return row; },
  related: async (row) => (await knex('programs').where({ university_id: row.id }).orderBy('name_en').select('id', 'name_en', 'name_ar', 'degree_level', 'is_active')).map((p) => ({ href: `/staff/programs/${p.id}`, title: p.name_en, sub: p.degree_level, off: !p.is_active })),
  csv: {
    columns: ['slug', 'name_en', 'name_ar', 'destination', 'country_code', 'city_en', 'city_ar', 'website', 'institution_type', 'ranking_world', 'ranking_national', 'currency', 'tuition_min', 'tuition_max',
      'application_fee', 'min_ielts', 'min_toefl', 'min_pte', 'intakes', 'partner_status', 'is_active', 'commission_note', 'internal_notes'],
    exportValue: (c, r) => (c === 'intakes' ? (r.intakes || []).join(' ') : r[c]),
    importValue: async (rec) => {
      const out = { ...rec };
      if (rec.destination) { const d = await knex('destinations').where({ slug: rec.destination }).first('id'); out.destination_id = d ? String(d.id) : null; }
      delete out.destination;
      if (rec.intakes !== undefined) out.intakes = String(rec.intakes).split(/[\s,;]+/).filter(Boolean);
      return out;
    },
  },
});

// ---------------------------------------------------------------- Programs
async function normaliseProgram(row) {
  if (row.intakes) row.intakes = JSON.stringify(intList(JSON.parse(row.intakes)));
  if (row.tuition_fee !== undefined) row.tuition_usd = row.tuition_fee === null ? null : await money.toUsd(row.tuition_fee, row.currency || 'USD');
  if (row.university_id) row.university_id = Number(row.university_id);
  if (row.commission_type === null || row.commission_type === '') row.commission_type = 'inherit';
  if (row.commission_type === 'inherit') row.commission_rate = null;
  return row;
}
const programs = resource({
  key: 'programs', table: 'programs', entity: 'program', nameField: 'name_en', slugFrom: 'name_en',
  publicUrl: (r) => `/programs/${r.slug}`, defaults: { is_active: true, currency: 'USD', study_mode: 'on_campus', internship: 'none', commission_type: 'inherit' },
  list: {
    search: ['name_en', 'name_ar', 'faculty'], defaultSort: ['name_en', 'asc'],
    select: (q) => q.join('universities as u', 'u.id', 'programs.university_id').select('programs.*', 'u.name_en as university_en', 'u.name_ar as university_ar', 'u.slug as university_slug'),
    filters: [
      { key: 'university_id', options: universityOptions, label: 'catalog.university' },
      { key: 'degree_level', options: ref.DEGREES, optionLabel: 'ref.degree', label: 'leads.degree' },
      { key: 'field', options: ref.FIELDS, optionLabel: 'ref.field', label: 'leads.field' },
    ],
    columns: [
      { key: 'name', label: 'common.name', render: (r, req) => L(req, r, 'name'), link: true }, { key: 'university', label: 'catalog.university', render: (r, req) => L(req, r, 'university') },
      { key: 'degree_level', label: 'leads.degree', render: (r, req) => req.t(`ref.degree.${r.degree_level}`) }, { key: 'tuition', label: 'catalog.tuition', render: (r) => (r.tuition_fee ? `${r.tuition_fee.toLocaleString('en')} ${r.currency}` : '—') },
      { key: 'next_deadline', label: 'catalog.deadline', type: 'date' }, { key: 'is_active', label: 'common.status', type: 'bool' }],
  },
  sections: [
    { key: 'basics', fields: [{ name: 'name', type: 'text', bilingual: true, required: true, max: 190 }, { name: 'slug', type: 'slug', hint: 'catalog.slug_hint' },
      { name: 'university_id', type: 'select', required: true, options: universityOptions }, { name: 'degree_level', type: 'select', required: true, options: ref.DEGREES, optionLabel: 'ref.degree' },
      { name: 'field', type: 'select', required: true, options: ref.FIELDS, optionLabel: 'ref.field' }, { name: 'faculty', type: 'text', max: 160 },
      { name: 'duration_months', type: 'int', max: 120 }, { name: 'study_mode', type: 'select', required: true, options: ref.STUDY_MODES, optionLabel: 'ref.mode' },
      { name: 'program_url', type: 'url' }, { name: 'description', type: 'markdown', bilingual: true, rows: 5 }] },
    { key: 'fees', fields: [{ name: 'currency', type: 'select', required: true, options: currencyOptions }, { name: 'tuition_fee', type: 'int', hint: 'catalog.per_year' }, { name: 'application_fee', type: 'int' }, { name: 'scholarships_available', type: 'bool' }] },
    { key: 'dates', fields: [{ name: 'intakes', type: 'checks', options: monthOptions }, { name: 'next_deadline', type: 'date' }, { name: 'deadline_note', type: 'text', max: 190 }] },
    { key: 'requirements', fields: [{ name: 'min_gpa_pct', type: 'number', max: 100, hint: 'catalog.gpa_pct_hint' }, { name: 'academic', type: 'markdown', bilingual: true, rows: 3 },
      { name: 'min_ielts', type: 'number', max: 9 }, { name: 'min_ielts_band', type: 'number', max: 9 }, { name: 'min_toefl', type: 'int', max: 120 }, { name: 'min_pte', type: 'int', max: 90 },
      { name: 'min_duolingo', type: 'int', max: 160 }, { name: 'documents_required', type: 'list', hint: 'catalog.one_per_line' }] },
    { key: 'outcomes', fields: [{ name: 'internship', type: 'select', required: true, options: ['none', 'optional', 'included', 'coop'], optionLabel: 'catalog.internship' }, { name: 'work_after_study', type: 'bool' }, { name: 'work_after_study_note', type: 'text' }] },
    { key: 'internal', internal: true, fields: [{ name: 'commission_type', type: 'select', internal: true, options: ['inherit', 'percent', 'fixed'], optionLabel: 'partnerp.commission_type', hint: 'partnerp.commission_hint' }, { name: 'commission_rate', type: 'number', internal: true, min: 0, max: 100000 }, { name: 'internal_notes', type: 'textarea', internal: true, rows: 4 }] },
    { key: 'visibility', fields: [{ name: 'is_active', type: 'bool' }] },
    { key: 'seo', fields: seoFields },
  ],
  beforeSave: normaliseProgram,
  csv: {
    key: 'slug',
    columns: ['slug', 'name_en', 'name_ar', 'university', 'degree_level', 'field', 'faculty', 'duration_months', 'study_mode', 'currency', 'tuition_fee', 'application_fee', 'intakes', 'next_deadline',
      'min_gpa_pct', 'min_ielts', 'min_ielts_band', 'min_toefl', 'min_pte', 'min_duolingo', 'scholarships_available', 'internship', 'work_after_study', 'program_url', 'is_active', 'internal_notes'],
    exportValue: (c, r) => (c === 'intakes' ? (r.intakes || []).join(' ') : c === 'university' ? r.university_slug : r[c]),
    importValue: async (rec) => {
      const out = { ...rec };
      if (rec.university) { const u = await knex('universities').where({ slug: rec.university }).first('id'); out.university_id = u ? String(u.id) : null; }
      delete out.university;
      if (rec.intakes !== undefined) out.intakes = String(rec.intakes).split(/[\s,;]+/).filter(Boolean);
      return out;
    },
  },
});

// ---------------------------------------------------------------- Scholarships
const scholarships = resource({
  key: 'scholarships', table: 'scholarships', entity: 'scholarship', nameField: 'name_en', slugFrom: 'name_en',
  publicUrl: (r) => `/scholarships/${r.slug}`, defaults: { is_active: true, currency: 'USD', amount_type: 'fixed' },
  list: {
    search: ['name_en', 'name_ar', 'provider_en'], defaultSort: ['deadline', 'asc'],
    filters: [{ key: 'destination_id', options: destinationOptions, label: 'catalog.destination' }],
    columns: [{ key: 'name', label: 'common.name', render: (r, req) => L(req, r, 'name'), link: true }, { key: 'provider', label: 'catalog.provider', render: (r, req) => L(req, r, 'provider') || '—' },
      { key: 'amount', label: 'catalog.amount', render: (r, req) => (r.amount_type === 'full' ? req.t('catalog.amount_type.full') : r.amount_type === 'percentage' ? `${r.amount_min || ''}–${r.amount_max || ''}%` : r.amount_min || r.amount_max ? `${r.amount_min || ''}–${r.amount_max || ''} ${r.currency}` : '—') },
      { key: 'deadline', label: 'catalog.deadline', type: 'date' }, { key: 'is_active', label: 'common.status', type: 'bool' }],
  },
  sections: [
    { key: 'basics', fields: [{ name: 'name', type: 'text', bilingual: true, required: true, max: 190 }, { name: 'slug', type: 'slug', hint: 'catalog.slug_hint' }, { name: 'provider', type: 'text', bilingual: true },
      { name: 'university_id', type: 'select', options: universityOptions }, { name: 'destination_id', type: 'select', options: destinationOptions },
      { name: 'description', type: 'markdown', bilingual: true, rows: 4 }, { name: 'source_url', type: 'url', hint: 'catalog.source_hint' }] },
    { key: 'award', fields: [{ name: 'amount_type', type: 'select', required: true, options: ['fixed', 'percentage', 'full', 'varies'], optionLabel: 'catalog.amount_type' },
      { name: 'amount_min', type: 'int' }, { name: 'amount_max', type: 'int' }, { name: 'currency', type: 'select', required: true, options: currencyOptions }, { name: 'coverage', type: 'text', bilingual: true }] },
    { key: 'eligibility', fields: [{ name: 'eligibility', type: 'list', bilingual: true, hint: 'catalog.one_per_line' }, { name: 'degree_levels', type: 'checks', options: ref.DEGREES, optionLabel: 'ref.degree' },
      { name: 'fields', type: 'checks', options: ref.FIELDS, optionLabel: 'ref.field' }, { name: 'nationalities', type: 'list', hint: 'catalog.nationalities_hint' },
      { name: 'min_gpa_pct', type: 'number', max: 100 }, { name: 'min_ielts', type: 'number', max: 9 }] },
    { key: 'dates', fields: [{ name: 'deadline', type: 'date' }, { name: 'deadline_note', type: 'text', max: 190 }] },
    { key: 'visibility', fields: [{ name: 'is_active', type: 'bool' }] },
    { key: 'seo', fields: seoFields },
  ],
  beforeSave: (row) => { if (row.nationalities) row.nationalities = JSON.stringify(JSON.parse(row.nationalities).map((c) => String(c).trim().toUpperCase()).filter((c) => ref.ISO.includes(c))); return row; },
  csv: {
    columns: ['slug', 'name_en', 'name_ar', 'provider_en', 'amount_type', 'amount_min', 'amount_max', 'currency', 'deadline', 'source_url', 'is_active'],
    importValue: async (rec) => rec,
  },
});

// Searching the catalogue from the command palette.
registry.addSearch(async (req, q) => {
  if (!req.can('catalog.view')) return null;
  const like = `%${String(q).replace(/[%_\\]/g, '')}%`;
  const [ps, us] = await Promise.all([
    knex('programs as p').join('universities as u', 'u.id', 'p.university_id').where((w) => w.where('p.name_en', 'like', like).orWhere('p.name_ar', 'like', like)).select('p.id', 'p.name_en', 'p.name_ar', 'u.name_en as uni').limit(4),
    knex('universities').where((w) => w.where('name_en', 'like', like).orWhere('name_ar', 'like', like)).select('id', 'name_en', 'name_ar', 'city_en').limit(4),
  ]);
  return { key: 'catalog', label: req.t('palette.catalog'), items: [
    ...us.map((u) => ({ title: L(req, u, 'name'), sub: u.city_en, href: `/staff/universities/${u.id}`, icon: 'building-2' })),
    ...ps.map((p) => ({ title: L(req, p, 'name'), sub: p.uni, href: `/staff/programs/${p.id}`, icon: 'book-open' })),
  ] };
});

const router = express.Router();
router.use('/destinations', destinations.router);
router.use('/universities', universities.router);
router.use('/programs', programs.router);
router.use('/scholarships', scholarships.router);

// Exchange rates used to compare tuition and budgets (estimates; shown with a note on the website).
router.get('/currencies', can('catalog.manage', 'settings.manage'), ah(async (req, res) => {
  res.page('pages/staff/catalog/currencies', { layout: 'staff', narrow: true, title: req.t('settings.currencies'), rates: await knex('currency_rates').orderBy('code') });
}));
router.post('/currencies', can('catalog.manage', 'settings.manage'), ah(async (req, res) => {
  const before = Object.fromEntries((await knex('currency_rates')).map((r) => [r.code, Number(r.per_usd)]));
  const next = {};
  for (const [k, v] of Object.entries(req.body)) {
    const m = /^rate_([A-Z]{3})$/.exec(k);
    if (m && Number(v) > 0) next[m[1]] = Number(v);
  }
  const add = String(req.body.new_code || '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(add) && Number(req.body.new_rate) > 0) next[add] = Number(req.body.new_rate);
  next.USD = 1;
  for (const [code, rate] of Object.entries(next)) await knex.raw('INSERT INTO currency_rates (code, per_usd, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE per_usd = VALUES(per_usd), updated_at = NOW()', [code, rate]); // eslint-disable-line no-await-in-loop
  money.clear();
  // keep normalised tuition in step with the new rates
  for (const p of await knex('programs').whereNotNull('tuition_fee').select('id', 'tuition_fee', 'currency')) await knex('programs').where({ id: p.id }).update({ tuition_usd: await money.toUsd(p.tuition_fee, p.currency) }); // eslint-disable-line no-await-in-loop
  await audit.record(req.ctx, 'settings.currencies_updated', { entityType: 'settings', entityId: 'currencies', oldValues: before, newValues: next });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/staff/currencies');
}));

module.exports = { router, destinations, universities, programs, scholarships };
