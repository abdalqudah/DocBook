// Medical documents (sick leave, medical report, attendance certificate) against the test database: serial numbers
// under concurrency, doctor scope, revoke (reason, audit, no double revoke), privacy defaults, and the public
// verification page (valid / revoked / not found, masking, nothing clinical leaked, enumeration rate limit).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const { clinicNow } = require('../src/modules/clinic/scheduling');
const svc = require('../src/modules/certificates/certificates.service');
const verifyWeb = require('../src/modules/certificates/verify.web');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let ctx; let docA; let docB; let patientId; let visitA; let visitB; let server; let base; let today;

async function makeClinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), slug: `certs-${tag}` });
  businesses.forget(businessId);
  today = clinicNow('Asia/Amman').date;
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, locale: 'ar', today };
}

async function visit(doctorId, extra = {}) {
  const [id] = await knex('appointments').insert({
    business_id: ctx.businessId, doctor_id: doctorId, patient_id: patientId, patient_name: 'محمد عبد الله أحمد', patient_phone: '0791234567',
    appointment_date: today, appointment_time: '09:00', duration_minutes: 30, status: 'completed', ...extra,
  });
  return id;
}
const doctorCtx = (doctorId) => ({ ...ctx, permissions: new Set(['appointments.view', 'certificates.view', 'certificates.issue']), ownDoctorId: doctorId, doctorId });
const sick = (extra = {}) => ({ doc_type: 'sick_leave', language: 'ar', leave_start: today, leave_days: '3', diagnosis: 'Acute tonsillitis', ...extra });

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ctx = await makeClinic(`certs${tag}@t.test`, 'عيادة الاختبار');
  docA = await doctors.saveDoctor(ctx, null, { full_name: 'د. أحمد', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1', license_number: 'JMC-1' });
  docB = await doctors.saveDoctor(ctx, null, { full_name: 'د. باسم', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
  [patientId] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'محمد عبد الله أحمد', phone: '0791234567', national_id: '9876543210' });
  visitA = await visit(docA);
  visitB = await visit(docB);
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await knex.destroy(); });

test('helpers: masking, codes and serials', () => {
  assert.equal(svc.maskName('محمد عبد الله أحمد'), 'محمد ع*** ا*** أ***');
  assert.equal(svc.maskName('Lena'), 'L***');
  assert.equal(svc.maskName('  '), '—');
  const code = svc.newCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{16}$/);
  assert.notEqual(svc.newCode(), code);
  assert.equal(svc.normalizeCode(svc.formatCode(code).toLowerCase()), code);
  assert.equal(svc.normalizeCode('ABCD'), null);
  assert.equal(svc.normalizeCode('0000111122223333'), null); // 0 and 1 are not in the alphabet
  assert.equal(svc.serialOf('sick_leave', 2026, 123), 'SL-2026-000123');
  assert.equal(svc.normalizeSerial(' sl-2026-000123 '), 'SL-2026-000123');
  assert.equal(svc.addDays('2026-12-30', 3), '2027-01-02');
});

test('serials are sequential per clinic, type and year, with no gaps or duplicates under concurrency', async () => {
  const ids = await Promise.all(Array.from({ length: 12 }, () => svc.issue(ctx, visitA, sick())));
  const rows = await knex('certificates').whereIn('id', ids).select('serial', 'serial_number', 'verify_code');
  const numbers = rows.map((r) => r.serial_number).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(new Set(rows.map((r) => r.serial)).size, 12);
  assert.equal(new Set(rows.map((r) => r.verify_code)).size, 12);
  assert.ok(rows.every((r) => r.serial.startsWith(`SL-${today.slice(0, 4)}-`)));
  // Another type has its own sequence.
  const rep = await svc.get(ctx, await svc.issue(ctx, visitA, { doc_type: 'medical_report', language: 'en', findings: 'Fever', recommendations: 'Rest' }));
  assert.equal(rep.serial, `MR-${today.slice(0, 4)}-000001`);
});

test('sick leave: period, privacy defaults and validation', async () => {
  const doc = await svc.get(ctx, await svc.issue(ctx, visitA, sick()));
  assert.equal(doc.leave_end, svc.addDays(today, 2));
  assert.equal(doc.show_diagnosis, false);
  assert.equal(doc.diagnosis, null); // not stored unless the doctor chooses to print it
  assert.equal(doc.patient_national_id, null); // only when ticked
  assert.equal(doc.doctor_license, 'JMC-1');
  const withId = await svc.get(ctx, await svc.issue(ctx, visitA, sick({ include_national_id: '1', show_diagnosis: '1' })));
  assert.equal(withId.patient_national_id, '9876543210');
  assert.equal(withId.diagnosis, 'Acute tonsillitis');
  await assert.rejects(svc.issue(ctx, visitA, sick({ leave_days: '31' })), (e) => e.code === 'VALIDATION_FAILED' && !!e.details.leave_days);
  await assert.rejects(svc.issue(ctx, visitA, sick({ leave_start: svc.addDays(today, -1) })), (e) => e.code === 'VALIDATION_FAILED' && !!e.details.leave_start);
  await assert.rejects(svc.issue(ctx, visitA, sick({ companion_leave: '1' })), (e) => e.code === 'VALIDATION_FAILED' && !!e.details.companion_name);
  await assert.rejects(svc.issue(ctx, visitA, { doc_type: 'attendance', time_from: '10:00', time_to: '09:00' }), (e) => e.code === 'VALIDATION_FAILED');
  // Only visits that took place.
  const cancelled = await visit(docA, { status: 'cancelled' });
  await assert.rejects(svc.issue(ctx, cancelled, sick()), (e) => e.code === 'VISIT_NOT_ATTENDED');
  const future = await visit(docA, { appointment_date: svc.addDays(today, 3), status: 'confirmed' });
  await assert.rejects(svc.issue(ctx, future, sick()), (e) => e.code === 'VISIT_IN_FUTURE');
});

test('doctor scope: a doctor issues and sees only documents of their own visits', async () => {
  const b = doctorCtx(docB);
  await assert.rejects(svc.issue(b, visitA, sick()), (e) => e.code === 'NOT_FOUND');
  const own = await svc.issue(b, visitB, { doc_type: 'attendance', time_from: '09:00', time_to: '09:30' });
  const { rows } = await svc.list(b, {});
  assert.ok(rows.length >= 1 && rows.every((r) => r.doctor_id === docB));
  const aDoc = (await knex('certificates').where({ business_id: ctx.businessId, doctor_id: docA }).first('id')).id;
  await assert.rejects(svc.get(b, aDoc), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(svc.revoke(b, aDoc, { reason: 'wrong patient' }), (e) => e.code === 'NOT_FOUND');
  assert.equal((await svc.get(b, own)).doctor_id, docB);
  // Viewing is not issuing.
  const viewer = { ...ctx, permissions: new Set(['certificates.view']) };
  await assert.rejects(svc.issue(viewer, visitA, sick()), (e) => e.code === 'PERMISSION_DENIED');
  await assert.rejects(svc.revoke(viewer, own, { reason: 'wrong patient' }), (e) => e.code === 'PERMISSION_DENIED');
});

test('revoke: needs a reason, is audited, happens once; a correction links to the revoked document', async () => {
  const id = await svc.issue(ctx, visitA, sick());
  await assert.rejects(svc.revoke(ctx, id, { reason: '' }), (e) => e.code === 'VALIDATION_FAILED');
  await svc.revoke(ctx, id, { reason: 'Wrong number of days' });
  const doc = await svc.get(ctx, id);
  assert.ok(doc.revoked_at);
  assert.equal(doc.revoke_reason, 'Wrong number of days');
  await assert.rejects(svc.revoke(ctx, id, { reason: 'again please' }), (e) => e.code === 'ALREADY_REVOKED');
  const audits = await knex('audit_logs').where({ business_id: ctx.businessId, entity_type: 'certificate', entity_id: String(id) }).pluck('action');
  assert.deepEqual(audits.sort(), ['certificate.issued', 'certificate.revoked']);
  const fixed = await svc.get(ctx, await svc.issue(ctx, visitA, sick({ leave_days: '2', replaces_id: String(id) })));
  assert.equal(fixed.replaces_id, id);
  const live = await svc.issue(ctx, visitA, sick());
  await assert.rejects(svc.issue(ctx, visitA, sick({ replaces_id: String(live) })), (e) => e.code === 'VALIDATION_FAILED'); // only a revoked one can be replaced
});

test('public verification: valid, revoked, not found — masked name and nothing clinical', async () => {
  verifyWeb.resetLimits();
  const id = await svc.issue(ctx, visitA, sick({ include_national_id: '1', show_diagnosis: '1' }));
  const doc = await svc.get(ctx, id);
  let r = await fetch(`${base}/verify/${svc.formatCode(doc.verify_code)}`);
  let html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /verify-valid/);
  assert.match(html, /noindex/);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.ok(html.includes(doc.serial));
  assert.ok(html.includes('محمد ع*** ا*** أ***'));
  assert.ok(html.includes('د. أحمد'));
  for (const secret of ['9876543210', 'Acute tonsillitis', '0791234567', 'عبد الله']) assert.ok(!html.includes(secret), `leaked ${secret}`);
  // Manual lookup needs the matching serial AND code.
  r = await fetch(`${base}/verify?serial=${doc.serial.toLowerCase()}&code=${doc.verify_code.toLowerCase()}`);
  assert.equal(r.status, 200);
  r = await fetch(`${base}/verify?serial=SL-2000-000001&code=${doc.verify_code}`);
  assert.equal(r.status, 404);
  await svc.revoke(ctx, id, { reason: 'Issued in error' });
  r = await fetch(`${base}/verify/${doc.verify_code}`);
  html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /verify-revoked/);
  assert.ok(!html.includes('Issued in error')); // the reason stays internal
  r = await fetch(`${base}/verify/ZZZZZZZZZZZZZZZZ`);
  assert.equal(r.status, 404);
  assert.match(await r.text(), /verify-not_found/);
});

test('enumeration: repeated failed lookups are rate limited, even for a real code afterwards', async () => {
  verifyWeb.resetLimits();
  const doc = await svc.get(ctx, await svc.issue(ctx, visitA, sick()));
  const { FAIL_LIMIT } = verifyWeb.LIMITS;
  for (let i = 0; i < FAIL_LIMIT; i += 1) {
    const r = await fetch(`${base}/verify/${svc.newCode()}`); // eslint-disable-line no-await-in-loop
    assert.equal(r.status, 404);
  }
  const r = await fetch(`${base}/verify/${doc.verify_code}`);
  assert.equal(r.status, 429);
  assert.match(await r.text(), /verify-limited/);
  verifyWeb.resetLimits();
  assert.equal((await fetch(`${base}/verify/${doc.verify_code}`)).status, 200);
});

test('permissions: roles and labels', () => {
  const { SYSTEM_ROLES, normalise } = require('../src/modules/rbac/permissions'); // eslint-disable-line global-require
  const perms = (k) => normalise(SYSTEM_ROLES.find((r) => r.key === k).permissions);
  for (const k of ['owner', 'clinic_manager', 'doctor']) assert.ok(perms(k).includes('certificates.issue'), k);
  for (const k of ['nurse', 'receptionist']) { assert.ok(perms(k).includes('certificates.view'), k); assert.ok(!perms(k).includes('certificates.issue'), k); }
  assert.ok(!perms('accountant').includes('certificates.view'));
  for (const l of ['en', 'ar']) {
    const c = require(`../src/locales/${l}/common.json`); // eslint-disable-line global-require
    assert.ok(c.perms['certificates.issue'] && c.perms['certificates.view'] && c.nav.certificates);
  }
});
