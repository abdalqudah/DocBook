// Tenant isolation over HTTP (security audit, docs/SECURITY_AUDIT.md): two clinics, A and B. The owner of clinic A —
// every permission in A — asks for clinic B's records by id (patient, appointment, visit, invoice, prescription,
// patient file, legacy attachment, specialty record, order, surgery, chat, media, insurance claims, purchase order),
// posts changes to B's ids, switches the session to B, and runs A's own exports and searches. Every answer must be
// 403 / 404 (or a refusal that changes nothing) and must never carry B's data; B's rows must stay unchanged.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const { serve } = require('./_http');

require('http').globalAgent = new (require('http').Agent)({ keepAlive: false });

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `iso-${k}-${tag}@t.test`;
const SECRET = `SECRETB${tag}`; // appears only in clinic B's rows
const today = new Date().toISOString().slice(0, 10);
let app; let A; let B; let a;
const ids = {};

async function clinic(k) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: `Owner ${k}`, email: mail(k), password: 'Passw0rd!x' });
    await businesses.create(id, { name: `Iso ${k} ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('users').where({ id: userId }).update({ email_verified_at: new Date() });
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date() });
  return { businessId, userId };
}

/** Clinic B's records, written straight to the database (every row carries the SECRET marker). */
async function seedB() {
  const b = B.businessId;
  const one = async (table, row) => (await knex(table).insert({ business_id: b, ...row }))[0];
  ids.doctor = await one('doctors', { full_name: `Dr ${SECRET}`, is_active: true });
  ids.patient = await one('patients', { full_name: `Patient ${SECRET}`, phone: '0791111111', notes: `notes ${SECRET}` });
  ids.appt = await one('appointments', { patient_id: ids.patient, doctor_id: ids.doctor, patient_name: `Patient ${SECRET}`, patient_phone: '0791111111', appointment_date: today, appointment_time: '10:00', status: 'completed', notes: `appt ${SECRET}` });
  ids.consult = await one('consultations', { appointment_id: ids.appt, doctor_id: ids.doctor, patient_id: ids.patient, patient_name: `Patient ${SECRET}`, subjective: `soap ${SECRET}`, diagnosis: `dx ${SECRET}` });
  ids.rx = await one('prescriptions', { appointment_id: ids.appt, doctor_id: ids.doctor, patient_id: ids.patient, patient_name: `Patient ${SECRET}`, diagnosis: `rx ${SECRET}`, items: JSON.stringify([{ medicationName: `Drug ${SECRET}`, dosage: '1', frequency: '1', duration: '1' }]) });
  ids.invoice = await one('invoices', { invoice_number: 999001, appointment_id: ids.appt, doctor_id: ids.doctor, patient_id: ids.patient, patient_name: `Patient ${SECRET}`, amount: 77, subtotal: 77, payment_method: 'cash', service_name: `Svc ${SECRET}` });
  const data = Buffer.from(`%PDF-1.4\n% ${SECRET}\n%%EOF\n`);
  ids.file = await one('patient_files', { patient_id: ids.patient, appointment_id: ids.appt, category: 'scan', title: `File ${SECRET}`, name: `file-${SECRET}.pdf`, mime: 'application/pdf', size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), data });
  ids.attachment = await one('patient_attachments', { patient_id: ids.patient, original_filename: `old-${SECRET}.pdf`, stored_filename: `x-${tag}.pdf`, mime_type: 'application/pdf', category: 'document', file_size: 10, storage_path: `${b}/x-${tag}.pdf`, checksum: 'x' });
  ids.record = await one('specialty_records', { patient_id: ids.patient, appointment_id: ids.appt, doctor_id: ids.doctor, form_key: 'vitals', record_date: today, data: JSON.stringify({ note: SECRET }), headline: `rec ${SECRET}` });
  ids.order = await one('medical_orders', { patient_id: ids.patient, appointment_id: ids.appt, doctor_id: ids.doctor, kind: 'lab', items: JSON.stringify([{ name: `Lab ${SECRET}` }]), notes: `order ${SECRET}`, patient_name: `Patient ${SECRET}` });
  ids.surgery = await one('surgeries', { appointment_id: ids.appt, doctor_id: ids.doctor, patient_id: ids.patient, patient_name: `Patient ${SECRET}`, surgery_date: today, surgery_time: '09:00', procedure_name: `Op ${SECRET}` });
  ids.expense = await one('expenses', { date: today, category: 'other', title: `Exp ${SECRET}`, amount: 5 });
  ids.insurer = await one('insurance_providers', { name: `Ins ${SECRET}`, coverage_percent: 50, is_active: true });
  ids.supplier = await one('suppliers', { name: `Sup ${SECRET}` }).catch(() => null);
  ids.po = await one('purchase_orders', { supplier_name: `Sup ${SECRET}`, notes: `po ${SECRET}` }).catch(() => null);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  ids.media = await one('clinic_media', { name: `m-${SECRET}`, mime: 'image/png', size: png.length, width: 1, height: 1, sha: crypto.createHash('sha1').update(png).digest('hex').slice(0, 16), data: png, is_public: false });
  ids.chat = await one('staff_chats', { kind: 'group' });
  await knex('staff_chat_members').insert({ chat_id: ids.chat, user_id: B.userId });
  await knex('staff_chat_messages').insert({ chat_id: ids.chat, business_id: b, user_id: B.userId, body: `chat ${SECRET}` });
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  A = await clinic('a');
  B = await clinic('b');
  await seedB();
  // Clinic A has a patient of its own (for "A's patient id + B's file id").
  [ids.aPatient] = await knex('patients').insert({ business_id: A.businessId, full_name: `A patient ${tag}`, phone: '0792222222' });
  app = await serve();
  a = app.agent();
  await a.login(mail('a'));
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

const refused = (r) => [403, 404].includes(r.status);
function noLeak(r, what) {
  assert.ok(!r.text.includes(SECRET), `${what}: answer carries clinic B's data (status ${r.status})`);
  assert.ok(!(r.body && r.body.includes(Buffer.from(SECRET))), `${what}: body carries clinic B's data`);
}
async function getRefused(path) {
  const r = await a.get(path);
  noLeak(r, `GET ${path}`);
  assert.ok(refused(r), `GET ${path}: expected 403/404, got ${r.status} → ${r.location || ''}`);
  return r;
}
/** A POST with a valid CSRF token (from A's own page) to one of B's ids: refused, or at least no data and no change. */
async function postRefused(path, form) {
  const r = await a.submit('/app/patients', path, form);
  noLeak(r, `POST ${path}`);
  if (r.status === 302 && r.location) {
    // some forms answer a refusal with a flash message and a redirect back to the record — which must itself be refused
    const next = await a.get(r.location);
    noLeak(next, `GET ${r.location} after POST ${path}`);
    assert.ok(refused(next), `POST ${path} → ${r.location}: expected the record to be refused, got ${next.status}`);
    return r;
  }
  assert.ok(refused(r), `POST ${path}: expected 403/404, got ${r.status} → ${r.location || ''}`);
  return r;
}

test('sanity: A is signed in and opens its own patient', async () => {
  const r = await a.get(`/app/patients/${ids.aPatient}`);
  assert.equal(r.status, 200, r.location || r.text.slice(0, 200));
  noLeak(r, 'own patient page');
});

test('control: clinic B\'s own owner does see the marker (so the checks below can detect a leak)', async () => {
  const b = app.agent();
  await b.login(mail('b'));
  const r = await b.get(`/app/patients/${ids.patient}`);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(SECRET));
  const f = await b.get(`/app/patients/${ids.patient}/files/${ids.file}`);
  assert.equal(f.status, 200);
  assert.ok(f.body.includes(Buffer.from(SECRET)));
});

test('clinical record of clinic B: patient, appointment, visit, prescription — 404, nothing of B shown', async () => {
  await getRefused(`/app/patients/${ids.patient}`);
  await getRefused(`/app/patients/${ids.patient}/edit`);
  await getRefused(`/app/patients/${ids.patient}/summary`);
  await getRefused(`/app/patients/${ids.patient}/photo`);
  await getRefused(`/app/appointments/${ids.appt}`);
  await getRefused(`/app/appointments/${ids.appt}/peek`);
  await getRefused(`/app/visits/${ids.appt}`);
  await getRefused(`/app/visits/${ids.appt}/prescriptions/${ids.rx}`);
  await getRefused(`/app/patients/${ids.patient}/records`);
  await getRefused(`/app/orders/${ids.order}`);
  await getRefused(`/app/surgeries/${ids.surgery}`);
});

test('documents and files of clinic B: invoice, prescription PDF, patient file, legacy attachment, media, chat — refused', async () => {
  await getRefused(`/app/billing/${ids.invoice}`);
  const pdf = await a.get(`/app/patient-docs/${ids.appt}/prescription/${ids.rx}.pdf`);
  noLeak(pdf, 'prescription PDF');
  assert.ok(refused(pdf) || (pdf.status === 302 && !String(pdf.location).includes(String(ids.appt))), `prescription PDF: ${pdf.status} → ${pdf.location}`);
  assert.ok(!/application\/pdf/.test(pdf.type), 'no PDF is produced for clinic B\'s visit');
  await getRefused(`/app/patients/${ids.patient}/files/${ids.file}`);
  await getRefused(`/app/patients/${ids.aPatient}/files/${ids.file}`); // A's own patient + B's file id
  await getRefused(`/api/patients/${ids.patient}/attachments/${ids.attachment}/download`);
  await getRefused(`/app/media/${ids.media}`);
  const chat = await a.get(`/app/chat/${ids.chat}/messages`, { accept: 'application/json' });
  noLeak(chat, 'chat messages');
  assert.ok(refused(chat), `chat messages: ${chat.status}`);
  const ins = await a.get(`/app/insurance-claims/${ids.insurer}/export`);
  noLeak(ins, 'insurance claims export');
  assert.ok(refused(ins) || ins.status === 302, `insurance export: ${ins.status}`);
  if (ids.po) await getRefused(`/app/supplies/orders/${ids.po}`);
});

test('patient export (ZIP of the whole file) of clinic B\'s patient is refused', async () => {
  const r = await postRefused(`/app/patients/${ids.patient}/export`, {});
  assert.ok(!/zip/.test(r.type), 'no archive produced');
});

test('writes to clinic B\'s ids are refused and change nothing', async () => {
  await postRefused(`/app/patients/${ids.patient}/edit`, { full_name: 'Hijacked by A', phone: '0793333333' });
  await postRefused(`/app/appointments/${ids.appt}/status`, { status: 'cancelled' });
  await postRefused(`/app/appointments/${ids.appt}/note`, { notes: 'A was here' });
  await postRefused(`/app/visits/${ids.appt}/note`, { subjective: 'A was here' });
  await postRefused(`/app/billing/${ids.invoice}/void`, { reason: 'A voids B' });
  const cat = require('../src/modules/expenses/expense.service').SYSTEM_CATEGORIES || []; // eslint-disable-line global-require
  await postRefused(`/app/expenses/${ids.expense}`, { date: today, category: cat[0] || 'other', title: 'A edits B', amount: '1', payment_method: 'cash' });
  await postRefused(`/app/patients/${ids.patient}/files/${ids.file}/delete`, {});
  await postRefused(`/app/patients/${ids.patient}/delete`, {});
  const p = await knex('patients').where({ id: ids.patient }).first('full_name', 'phone');
  assert.equal(p.full_name, `Patient ${SECRET}`);
  assert.equal(p.phone, '0791111111');
  const ap = await knex('appointments').where({ id: ids.appt }).first('status', 'notes');
  assert.equal(ap.status, 'completed');
  assert.equal(ap.notes, `appt ${SECRET}`);
  assert.ok(await knex('invoices').where({ id: ids.invoice }).first('id'), 'B\'s invoice still there');
  assert.ok(await knex('patient_files').where({ id: ids.file }).first('id'), 'B\'s file still there');
  assert.equal((await knex('expenses').where({ id: ids.expense }).first('title')).title, `Exp ${SECRET}`);
  assert.equal((await knex('consultations').where({ id: ids.consult }).first('subjective')).subjective, `soap ${SECRET}`);
});

test('A\'s own lists, searches and exports never include clinic B\'s rows', async () => {
  const q = SECRET.slice(0, -2); // matches B's rows (LIKE) but an echo of the query is not the full marker
  for (const path of [
    `/app/patients?q=${q}`, '/app/patients/export', '/app/appointments/export?from=2000-01-01&to=2100-01-01',
    '/app/billing?from=2000-01-01&to=2100-01-01', '/app/billing/export?from=2000-01-01&to=2100-01-01', '/app/expenses/export?from=2000-01-01&to=2100-01-01',
    `/app/search?q=${q}`, `/app/appointments/patient-lookup?q=${q}`, '/app/reports', `/app/media/api?q=${q}`,
  ]) {
    const r = await a.get(path, { accept: path.includes('lookup') || path.includes('/api') ? 'application/json' : 'text/html' });
    noLeak(r, `GET ${path}`);
    assert.ok(r.status < 500, `GET ${path}: ${r.status}`);
  }
});

test('the session cannot be switched to clinic B (not a member)', async () => {
  const r = await a.submit('/app/patients', '/workspaces/switch', { business_id: String(B.businessId) });
  assert.equal(r.status, 403);
  assert.ok(refused(await a.get(`/app/patients/${ids.patient}`)), 'still clinic A');
  const own = await a.get(`/app/patients/${ids.aPatient}`);
  assert.equal(own.status, 200);
});

test('a session whose stored clinic is B (tampered row) still works in A only', async () => {
  // Write businessId = B straight into A's stored session, as if the session row had been altered.
  const rows = await knex('sessions').select('sid', 'sess');
  const mine = rows.map((r) => ({ sid: r.sid, s: typeof r.sess === 'string' ? JSON.parse(r.sess) : r.sess })).filter((r) => r.s.userId === A.userId);
  assert.ok(mine.length >= 1);
  for (const r of mine) await knex('sessions').where({ sid: r.sid }).update({ sess: JSON.stringify({ ...r.s, businessId: B.businessId }) }); // eslint-disable-line no-await-in-loop
  await getRefused(`/app/patients/${ids.patient}`);
  await getRefused(`/app/billing/${ids.invoice}`);
  const own = await a.get(`/app/patients/${ids.aPatient}`);
  assert.equal(own.status, 200, 'resolveBusiness fell back to a clinic A membership');
});
