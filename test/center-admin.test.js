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

test('the shared reception works for any doctor\'s clinic: calendar, booking, a blocked time, a surgery', async () => {
  const r = app.agent(); await r.login(mail('r'));
  const date = new Date(Date.parse(`${scheduling.clinicNow('Asia/Amman').date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10); // tomorrow: every time still open
  // The calendar opens for the centre's first clinic, with a switch to every clinic of the centre.
  let cal = await r.get('/app/appointments');
  assert.equal(cal.status, 200);
  assert.match(cal.text, /class="act-bar"/);
  assert.match(cal.text, /عيادة العظام/);
  assert.match(cal.text, /عيادة الجلدية/);
  assert.ok(cal.text.includes('href="/app/appointments"'), 'menu item');
  cal = await r.get(`/app/appointments?practice=${B}&date=${date}`);
  assert.match(cal.text, new RegExp(`href="/app/appointments\\?practice=${B}[^"]*" class="is-on"`));
  const doc = (await knex('doctors').where({ business_id: B }).first('id')).id;
  // Booking with Dr Basel: the visit belongs to Dr Basel's clinic, audited there by the receptionist.
  const form = await r.get(`/app/appointments/new?doctor=${doc}&date=${date}`);
  assert.equal(form.status, 200);
  let res = await r.post('/app/appointments/new', { _csrf: r.csrf(form.text), doctor_id: String(doc), patient_name: 'Sami Desk', patient_phone: '0791112223', appointment_date: date, appointment_time: '13:00', duration_minutes: '20', appointment_type: 'in_person' });
  assert.equal(res.status, 302, res.text && res.text.slice(0, 400));
  const booked = await knex('appointments').where({ patient_name: 'Sami Desk', business_id: B }).orderBy('id', 'desc').first();
  assert.equal(booked.business_id, B);
  const u = await knex('users').where({ email: mail('r') }).first('id');
  assert.ok(await knex('audit_logs').where({ business_id: B, user_id: u.id }).first('id'));
  // A blocked time and a surgery for the doctor.
  res = await r.post('/app/appointments/blocks', { _csrf: r.csrf(form.text), doctor_id: String(doc), appointment_date: date, appointment_time: '11:00', duration_minutes: '30', notes: 'meeting' });
  assert.equal(res.status, 302, res.text && res.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').match(/.{0,200}(error|alert|تعارض|conflict).{0,200}/i)?.[0]);
  assert.ok(await knex('appointments').where({ business_id: B, appointment_type: 'blocked', appointment_time: '11:00' }).first('id'));
  res = await r.post('/app/appointments/blocks', { _csrf: r.csrf(form.text), doctor_id: String(doc), appointment_date: date, appointment_time: '12:00', duration_minutes: '60', kind: 'surgery', patient_name: 'Sami Desk', patient_phone: '0791112223', procedure_name: 'Arthroscopy' });
  assert.equal(res.status, 302, res.text && res.text.slice(0, 400));
  assert.ok(await knex('surgeries').where({ business_id: B, procedure_name: 'Arthroscopy' }).first('id'));
  assert.equal((await r.get('/app/surgeries')).status, 200);
  // Never another centre's clinic (the choice falls back to this centre's), never the clinic's patient records.
  const [other] = await knex('businesses').insert({ name: 'Elsewhere', slug: `else-${tag}`, currency: 'JOD', timezone: 'Asia/Amman', status: 'active' });
  const away = await r.get(`/app/appointments?practice=${other}`);
  assert.equal(away.status, 200);
  assert.doesNotMatch(away.text, /Elsewhere/);
  assert.notEqual((await r.get('/app/appointments')).text.includes(`practice=${other}" class="is-on"`), true);
  assert.equal((await r.get('/app/patients')).location, '/app/center/desk');
  // The centre's own pages are unchanged by the choice.
  assert.equal((await r.get('/app/center/desk')).status, 200);
});

test('a shared expense for all the clinics or for one clinic — on the centre page and on the cash screen', async () => {
  const pg = await admin.get('/app/center/expenses');
  assert.match(pg.text, /value="one"/);
  let r = await admin.post('/app/center/expenses', { _csrf: admin.csrf(pg.text), title: 'X-ray film', amount: '90', category: 'medical_supplies', split_mode: 'one', for_practice: String(B) });
  assert.equal(r.location, '/app/center/expenses');
  let e = await knex('center_expenses').where({ title: 'X-ray film' }).orderBy('id', 'desc').first();
  assert.equal(e.split_mode, 'one');
  assert.deepEqual((await knex('center_expense_shares').where({ expense_id: e.id })).map((s) => [s.business_id, Number(s.amount)]), [[B, 90]]);
  // A clinic outside the centre: refused, nothing saved.
  const [other] = await knex('businesses').insert({ name: 'Out', slug: `out-${tag}`, currency: 'JOD', timezone: 'Asia/Amman', status: 'active' });
  await admin.post('/app/center/expenses', { _csrf: admin.csrf(pg.text), title: 'Sneaky', amount: '5', split_mode: 'one', for_practice: String(other) });
  assert.equal(await knex('center_expenses').where({ title: 'Sneaky' }).first(), undefined);
  // The cash screen: the dialog asks who the expense is for, and saves without leaving the page (JSON).
  const screen = await admin.get('/app/cashier/screen');
  assert.match(screen.text, /name="for_practice"/);
  assert.match(screen.text, /data-pos-expense/);
  const csrf = admin.csrf(screen.text);
  r = await admin.post('/app/cashier/screen/expense', { _csrf: csrf, title: 'Water', amount: '12', category: 'utilities', for_practice: String(Own.id) }, { accept: 'application/json' });
  assert.equal(r.status, 200, r.text);
  assert.equal(JSON.parse(r.text).ok, true);
  e = await knex('center_expenses').where({ title: 'Water' }).orderBy('id', 'desc').first();
  assert.deepEqual((await knex('center_expense_shares').where({ expense_id: e.id })).map((s) => s.business_id), [Own.id]);
  r = await admin.post('/app/cashier/screen/expense', { _csrf: csrf, title: 'Internet', amount: '30', category: 'utilities', for_practice: 'all' }, { accept: 'application/json' });
  assert.equal(JSON.parse(r.text).ok, true);
  e = await knex('center_expenses').where({ title: 'Internet' }).orderBy('id', 'desc').first();
  assert.equal((await knex('center_expense_shares').where({ expense_id: e.id })).length, 2);
  r = await admin.post('/app/cashier/screen/expense', { _csrf: csrf, title: '', amount: '30' }, { accept: 'application/json' });
  assert.equal(r.status, 422);
  assert.equal(JSON.parse(r.text).ok, false);
});

test('the centre\'s website: every doctor of its clinics, booking and doctor pages on each doctor\'s own site', async () => {
  const centre = await knex('businesses').where({ id: A }).first('slug', 'center_id');
  const b = await knex('businesses').where({ id: B }).first('slug');
  const doc = (await knex('doctors').where({ business_id: B }).first('id')).id;
  // The administration account manages the centre's website (its own menu item).
  const home = await admin.get('/app/center');
  assert.ok(home.text.includes('href="/app/website"'));
  assert.equal((await admin.get('/app/website')).status, 200);
  // Public pages.
  const pub = app.agent();
  const site = await pub.get(`/${centre.slug}`);
  assert.equal(site.status, 200);
  assert.match(site.text, /Dr Basel/);
  const book = await pub.get(`/${centre.slug}/book`);
  assert.equal(book.status, 200);
  assert.match(book.text, /Dr Basel/);
  assert.ok(new RegExp(`href="/${b.slug}/book\\?doctor=(dr-|doctor-)[a-z0-9-]*"`).test(book.text));
  assert.equal((await pub.get(`/${centre.slug}/book?doctor=${doc}`)).location, `/${b.slug}/book?doctor=${doc}`);
  assert.match((await pub.get(`/${centre.slug}/doctors/${doc}`)).location, new RegExp(`^/${b.slug}/doctors/(dr-|doctor-)`));
  // A doctor of another clinic (outside the centre) is never reached through the centre's site.
  const [out] = await knex('businesses').insert({ name: 'Away', slug: `away-${tag}`, currency: 'JOD', timezone: 'Asia/Amman', status: 'active' });
  const [far] = await knex('doctors').insert({ business_id: out, full_name: 'Dr Far', is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()) });
  assert.equal((await pub.get(`/${centre.slug}/doctors/${far}`)).status, 404);
  assert.equal((await pub.get(`/${centre.slug}/book?doctor=${far}`)).location, null);
  // Each doctor's clinic keeps its own website.
  assert.equal((await pub.get(`/${b.slug}`)).status, 200);
});
