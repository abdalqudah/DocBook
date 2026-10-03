// The patient file export (one ZIP: summary PDF, every paper as PDF, the stored files, data.json, README), what each
// role gets, the audit + access log, and the one storage size that now counts patient files and chat attachments.
process.env.NODE_ENV = 'test';
process.env.PATIENT_EXPORT_DIR = require('path').join(require('os').tmpdir(), `px-${process.pid}-${Date.now()}`);
const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const storage = require('../src/modules/storage/storage.service');
const orders = require('../src/modules/orders/orders.service');
const chat = require('../src/modules/chat/chat.service');
const bulk = require('../src/modules/patientexport/bulk.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `px-${k}-${tag}@t.test`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkYGD4z8DAwMDAwMDAAAANBAEB8yJyWQAAAABJRU5ErkJggg==', 'base64');
let app; let B; let pid; let ownerId;

async function member(key, roleKey) {
  const id = await knex.transaction((trx) => auth.createUser(trx, { name: roleKey, email: mail(key), password: 'Passw0rd!x' }));
  await knex('users').where({ id }).update({ last_business_id: B, email_verified_at: new Date() });
  await knex('memberships').insert({ business_id: B, user_id: id, role_id: (await rbac.getRoleByKey(B, roleKey)).id });
  return id;
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ownerId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Dr Export', email: mail('o'), password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'عيادة التصدير', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: ownerId }).update({ email_verified_at: new Date() });
  ({ last_business_id: B } = await knex('users').where({ id: ownerId }).first('last_business_id'));
  await knex('businesses').where({ id: B }).update({ onboarding_completed_at: new Date() });
  const today = scheduling.clinicNow('Asia/Amman').date;
  const [doc] = await knex('doctors').insert({ business_id: B, full_name: 'د. سامي', is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()), slot_duration_minutes: 30 });
  [pid] = await knex('patients').insert({ business_id: B, full_name: 'أحمد يوسف', phone: '0791234567', date_of_birth: '1988-09-07', gender: 'male', allergies: 'بنسلين' });
  const [visit] = await knex('appointments').insert({ business_id: B, doctor_id: doc, patient_id: pid, patient_name: 'أحمد يوسف', patient_phone: '0791234567', appointment_date: today, appointment_time: '10:00', status: 'completed', appointment_type: 'in_person', source: 'staff' });
  await knex('consultations').insert({ business_id: B, appointment_id: visit, doctor_id: doc, patient_id: pid, patient_name: 'أحمد يوسف', chief_complaint: 'ألم أسنان', diagnosis: 'تسوس', vital_signs: JSON.stringify({ bloodPressure: '120/80' }) });
  await knex('prescriptions').insert({ business_id: B, appointment_id: visit, doctor_id: doc, patient_id: pid, patient_name: 'أحمد يوسف', items: JSON.stringify([{ medicationName: 'Amoxicillin', dosage: '500 mg' }]) });
  await knex('invoices').insert({ business_id: B, invoice_number: 1001, appointment_id: visit, doctor_id: doc, patient_id: pid, patient_name: 'أحمد يوسف', amount: 25, subtotal: 25 });
  const ctx = { businessId: B, userId: ownerId, permissions: await rbac.getUserPermissions(B, ownerId), ownDoctorId: null };
  await orders.addFiles(ctx, pid, [{ buffer: PNG, size: PNG.length, originalname: 'صورة أشعة بانوراما.png' }], { category: 'imaging', title: 'بانوراما', appointment_id: visit });
  await member('r', 'receptionist');
  await member('n', 'nurse');
  rbac.invalidate(B);
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('the owner exports the whole file: summary, papers, the X-ray as uploaded, data.json, README; logged', async () => {
  const o = app.agent(); await o.login(mail('o'));
  const page = await o.get(`/app/patients/${pid}`);
  assert.match(page.text, new RegExp(`action="/app/patients/${pid}/export"`));
  const r = await o.post(`/app/patients/${pid}/export`, { _csrf: o.csrf(page.text) });
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/zip/);
  const zip = new AdmZip(r.body);
  const names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.includes('00-summary.pdf'));
  assert.ok(names.includes('data.json'));
  assert.ok(names.includes('README.txt'));
  assert.ok(names.some((n) => /^papers\/\d{4}-\d{2}-\d{2}_prescription-\d+\.pdf$/.test(n)), names.join(','));
  assert.ok(names.some((n) => /^papers\/.*_report-\d+\.pdf$/.test(n)));
  assert.ok(names.some((n) => /^papers\/.*_invoice-\d+\.pdf$/.test(n)));
  const xray = names.find((n) => /^files\/.*\.png$/.test(n));
  assert.ok(xray);
  assert.deepEqual(zip.getEntry(xray).getData(), PNG);
  assert.equal(zip.getEntry('00-summary.pdf').getData().subarray(0, 5).toString(), '%PDF-');
  const data = JSON.parse(zip.getEntry('data.json').getData().toString('utf8'));
  assert.equal(data.patient.full_name, 'أحمد يوسف');
  assert.equal(data.prescriptions[0].items[0].medicationName, 'Amoxicillin');
  assert.equal(data.files[0].path, xray);
  assert.ok(!('data' in data.files[0]));
  assert.deepEqual(data.not_included, []);
  assert.ok(await knex('audit_logs').where({ business_id: B, action: 'patient.exported', entity_id: pid }).first());
  assert.ok(await knex('record_access_log').where({ business_id: B, patient_id: pid, what: 'export' }).first());
});

test('a nurse gets the clinical file without invoices; roles without the patient file or export cannot export', async () => {
  const n = app.agent(); await n.login(mail('n'));
  const page = await n.get(`/app/patients/${pid}`);
  assert.equal(page.status, 200);
  const r = await n.post(`/app/patients/${pid}/export`, { _csrf: n.csrf(page.text) });
  assert.equal(r.status, 200);
  const zip = new AdmZip(r.body);
  const names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.some((x) => x.startsWith('files/')), names.join(','));
  assert.ok(!names.some((x) => /invoice/.test(x)), names.join(','));
  const data = JSON.parse(zip.getEntry('data.json').getData().toString('utf8'));
  assert.ok(data.not_included.includes('billing'));
  assert.equal(data.invoices.length, 0);

  const rc = app.agent(); await rc.login(mail('r'));
  const p2 = await rc.get(`/app/patients/${pid}`);
  assert.doesNotMatch(p2.text, /\/export"/);
  const r2 = await rc.post(`/app/patients/${pid}/export`, { _csrf: rc.csrf(p2.text) });
  assert.equal(r2.status, 403);
});

test('one storage size: patient files and chat attachments count, and are refused when it is full', async () => {
  const ctx = { businessId: B, userId: ownerId, permissions: await rbac.getUserPermissions(B, ownerId), ownDoctorId: null };
  let s = await storage.stats(B);
  assert.equal(s.by.patients, PNG.length);
  assert.ok(s.bytes >= PNG.length);
  await knex('businesses').where({ id: B }).update({ media_quota_mb: 1 });
  await knex('patient_files').where({ business_id: B }).update({ size: 1024 * 1024 }); // pretend the X-ray fills it
  s = await storage.stats(B);
  assert.equal(s.quota, 1024 * 1024);
  await assert.rejects(orders.addFiles(ctx, pid, [{ buffer: PNG, size: PNG.length, originalname: 'b.png' }], {}), (e) => e.code === 'STORAGE_FULL');
  const room = await chat.room(ctx);
  await assert.rejects(chat.send(ctx, room.id, 'صورة', [{ buffer: PNG, originalname: 'c.png', mimetype: 'image/png' }]), (e) => e.code === 'STORAGE_FULL');
  await chat.send(ctx, room.id, 'نص فقط'); // a message without files still goes
  await knex('businesses').where({ id: B }).update({ media_quota_mb: null });
});

test('every patient in one ZIP: built in the background, index + a folder per patient, download, delete; data.export only', async () => {
  const o = app.agent(); await o.login(mail('o'));
  const list = await o.get('/app/patients');
  assert.match(list.text, /href="\/app\/patients\/export-all"/);
  let page = await o.get('/app/patients/export-all');
  assert.equal(page.status, 200);
  let r = await o.post('/app/patients/export-all', { _csrf: o.csrf(page.text) });
  assert.equal(r.status, 302);
  await bulk.settle(B);
  const st = JSON.parse((await o.get('/app/patients/export-all/status')).text);
  assert.equal(st.state, 'idle');
  page = await o.get('/app/patients/export-all');
  const name = (page.text.match(/href="\/app\/patients\/export-all\/(patients-[^"]+\.zip)"/) || [])[1];
  assert.ok(name, 'download link');
  r = await o.get(`/app/patients/export-all/${name}`);
  assert.equal(r.status, 200);
  const zip = new AdmZip(r.body);
  const names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.includes('index.xlsx') && names.includes('index.csv') && names.includes('README.txt'));
  const folder = names.find((n) => new RegExp(`^patients/\\d{5}_${pid}_[^/]+/00-summary\\.pdf$`).test(n));
  assert.ok(folder, names.join(','));
  assert.ok(names.some((n) => n.startsWith(folder.replace('00-summary.pdf', 'files/'))));
  assert.match(zip.getEntry('index.csv').getData().toString('utf8'), /أحمد يوسف/);
  assert.ok(await knex('audit_logs').where({ business_id: B, action: 'patients.exported_all' }).first());
  assert.ok(await knex('audit_logs').where({ business_id: B, action: 'patients.export_downloaded' }).first());
  assert.equal((await o.get('/app/patients/export-all/../../x.zip')).status, 404);

  const n = app.agent(); await n.login(mail('n'));
  assert.equal((await n.get('/app/patients/export-all')).status, 403);
  assert.equal((await n.get(`/app/patients/export-all/${name}`)).status, 403);

  r = await o.post(`/app/patients/export-all/${name}/delete`, { _csrf: o.csrf(page.text) });
  assert.equal(r.status, 302);
  assert.equal((await o.get(`/app/patients/export-all/${name}`)).status, 404);
});
