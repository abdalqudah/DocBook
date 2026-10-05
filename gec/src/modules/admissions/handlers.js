// Reactions inside admissions: a new application builds the student's document checklist; when every checklist
// document is approved, applications waiting in "Documents Pending" move to "Documents Complete".
const knex = require('../../db/knex');
const events = require('../../core/events');
const documents = require('./documents.service');
const stages = require('./stages');

const SYSTEM = { employee: { dataScope: 'all', id: null }, permissions: new Set(), user: { id: null } };

events.on('application.created', async ({ application, by }) => {
  const program = application.program_id ? await knex('programs').where({ id: application.program_id }).first('degree_level') : null;
  await documents.ensureChecklist({ userId: by }, application.student_id, { degree: program ? program.degree_level : 'bachelor', applicationId: application.id });
});

events.on('documents.maybe_complete', async ({ studentId, ctx }) => {
  const open = await knex('documents').where({ student_id: studentId }).whereNot('status', 'approved').first('id');
  if (open) return;
  const pending = await stages.byKey('documents_pending');
  const complete = await stages.byKey('documents_complete');
  if (!pending || !complete) return;
  const apps = await knex('applications').where({ student_id: studentId, stage_id: pending.id, status: 'open' }).select('id');
  const svc = require('./applications.service'); // eslint-disable-line global-require
  for (const a of apps) await svc.moveStage(ctx || { userId: null }, SYSTEM, a.id, complete.id, { note: 'all documents approved' }); // eslint-disable-line no-await-in-loop
});

module.exports = { SYSTEM };
