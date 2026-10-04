// The medical centre's administration account, from sign-up: the centre's own menu and home (never a clinic's pages),
// doctors added as separate clinics (or "I am a doctor too" with the same login), shared costs split among the
// doctors' clinics only, the cash screen always the centre's, a shared receptionist landing on the shared reception.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const scheduling = require('../src/modules/clinic/scheduling');
const mailer = require('../src/core/mailer');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `cad-${k}-${tag}@t.test`;
let app; let admin; let A; let B; let Own;
mailer.configured = () => false;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('sign-up as a centre asks for the centre only and lands on the centre\'s home', async () => {
  const a = app.agent();
  const page = await a.get('/signup');
  assert.match(page.text, /data-clinic-only/);
  const r = await a.post('/signup', { _csrf: a.csrf(page.text), name: 'Rania Admin', email: mail('a'), password: 'Passw0rd!x-Long', account_type: 'center', center_name: 'مجمع النخبة', currency: 'JOD', timezone: 'Asia/Amman', terms: 'on' });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/app/center');
  const u = await knex('users').where({ email: mail('a') }).first();
  await knex('users').where({ id: u.id }).update({ email_verified_at: new Date() });
  A = u.last_business_id;
  const b = await knex('businesses').where({ id: A }).first();
  assert.equal(b.kind, 'center_admin');
  assert.equal(b.name, 'مجمع النخبة');
  // Without a centre name: refused.
  const z = app.agent();
  const p2 = await z.get('/signup');
  const bad = await z.post('/signup', { _csrf: z.csrf(p2.text), name: 'X', email: mail('z'), password: 'Passw0rd!x-Long', account_type: 'center', currency: 'JOD', timezone: 'Asia/Amman', terms: 'on' });
  assert.notEqual(bad.status, 302);
  assert.equal(await knex('users').where({ email: mail('z') }).first(), undefined);

  admin = app.agent(); await admin.login(mail('a'), 'Passw0rd!x-Long');
  const home = await admin.get('/app/center');
  assert.equal(home.status, 200);
  assert.match(home.text, /class="ctr-steps"/);
  for (const href of ['/app/center/doctors', '/app/center/desk', '/app/center/staff', '/app/center/expenses', '/app/center/settings']) assert.ok(home.text.includes(`href="${href}"`), href);
  assert.doesNotMatch(home.text, /href="\/app\/patients"/); // a clinic's menu is not shown
  assert.doesNotMatch(home.text, /href="\/app\/clinic\/branches"/);
  // A clinic's pages lead back to the centre.
  assert.equal((await admin.get('/app')).location, '/app/center');
  assert.equal((await admin.get('/app/patients')).location, '/app/center');
  assert.equal((await admin.get('/app/clinic/branches')).location, '/app/center');
  assert.equal((await admin.get('/app/onboarding')).location, '/app/center');
  for (const p of ['/app/center/doctors', '/app/center/staff', '/app/center/expenses', '/app/center/settings']) assert.equal((await admin.get(p)).status, 200, p);
});

test('doctors: each a separate clinic; "I am a doctor too" opens the admin\'s own clinic with the same login', async () => {
  const pg = await admin.get('/app/center/doctors');
  assert.match(pg.text, /name="is_me"/);
  let r = await admin.post('/app/center/doctors', { _csrf: admin.csrf(pg.text), doctor_name: 'Dr Basel', email: mail('b'), practice_name: 'عيادة العظام' });
  assert.equal(r.location, '/app/center/doctors');
  B = (await knex('users').where({ email: mail('b') }).first()).last_business_id;
  assert.equal((await knex('businesses').where({ id: B }).first()).center_share_cash, 1); // on the shared cash screen by default
  r = await admin.post('/app/center/doctors', { _csrf: admin.csrf(pg.text), is_me: '1', doctor_name: 'د. رانيا', practice_name: 'عيادة الجلدية' });
  assert.equal(r.status, 302);
  const u = await knex('users').where({ email: mail('a') }).first();
  assert.equal(u.last_business_id, A); // still lands on the centre
  Own = await knex('businesses').where({ name: 'عيادة الجلدية' }).orderBy('id', 'desc').first();
  assert.equal(Own.kind, 'clinic');
  const m = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.business_id': Own.id, 'm.user_id': u.id }).first('r.key', 'm.doctor_id');
  assert.equal(m.key, 'owner');
  assert.ok(m.doctor_id);
  // The list shows the two clinics, never the administration account.
  const list = await admin.get('/app/center/doctors');
  assert.match(list.text, /عيادة العظام/);
  assert.match(list.text, /عيادة الجلدية/);
  const ids = (await knex('businesses').where({ center_id: (await knex('businesses').where({ id: A }).first()).center_id })).map((x) => x.id);
  assert.ok(ids.includes(A) && ids.includes(B) && ids.includes(Own.id));
  // The admin switches to their own clinic like any other.
  const sw = await admin.post('/workspaces/switch', { _csrf: admin.csrf(list.text), business_id: String(Own.id) });
  assert.equal(sw.status, 302);
  assert.equal((await admin.get('/app/patients')).status, 200); // in their clinic now
  const back = await admin.get('/app/patients');
  await admin.post('/workspaces/switch', { _csrf: admin.csrf(back.text), business_id: String(A) });
  assert.equal((await admin.get('/app/patients')).location, '/app/center');
});

test('shared costs are split among the doctors\' clinics only; the cash screen is the centre\'s', async () => {
  const pg = await admin.get('/app/center/expenses');
  const r = await admin.post('/app/center/expenses', { _csrf: admin.csrf(pg.text), title: 'Rent', amount: '1000', category: 'rent', split_mode: 'equal' });
  assert.equal(r.location, '/app/center/expenses');
  const e = await knex('center_expenses').where({ title: 'Rent' }).orderBy('id', 'desc').first();
  const shares = await knex('center_expense_shares').where({ expense_id: e.id });
  assert.deepEqual(shares.map((s) => s.business_id).sort(), [B, Own.id].sort());
  assert.ok(shares.every((s) => Number(s.amount) === 500));
  // A visit of B, ready to pay, on the centre's cash screen (no "my clinic" scope for the administration).
  const [doc] = await knex('doctors').insert({ business_id: B, full_name: 'Dr Basel', is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()) });
  const [v] = await knex('appointments').insert({ business_id: B, doctor_id: doc, patient_name: 'Huda', patient_phone: '0790000000', appointment_date: scheduling.clinicNow('Asia/Amman').date, appointment_time: '10:00', duration_minutes: 20, status: 'completed', doctor_finished_at: new Date(), amount_due: 15 });
  const screen = await admin.get('/app/cashier/screen');
  assert.equal(screen.status, 200);
  assert.doesNotMatch(screen.text, /class="pos-scope"/);
  assert.match(screen.text, /pos-practices/);
  const data = JSON.parse((await admin.get('/app/cashier/screen/data')).text);
  assert.ok(data.visits.some((x) => x.id === v));
});

test('a shared receptionist of the centre lands on the shared reception', async () => {
  const pg = await admin.get('/app/center/staff');
  await admin.post('/app/center/staff', { _csrf: admin.csrf(pg.text), name: 'Hala', salary_monthly: '400', login_email: mail('r'), login_role: 'receptionist' });
  await knex('users').where({ email: mail('r') }).update({ must_change_password: false, email_verified_at: new Date() });
  const auth = require('../src/modules/auth/auth.service'); // eslint-disable-line global-require
  await knex('users').where({ email: mail('r') }).update({ password_hash: await auth.hashPassword('Passw0rd!x') });
  const r = app.agent(); await r.login(mail('r'));
  assert.equal((await r.get('/app')).location, '/app/center/desk');
  assert.equal((await r.get('/app/center/desk')).status, 200);
  assert.equal((await r.get('/app/center/expenses')).status, 403);
});
