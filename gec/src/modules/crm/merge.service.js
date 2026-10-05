// Safe merging of duplicate records. Everything linked to the duplicate (timeline, notes, tasks, applications,
// documents, appointments, payments…) moves to the record that is kept; empty fields of the kept record are filled
// from the duplicate; the duplicate is marked merged (not deleted) so links and the audit trail stay valid.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const activity = require('./activity.service');
const people = require('./people');

/** Every table with a lead_id / student_id column (discovered once from the schema). */
let linkCache = null;
async function linkedTables() {
  if (linkCache) return linkCache;
  const [rows] = await knex.raw("SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN ('lead_id', 'student_id')");
  const skip = new Set(['leads', 'students']);
  linkCache = { lead_id: [], student_id: [] };
  rows.forEach((r) => { if (!skip.has(r.t)) linkCache[r.c].push(r.t); });
  return linkCache;
}
const resetCache = () => { linkCache = null; };

const PERSON_FIELDS = ['last_name', 'email', 'phone', 'phone_tail', 'whatsapp', 'nationality', 'residence_country', 'city', 'counsellor_id', 'branch_id', 'visitor_id',
  'utm_source', 'utm_medium', 'utm_campaign', 'landing_page', 'referrer', 'first_visit_at'];
const fillEmpty = (keep, drop, fields) => Object.fromEntries(fields.filter((f) => (keep[f] === null || keep[f] === '' || keep[f] === undefined) && drop[f] !== null && drop[f] !== undefined && drop[f] !== '').map((f) => [f, drop[f]]));

async function mergeLeads(ctx, keepId, dropId) {
  if (Number(keepId) === Number(dropId)) throw E.validation({ merge: 'Choose two different records.' });
  const keep = await knex('leads').where({ id: keepId }).first();
  const drop = await knex('leads').where({ id: dropId }).first();
  if (!keep || !drop || keep.status === 'merged' || drop.status === 'merged') throw E.notFound('Lead');
  const tables = await linkedTables();
  await knex.transaction(async (trx) => {
    for (const t of tables.lead_id) await trx(t).where({ lead_id: drop.id }).update({ lead_id: keep.id }); // eslint-disable-line no-await-in-loop
    const fill = fillEmpty(keep, drop, [...PERSON_FIELDS, 'interest_degree', 'interest_field', 'interest_intake', 'budget_range', 'education_level', 'english_level', 'student_id']);
    if (drop.consent_marketing && !keep.consent_marketing && !keep.unsubscribed_at) Object.assign(fill, { consent_marketing: true, consent_marketing_at: drop.consent_marketing_at });
    fill.score = Math.max(keep.score, drop.score);
    await trx('leads').where({ id: keep.id }).update({ ...fill, updated_at: new Date() });
    await trx('leads').where({ id: drop.id }).update({ status: 'merged', merged_into_id: keep.id, updated_at: new Date() });
    await activity.log({ leadId: keep.id }, { type: 'merged', title: 'merged', meta: { from_kind: 'lead', from_ref: drop.ref, from_id: drop.id }, actorId: ctx.userId }, trx);
    await audit.record(ctx, 'lead.merged', { entityType: 'lead', entityId: keep.id, oldValues: { duplicate: drop.ref }, newValues: { kept: keep.ref, filled: Object.keys(fill) } }, trx);
  });
  return keep.id;
}

/** A lead that turns out to be an existing student: link and move its history. */
async function mergeLeadIntoStudent(ctx, studentId, leadId) {
  const student = await knex('students').where({ id: studentId }).first();
  const lead = await knex('leads').where({ id: leadId }).first();
  if (!student || !lead) throw E.notFound();
  await knex.transaction(async (trx) => {
    await trx('leads').where({ id: lead.id }).update({ student_id: student.id, updated_at: new Date() });
    const fill = fillEmpty(student, lead, PERSON_FIELDS);
    if (Object.keys(fill).length) await trx('students').where({ id: student.id }).update({ ...fill, updated_at: new Date() });
    await activity.log({ studentId: student.id, leadId: lead.id }, { type: 'merged', title: 'merged', meta: { from_kind: 'lead', from_ref: lead.ref, from_id: lead.id }, actorId: ctx.userId }, trx);
    await audit.record(ctx, 'student.lead_linked', { entityType: 'student', entityId: student.id, newValues: { lead: lead.ref } }, trx);
  });
  return student.id;
}

async function mergeStudents(ctx, keepId, dropId) {
  if (Number(keepId) === Number(dropId)) throw E.validation({ merge: 'Choose two different records.' });
  const keep = await knex('students').where({ id: keepId }).first();
  const drop = await knex('students').where({ id: dropId }).first();
  if (!keep || !drop || keep.merged_into_id || drop.merged_into_id) throw E.notFound('Student');
  if (keep.user_id && drop.user_id) throw E.conflict('BOTH_HAVE_ACCOUNTS', 'Both students have portal accounts. Disable one account first.');
  const tables = await linkedTables();
  await knex.transaction(async (trx) => {
    for (const t of tables.student_id) { // eslint-disable-line no-restricted-syntax
      if (t === 'shortlists' || t === 'student_shortlist') continue; // eslint-disable-line no-continue
      await trx(t).where({ student_id: drop.id }).update({ student_id: keep.id }); // eslint-disable-line no-await-in-loop
    }
    await trx('leads').where({ student_id: drop.id }).update({ student_id: keep.id });
    const fill = fillEmpty(keep, drop, [...PERSON_FIELDS, 'date_of_birth', 'gender', 'passport_enc', 'passport_hash', 'passport_last4', 'passport_expiry', 'education_level', 'institution',
      'major', 'gpa', 'gpa_scale', 'graduation_date', 'ielts_overall', 'ielts_min_band', 'toefl', 'pte', 'duolingo', 'english_test_date', 'pref_degree', 'budget_usd', 'pref_intake', 'user_id']);
    await trx('students').where({ id: drop.id }).update({ merged_into_id: keep.id, status: 'closed', user_id: null, updated_at: new Date() });
    await trx('students').where({ id: keep.id }).update({ ...fill, updated_at: new Date() });
    await activity.log({ studentId: keep.id }, { type: 'merged', title: 'merged', meta: { from_kind: 'student', from_ref: drop.ref, from_id: drop.id }, actorId: ctx.userId }, trx);
    await audit.record(ctx, 'student.merged', { entityType: 'student', entityId: keep.id, oldValues: { duplicate: drop.ref }, newValues: { kept: keep.ref, filled: Object.keys(fill).filter((k) => !/passport/.test(k)) } }, trx);
  });
  return keep.id;
}

module.exports = { mergeLeads, mergeLeadIntoStudent, mergeStudents, linkedTables, resetCache, fullName: people.fullName };
