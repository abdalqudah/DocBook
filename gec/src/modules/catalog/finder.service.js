// Study Finder: program search with filters, facets and server-side pagination. Understands natural queries such as
// "Master's in Data Science UK" or "ماجستير علم البيانات بريطانيا" (degree, field and destination are recognised and
// turned into filters; the rest is matched against program and university names).
const knex = require('../../db/knex');
const ref = require('./reference');
const { dictionaries } = require('../../core/i18n');

const PER_PAGE = 12;
const esc = (s) => String(s).replace(/[%_\\]/g, (m) => `\\${m}`);

const DEGREE_WORDS = {
  bachelor: ['bachelor', 'bachelors', "bachelor's", 'bsc', 'ba', 'beng', 'undergraduate', 'بكالوريوس', 'البكالوريوس'],
  master: ['master', 'masters', "master's", 'msc', 'ma', 'mba', 'meng', 'postgraduate', 'ماجستير', 'الماجستير'],
  phd: ['phd', 'doctorate', 'doctoral', 'دكتوراه', 'الدكتوراه'],
  diploma: ['diploma', 'دبلوم'],
  foundation: ['foundation', 'تأسيسية', 'تحضيرية'],
  language: ['english course', 'language', 'لغة', 'انجليزي', 'إنجليزي'],
};
const STOP = new Set(['in', 'at', 'of', 'the', 'a', 'an', 'to', 'for', 'study', 'studying', 'degree', 'program', 'programme', 'course', 'في', 'دراسة', 'برنامج', 'تخصص', 'من', 'إلى']);

/** Pulls degree / field / destination out of a free-text query. */
async function parseQuery(q) {
  let text = ` ${String(q || '').toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ')} `;
  const found = {};
  for (const [deg, words] of Object.entries(DEGREE_WORDS)) {
    for (const w of words) {
      if (text.includes(` ${w} `)) { found.degree = found.degree || deg; text = text.replace(` ${w} `, ' '); }
    }
  }
  const dests = await knex('destinations').where({ is_active: true }).select('slug', 'name_en', 'name_ar', 'country_code');
  const aliases = { uk: ['uk', 'britain', 'england', 'united kingdom', 'بريطانيا', 'المملكة المتحدة'], usa: ['usa', 'us', 'america', 'united states', 'أمريكا', 'امريكا', 'الولايات المتحدة'] };
  for (const d of dests) {
    const names = [d.slug, d.name_en, d.name_ar, ...(aliases[d.slug] || [])].filter(Boolean).map((n) => n.toLowerCase());
    for (const n of names.sort((a, b) => b.length - a.length)) {
      if (text.includes(` ${n} `)) { found.destination = found.destination || d.slug; text = text.replace(` ${n} `, ' '); break; }
    }
  }
  // fields: longest label first, both languages
  const labels = [];
  for (const lang of Object.keys(dictionaries)) {
    const map = (dictionaries[lang].ref || {}).field || {};
    Object.entries(map).forEach(([k, label]) => { if (k !== 'other') labels.push([k, label.toLowerCase()]); if (label.includes(' & ')) labels.push([k, label.toLowerCase().split(' & ')[0]]); });
  }
  labels.sort((a, b) => b[1].length - a[1].length);
  for (const [k, label] of labels) {
    if (text.includes(` ${label} `)) { found.field = k; text = text.replace(` ${label} `, ' '); break; }
  }
  const rest = text.split(/\s+/).filter((w) => w && !STOP.has(w)).join(' ').trim();
  return { ...found, text: rest };
}

/** Normalised filters from a query string (unknown values are ignored, never trusted). */
function cleanFilters(p) {
  const out = {};
  const pickList = (v, allowed) => [].concat(v || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter((x) => x && (!allowed || allowed.includes(x)));
  out.q = String(p.q || '').slice(0, 120).trim();
  out.degree = pickList(p.degree, ref.DEGREES);
  out.field = pickList(p.field, ref.FIELDS);
  out.destination = pickList(p.destination).filter((x) => /^[a-z0-9-]{2,60}$/.test(x));
  out.university = /^\d+$/.test(p.university || '') ? Number(p.university) : null;
  out.city = String(p.city || '').slice(0, 80).trim();
  out.mode = pickList(p.mode, ref.STUDY_MODES);
  out.intake = pickList(p.intake).map(Number).filter((m) => m >= 1 && m <= 12);
  out.duration = ['short', 'mid', 'long'].includes(p.duration) ? p.duration : '';
  out.max_tuition = Number(p.max_tuition) > 0 ? Math.min(Number(p.max_tuition), 1e6) : null;
  out.max_app_fee = p.max_app_fee === '0' ? 0 : (Number(p.max_app_fee) > 0 ? Number(p.max_app_fee) : null);
  out.ielts = Number(p.ielts) > 0 && Number(p.ielts) <= 9 ? Number(p.ielts) : null;
  out.toefl = Number(p.toefl) > 0 && Number(p.toefl) <= 120 ? Number(p.toefl) : null;
  out.pte = Number(p.pte) > 0 && Number(p.pte) <= 90 ? Number(p.pte) : null;
  out.scholarship = p.scholarship === '1';
  out.internship = p.internship === '1';
  out.work = p.work === '1';
  out.sort = ['relevance', 'tuition_asc', 'tuition_desc', 'ranking', 'deadline'].includes(p.sort) ? p.sort : 'relevance';
  out.page = Math.max(1, Math.min(500, Number(p.page) || 1));
  return out;
}

function baseQuery() {
  return knex('programs as p').join('universities as u', 'u.id', 'p.university_id').leftJoin('destinations as d', 'd.id', 'u.destination_id')
    .where('p.is_active', true).where('u.is_active', true);
}

function applyFilters(q, f, parsed) {
  const degree = f.degree.length ? f.degree : (parsed.degree ? [parsed.degree] : []);
  const field = f.field.length ? f.field : (parsed.field ? [parsed.field] : []);
  const dest = f.destination.length ? f.destination : (parsed.destination ? [parsed.destination] : []);
  if (degree.length) q.whereIn('p.degree_level', degree);
  if (field.length) q.whereIn('p.field', field);
  if (dest.length) q.whereIn('d.slug', dest);
  if (f.university) q.where('u.id', f.university);
  if (f.city) q.where((w) => w.where('u.city_en', 'like', `%${esc(f.city)}%`).orWhere('u.city_ar', 'like', `%${esc(f.city)}%`));
  if (f.mode.length) q.whereIn('p.study_mode', f.mode);
  if (f.intake.length) q.where((w) => f.intake.forEach((m) => w.orWhereRaw('JSON_CONTAINS(p.intakes, ?)', [String(m)])));
  if (f.duration === 'short') q.where('p.duration_months', '<=', 12);
  if (f.duration === 'mid') q.whereBetween('p.duration_months', [13, 24]);
  if (f.duration === 'long') q.where('p.duration_months', '>', 24);
  if (f.max_tuition) q.where((w) => w.where('p.tuition_usd', '<=', f.max_tuition).orWhereNull('p.tuition_usd'));
  if (f.max_app_fee !== null) q.where((w) => w.where('p.application_fee', '<=', f.max_app_fee).orWhereNull('p.application_fee'));
  // "I have IELTS 6.5": programs whose minimum is at most my score (or that don't publish one)
  if (f.ielts) q.where((w) => w.where('p.min_ielts', '<=', f.ielts).orWhereNull('p.min_ielts'));
  if (f.toefl) q.where((w) => w.where('p.min_toefl', '<=', f.toefl).orWhereNull('p.min_toefl'));
  if (f.pte) q.where((w) => w.where('p.min_pte', '<=', f.pte).orWhereNull('p.min_pte'));
  if (f.scholarship) q.where('p.scholarships_available', true);
  if (f.internship) q.whereIn('p.internship', ['optional', 'included', 'coop']);
  if (f.work) q.where('p.work_after_study', true);
  const text = parsed.text;
  if (text) {
    const words = text.split(' ').filter((w) => w.length > 1).slice(0, 6);
    words.forEach((w) => {
      const term = `%${esc(w)}%`;
      q.where((x) => x.where('p.name_en', 'like', term).orWhere('p.name_ar', 'like', term).orWhere('u.name_en', 'like', term).orWhere('u.name_ar', 'like', term)
        .orWhere('p.faculty', 'like', term).orWhere('u.city_en', 'like', term).orWhere('u.city_ar', 'like', term));
    });
  }
  return { degree, field, dest };
}

const COLUMNS = ['p.id', 'p.slug', 'p.name_en', 'p.name_ar', 'p.degree_level', 'p.field', 'p.duration_months', 'p.currency', 'p.tuition_fee', 'p.tuition_usd', 'p.application_fee',
  'p.intakes', 'p.next_deadline', 'p.min_ielts', 'p.min_ielts_band', 'p.min_toefl', 'p.min_pte', 'p.min_duolingo', 'p.min_gpa_pct', 'p.scholarships_available', 'p.internship', 'p.study_mode',
  'p.work_after_study', 'p.is_demo', 'u.id as university_id', 'u.slug as university_slug', 'u.name_en as university_en', 'u.name_ar as university_ar', 'u.city_en', 'u.city_ar', 'u.logo',
  'u.ranking_world', 'u.ranking_national', 'd.slug as destination_slug', 'd.name_en as destination_en', 'd.name_ar as destination_ar', 'd.country_code'];

const parseJson = (v) => { if (Array.isArray(v)) return v; if (!v) return []; try { return JSON.parse(v); } catch { return []; } };
const shape = (r) => ({ ...r, intakes: parseJson(r.intakes) });

async function search(params) {
  const f = cleanFilters(params);
  const parsed = f.q ? await parseQuery(f.q) : { text: '' };
  const q = baseQuery();
  const applied = applyFilters(q, f, parsed);
  const [{ n }] = await q.clone().count({ n: '*' });
  const sorted = q.clone().select(COLUMNS);
  if (f.sort === 'tuition_asc') sorted.orderByRaw('p.tuition_usd IS NULL, p.tuition_usd ASC');
  else if (f.sort === 'tuition_desc') sorted.orderBy('p.tuition_usd', 'desc');
  else if (f.sort === 'ranking') sorted.orderByRaw('u.ranking_world IS NULL, u.ranking_world ASC');
  else if (f.sort === 'deadline') sorted.orderByRaw('p.next_deadline IS NULL, p.next_deadline ASC');
  else sorted.orderBy('u.is_featured', 'desc').orderByRaw('u.ranking_world IS NULL, u.ranking_world ASC');
  const rows = await sorted.orderBy('p.id').limit(PER_PAGE).offset((f.page - 1) * PER_PAGE);
  // facets: counts per degree and destination for the current search without that facet
  const facetBase = (skip) => { const fq = baseQuery(); applyFilters(fq, { ...f, [skip]: [] }, { ...parsed, [skip === 'destination' ? 'destination' : skip]: undefined }); return fq; };
  const [byDegree, byDest] = await Promise.all([
    facetBase('degree').select('p.degree_level as k').count({ n: '*' }).groupBy('p.degree_level'),
    facetBase('destination').select('d.slug as k').count({ n: '*' }).groupBy('d.slug'),
  ]);
  return {
    rows: rows.map(shape), filters: f, parsed, applied, total: Number(n),
    meta: { total: Number(n), page: f.page, pages: Math.max(1, Math.ceil(Number(n) / PER_PAGE)) },
    facets: { degree: Object.fromEntries(byDegree.map((r) => [r.k, Number(r.n)])), destination: Object.fromEntries(byDest.map((r) => [r.k, Number(r.n)])) },
  };
}

async function programsByIds(ids) {
  if (!ids.length) return [];
  const rows = await baseQuery().whereIn('p.id', ids).select([...COLUMNS, 'p.academic_en', 'p.academic_ar', 'p.documents_required', 'p.work_after_study_note', 'u.currency as uni_currency', 'd.cost_profile', 'd.currency as dest_currency', 'd.living_month_min', 'd.living_month_max']);
  const order = new Map(ids.map((id, i) => [Number(id), i]));
  return rows.map(shape).sort((a, b) => order.get(a.id) - order.get(b.id));
}

/** Autocomplete for the big search box: programs, universities, destinations, fields. */
async function suggest(q, locale = 'en') {
  const term = String(q || '').trim().slice(0, 80);
  if (term.length < 2) return [];
  const like = `%${esc(term)}%`;
  const [programs, unis, dests] = await Promise.all([
    baseQuery().where((w) => w.where('p.name_en', 'like', like).orWhere('p.name_ar', 'like', like)).select('p.slug', 'p.name_en', 'p.name_ar', 'u.name_en as uni_en', 'u.name_ar as uni_ar').limit(5),
    knex('universities').where('is_active', true).where((w) => w.where('name_en', 'like', like).orWhere('name_ar', 'like', like).orWhere('city_en', 'like', like)).select('slug', 'name_en', 'name_ar', 'city_en', 'city_ar').limit(4),
    knex('destinations').where('is_active', true).where((w) => w.where('name_en', 'like', like).orWhere('name_ar', 'like', like).orWhere('slug', 'like', like)).select('slug', 'name_en', 'name_ar').limit(3),
  ]);
  const L = (r, f) => (locale === 'ar' ? r[`${f}_ar`] || r[`${f}_en`] : r[`${f}_en`] || r[`${f}_ar`]);
  const fields = [];
  const map = (dictionaries[locale].ref || {}).field || {};
  Object.entries(map).forEach(([k, label]) => { if (label.toLowerCase().includes(term.toLowerCase()) && fields.length < 3) fields.push({ type: 'field', title: label, href: `/programs?field=${k}`, icon: 'book-open' }); });
  return [
    ...fields,
    ...dests.map((d) => ({ type: 'destination', title: L(d, 'name'), href: `/study/${d.slug}`, icon: 'globe' })),
    ...programs.map((p) => ({ type: 'program', title: L(p, 'name'), sub: L(p, 'uni'), href: `/programs/${p.slug}`, icon: 'graduation-cap' })),
    ...unis.map((u) => ({ type: 'university', title: L(u, 'name'), sub: L(u, 'city'), href: `/universities/${u.slug}`, icon: 'building-2' })),
  ];
}

module.exports = { search, suggest, parseQuery, cleanFilters, programsByIds, baseQuery, COLUMNS, shape, parseJson, PER_PAGE };
