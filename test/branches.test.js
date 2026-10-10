// Branches: package price by number of branches, the branch limit from the package, managing branches, doctors and
// appointments taking their branch (set by the server), the branch filter, and public booking at a branch.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const appts = require('../src/modules/clinic/appointments.service');
const branches = require('../src/modules/clinic/branches.service');
const scheduling = require('../src/modules/clinic/scheduling');
const subs = require('../src/modules/subscriptions/subscriptions.service');
const pricing = require('../src/modules/subscriptions/branch-pricing');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `br-${k}-${tag}@t.test`;
const admin = { businessId: null, userId: null, ip: '127.0.0.1' };
let app; let ctx; let business; let slug; let savedSettings; let planId; let docMain; let docB; let date;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const row = await knex('platform_settings').where({ key: 'subscriptions' }).first('value');
  savedSettings = row ? JSON.parse(row.value) : null;
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: mail('owner'), password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Branch clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: userId }).update({ email_verified_at: new Date() });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  slug = `br-${tag}`.slice(0, 40);
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), branches_allowed: true, slug, booking_enabled: true, city: 'Amman', address: 'Main street 1' });
  businesses.forget(businessId);
  business = await businesses.get(businessId);
  ctx = { businessId, userId, roleKey: 'owner', permissions: await rbac.getUserPermissions(businessId, userId), locale: 'en', timezone: 'Asia/Amman', currency: 'JOD', ip: '127.0.0.1' };
  const week = Object.fromEntries(scheduling.DAY_KEYS.map((k) => [k, { enabled: true, shifts: [{ start: '09:00', end: '17:00' }], breaks: [] }]));
  docMain = await doctors.saveDoctor(ctx, null, { full_name: 'Dr Main', slot_duration_minutes: '30', consultation_fee: '20', is_active: '1', hours_mode: 'custom' });
  docB = await doctors.saveDoctor(ctx, null, { full_name: 'Dr North', slot_duration_minutes: '30', consultation_fee: '20', is_active: '1', hours_mode: 'custom' });
  await knex('doctors').whereIn('id', [docMain, docB]).update({ working_hours: JSON.stringify(week) });
  const d = new Date(`${scheduling.clinicNow('Asia/Amman').date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 3);
  date = d.toISOString().slice(0, 10);
  app = await serve();
});

test.after(async () => {
  await knex('platform_settings').where({ key: 'subscriptions' }).del();
  if (savedSettings) await knex('platform_settings').insert({ key: 'subscriptions', value: JSON.stringify(savedSettings) });
  subs.forgetSettings();
  if (planId) { await knex('clinic_subscriptions').where({ plan_id: planId }).update({ plan_id: null }); await knex('platform_invoices').where({ plan_id: planId }).del(); await knex('subscription_plans').where({ id: planId }).del(); }
  if (app) await app.close();
  await knex.destroy();
});

test('price by number of branches: set prices, then "each extra branch" for the rest', () => {
  const plan = { price_monthly: 30, price_yearly: 300, branch_prices: JSON.stringify(pricing.fromForm({ bp_m_2: '50', bp_y_2: '500', bp_m_3: '', bp_extra_m: '15', bp_extra_y: '150' })) };
  assert.equal(pricing.priceFor(plan, 1, 'monthly'), 30);
  assert.equal(pricing.priceFor(plan, 2, 'monthly'), 50);
  assert.equal(pricing.priceFor(plan, 3, 'monthly'), 65, '2 branches + one extra');
  assert.equal(pricing.priceFor(plan, 4, 'yearly'), 800);
  assert.deepEqual(pricing.choices(3), [1, 2, 3]);
  assert.equal(pricing.priceFor({ price_monthly: 10, price_yearly: 100 }, 3, 'monthly'), 10, 'no branch prices: same price');
});

test('package: branch limit, choosing branches sets the invoice amount, payment sets the branches paid for', async () => {
  await subs.saveSettings(admin, { ...(savedSettings || {}), trialDays: 30, graceDays: 7, enabled: '1', trialNoCard: '1' });
  planId = await subs.savePlan(admin, null, { name: `Branches ${tag}`, price_monthly: '30', price_yearly: '300', currency: 'JOD', is_active: '1', is_public: '1', sort_order: '0',
    'n_clinic.max_branches': '3', bp_m_2: '50', bp_y_2: '500', bp_extra_m: '15', bp_extra_y: '150' });
  const plan = await subs.getPlan(planId);
  assert.equal(pricing.parse(plan.branch_prices).tiers[2].m, 50);
  await knex('clinic_subscriptions').where({ business_id: business.id }).del();
  await subs.ensure(business);
  await knex('clinic_subscriptions').where({ business_id: business.id }).update({ plan_id: planId });
  const err = await subs.choosePlan(ctx, business, { plan_id: String(planId), billing_cycle: 'monthly', branches: '4' }).catch((e) => e);
  assert.equal(err.code, 'VALIDATION_FAILED', 'more branches than the plan allows');
  const invId = await subs.choosePlan(ctx, business, { plan_id: String(planId), billing_cycle: 'monthly', branches: '3' });
  const inv = await subs.getInvoice(business.id, invId);
  assert.equal(Number(inv.amount), 65);
  assert.equal(inv.branches, 3);
  await subs.recordPayment({ ...admin, userId: null }, business.id, { invoice_id: String(invId), billing_cycle: 'monthly', method: 'bank_transfer', amount: '' });
  const sub = await knex('clinic_subscriptions').where({ business_id: business.id }).first('branches', 'status');
  assert.equal(sub.status, 'active');
  assert.equal(sub.branches, 3);
  assert.equal(await subs.branchAllowance(business), 3);
  // paying for 2 branches limits the clinic to 2 even though the plan allows 3
  await knex('clinic_subscriptions').where({ business_id: business.id }).update({ branches: 2 });
  assert.equal(await subs.branchAllowance(business), 2);
});

let north;
test('branches: added within the package; the next one is refused; turning off / deleting needs it unused', async () => {
  north = await branches.save(ctx, business, null, { name: 'North branch', name_en: 'North', city: 'Irbid', address: 'King St', phone: '+962 7 9000 0000', map_url: 'https://maps.example.com/x' });
  const e = await branches.save(ctx, business, null, { name: 'South' }).catch((x) => x);
  assert.equal(e.code, 'PLAN_LIMIT_BRANCHES', 'the package pays for 2 branches (main + North)');
  const bad = await branches.save(ctx, business, null, { name: 'X', map_url: 'javascript:alert(1)' }).catch((x) => x);
  assert.equal(bad.code, 'VALIDATION_FAILED');
  // a doctor moves to the North branch from the doctor form
  await doctors.saveDoctor(ctx, docB, { full_name: 'Dr North', slot_duration_minutes: '30', consultation_fee: '20', is_active: '1', branch_form: '1', branch_id: String(north) });
  assert.equal((await knex('doctors').where({ id: docB }).first('branch_id')).branch_id, north);
  const wrong = await doctors.saveDoctor(ctx, docMain, { full_name: 'Dr Main', slot_duration_minutes: '30', consultation_fee: '20', is_active: '1', branch_form: '1', branch_id: '999999' }).catch((x) => x);
  assert.equal(wrong.code, 'VALIDATION_FAILED', 'a branch of another clinic / unknown is refused');
  const off = await branches.setActive({ ...ctx, today: date }, business, north, false).catch((x) => x);
  assert.equal(off.code, 'BRANCH_HAS_DOCTORS');
  const del = await branches.remove(ctx, north).catch((x) => x);
  assert.equal(del.code, 'BRANCH_IN_USE');
  const logs = await knex('audit_logs').where({ business_id: business.id, entity_type: 'branch' }).pluck('action');
  assert.ok(logs.includes('branch.created'));
});

test('appointments take the doctor\'s branch; moving to another doctor moves the branch; the filter shows each branch', async () => {
  const a1 = await appts.book(ctx, { doctor_id: String(docB), patient_name: 'Patient N', patient_phone: '0790000001', appointment_date: date, appointment_time: '10:00', branch_id: 'main' });
  assert.equal((await knex('appointments').where({ id: a1 }).first('branch_id')).branch_id, north, 'the doctor\'s branch, not the form\'s');
  const a2 = await appts.book(ctx, { doctor_id: String(docMain), patient_name: 'Patient M', patient_phone: '0790000002', appointment_date: date, appointment_time: '10:00' });
  assert.equal((await knex('appointments').where({ id: a2 }).first('branch_id')).branch_id, null);
  assert.deepEqual((await appts.list(ctx, { from: date, to: date, branch: north })).map((r) => r.id), [a1]);
  assert.deepEqual((await appts.list(ctx, { from: date, to: date, branch: 'main' })).map((r) => r.id), [a2]);
  await appts.move(ctx, a1, { doctor_id: docMain, appointment_date: date, appointment_time: '11:00' });
  assert.equal((await knex('appointments').where({ id: a1 }).first('branch_id')).branch_id, null, 'moved with the doctor');
  const o = app.agent();
  await o.login(mail('owner'));
  let r = await o.get(`/app/appointments?view=list&from=${date}&to=${date}&branch=main&lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /name="branch"/);
  r = await o.get(`/app/appointments/${a1}?lang=en`);
  assert.match(r.text, /Main branch/);
  r = await o.get('/app/clinic/branches?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /North branch/);
  assert.match(r.text, /reached your package/);
  r = await o.get(`/app/doctors/${docB}/edit?lang=en`);
  assert.match(r.text, new RegExp(`name="branch_id"[\\s\\S]*value="${north}" selected`));
  await knex('appointments').whereIn('id', [a1, a2]).del();
});

test('public booking: the patient picks the branch; "any doctor" keeps the branch; the website lists the branches', async () => {
  await knex('doctors').where({ business_id: business.id }).whereNotIn('id', [docMain, docB]).update({ is_active: false });
  const v = app.agent();
  let r = await v.get(`/${slug}/book?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /name="branch" value="main"/);
  assert.match(r.text, new RegExp(`name="branch" value="${north}"`));
  const slots = JSON.parse((await v.get(`/${slug}/book/slots?doctor=any&branch=${north}&date=${date}`)).text).data;
  assert.ok(slots.includes('09:00'));
  r = await v.get(`/${slug}/book?lang=en`);
  const csrf = v.csrf(r.text);
  r = await v.post(`/${slug}/book`, { _csrf: csrf, doctor_id: 'any', appointment_date: date, appointment_time: '09:00', patient_name: 'Walk In', patient_phone: '0791112223' });
  assert.equal(r.status, 422, 'a clinic with branches needs the branch for "any doctor"');
  r = await v.post(`/${slug}/book`, { _csrf: csrf, branch: String(north), doctor_id: 'any', appointment_date: date, appointment_time: '09:00', patient_name: 'Walk In', patient_phone: '0791112223' });
  assert.equal(r.status, 302);
  const a = await knex('appointments').where({ business_id: business.id, patient_phone: '0791112223' }).first('branch_id', 'doctor_id');
  assert.equal(a.branch_id, north);
  assert.equal(a.doctor_id, null);
  r = await v.get(`/${slug}/book/done?lang=en`);
  assert.match(r.text, /North/);
  assert.match(r.text, /Irbid · King St/);
  await knex('appointments').where({ business_id: business.id, patient_phone: '0791112223' }).del();
});
