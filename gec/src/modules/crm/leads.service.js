// Leads: capture (website, manual, imports), pipeline stages, assignment, follow-up, loss, conversion, merge.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const events = require('../../core/events');
const { E } = require('../../core/errors');
const { scope, inScope } = require('../rbac/rbac.service');
const stages = require('./stages');
const activity = require('./activity.service');
const assignment = require('./assignment');
const people = require('./people');

const SCOPE = { owner: 'leads.counsellor_id', branch: 'leads.branch_id' };
const OWN = { owner: 'counsellor_id', branch: 'branch_id' };

const PER_PAGE = 30;
const esc = (s) => String(s).replace(/[%_\\]/g, (m) => `\\${m}`);

/** Base query with the employee's data scope and the list filters. */
function filtered(staff, params = {}) {
  const q = scope(knex('leads'), staff, SCOPE);
  const status = params.status || 'open';
  if (status !== 'all') q.where('leads.status', status);
  if (params.q) {
    const term = `%${esc(String(params.q).trim())}%`;
    const tail = people.phoneTail(params.q);
    q.where((w) => {
      w.where(knex.raw("CONCAT_WS(' ', leads.first_name, leads.last_name)"), 'like', term).orWhere('leads.email', 'like', term).orWhere('leads.ref', 'like', term);
      if (tail) w.orWhere('leads.phone_tail', tail);
    });
  }
  if (/^\d+$/.test(params.stage || '')) q.where('leads.stage_id', Number(params.stage));
  if (params.owner === 'me' && staff.employee) q.where('leads.counsellor_id', staff.employee.id);
  else if (params.owner === 'none') q.whereNull('leads.counsellor_id');
  else if (/^\d+$/.test(params.owner || '')) q.where('leads.counsellor_id', Number(params.owner));
  if (params.source) q.where('leads.source', String(params.source));
  if (['cold', 'warm', 'hot'].includes(params.temp)) q.where('leads.temperature', params.temp);
  if (/^\d+$/.test(params.branch || '')) q.where('leads.branch_id', Number(params.branch));
  if (params.country) q.whereRaw('JSON_CONTAINS(leads.interest_countries, JSON_QUOTE(?))', [String(params.country)]);
  if (params.followup === 'overdue') q.where('leads.next_follow_up_at', '<', new Date());
  if (params.uncontacted === '1') q.whereNull('leads.first_contacted_at');
  return q;
}

const SORTS = { created: 'leads.created_at', score: 'leads.score', activity: 'leads.last_activity_at', name: 'leads.first_name', followup: 'leads.next_follow_up_at' };

async function list(staff, params = {}) {
  const base = filtered(staff, params);
  const [{ n }] = await base.clone().count({ n: '*' });
  const page = Math.max(1, Number(params.page) || 1);
  const sort = SORTS[params.sort] || SORTS.created;
  const rows = await base.clone()
    .leftJoin('lead_stages as s', 's.id', 'leads.stage_id')
    .leftJoin('employees as e', 'e.id', 'leads.counsellor_id').leftJoin('users as u', 'u.id', 'e.user_id')
    .select('leads.*', 's.name_en as stage_en', 's.name_ar as stage_ar', 's.tone as stage_tone', 'u.name as counsellor_name')
    .orderBy(sort, params.dir === 'asc' ? 'asc' : 'desc').orderBy('leads.id', 'desc')
    .limit(PER_PAGE).offset((page - 1) * PER_PAGE);
  return { rows, meta: { total: Number(n), page, pages: Math.max(1, Math.ceil(Number(n) / PER_PAGE)), perPage: PER_PAGE } };
}

/** Kanban: open leads per stage (first 50 of each, most recent activity first). */
async function board(staff, params = {}) {
  const all = await stages.all();
  const cols = all.filter((s) => s.is_active && !s.is_lost);
  const counts = await filtered(staff, { ...params, status: 'open', stage: undefined }).select('leads.stage_id').count({ n: '*' }).groupBy('leads.stage_id');
  const out = [];
  for (const s of cols) {
    const rows = await filtered(staff, { ...params, status: 'open', stage: String(s.id) }) // eslint-disable-line no-await-in-loop
      .leftJoin('employees as e', 'e.id', 'leads.counsellor_id').leftJoin('users as u', 'u.id', 'e.user_id')
      .select('leads.id', 'leads.ref', 'leads.first_name', 'leads.last_name', 'leads.temperature', 'leads.score', 'leads.interest_degree', 'leads.interest_field', 'leads.interest_countries', 'leads.stage_entered_at', 'leads.next_follow_up_at', 'leads.is_demo', 'u.name as counsellor_name')
      .orderByRaw('COALESCE(leads.last_activity_at, leads.created_at) DESC').limit(50);
    out.push({ stage: s, rows, count: Number((counts.find((c) => c.stage_id === s.id) || {}).n || 0) });
  }
  return out;
}

async function get(staff, id) {
  const lead = await knex('leads').where({ id }).first();
  if (!lead || !inScope(staff, lead, OWN)) throw E.notFound('Lead');
  return lead;
}

/** Fields accepted from forms / the website. */
const FIELDS = ['first_name', 'last_name', 'email', 'phone', 'whatsapp', 'nationality', 'residence_country', 'city', 'preferred_locale', 'interest_degree', 'interest_field',
  'interest_countries', 'interest_intake', 'budget_range', 'education_level', 'english_level', 'message', 'interest_type', 'interest_ref', 'branch_id', 'next_follow_up_at'];
const pick = (data) => Object.fromEntries(FIELDS.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));

/**
 * Creates a lead — or, when the same person already has an open lead, records the new enquiry on it (no duplicate).
 * `origin`: { source, sourceDetail, utm: {...}, landingPage, referrer, visitorId, firstVisitAt, lastVisitAt, consent: {contact, marketing} }
 * Returns { lead, created: boolean }.
 */
async function capture(ctx, data, origin = {}, { staff = null } = {}) {
  const email = data.email ? String(data.email).trim().toLowerCase() : null;
  const tail = people.phoneTail(data.phone || data.whatsapp);
  const existing = (email || tail) ? await knex('leads').where('status', 'open').where((w) => { if (email) w.orWhere('email', email); if (tail) w.orWhere('phone_tail', tail); }).orderBy('id', 'desc').first() : null;
  const utm = origin.utm || {};
  if (existing && !staff) {
    // A returning enquiry: keep first-touch attribution, update the latest touch and the interest.
    const upd = {
      latest_source: origin.source || null, latest_utm_source: utm.source || null, latest_utm_medium: utm.medium || null, latest_utm_campaign: utm.campaign || null,
      last_visit_at: origin.lastVisitAt || null, updated_at: new Date(),
    };
    for (const k of ['interest_degree', 'interest_field', 'interest_intake', 'budget_range', 'education_level', 'english_level', 'interest_type', 'interest_ref', 'whatsapp', 'nationality', 'residence_country', 'city']) {
      if (data[k] && !existing[k]) upd[k] = data[k];
    }
    if (data.interest_countries && data.interest_countries.length) {
      const prev = parseJson(existing.interest_countries);
      upd.interest_countries = JSON.stringify([...new Set([...prev, ...data.interest_countries])]);
    }
    if (origin.consent && origin.consent.marketing && !existing.consent_marketing) Object.assign(upd, { consent_marketing: true, consent_marketing_at: new Date(), unsubscribed_at: null });
    if (!existing.visitor_id && origin.visitorId) upd.visitor_id = origin.visitorId;
    await knex('leads').where({ id: existing.id }).update(upd);
    await activity.log({ leadId: existing.id, studentId: existing.student_id }, { type: 'form', title: `enquiry:${origin.source || 'website'}`, body: data.message || null, meta: { source: origin.source, interest: data.interest_ref || data.interest_field || null, page: origin.landingPage || null } });
    const lead = await knex('leads').where({ id: existing.id }).first();
    await events.emit('lead.enquiry', { lead, source: origin.source, data });
    return { lead, created: false };
  }

  const first = await stages.first();
  const row = {
    ...pick(data),
    ref: await people.newRef('leads', 'L'),
    email, phone_tail: tail, stage_id: first.id, status: 'open',
    interest_countries: JSON.stringify(data.interest_countries || []),
    source: origin.source || 'manual', source_detail: origin.sourceDetail || null,
    utm_source: utm.source || null, utm_medium: utm.medium || null, utm_campaign: utm.campaign || null, utm_term: utm.term || null, utm_content: utm.content || null,
    latest_source: origin.source || 'manual', latest_utm_source: utm.source || null, latest_utm_medium: utm.medium || null, latest_utm_campaign: utm.campaign || null,
    landing_page: origin.landingPage ? String(origin.landingPage).slice(0, 500) : null, referrer: origin.referrer ? String(origin.referrer).slice(0, 500) : null,
    visitor_id: origin.visitorId || null, first_visit_at: origin.firstVisitAt || null, last_visit_at: origin.lastVisitAt || null,
    consent_contact: Boolean(origin.consent && origin.consent.contact), consent_marketing: Boolean(origin.consent && origin.consent.marketing),
    consent_marketing_at: origin.consent && origin.consent.marketing ? new Date() : null,
    created_by: ctx.userId || null, is_demo: Boolean(data.is_demo),
  };
  if (staff && data.counsellor_id !== undefined) row.counsellor_id = data.counsellor_id || null;
  let lead;
  await knex.transaction(async (trx) => {
    let assigned = null;
    if (row.counsellor_id === undefined) {
      assigned = await assignment.pick({ branchId: row.branch_id, countries: data.interest_countries || [] }, trx);
      row.counsellor_id = assigned ? assigned.employeeId : null;
    }
    if (row.counsellor_id && !row.branch_id) {
      const emp = await trx('employees').where({ id: row.counsellor_id }).first('branch_id');
      row.branch_id = emp ? emp.branch_id : null;
    }
    const [id] = await trx('leads').insert(row);
    lead = await trx('leads').where({ id }).first();
    await activity.log({ leadId: id }, { type: 'created', title: `created:${row.source}`, body: data.message || null, meta: { source: row.source, detail: row.source_detail, page: row.landing_page }, actorId: ctx.userId || null }, trx);
    if (row.counsellor_id) {
      await activity.log({ leadId: id }, { type: 'assigned', title: 'assigned', meta: { to: row.counsellor_id, rule: assigned ? assigned.rule : 'manual' }, actorId: ctx.userId || null }, trx);
    }
    await audit.record(ctx, 'lead.created', { entityType: 'lead', entityId: id, newValues: { ref: row.ref, source: row.source, counsellor_id: row.counsellor_id } }, trx);
  });
  await events.emit('lead.created', { lead, source: lead.source, data });
  if (lead.counsellor_id) await events.emit('lead.assigned', { lead, employeeId: lead.counsellor_id, by: ctx.userId || null });
  return { lead, created: true };
}

function parseJson(v) { if (!v) return []; if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch { return []; } }

async function update(ctx, staff, id, data) {
  const before = await get(staff, id);
  const row = pick(data);
  if (row.email !== undefined) row.email = row.email ? String(row.email).toLowerCase() : null;
  if (row.phone !== undefined || row.whatsapp !== undefined) row.phone_tail = people.phoneTail(row.phone ?? before.phone) || people.phoneTail(row.whatsapp ?? before.whatsapp);
  if (row.interest_countries !== undefined) row.interest_countries = JSON.stringify(row.interest_countries || []);
  const d = audit.diff(before, row);
  if (!d.changed) return false;
  await knex('leads').where({ id }).update({ ...row, updated_at: new Date() });
  await audit.record(ctx, 'lead.updated', { entityType: 'lead', entityId: id, oldValues: d.oldValues, newValues: d.newValues });
  return true;
}

/** Moves a lead to another pipeline stage (kanban drag, buttons). Lost needs a reason. */
async function moveStage(ctx, staff, id, stageId, { reason } = {}) {
  const lead = await get(staff, id);
  const all = await stages.all();
  const to = all.find((s) => s.id === Number(stageId));
  if (!to) throw E.validation({ stage_id: 'Choose a valid option.' });
  if (to.id === lead.stage_id) return lead;
  if (to.is_lost && !reason) throw E.validation({ reason: 'Required.' });
  const from = all.find((s) => s.id === lead.stage_id);
  const upd = { stage_id: to.id, stage_entered_at: new Date(), updated_at: new Date() };
  if (to.is_lost) Object.assign(upd, { status: 'lost', lost_reason: String(reason).slice(0, 190) });
  else if (lead.status === 'lost') Object.assign(upd, { status: 'open', lost_reason: null });
  // Reaching "contacted" or later counts as the first contact.
  if (!lead.first_contacted_at && !to.is_lost && to.position >= ((await stages.byKey('contacted')) || { position: 2 }).position) upd.first_contacted_at = new Date();
  await knex.transaction(async (trx) => {
    await trx('leads').where({ id }).update(upd);
    await activity.log({ leadId: id, studentId: lead.student_id }, { type: to.is_lost ? 'lost' : 'stage', title: 'stage', meta: { from: from && from.key, to: to.key, from_en: from && from.name_en, to_en: to.name_en, from_ar: from && from.name_ar, to_ar: to.name_ar, reason: reason || null }, actorId: ctx.userId }, trx);
    await audit.record(ctx, 'lead.stage_changed', { entityType: 'lead', entityId: id, oldValues: { stage: from && from.key }, newValues: { stage: to.key, reason: reason || undefined } }, trx);
  });
  const updated = await knex('leads').where({ id }).first();
  await events.emit('lead.stage_changed', { lead: updated, from, to, by: ctx.userId });
  return updated;
}

async function assign(ctx, staff, id, employeeId) {
  const lead = await get(staff, id);
  const emp = employeeId ? await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('e.id', employeeId).where('u.status', 'active').first('e.id', 'e.branch_id', 'u.name') : null;
  if (employeeId && !emp) throw E.validation({ counsellor_id: 'Choose a valid option.' });
  if ((lead.counsellor_id || null) === (emp ? emp.id : null)) return lead;
  await knex.transaction(async (trx) => {
    await trx('leads').where({ id }).update({ counsellor_id: emp ? emp.id : null, branch_id: emp && emp.branch_id ? emp.branch_id : lead.branch_id, updated_at: new Date() });
    await activity.log({ leadId: id, studentId: lead.student_id }, { type: 'assigned', title: emp ? 'assigned' : 'unassigned', meta: { to: emp ? emp.id : null, to_name: emp ? emp.name : null, rule: 'manual' }, actorId: ctx.userId }, trx);
    await audit.record(ctx, 'lead.assigned', { entityType: 'lead', entityId: id, oldValues: { counsellor_id: lead.counsellor_id }, newValues: { counsellor_id: emp ? emp.id : null } }, trx);
  });
  const updated = await knex('leads').where({ id }).first();
  if (emp) await events.emit('lead.assigned', { lead: updated, employeeId: emp.id, by: ctx.userId });
  return updated;
}

/** Logs a call / WhatsApp / e-mail / meeting done outside the system, with its outcome; counts as contact. */
async function logContact(ctx, staff, id, { channel, outcome, body, followUpAt }) {
  const lead = await get(staff, id);
  const upd = { updated_at: new Date() };
  if (outcome !== 'no_answer' && !lead.first_contacted_at) upd.first_contacted_at = new Date();
  if (followUpAt !== undefined) upd.next_follow_up_at = followUpAt || null;
  await knex('leads').where({ id }).update(upd);
  await activity.log({ leadId: id, studentId: lead.student_id }, { type: channel, title: `contact:${channel}`, body: body || null, meta: { outcome }, actorId: ctx.userId });
  // A first attempt / contact moves a brand-new lead forward automatically.
  const cur = (await stages.all()).find((s) => s.id === lead.stage_id);
  if (cur && cur.key === 'new') {
    const next = await stages.byKey(outcome === 'no_answer' ? 'attempted' : 'contacted');
    if (next) await moveStage(ctx, staff, id, next.id);
  } else if (cur && cur.key === 'attempted' && outcome !== 'no_answer') {
    const next = await stages.byKey('contacted');
    if (next) await moveStage(ctx, staff, id, next.id);
  }
  await events.emit('lead.contacted', { lead, channel, outcome, by: ctx.userId });
}

async function remove(ctx, staff, id) {
  const lead = await get(staff, id);
  await knex('leads').where({ id }).del();
  await audit.record(ctx, 'lead.deleted', { entityType: 'lead', entityId: id, oldValues: { ref: lead.ref, name: people.fullName(lead), email: lead.email } });
}

module.exports = { list, board, get, capture, update, moveStage, assign, logContact, remove, filtered, parseJson, SCOPE, OWN, FIELDS };
