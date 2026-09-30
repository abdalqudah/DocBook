// Clinical extras against the test database: ICD-10 search ranking (clinic's most-used codes first, custom codes,
// Arabic normalisation), coded diagnoses of a visit, the consultation timer (idempotent start/stop, pause maths),
// and the medical-record privacy rule (treating doctor yes, other doctor no, owner yes, nurse vitals only,
// break-glass yes + logged, audited and notified).
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
const icd = require('../src/modules/clinicalplus/icd.service');
const timer = require('../src/modules/clinicalplus/timer.service');
const privacy = require('../src/modules/clinicalplus/privacy.service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let ctx; let docA; let docB; let patientId; let otherPatient; let visitA; let today;

async function makeClinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), slug: `cplus-${tag}-${email.slice(0, 6)}` });
  businesses.forget(businessId);
  today = clinicNow('Asia/Amman').date;
  return { businessId, userId, userName: 'Owner', roleKey: 'owner', doctorId: null, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, locale: 'ar', today };
}

async function visit(doctorId, pid = patientId, extra = {}) {
  const [id] = await knex('appointments').insert({
    business_id: ctx.businessId, doctor_id: doctorId, patient_id: pid, patient_name: 'سارة خالد', patient_phone: '0790000000',
    appointment_date: today, appointment_time: '10:00', duration_minutes: 15, status: 'confirmed', ...extra,
  });
  return id;
}
async function staffUser(name) {
  return knex.transaction((trx) => auth.createUser(trx, { name, email: `${name.toLowerCase()}${tag}@t.test`, password: 'Passw0rd!x' }));
}
const DOCTOR_PERMS = ['dashboard.view', 'appointments.view', 'patients.view', 'patients.edit', 'clinical.view', 'clinical.edit', 'vitals.edit', 'prescriptions.create'];
const doctorCtx = (userId, doctorId) => ({ ...ctx, userId, userName: `Dr ${doctorId}`, roleKey: 'doctor', doctorId, ownDoctorId: doctorId, permissions: new Set(DOCTOR_PERMS) });

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ctx = await makeClinic(`cplus${tag}@t.test`, 'عيادة الاختبار');
  docA = await doctors.saveDoctor(ctx, null, { full_name: 'د. أحمد', slot_duration_minutes: '15', consultation_fee: '20', base_salary: '0', is_active: '1' });
  docB = await doctors.saveDoctor(ctx, null, { full_name: 'د. باسم', slot_duration_minutes: '15', consultation_fee: '20', base_salary: '0', is_active: '1' });
  [patientId] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'سارة خالد', phone: '0790000000' });
  [otherPatient] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'ليث سامر', phone: '0790000001' });
  visitA = await visit(docA);
});
test.after(async () => { await knex.destroy(); });

// ---------------------------------------------------------------- ICD-10
test('ICD data: real WHO codes, unique, bilingual', () => {
  const codes = icd.INDEX.map((e) => e.code);
  assert.ok(codes.length >= 600, `expected a curated list of 600+ codes, got ${codes.length}`);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(icd.INDEX.every((e) => /^[A-Z]\d{2}(\.\d)?$/.test(e.code) && e.en && /[؀-ۿ]/.test(e.ar)));
  for (const c of ['J06.9', 'I10', 'E11.9', 'K02.9', 'K04.0', 'Z00.0', 'Z34.9', 'O24.4', 'L70.0', 'H52.1', 'M54.5', 'F41.1']) assert.ok(icd.BY_CODE.has(c), c);
  assert.equal(icd.normalizeCode(' j069 '), 'J06.9');
  assert.equal(icd.normalizeCode('i10'), 'I10');
  assert.deepEqual(icd.parseCodes('j06.9, R50.9،J06.9'), ['J06.9', 'R50.9']);
});

test('ICD search: code prefix, Arabic and English words, Arabic spelling variants', async () => {
  const codes = (rows) => rows.map((r) => r.code);
  assert.equal(codes(await icd.search(ctx.businessId, 'J06.9'))[0], 'J06.9');
  assert.ok(codes(await icd.search(ctx.businessId, 'k02')).every((c) => c.startsWith('K02')));
  assert.ok(codes(await icd.search(ctx.businessId, 'tonsillitis')).includes('J03.9'));
  assert.ok(codes(await icd.search(ctx.businessId, 'التهاب اللوزتين')).includes('J03.9'));
  const a = codes(await icd.search(ctx.businessId, 'اكزيما'));
  const b = codes(await icd.search(ctx.businessId, 'أكزيما'));
  assert.ok(a.includes('L20.9')); assert.deepEqual(a, b); // hamza folded
  assert.ok(codes(await icd.search(ctx.businessId, 'سُكَّري')).includes('E11.9')); // diacritics ignored
  assert.deepEqual(await icd.search(ctx.businessId, 'j'), []); // min 2 characters
  assert.ok((await icd.search(ctx.businessId, 'itis', { limit: 20 })).length <= 20);
});

test("ICD search: the clinic's most-used codes come first; custom codes are searchable", async () => {
  const before = (await icd.search(ctx.businessId, 'otitis')).map((r) => r.code);
  assert.ok(before.includes('H66.9') && before[0] !== 'H66.9');
  // This clinic codes "otitis media, unspecified" a lot.
  const v = [];
  for (let i = 0; i < 3; i += 1) v.push(await visit(docA)); // eslint-disable-line no-await-in-loop
  for (const id of v) await icd.saveDiagnoses(ctx, { id, patient_id: patientId, doctor_id: docA }, [await icd.lookup(ctx.businessId, 'H66.9')], 'H66.9'); // eslint-disable-line no-await-in-loop
  const after = await icd.search(ctx.businessId, 'otitis');
  assert.equal(after[0].code, 'H66.9');
  assert.equal(after[0].uses, 3);
  // Another clinic is not affected by this clinic's usage.
  const other = await makeClinic(`cplus2${tag}@t.test`, 'عيادة أخرى');
  assert.equal((await icd.search(other.businessId, 'otitis'))[0].uses, 0);
  // Custom codes.
  await icd.saveCustom(ctx, null, { code: 'dent-01', title_ar: 'تبييض الأسنان', title_en: 'Teeth whitening', is_active: '1' });
  const custom = await icd.search(ctx.businessId, 'تبييض');
  assert.equal(custom[0].code, 'DENT-01');
  assert.equal(custom[0].custom, true);
  assert.ok(await icd.lookup(ctx.businessId, 'dent-01'));
  assert.equal(await icd.lookup(other.businessId, 'DENT-01'), null);
  await assert.rejects(icd.saveCustom(ctx, null, { code: 'J06.9', title_ar: 'x', is_active: '1' }), (e) => e.code === 'ICD_CODE_EXISTS');
  await assert.rejects(icd.saveCustom(ctx, null, { code: 'DENT-01', title_ar: 'x', is_active: '1' }), (e) => e.code === 'ICD_CODE_TAKEN');
});

test('coded diagnoses of a visit: validation, primary, replace, snapshot', async () => {
  const appt = { id: visitA, patient_id: patientId, doctor_id: docA };
  await assert.rejects(icd.resolveCodes(ctx.businessId, 'J06.9, ZZ99'), (e) => e.code === 'VALIDATION_FAILED' && e.details.icd_codes === 'ZZ99');
  await icd.saveDiagnoses(ctx, appt, await icd.resolveCodes(ctx.businessId, 'j03.9, r50.9'), 'R50.9');
  let rows = await icd.diagnosesFor(ctx.businessId, visitA);
  assert.deepEqual(rows.map((r) => [r.code, Boolean(r.is_primary)]), [['R50.9', true], ['J03.9', false]]);
  assert.equal(rows[1].title_ar, 'التهاب اللوزتين الحاد، غير محدد');
  await icd.saveDiagnoses(ctx, appt, await icd.resolveCodes(ctx.businessId, 'J03.9'), '');
  rows = await icd.diagnosesFor(ctx.businessId, visitA);
  assert.deepEqual(rows.map((r) => [r.code, Boolean(r.is_primary)]), [['J03.9', true]]);
  const audits = await knex('audit_logs').where({ business_id: ctx.businessId, action: 'consultation.diagnoses', entity_id: String(visitA) }).count({ n: '*' });
  assert.equal(Number(audits[0].n), 2);
});

// ---------------------------------------------------------------- consultation timer
test('timer maths: duration excludes pauses, including a running pause', () => {
  const t0 = new Date('2026-01-01T10:00:00Z');
  const at = (min) => new Date(t0.getTime() + min * 60000);
  assert.equal(timer.durationSeconds(null), 0);
  assert.equal(timer.durationSeconds({ started_at: t0, paused_seconds: 0 }, at(12)), 720);
  assert.equal(timer.durationSeconds({ started_at: t0, paused_seconds: 120, ended_at: at(20) }, at(99)), 1080);
  assert.equal(timer.durationSeconds({ started_at: t0, paused_seconds: 60, paused_at: at(10) }, at(15)), 540); // 10 min − 1 min paused before
  assert.equal(timer.median([5, 1, 3]), 3);
  assert.equal(timer.median([10, 20]), 15);
  assert.equal(timer.suggestSlot(16.5), 20);
  assert.equal(timer.suggestSlot(15), 15);
  assert.equal(timer.suggestSlot(2), 5);
});

test('timer: start and stop are idempotent; pause/resume adds paused time; audited', async () => {
  const id = await visit(docA);
  const appt = { id, doctor_id: docA };
  const t0 = new Date(Math.floor(Date.now() / 1000) * 1000 - 3600 * 1000); // whole seconds (TIMESTAMP precision)
  const at = (min) => new Date(t0.getTime() + min * 60000);
  const first = await timer.start(ctx, appt, t0);
  const again = await timer.start(ctx, appt, at(5));
  assert.equal(new Date(again.started_at).getTime(), t0.getTime()); // start time never moves
  assert.equal(timer.stateOf(again), 'running');
  assert.equal(first.id, again.id);
  await timer.pause(ctx, appt, at(10));
  await timer.pause(ctx, appt, at(11)); // second pause is ignored
  assert.equal(timer.stateOf(await timer.get(ctx.businessId, id)), 'paused');
  await timer.resume(ctx, appt, at(13));
  const stopped = await timer.stop(ctx, appt, at(20));
  assert.equal(stopped.paused_seconds, 180);
  assert.equal(timer.durationSeconds(stopped), 17 * 60);
  const stoppedAgain = await timer.stop(ctx, appt, at(40));
  assert.equal(new Date(stoppedAgain.ended_at).getTime(), at(20).getTime()); // end time never moves
  assert.equal(timer.durationSeconds(stoppedAgain, at(90)), 17 * 60);
  assert.equal(timer.stateOf(await timer.start(ctx, appt, at(50))), 'done'); // a finished consultation stays finished
  const actions = await knex('audit_logs').where({ business_id: ctx.businessId, entity_type: 'appointment', entity_id: String(id) }).pluck('action');
  assert.deepEqual(actions.sort(), ['consultation.timer_paused', 'consultation.timer_resumed', 'consultation.timer_started', 'consultation.timer_stopped']);
  // Stopping while paused closes the pause first; stopping with no timer is a no-op.
  const id2 = await visit(docA);
  await timer.start(ctx, { id: id2 }, t0);
  await timer.pause(ctx, { id: id2 }, at(4));
  const s2 = await timer.stop(ctx, { id: id2 }, at(10));
  assert.equal(timer.durationSeconds(s2), 4 * 60);
  assert.equal(await timer.stop(ctx, { id: await visit(docA) }), undefined);
  // Concurrent starts create one row.
  const id3 = await visit(docA);
  await Promise.all([timer.start(ctx, { id: id3 }), timer.start(ctx, { id: id3 }), timer.start(ctx, { id: id3 })]);
  assert.equal(Number((await knex('consultation_timers').where({ appointment_id: id3 }).count({ n: '*' }))[0].n), 1);
});

// ---------------------------------------------------------------- privacy
test('privacy rule: treating doctor yes, other doctor no, owner yes, nurse vitals only', async () => {
  const uA = await staffUser('DoctorA'); const uB = await staffUser('DoctorB');
  const a = doctorCtx(uA, docA); const b = doctorCtx(uB, docB);
  const nurse = { ...ctx, userId: await staffUser('Nurse'), roleKey: 'nurse', permissions: new Set(['patients.view', 'clinical.view', 'vitals.edit']) };
  const receptionist = { ...ctx, userId: await staffUser('Reception'), roleKey: 'receptionist', permissions: new Set(['patients.view', 'appointments.view']) };
  const appt = await knex('appointments').where({ id: visitA }).first();

  // Setting off (default): unchanged behaviour.
  assert.equal(await privacy.isOn(ctx.businessId), false);
  assert.equal((await privacy.access(b, { patientId })).clinical, true);
  assert.equal((await privacy.access(nurse, { patientId })).clinical, true);

  await knex('businesses').where({ id: ctx.businessId }).update({ clinical_privacy: true });
  const accA = await privacy.access(a, { patientId });
  assert.deepEqual([accA.clinical, accA.reason], [true, 'treating']);
  assert.equal((await privacy.access(a, { appointment: appt })).clinical, true);
  const accB = await privacy.access(b, { patientId });
  assert.deepEqual([accB.clinical, accB.vitals, accB.reason, accB.canBreakGlass], [false, false, 'restricted', true]);
  assert.equal((await privacy.access(b, { appointment: appt })).clinical, false);
  const own = await privacy.access(ctx, { patientId });
  assert.deepEqual([own.clinical, own.reason], [true, 'manager']);
  const manager = await privacy.access({ ...ctx, userId: uB, roleKey: 'clinic_manager', permissions: new Set(['clinical.view']) }, { patientId });
  assert.equal(manager.clinical, true);
  const n = await privacy.access(nurse, { patientId });
  assert.deepEqual([n.clinical, n.vitals, n.canBreakGlass], [false, true, false]);
  assert.equal((await privacy.access(receptionist, { patientId })).reason, 'no_permission');
  // A booking (not only a completed visit) makes a doctor "treating"; a cancelled one does not.
  await visit(docB, otherPatient, { status: 'cancelled' });
  assert.equal((await privacy.access(b, { patientId: otherPatient })).clinical, false);
  await visit(docB, otherPatient, { status: 'pending' });
  assert.equal((await privacy.access(b, { patientId: otherPatient })).clinical, true);
  // Doctor A has no booking with the other patient.
  assert.equal((await privacy.access(a, { patientId: otherPatient })).clinical, false);
});

test('privacy: break-glass opens the record for 24 h, is logged, audited and notified to the owner', async () => {
  await knex('businesses').where({ id: ctx.businessId }).update({ clinical_privacy: true });
  const uB = await staffUser('DoctorB2');
  const b = doctorCtx(uB, docB);
  const patient = await knex('patients').where({ id: patientId }).first('id', 'full_name');
  assert.equal((await privacy.access(b, { patientId })).clinical, false);
  await assert.rejects(privacy.breakGlass(b, patient, { reason: 'short' }), (e) => e.code === 'VALIDATION_FAILED');
  const nurse = { ...ctx, userId: await staffUser('Nurse2'), roleKey: 'nurse', permissions: new Set(['clinical.view', 'vitals.edit']) };
  await assert.rejects(privacy.breakGlass(nurse, patient, { reason: 'I need to see the notes please' }), (e) => e.code === 'EMERGENCY_NOT_ALLOWED');

  const now = new Date();
  const grant = await privacy.breakGlass(b, patient, { reason: 'Patient arrived with chest pain, Dr A is away' }, now);
  assert.ok(grant.id);
  const acc = await privacy.access(b, { patientId });
  assert.deepEqual([acc.clinical, acc.reason], [true, 'emergency']);
  assert.ok(Math.abs(new Date(acc.grant.expires_at).getTime() - (now.getTime() + 24 * 3600 * 1000)) < 2000);
  // Logged, audited, owner notified.
  const logged = await knex('record_access_log').where({ business_id: ctx.businessId, user_id: uB, patient_id: patientId, what: 'break_glass', access: 'emergency' }).first();
  assert.ok(logged);
  const audited = await knex('audit_logs').where({ business_id: ctx.businessId, user_id: uB, action: 'record.emergency_access', entity_id: String(patientId) }).first();
  assert.ok(audited);
  const note = await knex('notifications').where({ business_id: ctx.businessId, user_id: ctx.userId, type: 'record.emergency' }).first();
  assert.ok(note && note.title.includes(patient.full_name) && note.link.includes(`patient=${patientId}`));
  // Only for this patient, and only for 24 hours.
  assert.equal((await privacy.access(b, { patientId: otherPatient })).reason === 'emergency', false);
  await knex('record_access_grants').where({ id: grant.id }).update({ expires_at: new Date(Date.now() - 1000) });
  assert.equal((await privacy.access(b, { patientId })).clinical, false);
});

test('privacy: every view is logged with its access level; the log is filterable per clinic', async () => {
  const uB = await staffUser('DoctorB3');
  const b = doctorCtx(uB, docB);
  await knex('businesses').where({ id: ctx.businessId }).update({ clinical_privacy: true });
  const acc = await privacy.access(b, { patientId });
  await privacy.log(b, { patientId, what: 'patient', access: privacy.levelOf(acc) });
  await privacy.log(ctx, { patientId, appointmentId: visitA, what: 'visit', access: privacy.levelOf(await privacy.access(ctx, { patientId })) });
  const rows = await privacy.logQuery(ctx, { patient: String(patientId) }).select('l.user_id', 'l.what', 'l.access');
  assert.ok(rows.some((r) => r.user_id === uB && r.what === 'patient' && r.access === 'limited'));
  assert.ok(rows.some((r) => r.user_id === ctx.userId && r.what === 'visit' && r.access === 'full'));
  const other = await makeClinic(`cplus3${tag}@t.test`, 'عيادة ثالثة');
  assert.equal((await privacy.logQuery(other, { patient: String(patientId) }).select('l.id')).length, 0);
});
