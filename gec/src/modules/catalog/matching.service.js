// Program matching: compares a student's profile with each program's published requirements and returns a score,
// a category and the reasons — never an admission prediction. Where the catalogue has no figure for a requirement,
// the reason says so ("verify with the university") instead of assuming the student meets it.
//
// Categories: excellent (≥ 85), good (≥ 70), possible (below), missing (we lack the student's grades / English to judge),
// not_eligible (a published minimum is clearly not met).
const knex = require('../../db/knex');
const finder = require('./finder.service');
const money = require('./money');

const WEIGHTS = { academic: 30, english: 25, budget: 20, intake: 10, preference: 10, work: 5 };

/** Grade as a percentage: 3.2 / 4 → 80; 85 / 100 → 85. */
function gpaPct(gpa, scale) {
  if (gpa === null || gpa === undefined || gpa === '') return null;
  const g = Number(gpa);
  const s = Number(scale) || (g <= 4.3 ? 4 : g <= 5 ? 5 : g <= 10 ? 10 : 100);
  return Math.max(0, Math.min(100, (g / s) * 100));
}

/** The student's matching profile from a students row (or a quick profile from the public advisor form). */
function profileOf(s) {
  const arr = (v) => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v || '[]'); } catch { return []; } })());
  return {
    gpa: gpaPct(s.gpa, s.gpa_scale),
    ielts: s.ielts_overall !== null && s.ielts_overall !== undefined && s.ielts_overall !== '' ? Number(s.ielts_overall) : null,
    ieltsBand: s.ielts_min_band ? Number(s.ielts_min_band) : null,
    toefl: s.toefl ? Number(s.toefl) : null, pte: s.pte ? Number(s.pte) : null, duolingo: s.duolingo ? Number(s.duolingo) : null,
    budget: s.budget_usd ? Number(s.budget_usd) : null,
    degree: s.pref_degree || null, fields: arr(s.pref_fields), countries: arr(s.pref_countries),
    intake: /^\d{4}-\d{2}$/.test(s.pref_intake || '') ? Number(s.pref_intake.slice(5)) : null,
    wantsWork: Boolean(s.work_after_study), nationality: s.nationality || null,
    missingDocs: s.missing_documents ?? null,
  };
}

/** Yearly living cost estimate in USD for the program's destination (middle of the published range). */
async function livingUsd(p) {
  if (!p.living_month_min && !p.living_month_max) return null;
  const month = ((Number(p.living_month_min) || Number(p.living_month_max)) + (Number(p.living_month_max) || Number(p.living_month_min))) / 2;
  return money.toUsd(month * 12, p.dest_currency || 'USD');
}

async function evaluate(profile, p) {
  const reasons = [];
  let score = 0;
  let max = 0;
  let notEligible = false;
  let missingData = false;
  const add = (tone, key, vars = {}) => reasons.push({ tone, key, vars });

  // Academic
  max += WEIGHTS.academic;
  if (p.min_gpa_pct === null || p.min_gpa_pct === undefined) { add('info', 'gpa_unpublished'); score += WEIGHTS.academic * 0.6; }
  else if (profile.gpa === null) { add('warn', 'gpa_missing'); missingData = true; }
  else if (profile.gpa >= Number(p.min_gpa_pct)) { add('ok', 'gpa_meets'); score += WEIGHTS.academic; }
  else if (profile.gpa >= Number(p.min_gpa_pct) - 5) { add('warn', 'gpa_close'); score += WEIGHTS.academic * 0.4; }
  else { add('bad', 'gpa_below'); notEligible = true; }

  // English: any accepted test meeting its published minimum
  max += WEIGHTS.english;
  const tests = [['ielts', p.min_ielts], ['toefl', p.min_toefl], ['pte', p.min_pte], ['duolingo', p.min_duolingo]].filter(([, m]) => m !== null && m !== undefined);
  const hasAny = [profile.ielts, profile.toefl, profile.pte, profile.duolingo].some((v) => v !== null);
  if (!tests.length) { add('info', 'english_unpublished'); score += WEIGHTS.english * 0.6; }
  else if (!hasAny) { add('warn', 'english_missing', { test: 'IELTS', min: p.min_ielts ?? '—' }); missingData = true; }
  else {
    const met = tests.find(([k, m]) => profile[k] !== null && profile[k] >= Number(m));
    const bandOk = !(met && met[0] === 'ielts' && p.min_ielts_band && profile.ieltsBand !== null && profile.ieltsBand < Number(p.min_ielts_band));
    if (met && bandOk) { add('ok', 'english_meets', { test: met[0].toUpperCase(), score: profile[met[0]], min: met[1] }); score += WEIGHTS.english; }
    else if (met && !bandOk) { add('warn', 'english_band', { band: p.min_ielts_band }); score += WEIGHTS.english * 0.5; }
    else {
      const close = tests.find(([k, m]) => profile[k] !== null && ((k === 'ielts' && profile[k] >= Number(m) - 0.5) || (k !== 'ielts' && profile[k] >= Number(m) * 0.92)));
      if (close) { add('warn', 'english_close', { test: close[0].toUpperCase(), min: close[1] }); score += WEIGHTS.english * 0.3; }
      else { add('bad', 'english_below', { test: tests[0][0].toUpperCase(), min: tests[0][1] }); notEligible = true; }
    }
  }

  // Budget: tuition + living estimate vs yearly budget
  max += WEIGHTS.budget;
  const living = await livingUsd(p);
  const cost = p.tuition_usd !== null && p.tuition_usd !== undefined ? Number(p.tuition_usd) + (living || 0) : null;
  if (profile.budget === null) { add('info', 'budget_missing'); score += WEIGHTS.budget * 0.5; }
  else if (cost === null) { add('info', 'tuition_unpublished'); score += WEIGHTS.budget * 0.5; }
  else if (cost <= profile.budget) { add('ok', 'budget_within', { cost: Math.round(cost) }); score += WEIGHTS.budget; }
  else if (cost <= profile.budget * 1.15) { add('warn', 'budget_slightly_over', { cost: Math.round(cost) }); score += WEIGHTS.budget * 0.5; }
  else { add('warn', 'budget_over', { cost: Math.round(cost) }); }

  // Intake
  max += WEIGHTS.intake;
  const intakes = p.intakes || [];
  if (!profile.intake) score += WEIGHTS.intake * 0.5;
  else if (!intakes.length) { add('info', 'intake_unpublished'); score += WEIGHTS.intake * 0.5; }
  else if (intakes.map(Number).includes(profile.intake)) { add('ok', 'intake_available', { month: profile.intake }); score += WEIGHTS.intake; }
  else add('warn', 'intake_other', { months: intakes.join(',') });

  // Preferences (destination + field)
  max += WEIGHTS.preference;
  let pref = 0;
  if (!profile.countries.length || profile.countries.includes(p.destination_slug)) pref += 0.5;
  if (!profile.fields.length || profile.fields.includes(p.field)) pref += 0.5;
  score += WEIGHTS.preference * pref;
  if (profile.countries.length && !profile.countries.includes(p.destination_slug)) add('info', 'other_destination');

  // Work after study
  max += WEIGHTS.work;
  if (!profile.wantsWork) score += WEIGHTS.work;
  else if (p.work_after_study) { add('ok', 'work_available'); score += WEIGHTS.work; }
  else add('info', 'work_unknown');

  if (profile.missingDocs) add('warn', 'documents_missing', { n: profile.missingDocs });
  if (p.scholarships_available) add('ok', 'scholarships');

  const pct = Math.round((score / max) * 100);
  const category = notEligible ? 'not_eligible' : missingData ? 'missing' : pct >= 85 ? 'excellent' : pct >= 70 ? 'good' : 'possible';
  return { score: notEligible ? Math.min(pct, 40) : pct, category, reasons, costUsd: cost, livingUsd: living };
}

/**
 * Best programs for a profile. Candidates are pre-filtered in SQL (degree, preferred fields/destinations when given),
 * then evaluated; at most `limit` results, best first. `includeOthers` widens to other destinations when few match.
 */
async function recommend(profile, { limit = 20, includeNotEligible = false } = {}) {
  const q = finder.baseQuery();
  if (profile.degree) q.where('p.degree_level', profile.degree);
  if (profile.fields.length) q.whereIn('p.field', profile.fields);
  let candidates = await q.clone().modify((x) => { if (profile.countries.length) x.whereIn('d.slug', profile.countries); })
    .select([...finder.COLUMNS, 'd.living_month_min', 'd.living_month_max', 'd.currency as dest_currency']).limit(400);
  if (candidates.length < 5 && profile.countries.length) {
    candidates = await q.clone().select([...finder.COLUMNS, 'd.living_month_min', 'd.living_month_max', 'd.currency as dest_currency']).limit(400);
  }
  const out = [];
  for (const raw of candidates) {
    const p = finder.shape(raw);
    const m = await evaluate(profile, p); // eslint-disable-line no-await-in-loop
    if (m.category === 'not_eligible' && !includeNotEligible) continue; // eslint-disable-line no-continue
    out.push({ program: p, match: m });
  }
  const rank = { excellent: 0, good: 1, possible: 2, missing: 3, not_eligible: 4 };
  out.sort((a, b) => rank[a.match.category] - rank[b.match.category] || b.match.score - a.match.score);
  return out.slice(0, limit);
}

/** Matches for a stored student (counts their missing documents when the documents module exists). */
async function forStudent(studentId, opts = {}) {
  const s = await knex('students').where({ id: studentId }).first();
  if (!s) return [];
  let missingDocs = null;
  if (await knex.schema.hasTable('documents')) {
    const [{ n }] = await knex('documents').where({ student_id: studentId }).whereIn('status', ['missing', 'rejected', 'expired']).count({ n: '*' });
    missingDocs = Number(n) || null;
  }
  return recommend({ ...profileOf(s), missingDocs }, opts);
}

module.exports = { evaluate, recommend, forStudent, profileOf, gpaPct, WEIGHTS };
