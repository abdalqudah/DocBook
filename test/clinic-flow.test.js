// Integration test of the clinic flow against a real database (docbook_test):
// booking with slot locking, patient matching, checkout + invoice numbering, doctor scoping,
// tenant isolation, commissions and staff logins.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const appts = require('../src/modules/clinic/appointments.service');
const payroll = require('../src/modules/clinic/payroll.service');
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

test.before(async () => {
  await knex.migrate.rollback(undefined, true);
  await knex.migrate.latest();
  ctx = await clinic('owner@a.test', 'Clinic A');
  otherCtx = await clinic('owner@b.test', 'Clinic B');
  doctorId = await doctors.saveDoctor(ctx, null, { full_name: 'Dr. Sami', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '500', is_active: '1', show_consultation_fee: '1' });
  doctor2Id = await doctors.saveDoctor(ctx, null, { full_name: 'Dr. Huda', slot_duration_minutes: '30', consultation_fee: '25', base_salary: '0', is_active: '1', show_consultation_fee: '1' });
  serviceId = await doctors.saveService(ctx, null, { name: 'Check-up', price: '100', duration_minutes: '30', is_active: '1', show_price: '1' });
  date = nextSunday();
});

test.after(() => knex.destroy());

test('slots follow the default schedule and a booked slot disappears', async () => {
  const slots = await scheduling.availableSlots({ businessId: ctx.businessId, timezone: ctx.timezone, doctorId, date, serviceId });
  assert.equal(slots[0], '09:00');
  assert.ok(!slots.includes('13:00'), 'the 13:00–14:00 break is not bookable');
  await appts.book(ctx, booking('09:00'));
  const after = await scheduling.availableSlots({ businessId: ctx.businessId, timezone: ctx.timezone, doctorId, date, serviceId });
  assert.ok(!after.includes('09:00'));
  await assert.rejects(appts.book(ctx, booking('09:00', { patient_phone: '0790000002' })), { code: 'SLOT_TAKEN' });
});

test('two simultaneous bookings of the same slot: exactly one wins', async () => {
  const results = await Promise.allSettled([appts.book(ctx, booking('10:00', { patient_phone: '0790000003' })), appts.book(ctx, booking('10:00', { patient_phone: '0790000004' }))]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'SLOT_TAKEN');
});

test('patients are matched by exact phone within the clinic', async () => {
  const a = await appts.book(ctx, booking('11:00'));
  const first = await knex('appointments').where({ business_id: ctx.businessId, appointment_time: '09:00', appointment_date: date }).first('patient_id');
  const second = await knex('appointments').where({ id: a }).first('patient_id');
  assert.equal(first.patient_id, second.patient_id);
});

test('checkout issues sequential invoices; net amount paid, discount derived; double payment refused', async () => {
  const a1 = await appts.book(ctx, booking('11:30', { patient_phone: '0790000010' }));
  const a2 = await appts.book(ctx, booking('12:00', { patient_phone: '0790000011' }));
  const i1 = await appts.checkout(ctx, a1, { amount_paid: '80', payment_method: 'cash', discount_percent: '20' });
  const i2 = await appts.checkout(ctx, a2, { amount_paid: '100', payment_method: 'card', discount_percent: '' });
  const [inv1, inv2] = await Promise.all([knex('invoices').where({ id: i1 }).first(), knex('invoices').where({ id: i2 }).first()]);
  assert.equal(inv1.invoice_number, 1);
  assert.equal(inv2.invoice_number, 2);
  assert.equal(Number(inv1.amount), 80);
  assert.equal(Number(inv1.discount_amount), 20);
  const appt = await appts.get(ctx, a1);
  assert.equal(appt.payment_status, 'paid');
  assert.equal(appt.status, 'completed');
  await assert.rejects(appts.checkout(ctx, a1, { amount_paid: '80', payment_method: 'cash' }), { code: 'ALREADY_PAID' });
  await assert.rejects(appts.remove(ctx, a1), { code: 'APPOINTMENT_INVOICED' });
  await appts.voidInvoice(ctx, i2);
  assert.equal((await appts.get(ctx, a2)).payment_status, 'unpaid');
});

test('a doctor login only sees its own schedule; other clinics see nothing', async () => {
  const mine = await appts.book(ctx, { ...booking('14:00', { patient_phone: '0790000020' }), doctor_id: doctor2Id });
  const scoped = { ...ctx, ownDoctorId: doctorId };
  await assert.rejects(appts.get(scoped, mine), { code: 'NOT_FOUND' });
  const list = await appts.list(scoped, { from: date, to: date });
  assert.ok(list.length > 0 && list.every((a) => a.doctor_id === doctorId));
  await assert.rejects(appts.get(otherCtx, mine), { code: 'NOT_FOUND' });
  await assert.rejects(doctors.doctors.get(otherCtx, doctorId), { code: 'NOT_FOUND' });
});

test('commission and payroll: approved adjustments only, four-eyes rule', async () => {
  await payroll.saveRule(ctx, doctorId, { basis: 'percentage', rate: '10' });
  const period = new Date().toISOString().slice(0, 7);
  const adj = await payroll.addAdjustment(ctx, doctorId, { type: 'bonus', amount: '50', reason: 'x', period });
  const noOverride = { ...ctx, permissions: new Set([...ctx.permissions].filter((p) => p !== 'data.manage')) };
  await assert.rejects(payroll.reviewAdjustment(noOverride, adj, 'approved'), { code: 'FOUR_EYES' });
  await assert.rejects(payroll.markPaid(ctx, doctorId, period), { code: 'PENDING_ADJUSTMENTS' });
  await payroll.reviewAdjustment(ctx, adj, 'approved');
  const c = await payroll.calculate(ctx, doctorId, period);
  assert.equal(c.commission, 8); // 10% of the one remaining invoice (80); the voided one is gone
  assert.equal(c.netPayroll, 500 + 8 + 50);
  await payroll.markPaid(ctx, doctorId, period, { method: 'bank_transfer' });
  await assert.rejects(payroll.addAdjustment(ctx, doctorId, { type: 'bonus', amount: '5', period }), { code: 'PERIOD_PAID' });
});

test('staff login with a temporary password is linked to its doctor profile and must change the password', async () => {
  const roles = await rbac.listRoles(ctx.businessId);
  const doctorRole = roles.find((r) => r.key === 'doctor');
  const res = await businesses.addStaff(ctx, { name: 'Dr. Sami', email: 'sami@a.test', roleId: doctorRole.id, doctorId, mode: 'password' });
  assert.ok(res.password && res.password.length >= 12);
  const user = await knex('users').where({ email: 'sami@a.test' }).first();
  assert.equal(Boolean(user.must_change_password), true);
  const m = await knex('memberships').where({ user_id: user.id, business_id: ctx.businessId }).first();
  assert.equal(m.doctor_id, doctorId);
  const perms = await rbac.getUserPermissions(ctx.businessId, user.id);
  assert.ok(perms.has('clinical.edit') && !perms.has('appointments.view_all') && !perms.has('users.manage'));
  await assert.rejects(businesses.addStaff(ctx, { name: 'X', email: 'x@a.test', roleId: doctorRole.id, doctorId, mode: 'password' }), (e) => e.code === 'VALIDATION_FAILED' || e.code === 'DOCTOR_LINKED');
});
