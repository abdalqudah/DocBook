// Platform notifications (admin home and rep portal), the events & conferences vendor type, and that a clinic's
// contact details reach a rep only once the clinic adds that rep as a supplier.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const vendors = require('../src/modules/vendors/vendor.service');
const market = require('../src/modules/marketplace/market.service');
const reps = require('../src/modules/marketplace/rep-visits.service');
const billing = require('../src/modules/vendorbilling/billing.service');
const notify = require('../src/modules/platformnotify/notify.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const today = scheduling.clinicNow('Asia/Amman').date;
let app; let vendorId; let repEmail; let adminEmail; let adminId; let clinic;
const kinds = async (audience, vid) => (await notify.list(audience, vid, { limit: 200 })).map((n) => n.kind);

test.before(async () => {
  await knex.migrate.latest();
  app = await serve();
  repEmail = `ev${tag}@pn.test`;
  ({ vendorId } = await vendors.signup({ type: 'events', name: `Med Expo ${tag}`, contact_name: 'Rana', email: repEmail, password: 'Passw0rd!x', terms: 'on', specialties: ['dentistry'] }));
  adminEmail = `adm${tag}@pn.test`;
  adminId = await auth.createUser(knex, { name: 'Admin', email: adminEmail, password: 'Passw0rd!x' });
  await knex('users').where({ id: adminId }).update({ is_platform_admin: true });
  const owner = `own${tag}@pn.test`;
  const uid = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: owner, password: 'Passw0rd!x' });
    await businesses.create(id, { name: `Contact Clinic ${tag}`, currency: 'JOD', timezone: 'Asia/Amman', specialty: 'dentistry' }, trx);
    return id;
  });
  const { last_business_id: bid } = await knex('users').where({ id: uid }).first('last_business_id');
  await knex('businesses').where({ id: bid }).update({ address: 'Street 9', map_url: 'https://maps.example/x', status: 'active' });
  clinic = { businessId: bid, userId: uid, today, timezone: 'Asia/Amman', permissions: await rbac.getUserPermissions(bid, uid) };
});
test.after(async () => { await app.close(); await knex.destroy(); });

test('events & conferences is a vendor type; sign-ups and new clinics notify the admin', async () => {
  assert.ok(vendors.TYPES.includes('events'));
  assert.equal((await knex('vendors').where({ id: vendorId }).first('type')).type, 'events');
  const k = await kinds('admin', null);
  assert.ok(k.includes('vendor_signup') && k.includes('clinic_signup'));
});

test('approval, payments and visit decisions notify the rep; admin sees reported payments', async () => {
  await vendors.setStatus({ userId: adminId }, vendorId, 'active');
  const [inv] = await knex('vendor_invoices').insert({ number: `VN-T-${tag}`.slice(0, 30), vendor_id: vendorId, kind: 'plan', description: 'Plan', amount: 10, currency: 'JOD' });
  await billing.reportPayment({ vendorId, userId: null }, inv, { method: 'cliq', reference: 'R1' });
  assert.ok((await kinds('admin', null)).includes('vendor_payment'));
  const [rv] = await knex('rep_visits').insert({ business_id: clinic.businessId, vendor_id: vendorId, user_id: clinic.userId, visit_date: today, visit_time: '11:00', duration_minutes: 15, purpose: 'Expo invite', status: 'requested' });
  await reps.decide(clinic, rv, 'confirm');
  const k = await kinds('vendor', vendorId);
  for (const x of ['account_approved', 'visit_confirmed']) assert.ok(k.includes(x), x);
  assert.ok(await notify.unread('vendor', vendorId) >= 2);
});

test('clinic contact details reach the rep only after the clinic adds it as a supplier', async () => {
  // A confirmed visit shows the address; a request still waiting does not.
  const [rq] = await knex('rep_visits').insert({ business_id: clinic.businessId, vendor_id: vendorId, user_id: clinic.userId, visit_date: today, visit_time: '12:00', duration_minutes: 15, purpose: 'Second', status: 'requested' });
  const rows0 = await reps.vendorVisits(vendorId);
  assert.equal(rows0.find((r) => r.status === 'confirmed').clinic_address, 'Street 9');
  let row = rows0.find((r) => r.id === rq);
  assert.equal(row.clinic_address, null);
  assert.equal(row.clinic_map_url, null);
  assert.equal(row.isSupplier, false);
  await market.ensureSupplier(clinic, vendorId);
  row = (await reps.vendorVisits(vendorId)).find((r) => r.id === rq);
  assert.equal(row.clinic_address, 'Street 9');
  assert.ok(row.isSupplier);
  assert.ok((await kinds('vendor', vendorId)).includes('supplier_added'));
});

test('pages: admin home attention + bell, notification pages mark read', async () => {
  const m = app.agent(); await m.login(adminEmail);
  const home = await m.get('/admin');
  assert.equal(home.status, 200);
  assert.match(home.text, /href="\/admin\/notifications"/);
  assert.match(home.text, /\/admin\/vendor-billing\?tab=invoices&amp;status=reported/);
  assert.equal((await m.get('/admin/notifications')).status, 200);
  assert.equal(await notify.unread('admin', null), 0);
  const r = app.agent(); await r.login(repEmail);
  const dash = await r.get('/vendor');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /bell-count/);
  const page = await r.get('/vendor/notifications');
  assert.equal(page.status, 200);
  assert.match(page.text, /Contact Clinic/);
  assert.equal(await notify.unread('vendor', vendorId), 0);
});
