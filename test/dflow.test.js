// Doctor journey — "Finish visit & send to reception" (src/modules/clinic/dflow.service.js), against docbook_test:
// amount validation and bill lines, note + prescription saved with the finish, idempotency (finishing twice never
// duplicates the prescription), refusals (cancelled, no-show, already paid), a doctor's own-schedule scope and
// services of another clinic, and "Start visit" (sent in + timer).
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
const dflow = require('../src/modules/clinic/dflow.service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let ctx; let docA; let docB; let patientId; let today; let serviceId; let otherServiceId;

async function makeClinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date() });
  businesses.forget(businessId);
  today = clinicNow('Asia/Amman').date;
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, locale: 'ar', today };
}

async function visit(doctorId, extra = {}) {
  const [id] = await knex('appointments').insert({
    business_id: ctx.businessId, doctor_id: doctorId, patient_id: patientId, patient_name: 'سارة محمود', patient_phone: '0791112223',
    appointment_date: today, appointment_time: '10:00', duration_minutes: 20, status: 'confirmed', checked_in: true, with_doctor: true,
    service_id: serviceId, amount_due: 15, ...extra,
  });
  return id;
}
const doctorCtx = (doctorId) => ({ ...ctx, permissions: new Set(['clinical.view', 'clinical.edit', 'prescriptions.create', 'appointments.view']), ownDoctorId: doctorId, doctorId });
const FULL = { note: true, rx: true };
const noteAndRx = (extra = {}) => ({
  subjective: 'ألم في الحلق', objective: 'احمرار', diagnosis: 'التهاب البلعوم', plan_text: 'سوائل وراحة',
  rx: { 0: { medicationName: 'Amoxicillin', dosage: '500 mg', frequency: '3× daily', duration: '7 days' }, 1: { medicationName: 'Paracetamol', dosage: '500 mg', instructions: 'After meals' }, 2: { medicationName: '' } },
  lines: { 0: { service_id: String(serviceId), unit_price: '25' } },
  ...extra,
});
const items = (r) => (typeof r.items === 'string' ? JSON.parse(r.items) : r.items);
const linesOf = (a) => (typeof a.doctor_lines === 'string' ? JSON.parse(a.doctor_lines) : a.doctor_lines);

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ctx = await makeClinic(`dflow${tag}@t.test`, 'عيادة المسار');
  docA = await doctors.saveDoctor(ctx, null, { full_name: 'د. أحمد', slot_duration_minutes: '20', consultation_fee: '20', base_salary: '0', is_active: '1' });
  docB = await doctors.saveDoctor(ctx, null, { full_name: 'د. باسم', slot_duration_minutes: '20', consultation_fee: '30', base_salary: '0', is_active: '1' });
  [serviceId] = await knex('services').insert({ business_id: ctx.businessId, name: 'كشفية', name_en: 'Consultation', duration_minutes: 20, price: 15, is_active: true });
  const other = await makeClinic(`dflow-other${tag}@t.test`, 'عيادة أخرى');
  [otherServiceId] = await knex('services').insert({ business_id: other.businessId, name: 'خدمة أخرى', duration_minutes: 20, price: 99, is_active: true });
  [patientId] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'سارة محمود', phone: '0791112223' });
});
test.after(async () => { await knex.destroy(); });

test('bill lines: validation, blank rows, consultation line and rounding', () => {
  const r = dflow.cleanLines({ 0: { unit_price: '25' }, 1: { service_id: '', unit_price: '' }, 2: { name: 'تنظيف', unit_price: '7.1234' } }, 'JOD');
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].consultation, true);
  assert.equal(r.lines[1].unit_price, 7.123); // JOD has three decimals
  assert.equal(r.total, 32.123);
  assert.equal(dflow.cleanLines({ 0: { unit_price: '٢٥' } }, 'JOD').total, 25); // Arabic-Indic digits
  assert.equal(dflow.cleanLines({ 0: { unit_price: '0' } }, 'JOD').total, 0); // a free visit is allowed
  for (const bad of [{ 0: { unit_price: '-1' } }, { 0: { unit_price: 'abc' } }, { 0: { unit_price: '5000000' } }, { 0: { name: 'x' } }, {}, { 0: { unit_price: '5', qty: '0' } }]) {
    assert.throws(() => dflow.cleanLines(bad, 'JOD'), (e) => e.code === 'VALIDATION_FAILED', JSON.stringify(bad));
  }
  const many = Object.fromEntries(Array.from({ length: dflow.MAX_LINES + 1 }, (_, i) => [i, { unit_price: '1' }]));
  assert.throws(() => dflow.cleanLines(many, 'JOD'), (e) => e.code === 'VALIDATION_FAILED');
  assert.deepEqual(dflow.cleanRx({ 0: { medicationName: ' ' }, 1: { medicationName: 'X', dosage: '' } }), [{ medicationName: 'X' }]);
});

test('default bill: doctor lines, else the booked service, else the consultation fee', () => {
  assert.equal(dflow.defaultLines({ service_id: 3, service_name: 'S', service_price: '12.5', amount_due: 9 })[0].unit_price, 12.5);
  assert.equal(dflow.defaultLines({ service_id: null, amount_due: 0, consultation_fee: '20' })[0].unit_price, 20);
  assert.equal(dflow.defaultLines({ doctor_lines: JSON.stringify([{ name: null, qty: 1, unit_price: 25, consultation: true }]) })[0].unit_price, 25);
});

test('finish: note + prescription + amount in one step; the visit is completed and sent to reception', async () => {
  const id = await visit(docA);
  await knex('consultation_timers').insert({ business_id: ctx.businessId, appointment_id: id, doctor_id: docA, started_at: new Date(Date.now() - 600000), started_by: ctx.userId });
  const r = await dflow.finish(doctorCtx(docA), id, noteAndRx(), FULL);
  assert.equal(r.total, 25);
  assert.ok(r.rxId);
  const a = await knex('appointments').where({ id }).first();
  assert.equal(a.status, 'completed');
  assert.equal(Boolean(a.with_doctor), false);
  assert.equal(Number(a.amount_due), 25);
  assert.equal(a.payment_status, 'unpaid');
  assert.ok(a.doctor_finished_at);
  assert.deepEqual(linesOf(a).map((l) => [l.service_id, l.name, l.unit_price]), [[serviceId, 'كشفية', 25]]);
  const c = await knex('consultations').where({ appointment_id: id }).first();
  assert.equal(c.diagnosis, 'التهاب البلعوم');
  assert.equal(c.subjective, 'ألم في الحلق');
  const rxs = await knex('prescriptions').where({ appointment_id: id });
  assert.equal(rxs.length, 1);
  assert.deepEqual(items(rxs[0]).map((i) => i.medicationName), ['Amoxicillin', 'Paracetamol']);
  const t = await knex('consultation_timers').where({ appointment_id: id }).first();
  assert.ok(t.ended_at, 'the consultation timer stops');
  const log = await knex('audit_logs').where({ business_id: ctx.businessId, entity_type: 'appointment', entity_id: id, action: 'visit.finished' }).first();
  assert.ok(log);
});

test('finishing twice (double click, second tab) never duplicates; the amount can be corrected before payment', async () => {
  const id = await visit(docA);
  const dc = doctorCtx(docA);
  const [r1, r2] = await Promise.all([dflow.finish(dc, id, noteAndRx(), FULL), dflow.finish(dc, id, noteAndRx(), FULL)]);
  assert.equal(r1.rxId, r2.rxId);
  assert.equal(await knex('prescriptions').where({ appointment_id: id }).count({ n: '*' }).then(([x]) => Number(x.n)), 1);
  // Correct the amount, add a service without a price (takes the service price) and edit the prescription.
  const r3 = await dflow.finish(dc, id, noteAndRx({
    rx_id: String(r1.rxId), rx: { 0: { medicationName: 'Azithromycin', dosage: '250 mg' } },
    lines: { 0: { unit_price: '20' }, 1: { service_id: String(serviceId), unit_price: '' } },
  }), FULL);
  assert.equal(r3.again, true);
  assert.equal(r3.total, 35);
  assert.equal(r3.rxId, r1.rxId);
  const rxs = await knex('prescriptions').where({ appointment_id: id });
  assert.equal(rxs.length, 1);
  assert.deepEqual(items(rxs[0]).map((i) => i.medicationName), ['Azithromycin']);
  const a = await knex('appointments').where({ id }).first();
  assert.equal(Number(a.amount_due), 35);
  assert.equal(linesOf(a).length, 2);
  assert.equal(linesOf(a)[0].consultation, true);
  // A prescription id of another visit is refused.
  const other = await visit(docA);
  await assert.rejects(dflow.finish(dc, other, noteAndRx({ rx_id: String(r1.rxId) }), FULL), (e) => e.code === 'VALIDATION_FAILED');
});

test('cannot finish a cancelled, no-show, already paid or invoiced visit', async () => {
  const dc = doctorCtx(docA);
  const cancelled = await visit(docA, { status: 'cancelled' });
  await assert.rejects(dflow.finish(dc, cancelled, noteAndRx(), FULL), (e) => e.code === 'APPOINTMENT_CANCELLED');
  const noShow = await visit(docA, { status: 'no_show' });
  await assert.rejects(dflow.finish(dc, noShow, noteAndRx(), FULL), (e) => e.code === 'VISIT_NO_SHOW');
  const paid = await visit(docA, { status: 'completed', payment_status: 'paid', amount_due: 15 });
  await assert.rejects(dflow.finish(dc, paid, noteAndRx(), FULL), (e) => e.code === 'ALREADY_PAID');
  assert.equal(Number((await knex('appointments').where({ id: paid }).first()).amount_due), 15, 'a paid amount is never changed');
  assert.equal(await knex('prescriptions').whereIn('appointment_id', [cancelled, noShow, paid]).count({ n: '*' }).then(([x]) => Number(x.n)), 0, 'nothing written on a refused finish');
  const invoiced = await visit(docA);
  await knex('invoices').insert({ business_id: ctx.businessId, appointment_id: invoiced, invoice_number: `T-${tag}`, patient_name: 'x', amount: 15, payment_method: 'cash' }).catch(() => null);
  if (await knex('invoices').where({ appointment_id: invoiced }).first()) {
    await assert.rejects(dflow.finish(dc, invoiced, noteAndRx(), FULL), (e) => e.code === 'APPOINTMENT_INVOICED');
  }
});

test('scope and validation: own schedule only, services of this clinic only, bad amounts write nothing', async () => {
  const id = await visit(docA);
  await assert.rejects(dflow.finish(doctorCtx(docB), id, noteAndRx(), FULL), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(dflow.finish(doctorCtx(docA), id, noteAndRx({ lines: { 0: { unit_price: '10' }, 1: { service_id: String(otherServiceId), unit_price: '5' } } }), FULL), (e) => e.code === 'VALIDATION_FAILED');
  await assert.rejects(dflow.finish(doctorCtx(docA), id, noteAndRx({ lines: { 0: { unit_price: '-5' } } }), FULL), (e) => e.code === 'VALIDATION_FAILED');
  await assert.rejects(dflow.finish(doctorCtx(docA), id, noteAndRx({ rx: { 0: { medicationName: 'X'.repeat(300) } } }), FULL), (e) => e.code === 'VALIDATION_FAILED');
  const a = await knex('appointments').where({ id }).first();
  assert.equal(a.status, 'confirmed');
  assert.equal(a.doctor_lines, null);
  assert.equal(await knex('consultations').where({ appointment_id: id }).count({ n: '*' }).then(([x]) => Number(x.n)), 0);
  // Reception / manager without clinical rights: only the bill is written, the note and prescription are ignored.
  const r = await dflow.finish({ ...ctx, permissions: new Set(['appointments.manage']) }, id, noteAndRx(), { note: false, rx: false });
  assert.equal(r.rxId, null);
  assert.equal(await knex('consultations').where({ appointment_id: id }).count({ n: '*' }).then(([x]) => Number(x.n)), 0);
  assert.equal(Number((await knex('appointments').where({ id }).first()).amount_due), 25);
});

test('save without finishing and "Start visit"', async () => {
  const id = await visit(docA, { checked_in: false, with_doctor: false });
  const dc = doctorCtx(docA);
  const s1 = await dflow.saveDraft(dc, id, noteAndRx(), FULL);
  const s2 = await dflow.saveDraft(dc, id, noteAndRx({ rx_id: String(s1.rxId) }), FULL);
  assert.equal(s1.rxId, s2.rxId);
  assert.equal((await knex('appointments').where({ id }).first()).status, 'confirmed', 'saving does not finish');
  const st = await dflow.start(dc, id);
  assert.equal(st.started, true);
  const a = await knex('appointments').where({ id }).first();
  assert.equal(Boolean(a.checked_in) && Boolean(a.with_doctor), true);
  assert.ok(await knex('consultation_timers').where({ appointment_id: id }).whereNull('ended_at').first());
  const done = await visit(docA, { status: 'completed' });
  assert.equal((await dflow.start(dc, done)).started, false, 'a finished visit only opens');
});
