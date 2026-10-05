const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, agent, staffAgent } = require('./helpers');

test.before(resetDb);
test.after(() => knex.destroy());

const arr = (v) => (Array.isArray(v) ? v : JSON.parse(v || '[]'));
async function publicToken(a) { const r = await a.get('/book'); return /name="_csrf" value="([^"]+)"/.exec(r.text)[1]; }
const BOOK = { first_name: 'Ahmad', last_name: 'Masri', email: 'ahmad@example.com', phone: '+962 79 123 4567', residence_country: 'JO', interest_countries: 'uk', interest_degree: 'master', interest_field: 'Data Science', interest_intake: '2027-09', budget_range: '20_35', consent_contact: '1', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'uk-masters' };

let c1; let c2;
test('setup counsellors', async () => {
  c1 = await makeStaff({ role: 'counsellor', name: 'Sarah Haddad' });
  c2 = await makeStaff({ role: 'counsellor', name: 'Omar Khalil' });
});

test('consultation form creates an assigned lead with attribution and timeline', async () => {
  const a = await agent();
  const token = await publicToken(a);
  const r = await a.post('/book').type('form').send({ ...BOOK, _csrf: token });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/book/thanks');
  const lead = await knex('leads').where({ email: 'ahmad@example.com' }).first();
  assert.ok(lead);
  assert.equal(lead.source, 'consultation');
  assert.equal(lead.utm_source, 'google');
  assert.equal(lead.utm_campaign, 'uk-masters');
  assert.equal(lead.phone_tail, '791234567');
  assert.ok([c1.employee.id, c2.employee.id].includes(lead.counsellor_id), 'round-robin assigned a counsellor');
  assert.deepEqual(arr(lead.interest_countries), ['uk']);
  const acts = await knex('activities').where({ lead_id: lead.id }).pluck('type');
  assert.ok(acts.includes('created') && acts.includes('assigned'));
});

test('a returning enquiry from the same person updates the open lead instead of duplicating it', async () => {
  const a = await agent();
  const token = await publicToken(a);
  await a.post('/book').type('form').send({ ...BOOK, email: '', phone: '0791234567', interest_countries: 'canada', utm_source: 'facebook', _csrf: token });
  const rows = await knex('leads').where('phone_tail', '791234567');
  assert.equal(rows.length, 1);
  assert.deepEqual(arr(rows[0].interest_countries).sort(), ['canada', 'uk']);
  assert.equal(rows[0].utm_source, 'google', 'first touch kept');
  assert.equal(rows[0].latest_utm_source, 'facebook', 'latest touch updated');
});

test('round-robin alternates between counsellors', async () => {
  const a = await agent();
  const token = await publicToken(a);
  await a.post('/book').type('form').send({ ...BOOK, email: 'b1@example.com', phone: '+1 555 000 0001', _csrf: token });
  await a.post('/book').type('form').send({ ...BOOK, email: 'b2@example.com', phone: '+1 555 000 0002', _csrf: token });
  const owners = (await knex('leads').whereIn('email', ['b1@example.com', 'b2@example.com']).pluck('counsellor_id'));
  assert.notEqual(owners[0], owners[1]);
});

test('consent is required; honeypot submissions are dropped silently', async () => {
  const a = await agent();
  const token = await publicToken(a);
  const r = await a.post('/book').type('form').send({ ...BOOK, email: 'noconsent@example.com', phone: '', consent_contact: '', _csrf: token });
  assert.equal(r.status, 422);
  assert.equal(await knex('leads').where({ email: 'noconsent@example.com' }).first(), undefined);
  const bot = await a.post('/book').type('form').send({ ...BOOK, email: 'bot@example.com', website: 'http://spam', _csrf: token });
  assert.equal(bot.status, 302);
  assert.equal(await knex('leads').where({ email: 'bot@example.com' }).first(), undefined);
});

test('data scope: a counsellor only sees their own leads (list, page, palette, API)', async () => {
  const lead = await knex('leads').where({ email: 'ahmad@example.com' }).first();
  const owner = lead.counsellor_id === c1.employee.id ? c1 : c2;
  const other = owner === c1 ? c2 : c1;
  const oa = await staffAgent(owner);
  const xa = await staffAgent(other);
  assert.equal((await oa.get(`/staff/leads/${lead.id}`)).status, 200);
  assert.equal((await xa.get(`/staff/leads/${lead.id}`)).status, 404);
  assert.equal((await xa.get(`/api/leads/${lead.id}`).set('Accept', 'application/json')).status, 404);
  const list = await xa.get('/staff/leads?q=Ahmad');
  assert.doesNotMatch(list.text, /ahmad@example\.com/);
  const pal = await xa.get('/staff/api/palette?q=Ahmad').set('Accept', 'application/json');
  assert.ok(!JSON.stringify(pal.body).includes(`/staff/leads/${lead.id}"`));
  const token = await xa.token();
  const move = await xa.patch(`/api/leads/${lead.id}/stage`).set('X-CSRF-Token', token).send({ stage_id: 2 });
  assert.equal(move.status, 404);
  const admin = await staffAgent(await makeStaff({ role: 'admin' }));
  assert.equal((await admin.get(`/staff/leads/${lead.id}`)).status, 200);
});

test('Kanban API: moving a stage is logged; Lost needs a reason', async () => {
  const lead = await knex('leads').where({ email: 'ahmad@example.com' }).first();
  const owner = lead.counsellor_id === c1.employee.id ? c1 : c2;
  const a = await staffAgent(owner);
  const token = await a.token();
  const contacted = await knex('lead_stages').where({ key: 'contacted' }).first();
  const r = await a.patch(`/api/leads/${lead.id}/stage`).set('X-CSRF-Token', token).send({ stage_id: contacted.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.lead.stage_id, contacted.id);
  assert.ok(r.body.lead.first_contacted_at, 'reaching Contacted counts as first contact');
  const noToken = await a.patch(`/api/leads/${lead.id}/stage`).send({ stage_id: contacted.id });
  assert.equal(noToken.status, 419);
  const lost = await knex('lead_stages').where({ key: 'lost' }).first();
  const bad = await a.patch(`/api/leads/${lead.id}/stage`).set('X-CSRF-Token', token).send({ stage_id: lost.id });
  assert.equal(bad.status, 422);
  assert.ok(await knex('activities').where({ lead_id: lead.id, type: 'stage' }).first());
  assert.ok(await knex('audit_logs').where({ action: 'lead.stage_changed', entity_id: String(lead.id) }).first());
});

test('convert to student, profile completion, encrypted passport with audited reveal', async () => {
  const lead = await knex('leads').where({ email: 'ahmad@example.com' }).first();
  const owner = lead.counsellor_id === c1.employee.id ? c1 : c2;
  const a = await staffAgent(owner);
  let token = await a.token();
  const r = await a.post(`/staff/leads/${lead.id}/convert`).type('form').send({ _csrf: token });
  assert.equal(r.status, 302);
  const s = await knex('students').where({ email: 'ahmad@example.com' }).first();
  assert.ok(s);
  assert.equal(s.counsellor_id, owner.employee.id);
  assert.deepEqual(arr(s.pref_fields), ['data_science']);
  assert.equal(s.utm_campaign, 'uk-masters', 'attribution carried over');
  token = await a.token();
  const p = await a.post(`/staff/students/${s.id}/profile/personal`).type('form').send({ _csrf: token, first_name: 'Ahmad', last_name: 'Masri', email: 'ahmad@example.com', phone: '+962791234567', nationality: 'JO', residence_country: 'JO', date_of_birth: '2001-02-03', passport: 'N1234567' });
  assert.equal(p.status, 302);
  const s2 = await knex('students').where({ id: s.id }).first();
  assert.equal(s2.passport_last4, '4567');
  assert.ok(s2.passport_enc && !s2.passport_enc.includes('N1234567'));
  const rev = await a.post(`/staff/students/${s.id}/passport`).set('X-CSRF-Token', token).set('Accept', 'application/json');
  assert.equal(rev.body.passport, 'N1234567');
  assert.ok(await knex('audit_logs').where({ action: 'student.passport_viewed', entity_id: String(s.id) }).first());
  // completing the rest of the profile moves the journey to counselling
  for (const [section, body] of [
    ['academic', { education_level: 'bachelor', major: 'CS', gpa: '3.4', gpa_scale: '4', graduation_date: '2024-06-30' }],
    ['english', { ielts_overall: '7', ielts_min_band: '6.5' }],
    ['goals', { pref_countries: 'uk', pref_fields: 'data_science', pref_degree: 'master', budget_usd: '30000', pref_intake: '2027-09' }],
  ]) {
    const x = await a.post(`/staff/students/${s.id}/profile/${section}`).type('form').send({ _csrf: token, ...body }); // eslint-disable-line no-await-in-loop
    assert.equal(x.status, 302, section);
  }
  const s3 = await knex('students').where({ id: s.id }).first();
  assert.equal(s3.journey_stage, 'counselling');
  const bad = await a.post(`/staff/students/${s.id}/profile/academic`).type('form').send({ _csrf: token, gpa: '5', gpa_scale: '4' });
  assert.equal(bad.status, 422);
});

test('duplicates are detected and leads can be merged safely', async () => {
  const admin = await staffAgent(await makeStaff({ role: 'admin' }));
  let token = await admin.token();
  const r1 = await admin.post('/staff/leads').type('form').send({ _csrf: token, first_name: 'Dana', email: 'dana@example.com', counsellor_id: '' });
  assert.equal(r1.status, 302);
  const dup = await admin.post('/staff/leads').type('form').send({ _csrf: token, first_name: 'Dana', last_name: 'K', email: 'DANA@example.com', counsellor_id: '' });
  assert.equal(dup.status, 409, 'warned about the duplicate');
  const forced = await admin.post('/staff/leads').type('form').send({ _csrf: token, first_name: 'Dana', last_name: 'K', email: 'dana@example.com', counsellor_id: '', confirm_duplicate: '1' });
  assert.equal(forced.status, 302);
  const [a, b] = await knex('leads').where({ email: 'dana@example.com' }).orderBy('id');
  await knex('tasks').insert({ title: 'call dana', lead_id: b.id });
  token = await admin.token();
  const m = await admin.post(`/staff/leads/${a.id}/merge`).type('form').send({ _csrf: token, other_id: b.id, other_kind: 'lead', keep: 'self' });
  assert.equal(m.status, 302);
  const after = await knex('leads').where({ id: b.id }).first();
  assert.equal(after.status, 'merged');
  assert.equal(after.merged_into_id, a.id);
  assert.equal((await knex('tasks').where({ title: 'call dana' }).first()).lead_id, a.id);
  assert.equal((await knex('leads').where({ id: a.id }).first()).last_name, 'K', 'empty field filled from the duplicate');
  const counsellor = await staffAgent(c1);
  const t2 = await counsellor.token();
  assert.equal((await counsellor.post(`/staff/leads/${a.id}/merge`).type('form').send({ _csrf: t2, other_id: b.id })).status, 403);
});

test('tasks: recurring task creates the next occurrence when completed', async () => {
  const a = await staffAgent(c1);
  const token = await a.token();
  const r = await a.post('/staff/tasks').type('form').send({ _csrf: token, title: 'Weekly check-in', due_at: '2026-10-07T10:00', recurrence: 'weekly', priority: 'high' });
  assert.equal(r.status, 302);
  const task = await knex('tasks').where({ title: 'Weekly check-in' }).first();
  assert.equal(task.assignee_id, c1.employee.id);
  await a.post(`/staff/tasks/${task.id}/status`).type('form').send({ _csrf: token, status: 'completed' });
  const next = await knex('tasks').where({ title: 'Weekly check-in', previous_id: task.id }).first();
  assert.ok(next, 'next occurrence created');
  assert.equal(next.status, 'todo');
  assert.ok(new Date(next.due_at) > new Date(task.due_at));
  const other = await staffAgent(c2);
  const t2 = await other.token();
  assert.equal((await other.post(`/staff/tasks/${next.id}/status`).type('form').send({ _csrf: t2, status: 'completed' })).status, 404, 'cannot touch others\' tasks');
});

test('notes resolve @mentions', async () => {
  const notes = require('../src/modules/crm/notes.service');
  const ids = await notes.resolveMentions('Please call back @Omar Khalil and ask @Sarah about IELTS');
  assert.deepEqual(ids.sort(), [c1.employee.id, c2.employee.id].sort());
});

test('employees: admins cannot create super admins; disabling ends sessions', async () => {
  const admin = await staffAgent(await makeStaff({ role: 'admin' }));
  const token = await admin.token();
  const sup = await knex('roles').where({ key: 'super_admin' }).first();
  const r = await admin.post('/staff/employees').type('form').send({ _csrf: token, name: 'Evil', email: 'evil@gec.test', role_id: sup.id, mode: 'invite', locale: 'en' });
  assert.equal(r.status, 403);
  const role = await knex('roles').where({ key: 'sales' }).first();
  const ok = await admin.post('/staff/employees').type('form').send({ _csrf: token, name: 'New Sales', email: 'sales.new@gec.test', role_id: role.id, mode: 'invite', locale: 'en', is_counsellor: '0', auto_assign: '0' });
  assert.equal(ok.status, 302);
  const u = await knex('users').where({ email: 'sales.new@gec.test' }).first();
  assert.equal(u.status, 'invited');
  assert.ok(await knex('password_resets').where({ user_id: u.id }).first(), 'invitation link created');
  const victim = await makeStaff({ role: 'counsellor' });
  const va = await staffAgent(victim);
  assert.equal((await va.get('/staff')).status, 200);
  await admin.post(`/staff/employees/${victim.employee.id}/status`).type('form').send({ _csrf: token, status: 'disabled' });
  assert.equal((await va.get('/staff')).status, 302);
});

test('lead export is permission-checked and CSV-injection safe', async () => {
  await knex('leads').where({ email: 'b1@example.com' }).update({ first_name: '=HYPERLINK("x")' });
  const admin = await staffAgent(await makeStaff({ role: 'admin' }));
  const csv = await admin.get('/staff/leads/export.csv?status=all');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /'=HYPERLINK/);
  const fin = await staffAgent(await makeStaff({ role: 'finance' }));
  assert.equal((await fin.get('/staff/leads/export.csv')).status, 403);
});
