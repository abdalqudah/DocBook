// Automation rules: WHEN something happens (a domain event, or a time condition checked by a job) AND the
// conditions match, THEN run actions (send a template, create a task, assign a counsellor, move the lead stage,
// add a note, e-mail the counsellor). Rules are off until an administrator enables them. Every run is logged.
// Automations cannot trigger themselves endlessly: actions taken by a rule do not start other rules beyond
// a depth of 2, and time-based rules run once per record.
const { AsyncLocalStorage } = require('async_hooks');
const knex = require('../../db/knex');
const config = require('../../config');
const events = require('../../core/events');
const settings = require('../settings/settings.service');
const people = require('../crm/people');
const jobs = require('../jobs');

const depth = new AsyncLocalStorage();
const parse = (v, d) => (v && typeof v === 'object' ? v : (() => { try { return JSON.parse(v || ''); } catch { return d; } })());

// Event triggers → how to find the lead / student, plus extra facts for conditions.
const TRIGGERS = {
  'lead.created': (p) => ({ leadId: p.lead && p.lead.id }),
  'lead.enquiry': (p) => ({ leadId: p.lead && p.lead.id }),
  'lead.stage_changed': (p) => ({ leadId: p.lead && p.lead.id, facts: { to_stage: p.to && p.to.key } }),
  'lead.temperature_changed': (p) => ({ leadId: p.leadId, facts: { to_temperature: p.to } }),
  'appointment.booked': (p) => ({ leadId: p.appointment && p.appointment.lead_id, studentId: p.appointment && p.appointment.student_id }),
  'appointment.no_show': (p) => ({ leadId: p.appointment && p.appointment.lead_id, studentId: p.appointment && p.appointment.student_id }),
  'appointment.completed': (p) => ({ leadId: p.appointment && p.appointment.lead_id, studentId: p.appointment && p.appointment.student_id }),
  'application.stage_changed': (p) => ({ studentId: p.application && p.application.student_id, applicationId: p.application && p.application.id, facts: { application_stage: p.to && p.to.key } }),
  'document.reviewed': (p) => ({ studentId: p.studentId, facts: { document_status: p.status } }),
  'visa.stage_changed': (p) => ({ studentId: p.studentId, facts: { visa_stage: p.to } }),
  'payment.received': () => ({}),
  'event.attended': (p) => ({ leadId: p.registration && p.registration.lead_id, studentId: p.registration && p.registration.student_id }),
  'message.received': (p) => ({ leadId: p.leadId, studentId: p.studentId, facts: { channel: p.channel } }),
};
// Time-based triggers checked every 15 minutes; `delay_hours` on the rule sets the wait.
const TIMED = ['lead.not_contacted', 'lead.inactive', 'application.stuck', 'appointment.tomorrow'];
const ALL_TRIGGERS = [...Object.keys(TRIGGERS), ...TIMED];
const FIELDS = ['source', 'lead_stage', 'temperature', 'country', 'degree', 'journey_stage', 'to_stage', 'to_temperature', 'application_stage', 'document_status', 'visa_stage', 'channel', 'branch_id', 'has_counsellor'];
const ACTIONS = ['send_template', 'create_task', 'assign', 'move_lead_stage', 'add_note', 'email_counsellor'];

async function contextFor({ leadId, studentId, applicationId, facts = {} }) {
  let lead = leadId ? await knex('leads').where({ id: leadId }).first() : null;
  let student = studentId ? await knex('students').where({ id: studentId }).first() : null;
  if (!student && lead && lead.student_id) student = await knex('students').where({ id: lead.student_id }).first();
  if (!lead && student) lead = await knex('leads').where({ student_id: student.id }).orderBy('id', 'desc').first() || null;
  const stage = lead ? await knex('lead_stages').where({ id: lead.stage_id }).first('key') : null;
  const p = student || lead;
  const countries = parse(lead ? lead.interest_countries : null, []).concat(parse(student ? student.pref_countries : null, []));
  return { lead, student, applicationId: applicationId || null, values: {
    source: lead ? lead.source : null, lead_stage: stage ? stage.key : null, temperature: lead ? lead.temperature : null, country: countries,
    degree: (lead && lead.interest_degree) || (student && student.pref_degree) || null, journey_stage: student ? student.journey_stage : null,
    branch_id: p ? String(p.branch_id || '') : null, has_counsellor: p && p.counsellor_id ? 'yes' : 'no', ...facts,
  } };
}

function matches(conditions, values) {
  return (conditions || []).every((c) => {
    const v = values[c.field];
    const want = String(c.value || '').split(',').map((x) => x.trim()).filter(Boolean);
    const have = (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined).map(String);
    if (c.op === 'neq') return !have.some((h) => want.includes(h));
    return have.some((h) => want.includes(h)); // eq / in (comma-separated)
  });
}

async function runActions(rule, ctx) {
  const done = [];
  const p = ctx.student || ctx.lead;
  const who = { leadId: ctx.lead ? ctx.lead.id : null, studentId: ctx.student ? ctx.student.id : null };
  const sys = { userId: null, ip: null };
  for (const a of parse(rule.actions, [])) {
    if (a.type === 'send_template' && p) {
      const channel = ['email', 'sms', 'whatsapp'].includes(a.channel) ? a.channel : 'email';
      const to = channel === 'email' ? p.email : (channel === 'whatsapp' ? p.whatsapp || p.phone : p.phone);
      if (!to) { done.push(`${a.type}:no_address`); continue; } // eslint-disable-line no-continue
      const locale = p.preferred_locale === 'ar' ? 'ar' : 'en';
      const branding = await settings.get('branding'); // eslint-disable-line no-await-in-loop
      const counsellor = p.counsellor_id ? await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('e.id', p.counsellor_id).first('u.name') : null; // eslint-disable-line no-await-in-loop
      const templates = require('../comms/templates'); // eslint-disable-line global-require
      const msg = await templates.render(a.template, locale, { student_name: people.fullName(p), counsellor_name: counsellor ? counsellor.name : '', company_name: branding.legal_name, link: `${config.appUrl}/portal` }, channel) // eslint-disable-line no-await-in-loop
        || await templates.render(a.template, locale, { student_name: people.fullName(p), company_name: branding.legal_name }, 'email'); // eslint-disable-line no-await-in-loop
      if (!msg) { done.push(`${a.type}:no_template`); continue; } // eslint-disable-line no-continue
      const r = await require('../comms/comms.service').send({ channel, to, subject: msg.subject, body: msg.body, ...who, templateKey: a.template, automated: true, locale }); // eslint-disable-line global-require, no-await-in-loop
      done.push(`${a.type}:${r.sent ? 'sent' : r.reason}`);
    } else if (a.type === 'create_task') {
      const assignee = a.assign === 'counsellor' ? (p && p.counsellor_id) : (/^\d+$/.test(String(a.assign || '')) ? Number(a.assign) : null);
      await require('../crm/tasks.service').create(sys, { title: String(a.title || rule.name).slice(0, 190), description: a.description || null, lead_id: who.studentId ? null : who.leadId, student_id: who.studentId, application_id: ctx.applicationId, assignee_id: assignee || null, due_at: new Date(Date.now() + (Number(a.due_hours) || 24) * 3600_000), priority: a.priority || 'normal', origin: `automation:${rule.id}` }); // eslint-disable-line global-require, no-await-in-loop
      done.push(a.type);
    } else if (a.type === 'assign' && ctx.lead && !ctx.lead.counsellor_id) {
      let emp = /^\d+$/.test(String(a.employee_id || '')) ? Number(a.employee_id) : null;
      if (!emp) { const r = await require('../crm/assignment').pick({ branchId: ctx.lead.branch_id, countries: parse(ctx.lead.interest_countries, []) }); emp = r && r.employeeId; } // eslint-disable-line global-require, no-await-in-loop
      if (emp) { await require('../crm/leads.service').assign(sys, { employee: { dataScope: 'all' } }, ctx.lead.id, emp); done.push(`assign:${emp}`); } else done.push('assign:none_available'); // eslint-disable-line global-require, no-await-in-loop
    } else if (a.type === 'move_lead_stage' && ctx.lead) {
      const st = await knex('lead_stages').where({ key: a.stage_key }).first(); // eslint-disable-line no-await-in-loop
      if (st && st.id !== ctx.lead.stage_id) { await require('../crm/leads.service').moveStage(sys, { employee: { dataScope: 'all' } }, ctx.lead.id, st.id); done.push(`stage:${st.key}`); } // eslint-disable-line global-require, no-await-in-loop
    } else if (a.type === 'add_note' && (who.leadId || who.studentId)) {
      await require('../crm/activity.service').log(who, { type: 'note', title: 'automation_note', body: String(a.text || '').slice(0, 2000), meta: { rule: rule.name } }); // eslint-disable-line global-require, no-await-in-loop
      done.push(a.type);
    } else if (a.type === 'email_counsellor' && p && p.counsellor_id) {
      const u = await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('e.id', p.counsellor_id).first('u.email', 'u.name', 'u.locale'); // eslint-disable-line no-await-in-loop
      if (u) {
        const href = ctx.student ? `${config.appUrl}/staff/students/${ctx.student.id}` : `${config.appUrl}/staff/leads/${ctx.lead.id}`;
        const html = await require('../comms/email').layout({ locale: u.locale || 'en', title: rule.name, body: `${String(a.text || rule.name)}\n\n${people.fullName(p)}`, cta: 'Open', href }); // eslint-disable-line global-require, no-await-in-loop
        const r = await require('../comms/email').send({ to: u.email, subject: `[GEC] ${rule.name}`, html, text: `${a.text || rule.name} — ${href}` }); // eslint-disable-line global-require, no-await-in-loop
        done.push(`email_counsellor:${r.sent ? 'sent' : r.reason}`);
      }
    }
  }
  return done;
}

async function execute(rule, target, dedupeKey = null) {
  const ctx = await contextFor(target);
  if (!ctx.lead && !ctx.student) return null;
  if (!matches(parse(rule.conditions, []), ctx.values)) return null;
  if (dedupeKey) {
    try { await knex('automation_runs').insert({ automation_id: rule.id, entity_type: ctx.student ? 'student' : 'lead', entity_id: (ctx.student || ctx.lead).id, status: 'done', detail: 'claimed', dedupe_key: dedupeKey }); } catch { return null; } // already ran
  }
  let status = 'done'; let detail;
  try { detail = (await depth.run((depth.getStore() || 0) + 1, () => runActions(rule, ctx))).join(', ') || 'no actions applied'; } catch (e) { status = 'failed'; detail = e.message; }
  if (dedupeKey) await knex('automation_runs').where({ automation_id: rule.id, dedupe_key: dedupeKey }).update({ status, detail: String(detail).slice(0, 500) });
  else await knex('automation_runs').insert({ automation_id: rule.id, entity_type: ctx.student ? 'student' : 'lead', entity_id: (ctx.student || ctx.lead).id, status, detail: String(detail).slice(0, 500) });
  await knex('automations').where({ id: rule.id }).update({ run_count: knex.raw('run_count + 1'), last_run_at: new Date() });
  return { status, detail };
}

// Event-driven rules.
for (const name of Object.keys(TRIGGERS)) {
  events.on(name, async (payload) => {
    if ((depth.getStore() || 0) >= 2) return;
    const rules = await knex('automations').where({ trigger: name, is_active: true });
    if (!rules.length) return;
    let target = TRIGGERS[name](payload) || {};
    if (name === 'payment.received' && payload.paymentId) { const pay = await knex('payments').where({ id: payload.paymentId }).first(); target = { leadId: pay && pay.lead_id, studentId: pay && pay.student_id }; }
    for (const rule of rules) await execute(rule, target); // eslint-disable-line no-await-in-loop
  });
}

/** Time-based rules: each record fires once per rule. */
async function timed() {
  const rules = await knex('automations').where({ is_active: true }).whereIn('trigger', TIMED);
  for (const rule of rules) {
    const cutoff = new Date(Date.now() - Number(rule.delay_hours || 0) * 3600_000);
    let targets = [];
    if (rule.trigger === 'lead.not_contacted') targets = (await knex('leads').where({ status: 'open' }).whereNull('first_contacted_at').where('created_at', '<=', cutoff).where('created_at', '>=', new Date(Date.now() - 30 * 86400_000)).limit(200).pluck('id')).map((id) => ({ t: { leadId: id }, key: `lead:${id}` })); // eslint-disable-line no-await-in-loop
    if (rule.trigger === 'lead.inactive') targets = (await knex('leads').where({ status: 'open' }).whereRaw('COALESCE(last_activity_at, created_at) <= ?', [cutoff]).limit(200).select('id', 'last_activity_at')).map((l) => ({ t: { leadId: l.id }, key: `lead:${l.id}:${l.last_activity_at ? new Date(l.last_activity_at).getTime() : 0}` })); // eslint-disable-line no-await-in-loop
    if (rule.trigger === 'application.stuck') targets = (await knex('applications').where({ status: 'open' }).where('stage_entered_at', '<=', cutoff).limit(200).select('id', 'student_id', 'stage_id', 'stage_entered_at')).map((a) => ({ t: { studentId: a.student_id, applicationId: a.id }, key: `app:${a.id}:${a.stage_id}:${new Date(a.stage_entered_at).getTime()}` })); // eslint-disable-line no-await-in-loop
    if (rule.trigger === 'appointment.tomorrow') targets = (await knex('appointments').whereIn('status', ['scheduled', 'confirmed']).whereBetween('start_at', [new Date(Date.now() + 12 * 3600_000), new Date(Date.now() + 36 * 3600_000)]).limit(200).select('id', 'lead_id', 'student_id')).map((a) => ({ t: { leadId: a.lead_id, studentId: a.student_id }, key: `appt:${a.id}` })); // eslint-disable-line no-await-in-loop
    for (const x of targets) await execute(rule, x.t, x.key); // eslint-disable-line no-await-in-loop
  }
}
jobs.register('automations.timed', 15 * 60_000, timed);

module.exports = { TRIGGERS, TIMED, ALL_TRIGGERS, FIELDS, ACTIONS, matches, contextFor, execute, timed };
