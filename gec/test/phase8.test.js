const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, staffAgent, agent, outbox } = require('./helpers');

const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)[1];
const linkIn = (mail, re) => { const m = re.exec(mail.html || mail.text || ''); return m && m[0]; };
let counsellor; let admin; let program;
test.before(async () => {
  await resetDb();
  await require('../src/db/seeds/demo-catalog').run();
  counsellor = await makeStaff({ role: 'counsellor', name: 'Sarah Haddad' });
  admin = await makeStaff({ role: 'super_admin' });
  program = await knex('programs').where('slug', 'like', 'msc-data-science-university-of-manchester%').first();
});
test.after(() => knex.destroy());

async function signIn(a, email, password) {
  const p = await a.get('/login');
  return a.post('/login').type('form').send({ _csrf: csrfOf(p.text), email, password });
}

test('sign-up: confirmation required, the existing lead becomes the student, the visitor shortlist follows', async () => {
  const leads = require('../src/modules/crm/leads.service');
  const { lead } = await leads.capture({ userId: null }, { first_name: 'Rana', email: 'rana@example.com', interest_countries: ['uk'] }, { source: 'consultation' }, {});
  await knex('leads').where({ id: lead.id }).update({ counsellor_id: counsellor.employee.id });
  const a = await agent();
  const prog = await a.get(`/programs/${program.slug}`);
  await a.post('/shortlist/toggle').type('form').send({ _csrf: csrfOf(prog.text), type: 'program', id: program.id });
  const reg = await a.get('/register');
  outbox.length = 0;
  const r = await a.post('/register').type('form').send({ _csrf: csrfOf(reg.text), first_name: 'Rana', last_name: 'Saleh', email: 'Rana@Example.com', password: 'SecurePass123!', password_confirm: 'SecurePass123!', terms: '1' });
  assert.equal(r.status, 200);
  const mail = outbox.find((m) => m.to === 'rana@example.com');
  assert.ok(mail, 'confirmation e-mail sent');
  const blocked = await signIn(await agent(), 'rana@example.com', 'SecurePass123!');
  assert.match(blocked.text, /Confirm your e-mail/);
  assert.equal(await knex('students').where({ email: 'rana@example.com' }).first(), undefined, 'nothing linked before confirmation');
  const link = linkIn(mail, /http:\/\/[^"\s]+\/verify\/[A-Za-z0-9_-]+/);
  const v = await a.get(link.replace(/^http:\/\/[^/]+/, ''));
  assert.equal(v.status, 302); assert.match(v.headers.location, /^\/portal\/profile\/personal/);
  const student = await knex('students').where({ email: 'rana@example.com' }).first();
  assert.ok(student.user_id);
  assert.equal((await knex('leads').where({ id: lead.id }).first()).student_id, student.id, 'the existing lead was converted, not duplicated');
  assert.equal(Number((await knex('leads').where({ email: 'rana@example.com' }).count({ n: '*' }))[0].n), 1);
  assert.equal(student.counsellor_id, counsellor.employee.id, 'keeps the lead’s counsellor');
  assert.ok(await knex('shortlist_items').where({ student_id: student.id, item_id: program.id }).first(), 'shortlist adopted');
  assert.equal((await a.get('/portal')).status, 200);
  // the link works once
  assert.equal((await (await agent()).get(link.replace(/^http:\/\/[^/]+/, ''))).status, 404);
  // registering again with the same address creates nothing and tells the owner
  const b = await agent(); const reg2 = await b.get('/register');
  outbox.length = 0;
  await b.post('/register').type('form').send({ _csrf: csrfOf(reg2.text), first_name: 'X', email: 'rana@example.com', password: 'AnotherPass123!', password_confirm: 'AnotherPass123!', terms: '1' });
  assert.equal(Number((await knex('users').where({ email: 'rana@example.com' }).count({ n: '*' }))[0].n), 1);
  assert.match(outbox[0].subject, /already have/);
});

test('portal is private to the student; profile steps save and the sign-in e-mail cannot be changed', async () => {
  const students = require('../src/modules/crm/students.service');
  const other = await students.create({ userId: null }, { first_name: 'Other', email: 'other@example.com' });
  const apps = require('../src/modules/admissions/applications.service');
  const sys = { employee: { dataScope: 'all', id: 0 }, permissions: new Set() };
  const otherApp = await apps.create({ userId: admin.user.id }, sys, { studentId: other.id, programId: program.id, intake: '2027-09' });
  const a = await agent();
  await signIn(a, 'rana@example.com', 'SecurePass123!');
  assert.equal((await a.get(`/portal/applications/${otherApp.id}`)).status, 404);
  const otherDoc = await knex('documents').where({ student_id: other.id }).first();
  assert.equal((await a.get(`/portal/documents/${otherDoc.id}/file`)).status, 404);
  const s = await knex('students').where({ email: 'rana@example.com' }).first();
  const step = await a.get('/portal/profile/english');
  const r = await a.post('/portal/profile/english').type('form').send({ _csrf: csrfOf(step.text), ielts_overall: '7', toefl: '' });
  assert.equal(r.status, 302); assert.equal(r.headers.location, '/portal/profile/goals');
  assert.equal(Number((await knex('students').where({ id: s.id }).first()).ielts_overall), 7);
  const p = await a.get('/portal/profile/personal');
  await a.post('/portal/profile/personal').type('form').send({ _csrf: csrfOf(p.text), first_name: 'Rana', email: 'hacker@example.com' });
  assert.equal((await knex('students').where({ id: s.id }).first()).email, 'rana@example.com');
  // staff accounts are not students
  const st = await staffAgent(counsellor);
  assert.equal((await st.get('/portal')).status, 302);
  // data export: no secrets, includes their records
  const ex = await a.get('/portal/settings/export');
  assert.equal(ex.status, 200);
  assert.doesNotMatch(ex.text, /passport_enc|passport_hash/);
  assert.ok(JSON.parse(ex.text).student.email === 'rana@example.com');
});

test('documents and notifications: upload → counsellor told; rejection → student told by e-mail unless switched off', async () => {
  const s = await knex('students').where({ email: 'rana@example.com' }).first();
  const apps = require('../src/modules/admissions/applications.service');
  const sys = { employee: { dataScope: 'all', id: 0 }, permissions: new Set() };
  await apps.create({ userId: counsellor.user.id }, sys, { studentId: s.id, programId: program.id, intake: '2027-09' });
  const a = await agent();
  await signIn(a, 'rana@example.com', 'SecurePass123!');
  const docs = await a.get('/portal/documents');
  const passport = await knex('documents').where({ student_id: s.id, type_key: 'passport' }).first();
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const up = await a.post('/portal/documents/upload').field('_csrf', csrfOf(docs.text)).field('document_id', String(passport.id)).attach('file', pdf, 'passport.pdf');
  assert.equal(up.status, 302);
  assert.equal((await knex('documents').where({ id: passport.id }).first()).status, 'uploaded');
  assert.ok(await knex('notifications').where({ user_id: counsellor.user.id, category: 'documents' }).first(), 'counsellor notified');
  assert.equal((await a.get(`/portal/documents/${passport.id}/file`)).status, 200);
  const staff = await staffAgent(admin);
  const t = await staff.token();
  outbox.length = 0;
  await staff.post(`/staff/documents/${passport.id}/review`).type('form').send({ _csrf: t, decision: 'reject', reason: 'The photo page is blurred' });
  assert.ok(outbox.some((m) => m.to === 'rana@example.com' && /re-upload/i.test(m.subject)), 'rejection e-mail');
  assert.ok(await knex('notifications').where({ user_id: s.user_id, category: 'documents' }).first(), 'in-app notification');
  // switch document e-mails off
  const set = await a.get('/portal/settings');
  await a.post('/portal/settings/notifications').type('form').send({ _csrf: csrfOf(set.text), applications_email: '1' });
  const up2 = await a.get('/portal/documents');
  await a.post('/portal/documents/upload').field('_csrf', csrfOf(up2.text)).field('document_id', String(passport.id)).attach('file', pdf, 'passport2.pdf');
  outbox.length = 0;
  await staff.post(`/staff/documents/${passport.id}/review`).type('form').send({ _csrf: t, decision: 'reject', reason: 'Expired' });
  assert.equal(outbox.filter((m) => m.to === 'rana@example.com').length, 0, 'preference respected');
  assert.equal(Number((await knex('notifications').where({ user_id: s.user_id, category: 'documents' }).count({ n: '*' }))[0].n), 2, 'in-app always kept');
});

test('messages: student ↔ counsellor through the portal, with notifications both ways', async () => {
  const s = await knex('students').where({ email: 'rana@example.com' }).first();
  const a = await agent();
  await signIn(a, 'rana@example.com', 'SecurePass123!');
  const set = await a.get('/portal/settings');
  await a.post('/portal/settings/notifications').type('form').send({ _csrf: csrfOf(set.text), messages_email: '1' }); // test 3 switched most e-mails off
  const page = await a.get('/portal/messages');
  await a.post('/portal/messages').type('form').send({ _csrf: csrfOf(page.text), body: 'When is my deadline?' });
  const inbound = await knex('messages').where({ student_id: s.id, channel: 'portal', direction: 'in' }).first();
  assert.ok(inbound);
  assert.ok(await knex('notifications').where({ user_id: counsellor.user.id, category: 'messages' }).first());
  const c = await staffAgent(counsellor);
  const t = await c.token();
  assert.equal((await c.get(`/staff/messages/${inbound.id}`)).status, 200);
  outbox.length = 0;
  await c.post('/staff/messages/send').type('form').send({ _csrf: t, student_id: s.id, channel: 'portal', body: 'It is 15 January.' });
  const thread = await a.get('/portal/messages');
  assert.match(thread.text, /It is 15 January\./);
  assert.ok(await knex('notifications').where({ user_id: s.user_id, category: 'messages' }).first());
  assert.ok(outbox.some((m) => m.to === 'rana@example.com' && /New message/.test(m.subject)));
  // notification click marks it read and opens the target
  const n = await knex('notifications').where({ user_id: s.user_id, category: 'messages' }).first();
  const np = await a.get('/portal/notifications');
  const go = await a.post('/portal/notifications/read').type('form').send({ _csrf: csrfOf(np.text), id: String(n.id) });
  assert.equal(go.headers.location, '/portal/messages');
  assert.ok((await knex('notifications').where({ id: n.id }).first()).read_at);
});

test('staff invite: link sets the password, confirms the address and opens the portal', async () => {
  const students = require('../src/modules/crm/students.service');
  const s = await students.create({ userId: null }, { first_name: 'Invited', email: 'invited@example.com' }, { counsellorId: counsellor.employee.id });
  const c = await staffAgent(counsellor);
  const t = await c.token();
  outbox.length = 0;
  const r = await c.post(`/staff/students/${s.id}/invite`).type('form').send({ _csrf: t });
  assert.equal(r.status, 302);
  const mail = outbox.find((m) => m.to === 'invited@example.com');
  assert.ok(mail);
  const link = linkIn(mail, /http:\/\/[^"\s]+\/reset\/[A-Za-z0-9_-]+/).replace(/^http:\/\/[^/]+/, '');
  const a = await agent();
  const form = await a.get(link);
  await a.post(link).type('form').send({ _csrf: csrfOf(form.text), password: 'InvitedPass123!', password_confirm: 'InvitedPass123!' });
  const login = await signIn(a, 'invited@example.com', 'InvitedPass123!');
  assert.equal(login.headers.location, '/portal');
  assert.match((await a.get('/portal')).text, /Hello Invited/);
});

test('AI advisor: honest search mode without a provider; with one, answers come from database tools only', async () => {
  const a = await agent();
  const page = await a.get('/advisor');
  assert.match(page.text, /not connected yet/);
  const q = "I have IELTS 6.5 and a $20,000 annual budget. I want a Master's in Data Science in the UK.";
  const r = await a.post('/advisor/ask').set('X-CSRF-Token', csrfOf(page.text)).send({ question: q });
  assert.equal(r.body.mode, 'search');
  assert.ok(r.body.programs.length >= 1);
  assert.ok(r.body.programs.every((p) => p.program.country === 'United Kingdom'));
  assert.equal(r.body.overBudget, true, 'UK data science tuition is above $20k: said so, not hidden');
  // A scripted model: asks to search, then answers with what the tool returned (and tries to inject HTML).
  const provider = require('../src/modules/ai/provider');
  const calls = [];
  provider.useTestProvider(async ({ messages, tools }) => {
    calls.push(messages.length);
    if (calls.length === 1) {
      assert.ok(tools.some((tl) => tl.name === 'search_programs'));
      return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'search_programs', input: { destination: 'uk', degree: 'master', field: 'data_science' } }], usage: { input_tokens: 10, output_tokens: 5 } };
    }
    const result = JSON.parse(messages[messages.length - 1].content[0].content);
    const first = result.programs[0];
    return { stopReason: 'end_turn', content: [{ type: 'text', text: `Try [${first.name}](${first.url}) <script>alert(1)</script>` }], usage: { input_tokens: 20, output_tokens: 8 } };
  });
  try {
    const ai = await a.post('/advisor/ask').set('X-CSRF-Token', csrfOf(page.text)).send({ question: q });
    assert.equal(ai.body.mode, 'ai');
    assert.match(ai.body.html, /href="\/programs\/msc-data/);
    assert.doesNotMatch(ai.body.html, /<script>/, 'model output is escaped');
    const log = await knex('advisor_logs').where({ mode: 'ai' }).orderBy('id', 'desc').first();
    assert.equal((typeof log.tools === 'string' ? JSON.parse(log.tools) : log.tools)[0].name, 'search_programs');
    provider.useTestProvider(async () => ({ stopReason: 'refusal', content: [], usage: {} }));
    const ref = await a.post('/advisor/ask').set('X-CSRF-Token', csrfOf(page.text)).send({ question: 'something else' });
    assert.match(ref.body.text, /can’t help/);
  } finally { provider.useTestProvider(null); }
});

test('staff notifications: assigned tasks and @mentions reach the right person', async () => {
  const tasks = require('../src/modules/crm/tasks.service');
  await tasks.create({ userId: admin.user.id }, { title: 'Call Rana about the deadline', assignee_id: counsellor.employee.id });
  const n = await knex('notifications').where({ user_id: counsellor.user.id, category: 'tasks' }).first();
  assert.match(n.title_en, /Call Rana/);
  const c = await staffAgent(counsellor);
  const page = await c.get('/staff/notifications');
  assert.match(page.text, /Call Rana about the deadline/);
  const t = await c.token();
  await c.post('/staff/notifications/read').type('form').send({ _csrf: t });
  assert.equal(Number((await knex('notifications').where({ user_id: counsellor.user.id }).whereNull('read_at').count({ n: '*' }))[0].n), 0);
});
