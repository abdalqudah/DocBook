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
