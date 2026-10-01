// Booking with the clinic ("any doctor"), the patient's messages (received → confirmed), reception confirming and
// choosing the doctor, and doctors' hours following the clinic's week (break and second period only when chosen).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const setup = require('../src/modules/onboarding/setup.service');
const scheduling = require('../src/modules/clinic/scheduling');
const msg = require('../src/modules/messaging/messaging.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (r) => `${r}${tag}@any.test`;
let app; let ctx; let slug; let docA; let docB; let date;
const realFetch = global.fetch;
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: mail('owner'), password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Any clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: userId }).update({ email_verified_at: new Date() });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  slug = `any-${tag}`.slice(0, 40);
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), slug, booking_enabled: true });
  ctx = { businessId, userId, roleKey: 'owner', permissions: await rbac.getUserPermissions(businessId, userId), locale: 'en', timezone: 'Asia/Amman', currency: 'JOD', ip: '127.0.0.1' };
  await setup.saveHours(ctx, { days: ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'], s1: '09:00', e1: '17:00' });
  docA = await doctors.saveDoctor(ctx, null, { full_name: 'Dr A', slot_duration_minutes: '30', consultation_fee: '20', is_active: '1', show_consultation_fee: '1' });
  docB = await doctors.saveDoctor(ctx, null, { full_name: 'Dr B', slot_duration_minutes: '30', consultation_fee: '20', is_active: '1', show_consultation_fee: '1' });
  const role = await rbac.getRoleByKey(businessId, 'receptionist');
  const rid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Reception', email: mail('desk'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: rid }).update({ last_business_id: businessId, email_verified_at: new Date() });
  await knex('memberships').insert({ business_id: businessId, user_id: rid, role_id: role.id });
  await msg.saveSettings(ctx, { confirmations_enabled: '1', reminders_enabled: '0', reviews_enabled: '0', message_locale: 'en', use_whatsapp: '1', default_dial: '962',
    wa_phone_number_id: '1234567890', wa_token: 'EAAG-test-token', wa_tpl_confirmation: 'appointment_booked', wa_tpl_received: 'booking_received', wa_app_secret: 'secret', wa_lang_ar: 'ar', wa_lang_en: 'en' });
  const tomorrow = new Date(`${scheduling.clinicNow('Asia/Amman').date}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 2);
  date = tomorrow.toISOString().slice(0, 10);
  app = await serve();
});
test.after(async () => { global.fetch = realFetch; if (app) await app.close(); await knex.destroy(); });

const sent = [];
const stub = () => { global.fetch = async (url, init) => { if (/graph\.facebook\.com/.test(String(url))) { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200, headers: { 'content-type': 'application/json' } }); } return realFetch(url, init); }; };

test('doctors follow the clinic week; a custom week keeps its break and second period only when ticked', async () => {
  const a = await knex('doctors').where({ id: docA }).first('hours_mode', 'working_hours');
  assert.equal(a.hours_mode, 'clinic');
  const week = J(a.working_hours);
  assert.deepEqual(week.sat, { enabled: true, shifts: [{ start: '09:00', end: '17:00' }], breaks: [] }, 'no break unless one is chosen');
  const wh = { sat: { enabled: '1', s1: '08:00', e1: '12:00', extra: ['0'], s2: '16:00', e2: '20:00', break: ['0'], bs: '10:00', be: '10:30' },
    sun: { enabled: '1', s1: '08:00', e1: '12:00', extra: ['0', '1'], s2: '16:00', e2: '20:00', break: ['0', '1'], bs: '10:00', be: '10:30' } };
  const parsed = scheduling.parseWorkingHoursForm({ wh });
  assert.deepEqual(parsed.sat.shifts, [{ start: '08:00', end: '12:00' }]);
  assert.deepEqual(parsed.sat.breaks, []);
  assert.equal(parsed.sun.shifts.length, 2);
  assert.deepEqual(parsed.sun.breaks, [{ start: '10:00', end: '10:30' }]);
  const c = await doctors.saveDoctor(ctx, null, { full_name: 'Dr C', slot_duration_minutes: '30', consultation_fee: '20', is_active: '1', hours_mode: 'custom', wh });
  await setup.saveHours(ctx, { days: ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'], s1: '08:00', e1: '18:00' });
  assert.equal(J((await knex('doctors').where({ id: docA }).first('working_hours')).working_hours).mon.shifts[0].end, '18:00', 'follows the clinic');
  assert.equal(J((await knex('doctors').where({ id: c }).first('working_hours')).working_hours).sun.shifts.length, 2, 'custom hours untouched');
  await knex('doctors').where({ id: c }).update({ is_active: false });
});

test('booking with the clinic: any free doctor, "received" message, reception confirms with a doctor and time, "confirmed" message', async () => {
  stub();
  const v = app.agent();
  let r = await v.get(`/${slug}/book/slots?doctor=any&date=${date}`);
  assert.ok(JSON.parse(r.text).data.includes('10:00'));
  r = await v.get(`/${slug}/book`);
  assert.match(r.text, /value="any"/, 'the patient can book without choosing a doctor');
  r = await v.submit(`/${slug}/book`, `/${slug}/book`, { doctor_id: 'any', appointment_date: date, appointment_time: '10:00', patient_name: 'Any Patient', patient_phone: '0791112233' });
  assert.equal(r.status, 302);
  const a = await knex('appointments').where({ business_id: ctx.businessId, patient_name: 'Any Patient' }).first();
  assert.equal(a.doctor_id, null);
  assert.equal(a.status, 'pending');
  assert.match((await v.get(`/${slug}/book/done?lang=en`)).text, /Chosen by the clinic when it confirms/);
  const cfg = await msg.getConfig(ctx.businessId);
  await msg.runClinic(cfg, Date.now(), 'http://x');
  assert.deepEqual((await knex('message_dispatches').where({ appointment_id: a.id }).pluck('stage')), ['received']);
  assert.equal(sent.at(-1).template.name, 'booking_received');
  // two doctors: one more "any" booking fits at 10:00, a third does not
  await knex('appointments').insert({ business_id: ctx.businessId, patient_name: 'Second', patient_phone: '0791112244', appointment_date: date, appointment_time: '10:00', status: 'pending', source: 'website', appointment_type: 'in_person' });
  assert.ok(!JSON.parse((await v.get(`/${slug}/book/slots?doctor=any&date=${date}`)).text).data.includes('10:00'), 'both doctors are spoken for at 10:00');
  // reception confirms: chooses Dr B and moves it to 10:30
  const d = app.agent();
  await d.login(mail('desk'));
  r = await d.get(`/app/appointments/${a.id}/peek?lang=en`);
  assert.match(r.text, /action="\/app\/appointments\/\d+\/confirm"/);
  assert.match(r.text, /Choose the doctor/);
  r = await d.submit(`/app/appointments/${a.id}`, `/app/appointments/${a.id}/confirm`, { doctor_id: '', appointment_date: date, appointment_time: '10:30' });
  assert.equal((await knex('appointments').where({ id: a.id }).first()).status, 'pending', 'a doctor is required');
  r = await d.submit(`/app/appointments/${a.id}`, `/app/appointments/${a.id}/confirm`, { doctor_id: String(docB), appointment_date: date, appointment_time: '10:30' });
  const after = await knex('appointments').where({ id: a.id }).first();
  assert.equal(after.status, 'confirmed');
  assert.equal(after.doctor_id, docB);
  assert.equal(after.appointment_time.slice(0, 5), '10:30');
  await msg.runClinic(cfg, Date.now(), 'http://x');
  assert.deepEqual((await knex('message_dispatches').where({ appointment_id: a.id }).orderBy('id').pluck('stage')), ['received', 'confirmed']);
  assert.equal(sent.at(-1).template.name, 'appointment_booked');
  assert.equal(sent.at(-1).template.components[0].parameters[1].text, 'Dr B');
});

test('clinic types: the admin hides a built-in type and adds one; sign-up and settings offer them; a used type stays', async () => {
  const types = require('../src/modules/platformops/clinic-types'); // eslint-disable-line global-require
  const before = await knex('platform_settings').where({ key: types.KEY }).first();
  try {
    await types.save({ ...ctx, businessId: null }, { hidden: ['cosmetic'], custom: [{ ar: 'زراعة الشعر', en: 'Hair transplant <b>', template: 'aesthetic' }] }, { templates: ['general', 'aesthetic'] });
    const added = types.state.custom[0];
    assert.match(added.key, /^c_[a-z0-9]+$/);
    assert.equal(added.en, 'Hair transplant b', 'plain text');
    assert.ok(types.valid(added.key));
    assert.ok(!types.visible().includes('cosmetic'));
    let r = await app.agent().get('/signup?lang=en');
    assert.match(r.text, new RegExp(`value="${added.key}"[^>]*>Hair transplant b`));
    assert.ok(!/value="cosmetic"/.test(r.text), 'hidden from new clinics');
    await knex('businesses').where({ id: ctx.businessId }).update({ specialty: added.key });
    businesses.forget(ctx.businessId);
    const o = app.agent();
    await o.login(mail('owner'));
    r = await o.get('/app/settings/clinic?lang=en');
    assert.match(r.text, new RegExp(`value="${added.key}" selected`));
    // removing a type a clinic uses keeps it
    await types.save({ ...ctx, businessId: null }, { hidden: [], custom: [{ ...added, remove: '1' }] }, { templates: ['general', 'aesthetic'] });
    assert.ok(types.valid(added.key), 'a used type is kept');
    assert.equal(types.template(added.key), 'aesthetic');
  } finally {
    await knex('businesses').where({ id: ctx.businessId }).update({ specialty: null });
    if (before) await knex('platform_settings').where({ key: types.KEY }).update({ value: before.value });
    else await knex('platform_settings').where({ key: types.KEY }).del();
    await types.load(true);
  }
});

test('clinic week: a different time for each day, kept as entered and shown day by day', async () => {
  const wh = { sat: { enabled: '1', s1: '09:00', e1: '17:00', extra: '0', break: '0' }, thu: { enabled: '1', s1: '09:00', e1: '13:00', extra: '0', break: '0' },
    sun: { enabled: '1', s1: '10:00', e1: '14:00', extra: ['0', '1'], s2: '16:00', e2: '20:00', break: '0' } };
  let e = await setup.saveHours(ctx, { hours_layout: 'days', wh: { sat: { enabled: '1', s1: '17:00', e1: '09:00' } } }).catch((x) => x);
  assert.ok(e.details && e.details.days, 'closing before opening is refused');
  e = await setup.saveHours(ctx, { hours_layout: 'days', wh: { sat: { s1: '09:00', e1: '17:00' } } }).catch((x) => x);
  assert.ok(e.details && e.details.days, 'at least one open day');
  const r = await setup.saveHours(ctx, { hours_layout: 'days', wh });
  assert.deepEqual(r.week.thu.shifts, [{ start: '09:00', end: '13:00' }]);
  assert.deepEqual(r.week.sun.shifts, [{ start: '10:00', end: '14:00' }, { start: '16:00', end: '20:00' }]);
  assert.equal(r.week.mon.enabled, false);
  assert.equal(J((await knex('doctors').where({ id: docA }).first('working_hours')).working_hours).thu.shifts[0].end, '13:00', 'doctors following the clinic get each day');
  assert.equal(setup.hoursForm(r.week).perDay, true);
  const o = app.agent();
  await o.login(mail('owner'));
  const page = await o.get('/app/onboarding/hours?lang=en');
  assert.equal(page.status, 200);
  assert.match(page.text, /name="hours_layout" value="days" checked/);
  assert.match(page.text, /name="wh\[thu\]\[e1\]" value="13:00"/);
});
