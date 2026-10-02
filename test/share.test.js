// Sending documents to patients by WhatsApp: a secure link (only its hash stored, expires, withdrawn with the
// document), opening only that document — invoice, prescription, visit report, lab order, patient file.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const scheduling = require('../src/modules/clinic/scheduling');
const share = require('../src/modules/share/share.service');
const mailer = require('../src/core/mailer');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `sh-${k}-${tag}@t.test`;
let app; let businessId; let visit; let patientId; let invId; let rxId; let fileId; let otherBiz;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const mk = async (k) => {
    const id = await knex.transaction(async (trx) => { const u = await auth.createUser(trx, { name: 'Owner', email: mail(k), password: 'Passw0rd!x' }); await businesses.create(u, { name: `Share ${k}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx); return u; });
    await knex('users').where({ id }).update({ email_verified_at: new Date() });
    const b = (await knex('users').where({ id }).first('last_business_id')).last_business_id;
    await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date(), slug: `sh-${k}-${tag}`.slice(0, 40), country: 'JO' });
    businesses.forget(b);
    return b;
  };
  businessId = await mk('a');
  otherBiz = await mk('b');
  const today = scheduling.clinicNow('Asia/Amman').date;
  const [doc] = await knex('doctors').insert({ business_id: businessId, full_name: 'Dr Share', is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()), slot_duration_minutes: 30 });
  [patientId] = await knex('patients').insert({ business_id: businessId, full_name: 'Share Patient', phone: '0791234567' });
  [visit] = await knex('appointments').insert({ business_id: businessId, doctor_id: doc, patient_id: patientId, patient_name: 'Share Patient', patient_phone: '0791234567', appointment_date: today, appointment_time: '10:00', status: 'completed', appointment_type: 'in_person', source: 'staff' });
  await knex('consultations').insert({ business_id: businessId, appointment_id: visit, doctor_id: doc, patient_id: patientId, patient_name: 'Share Patient', diagnosis: 'Acute pharyngitis' });
  [rxId] = await knex('prescriptions').insert({ business_id: businessId, appointment_id: visit, doctor_id: doc, patient_id: patientId, patient_name: 'Share Patient', patient_phone: '0791234567', items: JSON.stringify([{ medicationName: 'Paracetamol', dosage: '500 mg' }]) });
  [invId] = await knex('invoices').insert({ business_id: businessId, invoice_number: 77, appointment_id: visit, patient_id: patientId, doctor_id: doc, doctor_name: 'Dr Share', service_name: 'Visit', patient_name: 'Share Patient', patient_phone: '0791234567', amount: 25, payment_method: 'cash', discount_amount: 0, discount_percent: 0 });
  [fileId] = await knex('patient_files').insert({ business_id: businessId, patient_id: patientId, appointment_id: visit, category: 'imaging', title: 'Chest X-ray', name: 'xray.png', mime: 'image/png', size: 8, sha256: 'x'.repeat(64), data: Buffer.from('89504e470d0a1a0a', 'hex') });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

const waLink = (r) => { assert.equal(r.status, 302, r.text && r.text.slice(0, 200)); assert.match(r.location, /^https:\/\/wa\.me\/962791234567\?text=/); return decodeURIComponent(r.location.split('text=')[1]); };

test('WhatsApp buttons open a chat with the patient and a secure link; the link opens only that document', async () => {
  const o = app.agent(); await o.login(mail('a'));
  // invoice
  let r = await o.get(`/app/share/wa?kind=invoice&id=${invId}&lang_msg=ar`, { referer: `http://x/app/billing/${invId}` });
  const text = waLink(r);
  assert.match(text, /Share Patient/);
  assert.match(text, /الفاتورة رقم 77/);
  const url = text.match(/https?:\/\/[^\s]+\/d\/([A-Za-z0-9_-]+)/);
  assert.ok(url, 'the message carries the link');
  const visitor = app.agent();
  r = await visitor.get(`/d/${url[1]}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Share Patient/);
  assert.match(r.text, /Visit/);
  assert.doesNotMatch(r.text, /Acute pharyngitis/, 'nothing else of the record');
  // print / save as PDF / share buttons (screen only), the clinic's public colours, and the PDF itself
  assert.match(r.text, new RegExp(`/d/${url[1]}/pdf\\?dl=1`));
  assert.match(r.text, /data-share-pdf=/);
  assert.match(r.text, /share-actions no-print/);
  assert.doesNotMatch(r.text, /\/app\/theme\//);
  r = await visitor.get(`/d/${url[1]}/pdf?dl=1`);
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/pdf/);
  assert.match(r.text.slice(0, 5), /%PDF-/);
  // a test request and a referral as PDF too (signed sheets on the clinic's letterhead)
  const [oid] = await knex('medical_orders').insert({ business_id: businessId, appointment_id: visit, patient_id: patientId, doctor_id: null, patient_name: 'Share Patient', kind: 'lab', items: JSON.stringify([{ name: 'CBC', code: 'CBC' }]), status: 'ordered' });
  const [fid] = await knex('referrals').insert({ business_id: businessId, appointment_id: visit, patient_id: patientId, patient_name: 'Share Patient', specialty: 'Cardiology', reason: 'Chest pain' });
  const staffCtx = { businessId, userId: null, ownDoctorId: null, permissions: new Set(['clinical.view']) };
  for (const [kind, id] of [['order', oid], ['referral', fid]]) {
    const made = await share.create(staffCtx, kind, id, { locale: 'ar' });
    r = await visitor.get(`${made.url}/pdf`);
    assert.equal(r.status, 200, kind);
    assert.match(r.type, /application\/pdf/, kind);
  }
  await knex('medical_orders').where({ id: oid }).del(); await knex('referrals').where({ id: fid }).del();
  // prescription and visit report as PDF
  for (const [kind, id] of [['prescription', rxId], ['report', visit]]) {
    r = await o.get(`/app/share/wa?kind=${kind}&id=${id}`);
    const tok = waLink(r).match(/\/d\/([A-Za-z0-9_-]+)/)[1];
    r = await visitor.get(`/d/${tok}`);
    assert.equal(r.status, 200);
    assert.match(r.type, /application\/pdf/, kind);
  }
  // an imaging file
  r = await o.get(`/app/share/wa?kind=file&id=${fileId}`);
  const ft = waLink(r).match(/\/d\/([A-Za-z0-9_-]+)/)[1];
  r = await visitor.get(`/d/${ft}`);
  assert.match(r.type, /image\/png/);
  // only a hash is stored; an unknown, expired or withdrawn link shows "not available"
  const row = await knex('share_links').where({ kind: 'file', ref_id: fileId }).first();
  assert.notEqual(row.token_hash, ft);
  assert.equal(row.opens, 1);
  r = await visitor.get('/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(r.status, 404);
  await knex('share_links').where({ id: row.id }).update({ expires_at: new Date(Date.now() - 1000) });
  r = await visitor.get(`/d/${ft}`);
  assert.equal(r.status, 404);
});

test('Today shows each visit\'s papers; one WhatsApp link lists all of them; the same link goes out by e-mail', async () => {
  const o = app.agent(); await o.login(mail('a'));
  let r = await o.get('/app');
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`/app/visits/${visit}/prescriptions/${rxId}`), 'prescription icon');
  assert.match(r.text, new RegExp(`/app/billing/${invId}"`), 'invoice icon');
  assert.match(r.text, new RegExp(`kind=visit&id=${visit}"`), 'send-all button');
  r = await o.get(`/app/share/wa?kind=visit&id=${visit}&lang_msg=en`);
  const tok = waLink(r).match(/\/d\/([A-Za-z0-9_-]+)/)[1];
  const visitor = app.agent();
  r = await visitor.get(`/d/${tok}?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Your visit documents/);
  const items = JSON.parse((await knex('share_links').where({ kind: 'visit', ref_id: visit }).first('options')).options).items;
  assert.deepEqual(items.map((i) => i.kind), ['invoice', 'prescription', 'report', 'file']);
  assert.match(r.text, new RegExp(`/d/${tok}/i/3`));
  r = await visitor.get(`/d/${tok}/i/0`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Share Patient/);
  r = await visitor.get(`/d/${tok}/i/1`);
  assert.match(r.type, /application\/pdf/);
  r = await visitor.get(`/d/${tok}/i/0/pdf`);
  assert.match(r.type, /application\/pdf/, 'the visit\'s invoice as PDF');
  r = await visitor.get(`/d/${tok}/i/3/pdf`);
  assert.equal(r.status, 404, 'a file is not turned into a PDF');
  r = await visitor.get(`/d/${tok}/i/9`);
  assert.equal(r.status, 404);
  // e-mail: refused without an address, sent straight away with one
  const real = { configuredFor: mailer.configuredFor, send: mailer.send }; const sent = [];
  mailer.configuredFor = async () => true; mailer.send = async (m) => { sent.push(m); return true; };
  try {
    r = await o.submit('/app', '/app/share/email', { kind: 'visit', id: visit });
    assert.equal(r.status, 302);
    assert.equal(sent.length, 0);
    await knex('patients').where({ id: patientId }).update({ email: 'patient@share.test' });
    r = await o.submit('/app', '/app/share/email', { kind: 'visit', id: visit });
    assert.equal(r.status, 302);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'patient@share.test');
    assert.equal(sent[0].kind, 'patient_letters');
    assert.match(sent[0].html, /\/d\/[A-Za-z0-9_-]{20,}/);
    // the e-mail button beside each document (kind and id in the address, the page-wide form's token in the body)
    r = await o.get(`/app/billing/${invId}`);
    assert.match(r.text, /id="share-mail-form"/);
    r = await o.submit(`/app/billing/${invId}`, `/app/share/email?kind=invoice&id=${invId}`, {});
    assert.equal(r.status, 302);
    assert.equal(sent.length, 2);
  } finally { Object.assign(mailer, real); }
});

test('reception prints the prescription and the test request from Today; only the clinic\'s admins void an invoice', async () => {
  const rid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Reception', email: mail('rec'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: rid }).update({ email_verified_at: new Date() });
  const role = await knex('roles').where({ business_id: businessId, key: 'receptionist' }).first('id');
  await knex('memberships').insert({ business_id: businessId, user_id: rid, role_id: role.id, status: 'active' });
  await knex('users').where({ id: rid }).update({ last_business_id: businessId });
  const [oid] = await knex('medical_orders').insert({ business_id: businessId, appointment_id: visit, patient_id: patientId, patient_name: 'Share Patient', kind: 'imaging', items: JSON.stringify([{ name: 'Chest X-ray' }]), status: 'ordered' });
  const [lid] = await knex('medical_orders').insert({ business_id: businessId, appointment_id: visit, patient_id: patientId, patient_name: 'Share Patient', kind: 'lab', items: JSON.stringify([{ name: 'CBC' }]), status: 'ordered' });
  const [refId] = await knex('referrals').insert({ business_id: businessId, appointment_id: visit, patient_id: patientId, patient_name: 'Share Patient', specialty: 'Neurology', reason: 'Headache' });
  const rec = app.agent(); await rec.login(mail('rec'));
  let r = await rec.get('/app?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`/app/cashier/papers/${visit}/prescription/${rxId}\\.pdf`), 'print the prescription');
  assert.match(r.text, new RegExp(`/app/cashier/papers/${visit}/order/${oid}\\.pdf`), 'print the test request');
  assert.match(r.text, new RegExp(`/app/cashier/papers/${visit}/order/${lid}\\.pdf`), 'every request has its icon (lab too)');
  assert.match(r.text, new RegExp(`/app/cashier/papers/${visit}/referral/${refId}\\.pdf`), 'and the referral');
  assert.match(r.text, /Referral: Neurology/);
  r = await rec.get(`/app/cashier/papers/${visit}/referral/${refId}.pdf`);
  assert.match(r.type, /application\/pdf/);
  r = await rec.get(`/app/cashier/papers/${visit}/order/${oid}.pdf`);
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/pdf/);
  // no void for reception: neither the button nor the action
  r = await rec.get(`/app/billing/${invId}?lang=en`);
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, new RegExp(`/app/billing/${invId}/void`));
  r = await rec.submit(`/app/billing/${invId}`, `/app/billing/${invId}/void`, { confirm_name: '77' });
  assert.equal(r.status, 403);
  assert.ok(await knex('invoices').where({ id: invId }).first('id'), 'still there');
  const o = app.agent(); await o.login(mail('a'));
  r = await o.get(`/app/billing/${invId}`);
  assert.match(r.text, new RegExp(`/app/billing/${invId}/void`), 'the owner can void');
  await knex('medical_orders').whereIn('id', [oid, lid]).del(); await knex('referrals').where({ id: refId }).del();
});

test('another clinic cannot share these documents; a patient without a mobile gets a copy-the-link page', async () => {
  const other = app.agent(); await other.login(mail('b'));
  let r = await other.get(`/app/share/wa?kind=invoice&id=${invId}`);
  assert.equal(r.status, 404);
  assert.equal(Number((await knex('share_links').where({ business_id: otherBiz }).count({ n: '*' }))[0].n), 0);
  await knex('patients').where({ id: patientId }).update({ phone: null });
  await knex('invoices').where({ id: invId }).update({ patient_phone: null });
  await knex('appointments').where({ id: visit }).update({ patient_phone: '' });
  const o = app.agent(); await o.login(mail('a'));
  r = await o.get(`/app/share/wa?kind=invoice&id=${invId}&lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /no valid mobile number/);
  assert.match(r.text, /\/d\/[A-Za-z0-9_-]{20,}/);
  assert.ok(share.KINDS.includes('certificate'));
});
