// DocBook 2.0 redesign (phase 3): the workspace sidebar per role, workspace tabs, moved pages and their redirects,
// the Clinical setup hub, the Payments list — over HTTP against the test database (docbook_test).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const setup = require('../src/modules/onboarding/setup.service');
const nav = require('../src/routes/nav');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (r) => `${r}${tag}@redesign.test`;
let app; let ctx; let doctorId;
const users = {};

async function addMember(roleKey, extra = {}) {
  const role = await rbac.getRoleByKey(ctx.businessId, roleKey);
  const id = await knex.transaction((trx) => auth.createUser(trx, { name: `${roleKey} person`, email: mail(roleKey), password: 'Passw0rd!x' }));
  await knex('users').where({ id }).update({ last_business_id: ctx.businessId, email_verified_at: new Date() });
  await knex('memberships').insert({ business_id: ctx.businessId, user_id: id, role_id: role.id, ...extra });
  rbac.invalidate(ctx.businessId);
  users[roleKey] = id;
}
// The workspace lines of the sidebar, in order (data-nav-ws attributes).
const sidebar = (html) => [...html.matchAll(/data-nav-ws="([a-z_]+)"/g)].map((m) => m[1]);
const tabs = (html) => { const m = html.match(/<nav class="section-tabs"[\s\S]*?<\/nav>/); return m ? [...m[0].matchAll(/href="([^"]+)"/g)].map((x) => x[1]) : []; };

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: mail('owner'), password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Redesign clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: userId }).update({ email_verified_at: new Date() });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date() });
  ctx = { businessId, userId, roleKey: 'owner', permissions: await rbac.getUserPermissions(businessId, userId), locale: 'en', timezone: 'Asia/Amman', currency: 'JOD' };
  doctorId = await setup.addDoctor(ctx, { full_name: 'Dr Sami', consultation_fee: '20', slot_duration_minutes: '30' });
  await addMember('clinic_manager');
  await addMember('doctor', { doctor_id: doctorId });
  await addMember('nurse');
  await addMember('receptionist');
  await addMember('accountant');
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('sidebar: one line per workspace, in the redesign order, per role', async () => {
  const expected = {
    owner: ['today', 'appointments', 'front_desk', 'patients', 'finance', 'clinic', 'stock', 'website', 'reports', 'settings', 'support'],
    doctor: ['today', 'appointments', 'patients', 'clinic', 'stock', 'website', 'support'],
    receptionist: ['today', 'appointments', 'front_desk', 'patients', 'finance', 'clinic', 'stock', 'support'],
    accountant: ['today', 'appointments', 'finance', 'clinic', 'stock', 'reports', 'settings', 'support'], // data export lives in settings
  };
  for (const [role, lines] of Object.entries(expected)) {
    const a = app.agent();
    await a.login(mail(role));
    const r = await a.get(role === 'doctor' ? '/app/my-day' : '/app');
    assert.equal(r.status, 200, `${role} home`);
    assert.deepEqual(sidebar(r.text), lines, `${role} sidebar`);
    assert.ok(!/nav-sec-items|<details class="nav-sec/.test(r.text), 'no accordion groups');
  }
});

test('the receptionist sees Finance as "Cashier", landing on the cash screen; the accountant lands on the overview', async () => {
  const a = app.agent();
  await a.login(mail('receptionist'));
  const r = await a.get('/app');
  assert.match(r.text, /data-nav-ws="finance">[\s\S]*?Cashier/);
  assert.match(r.text, /href="\/app\/cashier"[^>]*data-nav-ws="finance"/);
  const b = app.agent();
  await b.login(mail('accountant'));
  const s = await b.get('/app');
  assert.match(s.text, /href="\/app\/finance"[^>]*data-nav-ws="finance"/);
});

test('workspace tabs: finance pages show the finance tabs with the payments list', async () => {
  const a = app.agent();
  await a.login(mail('owner'));
  const r = await a.get('/app/billing');
  assert.equal(r.status, 200);
  const t = tabs(r.text);
  for (const href of ['/app/finance', '/app/cashier', '/app/billing', '/app/billing/payments', '/app/cashier/closings', '/app/expenses', '/app/payroll', '/app/partners']) assert.ok(t.includes(href), `tab ${href}`);
  assert.match(r.text, /section-tabs-sep/, 'finance tabs are clustered');
});

test('payments list: every part of an invoice is one payment; filters and export', async () => {
  const [invId] = await knex('invoices').insert({ business_id: ctx.businessId, invoice_number: 9001, patient_name: 'Rana Test', amount: 40, payment_method: 'mixed', doctor_id: doctorId, doctor_name: 'Dr Sami', created_by: ctx.userId });
  await knex('invoice_payments').insert([{ business_id: ctx.businessId, invoice_id: invId, method: 'cash', amount: 25 }, { business_id: ctx.businessId, invoice_id: invId, method: 'card', amount: 15 }]);
  await knex('invoices').insert({ business_id: ctx.businessId, invoice_number: 9002, patient_name: 'Old Invoice', amount: 10, payment_method: 'cash', created_by: ctx.userId });
  const a = app.agent();
  await a.login(mail('accountant'));
  let r = await a.get('/app/billing/payments');
  assert.equal(r.status, 200);
  assert.equal((r.text.match(/Rana Test/g) || []).length, 2, 'cash part + card part');
  assert.match(r.text, /Old Invoice/, 'an invoice without parts counts as one payment');
  assert.ok(!/Mixed/i.test(r.text.replace(/<script[\s\S]*?<\/script>/g, '')), 'never "mixed"');
  r = await a.get('/app/billing/payments?method=card');
  assert.equal((r.text.match(/Rana Test/g) || []).length, 1);
  assert.ok(!/Old Invoice/.test(r.text));
  r = await a.get('/app/billing/payments/export?format=csv');
  assert.equal(r.status, 200);
  assert.match(r.text, /Rana Test/);
  const doc = app.agent();
  await doc.login(mail('doctor'));
  r = await doc.get('/app/billing/payments');
  assert.equal(r.status, 403, 'no billing.view');
});

test('team, roles and page access moved to Clinic: old addresses answer 301, old form posts still work', async () => {
  const a = app.agent();
  await a.login(mail('owner'));
  let r = await a.get('/app/settings/team?group=all');
  assert.equal(r.status, 301);
  assert.equal(r.location, '/app/clinic/team?group=all');
  r = await a.get('/app/settings/roles');
  assert.equal(r.location, '/app/clinic/roles');
  const m = await knex('memberships').where({ business_id: ctx.businessId, user_id: users.nurse }).first('id');
  r = await a.get(`/app/settings/team/${m.id}/access`);
  assert.equal(r.location, `/app/clinic/team/${m.id}/access`);
  for (const path of ['/app/clinic/team', '/app/clinic/roles', `/app/clinic/team/${m.id}/access`]) {
    r = await a.get(path);
    assert.equal(r.status, 200, path);
    assert.deepEqual(tabs(r.text).slice(0, 3), ['/app/doctors', '/app/services', '/app/clinic/team'], `${path}: clinic tabs`);
    assert.ok(!/class="settings-nav"/.test(r.text), `${path}: no settings sidebar`);
  }
  r = await a.submit('/app/clinic/roles', '/app/settings/roles', { name: 'Old form role', permissions: 'patients.view' });
  assert.equal(r.status, 302, 'a form posted to the old address still saves');
  assert.ok(await knex('roles').where({ business_id: ctx.businessId, name: 'Old form role' }).first());
  const recep = app.agent();
  await recep.login(mail('receptionist'));
  r = await recep.get('/app/clinic/team');
  assert.equal(r.status, 403);
});

test('clinical setup hub: cards by permission; the lists render inside the Clinic workspace', async () => {
  const a = app.agent();
  await a.login(mail('owner'));
  let r = await a.get('/app/clinic/setup');
  assert.equal(r.status, 200);
  for (const href of ['/app/settings/medications', '/app/settings/diagnosis-codes', '/app/settings/insurance', '/app/settings/signatures']) assert.ok(r.text.includes(`href="${href}"`), href);
  r = await a.get('/app/settings/medications');
  assert.equal(r.status, 200);
  assert.ok(!/class="settings-nav"/.test(r.text));
  assert.ok(tabs(r.text).includes('/app/clinic/setup'));
  const d = app.agent();
  await d.login(mail('doctor'));
  r = await d.get('/app/clinic/setup');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('href="/app/settings/medications"'));
  assert.ok(!r.text.includes('href="/app/settings/insurance"'), 'insurance needs settings.manage');
  const n = app.agent();
  await n.login(mail('nurse'));
  assert.equal((await n.get('/app/clinic/setup')).status, 403);
});

test('settings no longer lists the moved pages; personal pages stay reachable from the user menu', async () => {
  const a = app.agent();
  await a.login(mail('owner'));
  const r = await a.get('/app/settings');
  assert.equal(r.status, 200);
  const settingsNav = (r.text.match(/<nav class="settings-nav"[\s\S]*?<\/nav>/) || [''])[0];
  for (const gone of ['/app/clinic/team', '/app/settings/medications', '/app/settings/insurance']) assert.ok(!settingsNav.includes(gone), gone);
  const n = app.agent();
  await n.login(mail('nurse'));
  const home = await n.get('/app');
  assert.ok(home.text.includes('href="/app/settings/account"'), 'user menu: account');
  assert.ok(home.text.includes('href="/app/attendance"'), 'user menu: clock in/out');
});

test('"+ New" lists only what the member may create; no free-standing sale', () => {
  const keys = (role) => nav.actionsFor(new Set(require('../src/modules/rbac/permissions').normalise(require('../src/modules/rbac/permissions').SYSTEM_ROLES.find((r) => r.key === role).permissions)))
    .filter((x) => x.create).map((x) => x.key);
  assert.deepEqual(keys('receptionist'), ['new_appointment', 'new_patient', 'check_in', 'collect_payment']);
  assert.deepEqual(keys('doctor'), ['new_certificate']);
  assert.ok(!nav.ACTIONS.some((x) => /sale|invoice/.test(x.key)));
});

test('search: grouped results, Arabic spelling variants and Arabic-Indic digits; inline actions by permission', async () => {
  const [pid] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'أحمد علي', phone: '0791234567' });
  const a = app.agent();
  await a.login(mail('receptionist'));
  let r = await a.get('/app/search?q=' + encodeURIComponent('احمد'), { accept: 'application/json' });
  let body = JSON.parse(r.text);
  const hit = body.data.find((x) => x.href === `/app/patients/${pid}`);
  assert.ok(hit, 'احمد finds أحمد');
  assert.equal(hit.group, 'patients');
  assert.equal(hit.action.href, `/app/appointments/new?patient=${pid}`, 'reception can book from the result');
  assert.ok(body.groups.patients);
  r = await a.get('/app/search?q=' + encodeURIComponent('٠٧٩١٢٣'), { accept: 'application/json' });
  body = JSON.parse(r.text);
  assert.ok(body.data.some((x) => x.href === `/app/patients/${pid}`), 'Arabic-Indic digits match the phone');
  const n = app.agent();
  await n.login(mail('nurse'));
  body = JSON.parse((await n.get('/app/search?q=' + encodeURIComponent('أحمد'), { accept: 'application/json' })).text);
  const nh = body.data.find((x) => x.href === `/app/patients/${pid}`);
  assert.ok(nh && !nh.action, 'no booking action without appointments.manage');
  assert.ok(!body.data.some((x) => x.group === 'invoices'), 'no invoices without billing.view');
});

test('appointment drawer: essentials + actions by state and permission; returns to the page', async () => {
  const today = require('../src/modules/clinic/scheduling').clinicNow('Asia/Amman').date;
  const [id] = await knex('appointments').insert({ business_id: ctx.businessId, doctor_id: doctorId, patient_name: 'Drawer Patient', patient_phone: '0790000009', appointment_date: today, appointment_time: '23:59', status: 'confirmed' });
  const a = app.agent();
  await a.login(mail('receptionist'));
  let r = await a.get(`/app/appointments/${id}/peek?return=${encodeURIComponent('/app/appointments?view=list')}`);
  assert.equal(r.status, 200);
  assert.ok(!/<html/i.test(r.text), 'a fragment, not a page');
  assert.match(r.text, /Drawer Patient/);
  assert.match(r.text, new RegExp(`action="/app/front-desk/${id}/check-in"`));
  assert.match(r.text, /name="return_to" value="\/app\/appointments\?view=list"/);
  r = await a.submit('/app/appointments', `/app/front-desk/${id}/check-in`, { on: '1', return_to: '/app/appointments?view=list' });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/app/appointments?view=list', 'check-in from the drawer comes back to the list');
  r = await a.submit('/app/appointments', `/app/front-desk/${id}/check-in`, { on: '0', return_to: 'https://evil.test/' });
  assert.equal(r.location, '/app/front-desk', 'only /app addresses are followed');
  const d = app.agent();
  await d.login(mail('doctor'));
  r = await d.get(`/app/appointments/${id}/peek`);
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('/check-in"'), 'no reception actions for a doctor');
  assert.ok(!r.text.includes('/status"'), 'no cancel without appointments.manage');
});

test('patient workspace: tabs by permission; billing and clinical tabs hidden without the rights', async () => {
  const [pid] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'Tabs Patient', allergies: 'Penicillin' });
  const o = app.agent();
  await o.login(mail('owner'));
  let r = await o.get(`/app/patients/${pid}`);
  assert.equal(r.status, 200);
  for (const k of ['clinical', 'appointments', 'prescriptions', 'documents', 'billing', 'timeline']) assert.ok(r.text.includes(`/app/patients/${pid}?tab=${k}`), k);
  assert.match(r.text, /Penicillin/, 'alerts on every tab');
  for (const k of ['clinical', 'appointments', 'prescriptions', 'documents', 'billing', 'timeline']) {
    const t = await o.get(`/app/patients/${pid}?tab=${k}`);
    assert.equal(t.status, 200, k);
    assert.match(t.text, /Penicillin/);
  }
  const rc = app.agent();
  await rc.login(mail('receptionist'));
  r = await rc.get(`/app/patients/${pid}`);
  assert.ok(!r.text.includes('?tab=clinical') && !r.text.includes('?tab=prescriptions'), 'no clinical tabs for reception');
  assert.ok(r.text.includes('?tab=billing'));
  r = await rc.get(`/app/patients/${pid}?tab=clinical`);
  assert.equal(r.status, 200, 'an unknown/forbidden tab falls back to the overview');
  assert.ok(!/clinical_visits|Visits and diagnoses/.test(r.text));
});

test('Today: "needs attention now" lists the late arrival and visits to pay, for reception', async () => {
  const today = require('../src/modules/clinic/scheduling').clinicNow('Asia/Amman').date;
  await knex('appointments').insert({ business_id: ctx.businessId, doctor_id: doctorId, patient_name: 'To Pay', appointment_date: today, appointment_time: '00:00', status: 'completed', payment_status: 'unpaid', amount_due: 20 });
  const a = app.agent();
  await a.login(mail('receptionist'));
  const r = await a.get('/app');
  assert.equal(r.status, 200);
  assert.match(r.text, /today-attention/);
  assert.match(r.text, /href="\/app\/cashier\/screen"/, 'visits to pay → cash screen');
  assert.ok(!/class="ox-actions"/.test(r.text), 'no duplicate action tiles; "+ New" is the one action menu');
});

test('public clinic page: no staff sign-in cards; the staff link still works', async () => {
  await knex('businesses').where({ id: ctx.businessId }).update({ slug: `redesign-${tag}`.slice(0, 40) });
  const b = await knex('businesses').where({ id: ctx.businessId }).first('slug');
  const anon = app.agent();
  let r = await anon.get(`/${b.slug}`);
  assert.equal(r.status, 200);
  assert.ok(!/role-pick|login\?as=/.test(r.text), 'no staff role cards for patients');
  r = await anon.get(`/${b.slug}/login`);
  assert.equal(r.status, 200);
});

test('settings: grouped by kind of configuration; a pointer to the moved pages', async () => {
  const a = app.agent();
  await a.login(mail('owner'));
  const r = await a.get('/app/settings');
  for (const g of ['Clinic profile', 'Documents &amp; printing', 'Messages &amp; notifications', 'Features', 'Subscription', 'Data &amp; privacy']) assert.ok(r.text.includes(g), g);
  assert.match(r.text, /set-moved/);
});

test('"+ New": every create action opens a page; a document without a visit starts by choosing one (own visits for a doctor)', async () => {
  const today = require('../src/modules/clinic/scheduling').clinicNow('Asia/Amman').date;
  const other = await setup.addDoctor(ctx, { full_name: 'Dr Other', consultation_fee: '20', slot_duration_minutes: '30' });
  const [p1] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'Pick Mine' });
  const [p2] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'Pick Theirs' });
  const [mine] = await knex('appointments').insert({ business_id: ctx.businessId, doctor_id: doctorId, patient_id: p1, patient_name: 'Pick Mine', appointment_date: today, appointment_time: '00:01', status: 'completed' });
  await knex('appointments').insert({ business_id: ctx.businessId, doctor_id: other, patient_id: p2, patient_name: 'Pick Theirs', appointment_date: today, appointment_time: '00:02', status: 'completed' });
  await knex('appointments').insert({ business_id: ctx.businessId, doctor_id: doctorId, patient_id: p1, patient_name: 'Pick Mine', appointment_date: today, appointment_time: '00:03', status: 'cancelled' });
  const o = app.agent();
  await o.login(mail('owner'));
  for (const x of nav.actionsFor(ctx.permissions).filter((y) => y.create)) {
    const r = await o.get(x.href.split('#')[0]);
    assert.equal(r.status, 200, `${x.key} → ${x.href}`);
  }
  let r = await o.get('/app/certificates/new?type=attendance');
  assert.match(r.text, /Pick Mine/);
  assert.match(r.text, /Pick Theirs/);
  assert.match(r.text, new RegExp(`/app/certificates/new\\?visit=${mine}&type=attendance`));
  const d = app.agent();
  await d.login(mail('doctor'));
  r = await d.get('/app/certificates/new');
  assert.equal(r.status, 200);
  assert.match(r.text, /Pick Mine/);
  assert.ok(!/Pick Theirs/.test(r.text), "another doctor's visits are not offered");
  assert.equal((r.text.match(/certificates\/new\?visit=/g) || []).length, 1, 'cancelled visits are not offered');
  r = await d.get('/app/certificates/new?q=Theirs');
  assert.ok(!/Pick Theirs/.test(r.text));
});

test('an area outside the package or turned off has no links: the AI assistant in settings and on the P&L page', async () => {
  const ops = require('../src/modules/platformops/ops.service'); // eslint-disable-line global-require
  const o = app.agent();
  await o.login(mail('owner'));
  assert.match((await o.get('/app/settings')).text, /href="\/app\/settings\/ai"/);
  assert.match((await o.get('/app/finance')).text, /href="\/app\/finance\/assistant"/);
  await ops.saveModules({ ...ctx, ip: '127.0.0.1' }, await knex('businesses').where({ id: ctx.businessId }).first(), Object.fromEntries(ops.KEYS.filter((k) => k !== 'ai_assistant').map((k) => [k, '1'])));
  try {
    assert.ok(!/href="\/app\/settings\/ai"/.test((await o.get('/app/settings')).text));
    assert.ok(!/href="\/app\/finance\/assistant"/.test((await o.get('/app/finance')).text));
  } finally {
    await ops.saveModules({ ...ctx, ip: '127.0.0.1' }, await knex('businesses').where({ id: ctx.businessId }).first(), Object.fromEntries(ops.KEYS.map((k) => [k, '1'])));
  }
});
