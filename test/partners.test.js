// Pharmacies, imaging centres and labs: the clinic adds them; a prescription goes to a pharmacy on WhatsApp (secure
// link to that paper only), an imaging request to a centre inside the clinic (its list, then done); only partners of
// the right kind; other clinics' partners are refused.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const scheduling = require('../src/modules/clinic/scheduling');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `pt-${k}-${tag}@t.test`;
let app; let A; let B; let rxId; let orderId; let labOrderId;

async function clinic(k) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: mail(k), password: 'Passw0rd!x' });
    await businesses.create(id, { name: `Partners ${k}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: userId }).update({ email_verified_at: new Date() });
  const { last_business_id: b } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date() });
  return b;
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  A = await clinic('a'); B = await clinic('b');
  const today = scheduling.clinicNow('Asia/Amman').date;
  const [doc] = await knex('doctors').insert({ business_id: A, full_name: 'Dr P', is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()), slot_duration_minutes: 30 });
  const [pid] = await knex('patients').insert({ business_id: A, full_name: 'Partner Patient', phone: '0791234567' });
  const [visit] = await knex('appointments').insert({ business_id: A, doctor_id: doc, patient_id: pid, patient_name: 'Partner Patient', patient_phone: '0791234567', appointment_date: today, appointment_time: '10:00', status: 'completed', appointment_type: 'in_person', source: 'staff' });
  [rxId] = await knex('prescriptions').insert({ business_id: A, appointment_id: visit, doctor_id: doc, patient_id: pid, patient_name: 'Partner Patient', items: JSON.stringify([{ medicationName: 'Amoxicillin' }]) });
  [orderId] = await knex('medical_orders').insert({ business_id: A, appointment_id: visit, patient_id: pid, doctor_id: doc, kind: 'imaging', items: JSON.stringify([{ name: 'Chest X-ray' }]), patient_name: 'Partner Patient' });
  [labOrderId] = await knex('medical_orders').insert({ business_id: A, appointment_id: visit, patient_id: pid, doctor_id: doc, kind: 'lab', items: JSON.stringify([{ name: 'CBC' }]), patient_name: 'Partner Patient' });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('partners: add, send a prescription on WhatsApp, an imaging request to the centre inside the clinic', async () => {
  const o = app.agent(); await o.login(mail('a'));
  let r = await o.get('/app/settings/partners?lang=en');
  assert.equal(r.status, 200);
  r = await o.submit('/app/settings/partners', '/app/settings/partners', { kind: 'pharmacy', name: 'Green Pharmacy', phone: '0795556666', email: '' });
  assert.equal(r.status, 302);
  r = await o.submit('/app/settings/partners', '/app/settings/partners', { kind: 'imaging', name: 'Our X-ray room', in_house: '1' });
  assert.equal(r.status, 302);
  r = await o.submit('/app/settings/partners', '/app/settings/partners', { kind: 'lab', name: 'No contact lab' });
  assert.notEqual(r.status, 302, 'an outside partner needs WhatsApp or e-mail');
  const pharmacy = await knex('clinic_partners').where({ business_id: A, kind: 'pharmacy' }).first();
  const xray = await knex('clinic_partners').where({ business_id: A, kind: 'imaging' }).first();
  assert.ok(xray.in_house);

  // The prescription page offers the pharmacy; WhatsApp to the pharmacy with a secure link.
  const appt = (await knex('prescriptions').where({ id: rxId }).first('appointment_id')).appointment_id;
  r = await o.get(`/app/visits/${appt}/prescriptions/${rxId}?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Send to a pharmacy/);
  assert.match(r.text, /Green Pharmacy/);
  r = await o.submit(`/app/visits/${appt}/prescriptions/${rxId}`, '/app/centres/send', { doc_kind: 'prescription', doc_id: String(rxId), partner_id: String(pharmacy.id), channel: 'whatsapp', return_to: `/app/visits/${appt}` });
  assert.equal(r.status, 200);
  assert.match(r.text, /https:\/\/wa\.me\/962795556666\?text=/);
  const send = await knex('partner_sends').where({ business_id: A, partner_id: pharmacy.id, doc_kind: 'prescription', doc_id: rxId }).first();
  assert.ok(send && send.share_link_id && send.channel === 'whatsapp');

  // The prescription cannot go to the imaging centre, nor a lab request to it.
  r = await o.submit('/app/settings/partners', '/app/centres/send', { doc_kind: 'prescription', doc_id: String(rxId), partner_id: String(xray.id), return_to: '/app' });
  assert.equal(r.status, 302);
  assert.equal(await knex('partner_sends').where({ partner_id: xray.id, doc_kind: 'prescription' }).first(), undefined);
  r = await o.submit('/app/settings/partners', '/app/centres/send', { doc_kind: 'order', doc_id: String(labOrderId), partner_id: String(xray.id), return_to: '/app' });
  assert.equal(await knex('partner_sends').where({ partner_id: xray.id, doc_kind: 'order', doc_id: labOrderId }).first(), undefined);

  // Imaging request → the centre inside the clinic: on its list, then done from the request page.
  r = await o.submit(`/app/orders/${orderId}`, '/app/centres/send', { doc_kind: 'order', doc_id: String(orderId), partner_id: String(xray.id), return_to: `/app/orders/${orderId}` });
  assert.equal(r.status, 302);
  assert.equal((await knex('medical_orders').where({ id: orderId }).first('partner_id')).partner_id, xray.id);
  r = await o.get(`/app/centres/${xray.id}?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Chest X-ray/);
  assert.match(r.text, /Waiting/);
  await knex('medical_orders').where({ id: orderId }).update({ status: 'done' });
  r = await o.get(`/app/centres/${xray.id}?lang=en`);
  assert.match(r.text, /badge-success badge-dot">Done/);

  // Another clinic cannot use these partners or papers.
  const b = app.agent(); await b.login(mail('b'));
  r = await b.submit('/app/settings/partners', '/app/centres/send', { doc_kind: 'prescription', doc_id: String(rxId), partner_id: String(pharmacy.id), channel: 'whatsapp', return_to: '/app' });
  assert.equal(r.status, 404);
  assert.equal((await b.get(`/app/centres/${xray.id}`)).status, 404);
});
