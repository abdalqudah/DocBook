const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, staffAgent, agent, outbox } = require('./helpers');

const form = async (a, url, body) => { const t = await a.token(); return a.post(url).type('form').send({ _csrf: t, ...body }); };
const publicToken = async (a, url) => /name="_csrf" value="([^"]+)"/.exec((await a.get(url)).text)[1];
let finance; let admissions;
test.before(async () => {
  await resetDb(); await require('../src/db/seeds/demo-catalog').run();
  finance = await makeStaff({ role: 'finance' }); admissions = await makeStaff({ role: 'admissions_manager' });
});
test.after(() => knex.destroy());

async function partnerAgent(link, email, password = 'PartnerPass123!') {
  const a = await agent();
  const path = new URL(link).pathname;
  let t = await publicToken(a, path);
  assert.equal((await a.post(path).type('form').send({ _csrf: t, password, password_confirm: password })).status, 302);
  t = await publicToken(a, '/partner/login');
  const r = await a.post('/partner/login').type('form').send({ _csrf: t, email, password });
  assert.equal(r.headers.location, '/partner');
  a.token = async () => publicToken(a, '/partner/team');
  return a;
}

let partner; let uniId; let programId;
test('website: a university asks to join; partnerships staff approve with GEC margin and the contact is invited', async () => {
  const v = await agent();
  const page = await v.get('/for-universities?lang=en');
  assert.equal(page.status, 200);
  assert.match(page.text, /Become a partner/);
  let t = await publicToken(v, '/for-universities');
  await v.post('/for-universities').type('form').send({ _csrf: t, university_name: 'Spam U', contact_name: 'Bot', email: 'bot@x.test', consent: '1', company_url: 'http://spam' });
  assert.equal(await knex('partner_applications').where({ university_name: 'Spam U' }).first(), undefined, 'honeypot');
  t = await publicToken(v, '/for-universities');
  const r = await v.post('/for-universities').type('form').send({ _csrf: t, university_name: 'Northbridge University', country_code: 'GB', city: 'Leeds', website: 'https://northbridge.example', contact_name: 'Sara Admissions', job_title: 'International Officer', email: 'sara@northbridge.example', consent: '1' });
  assert.equal(r.status, 302);
  const a = await knex('partner_applications').where({ email: 'sara@northbridge.example' }).first();
  assert.equal(a.status, 'new');

  const f = await staffAgent(finance);
  assert.match((await f.get('/staff/partner-requests')).text, /Northbridge University/);
  const before = outbox.length;
  await form(f, `/staff/partner-requests/${a.id}/approve`, { university_id: 'new', commission_type: 'percent', commission_rate: '12' });
  const done = await knex('partner_applications').where({ id: a.id }).first();
  assert.equal(done.status, 'approved');
  uniId = done.university_id;
  const uni = await knex('universities').where({ id: uniId }).first();
  assert.equal(uni.partner_status, 'active');
  assert.equal(uni.is_active, 0, 'new universities stay hidden until staff publish them');
  const p = await knex('partners').where({ university_id: uniId }).first();
  assert.equal(Number(p.commission_rate), 12);
  const mail = outbox.slice(before).find((m) => m.to === 'sara@northbridge.example');
  assert.ok(mail, 'invitation e-mail');
  const link = /https?:\/\/[^"\s]+\/partner\/reset\/[A-Za-z0-9_-]+/.exec(mail.html)[0];
  partner = await partnerAgent(link, 'sara@northbridge.example');

  // Only partnerships staff see the requests.
  const c = await staffAgent(await makeStaff({ role: 'counsellor' }));
  assert.equal((await c.get('/staff/partner-requests')).status, 403);
});

test('partner portal: university staff submit a program; nothing is public until GEC approves it with a margin', async () => {
  const home = await partner.get('/partner?lang=en');
  assert.equal(home.status, 200);
  assert.match(home.text, /Northbridge University/);
  assert.match(home.text, /12%/);
  const r = await form(partner, '/partner/programs', { name_en: 'MSc Coastal Robotics', name_ar: 'ماجستير علم البيانات', degree_level: 'master', field: 'computer_science', study_mode: 'on_campus', currency: 'GBP', tuition_fee: '20000', intakes: ['9', '1'], min_ielts: '6.5', internship: 'optional', documents_required: 'Transcript\nCV', is_active: '1' });
  assert.equal(r.status, 302);
  assert.equal(await knex('programs').where({ name_en: 'MSc Coastal Robotics' }).first(), undefined, 'not published yet');
  const sub = await knex('partner_submissions').where({ university_id: uniId, entity: 'program' }).first();
  assert.equal(sub.status, 'pending');

  // Invalid input comes back with errors, nothing stored.
  const bad = await form(partner, '/partner/programs', { name_en: 'x', degree_level: 'nope' });
  assert.equal(bad.status, 422);

  const s = await staffAgent(admissions);
  const q = await s.get('/staff/partner-submissions');
  assert.match(q.text, /MSc Coastal Robotics/);
  const view = await s.get(`/staff/partner-submissions/${sub.id}`);
  assert.equal(view.status, 200);
  await form(s, `/staff/partner-submissions/${sub.id}`, { action: 'approve', commission_type: 'percent', commission_rate: '15' });
  const prog = await knex('programs').where({ name_en: 'MSc Coastal Robotics' }).first();
  assert.ok(prog, 'published');
  programId = prog.id;
  assert.equal(prog.university_id, uniId);
  assert.equal(prog.commission_type, 'percent');
  assert.equal(Number(prog.commission_rate), 15);
  assert.deepEqual((typeof prog.intakes === 'string' ? JSON.parse(prog.intakes) : prog.intakes).map(Number).sort((x, y) => x - y), [1, 9]);
  assert.ok(prog.tuition_usd > 0);
  assert.equal((await knex('partner_submissions').where({ id: sub.id }).first()).status, 'approved');
  assert.ok(outbox.some((m) => m.to === 'sara@northbridge.example' && /live/i.test(m.subject)));

  // The program margin overrides the university agreement when the student enrols.
  const [stId] = await knex('students').insert({ ref: 'S-P14001', first_name: 'Lina', last_name: 'Haddad', nationality: 'JO' });
  const st = { id: stId };
  const stage = await knex('application_stages').first('id');
  const [appId] = await knex('applications').insert({ ref: 'APP-T14', student_id: st.id, university_id: uniId, program_id: programId, stage_id: stage.id, tuition_fee: 20000, currency: 'GBP' });
  const cid = await require('../src/modules/finance/partners').expectFor(await knex('applications').where({ id: appId }).first());
  const c = await knex('commissions').where({ id: cid }).first();
  assert.equal(Number(c.expected_amount), 3000);
  assert.match(c.basis, /program rate/);
  const apps = await partner.get('/partner/applications?lang=ar');
  assert.match(apps.text, /Lina H\./);
  assert.doesNotMatch(apps.text, /Haddad/, 'surname initial only');
  for (const u of ['/partner', '/partner/programs', '/partner/scholarships/new', '/partner/profile', '/partner/submissions', '/partner/team']) assert.equal((await partner.get(`${u}?lang=ar`)).status, 200, u);
});

test('partner edits: reviewers see the diff, can ask for changes (note required), and partners stay inside their university', async () => {
  await form(partner, `/partner/programs/${programId}`, { name_en: 'MSc Coastal Robotics', degree_level: 'master', field: 'computer_science', study_mode: 'online', internship: 'optional', currency: 'GBP', tuition_fee: '21000', is_active: '1' });
  const sub = await knex('partner_submissions').where({ entity_id: programId, status: 'pending' }).first();
  assert.ok(sub);
  const s = await staffAgent(admissions);
  const view = await s.get(`/staff/partner-submissions/${sub.id}?lang=en`);
  assert.match(view.text, /class="changed"[\s\S]*21000/);
  await form(s, `/staff/partner-submissions/${sub.id}`, { action: 'changes_requested', review_note: '' });
  assert.equal((await knex('partner_submissions').where({ id: sub.id }).first()).status, 'pending', 'a note is required');
  await form(s, `/staff/partner-submissions/${sub.id}`, { action: 'changes_requested', review_note: 'Please confirm the online fee.' });
  assert.equal((await knex('partner_submissions').where({ id: sub.id }).first()).status, 'changes_requested');
  assert.equal((await knex('programs').where({ id: programId }).first()).study_mode, 'on_campus', 'live record untouched');
  assert.match((await partner.get(`/partner/programs/${programId}?lang=en`)).text, /Please confirm the online fee/);

  // Another university's program is out of reach.
  const other = await knex('programs').whereNot({ university_id: uniId }).first('id');
  assert.equal((await partner.get(`/partner/programs/${other.id}`)).status, 404);
  await form(partner, `/partner/programs/${other.id}`, { name_en: 'Hijack', degree_level: 'master', field: 'computer_science', internship: 'none' });
  assert.equal(await knex('partner_submissions').where({ entity_id: other.id }).first(), undefined);
  // Partners are not staff, and staff/students do not get into the partner portal.
  assert.equal((await partner.get('/staff')).headers.location, '/staff/login');
  const f = await staffAgent(finance);
  assert.equal((await f.get('/partner')).headers.location, '/partner/login');
});

test('profile changes and team: owner invites a colleague; staff can disable partner accounts', async () => {
  await form(partner, '/partner/profile', { description_en: 'A research university in Leeds.', website: 'https://northbridge.example' });
  const sub = await knex('partner_submissions').where({ university_id: uniId, entity: 'university', status: 'pending' }).first();
  assert.ok(sub);
  const s = await staffAgent(admissions);
  await form(s, `/staff/partner-submissions/${sub.id}`, { action: 'approve' });
  const u = await knex('universities').where({ id: uniId }).first();
  assert.equal(u.description_en, 'A research university in Leeds.');
  assert.equal(u.contact_email, 'sara@northbridge.example', 'fields the form did not send are left alone');

  await form(partner, '/partner/team', { name: 'Omar Editor', email: 'omar@northbridge.example' });
  const m = await knex('partner_members as m').join('users as u', 'u.id', 'm.user_id').where('u.email', 'omar@northbridge.example').first('m.role', 'm.university_id', 'u.id');
  assert.equal(m.role, 'editor');
  assert.equal(m.university_id, uniId);

  const f = await staffAgent(finance);
  assert.match((await f.get('/staff/partner-accounts')).text, /omar@northbridge\.example/);
  await form(f, `/staff/partner-accounts/${m.id}/status`, {});
  assert.equal((await knex('users').where({ id: m.id }).first()).status, 'disabled');
});
