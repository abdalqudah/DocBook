// The advisor's tools: read-only questions to GEC's own database. The AI never sees anything else, so every
// program, fee or requirement it mentions comes from here (and demo / unpublished data is labelled as such).
const knex = require('../../db/knex');
const finder = require('../catalog/finder.service');
const matching = require('../catalog/matching.service');
const calculator = require('../catalog/calculator');
const ref = require('../catalog/reference');
const { translator } = require('../../core/i18n');

const tEn = translator('en');
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const programCard = (p) => ({
  id: p.id, url: `/programs/${p.slug}`, name: p.name_en, university: p.university_en, city: p.city_en, country: p.destination_en, degree: p.degree_level, field: p.field,
  duration_months: p.duration_months, tuition_per_year: p.tuition_fee ? `${p.tuition_fee} ${p.currency}` : 'not published', tuition_usd: num(p.tuition_usd),
  min_ielts: num(p.min_ielts), intakes: p.intakes, next_deadline: p.next_deadline || p.deadline_note || 'not published', scholarships_available: !!p.scholarships_available,
  work_after_study: !!p.work_after_study, demo_data: !!p.is_demo,
});

const DEFS = [
  { name: 'search_programs', description: 'Search GEC’s program catalogue. Use this before naming any program. Returns at most 8 programs with their published facts.',
    input_schema: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', description: 'Free text, e.g. "data science" or a university name.' }, destination: { type: 'string', description: 'Destination slug.' },
      degree: { type: 'string', enum: ref.DEGREES }, field: { type: 'string', enum: ref.FIELDS }, max_tuition_usd: { type: 'number', description: 'Maximum yearly tuition in USD.' },
      ielts: { type: 'number', description: 'The student’s IELTS overall score, to keep programs whose minimum is at or below it.' }, intake_month: { type: 'integer', minimum: 1, maximum: 12 },
      scholarship: { type: 'boolean' }, work_after_study: { type: 'boolean' }, sort: { type: 'string', enum: ['relevance', 'tuition_asc', 'ranking', 'deadline'] },
    }, required: [] } },
  { name: 'get_program', description: 'Full published details of one program: requirements, documents, fees, intakes, deadlines.',
    input_schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer' } }, required: ['id'] } },
  { name: 'check_match', description: 'Compare the student’s profile with a program’s published requirements. Uses the signed-in student’s saved profile, or the values given here.',
    input_schema: { type: 'object', additionalProperties: false, properties: { program_id: { type: 'integer' }, ielts: { type: 'number' }, gpa_percent: { type: 'number' }, budget_usd: { type: 'number' } }, required: ['program_id'] } },
  { name: 'search_scholarships', description: 'Search GEC’s scholarship database.',
    input_schema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, destination: { type: 'string' }, degree: { type: 'string', enum: ref.DEGREES } }, required: [] } },
  { name: 'estimate_costs', description: 'Yearly study and living cost estimate for up to three destinations, in a chosen currency (estimates from GEC’s cost profiles).',
    input_schema: { type: 'object', additionalProperties: false, properties: { destinations: { type: 'array', items: { type: 'string' }, maxItems: 3 }, currency: { type: 'string', description: 'ISO code, e.g. USD, GBP, JOD.' }, housing: { type: 'string', enum: ['campus', 'shared', 'private', 'homestay'] } }, required: ['destinations'] } },
  { name: 'application_checklist', description: 'The standard documents GEC asks for at a degree level (each university may ask for more).',
    input_schema: { type: 'object', additionalProperties: false, properties: { degree: { type: 'string', enum: ref.DEGREES } }, required: ['degree'] } },
];

async function definitions() {
  const dests = await knex('destinations').where({ is_active: true }).pluck('slug');
  return DEFS.map((d) => (d.name === 'search_programs'
    ? { ...d, input_schema: { ...d.input_schema, properties: { ...d.input_schema.properties, destination: { type: 'string', enum: dests } } } }
    : d));
}

async function run(name, input, { student = null } = {}) {
  const i = input || {};
  if (name === 'search_programs') {
    const r = await finder.search({ q: i.query || '', destination: i.destination || '', degree: i.degree || '', field: i.field || '', max_tuition: i.max_tuition_usd || '', ielts: i.ielts || '', intake: i.intake_month || '', scholarship: i.scholarship ? '1' : '', work: i.work_after_study ? '1' : '', sort: i.sort || 'relevance' });
    return { total_matching: r.total, programs: r.rows.slice(0, 8).map(programCard), note: r.total > 8 ? `Showing 8 of ${r.total}. Suggest the Study Finder for the full list.` : undefined };
  }
  if (name === 'get_program') {
    const [p] = await finder.programsByIds([Number(i.id)]);
    if (!p) return { error: 'No such program in GEC’s catalogue.' };
    const full = await knex('programs').where({ id: p.id }).first('academic_en', 'documents_required', 'min_gpa_pct', 'min_toefl', 'min_pte', 'application_fee', 'currency', 'program_url', 'internship', 'work_after_study_note', 'study_mode');
    const docs = Array.isArray(full.documents_required) ? full.documents_required : (() => { try { return JSON.parse(full.documents_required || '[]'); } catch { return []; } })();
    return { ...programCard(p), academic_requirements: full.academic_en || 'not published', min_grade_percent: num(full.min_gpa_pct), min_toefl: num(full.min_toefl), min_pte: num(full.min_pte),
      application_fee: full.application_fee === null ? 'not published' : `${full.application_fee} ${full.currency}`, documents_required: docs, study_mode: full.study_mode, internship: full.internship,
      work_after_study_note: full.work_after_study_note || null, official_page: full.program_url || null };
  }
  if (name === 'check_match') {
    const [p] = await knex('programs as p').join('universities as u', 'u.id', 'p.university_id').leftJoin('destinations as d', 'd.id', 'u.destination_id').where('p.id', Number(i.program_id))
      .select([...finder.COLUMNS, 'd.living_month_min', 'd.living_month_max', 'd.currency as dest_currency']);
    if (!p) return { error: 'No such program.' };
    const profile = student ? matching.profileOf(student) : matching.profileOf({ ielts_overall: i.ielts, gpa: i.gpa_percent, gpa_scale: 100, budget_usd: i.budget_usd });
    if (!student) { if (i.ielts) profile.ielts = Number(i.ielts); if (i.budget_usd) profile.budget = Number(i.budget_usd); }
    const m = await matching.evaluate(profile, finder.shape(p));
    return { program: p.name_en, category: m.category, score_percent: m.score, reasons: m.reasons.map((r) => `${r.tone}: ${tEn(`match.r_${r.key}`, r.vars)}`), note: 'Guidance only, based on published requirements — not an admission decision.' };
  }
  if (name === 'search_scholarships') {
    const q = knex('scholarships as s').leftJoin('universities as u', 'u.id', 's.university_id').leftJoin('destinations as d', 'd.id', 's.destination_id').where('s.is_active', true);
    if (i.query) q.where((w) => w.where('s.name_en', 'like', `%${String(i.query).slice(0, 80)}%`).orWhere('s.provider_en', 'like', `%${String(i.query).slice(0, 80)}%`));
    if (i.destination) q.where('d.slug', i.destination);
    if (i.degree) q.whereRaw('JSON_CONTAINS(s.degree_levels, ?)', [JSON.stringify(i.degree)]);
    const rows = await q.limit(8).select('s.slug', 's.name_en', 's.provider_en', 's.amount_type', 's.amount_min', 's.amount_max', 's.currency', 's.coverage_en', 's.deadline', 's.deadline_note', 's.source_url', 's.is_demo', 'u.name_en as university', 'd.name_en as destination');
    return { scholarships: rows.map((s) => ({ name: s.name_en, url: `/scholarships/${s.slug}`, provider: s.provider_en, university: s.university, destination: s.destination, amount: s.amount_type === 'full' ? 'full tuition' : [s.amount_min, s.amount_max].filter(Boolean).join('–') + (s.currency ? ` ${s.currency}` : ''), coverage: s.coverage_en, deadline: s.deadline || s.deadline_note || 'not published', official_source: s.source_url || null, demo_data: !!s.is_demo })) };
  }
  if (name === 'estimate_costs') {
    const r = await calculator.calculate({ destinations: i.destinations || [], currency: i.currency || 'USD', housing: i.housing || 'shared' });
    return { currency: r.currency, per_year: r.rows.map((x) => ({ destination: x.name_en, items: x.items, total: Math.round(x.gross) })), note: 'Estimates from GEC’s cost profiles; real costs vary by city and lifestyle.' };
  }
  if (name === 'application_checklist') {
    const docs = require('../admissions/documents.service').standardSet(i.degree); // eslint-disable-line global-require
    const names = await knex('document_types').whereIn('key', docs).select('key', 'name_en');
    return { degree: i.degree, documents: docs.map((k) => (names.find((n) => n.key === k) || { name_en: k }).name_en), note: 'Universities may ask for more; your counsellor confirms the final list.' };
  }
  return { error: `Unknown tool ${name}` };
}

module.exports = { definitions, run, programCard };
