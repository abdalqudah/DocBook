// Reporting: traffic (consenting visitors only), the conversion funnel for leads created in a period, source
// attribution (first touch and latest touch), campaigns, landing pages, programs viewed and team performance.
// Everything honours the employee's data scope through the leads they can see.
const knex = require('../../db/knex');
const { scope } = require('../rbac/rbac.service');
const settings = require('../settings/settings.service');

const range = (from, to) => [new Date(`${from}T00:00:00Z`), new Date(`${to}T23:59:59Z`)];
const leadsIn = (staff, from, to) => scope(knex('leads as l').whereNot('l.status', 'merged').whereBetween('l.created_at', range(from, to)), staff, { owner: 'l.counsellor_id', branch: 'l.branch_id' });
const num = (rows, k = 'n') => Number((rows[0] || {})[k] || 0);

/** Students (from the cohort) whose applications reached any of the stage keys. */
async function reachedStage(cohort, keys) {
  return num(await knex('applications as a').join('application_stage_history as h', 'h.application_id', 'a.id').join('application_stages as s', 's.id', 'h.to_stage_id')
    .whereIn('s.key', keys).whereIn('a.student_id', cohort.clone().clearSelect().whereNotNull('l.student_id').select('l.student_id')).countDistinct({ n: 'a.student_id' }));
}

async function overview(staff, { from, to }) {
  const [a, b] = range(from, to);
  const cohort = leadsIn(staff, from, to);
  const visitors = num(await knex('visitors').whereBetween('first_seen_at', [a, b]).count({ n: '*' }));
  const pageviews = num(await knex('tracking_events').where('name', 'pageview').whereBetween('created_at', [a, b]).count({ n: '*' }));
  const leads = num(await cohort.clone().count({ n: '*' }));
  const contacted = num(await cohort.clone().whereNotNull('l.first_contacted_at').count({ n: '*' }));
  const booked = num(await knex('appointments').whereIn('lead_id', cohort.clone().select('l.id')).whereNot('status', 'cancelled').countDistinct({ n: 'lead_id' }));
  const students = num(await cohort.clone().whereNotNull('l.student_id').count({ n: '*' }));
  const submitted = await reachedStage(cohort, ['submitted']);
  const offers = await reachedStage(cohort, ['conditional_offer', 'unconditional_offer']);
  const visa = await reachedStage(cohort, ['visa_approved']);
  const enrolled = await reachedStage(cohort, ['enrolled']);
  const fromVisitors = num(await cohort.clone().whereIn('l.visitor_id', knex('visitors').whereBetween('first_seen_at', [a, b]).select('id')).count({ n: '*' }));
  return {
    visitors, pageviews, leads, conversion: visitors ? fromVisitors / visitors : null,
    funnel: [['leads', leads], ['contacted', contacted], ['consultation_booked', booked], ['became_student', students], ['application_submitted', submitted], ['offer', offers], ['visa_approved', visa], ['enrolled', enrolled]],
  };
}

async function sources(staff, { from, to }, touch = 'first') {
  const col = touch === 'latest' ? knex.raw('COALESCE(l.latest_source, l.source)') : 'l.source';
  return leadsIn(staff, from, to).select({ source: col }).count({ leads: '*' })
    .sum({ students: knex.raw('CASE WHEN l.student_id IS NOT NULL THEN 1 ELSE 0 END') })
    .sum({ hot: knex.raw("CASE WHEN l.temperature = 'hot' THEN 1 ELSE 0 END") })
    .groupBy(col).orderBy('leads', 'desc');
}

async function campaigns(staff, { from, to }) {
  return leadsIn(staff, from, to).whereNotNull('l.utm_campaign').select('l.utm_source', 'l.utm_medium', 'l.utm_campaign').count({ leads: '*' })
    .sum({ students: knex.raw('CASE WHEN l.student_id IS NOT NULL THEN 1 ELSE 0 END') }).groupBy('l.utm_source', 'l.utm_medium', 'l.utm_campaign').orderBy('leads', 'desc').limit(20);
}

async function landingPages(staff, { from, to }) {
  const path = knex.raw("SUBSTRING_INDEX(l.landing_page, '?', 1)");
  return leadsIn(staff, from, to).whereNotNull('l.landing_page').select({ page: path }).count({ leads: '*' }).groupBy(path).orderBy('leads', 'desc').limit(10);
}

async function programsViewed({ from, to }) {
  return knex('tracking_events as e').join('programs as p', 'p.id', 'e.ref_id').where('e.name', 'program_view').whereBetween('e.created_at', range(from, to))
    .select('p.id', 'p.name_en', 'p.name_ar', 'p.slug').count({ views: '*' }).countDistinct({ visitors: 'e.visitor_id' }).groupBy('p.id', 'p.name_en', 'p.name_ar', 'p.slug').orderBy('views', 'desc').limit(10);
}

async function daily(staff, { from, to }) {
  const rows = await leadsIn(staff, from, to).select({ d: knex.raw('DATE(l.created_at)') }).count({ n: '*' }).groupByRaw('DATE(l.created_at)');
  const map = Object.fromEntries(rows.map((r) => [new Date(r.d).toISOString().slice(0, 10), Number(r.n)]));
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`) && out.length < 400; d = new Date(d.getTime() + 86400_000)) {
    const k = d.toISOString().slice(0, 10); out.push({ day: k, n: map[k] || 0 });
  }
  return out;
}

/** Per counsellor: leads received, contacted within the first-response target, converted, applications, enrolled. */
async function team(staff, { from, to }) {
  const hours = ((await settings.get('leads')) || {}).first_response_hours || 24;
  const rows = await leadsIn(staff, from, to).leftJoin('employees as e', 'e.id', 'l.counsellor_id').leftJoin('users as u', 'u.id', 'e.user_id')
    .select('l.counsellor_id', 'u.name').count({ leads: '*' })
    .sum({ in_time: knex.raw('CASE WHEN l.first_contacted_at IS NOT NULL AND TIMESTAMPDIFF(MINUTE, l.created_at, l.first_contacted_at) <= ? THEN 1 ELSE 0 END', [hours * 60]) })
    .sum({ contacted: knex.raw('CASE WHEN l.first_contacted_at IS NOT NULL THEN 1 ELSE 0 END') })
    .avg({ response_min: knex.raw('TIMESTAMPDIFF(MINUTE, l.created_at, l.first_contacted_at)') })
    .sum({ students: knex.raw('CASE WHEN l.student_id IS NOT NULL THEN 1 ELSE 0 END') })
    .groupBy('l.counsellor_id', 'u.name').orderBy('leads', 'desc');
  const [a, b] = range(from, to);
  const apps = await knex('applications').whereBetween('created_at', [a, b]).select('counsellor_id').count({ n: '*' }).groupBy('counsellor_id');
  const enrolled = await knex('applications as ap').join('application_stages as s', 's.id', 'ap.stage_id').where('s.key', 'enrolled').whereBetween('ap.updated_at', [a, b]).select('ap.counsellor_id').count({ n: '*' }).groupBy('ap.counsellor_id');
  const by = (list, id) => Number((list.find((x) => x.counsellor_id === id) || {}).n || 0);
  return { hours, rows: rows.map((r) => ({ ...r, leads: Number(r.leads), in_time: Number(r.in_time), contacted: Number(r.contacted), students: Number(r.students), response_min: r.response_min === null ? null : Math.round(Number(r.response_min)), applications: by(apps, r.counsellor_id), enrolled: by(enrolled, r.counsellor_id) })) };
}

module.exports = { overview, sources, campaigns, landingPages, programsViewed, daily, team };
