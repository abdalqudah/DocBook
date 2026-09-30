// SaaS subscriptions: lifecycle with fixed dates (trial → expired, active → past_due → expired after the grace
// period), the read-only gate (which methods/paths pass), plan limits, manual payments extending the period,
// reminders once per mark, and the OFF switch being a complete no-op.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const subs = require('../src/modules/subscriptions/subscriptions.service');
const enforce = require('../src/modules/subscriptions/enforce');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const admin = { businessId: null, userId: null, ip: '127.0.0.1' };
let clinic; let ctx; let savedSettings;

async function makeClinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date() });
  businesses.forget(businessId);
  return { business: await businesses.get(businessId), userId, permissions: await rbac.getUserPermissions(businessId, userId) };
}
const setSettings = (patch) => subs.saveSettings(admin, { ...savedSettings, trialDays: 30, graceDays: 7, ...patch, enabled: patch.enabled ? '1' : '', trialNoCard: '1' });
const fakeReq = (method, path, body = {}) => ({
  method, path, body, business: clinic.business, get: () => '', originalUrl: `/app${path}`, xhr: false,
  ctx: { ...ctx, today: subs.todayOf(clinic.business) }, t: (k) => k,
});
function fakeRes() {
  const res = { locals: {}, statusCode: 200, rendered: null, json: null };
  res.status = (s) => { res.statusCode = s; return res; };
  res.page = (view, data) => { res.rendered = { view, data }; return res; };
  res.json = (d) => { res.jsonBody = d; return res; };
  return res;
}
const run = (req) => new Promise((resolve, reject) => {
  const res = fakeRes();
  let nexted = false;
  Promise.resolve(enforce(req, res, (err) => { if (err) reject(err); nexted = true; resolve({ res, nexted }); }))
    .then(() => { if (!nexted) setImmediate(() => resolve({ res, nexted })); });
});

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const row = await knex('platform_settings').where({ key: 'subscriptions' }).first('value');
  savedSettings = row ? JSON.parse(row.value) : null;
  await knex('platform_settings').where({ key: 'subscriptions' }).del();
  subs.forgetSettings();
  clinic = await makeClinic(`subs${tag}@t.test`, 'عيادة الاشتراكات');
  ctx = { businessId: clinic.business.id, userId: clinic.userId, permissions: clinic.permissions, roleKey: 'owner', currency: 'JOD', timezone: 'Asia/Amman', locale: 'ar' };
});

test.after(async () => {
  if (savedSettings) await knex('platform_settings').insert({ key: 'subscriptions', value: JSON.stringify(savedSettings) }).onConflict('key').merge();
  else await knex('platform_settings').where({ key: 'subscriptions' }).del();
  subs.forgetSettings();
  await knex.destroy();
});

// ---------------------------------------------------------------- pure lifecycle
test('trial expires the day after trial_ends_at', () => {
  const sub = { status: 'trialing', trial_ends_at: '2026-10-30' };
  assert.equal(subs.evaluate(sub, '2026-10-29', 7), null);
  assert.equal(subs.evaluate(sub, '2026-10-30', 7), null, 'the last trial day still works');
  assert.deepEqual(subs.evaluate(sub, '2026-10-31', 7), { status: 'expired' });
});

test('active → past_due at period end, → expired after the grace period', () => {
  const sub = { status: 'active', current_period_end: '2026-10-31', grace_ends_at: null };
  assert.equal(subs.evaluate(sub, '2026-10-31', 7), null);
  assert.deepEqual(subs.evaluate(sub, '2026-11-01', 7), { status: 'past_due', grace_ends_at: '2026-11-07' });
  const due = { status: 'past_due', current_period_end: '2026-10-31', grace_ends_at: '2026-11-07' };
  assert.equal(subs.evaluate(due, '2026-11-07', 7), null, 'still in grace on its last day');
  assert.deepEqual(subs.evaluate(due, '2026-11-08', 7), { status: 'expired', grace_ends_at: '2026-11-07' });
  // A job that did not run for weeks goes straight to expired.
  assert.equal(subs.evaluate(sub, '2026-12-15', 7).status, 'expired');
  // Paid again (period moved forward) while past_due → active.
  assert.deepEqual(subs.evaluate({ ...due, current_period_end: '2026-11-30' }, '2026-11-05', 7), { status: 'active', grace_ends_at: null });
  // Grace 0: expired the day after the period.
  assert.equal(subs.evaluate(sub, '2026-11-01', 0).status, 'expired');
});

test('comped never expires; cancelled keeps access until the end', () => {
  assert.equal(subs.evaluate({ status: 'comped', trial_ends_at: '2020-01-01' }, '2030-01-01', 7), null);
  assert.equal(subs.isReadOnly({ status: 'comped' }, '2030-01-01'), false);
  const c = { status: 'cancelled', current_period_end: '2026-10-31', trial_ends_at: '2026-09-01' };
  assert.equal(subs.isReadOnly(c, '2026-10-31'), false);
  assert.equal(subs.isReadOnly(c, '2026-11-01'), true);
  assert.equal(subs.isReadOnly({ status: 'cancelled', trial_ends_at: '2026-10-10' }, '2026-10-11'), true);
  assert.equal(subs.isReadOnly({ status: 'expired' }, '2026-10-11'), true);
  assert.equal(subs.isReadOnly({ status: 'past_due' }, '2026-10-11'), false);
});

test('period arithmetic: month ends and next period start', () => {
  assert.equal(subs.periodEnd('2026-01-31', 'monthly'), '2026-02-27');
  assert.equal(subs.periodEnd('2026-10-01', 'monthly'), '2026-10-31');
  assert.equal(subs.periodEnd('2026-10-01', 'yearly'), '2027-09-30');
  assert.equal(subs.nextPeriodStart({ status: 'active', current_period_end: '2026-10-31' }, '2026-10-20'), '2026-11-01');
  assert.equal(subs.nextPeriodStart({ status: 'expired', current_period_end: '2026-08-31' }, '2026-10-20'), '2026-10-20');
  assert.equal(subs.nextPeriodStart({ status: 'trialing', trial_ends_at: '2026-10-25' }, '2026-10-20'), '2026-10-26');
});

// ---------------------------------------------------------------- read-only gate
test('read-only gate: reads always pass; writes only to paying, account, security, export', () => {
  for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.equal(subs.allowedWhileReadOnly(m, '/patients/12'), true);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(subs.allowedWhileReadOnly(m, '/patients'), false, `${m} /patients`);
    assert.equal(subs.allowedWhileReadOnly(m, '/appointments/5/status'), false);
  }
  for (const p of ['/settings/subscription', '/settings/subscription/choose', '/settings/subscription/invoices/3/notice', '/settings/account', '/settings/security/password',
    '/settings/preferences', '/settings/data/export', '/settings/database/run', '/notifications/read']) assert.equal(subs.allowedWhileReadOnly('POST', p), true, p);
  for (const p of ['/settings/data/delete', '/settings/clinic', '/settings/subscriptionX', '/settings/team', '/doctors/new', '/visits/3/consultation']) assert.equal(subs.allowedWhileReadOnly('POST', p), false, p);
});

test('limit routes: doctors, staff logins, appointments', () => {
  assert.equal(subs.limitFor('POST', '/doctors/new', { is_active: '1' }), 'doctors');
  assert.equal(subs.limitFor('POST', '/doctors/new', { is_active: '0' }), null, 'an inactive doctor does not count');
  assert.equal(subs.limitFor('GET', '/doctors/new'), null);
  assert.equal(subs.limitFor('POST', '/doctors/4/edit', {}), null);
  assert.equal(subs.limitFor('POST', '/settings/team', {}), 'staff');
  assert.equal(subs.limitFor('POST', '/settings/team/9/status', { status: 'active' }), 'staff');
  assert.equal(subs.limitFor('POST', '/settings/team/9/status', { status: 'disabled' }), null);
  assert.equal(subs.limitFor('POST', '/appointments/new', { appointment_type: 'in_person' }), 'appointments');
  assert.equal(subs.limitFor('POST', '/appointments/new', { appointment_type: 'blocked' }), null);
});

// ---------------------------------------------------------------- OFF switch
test('OFF (default): no rows, no gating, features all on, job does nothing', async () => {
  assert.equal((await subs.settings()).enabled, false);
  assert.equal(await subs.state(clinic.business), null);
  assert.equal(await subs.hasFeature(clinic.business, 'ai_assistant'), true);
  assert.deepEqual(await subs.checkLimit(fakeReq('POST', '/doctors/new'), 'doctors'), { ok: true, limit: null, used: null });
  assert.equal(await subs.acceptsBookings(clinic.business), true);
  assert.deepEqual(await subs.runDue(new Date('2027-06-01T10:00:00Z')), { checked: 0 });
  const { res, nexted } = await run(fakeReq('POST', '/patients', { full_name: 'x' }));
  assert.equal(nexted, true);
  assert.equal(res.locals.subscriptionBanner, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(await knex('clinic_subscriptions').where({ business_id: clinic.business.id }).first(), undefined, 'nothing created while off');
});

// ---------------------------------------------------------------- ON
test('ON: a clinic without a row starts a fresh trial lazily', async () => {
  await setSettings({ enabled: true });
  const today = subs.todayOf(clinic.business);
  const st = await subs.state(clinic.business, today);
  assert.equal(st.sub.status, 'trialing');
  assert.equal(st.sub.trial_ends_at, subs.addDays(today, 29));
  assert.equal(st.trialDaysLeft, 30);
  assert.equal(st.readOnly, false);
  // Idempotent: a second look does not create another row.
  await subs.state(clinic.business, today);
  const [{ n }] = await knex('clinic_subscriptions').where({ business_id: clinic.business.id }).count({ n: '*' });
  assert.equal(Number(n), 1);
  const { res, nexted } = await run(fakeReq('GET', '/'));
  assert.equal(nexted, true);
  assert.equal(res.locals.subscriptionBanner, undefined, 'no banner with 30 days left');
});

test('plan limits: doctors and features follow the plan', async () => {
  const planId = await subs.savePlan(admin, null, { name: 'أساسية', name_en: 'Basic', price_monthly: '20', price_yearly: '200', currency: 'JOD', max_doctors: '1', max_staff: '', max_appointments_month: '', is_active: '1', is_public: '1', sort_order: '1', f_reminders: '1' });
  await subs.changePlan(admin, clinic.business.id, { plan_id: String(planId), billing_cycle: 'monthly' });
  let r = await subs.checkLimit(fakeReq('POST', '/doctors/new'), 'doctors');
  assert.deepEqual(r, { ok: true, limit: 1, used: 0 });
  await doctors.saveDoctor({ ...ctx, today: subs.todayOf(clinic.business) }, null, { full_name: 'د. أحمد', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
  r = await subs.checkLimit(fakeReq('POST', '/doctors/new'), 'doctors');
  assert.deepEqual(r, { ok: false, limit: 1, used: 1 });
  assert.equal((await subs.checkLimit(fakeReq('POST', '/settings/team'), 'staff')).ok, true, 'no staff limit on this plan');
  const { res, nexted } = await run(fakeReq('POST', '/doctors/new', { full_name: 'د. باسم', is_active: '1' }));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 402);
  assert.equal(res.rendered.data.code, 'PLAN_LIMIT');
  assert.equal(await subs.hasFeature(clinic.business, 'reminders'), true);
  assert.equal(await subs.hasFeature(clinic.business, 'ai_assistant'), false);
});

test('lifecycle through the job with fixed dates, reminders once, read-only gate', async () => {
  const id = clinic.business.id;
  await knex('clinic_subscriptions').where({ business_id: id }).update({ status: 'trialing', trial_ends_at: '2031-03-10' });
  // 3 days of trial left on 2031-03-08 (08, 09, 10) → one reminder per owner, not repeated.
  await subs.runDue(new Date('2031-03-08T09:00:00Z'));
  await subs.runDue(new Date('2031-03-08T15:00:00Z'));
  const notes = await knex('notifications').where({ business_id: id }).where('dedupe_key', 'like', 'subs:trial:2031-03-10:3:%');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].user_id, clinic.userId);
  // The day after the trial: expired.
  await subs.runDue(new Date('2031-03-11T09:00:00Z'));
  let sub = await knex('clinic_subscriptions').where({ business_id: id }).first();
  assert.equal(sub.status, 'expired');

  // Read-only: GET passes, POST to clinical pages refused, subscription/export pass, public booking closed.
  subs.setNow(() => new Date('2031-03-11T09:00:00Z'));
  try {
    const req = (m, p) => ({ ...fakeReq(m, p), ctx: { ...ctx, today: '2031-03-11' } });
    let out = await run(req('GET', '/patients'));
    assert.equal(out.nexted, true);
    assert.equal(out.res.locals.subscriptionBanner.kind, 'expired');
    out = await run(req('POST', '/patients'));
    assert.equal(out.nexted, false);
    assert.equal(out.res.statusCode, 402);
    assert.equal(out.res.rendered.data.code, 'SUBSCRIPTION_EXPIRED');
    out = await run(req('DELETE', '/appointments/1'));
    assert.equal(out.res.statusCode, 402);
    out = await run(req('POST', '/settings/subscription/choose'));
    assert.equal(out.nexted, true);
    out = await run(req('GET', '/settings/data/export'));
    assert.equal(out.nexted, true);
    assert.equal(await subs.acceptsBookings(clinic.business), false);
    assert.equal(await subs.hasFeature(clinic.business, 'reminders'), false);
  } finally { subs.setNow(null); }

  // A manual payment on 2031-03-12 reactivates for one month from that day.
  subs.setNow(() => new Date('2031-03-12T09:00:00Z'));
  try {
    const r = await subs.recordPayment(admin, id, { billing_cycle: 'monthly', amount: '20', method: 'cliq', reference: 'CLQ-1' });
    assert.equal(r.start, '2031-03-12');
    assert.equal(r.end, '2031-04-11');
  } finally { subs.setNow(null); }
  sub = await knex('clinic_subscriptions').where({ business_id: id }).first();
  assert.equal(sub.status, 'active');
  const inv = await knex('platform_invoices').where({ business_id: id }).orderBy('id', 'desc').first();
  assert.equal(inv.status, 'paid');
  assert.match(inv.number, /^PL-\d{4}-\d{6}$/);

  // Period ends 2031-04-11 → past_due on 04-12 (grace to 04-18) → expired on 04-19.
  await subs.runDue(new Date('2031-04-12T09:00:00Z'));
  sub = await knex('clinic_subscriptions').where({ business_id: id }).first();
  assert.equal(sub.status, 'past_due');
  assert.equal(String(sub.grace_ends_at).slice(0, 10), '2031-04-18');
  await subs.runDue(new Date('2031-04-18T09:00:00Z'));
  assert.equal((await knex('clinic_subscriptions').where({ business_id: id }).first()).status, 'past_due');
  await subs.runDue(new Date('2031-04-19T09:00:00Z'));
  assert.equal((await knex('clinic_subscriptions').where({ business_id: id }).first()).status, 'expired');
});

test('clinic reports a payment, admin confirms it: the period continues from the old end', async () => {
  const id = clinic.business.id;
  await knex('clinic_subscriptions').where({ business_id: id }).update({ status: 'active', current_period_start: '2040-01-01', current_period_end: '2040-01-31', grace_ends_at: null });
  const plan = (await subs.listPlans())[0];
  subs.setNow(() => new Date('2040-01-20T09:00:00Z'));
  try {
    const invId = await subs.choosePlan({ ...ctx, today: '2040-01-20' }, clinic.business, { plan_id: String(plan.id), billing_cycle: 'yearly' });
    let inv = await subs.getInvoice(id, invId);
    assert.equal(inv.status, 'open');
    assert.equal(inv.period_start, '2040-02-01');
    assert.equal(inv.period_end, '2041-01-31');
    assert.equal(inv.amount, 200);
    await assert.rejects(subs.reportPayment(ctx, id, invId, { method: 'bank_transfer', reference: '' }), (e) => e.code === 'VALIDATION_FAILED');
    await subs.reportPayment(ctx, id, invId, { method: 'bank_transfer', reference: 'TRX-778' });
    inv = await subs.getInvoice(id, invId);
    assert.equal(inv.status, 'reported');
    const r = await subs.recordPayment(admin, id, { invoice_id: String(invId), billing_cycle: 'yearly', amount: '', method: 'bank_transfer' });
    assert.equal(r.end, '2041-01-31');
    inv = await subs.getInvoice(id, invId);
    assert.equal(inv.status, 'paid');
    assert.equal(inv.reference, 'TRX-778');
    await assert.rejects(subs.recordPayment(admin, id, { invoice_id: String(invId), billing_cycle: 'yearly', method: 'cash' }), (e) => e.code === 'INVOICE_CLOSED');
  } finally { subs.setNow(null); }
  const audit = await knex('audit_logs').whereNull('business_id').where({ action: 'platform.subscription_payment', entity_id: String(id) }).count({ n: '*' });
  assert.ok(Number(audit[0].n) >= 2, 'admin payments are audited in platform scope');
});

test('comp and turning the switch off again', async () => {
  const id = clinic.business.id;
  await subs.comp(admin, id, { note: 'pilot' });
  assert.equal((await knex('clinic_subscriptions').where({ business_id: id }).first()).status, 'comped');
  assert.equal(subs.isReadOnly(await knex('clinic_subscriptions').where({ business_id: id }).first(), '2099-01-01'), false);
  await knex('clinic_subscriptions').where({ business_id: id }).update({ status: 'expired' });
  await setSettings({ enabled: false });
  const { nexted, res } = await run(fakeReq('POST', '/patients'));
  assert.equal(nexted, true, 'OFF lets every write through even for an expired row');
  assert.equal(res.locals.subscriptionBanner, undefined);
  assert.equal(await subs.acceptsBookings(clinic.business), true);
  assert.equal(await subs.hasFeature(clinic.business, 'ai_assistant'), true);
});
