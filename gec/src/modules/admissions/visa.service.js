// Visa cases: a separate workflow per student and destination (preparing → submitted → biometrics → interview →
// processing → decision). Information here supports the case; it is never presented as legal advice.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const events = require('../../core/events');
const { E } = require('../../core/errors');
const { scope } = require('../rbac/rbac.service');
const activity = require('../crm/activity.service');
const people = require('../crm/people');
const studentsSvc = require('../crm/students.service');

const STAGES = ['preparing', 'documents_pending', 'ready', 'submitted', 'biometrics', 'interview', 'processing', 'approved', 'refused', 'withdrawn'];
const APP_STAGE = { preparing: 'visa_preparation', documents_pending: 'visa_preparation', ready: 'visa_preparation', submitted: 'visa_submitted', biometrics: 'visa_submitted', interview: 'visa_submitted', processing: 'visa_submitted', approved: 'visa_approved', refused: 'visa_refused' };

function base(staff) {
  // visa officers have "all" scope; counsellors see their students' cases
  return scope(knex('visa_cases as v'), staff, { owner: 'v.counsellor_id', branch: 'v.branch_id' })
    .join('students as s', 's.id', 'v.student_id').leftJoin('applications as a', 'a.id', 'v.application_id')
    .leftJoin('employees as oe', 'oe.id', 'v.officer_id').leftJoin('users as ou', 'ou.id', 'oe.user_id');
}
const COLS = ['v.*', 's.first_name', 's.last_name', 's.ref as student_ref', 'a.ref as application_ref', 'a.program_name', 'a.university_name', 'ou.name as officer_name'];

async function list(staff, params = {}) {
  const q = base(staff).select(COLS);
  if (STAGES.includes(params.stage)) q.where('v.stage', params.stage);
  else if (params.stage !== 'all') q.whereNotIn('v.stage', ['approved', 'refused', 'withdrawn']);
  if (/^[A-Z]{2}$/.test(params.country || '')) q.where('v.country_code', params.country);
  if (params.owner === 'me') q.where((w) => w.where('v.officer_id', staff.employee.id).orWhere('v.counsellor_id', staff.employee.id));
  return q.orderByRaw('COALESCE(v.interview_at, v.biometrics_at, v.travel_date) IS NULL, COALESCE(v.interview_at, v.biometrics_at, v.travel_date)').orderBy('v.updated_at', 'desc').limit(300);
}

async function get(staff, id) {
  const v = await base(staff).where('v.id', id).first(COLS);
  if (!v) throw E.notFound('Visa case');
  return v;
}

async function forStudent(staff, studentId) { return base(staff).where('v.student_id', studentId).select(COLS).orderBy('v.created_at', 'desc'); }

async function create(ctx, staff, { studentId, applicationId = null, countryCode, visaType = null, officerId = null, travelDate = null }) {
  const s = await studentsSvc.get(staff, studentId);
  if (applicationId && !(await knex('applications').where({ id: applicationId, student_id: s.id }).first('id'))) throw E.validation({ application_id: 'Choose a valid option.' });
  const ref = await people.newRef('visa_cases', 'V');
  const [id] = await knex('visa_cases').insert({ ref, student_id: s.id, application_id: applicationId, country_code: countryCode, visa_type: visaType, officer_id: officerId, travel_date: travelDate, counsellor_id: s.counsellor_id, branch_id: s.branch_id });
  await activity.log({ studentId: s.id, applicationId }, { type: 'visa', title: 'visa_created', meta: { ref, country: countryCode, visa_type: visaType }, actorId: ctx.userId, shareable: true });
  await audit.record(ctx, 'visa.created', { entityType: 'visa_case', entityId: id, newValues: { ref, student_id: s.id, country: countryCode } });
  await studentsSvc.advanceJourney(ctx, s.id, 'visa');
  await syncApplication(ctx, staff, applicationId, 'preparing');
  await events.emit('visa.created', { visaCaseId: id, studentId: s.id, by: ctx.userId });
  return id;
}

async function syncApplication(ctx, staff, applicationId, stage) {
  if (!applicationId || !APP_STAGE[stage]) return;
  const apps = require('./applications.service'); // eslint-disable-line global-require
  const target = await require('./stages').byKey(APP_STAGE[stage]); // eslint-disable-line global-require
  const app = await knex('applications as a').join('application_stages as st', 'st.id', 'a.stage_id').where('a.id', applicationId).first('a.id', 'st.position', 'a.status');
  if (target && app && app.status === 'open' && (app.position < target.position || ['visa_approved', 'visa_refused'].includes(target.key))) {
    await apps.moveStage(ctx, { ...staff, employee: { ...staff.employee, dataScope: 'all' } }, applicationId, target.id, { note: 'visa' });
  }
}

async function moveStage(ctx, staff, id, stage, { reason = null } = {}) {
  if (!STAGES.includes(stage)) throw E.validation({ stage: 'Choose a valid option.' });
  const v = await get(staff, id);
  if (v.stage === stage) return;
  if (stage === 'refused' && !reason) throw E.validation({ refusal_reason: 'Required.' });
  const upd = { stage, stage_entered_at: new Date(), updated_at: new Date() };
  if (stage === 'submitted' && !v.submitted_on) upd.submitted_on = new Date().toISOString().slice(0, 10);
  if (['approved', 'refused'].includes(stage)) upd.decision_on = new Date().toISOString().slice(0, 10);
  if (stage === 'refused') upd.refusal_reason = reason;
  await knex('visa_cases').where({ id }).update(upd);
  await activity.log({ studentId: v.student_id, applicationId: v.application_id }, { type: 'visa', title: 'visa_stage', body: stage === 'refused' ? reason : null, meta: { ref: v.ref, from: v.stage, to: stage }, actorId: ctx.userId, shareable: true });
  await audit.record(ctx, 'visa.stage_changed', { entityType: 'visa_case', entityId: id, oldValues: { stage: v.stage }, newValues: { stage } });
  await syncApplication(ctx, staff, v.application_id, stage);
  if (stage === 'approved') await studentsSvc.advanceJourney(ctx, v.student_id, 'pre_departure');
  await events.emit('visa.stage_changed', { visaCaseId: id, studentId: v.student_id, from: v.stage, to: stage, by: ctx.userId });
}

const EDITABLE = ['visa_type', 'application_number', 'submitted_on', 'biometrics_at', 'interview_at', 'medical', 'medical_on', 'travel_date', 'visa_expiry', 'officer_id', 'notes', 'country_code'];
async function update(ctx, staff, id, data) {
  const v = await get(staff, id);
  const before = await knex('visa_cases').where({ id }).first();
  const row = Object.fromEntries(Object.entries(data).filter(([k, val]) => EDITABLE.includes(k) && val !== undefined));
  const d = audit.diff(before, row);
  if (!d.changed) return false;
  await knex('visa_cases').where({ id }).update({ ...row, updated_at: new Date() });
  await audit.record(ctx, 'visa.updated', { entityType: 'visa_case', entityId: id, oldValues: d.oldValues, newValues: d.newValues });
  for (const k of ['biometrics_at', 'interview_at']) {
    if (d.newValues[k]) await activity.log({ studentId: v.student_id, applicationId: v.application_id }, { type: 'visa', title: `visa_${k}`, meta: { ref: v.ref, at: d.newValues[k] }, actorId: ctx.userId, shareable: true }); // eslint-disable-line no-await-in-loop
  }
  return true;
}

module.exports = { list, get, forStudent, create, moveStage, update, STAGES, APP_STAGE };
