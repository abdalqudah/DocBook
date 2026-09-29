// Reps & warehouses marketplace (clinic side) and rep visits, against the test database (docbook_test):
// specialty targeting, add-to-supplies idempotency, rep slot computation, the double-booking lock,
// doctor scoping, and that vendors never receive patient data.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const scheduling = require('../src/modules/clinic/scheduling');
const market = require('../src/modules/marketplace/market.service');
const reps = require('../src/modules/marketplace/rep-visits.service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const today = scheduling.clinicNow('Asia/Amman').date;
let dental; let multi; let derm; let vendor; let pending; let doc1; let doc2; let repUser; let date;
const offers = {};
let productId;

async function clinic(email, name, specialty) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman', specialty }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ specialty: specialty || null });
  const business = await knex('businesses').where({ id: businessId }).first();
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, today, business };
}

async function makeVendor(status, name) {
  const [id] = await knex('vendors').insert({ type: 'warehouse', name, email: `${name.toLowerCase().replace(/\W+/g, '')}${tag}@vendor.test`, phone: '0790000000', status });
  return knex('vendors').where({ id }).first();
}
async function offer(vendorId, title, specs, extra = {}) {
  const [id] = await knex('vendor_offers').insert({ vendor_id: vendorId, title, status: 'published', published_at: new Date(), ...extra });
  await knex('vendor_offer_specialties').insert(specs.map((s) => ({ offer_id: id, specialty: s })));
  return id;
}
function nextWeekday(dow) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test.before(async () => {
  await knex.migrate.latest();
  dental = await clinic(`dental${tag}@m.test`, 'Dental clinic', 'dentistry');
  multi = await clinic(`multi${tag}@m.test`, 'Multi clinic', 'multi');
  derm = await clinic(`derm${tag}@m.test`, 'Skin clinic', 'dermatology');
  vendor = await makeVendor('active', 'Noor Warehouse');
  pending = await makeVendor('pending', 'Pending Rep');
  offers.dental = await offer(vendor.id, 'Composite kits', ['dentistry']);
  offers.derm = await offer(vendor.id, 'Skin care', ['dermatology']);
  offers.expired = await offer(vendor.id, 'Old offer', ['dentistry'], { starts_on: '2020-01-01', ends_on: '2020-02-01' });
  offers.draft = await offer(vendor.id, 'Draft offer', ['dentistry'], { status: 'draft' });
  offers.pending = await offer(pending.id, 'Pending vendor offer', ['dentistry']);
  [productId] = await knex('vendor_products').insert({ vendor_id: vendor.id, name: 'Composite A2', unit: 'box', pack_size: '4 x 4 g', price: 38.5, currency: 'JOD' });
  await knex('vendor_product_specialties').insert({ product_id: productId, specialty: 'dentistry' });
  doc1 = await doctors.saveDoctor(dental, null, { full_name: 'Dr. Sami', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
  doc2 = await doctors.saveDoctor(dental, null, { full_name: 'Dr. Huda', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
  repUser = await auth.createUser(knex, { name: 'Rep', email: `rep${tag}@vendor.test`, password: 'Passw0rd!x' });
  await knex('vendor_users').insert({ vendor_id: vendor.id, user_id: repUser, role: 'owner' });
  date = nextWeekday(0); // a Sunday
});

test.after(() => knex.destroy());

test('offers target the clinic specialty; only published, in-date offers of active vendors are shown', async () => {
  const ids = (rows) => rows.map((r) => r.id);
  const dentalSees = ids(await market.offers(dental, dental.business));
  assert.ok(dentalSees.includes(offers.dental));
  for (const hidden of ['derm', 'expired', 'draft', 'pending']) assert.ok(!dentalSees.includes(offers[hidden]), `${hidden} hidden`);
  const dermSees = ids(await market.offers(derm, derm.business));
  assert.ok(dermSees.includes(offers.derm) && !dermSees.includes(offers.dental));
  // A multi-specialty clinic sees every specialty, and can filter.
  const multiSees = ids(await market.offers(multi, multi.business));
  assert.ok(multiSees.includes(offers.dental) && multiSees.includes(offers.derm));
  const filtered = ids(await market.offers(multi, multi.business, { specialty: 'dermatology' }));
  assert.ok(filtered.includes(offers.derm) && !filtered.includes(offers.dental));
  // A specialty clinic cannot widen its catalog through the filter.
  assert.ok(!ids(await market.offers(dental, dental.business, { specialty: 'dermatology' })).includes(offers.derm));
  await assert.rejects(market.offer(dental, dental.business, offers.derm), { code: 'NOT_FOUND' });
  await assert.rejects(market.offer(dental, dental.business, offers.pending), { code: 'NOT_FOUND' });
});

test('opening an offer records one view per clinic; the badge count drops; dismiss hides it', async () => {
  const before = await market.newOffersCount(dental, dental.business);
  assert.ok(before >= 1);
  await market.offer(dental, dental.business, offers.dental);
  await market.offer(dental, dental.business, offers.dental);
  const [{ n }] = await knex('vendor_offer_views').where({ offer_id: offers.dental, business_id: dental.businessId }).count({ n: '*' });
  assert.equal(Number(n), 1);
  assert.equal(await market.newOffersCount(dental, dental.business), before - 1);
  await market.setDismissed(dental, dental.business, offers.dental, true);
  assert.ok(!(await market.offers(dental, dental.business)).some((o) => o.id === offers.dental));
  assert.ok((await market.offers(dental, dental.business, { show: 'dismissed' })).some((o) => o.id === offers.dental));
  // Other clinics are not affected.
  assert.ok((await market.offers(multi, multi.business)).some((o) => o.id === offers.dental));
});

test('add to supplies is idempotent (also concurrently) and links one supplier per vendor', async () => {
  const input = { reorder_level: '2', current_stock: '5', unit_cost: '38.5' };
  const results = await Promise.all([market.addToSupplies(dental, dental.business, productId, input), market.addToSupplies(dental, dental.business, productId, input)]);
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(results[0].id, results[1].id);
  const again = await market.addToSupplies(dental, dental.business, productId, input);
  assert.equal(again.created, false);
  const items = await knex('supply_items').where({ business_id: dental.businessId, vendor_product_id: productId });
  assert.equal(items.length, 1);
  assert.equal(Number(items[0].current_stock), 5);
  const sups = await knex('suppliers').where({ business_id: dental.businessId, vendor_id: vendor.id });
  assert.equal(sups.length, 1);
  assert.equal(items[0].supplier_id, sups[0].id);
  const s2 = await market.ensureSupplier(dental, vendor.id);
  assert.equal(s2.created, false);
  assert.equal(s2.id, sups[0].id);
  // A pending vendor's product cannot be added.
  const [pp] = await knex('vendor_products').insert({ vendor_id: pending.id, name: 'Hidden' });
  await knex('vendor_product_specialties').insert({ product_id: pp, specialty: 'dentistry' });
  await assert.rejects(market.addToSupplies(dental, dental.business, pp, input), { code: 'NOT_FOUND' });
  await assert.rejects(market.ensureSupplier(dental, pending.id), { code: 'NOT_FOUND' });
});

test('rep slot computation: windows, visit length, booked visits, day off and past times', () => {
  const windows = [{ weekday: 'sun', start_time: '13:00', end_time: '14:00', slot_minutes: 20 }, { weekday: 'mon', start_time: '09:00', end_time: '10:00', slot_minutes: 15 }];
  const slots = reps.computeRepSlots({ windows, date, today: '2020-01-01' });
  assert.deepEqual(slots.map((s) => s.time), ['13:00', '13:20', '13:40']);
  assert.equal(slots[0].minutes, 20);
  const booked = reps.computeRepSlots({ windows, date, booked: [{ time: '13:10', duration: 15 }], today: '2020-01-01' });
  assert.deepEqual(booked.map((s) => s.time), ['13:40'], 'a 13:10–13:25 visit blocks both overlapping slots');
  assert.deepEqual(reps.computeRepSlots({ windows, date, dayOff: true, today: '2020-01-01' }), []);
  assert.deepEqual(reps.computeRepSlots({ windows, date, today: date, nowMinutes: 13 * 60 + 5 }).map((s) => s.time), ['13:20', '13:40']);
  assert.throws(() => reps.computeRepSlots({ windows, date: '2020-01-05', today }), { code: 'DATE_IN_PAST' });
});

test('clinic windows: validation, overlap, doctor-specific and clinic-wide availability, days off', async () => {
  await assert.rejects(reps.saveWindow(dental, null, { weekday: 'sun', start_time: '13:00', end_time: '14:00', slot_minutes: '5' }), { code: 'VALIDATION_FAILED' });
  await reps.saveWindow(dental, null, { weekday: 'sun', start_time: '13:00', end_time: '14:00', slot_minutes: '15' });
  await assert.rejects(reps.saveWindow(dental, null, { weekday: 'sun', start_time: '13:30', end_time: '14:30', slot_minutes: '15' }), { code: 'REP_WINDOW_OVERLAP' });
  await reps.saveWindow(dental, null, { doctor_id: String(doc1), weekday: 'sun', start_time: '10:00', end_time: '10:30', slot_minutes: '30' });
  await assert.rejects(reps.saveWindow(dental, null, { doctor_id: '999999', weekday: 'sun', start_time: '11:00', end_time: '12:00', slot_minutes: '15' }), { code: 'VALIDATION_FAILED' });
  const slot = (o) => reps.freeSlots({ businessId: dental.businessId, timezone: 'Asia/Amman', date, ...o }).then((r) => r.map((s) => s.time));
  assert.deepEqual(await slot({ doctorId: doc1 }), ['10:00', '13:00', '13:15', '13:30', '13:45']);
  assert.deepEqual(await slot({ doctorId: doc2 }), ['13:00', '13:15', '13:30', '13:45']);
  assert.deepEqual(await slot({ doctorId: null }), ['13:00', '13:15', '13:30', '13:45']);
  await knex('doctor_days_off').insert({ business_id: dental.businessId, doctor_id: doc2, off_date: date, reason: 'x' });
  assert.deepEqual(await slot({ doctorId: doc2 }), []);
  await knex('doctor_days_off').where({ business_id: dental.businessId, doctor_id: doc2, off_date: date }).delete();
});

test('booking: only active vendors, enabled clinics; two simultaneous bookings of one slot → exactly one wins', async () => {
  const vctx = { vendorId: vendor.id, userId: repUser };
  const input = { business_id: String(dental.businessId), doctor_id: String(doc1), visit_date: date, visit_time: '13:00', purpose: 'Introduce composites', products: [String(productId)] };
  await assert.rejects(reps.book(vctx, vendor, input), { code: 'NOT_FOUND' }, 'rep visits are off for this clinic');
  await reps.saveSettings(dental, { rep_visits_enabled: '1' });
  await assert.rejects(reps.book({ vendorId: pending.id, userId: repUser }, pending, input), { code: 'VENDOR_NOT_ACTIVE' });
  const results = await Promise.allSettled([reps.book(vctx, vendor, input), reps.book(vctx, vendor, { ...input, purpose: 'Second rep' })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'SLOT_TAKEN');
  const won = results.find((r) => r.status === 'fulfilled').value;
  assert.equal(won.status, 'requested');
  const row = await knex('rep_visits').where({ id: won.id }).first();
  assert.match(row.purpose, /Composite A2/, 'selected products are listed with the purpose');
  // Another doctor (or the clinic) can still be booked at the same time.
  const other = await reps.book(vctx, vendor, { ...input, doctor_id: String(doc2) });
  assert.ok(other.id);
  const n = await knex('notifications').where({ business_id: dental.businessId, type: 'rep_visit.requested' }).count({ c: '*' });
  assert.ok(Number(n[0].c) >= 2, 'staff are notified');
  // Auto-confirm.
  await reps.saveSettings(dental, { rep_visits_enabled: '1', rep_visits_auto_confirm: '1' });
  const auto = await reps.book(vctx, vendor, { ...input, visit_time: '13:30' });
  assert.equal(auto.status, 'confirmed');
  await reps.saveSettings(dental, { rep_visits_enabled: '1' });
});

test('doctor scope: a doctor login only sees and decides its own visits', async () => {
  const docCtx = { ...dental, userId: dental.userId, permissions: new Set(['vendors.view']), ownDoctorId: doc2, doctorId: doc2 };
  const mine = await reps.clinicVisits(docCtx, { tab: 'requests', today });
  assert.ok(mine.length >= 1 && mine.every((v) => v.doctor_id === doc2));
  const all = await reps.clinicVisits(dental, { tab: 'requests', today });
  const doc1Visit = all.find((v) => v.doctor_id === doc1);
  assert.ok(doc1Visit);
  await assert.rejects(reps.decide(docCtx, doc1Visit.id, 'confirm'), { code: 'NOT_FOUND' });
  assert.equal(await reps.decide(docCtx, mine[0].id, 'confirm'), 'confirmed');
  await assert.rejects(reps.decide(docCtx, mine[0].id, 'confirm'), { code: 'REP_VISIT_STATE' });
  // A receptionist-like login (vendors.view only, no doctor) cannot decide.
  const viewer = { ...dental, permissions: new Set(['vendors.view']), ownDoctorId: null, doctorId: null };
  await assert.rejects(reps.decide(viewer, doc1Visit.id, 'confirm'), { code: 'PERMISSION_DENIED' });
  assert.equal(await reps.decide(dental, doc1Visit.id, 'decline', 'Next week please'), 'declined');
  const counts = await reps.counts(docCtx, today);
  assert.equal(typeof counts.requests, 'number');
  // A declined slot is free again.
  const free = await reps.freeSlots({ businessId: dental.businessId, doctorId: doc1, date, timezone: 'Asia/Amman' });
  assert.ok(free.some((s) => s.time === '13:00'));
});

test('vendors never receive patient data', async () => {
  // A patient appointment in the same time does not change the rep windows, and nothing about it reaches the vendor.
  const [pid] = await knex('patients').insert({ business_id: dental.businessId, full_name: 'Secret Patient', phone: '0791234567' });
  await knex('appointments').insert({ business_id: dental.businessId, doctor_id: doc1, patient_id: pid, patient_name: 'Secret Patient', patient_phone: '0791234567', appointment_date: date, appointment_time: '13:45', status: 'confirmed' }).catch(() => {});
  const visits = await reps.vendorVisits(vendor.id);
  const clinicInfo = await reps.clinicForRep(dental.businessId);
  const found = await reps.bookableClinics({});
  const blob = JSON.stringify({ visits, clinicInfo, found, slots: await reps.freeSlots({ businessId: dental.businessId, doctorId: doc1, date, timezone: 'Asia/Amman' }) });
  assert.ok(!/Secret Patient|0791234567|patient/i.test(blob));
  assert.deepEqual(Object.keys(visits[0]).filter((k) => /patient|appointment/i.test(k)), []);
  assert.ok(!found.some((c) => c.id === multi.businessId), 'clinics without rep visits are not listed');
});
