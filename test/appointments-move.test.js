// Integration test of the calendar "drag to move" (appointments.move) against a real database (docbook_test):
// the new slot is re-validated with the slot lock, service/length are kept, paid and cancelled visits
// cannot be moved, a doctor login cannot move to another doctor, and every move is audited.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const appts = require('../src/modules/clinic/appointments.service');
const scheduling = require('../src/modules/clinic/scheduling');

let ctx; let otherCtx; let doctorId; let doctor2Id; let serviceId; let date;

async function clinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null };
}

/** Next Sunday at least two days ahead in the clinic's time zone (the default schedule works Sunday 09–17). */
function nextSunday() {
  const today = scheduling.clinicNow('Asia/Amman').date;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const booking = (time, extra = {}) => ({ doctor_id: doctorId, service_id: serviceId, patient_name: 'Lina', patient_phone: '0790000001', appointment_date: date, appointment_time: time, ...extra });
const row = (id) => knex('appointments').where({ id }).first();

test.before(async () => {
  await knex.migrate.rollback(undefined, true);
  await knex.migrate.latest();
  ctx = await clinic('owner@move-a.test', 'Clinic A');
  otherCtx = await clinic('owner@move-b.test', 'Clinic B');
  doctorId = await doctors.saveDoctor(ctx, null, { full_name: 'Dr. Sami', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1', show_consultation_fee: '1' });
  doctor2Id = await doctors.saveDoctor(ctx, null, { full_name: 'Dr. Layla', slot_duration_minutes: '20', consultation_fee: '35', base_salary: '0', is_active: '1', show_consultation_fee: '1' });
  serviceId = await doctors.saveService(ctx, null, { name: 'Check-up', price: '100', duration_minutes: '30', is_active: '1', show_price: '1' });
  date = nextSunday();
});

test.after(() => knex.destroy());

test('moves an appointment to another time and doctor, keeping its service', async () => {
  const id = await appts.book(ctx, booking('09:00'));
  await appts.move(ctx, id, { doctor_id: doctor2Id, appointment_date: date, appointment_time: '11:40' });
  const a = await row(id);
  assert.equal(a.doctor_id, doctor2Id);
  assert.equal(a.appointment_time, '11:40');
  assert.equal(a.service_id, serviceId);
  const log = await knex('audit_logs').where({ business_id: ctx.businessId, action: 'appointment.moved', entity_id: id }).first();
  assert.ok(log, 'the move is audited');
});

test('a move onto a taken or non-working slot is refused and nothing changes', async () => {
  const a = await appts.book(ctx, booking('10:00', { patient_phone: '0790000002' }));
  const b = await appts.book(ctx, booking('10:30', { patient_phone: '0790000003' }));
  await assert.rejects(appts.move(ctx, b, { doctor_id: doctorId, appointment_date: date, appointment_time: '10:00' }), { code: 'SLOT_TAKEN' });
  await assert.rejects(appts.move(ctx, b, { doctor_id: doctorId, appointment_date: date, appointment_time: '13:00' }), { code: 'SLOT_TAKEN' }, 'the break is not bookable');
  await assert.rejects(appts.move(ctx, b, { doctor_id: doctorId, appointment_date: date, appointment_time: '18:00' }), { code: 'SLOT_TAKEN' }, 'outside the shift');
  assert.equal((await row(b)).appointment_time, '10:30');
  assert.equal((await row(a)).appointment_time, '10:00');
  // Moving within its own slot range (overlapping only itself) is fine.
  await appts.move(ctx, b, { doctor_id: doctorId, appointment_date: date, appointment_time: '11:00' });
  assert.equal((await row(b)).appointment_time, '11:00');
});

test('a booking without a service keeps its length when moved to a doctor with a different slot', async () => {
  const id = await appts.book(ctx, booking('14:00', { service_id: '', patient_phone: '0790000004' }));
  assert.equal((await row(id)).duration_minutes, null);
  await appts.move(ctx, id, { doctor_id: doctor2Id, appointment_date: date, appointment_time: '15:00' });
  const a = await row(id);
  assert.equal(a.duration_minutes, 30, 'Dr. Sami\'s 30-minute slot is frozen on the booking');
  assert.equal(Number(a.amount_due), 35, 'the fee follows the new doctor');
});

test('time blocks can be moved too', async () => {
  const bid = await appts.block(ctx, { doctor_id: doctorId, appointment_date: date, appointment_time: '15:00', duration_minutes: '60', label: 'Meeting' });
  await appts.move(ctx, bid, { doctor_id: doctorId, appointment_date: date, appointment_time: '16:00' });
  const b = await row(bid);
  assert.equal(b.appointment_time, '16:00');
  assert.equal(b.duration_minutes, 60);
  assert.equal(b.appointment_type, 'blocked');
});

test('paid and cancelled appointments cannot be moved', async () => {
  const paid = await appts.book(ctx, booking('12:00', { patient_phone: '0790000005' }));
  await appts.checkout(ctx, paid, { amount_paid: '100', payment_method: 'cash', discount_percent: '' });
  await assert.rejects(appts.move(ctx, paid, { doctor_id: doctorId, appointment_date: date, appointment_time: '12:30' }), { code: 'ALREADY_PAID' });
  const cancelled = await appts.book(ctx, booking('09:30', { patient_phone: '0790000006' }));
  await appts.setStatus(ctx, cancelled, 'cancelled');
  await assert.rejects(appts.move(ctx, cancelled, { doctor_id: doctorId, appointment_date: date, appointment_time: '09:00' }), { code: 'APPOINTMENT_CANCELLED' });
});

test('a doctor login cannot move to another doctor; other clinics cannot see the appointment', async () => {
  const id = await appts.book(ctx, booking('11:30', { patient_phone: '0790000007' }));
  const scoped = { ...ctx, ownDoctorId: doctorId };
  await assert.rejects(appts.move(scoped, id, { doctor_id: doctor2Id, appointment_date: date, appointment_time: '16:00' }), { code: 'PERMISSION_DENIED' });
  await assert.rejects(appts.move(otherCtx, id, { doctor_id: doctorId, appointment_date: date, appointment_time: '09:00' }), { code: 'NOT_FOUND' });
  await assert.rejects(appts.move(ctx, id, { doctor_id: doctorId, appointment_date: '2020-01-05', appointment_time: '09:00' }), { code: 'DATE_IN_PAST' });
});
