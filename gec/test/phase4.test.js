const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, staffAgent } = require('./helpers');

let counsellor; let other; let admin; let student; let program; let lead;
test.before(async () => {
  await resetDb();
  await require('../src/db/seeds/demo-catalog').run();
  counsellor = await makeStaff({ role: 'counsellor', name: 'Lina Mansour' });
  other = await makeStaff({ role: 'counsellor', name: 'Other Counsellor' });
  admin = await makeStaff({ role: 'admin' });
  const leads = require('../src/modules/crm/leads.service');
  const students = require('../src/modules/crm/students.service');
  ({ lead } = await leads.capture({ userId: null }, { first_name: 'Sami', email: 'sami@example.com', interest_degree: 'master', interest_countries: ['uk'] }, { source: 'consultation' }, {}));
  await knex('leads').where({ id: lead.id }).update({ counsellor_id: counsellor.employee.id });
  const staffCtx = { employee: { dataScope: 'all' }, permissions: new Set() };
  student = await students.convertLead({ userId: null }, staffCtx, lead.id);
  program = await knex('programs').where('slug', 'like', 'msc-data-science-university-of-manchester%').first();
});
test.after(() => knex.destroy());

test('creating an application builds the checklist, moves the journey and the lead forward', async () => {
  const a = await staffAgent(counsellor);
  const t = await a.token();
  const r = await a.post('/staff/applications').type('form').send({ _csrf: t, student_id: student.id, program_id: program.id, intake: '2027-09', stage_key: 'documents_pending' });
  assert.equal(r.status, 302);
  const app = await knex('applications').where({ student_id: student.id }).first();
  assert.equal(app.university_name, 'The University of Manchester');
  assert.equal(app.counsellor_id, counsellor.employee.id);
  const docs = await knex('documents').where({ student_id: student.id });
  assert.ok(docs.length >= 8 && docs.every((d) => d.status === 'missing'), 'master checklist created');
  assert.equal((await knex('students').where({ id: student.id }).first()).journey_stage, 'documents');
  const l = await knex('leads as l').join('lead_stages as s', 's.id', 'l.stage_id').where('l.id', lead.id).first('s.key');
  assert.equal(l.key, 'documents_requested');
  const dup = await a.post('/staff/applications').type('form').send({ _csrf: t, student_id: student.id, program_id: program.id, intake: '2027-09' });
  assert.equal(dup.status, 302);
  assert.equal((await knex('applications').where({ student_id: student.id })).length, 1, 'no duplicate open application');
  // another counsellor cannot see it
  const o = await staffAgent(other);
  assert.equal((await o.get(`/staff/applications/${app.id}`)).status, 404);
});

test('documents: upload validated by content, review, and auto-complete moves the application', async () => {
  const a = await staffAgent(counsellor);
  const t = await a.token();
  const app = await knex('applications').where({ student_id: student.id }).first();
  const fake = await a.post(`/staff/students/${student.id}/documents/upload`).field('_csrf', t).field('type_key', 'passport').attach('file', Buffer.from('<html><script>alert(1)</script></html>'), 'passport.pdf');
  assert.equal(fake.status, 302);
  assert.equal((await knex('documents').where({ student_id: student.id, type_key: 'passport' }).first()).status, 'missing', 'a fake PDF is refused');
  const noCsrf = await a.post(`/staff/students/${student.id}/documents/upload`).field('type_key', 'passport').attach('file', Buffer.from('%PDF-1.4 test'), 'p.pdf');
  assert.equal(noCsrf.status, 302);
  assert.equal((await knex('documents').where({ student_id: student.id, type_key: 'passport' }).first()).status, 'missing', 'refused without the CSRF token');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const docs = await knex('documents').where({ student_id: student.id });
  for (const d of docs) {
    const r = await a.post(`/staff/students/${student.id}/documents/upload`).field('_csrf', t).field('document_id', String(d.id)).attach('file', pdf, `${d.type_key}.pdf`); // eslint-disable-line no-await-in-loop
    assert.equal(r.status, 302);
  }
  assert.ok((await knex('documents').where({ student_id: student.id })).every((d) => d.status === 'uploaded' && d.media_id));
  // counsellors cannot verify
  const one = docs[0];
  assert.equal((await a.post(`/staff/documents/${one.id}/review`).type('form').send({ _csrf: t, decision: 'approve' })).status, 403);
  // files are scoped
  const o = await staffAgent(other);
  assert.equal((await o.get(`/staff/documents/${one.id}/file`)).status, 404);
  const file = await a.get(`/staff/documents/${one.id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-type'], 'application/pdf');
  assert.match(file.headers['content-disposition'], /attachment/);
  // an admissions manager reviews everything
  const am = await staffAgent(await makeStaff({ role: 'admissions_manager' }));
  const at = await am.token();
  const rej = await am.post(`/staff/documents/${one.id}/review`).type('form').send({ _csrf: at, decision: 'reject' });
  assert.equal(rej.status, 302);
  assert.equal((await knex('documents').where({ id: one.id }).first()).status, 'uploaded', 'reject needs a reason');
  await am.post(`/staff/documents/${one.id}/review`).type('form').send({ _csrf: at, decision: 'reject', reason: 'Blurred scan' });
  assert.equal((await knex('documents').where({ id: one.id }).first()).status, 'rejected');
  await a.post(`/staff/students/${student.id}/documents/upload`).field('_csrf', t).field('document_id', String(one.id)).attach('file', pdf, 'again.pdf');
  const again = await knex('documents').where({ id: one.id }).first();
  assert.equal(again.status, 'uploaded');
  assert.equal(again.version, 2);
  for (const d of await knex('documents').where({ student_id: student.id })) {
    await am.post(`/staff/documents/${d.id}/review`).type('form').send({ _csrf: at, decision: 'approve', expiry_date: d.type_key === 'passport' ? '2031-01-01' : '' }); // eslint-disable-line no-await-in-loop
  }
  const stage = await knex('applications as a').join('application_stages as s', 's.id', 'a.stage_id').where('a.id', app.id).first('s.key');
  assert.equal(stage.key, 'documents_complete', 'all approved → Documents Complete');
});

test('stage moves record history, set dates, and an offer notifies through events', async () => {
  const events = require('../src/core/events');
  const seen = [];
  events.on('application.offer_received', ({ application }) => { seen.push(application.id); });
  const a = await staffAgent(counsellor);
  const t = await a.token();
  const app = await knex('applications').where({ student_id: student.id }).first();
  const st = async (key) => (await knex('application_stages').where({ key }).first()).id;
  await a.post(`/staff/applications/${app.id}/stage`).type('form').send({ _csrf: t, stage_id: await st('submitted') });
  await a.post(`/staff/applications/${app.id}/stage`).type('form').send({ _csrf: t, stage_id: await st('conditional_offer'), note: 'IELTS condition' });
  const after = await knex('applications').where({ id: app.id }).first();
  assert.ok(after.submitted_at && after.offer_received_at);
  assert.equal(after.offer_type, 'conditional');
  assert.deepEqual(seen, [app.id]);
  const hist = await knex('application_stage_history').where({ application_id: app.id }).orderBy('id');
  assert.ok(hist.length >= 4);
  assert.equal((await knex('students').where({ id: student.id }).first()).journey_stage, 'offer');
  assert.equal((await knex('leads as l').join('lead_stages as s', 's.id', 'l.stage_id').where('l.id', lead.id).first('s.key')).key, 'offer_received');
  const close = await a.post(`/staff/applications/${app.id}/stage`).type('form').send({ _csrf: t, stage_id: await st('closed') });
  assert.equal(close.status, 302);
  assert.equal((await knex('applications').where({ id: app.id }).first()).status, 'open', 'closing needs a reason');
  // Kanban API
  const api = await a.patch(`/api/applications/${app.id}/stage`).set('X-CSRF-Token', t).send({ stage_id: await st('unconditional_offer') });
  assert.equal(api.status, 200);
  assert.equal(api.body.application.offer_type, 'unconditional');
});

test('visa case: officer workflow syncs the application and the journey', async () => {
  const vo = await staffAgent(await makeStaff({ role: 'visa_officer' }));
  const t = await vo.token();
  const app = await knex('applications').where({ student_id: student.id }).first();
  const r = await vo.post(`/staff/students/${student.id}/visa`).type('form').send({ _csrf: t, country_code: 'GB', visa_type: 'Student visa', application_id: app.id });
  assert.equal(r.status, 302);
  const v = await knex('visa_cases').where({ student_id: student.id }).first();
  assert.equal(v.stage, 'preparing');
  assert.equal((await knex('applications as a').join('application_stages as s', 's.id', 'a.stage_id').where('a.id', app.id).first('s.key')).key, 'visa_preparation');
  const save = await vo.post(`/staff/visa/${v.id}`).type('form').send({ _csrf: t, visa_type: 'Student visa', interview_at: '2027-07-01T10:30', medical: 'required' });
  assert.equal(save.status, 302);
  assert.ok((await knex('visa_cases').where({ id: v.id }).first()).interview_at);
  const refuse = await vo.post(`/staff/visa/${v.id}/stage`).type('form').send({ _csrf: t, stage: 'refused' });
  assert.equal(refuse.status, 302);
  assert.equal((await knex('visa_cases').where({ id: v.id }).first()).stage, 'preparing', 'refusal needs a reason');
  await vo.post(`/staff/visa/${v.id}/stage`).type('form').send({ _csrf: t, stage: 'submitted' });
  await vo.post(`/staff/visa/${v.id}/stage`).type('form').send({ _csrf: t, stage: 'approved' });
  const after = await knex('visa_cases').where({ id: v.id }).first();
  assert.equal(after.stage, 'approved');
  assert.ok(after.decision_on);
  assert.equal((await knex('applications as a').join('application_stages as s', 's.id', 'a.stage_id').where('a.id', app.id).first('s.key')).key, 'visa_approved');
  assert.equal((await knex('students').where({ id: student.id }).first()).journey_stage, 'pre_departure');
  // finance cannot manage visas
  const fin = await staffAgent(await makeStaff({ role: 'finance' }));
  assert.equal((await fin.get(`/staff/visa/${v.id}`)).status, 403);
});

test('expired documents are flagged by the daily job', async () => {
  const documents = require('../src/modules/admissions/documents.service');
  const d = await knex('documents').where({ student_id: student.id, type_key: 'passport' }).first();
  await knex('documents').where({ id: d.id }).update({ expiry_date: '2020-01-01' });
  const n = await documents.expireDue();
  assert.equal(n, 1);
  assert.equal((await knex('documents').where({ id: d.id }).first()).status, 'expired');
});

test('pipeline settings: rename and add a stage; built-in keys stay', async () => {
  const sa = await staffAgent(await makeStaff({ role: 'super_admin' }));
  const t = await sa.token();
  const rows = await knex('application_stages').orderBy('position');
  const body = { _csrf: t, new_name_en: 'Interview Prep', new_position: '9' };
  rows.forEach((r) => { body[`name_en_${r.id}`] = r.key === 'submitted' ? 'Sent to university' : r.name_en; body[`position_${r.id}`] = r.position; body[`tone_${r.id}`] = r.tone; body[`is_active_${r.id}`] = '1'; });
  const res = await sa.post('/staff/settings/pipeline/applications').type('form').send(body);
  assert.equal(res.status, 302);
  assert.equal((await knex('application_stages').where({ key: 'submitted' }).first()).name_en, 'Sent to university');
  assert.ok(await knex('application_stages').where({ name_en: 'Interview Prep' }).first());
  void admin;
});
