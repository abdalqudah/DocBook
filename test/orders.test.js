// Lab & imaging orders, referral letters, the patient's files, the tests list and the clinical report — through HTTP,
// with the clinic scope checked (another clinic's ids never work).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const scheduling = require('../src/modules/clinic/scheduling');
const messaging = require('../src/modules/messaging/messaging.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `ord-${k}-${tag}@t.test`;
let app; let businessId; let otherBiz; let visit; let patientId; let otherPatient; let otherVisit;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const mk = async (k) => {
    const userId = await knex.transaction(async (trx) => {
      const id = await auth.createUser(trx, { name: 'Owner', email: mail(k), password: 'Passw0rd!x' });
      await businesses.create(id, { name: `Orders ${k}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
      return id;
    });
    await knex('users').where({ id: userId }).update({ email_verified_at: new Date() });
    const { last_business_id: b } = await knex('users').where({ id: userId }).first('last_business_id');
    await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date(), slug: `ord-${k}-${tag}`.slice(0, 40) });
    return b;
  };
  businessId = await mk('a');
  otherBiz = await mk('b');
  const today = scheduling.clinicNow('Asia/Amman').date;
  const [doc] = await knex('doctors').insert({ business_id: businessId, full_name: 'Dr Orders', specialization: 'باطنية', is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()), slot_duration_minutes: 30 });
  [patientId] = await knex('patients').insert({ business_id: businessId, full_name: 'Order Patient', phone: '0791111111', gender: 'female' });
  [otherPatient] = await knex('patients').insert({ business_id: otherBiz, full_name: 'Other Patient', phone: '0792222222' });
  [visit] = await knex('appointments').insert({ business_id: businessId, doctor_id: doc, patient_id: patientId, patient_name: 'Order Patient', patient_phone: '0791111111', appointment_date: today, appointment_time: '09:00', status: 'confirmed', appointment_type: 'in_person', source: 'staff' });
  [otherVisit] = await knex('appointments').insert({ business_id: otherBiz, patient_id: otherPatient, patient_name: 'Other Patient', patient_phone: '0792222222', appointment_date: today, appointment_time: '09:00', status: 'confirmed', appointment_type: 'in_person', source: 'staff' });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('doctor orders lab tests from the visit; the order prints on the letterhead; result is recorded', async () => {
  const o = app.agent(); await o.login(mail('a'));
  let r = await o.get(`/app/visits/${visit}?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /id="orders"/);
  assert.match(r.text, /Complete blood count \(CBC\)/, 'the starter list is added on first use');
  const cbc = await knex('order_catalog').where({ business_id: businessId, code: 'CBC' }).first('id');
  const hba = await knex('order_catalog').where({ business_id: businessId, code: 'HBA1C' }).first('id');
  r = await o.submit(`/app/visits/${visit}`, `/app/visits/${visit}/orders`, { kind: 'lab', tests: [String(cbc.id), String(hba.id)], other: 'Zinc level', urgency: 'urgent' });
  assert.equal(r.status, 302);
  const order = await knex('medical_orders').where({ business_id: businessId, appointment_id: visit }).first();
  assert.ok(order);
  const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
  assert.deepEqual(items.map((i) => i.name), ['صورة دم كاملة', 'السكر التراكمي', 'Zinc level']);
  assert.equal(order.patient_id, patientId);
  r = await o.get(`/app/orders/${order.id}?print=1&lang=ar`);
  assert.equal(r.status, 200);
  assert.match(r.text, /print-letterhead/);
  assert.match(r.text, /طلب تحاليل مخبرية/);
  assert.match(r.text, /عاجل/);
  // nothing chosen → refused with its reason
  r = await o.submit(`/app/visits/${visit}`, `/app/visits/${visit}/orders`, { kind: 'imaging' });
  assert.equal(r.status, 302);
  assert.equal(Number((await knex('medical_orders').where({ appointment_id: visit }).count({ n: '*' }))[0].n), 1);
  r = await o.submit(`/app/orders/${order.id}`, `/app/orders/${order.id}/status`, { status: 'done', result_note: 'HbA1c 6.1%' });
  assert.equal(r.status, 302);
  const after = await knex('medical_orders').where({ id: order.id }).first();
  assert.equal(after.status, 'done');
  assert.equal(after.result_note, 'HbA1c 6.1%');
  // another clinic's visit cannot be ordered on; another clinic's catalog ids are ignored
  r = await o.submit(`/app/visits/${visit}`, `/app/visits/${otherVisit}/orders`, { kind: 'lab', other: 'x' });
  assert.ok(r.status === 404 || r.status === 302);
  assert.ok(!(await knex('medical_orders').where({ appointment_id: otherVisit }).first()));
});

test('referral letter from the visit, printed with the reason', async () => {
  const o = app.agent(); await o.login(mail('a'));
  let r = await o.submit(`/app/visits/${visit}`, `/app/visits/${visit}/referrals`, { specialty: 'قلب', to_doctor: 'د. سامي', reason: 'خفقان متكرر', summary: 'ECG طبيعي' });
  assert.equal(r.status, 302);
  const ref = await knex('referrals').where({ business_id: businessId, appointment_id: visit }).first();
  assert.equal(ref.specialty, 'قلب');
  r = await o.get(`/app/referrals/${ref.id}?print=1&lang=ar`);
  assert.equal(r.status, 200);
  assert.match(r.text, /تحويل إلى قلب/);
  assert.match(r.text, /خفقان متكرر/);
  r = await o.submit(`/app/visits/${visit}`, `/app/visits/${visit}/referrals`, { specialty: 'عيون' });
  assert.equal(Number((await knex('referrals').where({ appointment_id: visit }).count({ n: '*' }))[0].n), 1, 'a referral needs a reason');
});

test('scanned files: uploaded to the patient file (type read from the bytes), opened, listed, deleted', async () => {
  const o = app.agent(); await o.login(mail('a'));
  let r = await o.upload(`/app/patients/${patientId}?tab=orders`, `/app/patients/${patientId}/files`, { category: 'lab_result', title: 'CBC result' }, { files: { buffer: PDF, name: 'scan.pdf' } });
  assert.equal(r.status, 302, r.text.slice(0, 200));
  const f = await knex('patient_files').where({ business_id: businessId, patient_id: patientId }).first('id', 'mime', 'name', 'category');
  assert.equal(f.mime, 'application/pdf');
  assert.equal(f.category, 'lab_result');
  r = await o.get(`/app/patients/${patientId}/files/${f.id}`);
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/pdf/);
  r = await o.get(`/app/patients/${patientId}?tab=orders&lang=en`);
  assert.match(r.text, /CBC result/);
  assert.match(r.text, /Tests ordered/);
  // a renamed text file is refused; another clinic's patient is not found
  r = await o.upload(`/app/patients/${patientId}?tab=orders`, `/app/patients/${patientId}/files`, {}, { files: { buffer: Buffer.from('hello world, not a pdf'), name: 'fake.pdf' } });
  assert.equal(r.status, 302);
  assert.equal(Number((await knex('patient_files').where({ patient_id: patientId }).count({ n: '*' }))[0].n), 1);
  r = await o.upload(`/app/patients/${patientId}?tab=orders`, `/app/patients/${otherPatient}/files`, {}, { files: { buffer: PDF, name: 'x.pdf' } });
  assert.equal(r.status, 404);
  r = await o.get(`/app/patients/${otherPatient}/files/${f.id}`);
  assert.equal(r.status, 404);
  r = await o.submit(`/app/patients/${patientId}?tab=orders`, `/app/patients/${patientId}/files/${f.id}/delete`, {});
  assert.equal(r.status, 302);
  assert.ok(!(await knex('patient_files').where({ id: f.id }).first()));
});

test('tests list: add, edit and hide items; clinical report shows the period', async () => {
  const o = app.agent(); await o.login(mail('a'));
  let r = await o.submit('/app/clinic/orders-catalog', '/app/clinic/orders-catalog', { kind: 'imaging', name: 'أشعة الجيوب الأنفية', name_en: 'Sinus X-ray', code: 'SINUS', is_active: '1' });
  assert.equal(r.status, 302);
  const it = await knex('order_catalog').where({ business_id: businessId, code: 'SINUS' }).first();
  assert.ok(it);
  r = await o.submit('/app/clinic/orders-catalog', `/app/clinic/orders-catalog/${it.id}`, { kind: 'imaging', name: 'أشعة الجيوب الأنفية', code: 'SINUS' });
  assert.equal(Boolean((await knex('order_catalog').where({ id: it.id }).first()).is_active), false);
  r = await o.get('/app/reports/clinical?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /Most ordered tests/);
  assert.match(r.text, /صورة دم كاملة|Complete blood count/);
});

test('cancellation message: only for the clinic cancelling an upcoming appointment', async () => {
  // Not set up to send anything → nothing happens and nothing breaks.
  assert.equal(await messaging.notifyCancelled({ businessId, userId: 1 }, visit), null);
  assert.equal(await messaging.notifyCancelled({ businessId, userId: null }, visit), null, 'patient cancelled → no message');
  assert.equal(messaging.DEFAULTS.cancellations_enabled, true);
});

test('the clinic cancels an upcoming appointment from the app → the patient gets a WhatsApp message once', async () => {
  const ch = require('../src/modules/messaging/channels'); // eslint-disable-line global-require
  const realFetch = ch.transport.fetch;
  const calls = [];
  ch.transport.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: 'wamid.x' }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    const owner = (await knex('users').where({ email: mail('a') }).first('id')).id;
    await messaging.saveSettings({ businessId, userId: owner, ip: '127.0.0.1' }, {
      confirmations_enabled: '', cancellations_enabled: '1', reminders_enabled: '', reviews_enabled: '', use_whatsapp: '1', default_dial: '962', message_locale: 'ar',
      wa_phone_number_id: '1234567890', wa_token: 'EAAG-test-token', wa_tpl_cancelled: 'appointment_cancelled', wa_lang_ar: 'ar', wa_lang_en: 'en',
    });
    const day = scheduling.addDays ? scheduling.addDays(scheduling.clinicNow('Asia/Amman').date, 3) : new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const doc = (await knex('doctors').where({ business_id: businessId }).first('id')).id;
    const [id] = await knex('appointments').insert({ business_id: businessId, doctor_id: doc, patient_id: patientId, patient_name: 'Order Patient', patient_phone: '0791111111', appointment_date: day, appointment_time: '11:00', status: 'confirmed', appointment_type: 'in_person', source: 'staff' });
    const o = app.agent(); await o.login(mail('a'));
    const r = await o.submit('/app/appointments', `/app/appointments/${id}/status`, { status: 'cancelled' });
    assert.equal(r.status, 302);
    assert.equal((await knex('appointments').where({ id }).first('status')).status, 'cancelled');
    const sent = calls.filter((b) => b.template && b.template.name === 'appointment_cancelled');
    assert.equal(sent.length, 1);
    assert.ok(await knex('message_dispatches').where({ appointment_id: id, stage: 'cancelled' }).first());
    // turned off → nothing more is sent
    await knex('clinic_messaging').where({ business_id: businessId }).update({ cancellations_enabled: false });
    cache.forgetPrefix('');
    await knex('appointments').where({ id }).update({ status: 'confirmed', appointment_time: '12:00' });
    await o.submit('/app/appointments', `/app/appointments/${id}/status`, { status: 'cancelled' });
    assert.equal(calls.filter((b) => b.template && b.template.name === 'appointment_cancelled').length, 1);
  } finally { ch.transport.fetch = realFetch; }
});
