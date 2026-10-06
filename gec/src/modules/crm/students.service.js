// Students: the people GEC actively advises. Created from a lead (conversion) or directly; one profile used by
// matching, applications, documents, visa and the student portal.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const events = require('../../core/events');
const secrets = require('../../core/secrets');
const { E } = require('../../core/errors');
const { scope, inScope } = require('../rbac/rbac.service');
const activity = require('./activity.service');
const people = require('./people');
const stages = require('./stages');

const SCOPE = { owner: 'students.counsellor_id', branch: 'students.branch_id' };
const OWN = { owner: 'counsellor_id', branch: 'branch_id' };
const PER_PAGE = 30;
const esc = (s) => String(s).replace(/[%_\\]/g, (m) => `\\${m}`);

const JOURNEY = ['profile', 'counselling', 'program_selection', 'documents', 'application', 'offer', 'visa', 'pre_departure', 'enrolled'];

// Profile sections and their fields (forms, completion %, autosave).
const SECTIONS = {
  personal: ['first_name', 'last_name', 'email', 'phone', 'whatsapp', 'nationality', 'residence_country', 'city', 'date_of_birth', 'gender', 'passport', 'passport_expiry', 'preferred_locale'],
  academic: ['education_level', 'institution', 'major', 'gpa', 'gpa_scale', 'graduation_date'],
  english: ['ielts_overall', 'ielts_min_band', 'toefl', 'pte', 'duolingo', 'english_test_date'],
  goals: ['pref_countries', 'pref_fields', 'pref_degree', 'budget_usd', 'pref_intake', 'work_after_study'],
  history: ['visa_refused', 'visa_history', 'work_experience_years', 'profile_notes'],
};
// What counts toward "profile complete" (passport is checked through passport_last4).
const REQUIRED_FOR_COMPLETE = ['first_name', 'last_name', 'email', 'phone', 'nationality', 'residence_country', 'date_of_birth', 'passport_last4',
  'education_level', 'major', 'gpa', 'graduation_date', 'english', 'pref_countries', 'pref_degree', 'pref_fields', 'budget_usd', 'pref_intake'];

const parseJson = (v) => { if (!v) return []; if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch { return []; } };

function completion(s) {
  const has = (k) => {
    if (k === 'english') return [s.ielts_overall, s.toefl, s.pte, s.duolingo].some((v) => v !== null && v !== undefined && v !== '');
    const v = s[k];
    if (['pref_countries', 'pref_fields'].includes(k)) return parseJson(v).length > 0;
    return v !== null && v !== undefined && v !== '';
  };
  const missing = REQUIRED_FOR_COMPLETE.filter((k) => !has(k));
  return { percent: Math.round(((REQUIRED_FOR_COMPLETE.length - missing.length) / REQUIRED_FOR_COMPLETE.length) * 100), missing };
}

function filtered(staff, params = {}) {
  const q = scope(knex('students'), staff, SCOPE).whereNull('students.merged_into_id');
  if (params.status && params.status !== 'all') q.where('students.status', params.status);
  else if (!params.status) q.whereIn('students.status', ['active', 'on_hold']);
  if (params.q) {
    const term = `%${esc(String(params.q).trim())}%`;
    const tail = people.phoneTail(params.q);
    q.where((w) => {
      w.where(knex.raw("CONCAT_WS(' ', students.first_name, students.last_name)"), 'like', term).orWhere('students.email', 'like', term).orWhere('students.ref', 'like', term);
      if (tail) w.orWhere('students.phone_tail', tail);
      const ph = people.passportHash(params.q);
      if (ph) w.orWhere('students.passport_hash', ph);
    });
  }
  if (JOURNEY.includes(params.journey)) q.where('students.journey_stage', params.journey);
  if (params.owner === 'me' && staff.employee) q.where('students.counsellor_id', staff.employee.id);
  else if (params.owner === 'none') q.whereNull('students.counsellor_id');
  else if (/^\d+$/.test(params.owner || '')) q.where('students.counsellor_id', Number(params.owner));
  if (/^\d+$/.test(params.branch || '')) q.where('students.branch_id', Number(params.branch));
  if (params.country) q.whereRaw('JSON_CONTAINS(students.pref_countries, JSON_QUOTE(?))', [String(params.country)]);
  if (params.degree) q.where('students.pref_degree', String(params.degree));
  return q;
}

async function list(staff, params = {}) {
  const base = filtered(staff, params);
  const [{ n }] = await base.clone().count({ n: '*' });
  const page = Math.max(1, Number(params.page) || 1);
  const rows = await base.clone().leftJoin('employees as e', 'e.id', 'students.counsellor_id').leftJoin('users as u', 'u.id', 'e.user_id')
    .select('students.*', 'u.name as counsellor_name')
    .orderByRaw('COALESCE(students.last_activity_at, students.created_at) DESC').orderBy('students.id', 'desc')
    .limit(PER_PAGE).offset((page - 1) * PER_PAGE);
  return { rows: rows.map((r) => ({ ...r, completion: completion(r).percent })), meta: { total: Number(n), page, pages: Math.max(1, Math.ceil(Number(n) / PER_PAGE)) } };
}

async function get(staff, id) {
  const s = await knex('students').where({ id }).first();
  if (!s || !inScope(staff, s, OWN)) throw E.notFound('Student');
  return s;
}

/** Turns form values into columns (JSON lists, encrypted passport). */
function toRow(data) {
  const row = {};
  for (const k of Object.values(SECTIONS).flat()) {
    if (data[k] === undefined || k === 'passport') continue; // eslint-disable-line no-continue
    row[k] = ['pref_countries', 'pref_fields'].includes(k) ? JSON.stringify(data[k] || []) : data[k];
  }
  if (row.email !== undefined) row.email = row.email ? String(row.email).toLowerCase() : null;
  if (row.phone !== undefined || row.whatsapp !== undefined) row.phone_tail = people.phoneTail(row.phone) || people.phoneTail(row.whatsapp) || null;
  if (data.passport !== undefined) {
    const p = String(data.passport || '').toUpperCase().replace(/\s+/g, '');
    row.passport_enc = p ? secrets.encrypt(p) : null;
    row.passport_hash = p ? people.passportHash(p) : null;
    row.passport_last4 = p ? p.slice(-4) : null;
  }
  return row;
}

async function create(ctx, data, { counsellorId = null, branchId = null, lead = null, isDemo = false } = {}) {
  const row = {
    ...toRow(data),
    ref: await people.newRef('students', 'S'),
    counsellor_id: counsellorId, branch_id: branchId, created_by: ctx.userId || null, is_demo: isDemo,
    journey_stage: 'profile',
  };
  if (lead) {
    Object.assign(row, {
      source: lead.source, source_detail: lead.source_detail, utm_source: lead.utm_source, utm_medium: lead.utm_medium, utm_campaign: lead.utm_campaign,
      utm_term: lead.utm_term, utm_content: lead.utm_content, landing_page: lead.landing_page, referrer: lead.referrer,
      latest_source: lead.latest_source, latest_utm_source: lead.latest_utm_source, latest_utm_medium: lead.latest_utm_medium, latest_utm_campaign: lead.latest_utm_campaign,
      visitor_id: lead.visitor_id, first_visit_at: lead.first_visit_at, last_visit_at: lead.last_visit_at,
      consent_contact: lead.consent_contact, consent_marketing: lead.consent_marketing, consent_marketing_at: lead.consent_marketing_at,
    });
  }
  const [id] = await knex('students').insert(row);
  await activity.log({ studentId: id, leadId: lead ? lead.id : null }, { type: 'created', title: lead ? 'student_from_lead' : 'student_created', actorId: ctx.userId || null });
  await audit.record(ctx, 'student.created', { entityType: 'student', entityId: id, newValues: { ref: row.ref, from_lead: lead ? lead.id : null } });
  const student = await knex('students').where({ id }).first();
  await events.emit('student.created', { student, lead, by: ctx.userId });
  return student;
}

/** Converts a lead to a student (or links it to an existing student), keeping its history on the timeline. */
async function convertLead(ctx, staff, leadId, { existingStudentId = null } = {}) {
  const leads = require('./leads.service'); // eslint-disable-line global-require
  const lead = await leads.get(staff, leadId);
  if (lead.student_id) return knex('students').where({ id: lead.student_id }).first();
  let student;
  if (existingStudentId) {
    student = await get(staff, existingStudentId);
  } else {
    const countries = parseJson(lead.interest_countries);
    student = await create(ctx, {
      first_name: lead.first_name, last_name: lead.last_name, email: lead.email, phone: lead.phone, whatsapp: lead.whatsapp,
      nationality: lead.nationality, residence_country: lead.residence_country, city: lead.city, preferred_locale: lead.preferred_locale,
      education_level: lead.education_level, pref_countries: countries, pref_fields: lead.interest_field && require('../catalog/reference').fieldKey(lead.interest_field) ? [require('../catalog/reference').fieldKey(lead.interest_field)] : [], // eslint-disable-line global-require
      pref_degree: lead.interest_degree, pref_intake: lead.interest_intake,
    }, { counsellorId: lead.counsellor_id, branchId: lead.branch_id, lead });
  }
  await knex('leads').where({ id: lead.id }).update({ student_id: student.id, updated_at: new Date() });
  await activity.log({ leadId: lead.id, studentId: student.id }, { type: 'converted', title: 'converted', meta: { student_id: student.id, student_ref: student.ref }, actorId: ctx.userId });
  await audit.record(ctx, 'lead.converted', { entityType: 'lead', entityId: lead.id, newValues: { student_id: student.id } });
  // Contacted at least: a converted lead is never "new".
  const cur = (await stages.all()).find((s) => s.id === lead.stage_id);
  const qualified = await stages.byKey('qualified');
  if (cur && qualified && cur.position < qualified.position) await leads.moveStage(ctx, staff, lead.id, qualified.id);
  await events.emit('lead.converted', { lead, student, by: ctx.userId });
  return student;
}

async function update(ctx, staff, id, data, { section } = {}) {
  const before = await get(staff, id);
  const fields = section ? SECTIONS[section] : Object.values(SECTIONS).flat();
  const picked = Object.fromEntries(Object.entries(data).filter(([k]) => fields.includes(k)));
  const row = toRow(picked);
  const d = audit.diff(before, row);
  if (!d.changed) return false;
  await knex('students').where({ id }).update({ ...row, updated_at: new Date() });
  await audit.record(ctx, 'student.updated', { entityType: 'student', entityId: id, oldValues: d.oldValues, newValues: d.newValues });
  const after = await knex('students').where({ id }).first();
  // Completing the profile moves the journey forward.
  if (after.journey_stage === 'profile' && completion(after).percent === 100) await setJourney(ctx, id, 'counselling', { auto: true });
  await events.emit('student.updated', { student: after, changed: Object.keys(d.newValues), by: ctx.userId });
  return true;
}

async function setJourney(ctx, id, stage, { auto = false } = {}) {
  if (!JOURNEY.includes(stage)) throw E.validation({ journey_stage: 'Choose a valid option.' });
  const s = await knex('students').where({ id }).first();
  if (!s || s.journey_stage === stage) return;
  await knex('students').where({ id }).update({ journey_stage: stage, status: stage === 'enrolled' ? 'enrolled' : s.status, updated_at: new Date() });
  await activity.log({ studentId: id }, { type: 'stage', title: 'journey', meta: { from: s.journey_stage, to: stage, auto }, actorId: auto ? null : ctx.userId, shareable: true });
  await audit.record(ctx, 'student.journey_changed', { entityType: 'student', entityId: id, oldValues: { journey_stage: s.journey_stage }, newValues: { journey_stage: stage } });
  await events.emit('student.journey_changed', { studentId: id, from: s.journey_stage, to: stage });
}

/** Moves the journey forward only (used by applications, visa, documents…). */
async function advanceJourney(ctx, id, stage) {
  const s = await knex('students').where({ id }).first('journey_stage');
  if (s && JOURNEY.indexOf(stage) > JOURNEY.indexOf(s.journey_stage)) await setJourney(ctx, id, stage, { auto: true });
}

async function assign(ctx, staff, id, employeeId) {
  const s = await get(staff, id);
  const emp = employeeId ? await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('e.id', employeeId).where('u.status', 'active').first('e.id', 'e.branch_id', 'u.name') : null;
  if (employeeId && !emp) throw E.validation({ counsellor_id: 'Choose a valid option.' });
  const owner = { counsellor_id: emp ? emp.id : null, branch_id: emp && emp.branch_id ? emp.branch_id : s.branch_id };
  await knex('students').where({ id }).update({ ...owner, updated_at: new Date() });
  // The student's open work moves with them (their converted leads, applications and visa cases).
  await knex('applications').where({ student_id: id }).update(owner);
  await knex('visa_cases').where({ student_id: id }).update(owner);
  await knex('leads').where({ student_id: id }).update({ counsellor_id: owner.counsellor_id, ...(owner.branch_id ? { branch_id: owner.branch_id } : {}) });
  await activity.log({ studentId: id }, { type: 'assigned', title: emp ? 'assigned' : 'unassigned', meta: { to: emp ? emp.id : null, to_name: emp ? emp.name : null }, actorId: ctx.userId });
  await audit.record(ctx, 'student.assigned', { entityType: 'student', entityId: id, oldValues: { counsellor_id: s.counsellor_id }, newValues: { counsellor_id: emp ? emp.id : null } });
  if (emp) await events.emit('student.assigned', { studentId: id, employeeId: emp.id, by: ctx.userId });
}

/** Decrypted passport number — only for people allowed to edit the student; every read is audited. */
async function revealPassport(ctx, staff, id) {
  const s = await get(staff, id);
  await audit.record(ctx, 'student.passport_viewed', { entityType: 'student', entityId: id });
  return s.passport_enc ? secrets.decrypt(s.passport_enc) : null;
}

async function remove(ctx, staff, id) {
  const s = await get(staff, id);
  await knex('students').where({ id }).del();
  await audit.record(ctx, 'student.deleted', { entityType: 'student', entityId: id, oldValues: { ref: s.ref, name: people.fullName(s), email: s.email } });
}

module.exports = { list, get, create, convertLead, update, setJourney, advanceJourney, assign, revealPassport, remove, completion, filtered, parseJson, SECTIONS, JOURNEY, SCOPE, OWN };
