// Public catalogue: Study Finder, programs, universities, scholarships, destinations, compare, shortlist,
// cost calculator and search. Server-rendered with clean URLs and structured data for search engines.
const express = require('express');
const knex = require('../../db/knex');
const { ah, ok } = require('../../core/http');
const { E } = require('../../core/errors');
const limits = require('../../middleware/limits');
const events = require('../../core/events');
const nav = require('../site/nav');
const features = require('../site/features');
const footer = require('../site/footer');
const finder = require('./finder.service');
const shortlist = require('./shortlist.service');
const compare = require('./compare.service');
const calculator = require('./calculator');
const money = require('./money');
const ref = require('./reference');
const { markdown } = require('../../core/markdown');

features.enable('search');
nav.add({ key: 'programs', href: '/programs', order: 10 });
nav.add({ key: 'universities', href: '/universities', order: 20 });
nav.add({ key: 'destinations', href: '/study', order: 30 });
nav.add({ key: 'scholarships', href: '/scholarships', order: 40 });
['programs', 'universities', 'scholarships'].forEach((k) => footer.add('study', { href: `/${k}`, label: `site.nav.${k}` }));
footer.add('study', { href: '/study', label: 'site.nav.destinations' });
footer.add('students', { href: '/cost-calculator', label: 'site.nav.calculator' });
footer.add('students', { href: '/compare', label: 'site.nav.compare' });
footer.add('students', { href: '/shortlist', label: 'site.nav.shortlist' });

const router = express.Router();
const parse = finder.parseJson;
const L = (req, row, f) => (req.locale === 'ar' ? row[`${f}_ar`] || row[`${f}_en`] : row[`${f}_en`] || row[`${f}_ar`]) || '';
const abs = (res, path) => `${res.locals.appUrl}${path}`;
const seoOf = (req, res, row, { title, description, path, image, jsonld, ogType }) => ({
  title: L(req, row || {}, 'seo_title') || title,
  description: (L(req, row || {}, 'seo_description') || description || '').slice(0, 300),
  canonical: abs(res, path),
  alternates: [{ lang: 'en', href: abs(res, `${path}${path.includes('?') ? '&' : '?'}lang=en`) }, { lang: 'ar', href: abs(res, `${path}${path.includes('?') ? '&' : '?'}lang=ar`) }],
  image, jsonld, ogType,
});

/** Shortlist + compare state for the current visitor (to render toggles). */
async function stateOf(req) {
  const owner = await shortlist.ownerOf(req);
  return { saved: await shortlist.ids(owner), comparing: compare.current(req) };
}

async function destinationsList() {
  return knex('destinations').where({ is_active: true }).orderBy('position');
}

// ------------------------------------------------------------------ Home
router.get('/', ah(async (req, res) => {
  const [dests, featured, scholarships, counts] = await Promise.all([
    destinationsList(),
    finder.baseQuery().where('u.is_featured', true).select(finder.COLUMNS).orderByRaw('p.next_deadline IS NULL, p.next_deadline').limit(6),
    knex('scholarships').where({ is_active: true }).orderByRaw('deadline IS NULL, deadline').limit(3),
    Promise.all([knex('programs').where({ is_active: true }).count({ n: '*' }), knex('universities').where({ is_active: true }).count({ n: '*' })]),
  ]);
  res.page('pages/site/home', {
    layout: 'public', dests, featured: featured.map(finder.shape), scholarships, state: await stateOf(req),
    stats: { programs: Number(counts[0][0].n), universities: Number(counts[1][0].n), destinations: dests.length },
    seo: seoOf(req, res, null, { title: res.locals.branding.legal_name, description: req.t('site.hero_lead'), path: '/', jsonld: {
      '@context': 'https://schema.org', '@type': 'EducationalOrganization', name: res.locals.branding.legal_name, url: res.locals.appUrl,
      logo: abs(res, '/brand/logo-horizontal.png'), email: res.locals.company.email || undefined, telephone: res.locals.company.phone || undefined,
    } }),
  });
}));

// ------------------------------------------------------------------ Study Finder
router.get('/programs', ah(async (req, res) => {
  const result = await finder.search(req.query);
  const [dests, unis] = await Promise.all([destinationsList(), knex('universities').where({ is_active: true }).orderBy('name_en').select('id', 'name_en', 'name_ar')]);
  await events.emit('site.search', { req, query: result.filters.q, total: result.total });
  res.page('pages/site/programs', {
    layout: 'public', ...result, dests, unis, state: await stateOf(req), pageScripts: ['/js/catalog.js'],
    seo: { ...seoOf(req, res, null, { title: req.t('finder.title'), description: req.t('finder.lead'), path: '/programs' }), noindex: Object.keys(req.query).some((k) => k !== 'page') },
  });
}));

router.get('/programs/:slug', ah(async (req, res) => {
  const p = await knex('programs as p').join('universities as u', 'u.id', 'p.university_id').leftJoin('destinations as d', 'd.id', 'u.destination_id')
    .where('p.slug', req.params.slug).where('p.is_active', true).where('u.is_active', true)
    .first('p.*', 'u.slug as university_slug', 'u.name_en as university_en', 'u.name_ar as university_ar', 'u.city_en', 'u.city_ar', 'u.logo', 'u.cover_image', 'u.website', 'u.ranking_world', 'u.ranking_national', 'u.ranking_source',
      'd.slug as destination_slug', 'd.name_en as destination_en', 'd.name_ar as destination_ar', 'd.country_code', 'd.currency as dest_currency', 'd.living_month_min', 'd.living_month_max');
  if (!p) throw E.notFound('Program');
  p.intakes = parse(p.intakes);
  p.documents_required = parse(p.documents_required);
  const [scholarships, similar] = await Promise.all([
    knex('scholarships').where({ is_active: true }).where((w) => w.where('program_id', p.id).orWhere('university_id', p.university_id)).limit(4),
    finder.baseQuery().where('p.field', p.field).where('p.degree_level', p.degree_level).whereNot('p.id', p.id).select(finder.COLUMNS).limit(3),
  ]);
  let match = null;
  if (req.user && req.user.kind === 'student') {
    const s = await knex('students').where({ user_id: req.user.id }).first();
    if (s) match = await require('./matching.service').evaluate(require('./matching.service').profileOf(s), { ...p, living_month_min: p.living_month_min, living_month_max: p.living_month_max, dest_currency: p.dest_currency }); // eslint-disable-line global-require
  }
  await events.emit('site.view', { req, type: 'program', id: p.id, title: p.name_en });
  const name = L(req, p, 'name');
  res.page('pages/site/program', {
    layout: 'public', p, scholarships, similar: similar.map(finder.shape), match, state: await stateOf(req), md: markdown, pageScripts: ['/js/catalog.js'],
    seo: seoOf(req, res, p, { title: `${name} — ${L(req, p, 'university')}`, description: L(req, p, 'description') || `${req.t(`ref.degree.${p.degree_level}`)} · ${L(req, p, 'university')}`, path: `/programs/${p.slug}`, image: p.cover_image, jsonld: {
      '@context': 'https://schema.org', '@type': 'Course', name, description: (L(req, p, 'description') || '').slice(0, 500) || undefined,
      provider: { '@type': 'CollegeOrUniversity', name: L(req, p, 'university'), sameAs: p.website || undefined },
      ...(p.tuition_fee ? { offers: { '@type': 'Offer', category: 'Tuition', price: p.tuition_fee, priceCurrency: p.currency } } : {}),
    } }),
  });
}));

// ------------------------------------------------------------------ Universities
router.get('/universities', ah(async (req, res) => {
  const q = knex('universities as u').leftJoin('destinations as d', 'd.id', 'u.destination_id').where('u.is_active', true);
  const term = String(req.query.q || '').trim().slice(0, 80);
  if (term) q.where((w) => w.where('u.name_en', 'like', `%${term.replace(/[%_\\]/g, '')}%`).orWhere('u.name_ar', 'like', `%${term.replace(/[%_\\]/g, '')}%`).orWhere('u.city_en', 'like', `%${term.replace(/[%_\\]/g, '')}%`));
  if (req.query.destination) q.where('d.slug', String(req.query.destination));
  if (['public', 'private', 'community_college', 'pathway', 'language_school'].includes(req.query.type)) q.where('u.institution_type', req.query.type);
  const page = Math.max(1, Number(req.query.page) || 1);
  const [{ n }] = await q.clone().count({ n: '*' });
  const rows = await q.clone().select('u.*', 'd.slug as destination_slug', 'd.name_en as destination_en', 'd.name_ar as destination_ar', 'd.country_code as dest_country',
    knex.raw('(SELECT COUNT(*) FROM programs p WHERE p.university_id = u.id AND p.is_active = 1) AS program_count'))
    .orderBy('u.is_featured', 'desc').orderByRaw('u.ranking_world IS NULL, u.ranking_world').orderBy('u.name_en').limit(18).offset((page - 1) * 18);
  res.page('pages/site/universities', {
    layout: 'public', rows: rows.map((r) => ({ ...r, intakes: parse(r.intakes) })), dests: await destinationsList(), state: await stateOf(req), pageScripts: ['/js/catalog.js'],
    meta: { total: Number(n), page, pages: Math.max(1, Math.ceil(Number(n) / 18)) },
    seo: { ...seoOf(req, res, null, { title: req.t('unis.title'), description: req.t('unis.lead'), path: '/universities' }), noindex: Object.keys(req.query).some((k) => k !== 'page') },
  });
}));

router.get('/universities/:slug', ah(async (req, res) => {
  const u = await knex('universities as u').leftJoin('destinations as d', 'd.id', 'u.destination_id').where('u.slug', req.params.slug).where('u.is_active', true)
    .first('u.*', 'd.slug as destination_slug', 'd.name_en as destination_en', 'd.name_ar as destination_ar', 'd.currency as dest_currency', 'd.living_month_min', 'd.living_month_max');
  if (!u) throw E.notFound('University');
  delete u.commission_note; delete u.internal_notes; // never on the website
  u.intakes = parse(u.intakes);
  u.documents_required = parse(u.documents_required);
  const [programs, scholarships] = await Promise.all([
    finder.baseQuery().where('u.id', u.id).select(finder.COLUMNS).orderBy('p.degree_level').orderBy('p.name_en'),
    knex('scholarships').where({ is_active: true, university_id: u.id }),
  ]);
  await events.emit('site.view', { req, type: 'university', id: u.id, title: u.name_en });
  res.page('pages/site/university', {
    layout: 'public', u, programs: programs.map(finder.shape), scholarships, state: await stateOf(req), md: markdown, pageScripts: ['/js/catalog.js'],
    seo: seoOf(req, res, u, { title: L(req, u, 'name'), description: L(req, u, 'description'), path: `/universities/${u.slug}`, image: u.cover_image, jsonld: {
      '@context': 'https://schema.org', '@type': 'CollegeOrUniversity', name: L(req, u, 'name'), url: u.website || undefined, logo: u.logo || undefined,
      address: { '@type': 'PostalAddress', addressLocality: L(req, u, 'city') || undefined, addressCountry: u.country_code || undefined },
    } }),
  });
}));

// ------------------------------------------------------------------ Scholarships
router.get('/scholarships', ah(async (req, res) => {
  const q = knex('scholarships as s').leftJoin('universities as u', 'u.id', 's.university_id').leftJoin('destinations as d', 'd.id', 's.destination_id').where('s.is_active', true);
  if (req.query.destination) q.where('d.slug', String(req.query.destination));
  if (ref.DEGREES.includes(req.query.degree)) q.where((w) => w.whereRaw('JSON_CONTAINS(s.degree_levels, JSON_QUOTE(?))', [req.query.degree]).orWhereRaw('JSON_LENGTH(COALESCE(s.degree_levels, JSON_ARRAY())) = 0'));
  if (/^[A-Z]{2}$/.test(req.query.nationality || '')) q.where((w) => w.whereRaw('JSON_CONTAINS(s.nationalities, JSON_QUOTE(?))', [req.query.nationality]).orWhereRaw('JSON_LENGTH(COALESCE(s.nationalities, JSON_ARRAY())) = 0'));
  if (req.query.open === '1') q.where((w) => w.whereNull('s.deadline').orWhere('s.deadline', '>=', new Date().toISOString().slice(0, 10)));
  const rows = await q.select('s.*', 'u.name_en as university_en', 'u.name_ar as university_ar', 'u.slug as university_slug', 'd.name_en as destination_en', 'd.name_ar as destination_ar', 'd.slug as destination_slug')
    .orderByRaw('s.deadline IS NULL, s.deadline').limit(60);
  res.page('pages/site/scholarships', {
    layout: 'public', rows: rows.map((r) => ({ ...r, degree_levels: parse(r.degree_levels), eligibility_en: parse(r.eligibility_en), eligibility_ar: parse(r.eligibility_ar) })), dests: await destinationsList(), state: await stateOf(req), pageScripts: ['/js/catalog.js'],
    seo: { ...seoOf(req, res, null, { title: req.t('schol.title'), description: req.t('schol.lead'), path: '/scholarships' }), noindex: Object.keys(req.query).length > 0 },
  });
}));

/** Possible eligibility for a scholarship from what the visitor tells us (never a decision). */
function eligibilityCheck(s, input) {
  const out = [];
  const nats = parse(s.nationalities);
  if (input.nationality) out.push(!nats.length || nats.includes(input.nationality) ? { tone: 'ok', key: 'nat_ok' } : { tone: 'bad', key: 'nat_no' });
  const degs = parse(s.degree_levels);
  if (input.degree) out.push(!degs.length || degs.includes(input.degree) ? { tone: 'ok', key: 'degree_ok' } : { tone: 'bad', key: 'degree_no' });
  if (s.min_gpa_pct && input.gpa !== null) out.push(input.gpa >= Number(s.min_gpa_pct) ? { tone: 'ok', key: 'gpa_ok' } : { tone: 'warn', key: 'gpa_low' });
  if (s.min_ielts && input.ielts !== null) out.push(input.ielts >= Number(s.min_ielts) ? { tone: 'ok', key: 'ielts_ok' } : { tone: 'warn', key: 'ielts_low', vars: { min: s.min_ielts } });
  if (s.deadline && new Date(s.deadline) < new Date()) out.push({ tone: 'bad', key: 'deadline_passed' });
  const verdict = out.some((r) => r.tone === 'bad') ? 'unlikely' : out.some((r) => r.tone === 'warn') ? 'possible' : out.length ? 'likely' : null;
  return { checks: out, verdict };
}

router.get('/scholarships/:slug', ah(async (req, res) => {
  const s = await knex('scholarships as s').leftJoin('universities as u', 'u.id', 's.university_id').leftJoin('destinations as d', 'd.id', 's.destination_id')
    .where('s.slug', req.params.slug).where('s.is_active', true)
    .first('s.*', 'u.name_en as university_en', 'u.name_ar as university_ar', 'u.slug as university_slug', 'd.name_en as destination_en', 'd.name_ar as destination_ar', 'd.slug as destination_slug');
  if (!s) throw E.notFound('Scholarship');
  ['eligibility_en', 'eligibility_ar', 'degree_levels', 'nationalities', 'fields'].forEach((k) => { s[k] = parse(s[k]); });
  let check = null;
  if (req.query.check === '1') {
    const matching = require('./matching.service'); // eslint-disable-line global-require
    check = eligibilityCheck(s, {
      nationality: /^[A-Z]{2}$/.test(req.query.nationality || '') ? req.query.nationality : null,
      degree: ref.DEGREES.includes(req.query.degree) ? req.query.degree : null,
      gpa: req.query.gpa ? matching.gpaPct(Number(req.query.gpa), Number(req.query.gpa_scale) || null) : null,
      ielts: Number(req.query.ielts) > 0 ? Number(req.query.ielts) : null,
    });
  }
  await events.emit('site.view', { req, type: 'scholarship', id: s.id, title: s.name_en });
  res.page('pages/site/scholarship', {
    layout: 'public', s, check, state: await stateOf(req), md: markdown, pageScripts: ['/js/catalog.js'],
    seo: seoOf(req, res, s, { title: L(req, s, 'name'), description: L(req, s, 'description') || L(req, s, 'coverage'), path: `/scholarships/${s.slug}` }),
  });
}));

// ------------------------------------------------------------------ Destinations
router.get('/study', ah(async (req, res) => {
  res.page('pages/site/destinations', { layout: 'public', dests: await destinationsList(), seo: seoOf(req, res, null, { title: req.t('dest.title'), description: req.t('dest.lead'), path: '/study' }) });
}));

router.get('/study/:slug', ah(async (req, res) => {
  const d = await knex('destinations').where({ slug: req.params.slug, is_active: true }).first();
  if (!d) throw E.notFound('Destination');
  ['why_en', 'why_ar', 'regions'].forEach((k) => { d[k] = parse(d[k]); });
  const [programs, unis, scholarships] = await Promise.all([
    finder.baseQuery().where('d.id', d.id).select(finder.COLUMNS).orderBy('u.is_featured', 'desc').limit(6),
    knex('universities').where({ destination_id: d.id, is_active: true }).orderBy('is_featured', 'desc').orderByRaw('ranking_world IS NULL, ranking_world').limit(8),
    knex('scholarships').where({ destination_id: d.id, is_active: true }).limit(3),
  ]);
  await events.emit('site.view', { req, type: 'destination', id: d.id, title: d.name_en });
  res.page('pages/site/destination', {
    layout: 'public', d, programs: programs.map(finder.shape), unis, scholarships, state: await stateOf(req), md: markdown, pageScripts: ['/js/catalog.js'],
    seo: seoOf(req, res, d, { title: req.t('dest.study_in', { name: L(req, d, 'name') }), description: L(req, d, 'tagline'), path: `/study/${d.slug}`, image: d.hero_image }),
  });
}));

// ------------------------------------------------------------------ Shortlist & compare (work with or without JS)
router.post('/shortlist/toggle', limits.api, ah(async (req, res) => {
  const owner = await shortlist.ownerOf(req, { create: true });
  const on = await shortlist.toggle(owner, String(req.body.type), Number(req.body.id), { on: req.body.on === undefined ? undefined : req.body.on === '1' || req.body.on === true });
  if (String(req.get('accept') || '').includes('application/json')) return ok(res, { on, count: (await knex('shortlist_items').where(owner.studentId ? { student_id: owner.studentId } : { visitor_key: owner.visitorKey }).count({ n: '*' }))[0].n });
  return res.redirect(require('../../middleware/errors').safeBack(req, '/shortlist')); // eslint-disable-line global-require
}));

router.get('/shortlist', ah(async (req, res) => {
  const owner = await shortlist.ownerOf(req);
  res.page('pages/site/shortlist', { layout: 'public', items: await shortlist.items(owner), state: await stateOf(req), seo: { title: req.t('shortlist.title'), noindex: true }, pageScripts: ['/js/catalog.js'] });
}));

router.post('/compare/toggle', limits.api, ah(async (req, res) => {
  const exists = await knex('programs').where({ id: Number(req.body.id), is_active: true }).first('id');
  if (!exists) throw E.notFound('Program');
  const list = compare.toggle(req, req.body.id);
  if (String(req.get('accept') || '').includes('application/json')) return ok(res, { ids: list, on: list.includes(Number(req.body.id)) });
  return res.redirect(require('../../middleware/errors').safeBack(req, '/compare')); // eslint-disable-line global-require
}));

router.get('/compare', ah(async (req, res) => {
  const fromQuery = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
  const ids = fromQuery.length ? fromQuery.slice(0, compare.MAX) : compare.current(req);
  res.page('pages/site/compare', { layout: 'public', programs: await compare.build(ids), token: null, state: await stateOf(req), seo: { title: req.t('compare.title'), noindex: true }, pageScripts: ['/js/catalog.js'] });
}));

router.post('/compare/save', limits.publicForm, ah(async (req, res) => {
  const ids = compare.current(req);
  if (!ids.length) return res.redirect('/compare');
  let studentId = null;
  if (req.user && req.user.kind === 'student') { const s = await knex('students').where({ user_id: req.user.id }).first('id'); studentId = s ? s.id : null; }
  const token = await compare.save(ids, { studentId, userId: req.user ? req.user.id : null });
  return res.redirect(`/compare/${token}`);
}));

router.get('/compare/:token', ah(async (req, res) => {
  const c = await compare.byToken(req.params.token);
  if (!c) throw E.notFound();
  res.page('pages/site/compare', { layout: 'public', programs: await compare.build(c.program_ids), token: c.token, state: await stateOf(req), seo: { title: req.t('compare.title'), noindex: true }, pageScripts: ['/js/catalog.js'] });
}));

// ------------------------------------------------------------------ Cost calculator
router.get('/cost-calculator', ah(async (req, res) => {
  const dests = await destinationsList();
  const chosen = [].concat(req.query.d || []).filter((s) => dests.some((d) => d.slug === s)).slice(0, 3);
  const input = { destinations: chosen.length ? chosen : dests.slice(0, 2).map((d) => d.slug), currency: /^[A-Z]{3}$/.test(req.query.currency || '') ? req.query.currency : (res.locals.fmt && 'USD'), housing: req.query.housing || 'shared', scholarship: req.query.scholarship, years: req.query.years || 1 };
  const result = await calculator.calculate(input);
  if (Object.keys(req.query).length) await events.emit('site.calculator', { req, input });
  res.page('pages/site/calculator', { layout: 'public', dests, input, result, currencies: await money.codes(), seo: seoOf(req, res, null, { title: req.t('calc.title'), description: req.t('calc.lead'), path: '/cost-calculator' }) });
}));

router.get('/estimate/:token', ah(async (req, res) => {
  const e = await calculator.byToken(req.params.token);
  if (!e) throw E.notFound();
  res.page('pages/site/estimate', { layout: 'public', e, seo: { title: e.title || req.t('calc.estimate'), noindex: true } });
}));

// ------------------------------------------------------------------ Search
router.get('/search', ah(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  let results = { programs: [], universities: [], scholarships: [], destinations: [] };
  if (q.length >= 2) {
    const like = `%${q.replace(/[%_\\]/g, '')}%`;
    const found = await finder.search({ q });
    const [unis, schol, dests] = await Promise.all([
      knex('universities').where('is_active', true).where((w) => w.where('name_en', 'like', like).orWhere('name_ar', 'like', like).orWhere('city_en', 'like', like).orWhere('city_ar', 'like', like)).limit(8),
      knex('scholarships').where('is_active', true).where((w) => w.where('name_en', 'like', like).orWhere('name_ar', 'like', like).orWhere('provider_en', 'like', like)).limit(6),
      knex('destinations').where('is_active', true).where((w) => w.where('name_en', 'like', like).orWhere('name_ar', 'like', like)).limit(4),
    ]);
    results = { programs: found.rows, programsTotal: found.total, parsed: found.parsed, universities: unis, scholarships: schol, destinations: dests };
    await events.emit('site.search', { req, query: q, total: found.total + unis.length });
  }
  res.page('pages/site/search', { layout: 'public', q, results, state: await stateOf(req), seo: { title: q ? `${q} — ${req.t('site.search')}` : req.t('site.search'), noindex: true }, pageScripts: ['/js/catalog.js'] });
}));

router.get('/api/suggest', limits.api, ah(async (req, res) => ok(res, { items: await finder.suggest(req.query.q, req.locale) })));

module.exports = router;
module.exports.eligibilityCheck = eligibilityCheck;
