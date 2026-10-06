// Applications (ATS): one student × one program/university × one intake, moving through configurable stages.
// Every move is recorded (stage history + timeline), keeps the student's journey and the originating lead in step,
// and emits events for automations and notifications.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const events = require('../../core/events');
const { E } = require('../../core/errors');
const { scope } = require('../rbac/rbac.service');
const activity = require('../crm/activity.service');
const people = require('../crm/people');
const studentsSvc = require('../crm/students.service');
const leadStages = require('../crm/stages');
const stages = require('./stages');

// Access follows the student's current counsellor / branch (the copies on the application are for reports and "mine" filters).
const SCOPE = { owner: 's.counsellor_id', branch: 's.branch_id' };
const PER_PAGE = 30;

function base(staff) {
  return scope(knex('applications as a').join('students as s', 's.id', 'a.student_id'), staff, SCOPE)
    .leftJoin('programs as p', 'p.id', 'a.program_id').leftJoin('universities as u', 'u.id', 'a.university_id')
    .leftJoin('application_stages as st', 'st.id', 'a.stage_id')
    .leftJoin('employees as e', 'e.id', 'a.counsellor_id').leftJoin('users as eu', 'eu.id', 'e.user_id');
}
const COLS = ['a.*', 's.first_name', 's.last_name', 's.ref as student_ref', 'p.name_en as p_name_en', 'p.name_ar as p_name_ar', 'p.slug as program_slug', 'p.degree_level',
  'u.name_en as u_name_en', 'u.name_ar as u_name_ar', 'st.key as stage_key', 'st.name_en as stage_en', 'st.name_ar as stage_ar', 'st.tone as stage_tone', 'st.sla_days', 'eu.name as counsellor_name'];

function filtered(staff, params = {}) {
  const q = base(staff);
  const status = params.status || 'open';
  if (status !== 'all') q.where('a.status', status);
  if (params.q) {
    const term = `%${String(params.q).trim().replace(/[%_\\]/g, '')}%`;
    q.where((w) => w.where(knex.raw("CONCAT_WS(' ', s.first_name, s.last_name)"), 'like', term).orWhere('a.ref', 'like', term).orWhere('p.name_en', 'like', term).orWhere('u.name_en', 'like', term).orWhere('a.university_name', 'like', term));
  }
  if (/^\d+$/.test(params.stage || '')) q.where('a.stage_id', Number(params.stage));
  if (params.owner === 'me' && staff.employee) q.where('a.counsellor_id', staff.employee.id);
  else if (/^\d+$/.test(params.owner || '')) q.where('a.counsellor_id', Number(params.owner));
  if (/^\d+$/.test(params.university || '')) q.where('a.university_id', Number(params.university));
  if (/^\d{4}-\d{2}$/.test(params.intake || '')) q.where('a.intake', params.intake);
  if (params.stuck === '1') q.whereNotNull('st.sla_days').whereRaw('a.stage_entered_at < DATE_SUB(NOW(), INTERVAL st.sla_days DAY)');
  if (params.deadline === 'soon') q.whereNotNull('a.deadline').whereRaw('a.deadline <= DATE_ADD(CURDATE(), INTERVAL 14 DAY)').whereNull('a.submitted_at');
  if (/^\d+$/.test(params.student || '')) q.where('a.student_id', Number(params.student));
  return q;
}

async function list(staff, params = {}) {
  const q = filtered(staff, params);
  const [{ n }] = await q.clone().count({ n: '*' });
  const page = Math.max(1, Number(params.page) || 1);
  const rows = await q.clone().select(COLS).orderByRaw('a.deadline IS NULL, a.deadline').orderBy('a.updated_at', 'desc').limit(PER_PAGE).offset((page - 1) * PER_PAGE);
  return { rows, meta: { total: Number(n), page, pages: Math.max(1, Math.ceil(Number(n) / PER_PAGE)) } };
}

async function board(staff, params = {}) {
  const all = (await stages.all()).filter((s) => s.is_active && s.key !== 'closed');
  const rows = await filtered(staff, { ...params, status: 'open' }).select(COLS).orderBy('a.stage_entered_at').limit(1000);
  return all.map((stage) => ({ stage, rows: rows.filter((r) => r.stage_id === stage.id) })).filter((c) => c.rows.length || !['lead', 'profile_started', 'profile_complete'].includes(c.stage.key));
}

async function get(staff, id) {
  const a = await base(staff).where('a.id', id).first(COLS);
  if (!a) throw E.notFound('Application');
  return a;
}

/** Applications of one student the employee may see (student page tab). */
async function forStudent(staff, studentId) {
  return base(staff).where('a.student_id', studentId).select(COLS).orderBy('a.created_at', 'desc');
}

async function create(ctx, staff, { studentId, programId = null, universityName = null, programName = null, intake = null, deadline = null, stageKey = 'shortlisting', isDemo = false }) {
  const student = await studentsSvc.get(staff, studentId);
  let program = null;
  if (programId) {
    program = await knex('programs as p').join('universities as u', 'u.id', 'p.university_id').where('p.id', programId).first('p.*', 'u.name_en as uni_name');
    if (!program) throw E.validation({ program_id: 'Choose a valid option.' });
    const dup = await knex('applications').where({ student_id: student.id, program_id: programId, status: 'open' }).modify((q) => { if (intake) q.where('intake', intake); }).first('id');
    if (dup) throw E.conflict('APPLICATION_EXISTS', 'This student already has an open application for this program and intake.', { id: dup.id });
  } else if (!programName || !universityName) throw E.validation({ program_id: 'Choose a program or enter the program and university.' });
  const stage = (await stages.byKey(stageKey)) || (await stages.all()).find((s) => s.is_active);
  const row = {
    ref: await people.newRef('applications', 'A'), student_id: student.id, program_id: program ? program.id : null, university_id: program ? program.university_id : null,
    program_name: program ? program.name_en : programName, university_name: program ? program.uni_name : universityName,
    intake, deadline: deadline || (program ? program.next_deadline : null), stage_id: stage.id,
    counsellor_id: student.counsellor_id, branch_id: student.branch_id, tuition_fee: program ? program.tuition_fee : null, currency: program ? program.currency : null,
    created_by: ctx.userId, is_demo: isDemo,
  };
  const [id] = await knex('applications').insert(row);
  await knex('application_stage_history').insert({ application_id: id, from_stage_id: null, to_stage_id: stage.id, changed_by: ctx.userId });
  await activity.log({ studentId: student.id, applicationId: id }, { type: 'application', title: 'application_created', meta: { ref: row.ref, program: row.program_name, university: row.university_name, stage_en: stage.name_en, stage_ar: stage.name_ar }, actorId: ctx.userId, shareable: true });
  await audit.record(ctx, 'application.created', { entityType: 'application', entityId: id, newValues: { ref: row.ref, student_id: student.id, program_id: row.program_id, stage: stage.key } });
  await syncStudentAndLead(ctx, student.id, stage);
  const app = await knex('applications').where({ id }).first();
  await events.emit('application.created', { application: app, stage, by: ctx.userId });
  return app;
}

/** Keeps the student journey and the originating open lead in step with the application (forward only). */
async function syncStudentAndLead(ctx, studentId, stage) {
  if (stage.journey) await studentsSvc.advanceJourney(ctx, studentId, stage.journey);
  if (!stage.lead_stage) return;
  const target = await leadStages.byKey(stage.lead_stage);
  if (!target) return;
  const leads = await knex('leads as l').join('lead_stages as s', 's.id', 'l.stage_id').where('l.student_id', studentId).where('l.status', 'open').select('l.id', 's.position');
  for (const l of leads) {
    if (l.position < target.position) {
      await knex('leads').where({ id: l.id }).update({ stage_id: target.id, stage_entered_at: new Date(), status: target.is_won ? 'converted' : 'open', updated_at: new Date() }); // eslint-disable-line no-await-in-loop
      await activity.log({ leadId: l.id, studentId }, { type: 'stage', title: 'stage', meta: { to: target.key, to_en: target.name_en, to_ar: target.name_ar, auto: true }, actorId: null }); // eslint-disable-line no-await-in-loop
    }
  }
}

async function moveStage(ctx, staff, id, stageId, { note = null, reason = null } = {}) {
  const app = await get(staff, id);
  const all = await stages.all();
  const to = all.find((s) => s.id === Number(stageId) && s.is_active);
  if (!to) throw E.validation({ stage_id: 'Choose a valid option.' });
  if (to.id === app.stage_id) return app;
  if (to.key === 'closed' && !reason) throw E.validation({ reason: 'Required.' });
  const from = all.find((s) => s.id === app.stage_id);
  const now = new Date();
  const upd = { stage_id: to.id, stage_entered_at: now, updated_at: now };
  if (to.key === 'submitted' && !app.submitted_at) upd.submitted_at = now;
  if (['conditional_offer', 'unconditional_offer'].includes(to.key)) { upd.offer_type = to.key === 'conditional_offer' ? 'conditional' : 'unconditional'; if (!app.offer_received_at) upd.offer_received_at = now; }
  if (to.key === 'deposit_paid' && !app.deposit_paid_at) upd.deposit_paid_at = now;
  if (to.is_terminal) Object.assign(upd, { status: to.is_success ? 'won' : 'lost', closed_reason: reason || null });
  else if (app.status !== 'open') Object.assign(upd, { status: 'open', closed_reason: null });
  await knex.transaction(async (trx) => {
    await trx('applications').where({ id }).update(upd);
    await trx('application_stage_history').insert({ application_id: id, from_stage_id: from ? from.id : null, to_stage_id: to.id, changed_by: ctx.userId, note: note || reason || null, seconds_in_previous: Math.round((now - new Date(app.stage_entered_at)) / 1000) });
    await activity.log({ studentId: app.student_id, applicationId: id }, { type: 'application', title: 'application_stage', body: note || null, meta: { ref: app.ref, program: app.program_name, from_en: from && from.name_en, from_ar: from && from.name_ar, to: to.key, to_en: to.name_en, to_ar: to.name_ar, reason: reason || null }, actorId: ctx.userId, shareable: true }, trx);
    await audit.record(ctx, 'application.stage_changed', { entityType: 'application', entityId: id, oldValues: { stage: from && from.key }, newValues: { stage: to.key, reason: reason || undefined } }, trx);
  });
  await syncStudentAndLead(ctx, app.student_id, to);
  const updated = await knex('applications').where({ id }).first();
  await events.emit('application.stage_changed', { application: updated, from, to, by: ctx.userId });
  if (['conditional_offer', 'unconditional_offer'].includes(to.key)) await events.emit('application.offer_received', { application: updated, stage: to });
  return updated;
}

const EDITABLE = ['intake', 'deadline', 'next_action', 'next_action_due', 'university_ref', 'portal_url', 'priority', 'offer_type', 'offer_conditions', 'deposit_amount', 'deposit_currency', 'deposit_due', 'cas_number', 'program_name', 'university_name'];
async function update(ctx, staff, id, data) {
  const app = await get(staff, id);
  const row = Object.fromEntries(Object.entries(data).filter(([k, v]) => EDITABLE.includes(k) && v !== undefined));
  const before = await knex('applications').where({ id }).first();
  const d = audit.diff(before, row);
  if (!d.changed) return false;
  await knex('applications').where({ id }).update({ ...row, updated_at: new Date() });
  await audit.record(ctx, 'application.updated', { entityType: 'application', entityId: id, oldValues: d.oldValues, newValues: d.newValues });
  if (d.newValues.cas_number) await activity.log({ studentId: app.student_id, applicationId: id }, { type: 'application', title: 'cas_recorded', meta: { ref: app.ref }, actorId: ctx.userId, shareable: true });
  return true;
}

async function history(id) {
  return knex('application_stage_history as h').leftJoin('application_stages as f', 'f.id', 'h.from_stage_id').join('application_stages as t', 't.id', 'h.to_stage_id').leftJoin('users as u', 'u.id', 'h.changed_by')
    .where('h.application_id', id).select('h.*', 'f.name_en as from_en', 'f.name_ar as from_ar', 't.key as to_key', 't.name_en as to_en', 't.name_ar as to_ar', 'u.name as by_name').orderBy('h.changed_at').orderBy('h.id');
}

async function remove(ctx, staff, id) {
  const app = await get(staff, id);
  await knex('applications').where({ id }).del();
  await audit.record(ctx, 'application.deleted', { entityType: 'application', entityId: id, oldValues: { ref: app.ref, student_id: app.student_id } });
}

module.exports = { list, board, get, forStudent, create, moveStage, update, history, remove, filtered, base, COLS, SCOPE };
