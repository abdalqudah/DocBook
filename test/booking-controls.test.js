// Booking controls: a doctor can be active without online booking, or kept off the website; and "booking with the
// clinic only" sends every online request to reception without a doctor (reception assigns one when it confirms).
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
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (r) => `${r}${tag}@bctl.test`;
let app; let ctx; let slug; let docA; let docB; let docC; let date;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: mail('owner'), password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Controls clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: userId }).update({ email_verified_at: new Date() });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  slug = `bctl-${tag}`.slice(0, 40);
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), slug, booking_enabled: true });
  ctx = { businessId, userId, roleKey: 'owner', permissions: await rbac.getUserPermissions(businessId, userId), locale: 'en', timezone: 'Asia/Amman', currency: 'JOD', ip: '127.0.0.1' };
  await setup.saveHours(ctx, { days: ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'], s1: '09:00', e1: '17:00' });
  const base = { slot_duration_minutes: '30', consultation_fee: '20', is_active: '1', show_consultation_fee: '1', booking_form: '1' };
  docA = await doctors.saveDoctor(ctx, null, { ...base, full_name: 'Dr Alpha', online_booking: '1', show_on_site: '1' });
  docB = await doctors.saveDoctor(ctx, null, { ...base, full_name: 'Dr Bravo', show_on_site: '1' }); // no online booking
  docC = await doctors.saveDoctor(ctx, null, { ...base, full_name: 'Dr Charlie', online_booking: '1' }); // not on the site
  const d = new Date(`${scheduling.clinicNow('Asia/Amman').date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 2);
  date = d.toISOString().slice(0, 10);
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('the doctor form saves online booking and the website listing separately from "active"', async () => {
  const rows = await knex('doctors').whereIn('id', [docA, docB, docC]).orderBy('id').select('is_active', 'online_booking', 'show_on_site');
  assert.deepEqual(rows.map((r) => [Boolean(r.is_active), Boolean(r.online_booking), Boolean(r.show_on_site)]), [[true, true, true], [true, false, true], [true, true, false]]);
  // a save without the booking section (setup, API) keeps them
  await doctors.saveDoctor(ctx, docB, { full_name: 'Dr Bravo', slot_duration_minutes: '30', consultation_fee: '20', is_active: '1' });
  assert.equal(Boolean((await knex('doctors').where({ id: docB }).first('online_booking')).online_booking), false);
});

test('the website hides doctors kept off it; booking offers only doctors taking online bookings', async () => {
  const v = app.agent();
  const site = (await v.get(`/${slug}?lang=en`)).text;
  assert.match(site, /Dr Alpha/); assert.match(site, /Dr Bravo/); assert.doesNotMatch(site, /Dr Charlie/);
  const book = (await v.get(`/${slug}/book?lang=en`)).text;
  assert.match(book, new RegExp(`value="${docA}"`)); assert.doesNotMatch(book, new RegExp(`value="${docB}"`)); assert.match(book, new RegExp(`value="${docC}"`));
  const r = await v.submit(`/${slug}/book`, `/${slug}/book`, { doctor_id: String(docB), appointment_date: date, appointment_time: '10:00', patient_name: 'No Online', patient_phone: '0791112200' });
  assert.equal(r.status, 422, 'a doctor without online booking cannot be booked from the site');
  assert.equal(await knex('appointments').where({ business_id: ctx.businessId, patient_name: 'No Online' }).first('id'), undefined);
});

test('booking with the clinic only: no doctor choice, requests reach reception without a doctor', async () => {
  const o = app.agent();
  await o.login(mail('owner'));
  let r = await o.submit('/app/website/booking', '/app/website/booking/mode', { booking_clinic_only: '1' });
  assert.equal(r.status, 302);
  assert.equal(Boolean((await knex('businesses').where({ id: ctx.businessId }).first('booking_clinic_only')).booking_clinic_only), true);
  cache.forgetPrefix('');
  const v = app.agent();
  const book = (await v.get(`/${slug}/book?lang=en`)).text;
  assert.match(book, /data-clinic-only/);
  assert.doesNotMatch(book, new RegExp(`value="${docA}"`));
  assert.ok(JSON.parse((await v.get(`/${slug}/book/slots?doctor=${docA}&date=${date}`)).text).data.includes('10:00'));
  r = await v.submit(`/${slug}/book`, `/${slug}/book`, { doctor_id: String(docA), appointment_date: date, appointment_time: '10:00', patient_name: 'Clinic Only', patient_phone: '0791112211' });
  assert.equal(r.status, 302);
  const a = await knex('appointments').where({ business_id: ctx.businessId, patient_name: 'Clinic Only' }).first();
  assert.equal(a.doctor_id, null, 'reception assigns the doctor');
  assert.equal(a.status, 'pending');
  r = await o.submit('/app/website/booking', '/app/website/booking/mode', {});
  assert.equal(Boolean((await knex('businesses').where({ id: ctx.businessId }).first('booking_clinic_only')).booking_clinic_only), false);
});
