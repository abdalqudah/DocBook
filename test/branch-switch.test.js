// A clinic with branches: the account menu lists the branches; choosing one makes it the calendar's and the
// appointments list's default (the page's own branch filter still wins); only this clinic's branches are accepted.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const scheduling = require('../src/modules/clinic/scheduling');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = `bs-${tag}@t.test`;
let app; let b; let branch; let other;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const u = await knex.transaction(async (trx) => { const id = await auth.createUser(trx, { name: 'Owner', email: mail, password: 'Passw0rd!x' }); await businesses.create(id, { name: `Main ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx); return id; });
  await knex('users').where({ id: u }).update({ email_verified_at: new Date() });
  b = (await knex('users').where({ id: u }).first('last_business_id')).last_business_id;
  await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date() });
  [branch] = await knex('clinic_branches').insert({ business_id: b, name: `العبدلي ${tag}`, is_active: true });
  const ob = (await knex('businesses').insert({ name: 'Other', slug: `bso${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }))[0];
  [other] = await knex('clinic_branches').insert({ business_id: ob, name: 'Not mine', is_active: true });
  const wh = JSON.stringify(scheduling.defaultWorkingHours());
  const [d1] = await knex('doctors').insert({ business_id: b, full_name: 'Dr Main', is_active: true, working_hours: wh, slot_duration_minutes: 30 });
  const [d2] = await knex('doctors').insert({ business_id: b, full_name: 'Dr Abdali', is_active: true, working_hours: wh, slot_duration_minutes: 30, branch_id: branch });
  const date = scheduling.clinicNow('Asia/Amman').date;
  const ap = { business_id: b, appointment_date: date, status: 'confirmed', appointment_type: 'in_person', source: 'staff' };
  await knex('appointments').insert([{ ...ap, doctor_id: d1, patient_name: 'Main Patient', appointment_time: '10:00' }, { ...ap, doctor_id: d2, branch_id: branch, patient_name: 'Abdali Patient', appointment_time: '11:00' }]);
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('the account menu switches the branch; the calendar and list follow it', async () => {
  const o = app.agent(); await o.login(mail);
  let r = await o.get('/app/appointments?view=list&lang=en');
  assert.match(r.text, /data-branch-switch/); assert.match(r.text, new RegExp(`العبدلي ${tag}`));
  assert.match(r.text, /Main Patient/); assert.match(r.text, /Abdali Patient/);
  r = await o.submit('/app/appointments?view=list', '/workspaces/branch', { branch: String(branch), return_to: '/app/appointments' });
  assert.equal(r.status, 302); assert.equal(r.location, '/app/appointments');
  r = await o.get('/app/appointments?view=list&lang=en');
  assert.match(r.text, /Abdali Patient/); assert.doesNotMatch(r.text, /Main Patient/);
  r = await o.get('/app/appointments?view=list&branch=&lang=en');
  assert.doesNotMatch(r.text, /Main Patient/, 'no branch filter on the page: the top bar decides');
  // another clinic's branch: refused
  r = await o.submit('/app/appointments?view=list', '/workspaces/branch', { branch: String(other) });
  assert.equal(r.status, 403);
  r = await o.submit('/app/appointments?view=list', '/workspaces/branch', { branch: 'main', return_to: '//evil.example/x' });
  assert.equal(r.location, '/app/appointments');
  r = await o.get('/app/appointments?view=list&lang=en');
  assert.match(r.text, /Main Patient/); assert.doesNotMatch(r.text, /Abdali Patient/);
});

test('Today and the reception board follow the branch; the top bar says which', async () => {
  const o = app.agent(); await o.login(mail);
  await o.submit('/app/appointments', '/workspaces/branch', { branch: String(branch) });
  let r = await o.get('/app/front-desk?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /Abdali Patient/); assert.doesNotMatch(r.text, /Main Patient/);
  assert.match(r.text, /data-branch-now/);
  r = await o.get('/app?lang=en');
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /Main Patient/);
  await o.submit('/app/appointments', '/workspaces/branch', { branch: '' });
  r = await o.get('/app/front-desk?lang=en');
  assert.match(r.text, /Abdali Patient/); assert.match(r.text, /Main Patient/); assert.doesNotMatch(r.text, /data-branch-now/);
});

test('the cash desk follows the branch: its receipts and its drawer; each branch closes its own drawer', async () => {
  const cashier = require('../src/modules/clinic/cashier.service'); // eslint-disable-line global-require
  const rbac = require('../src/modules/rbac/rbac.service'); // eslint-disable-line global-require
  const u = (await knex('users').where({ email: mail }).first('id')).id;
  const appts = await knex('appointments').where({ business_id: b }).whereIn('patient_name', ['Main Patient', 'Abdali Patient']).select('id', 'patient_name');
  const idOf = (n) => appts.find((x) => x.patient_name === n).id;
  await knex('invoices').insert([
    { business_id: b, appointment_id: idOf('Main Patient'), patient_name: 'Main Patient', amount: 10, payment_method: 'cash', invoice_number: 9101 },
    { business_id: b, appointment_id: idOf('Abdali Patient'), patient_name: 'Abdali Patient', amount: 25, payment_method: 'cash', invoice_number: 9102 },
  ]);
  const base = { businessId: b, userId: u, permissions: await rbac.getUserPermissions(b, u), currency: 'JOD', timezone: 'Asia/Amman', today: scheduling.clinicNow('Asia/Amman').date };
  const ab = { ...base, workBranch: String(branch) };
  const main = { ...base, workBranch: 'main' };
  assert.equal((await cashier.todayTotals(ab)).total, 25);
  assert.equal((await cashier.todayTotals(main)).total, 10);
  assert.equal((await cashier.todayTotals({ ...base, workBranch: '' })).total, 35);
  assert.equal((await cashier.openPeriod(ab)).expected, 25);
  await cashier.close(ab, { counted_cash: '25' });
  assert.equal((await cashier.openPeriod(ab)).expected, 0, 'the branch drawer is closed');
  assert.equal((await cashier.openPeriod(main)).expected, 10, 'the main branch drawer is not');
  assert.equal((await cashier.listClosings(main)).length, 0);
  assert.equal((await cashier.listClosings(ab)).length, 1);
  const o = app.agent(); await o.login(mail);
  await o.submit('/app/appointments', '/workspaces/branch', { branch: String(branch) });
  const r = await o.get('/app/cashier?lang=en');
  assert.equal(r.status, 200);
});

test('the branch has its own doctors and services; a new doctor goes to it; booking offers its doctors', async () => {
  const o = app.agent(); await o.login(mail);
  const docs = await knex('doctors').where({ business_id: b }).select('id', 'full_name');
  const id = (n) => docs.find((d) => d.full_name === n).id;
  await knex('services').insert([
    { business_id: b, name: 'Main cleaning', doctor_id: id('Dr Main'), price: 10, duration_minutes: 30, is_active: true },
    { business_id: b, name: 'Abdali whitening', doctor_id: id('Dr Abdali'), price: 50, duration_minutes: 30, is_active: true },
    { business_id: b, name: 'Clinic consult', doctor_id: null, price: 5, duration_minutes: 15, is_active: true },
  ]);
  await o.submit('/app/appointments', '/workspaces/branch', { branch: String(branch) });
  let r = await o.get('/app/doctors?lang=en');
  assert.match(r.text, /Dr Abdali/); assert.doesNotMatch(r.text, /Dr Main/);
  r = await o.get('/app/doctors/new?lang=en');
  assert.match(r.text, new RegExp(`<option value="${branch}" selected`), 'a new doctor goes to the branch');
  r = await o.get('/app/services?lang=en');
  assert.match(r.text, /Abdali whitening/); assert.match(r.text, /Clinic consult/); assert.doesNotMatch(r.text, /Main cleaning/);
  r = await o.get('/app/appointments/new?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /Dr Abdali/); assert.doesNotMatch(r.text, /Dr Main/);
  await o.submit('/app/appointments', '/workspaces/branch', { branch: '' });
  assert.match((await o.get('/app/doctors?lang=en')).text, /Dr Main/);
});

test('staff tied to a branch work there only; reports per branch; short names in the top bar', async () => {
  const o = app.agent(); await o.login(mail);
  // short names
  let r = await o.submit('/app/clinic/branches', '/app/clinic/branches/main-short', { short_name: 'الخالدي' });
  assert.equal(r.status, 302);
  r = await o.submit('/app/clinic/branches', `/app/clinic/branches/${branch}`, { name: `العبدلي ${tag}`, short_name: 'العبدلي' });
  assert.equal(r.status, 302);
  await o.submit('/app/appointments', '/workspaces/branch', { branch: 'main' });
  r = await o.get('/app/appointments?lang=en');
  assert.match(r.text, /data-branch-now[^>]*>[\s\S]{0,400}الخالدي/);
  // reports follow the branch
  await o.submit('/app/appointments', '/workspaces/branch', { branch: String(branch) });
  r = await o.get('/app/reports?lang=en');
  assert.equal(r.status, 200); assert.match(r.text, /العبدلي/);
  // a receptionist tied to the Abdali branch
  const role = await knex('roles').where({ business_id: b, key: 'receptionist' }).first('id');
  r = await o.submit('/app/clinic/team', '/app/clinic/team', { name: 'Reem Desk', email: `rd-${tag}@t.test`, role_id: String(role.id), mode: 'password', locale: 'en', work_branch: String(branch) });
  assert.equal(r.status, 302);
  const rm = await knex('memberships').where({ business_id: b }).whereIn('user_id', knex('users').where({ email: `rd-${tag}@t.test` }).select('id')).first();
  assert.equal(rm.work_branch, String(branch));
  r = await o.get('/app/clinic/team?lang=en');
  assert.match(r.text, /data-member-branch/);
  await knex('users').where({ email: `rd-${tag}@t.test` }).update({ password_hash: await require('bcryptjs').hash('Passw0rd!x', 4), must_change_password: false, email_verified_at: new Date() }); // eslint-disable-line global-require
  const rec = app.agent(); await rec.login(`rd-${tag}@t.test`);
  r = await rec.get('/app/front-desk?lang=en');
  assert.match(r.text, /Abdali Patient/); assert.doesNotMatch(r.text, /Main Patient/);
  assert.doesNotMatch(r.text, /data-branch-switch/, 'no switching for a member tied to a branch');
  r = await rec.submit('/app/front-desk', '/workspaces/branch', { branch: 'main' });
  assert.equal(r.status, 403);
});

test('branches kept apart: patients per branch (move, or both); a doctor\'s login works in its branch', async () => {
  const o = app.agent(); await o.login(mail);
  const [pm] = await knex('patients').insert({ business_id: b, full_name: `Pat Main ${tag}`, phone: '0791110001' });
  const [pa] = await knex('patients').insert({ business_id: b, full_name: `Pat Abdali ${tag}`, phone: '0791110002' });
  await knex('patient_branches').insert([{ business_id: b, patient_id: pm, branch_key: 'main' }, { business_id: b, patient_id: pa, branch_key: String(branch) }]);
  await o.submit('/app/appointments', '/workspaces/branch', { branch: String(branch) });
  let r = await o.get(`/app/patients?q=${encodeURIComponent(`Pat`)}&lang=en`);
  assert.match(r.text, new RegExp(`Pat Abdali ${tag}`)); assert.doesNotMatch(r.text, new RegExp(`Pat Main ${tag}`));
  assert.equal((await o.get(`/app/patients/${pm}`)).status, 404, 'another branch\'s patient is not opened');
  // a new patient added while in Abdali is Abdali's
  r = await o.submit('/app/patients/new', '/app/patients', { full_name: `Pat New ${tag}`, phone: '0791110003' });
  const pn = (await knex('patients').where({ business_id: b, full_name: `Pat New ${tag}` }).first('id')).id;
  assert.deepEqual(await knex('patient_branches').where({ patient_id: pn }).pluck('branch_key'), [String(branch)]);
  // move the Abdali patient to both
  r = await o.get(`/app/patients/${pa}?lang=en`);
  assert.match(r.text, /data-pt-branches/);
  r = await o.post(`/app/patients/${pa}/branches`, [['_csrf', o.csrf(r.text)], ['branches', 'main'], ['branches', String(branch)]]);
  assert.equal(r.status, 302);
  assert.deepEqual((await knex('patient_branches').where({ patient_id: pa }).pluck('branch_key')).sort(), [String(branch), 'main'].sort());
  r = await o.submit(`/app/patients/${pa}`, `/app/patients/${pa}/branches`, { branches: [] });
  assert.equal((await knex('patient_branches').where({ patient_id: pa }).count({ n: '*' }))[0].n, 2, 'at least one branch: nothing changed');
  // the calendar has no branch filter of its own
  r = await o.get('/app/appointments?lang=en');
  assert.doesNotMatch(r.text, /<select[^>]*name="branch"/);
  // a doctor's login: in its doctor's branch, no switching
  const role = await knex('roles').where({ business_id: b, key: 'doctor' }).first('id');
  const dAb = (await knex('doctors').where({ business_id: b, full_name: 'Dr Abdali' }).first('id')).id;
  r = await o.submit('/app/clinic/team', '/app/clinic/team', { name: 'Dr Abdali Login', email: `da-${tag}@t.test`, role_id: String(role.id), doctor_id: String(dAb), mode: 'password', locale: 'en' });
  await knex('users').where({ email: `da-${tag}@t.test` }).update({ password_hash: await require('bcryptjs').hash('Passw0rd!x', 4), must_change_password: false, email_verified_at: new Date() }); // eslint-disable-line global-require
  const doc = app.agent(); await doc.login(`da-${tag}@t.test`);
  r = await doc.get('/app/appointments?view=list&lang=en');
  assert.doesNotMatch(r.text, /data-branch-switch/);
  assert.equal((await doc.submit('/app/appointments', '/workspaces/branch', { branch: 'main' })).status, 403);
});
