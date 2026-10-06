// Phase 10 security regressions: account takeover through reset links, data scope after reassignment, duplicate
// lookups, course registrations, notes published to the portal, cross-record links and redirects.
const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, staffAgent, outbox } = require('./helpers');

let superAdmin; let admin; let manager; let counsellorA; let counsellorB; let sales; let instructor; let other;
let student; let app;
const form = async (a, url, body) => { const t = await a.token(); return a.post(url).type('form').send({ _csrf: t, ...body }); };
test.before(async () => {
  await resetDb();
  superAdmin = await makeStaff({ role: 'super_admin' });
  admin = await makeStaff({ role: 'admin' });
  manager = await makeStaff({ role: 'branch_manager' });
  counsellorA = await makeStaff({ role: 'counsellor', name: 'Counsellor A' });
  counsellorB = await makeStaff({ role: 'counsellor', name: 'Counsellor B' });
  sales = await makeStaff({ role: 'sales' });
  instructor = await makeStaff({ role: 'instructor' });
  other = await makeStaff({ role: 'instructor' });
  const stage = (await knex('lead_stages').orderBy('id').first()).id;
  const [sid] = await knex('students').insert({ ref: 'S-SEC001', first_name: 'Maha', last_name: 'Saleh', email: 'maha@example.com', counsellor_id: counsellorA.employee.id, branch_id: counsellorA.employee.branch_id });
  await knex('leads').insert({ ref: 'L-SEC001', stage_id: stage, first_name: 'Maha', email: 'maha@example.com', student_id: sid, counsellor_id: sales.employee.id, source: 'website' });
  student = await knex('students').where({ id: sid }).first();
  const a = await staffAgent(counsellorA);
  await form(a, '/staff/applications', { student_id: sid, program_name: 'MSc Data Science', university_name: 'Demo University', intake: '2027-09' });
  app = await knex('applications').where({ student_id: sid }).first();
});
test.after(() => knex.destroy());

test('reset links: an Admin cannot take over a Super Admin or another Admin; links go by e-mail', async () => {
  const a = await staffAgent(admin);
  const t = await a.token();
  const before = Number((await knex('password_resets').count({ n: '*' }))[0].n);
  const r = await a.post(`/staff/employees/${superAdmin.employee.id}/reset-link`).type('form').send({ _csrf: t });
  assert.notEqual(r.status, 302);
  const admin2 = await makeStaff({ role: 'admin' });
  await a.post(`/staff/employees/${admin2.employee.id}/reset-link`).type('form').send({ _csrf: t });
  assert.equal(Number((await knex('password_resets').count({ n: '*' }))[0].n), before, 'no reset token created for higher or equal accounts');
  outbox.length = 0;
  const ok = await a.post(`/staff/employees/${counsellorB.employee.id}/reset-link`).type('form').send({ _csrf: t });
  assert.equal(ok.status, 302);
  assert.ok(outbox.some((m) => m.to === counsellorB.user.email), 'the link is e-mailed to the employee');
  const page = await a.get(ok.headers.location);
  assert.doesNotMatch(page.text, /\/staff\/reset\//, 'and not shown to the admin when e-mail works');
  const s = await staffAgent(superAdmin);
  const sa = await form(s, `/staff/employees/${admin2.employee.id}/reset-link`, {});
  assert.equal(sa.status, 302, 'a Super Admin can');
});

test('reassigning a student moves applications, visa cases and the converted lead with them', async () => {
  const vo = await staffAgent(await makeStaff({ role: 'visa_officer' }));
  await form(vo, `/staff/students/${student.id}/visa`, { country_code: 'GB', visa_type: 'Student visa' });
  const visa = await knex('visa_cases').where({ student_id: student.id }).first();
  const a = await staffAgent(counsellorA);
  assert.equal((await a.get(`/staff/applications/${app.id}`)).status, 200);
  const m = await staffAgent(manager);
  await form(m, `/staff/students/${student.id}/assign`, { counsellor_id: String(counsellorB.employee.id) });
  assert.equal((await a.get(`/staff/applications/${app.id}`)).status, 404, 'old counsellor loses the application');
  assert.notEqual((await a.get(`/staff/visa/${visa.id}`)).status, 200, 'and the visa case');
  const b = await staffAgent(counsellorB);
  assert.equal((await b.get(`/staff/applications/${app.id}`)).status, 200, 'new counsellor sees it');
  assert.equal((await knex('applications').where({ id: app.id }).first()).counsellor_id, counsellorB.employee.id);
  const lead = await knex('leads').where({ student_id: student.id }).first();
  assert.equal(lead.counsellor_id, counsellorB.employee.id, 'converted lead follows the student');
  const sl = await staffAgent(sales);
  assert.equal((await sl.get(`/staff/leads/${lead.id}`)).status, 404, 'the previous lead owner no longer reads the student');
  // Messages follow the student, not the lead
  await knex('leads').where({ id: lead.id }).update({ counsellor_id: sales.employee.id });
  await knex('messages').insert({ channel: 'portal', direction: 'in', student_id: student.id, lead_id: lead.id, body: 'Private question from Maha', status: 'received' });
  const inbox = await sl.get('/staff/messages');
  assert.doesNotMatch(inbox.text, /Private question from Maha/);
  const leadPage = await sl.get(`/staff/leads/${lead.id}`);
  assert.equal(leadPage.status, 200);
  await form(b, `/staff/students/${student.id}/notes`, { body: 'Internal: family finances discussed' });
  assert.doesNotMatch((await sl.get(`/staff/leads/${lead.id}`)).text, /family finances/, 'student notes are not shown on the old lead');
  await knex('leads').where({ id: lead.id }).update({ counsellor_id: counsellorB.employee.id });
});

test('duplicate checks do not reveal people outside the data scope', async () => {
  const a = await staffAgent(counsellorA);
  const r = await form(a, '/staff/students', { first_name: 'Probe', email: 'maha@example.com' });
  assert.equal(r.status, 409);
  assert.doesNotMatch(r.text, /Saleh|S-SEC001/, 'no name or reference of the other team’s student');
  assert.match(r.text, /another team/);
  const b = await staffAgent(counsellorB);
  const r2 = await form(b, '/staff/students', { first_name: 'Probe', email: 'maha@example.com' });
  assert.match(r2.text, /S-SEC001/, 'the owner still sees the match');
});

test('instructors manage only their own courses', async () => {
  const [mine] = await knex('courses').insert({ slug: 'ielts-mine', name_en: 'IELTS prep', instructor_id: instructor.employee.id });
  const [theirs] = await knex('courses').insert({ slug: 'ielts-theirs', name_en: 'IELTS advanced', instructor_id: other.employee.id });
  const [rid] = await knex('course_registrations').insert({ ref: 'CR-SEC1', course_id: theirs, name: 'Someone', email: 'someone@example.com', payment_status: 'unpaid' });
  const i = await staffAgent(instructor);
  assert.equal((await i.get(`/staff/courses/${mine}/registrations`)).status, 200);
  assert.equal((await i.get(`/staff/courses/${theirs}/registrations?format=csv`)).status, 404);
  await form(i, `/staff/courses/registrations/${rid}`, { payment_status: 'paid' });
  assert.equal((await knex('course_registrations').where({ id: rid }).first()).payment_status, 'unpaid');
});

test('notes: view-only staff cannot publish to the portal; moderators stay within scope', async () => {
  const sl = await staffAgent(sales);
  // sales can view this student only if in scope — give them a student of their own branch scope via a new record
  const [sid] = await knex('students').insert({ ref: 'S-SEC002', first_name: 'Nour', counsellor_id: sales.employee.id, branch_id: sales.employee.branch_id });
  await form(sl, `/staff/students/${sid}/notes`, { body: 'Hello from sales', shareable: '1' });
  const n = await knex('notes').where({ student_id: sid }).first();
  assert.ok(n, 'internal note added'); assert.equal(n.is_shareable, 0, 'internal only');
  // A branch manager of another branch cannot delete notes on records outside their branch
  const [otherBranch] = await knex('branches').insert({ name: 'Other branch' });
  const farManager = await makeStaff({ role: 'branch_manager', branchId: otherBranch });
  const [noteId] = await knex('notes').insert({ student_id: student.id, author_id: counsellorB.user.id, body: 'Keep me' });
  const fm = await staffAgent(farManager);
  await form(fm, `/staff/notes/${noteId}/delete`, {});
  assert.ok(await knex('notes').where({ id: noteId }).first(), 'note kept');
});

test('a document request or task cannot point at another student’s application', async () => {
  const [sid] = await knex('students').insert({ ref: 'S-SEC003', first_name: 'Other', counsellor_id: counsellorB.employee.id, branch_id: counsellorB.employee.branch_id });
  const b = await staffAgent(counsellorB);
  const t = await b.token();
  await b.post(`/staff/students/${sid}/documents/request`).type('form').send({ _csrf: t, type_key: 'passport', application_id: String(app.id) });
  assert.equal(await knex('documents').where({ student_id: sid, application_id: app.id }).first(), undefined);
  await b.post(`/staff/students/${sid}/tasks`).type('form').send({ _csrf: t, title: 'Linked elsewhere', application_id: String(app.id) });
  const task = await knex('tasks').where({ title: 'Linked elsewhere' }).first();
  assert.ok(task); assert.equal(task.application_id, null);
});

test('safe back-redirects never leave the site', () => {
  const { safeBack } = require('../src/middleware/errors');
  const req = (referer) => ({ get: (h) => (h === 'referer' ? referer : 'gec.test') });
  assert.equal(safeBack(req('https://gec.test//evil.example/x'), '/staff'), '/staff');
  assert.equal(safeBack(req('https://evil.example/staff'), '/staff'), '/staff');
  assert.equal(safeBack(req('https://gec.test/staff/leads?x=1'), '/'), '/staff/leads?x=1');
});
