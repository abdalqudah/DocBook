// Pins DocBook's clinic rules: availability engine, checkout discount maths, commissions and payroll.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/modules/clinic/scheduling');
const M = require('../src/modules/clinic/money-rules');

const week = {
  sun: { enabled: true, shifts: [{ start: '09:00', end: '12:00' }, { start: '16:00', end: '18:00' }], breaks: [{ start: '10:30', end: '11:00' }] },
  mon: { start: '09:00', end: '10:00' },            // older DocBook shape
  fri: { enabled: false, shifts: [], breaks: [] },
};
// 2026-10-04 is a Sunday, 2026-10-05 a Monday, 2026-10-09 a Friday.

test('slots follow shifts, step, breaks and service length', () => {
  const slots = S.computeSlots({ workingHours: week, slotStep: 30, duration: 30, date: '2026-10-04', today: '2026-10-01' });
  assert.deepEqual(slots, ['09:00', '09:30', '10:00', '11:00', '11:30', '16:00', '16:30', '17:00', '17:30']);
  const long = S.computeSlots({ workingHours: week, slotStep: 30, duration: 60, date: '2026-10-04', today: '2026-10-01' });
  assert.deepEqual(long, ['09:00', '09:30', '11:00', '16:00', '16:30', '17:00']); // 10:00–11:00 hits the break
});

test('booked appointments block overlapping slots using their own length', () => {
  const slots = S.computeSlots({ workingHours: week, slotStep: 30, duration: 30, date: '2026-10-04', today: '2026-10-01', booked: [{ time: '09:00', duration: 45 }] });
  assert.ok(!slots.includes('09:00') && !slots.includes('09:30'));
  assert.ok(slots.includes('10:00'));
});

test('older {start,end} day shape, disabled days and days off', () => {
  assert.deepEqual(S.computeSlots({ workingHours: week, slotStep: 20, duration: 20, date: '2026-10-05', today: '2026-10-01' }), ['09:00', '09:20', '09:40']);
  assert.deepEqual(S.computeSlots({ workingHours: week, date: '2026-10-09', today: '2026-10-01' }), []);
  assert.deepEqual(S.computeSlots({ workingHours: week, date: '2026-10-04', today: '2026-10-01', dayOff: true }), []);
  assert.deepEqual(S.computeSlots({ workingHours: null, date: '2026-10-04', today: '2026-10-01' }), []);
});

test('past dates are refused and past times today are skipped', () => {
  assert.throws(() => S.computeSlots({ workingHours: week, date: '2026-09-01', today: '2026-10-01' }), /passed/);
  const today = S.computeSlots({ workingHours: week, slotStep: 30, duration: 30, date: '2026-10-04', today: '2026-10-04', nowMinutes: 16 * 60 });
  assert.deepEqual(today, ['16:30', '17:00', '17:30']);
});

test('clinicNow respects the clinic time zone', () => {
  const at = new Date('2026-10-04T22:30:00Z');
  assert.deepEqual(S.clinicNow('Asia/Amman', at), { date: '2026-10-05', minutes: 90 }); // UTC+3
  assert.deepEqual(S.clinicNow('UTC', at), { date: '2026-10-04', minutes: 22 * 60 + 30 });
});

test('working hours form parsing', () => {
  const wh = S.parseWorkingHoursForm({ wh: { sun: { enabled: '1', s1: '09:00', e1: '13:00', s2: '16:00', e2: '15:00', bs: '11:00', be: '11:30' }, mon: { enabled: '1' } } });
  assert.deepEqual(wh.sun, { enabled: true, shifts: [{ start: '09:00', end: '13:00' }], breaks: [{ start: '11:00', end: '11:30' }] });
  assert.equal(wh.mon.enabled, false); // no valid shift
});

test('checkout: amount paid is net; discount is derived (DocBook)', () => {
  assert.deepEqual(M.checkoutAmounts(80, 20), { amount: 80, discountPercent: 20, discountAmount: 20, originalAmount: 100 });
  assert.deepEqual(M.checkoutAmounts(50, 0), { amount: 50, discountPercent: 0, discountAmount: 0, originalAmount: 50 });
  assert.equal(M.checkoutAmounts(10, 150).discountPercent, 100);
});

const invoices = [
  { id: 1, amount: 100, serviceName: 'Cleaning', patientId: 1 },
  { id: 2, amount: 200, serviceName: 'Implant', patientId: 1 },
  { id: 3, amount: 50, serviceName: 'Cleaning', patientId: 2 },
];

test('commission: percentage with a per-service override', () => {
  const r = M.commission({ basis: 'percentage', rate: 10, serviceOverrides: [{ serviceName: 'Implant', basis: 'fixed_per_visit', rate: 30 }] }, invoices);
  assert.equal(r.totalRevenue, 350);
  assert.equal(r.totalCommission, 10 + 30 + 5);
  assert.equal(r.visitCount, 3);
  assert.equal(r.uniquePatientCount, 2);
});

test('commission: fixed per visit, fixed per patient, and no rule', () => {
  assert.equal(M.commission({ basis: 'fixed_per_visit', rate: 7, serviceOverrides: [] }, invoices).totalCommission, 21);
  assert.equal(M.commission({ basis: 'fixed_per_patient', rate: 15, serviceOverrides: [{ serviceName: 'Implant', basis: 'percentage', rate: 50 }] }, invoices).totalCommission, 30);
  const none = M.commission(null, invoices);
  assert.equal(none.totalCommission, 0);
  assert.equal(none.totalRevenue, 350);
  assert.equal(none.hasRule, false);
});

test('payroll counts only approved adjustments', () => {
  const p = M.payroll(1000, 250, [
    { type: 'bonus', amount: 100, approvalStatus: 'approved' },
    { type: 'bonus', amount: 999, approvalStatus: 'pending' },
    { type: 'deduction', amount: 40, approvalStatus: 'approved' },
    { type: 'advance', amount: 60, approvalStatus: 'approved' },
    { type: 'deduction', amount: 500, approvalStatus: 'rejected' },
  ]);
  assert.deepEqual(p, { baseSalary: 1000, commission: 250, bonuses: 100, deductions: 40, advances: 60, netPayroll: 1250 });
  assert.deepEqual(M.periodRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
});
