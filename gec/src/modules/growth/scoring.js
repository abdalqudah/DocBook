// Lead scoring: transparent, editable rules (Settings → Lead scoring). Every rule is a fact about the lead —
// what they told us, what they did on the website (only with consent) and how they engaged with the team.
// The score is 0–100; thresholds turn it into Cold / Warm / Hot. Each lead stores the reasons, so counsellors
// see *why*. A counsellor can fix the temperature by hand; the score keeps updating underneath.
const knex = require('../../db/knex');
const events = require('../../core/events');
const settings = require('../settings/settings.service');
const jobs = require('../jobs');

const parse = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v || '[]'); } catch { return []; } };
const monthsUntil = (ym) => { if (!/^\d{4}-\d{2}$/.test(ym || '')) return null; const [y, m] = ym.split('-').map(Number); const now = new Date(); return (y - now.getUTCFullYear()) * 12 + (m - 1 - now.getUTCMonth()); };

// key → { group, points (default), test(facts) }
const RULES = {
  has_email: { group: 'profile', points: 5, test: (f) => !!f.lead.email },
  has_phone: { group: 'profile', points: 5, test: (f) => !!(f.lead.phone || f.lead.whatsapp) },
  degree_known: { group: 'profile', points: 5, test: (f) => !!f.lead.interest_degree },
  destination_known: { group: 'profile', points: 5, test: (f) => parse(f.lead.interest_countries).length > 0 },
  budget_known: { group: 'profile', points: 10, test: (f) => !!f.lead.budget_range },
  intake_6_months: { group: 'profile', points: 15, test: (f) => { const m = monthsUntil(f.lead.interest_intake); return m !== null && m >= 0 && m <= 6; } },
  intake_12_months: { group: 'profile', points: 8, test: (f) => { const m = monthsUntil(f.lead.interest_intake); return m !== null && m > 6 && m <= 12; } },
  education_known: { group: 'profile', points: 5, test: (f) => !!f.lead.education_level },
  marketing_consent: { group: 'profile', points: 3, test: (f) => !!f.lead.consent_marketing },
  source_referral: { group: 'source', points: 10, test: (f) => f.lead.source === 'referral' },
  source_consultation: { group: 'source', points: 10, test: (f) => ['consultation', 'walk_in', 'phone'].includes(f.lead.source) },
  booked_consultation: { group: 'engagement', points: 20, test: (f) => f.appointments > 0 },
  attended_consultation: { group: 'engagement', points: 15, test: (f) => f.attended > 0 },
  event_registered: { group: 'engagement', points: 8, test: (f) => f.eventRegs > 0 },
  event_attended: { group: 'engagement', points: 10, test: (f) => f.eventAttended > 0 },
  replied: { group: 'engagement', points: 10, test: (f) => f.inbound > 0 },
  repeat_enquiry: { group: 'engagement', points: 8, test: (f) => f.enquiries > 1 },
  pages_5: { group: 'website', points: 5, test: (f) => f.pageviews >= 5 },
  pages_15: { group: 'website', points: 5, test: (f) => f.pageviews >= 15 },
  programs_viewed_3: { group: 'website', points: 8, test: (f) => f.programViews >= 3 },
  used_calculator: { group: 'website', points: 8, test: (f) => f.calculator > 0 },
  shortlisted: { group: 'website', points: 8, test: (f) => f.shortlist > 0 },
  inactive_30_days: { group: 'decay', points: -15, test: (f) => f.daysInactive >= 30 },
  no_show: { group: 'decay', points: -10, test: (f) => f.noShows > 0 },
};
const DEFAULTS = { warm: 30, hot: 60, rules: Object.fromEntries(Object.entries(RULES).map(([k, r]) => [k, { points: r.points, enabled: true }])) };

async function config() {
  const s = (await settings.get('scoring')) || {};
  const rules = {};
  for (const [k, r] of Object.entries(RULES)) rules[k] = { points: r.points, enabled: true, ...((s.rules || {})[k] || {}) };
  return { warm: Number(s.warm || DEFAULTS.warm), hot: Number(s.hot || DEFAULTS.hot), rules };
}

const n = async (q) => Number((await q.count({ n: '*' }))[0].n);
async function facts(lead) {
  const who = (q, col = 'lead_id') => q.where((w) => { w.where(col, lead.id); if (lead.student_id) w.orWhere('student_id', lead.student_id); });
  const hasTable = async (t) => knex.schema.hasTable(t);
  const f = { lead, appointments: 0, attended: 0, noShows: 0, eventRegs: 0, eventAttended: 0, inbound: 0, pageviews: 0, programViews: 0, calculator: 0, shortlist: 0 };
  if (await hasTable('appointments')) {
    f.appointments = await n(who(knex('appointments')).whereNotIn('status', ['cancelled']));
    f.attended = await n(who(knex('appointments')).where('status', 'completed'));
    f.noShows = await n(who(knex('appointments')).where('status', 'no_show'));
    f.eventRegs = await n(who(knex('event_registrations')).whereNot('status', 'cancelled'));
    f.eventAttended = await n(who(knex('event_registrations')).where('status', 'attended'));
  }
  if (await hasTable('messages')) f.inbound = await n(who(knex('messages')).where('direction', 'in'));
  f.enquiries = await n(knex('activities').where({ lead_id: lead.id }).whereIn('type', ['form', 'created']));
  const visitorIds = [lead.visitor_id, ...(await knex('visitors').where({ lead_id: lead.id }).pluck('id'))].filter(Boolean);
  if (visitorIds.length) {
    const rows = await knex('tracking_events').whereIn('visitor_id', [...new Set(visitorIds)]).groupBy('name').select('name').count({ c: '*' });
    const c = Object.fromEntries(rows.map((r) => [r.name, Number(r.c)]));
    f.pageviews = c.pageview || 0; f.programViews = c.program_view || 0; f.calculator = c.calculator || 0;
  }
  if (lead.student_id) f.shortlist = await n(knex('shortlist_items').where({ student_id: lead.student_id }));
  const last = lead.last_activity_at || lead.created_at;
  f.daysInactive = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400_000) : 0;
  return f;
}

/** Recomputes and stores a lead's score. Returns { score, temperature, reasons }. */
async function compute(leadId) {
  const lead = await knex('leads').where({ id: leadId }).first();
  if (!lead) return null;
  const cfg = await config();
  const f = await facts(lead);
  const reasons = [];
  let score = 0;
  for (const [k, rule] of Object.entries(RULES)) {
    const c = cfg.rules[k];
    if (!c.enabled || !Number(c.points)) continue; // eslint-disable-line no-continue
    let hit = false;
    try { hit = rule.test(f); } catch { hit = false; }
    if (hit) { score += Number(c.points); reasons.push({ key: k, points: Number(c.points) }); }
  }
  score = Math.max(0, Math.min(100, score));
  const auto = score >= cfg.hot ? 'hot' : (score >= cfg.warm ? 'warm' : 'cold');
  const temperature = lead.temperature_manual ? lead.temperature : auto;
  await knex('leads').where({ id: leadId }).update({ score, temperature, score_reasons: JSON.stringify(reasons), score_updated_at: new Date() });
  if (temperature !== lead.temperature) await events.emit('lead.temperature_changed', { leadId, from: lead.temperature, to: temperature, score });
  return { score, temperature, auto, reasons };
}

const safe = (id) => (id ? compute(id).catch((e) => console.error('[scoring]', e.message)) : null); // eslint-disable-line no-console
const leadOf = async (p) => p.leadId || (p.lead && p.lead.id) || (p.appointment && p.appointment.lead_id) || (p.registration && p.registration.lead_id) || null;
for (const ev of ['lead.created', 'lead.enquiry', 'lead.contacted', 'appointment.booked', 'appointment.completed', 'appointment.no_show', 'event.registered', 'event.attended', 'message.received']) {
  events.on(ev, async (p) => safe(await leadOf(p)));
}
// Website behaviour of an identified visitor: at most one recalculation every 10 minutes.
events.on('tracking.recorded', async ({ visitorId }) => {
  const v = await knex('visitors').where({ id: visitorId }).first('lead_id');
  if (!v || !v.lead_id) return;
  const l = await knex('leads').where({ id: v.lead_id }).first('score_updated_at');
  if (!l || (l.score_updated_at && Date.now() - new Date(l.score_updated_at).getTime() < 10 * 60_000)) return;
  await safe(v.lead_id);
});

/** Recalculates open leads (nightly, for inactivity, and after rules change). */
async function recomputeAll() {
  const ids = await knex('leads').where({ status: 'open' }).pluck('id');
  for (const id of ids) await safe(id); // eslint-disable-line no-await-in-loop
  return ids.length;
}
jobs.register('scoring.daily', 24 * 3600_000, recomputeAll);

module.exports = { RULES, DEFAULTS, config, compute, recomputeAll, facts };
