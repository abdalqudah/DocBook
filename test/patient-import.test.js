// Importing patient exports: into another clinic (everything new, doctors matched by name, invoices/certificates as
// PDF files, upcoming bookings left out), the same file again (nothing doubled), back into the same clinic (what was
// deleted returns with its old number), a bad file, and who may import.
process.env.NODE_ENV = 'test';
const os = require('os');
const path = require('path');
process.env.PATIENT_EXPORT_DIR = path.join(os.tmpdir(), `pxe-${process.pid}-${Date.now()}`);
process.env.PATIENT_IMPORT_DIR = path.join(os.tmpdir(), `pxi-${process.pid}-${Date.now()}`);
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const orders = require('../src/modules/orders/orders.service');
const bulk = require('../src/modules/patientexport/bulk.service');
const importer = require('../src/modules/patientexport/import.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `pi-${k}-${tag}@t.test`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkYGD4z8DAwMDAwMDAAAANBAEB8yJyWQAAAABJRU5ErkJggg==', 'base64');
let app; let A; let B; let pidA; let rxA; let fileA;

async function clinic(k) {
  const id = await knex.transaction(async (trx) => {
    const u = await auth.createUser(trx, { name: `Owner ${k}`, email: mail(k), password: 'Passw0rd!x' });
    await businesses.create(u, { name: `عيادة ${k}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return u;
  });
  await knex('users').where({ id }).update({ email_verified_at: new Date() });
  const { last_business_id: b } = await knex('users').where({ id }).first('last_business_id');
  await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date() });
  return { b, user: id };
}
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const count = async (table, b, extra = {}) => Number((await knex(table).where({ business_id: b, ...extra }).count({ n: '*' }))[0].n);

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const a = await clinic('a'); A = a.b;
  const bb = await clinic('b'); B = bb.b;
  const today = scheduling.clinicNow('Asia/Amman').date;
  const wh = JSON.stringify(scheduling.defaultWorkingHours());
  const [docA] = await knex('doctors').insert({ business_id: A, full_name: 'د. سامي', is_active: true, working_hours: wh, slot_duration_minutes: 30 });
  await knex('doctors').insert({ business_id: B, full_name: 'د. سامي', is_active: true, working_hours: wh, slot_duration_minutes: 30 });
  [pidA] = await knex('patients').insert({ business_id: A, full_name: 'ليلى حسن', phone: '0790000111', national_id: '9900112233', allergies: 'لاتكس' });
  const [v1] = await knex('appointments').insert({ business_id: A, doctor_id: docA, patient_id: pidA, patient_name: 'ليلى حسن', appointment_date: '2026-01-10', appointment_time: '09:00', status: 'completed', appointment_type: 'in_person', source: 'staff' });
  await knex('appointments').insert({ business_id: A, doctor_id: docA, patient_id: pidA, patient_name: 'ليلى حسن', appointment_date: '2099-01-01', appointment_time: '09:00', status: 'confirmed', appointment_type: 'in_person', source: 'staff' });
  await knex('consultations').insert({ business_id: A, appointment_id: v1, doctor_id: docA, patient_id: pidA, patient_name: 'ليلى حسن', diagnosis: 'التهاب لثة', vital_signs: JSON.stringify({ pulseBpm: '80' }) });
  [rxA] = await knex('prescriptions').insert({ business_id: A, appointment_id: v1, doctor_id: docA, patient_id: pidA, patient_name: 'ليلى حسن', items: JSON.stringify([{ medicationName: 'Chlorhexidine' }]) });
  await knex('invoices').insert({ business_id: A, invoice_number: 501, appointment_id: v1, doctor_id: docA, patient_id: pidA, patient_name: 'ليلى حسن', amount: 20, subtotal: 20 });
  const ctx = { businessId: A, userId: a.user, permissions: await rbac.getUserPermissions(A, a.user), ownDoctorId: null };
  [fileA] = await orders.addFiles(ctx, pidA, [{ buffer: PNG, size: PNG.length, originalname: 'xray.png' }], { category: 'imaging', title: 'أشعة', appointment_id: v1 });
  const nurse = await knex.transaction((trx) => auth.createUser(trx, { name: 'Nurse', email: mail('n'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: nurse }).update({ last_business_id: B, email_verified_at: new Date() });
  await knex('memberships').insert({ business_id: B, user_id: nurse, role_id: (await rbac.getRoleByKey(B, 'nurse')).id });
  void today; // eslint-disable-line no-void
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

async function exportOne(agent, pid) {
  const page = await agent.get(`/app/patients/${pid}`);
  const r = await agent.post(`/app/patients/${pid}/export`, { _csrf: agent.csrf(page.text) });
  assert.equal(r.status, 200);
  return r.body;
}
async function importZip(agent, buf, business, doctorPick = {}) {
  const r = await agent.upload('/app/patients/export-all', '/app/patients/import', {}, { file: { buffer: buf, name: 'export.zip' } });
  assert.equal(r.status, 302, r.text.slice(0, 200));
  const token = (r.location.match(/\/app\/patients\/import\/([a-f0-9]{16})$/) || [])[1];
  assert.ok(token, r.location);
  const preview = await agent.get(r.location);
  assert.equal(preview.status, 200);
  const s = await agent.post(`/app/patients/import/${token}`, { _csrf: agent.csrf(preview.text), ...doctorPick });
  assert.equal(s.status, 302);
  await importer.settle(business);
  return { token, preview: preview.text, meta: importer.get(business, token) };
}

test('into another clinic: the patient and the record come in; doctors by name; papers as files; upcoming left out', async () => {
  const oa = app.agent(); await oa.login(mail('a'));
  const zip = await exportOne(oa, pidA);
  const ob = app.agent(); await ob.login(mail('b'));
  const { preview, meta } = await importZip(ob, zip, B);
  assert.match(preview, /د\. سامي/);
  assert.equal(meta.state, 'done', JSON.stringify(meta));
  const p = await knex('patients').where({ business_id: B, national_id: '9900112233' }).first();
  assert.ok(p);
  assert.equal(p.allergies, 'لاتكس');
  const docB = await knex('doctors').where({ business_id: B }).first('id');
  const visits = await knex('appointments').where({ business_id: B, patient_id: p.id }).select();
  assert.equal(visits.length, 1); // the 2099 booking is not imported
  assert.equal(visits[0].doctor_id, docB.id);
  assert.equal(meta.report.future, 1);
  const c = await knex('consultations').where({ business_id: B, patient_id: p.id }).first();
  assert.equal(c.appointment_id, visits[0].id);
  assert.equal(J(c.vital_signs).pulseBpm, '80');
  const rx = await knex('prescriptions').where({ business_id: B, patient_id: p.id }).first();
  assert.equal(J(rx.items)[0].medicationName, 'Chlorhexidine');
  const files = await knex('patient_files').where({ business_id: B, patient_id: p.id }).orderBy('id').select();
  assert.equal(files.length, 2); // the X-ray + the invoice PDF
  assert.deepEqual(Buffer.from(files[0].data), PNG);
  assert.equal(files[0].appointment_id, visits[0].id);
  assert.equal(files[1].mime, 'application/pdf');
  assert.equal(await count('invoices', B), 0);
  assert.ok(await knex('audit_logs').where({ business_id: B, action: 'patients.imported' }).first());

  // The same file again: nothing doubles.
  const before = [await count('patients', B), await count('appointments', B), await count('prescriptions', B), await count('patient_files', B)];
  const again = await importZip(ob, zip, B);
  assert.equal(again.meta.state, 'done');
  assert.deepEqual([await count('patients', B), await count('appointments', B), await count('prescriptions', B), await count('patient_files', B)], before);
});

test('back into the same clinic (every patient\'s file): deleted records return with their old numbers', async () => {
  const oa = app.agent(); await oa.login(mail('a'));
  const page = await oa.get('/app/patients/export-all');
  await oa.post('/app/patients/export-all', { _csrf: oa.csrf(page.text) });
  await bulk.settle(A);
  const name = bulk.list(A).find((x) => x.state === 'ready').name;
  const zip = (await oa.get(`/app/patients/export-all/${name}`)).body;
  const before = [await count('appointments', A), await count('consultations', A)];
  await knex('prescriptions').where({ id: rxA }).del();
  await knex('patient_files').where({ id: fileA }).del();
  const { preview, meta } = await importZip(oa, zip, A);
  assert.match(preview, /هذا الملف من هذه العيادة|comes from this clinic/);
  assert.equal(meta.state, 'done', JSON.stringify(meta));
  assert.ok(await knex('prescriptions').where({ id: rxA, business_id: A }).first());
  const f = await knex('patient_files').where({ id: fileA, business_id: A }).first();
  assert.ok(f);
  assert.deepEqual(Buffer.from(f.data), PNG);
  assert.deepEqual([await count('appointments', A), await count('consultations', A)], before);
  assert.equal(await count('patients', A), 1);
  assert.equal(await count('patient_files', A), 1); // the invoice still exists here, so no PDF copy
});

test('a file that is not an export is refused; members without data.manage cannot import', async () => {
  const ob = app.agent(); await ob.login(mail('b'));
  const r = await ob.upload('/app/patients/export-all', '/app/patients/import', {}, { file: { buffer: Buffer.from('not a zip'), name: 'x.zip' } });
  assert.equal(r.status, 302);
  assert.match(r.location, /export-all#import/);
  const n = app.agent(); await n.login(mail('n'));
  const pg = await n.get('/app/patients');
  const r2 = await n.post('/app/patients/import/0123456789abcdef', { _csrf: n.csrf(pg.text) });
  assert.equal(r2.status, 403);
});
