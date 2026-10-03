// Reception & cash screen (worker: reception-cash): mixed payments, insurance split, the doctor's bill flowing into
// the cashier, the drawer counting only cash parts, and the double-payment lock. Integration test against docbook_test.
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
const cashier = require('../src/modules/clinic/cashier.service');

let ctx; let doctorId; let serviceId; let insurerId; let date; let seq = 0;
const times = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '14:00', '14:30', '15:00', '15:30'];

function nextSunday() {
  const d = new Date(`${scheduling.clinicNow('Asia/Amman').date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function visit() {
  seq += 1;
  // 12 times a day: later visits go to the same weekday of the following weeks.
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 7 * Math.floor((seq - 1) / times.length));
  return appts.book(ctx, { doctor_id: doctorId, service_id: serviceId, patient_name: `Cash ${seq}`, patient_phone: `07911100${String(seq).padStart(2, '0')}`, appointment_date: d.toISOString().slice(0, 10), appointment_time: times[(seq - 1) % times.length] });
}
/** What doctor-flow does when the doctor presses "Finish visit": lines + amount_due + completed. */
async function doctorFinishes(id, lines) {
  const total = lines.reduce((s, l) => s + l.qty * l.unit_price, 0);
  await knex('appointments').where({ id }).update({ doctor_lines: JSON.stringify(lines), amount_due: total, status: 'completed', with_doctor: false, doctor_finished_at: new Date() });
}
const line = (name, qty, price, extra = {}) => ({ name, qty: String(qty), unit_price: String(price), ...extra });

test.before(async () => {
  await knex.migrate.rollback(undefined, true);
  await knex.migrate.latest();
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: 'owner@cashx.test', password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Cash Screen Clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  ctx = { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, today: scheduling.clinicNow('Asia/Amman').date };
  doctorId = await doctors.saveDoctor(ctx, null, { full_name: 'Dr. Rana', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1', show_consultation_fee: '1' });
  serviceId = await doctors.saveService(ctx, null, { name: 'Check-up', price: '15', duration_minutes: '30', is_active: '1', show_price: '1' });
  [insurerId] = await knex('insurance_providers').insert({ business_id: businessId, name: 'Gulf Care', coverage_percent: 80, is_active: true });
  date = nextSunday();
});

test.after(() => knex.destroy());

test('settle: mixed parts must add up to what the patient pays, each part above zero', () => {
  assert.throws(() => cashier.settle({ total: 40, method: 'mixed', splitCash: 20, splitCard: 10 }, 'JOD'), { code: 'SPLIT_MISMATCH' });
  assert.throws(() => cashier.settle({ total: 40, method: 'mixed', splitCash: 40, splitCard: 0 }, 'JOD'), { code: 'VALIDATION_FAILED' });
  assert.throws(() => cashier.settle({ total: 40, method: 'mixed', splitCash: 25, splitCard: 15, received: 20 }, 'JOD'), { code: 'CASH_SHORT' });
  const s = cashier.settle({ total: 40, method: 'mixed', splitCash: 25.5, splitCard: 14.5, received: 30 }, 'JOD');
  assert.equal(s.paymentMethod, 'mixed');
  assert.deepEqual(s.parts.map((p) => [p.method, p.amount]), [['cash', 25.5], ['card', 14.5]]);
  assert.equal(s.change, 4.5, 'change comes from the cash part only');
});

test('settle: insurance split by percent or fixed amount; "insurance only" covers everything', () => {
  const pct = cashier.settle({ total: 50, method: 'cash', insurance: { on: true, type: 'percent', percent: 80 } }, 'JOD');
  assert.deepEqual([pct.insuranceAmount, pct.patientAmount, pct.coveragePercent, pct.paymentMethod], [40, 10, 80, 'mixed']);
  assert.deepEqual(pct.parts.map((p) => [p.method, p.amount]), [['insurance', 40], ['cash', 10]]);
  const amt = cashier.settle({ total: 30, method: 'card', insurance: { on: true, type: 'amount', amount: 12.345 } }, 'JOD');
  assert.deepEqual([amt.insuranceAmount, amt.patientAmount, amt.coveragePercent], [12.345, 17.655, 41.15]);
  assert.throws(() => cashier.settle({ total: 30, method: 'card', insurance: { on: true, type: 'amount', amount: 31 } }, 'JOD'), { code: 'VALIDATION_FAILED' });
  const only = cashier.settle({ total: 30, method: 'insurance' }, 'JOD');
  assert.deepEqual([only.insuranceAmount, only.patientAmount, only.paymentMethod, only.parts.length], [30, 0, 'insurance', 1]);
  const full = cashier.settle({ total: 30, method: 'cash', insurance: { on: true, type: 'percent', percent: 100 } }, 'JOD');
  assert.equal(full.paymentMethod, 'insurance', 'nothing left for the patient: an insurance-only receipt');
  assert.equal(full.received, null);
});

test("the doctor's lines and amount flow into the bill; changing them needs a reason, adding lines does not", async () => {
  const id = await visit();
  await doctorFinishes(id, [{ name: null, service_id: null, qty: 1, unit_price: 25, consultation: true }, { name: 'Check-up', service_id: serviceId, qty: 1, unit_price: 20 }]);
  const a = await cashier.visit(ctx, id);
  const lines = cashier.defaultLines(a);
  assert.deepEqual(lines.map((l) => [l.qty, l.unit_price, Boolean(l.fromDoctor)]), [[1, 25, true], [1, 20, true]], 'the doctor set 20 on a 15 service: the bill shows 20');
  // "Amount only": the doctor finished without lines → one line of amount_due.
  const b = { ...a, doctor_lines: null, amount_due: 33, service_id: null, service_name: null };
  assert.deepEqual(cashier.defaultLines(b).map((l) => l.unit_price), [33]);

  const screen = await cashier.today({ ...ctx, today: date });
  const v = screen.find((x) => x.id === id);
  assert.equal(v.state, 'ready');
  assert.equal(v.due, 45);

  const items = [line('Consultation', 1, 25), line('Check-up', 1, 18, { service_id: String(serviceId) })];
  await assert.rejects(cashier.pay(ctx, id, { items, payment_method: 'card' }), { code: 'ADJUST_REASON' });
  const withExtra = [line('Consultation', 1, 25), line('Check-up', 1, 20, { service_id: String(serviceId) }), line('Dressing', 1, 3)];
  const r = await cashier.pay(ctx, id, { items: withExtra, payment_method: 'card' });
  assert.equal(r.total, 48, 'adding a line to the doctor\'s bill needs no reason');
  const id2 = await visit();
  await doctorFinishes(id2, [{ name: 'Check-up', service_id: serviceId, qty: 1, unit_price: 20 }]);
  const r2 = await cashier.pay(ctx, id2, { items: [line('Check-up', 1, 18, { service_id: String(serviceId) })], payment_method: 'card', adjust_reason: 'price agreed with the doctor' });
  const inv = await knex('invoices').where({ id: r2.id }).first();
  assert.equal(inv.adjust_reason, 'price agreed with the doctor');
  assert.equal(Number(inv.amount), 18);
});

test('insurance payment stores the split: insurer part + patient part', async () => {
  const id = await visit();
  const r = await cashier.pay(ctx, id, { items: [line('Check-up', 1, 50)], payment_method: 'cash', insurance_provider_id: String(insurerId), coverage_type: 'percent', coverage: '80', amount_received: '20', discount_type: 'percent', discount_value: '0' });
  const inv = await knex('invoices').where({ id: r.id }).first();
  assert.equal(inv.insurance_provider_name, 'Gulf Care');
  assert.equal(Number(inv.insurance_amount), 40);
  assert.equal(Number(inv.insurance_coverage_percent), 80);
  assert.equal(Number(inv.amount), 50);
  assert.equal(Number(inv.change_due), 10);
  const parts = await knex('invoice_payments').where({ invoice_id: r.id }).orderBy('id');
  assert.deepEqual(parts.map((p) => [p.method, Number(p.amount)]), [['insurance', 40], ['cash', 10]]);
  const rec = await cashier.receipt(ctx, r.id);
  assert.deepEqual([rec.insuranceAmount, rec.patientAmount], [40, 10]);
});

test('expected cash in the drawer counts only the cash part of mixed / insured receipts', async () => {
  // Close whatever the earlier tests left, so this period starts clean.
  const p0 = await cashier.openPeriod(ctx);
  await cashier.close(ctx, { counted_cash: String(p0.expected), seen_expected: String(p0.expected), seen_count: String(p0.count) });
  assert.equal((await cashier.openPeriod(ctx)).expected, 0);

  await cashier.pay(ctx, await visit(), { items: [line('A', 1, 40)], payment_method: 'mixed', split_cash: '15', split_card: '25', amount_received: '20' });
  await cashier.pay(ctx, await visit(), { items: [line('B', 1, 30)], payment_method: 'card' });
  await cashier.pay(ctx, await visit(), { items: [line('C', 1, 12.5)], payment_method: 'cash', amount_received: '20' });
  await cashier.pay(ctx, await visit(), { items: [line('D', 1, 50)], payment_method: 'cash', insurance_provider_id: String(insurerId), coverage: '80' });
  // An older-style invoice without parts (front-desk quick checkout) still counts by its payment method.
  await appts.checkout(ctx, await visit(), { amount_paid: '7', payment_method: 'cash', discount_percent: '0' });
  const p = await cashier.openPeriod(ctx);
  assert.equal(p.expected, 15 + 12.5 + 10 + 7, 'cash parts only (not the change, not the card or insurance parts)');
  assert.equal(p.count, 4);
  const totals = await cashier.todayTotals({ ...ctx, today: scheduling.clinicNow('Asia/Amman').date });
  assert.ok(totals.byMethod.card >= 25 + 30);
  const closing = await cashier.close(ctx, { counted_cash: '44.5', seen_expected: String(p.expected), seen_count: String(p.count) });
  assert.equal(closing.variance, 0);
});

test('a visit is paid once: a second payment is refused (ALREADY_PAID), even at the same moment', async () => {
  const id = await visit();
  const body = { items: [line('Check-up', 1, 20)], payment_method: 'mixed', split_cash: '10', split_card: '10' };
  const results = await Promise.allSettled([cashier.pay(ctx, id, body), cashier.pay(ctx, id, body)]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(results.find((x) => x.status === 'rejected').reason.code, 'ALREADY_PAID');
  const [{ n }] = await knex('invoices').where({ appointment_id: id }).count({ n: '*' });
  assert.equal(Number(n), 1);
  const [{ m }] = await knex('invoice_payments').join('invoices', 'invoices.id', 'invoice_payments.invoice_id').where('invoices.appointment_id', id).count({ m: '*' });
  assert.equal(Number(m), 2, 'one set of parts');
});

test('voiding an invoice removes its payment parts', async () => {
  const id = await visit();
  const r = await cashier.pay(ctx, id, { items: [line('X', 1, 10)], payment_method: 'mixed', split_cash: '4', split_card: '6' });
  await appts.voidInvoice(ctx, r.id);
  assert.equal((await knex('invoice_payments').where({ invoice_id: r.id })).length, 0);
  assert.equal((await knex('appointments').where({ id }).first()).payment_status, 'unpaid');
});

// ---------------------------------------------------------------- cash screen: one payment for several visits
const saleLine = (id, amount, extra = {}) => ({ appointment_id: String(id), amount: String(amount), ...extra });

test('planSale: per-line discount % and insurance, totals, mixed split spread over the lines', () => {
  const lines = [
    { appointment_id: 1, amount: 30, discount_percent: 10 },                          // 27 to the patient
    { appointment_id: 2, amount: 25, discount_percent: 0, insurance_provider_id: 9, coverage: 80 }, // insurer 20, patient 5
    { appointment_id: 3, amount: 12.5, discount_percent: 0, coverage: 50 },           // coverage without a company: ignored
  ];
  const p = cashier.planSale({ lines, payment_method: 'mixed', split_cash: 30, split_card: 14.5, amount_received: 50 }, 'JOD');
  assert.deepEqual(p.lines.map((l) => [l.total, l.insurance, l.patient]), [[27, 0, 27], [25, 20, 5], [12.5, 0, 12.5]]);
  assert.deepEqual([p.total, p.insuranceTotal, p.patientTotal, p.cashTotal, p.cardTotal, p.change], [64.5, 20, 44.5, 30, 14.5, 20]);
  // Cash goes to the lines in order: 27 (cash) · 3 cash + 2 card (mixed) · 12.5 card.
  assert.deepEqual(p.lines.map((l) => [l.method, l.cash, l.card]), [['cash', 27, 0], ['mixed', 3, 2], ['card', 0, 12.5]]);
  assert.equal(p.lines.reduce((s, l) => s + l.cash, 0), 30, 'the cash parts add up to the cash handed over (minus change)');
  assert.deepEqual(p.lines.map((l) => l.received), [27, 23, undefined], 'the change is returned on the last line paid in cash');

  assert.throws(() => cashier.planSale({ lines, payment_method: 'mixed', split_cash: 30, split_card: 10 }, 'JOD'), { code: 'SPLIT_MISMATCH' });
  assert.throws(() => cashier.planSale({ lines, payment_method: 'cash', amount_received: 40 }, 'JOD'), { code: 'CASH_SHORT' });
  const cash = cashier.planSale({ lines, payment_method: 'cash', amount_received: 50 }, 'JOD');
  assert.deepEqual([cash.cashTotal, cash.change, cash.lines[2].received], [44.5, 5.5, 18]);
  const ins = cashier.planSale({ lines, payment_method: 'insurance' }, 'JOD');
  assert.deepEqual([ins.insuranceTotal, ins.patientTotal, ins.cashTotal, ins.change], [64.5, 0, 0, null]);
});

test('payMany: one invoice per visit, the doctor\'s lines kept, discounts / insurance per line, mixed parts add up', async () => {
  const a = await visit(); const b = await visit(); const c = await visit();
  await doctorFinishes(a, [{ name: null, service_id: null, qty: 1, unit_price: 20 }, { name: 'X-ray', service_id: null, qty: 1, unit_price: 10 }]);
  await doctorFinishes(b, [{ name: null, service_id: null, qty: 1, unit_price: 25 }]);
  const before = (await knex('businesses').where({ id: ctx.businessId }).first('invoice_next_number')).invoice_next_number;
  const r = await cashier.payMany(ctx, {
    payment_method: 'mixed', split_cash: '20', split_card: '27', amount_received: '50',
    lines: [saleLine(a, 30, { discount_percent: '10' }), saleLine(b, 25, { insurance_provider_id: String(insurerId), coverage: '80' }), saleLine(c, 15)],
  }, { consultationLabel: 'Consultation', source: 'cashier' }); // several visits at once: not from the cash screen (one patient there)
  assert.equal(r.invoices.length, 3);
  assert.deepEqual([r.total, r.insuranceTotal, r.patientTotal, r.cashTotal, r.cardTotal, r.change], [67, 20, 47, 20, 27, 30]);
  const invs = await knex('invoices').whereIn('id', r.invoices.map((i) => i.id)).orderBy('id');
  assert.deepEqual(invs.map((i) => i.appointment_id), [a, b, c], 'one invoice per visit, in order');
  assert.deepEqual(invs.map((i) => i.invoice_number), [before, before + 1, before + 2]);
  assert.deepEqual(invs.map((i) => Number(i.amount)), [27, 25, 15]);
  assert.equal(Number(invs[0].discount_percent), 10);
  assert.deepEqual((typeof invs[0].items === 'string' ? JSON.parse(invs[0].items) : invs[0].items).map((l) => [l.name, l.total]), [['Consultation', 20], ['X-ray', 10]], "the doctor's two lines stay on the invoice");
  assert.deepEqual([invs[1].insurance_provider_name, Number(invs[1].insurance_amount)], ['Gulf Care', 20]);
  const parts = await knex('invoice_payments').whereIn('invoice_id', invs.map((i) => i.id)).orderBy('id');
  const sum = (m) => parts.filter((p) => p.method === m).reduce((s, p) => s + Number(p.amount), 0);
  assert.deepEqual([sum('cash'), sum('card'), sum('insurance')], [20, 27, 20], 'the parts of all invoices add up to the payment');
  invs.forEach((inv) => {
    const own = parts.filter((p) => p.invoice_id === inv.id).reduce((s, p) => s + Number(p.amount), 0);
    assert.equal(Math.round(own * 1000) / 1000, Number(inv.amount), `invoice #${inv.invoice_number}: its parts add up to its amount`);
  });
  assert.equal(Number(invs[0].change_due), 30, 'the change is on the invoice that took the cash');
  const paid = await knex('appointments').whereIn('id', [a, b, c]).pluck('payment_status');
  assert.deepEqual(paid, ['paid', 'paid', 'paid']);
  const audits = await knex('audit_logs').where({ business_id: ctx.businessId, action: 'invoice.created' }).whereIn('entity_id', invs.map((i) => i.id)).select('new_values');
  assert.equal(audits.length, 3);
  assert.ok(audits.every((x) => (typeof x.new_values === 'string' ? JSON.parse(x.new_values) : x.new_values).source === 'cashier')); // paid from the cashier page (the cash screen takes one patient)
});

test('payMany: all or nothing — an already-paid visit, a changed doctor bill without a reason or a repeated visit pays nothing', async () => {
  const paidOne = await visit(); const fresh = await visit();
  await cashier.pay(ctx, paidOne, { items: [line('Check-up', 1, 15)], payment_method: 'card' });
  const count = async () => Number((await knex('invoices').where({ business_id: ctx.businessId }).count({ n: '*' }))[0].n);
  const n0 = await count();
  await assert.rejects(cashier.payMany(ctx, { payment_method: 'cash', lines: [saleLine(fresh, 15), saleLine(paidOne, 15)] }, { source: 'cashier' }), (e) => e.code === 'ALREADY_PAID' && e.line === paidOne);
  assert.equal(await count(), n0, 'nothing was paid');
  assert.equal((await knex('appointments').where({ id: fresh }).first()).payment_status, 'unpaid');

  await doctorFinishes(fresh, [{ name: null, service_id: null, qty: 1, unit_price: 20 }]);
  await assert.rejects(cashier.payMany(ctx, { payment_method: 'cash', lines: [saleLine(fresh, 15)] }), (e) => e.code === 'ADJUST_REASON' && e.line === fresh);
  await assert.rejects(cashier.payMany(ctx, { payment_method: 'cash', lines: [saleLine(fresh, 20), saleLine(fresh, 20)] }, { source: 'cashier' }), { code: 'VALIDATION_FAILED' });
  await assert.rejects(cashier.payMany(ctx, { payment_method: 'cash', lines: [] }), { code: 'VALIDATION_FAILED' });
  const r = await cashier.payMany(ctx, { payment_method: 'cash', amount_received: '20', lines: [saleLine(fresh, 15, { adjust_reason: 'agreed with the doctor' })] });
  const inv = await knex('invoices').where({ id: r.invoices[0].id }).first();
  assert.deepEqual([Number(inv.amount), inv.adjust_reason, Number(inv.change_due)], [15, 'agreed with the doctor', 5]);
  // Two cashiers paying the same visits at the same moment: one wins, the other is refused.
  const x = await visit(); const y = await visit();
  const body = { payment_method: 'card', lines: [saleLine(x, 10), saleLine(y, 10)] };
  const res = await Promise.allSettled([cashier.payMany(ctx, body, { source: 'cashier' }), cashier.payMany(ctx, body, { source: 'cashier' })]);
  assert.equal(res.filter((q) => q.status === 'fulfilled').length, 1);
  assert.equal(res.find((q) => q.status === 'rejected').reason.code, 'ALREADY_PAID');
  assert.equal(Number((await knex('invoices').whereIn('appointment_id', [x, y]).count({ n: '*' }))[0].n), 2);
});

test('cash screen: a patient still waiting or with the doctor is not paid there (no second invoice later)', async () => {
  const w = await visit(); const d = await visit(); const done = await visit();
  await knex('appointments').where({ id: w }).update({ checked_in: true });
  await knex('appointments').where({ id: d }).update({ checked_in: true, with_doctor: true });
  await doctorFinishes(done, [{ name: 'Consultation', qty: 1, unit_price: 15 }]);
  await assert.rejects(cashier.payMany(ctx, { payment_method: 'cash', lines: [saleLine(w, 15)] }), (e) => e.code === 'VISIT_NOT_DONE' && e.line === w);
  // One patient per payment on the cash screen.
  await assert.rejects(cashier.payMany(ctx, { payment_method: 'cash', lines: [saleLine(done, 15), saleLine(w, 15)] }), { code: 'ONE_VISIT' });
  await assert.rejects(cashier.payMany(ctx, { payment_method: 'cash', lines: [saleLine(d, 15)] }), (e) => e.code === 'VISIT_NOT_DONE' && e.line === d);
  assert.equal(Number((await knex('invoices').whereIn('appointment_id', [w, d, done]).count({ n: '*' }))[0].n), 0); // all or nothing
  const r = await cashier.payMany(ctx, { payment_method: 'cash', lines: [saleLine(done, 15)] });
  assert.equal(r.invoices.length, 1);
});

test('cash screen side column: send a waiting patient in, finish the visit with an amount, then it waits for payment', async () => {
  const id = await visit();
  await knex('appointments').where({ id }).update({ checked_in: true, appointment_date: ctx.today || (await knex('appointments').where({ id }).first()).appointment_date });
  const appts2 = require('../src/modules/clinic/appointments.service');
  await appts2.callIn(ctx, id, true);
  let a = await cashier.visit(ctx, id);
  assert.equal(cashier.flowState(a), 'with_doctor');
  const dflow = require('../src/modules/clinic/dflow.service');
  await dflow.finish(ctx, id, { lines: [{ name: 'Consultation', qty: 1, unit_price: '42.5' }] });
  a = await cashier.visit(ctx, id);
  assert.equal(cashier.flowState(a), 'ready');
  assert.equal(Number(a.amount_due), 42.5);
  const r = await cashier.payMany(ctx, { payment_method: 'cash', lines: [saleLine(id, 42.5)] });
  assert.equal(r.invoices.length, 1);
});
