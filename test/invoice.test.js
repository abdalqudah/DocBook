// Invoices shown and totalled by their payment parts (worker: invoice): never a "mixed" bucket. Pure aggregation +
// integration against docbook_test (SQL totals by method, the method filter, the fallback for invoices without parts,
// the P&L "of which" lines, the one-line breakdown text).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const { translator } = require('../src/core/i18n');
const pp = require('../src/modules/clinic/payment-parts');
const pnl = require('../src/modules/finance/pnl.service');

let businessId;
const ids = {};

async function invoice(key, { amount, method, parts = null, discount = 0, insurer = null, number }) {
  const [id] = await knex('invoices').insert({
    business_id: businessId, invoice_number: number, patient_name: `Patient ${key}`, doctor_name: 'Dr. Test', service_name: 'Visit',
    amount, discount_amount: discount, discount_percent: discount ? Math.round((discount / (amount + discount)) * 10000) / 100 : 0,
    payment_method: method, insurance_provider_name: insurer,
  });
  if (parts) await knex('invoice_payments').insert(parts.map(([m, a]) => ({ business_id: businessId, invoice_id: id, method: m, amount: a })));
  ids[key] = id;
  return id;
}

test.before(async () => {
  await knex.migrate.rollback(undefined, true);
  await knex.migrate.latest();
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: 'owner@invoice.test', password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Invoice Clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  ({ last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id'));
  // single cash, card, cash + card, insurance + patient cash, discounted card, and two OLD invoices without parts
  await invoice('cash', { number: 1, amount: 20, method: 'cash', parts: [['cash', 20]] });
  await invoice('card', { number: 2, amount: 35, method: 'card', parts: [['card', 35]] });
  await invoice('mixed', { number: 3, amount: 40, method: 'mixed', parts: [['cash', 20], ['card', 20]] });
  await invoice('insured', { number: 4, amount: 40, method: 'mixed', insurer: 'Nat Health', parts: [['insurance', 32], ['cash', 8]] });
  await invoice('discount', { number: 5, amount: 45, method: 'card', discount: 5, parts: [['card', 45]] });
  await invoice('oldCash', { number: 6, amount: 15, method: 'cash' });
  await invoice('oldTransfer', { number: 7, amount: 30, method: 'bank_transfer' });
});

test.after(() => knex.destroy());

test('aggregate (pure): parts count under each method, old invoices fall back to payment_method, no "mixed" key', () => {
  const invs = [{ id: 1, amount: 40, payment_method: 'mixed' }, { id: 2, amount: 40, payment_method: 'mixed' }, { id: 3, amount: 15, payment_method: 'cash' }, { id: 4, amount: 9, payment_method: 'mixed' }];
  const map = new Map([[1, [{ method: 'cash', amount: 20 }, { method: 'card', amount: 20 }]], [2, [{ method: 'insurance', amount: 32 }, { method: 'cash', amount: 8 }]]]);
  const a = pp.aggregate(invs, map);
  assert.deepEqual(a.byMethod.cash, { amount: 43, invoices: 3 });
  assert.deepEqual(a.byMethod.card, { amount: 20, invoices: 1 });
  assert.deepEqual(a.byMethod.insurance, { amount: 32, invoices: 1 });
  assert.equal(a.byMethod.mixed, undefined, 'the summary word is never a bucket');
  assert.deepEqual(a.byMethod.other, { amount: 9, invoices: 1 }, 'a legacy "mixed" invoice without parts is "other methods"');
  assert.equal(a.total, 104);
  assert.equal(a.rows[0].method, 'cash', 'largest first');
  // parts of one invoice: insurance first, then what the patient paid
  assert.deepEqual(pp.partsOf({ id: 2 }, map).map((p) => p.method), ['insurance', 'cash']);
  assert.deepEqual(pp.partsOf({ id: 3, amount: 15, payment_method: 'cash' }, map), [{ method: 'cash', amount: 15 }]);
});

test('totalsByMethod (SQL) sums invoice_payments per method with the fallback for invoices without parts', async () => {
  const r = await pp.totalsByMethod(knex('invoices as i').where('i.business_id', businessId), 'i.id', businessId);
  assert.deepEqual(r.byMethod, {
    cash: { amount: 63, invoices: 4 }, // 20 + 20 (mixed) + 8 (insured) + 15 (old)
    card: { amount: 100, invoices: 3 }, // 35 + 20 + 45
    insurance: { amount: 32, invoices: 1 },
    bank_transfer: { amount: 30, invoices: 1 },
  });
  assert.equal(r.total, 225);
  assert.equal(r.count, 7);
  const sum = r.rows.reduce((s, x) => s + x.amount, 0);
  assert.equal(sum, r.total, 'the method breakdown adds up to the revenue');
  // same answer as the pure aggregation over the same invoices
  const invs = await knex('invoices').where({ business_id: businessId }).select('id', 'amount', 'payment_method');
  const pure = pp.aggregate(invs, await pp.partsMap(businessId, invs.map((x) => x.id)));
  assert.deepEqual(pure.byMethod, r.byMethod);
});

test('the method filter keeps invoices that HAVE a part in that method (and old invoices by payment_method)', async () => {
  const having = async (m) => (await pp.whereHasMethod(knex('invoices').where('invoices.business_id', businessId), m).orderBy('invoice_number').pluck('invoices.id'));
  assert.deepEqual(await having('cash'), [ids.cash, ids.mixed, ids.insured, ids.oldCash]);
  assert.deepEqual(await having('card'), [ids.card, ids.mixed, ids.discount]);
  assert.deepEqual(await having('insurance'), [ids.insured]);
  assert.deepEqual(await having('bank_transfer'), [ids.oldTransfer]);
  assert.deepEqual(await having('mixed'), [], '"mixed" matches nothing — it is not a method');
  // other aliases work too (reports use invoices as i)
  const q = pp.whereHasMethod(knex('invoices as i').where('i.business_id', businessId), 'card', 'i.id', 'i.payment_method');
  assert.equal((await q.pluck('i.id')).length, 3);
});

test('breakdown text spells out the parts: "Cash 20.000 + Card 20.000", insurer named', async () => {
  const [mixed, insured, single] = await Promise.all([ids.mixed, ids.insured, ids.card].map(async (id) => {
    const inv = await knex('invoices').where({ id }).first();
    return pp.attach(businessId, [inv]).then(([x]) => x);
  }));
  const amount = (v) => Number(v).toFixed(3);
  const en = translator('en');
  const ar = translator('ar');
  assert.equal(pp.describe(en, mixed.parts, { amount }), 'Cash 20.000 + Card 20.000');
  assert.equal(pp.describe(en, insured.parts, { insuranceName: insured.insurance_provider_name, amount }), 'Insurance (Nat Health) 32.000 + Cash 8.000');
  assert.equal(pp.describe(ar, insured.parts, { insuranceName: 'نات هيلث', amount }), 'تأمين (نات هيلث) 32.000 + نقدًا 8.000');
  assert.equal(pp.describe(en, single.parts, { amount }), 'Card', 'one part: just the method');
  assert.equal(pp.amountBy(mixed.parts, 'cash'), 20);
  assert.equal(pp.amountBy(single.parts, 'cash'), 0);
  for (const t of [en, ar]) {
    pp.METHODS.concat(['other']).forEach((m) => assert.notEqual(t(`invoicex.m.${m}`), `invoicex.m.${m}`, `label for ${m}`));
    assert.doesNotMatch(pp.describe(t, [{ method: 'mixed', amount: 5 }]), /mixed|مختلط/i);
  }
});

test('P&L "of which" lines by payment method come from the parts and add up to revenue', async () => {
  const month = (await knex.raw("SELECT DATE_FORMAT(CONVERT_TZ(NOW(), @@session.time_zone, '+03:00'), '%Y-%m') AS m"))[0][0].m;
  const months = await pnl.monthly(businessId, 'Asia/Amman', month, month);
  const s = pnl.toStatement(pnl.sum(months, [month]));
  const by = Object.fromEntries(s.byMethod.map((x) => [x.method, x.amount]));
  assert.deepEqual(by, { cash: 63, card: 100, insurance: 32, bank_transfer: 30 });
  assert.equal(s.byMethod.reduce((t, x) => t + x.amount, 0), s.revenue);
});
