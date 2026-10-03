// Integration test of purchase orders (clinic ↔ supplier / registered vendor) against docbook_test.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const supplies = require('../src/modules/clinic/supplies.service');
const mailer = require('../src/core/mailer');
const po = require('../src/modules/purchasing/purchasing.service');

let ctx; let other; let vendor; let pendingVendor; let vctx; let supplierId; let vendorSupplierId; let plainSupplierId; let gloves; let syringes; let masks;
const sent = [];
const realMailer = { configured: mailer.configured, send: mailer.send };

async function clinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null };
}

async function makeVendor(email, status) {
  const userId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Rep', email, password: 'Passw0rd!x' }));
  const [id] = await knex('vendors').insert({ type: 'warehouse', name: `Warehouse ${email}`, email, status });
  await knex('vendor_users').insert({ vendor_id: id, user_id: userId, role: 'owner' });
  return { row: await knex('vendors').where({ id }).first(), userId };
}

const stubMail = (fail = false) => { mailer.configured = () => true; mailer.send = async (m) => { if (fail) throw new Error('smtp down'); sent.push(m); return true; }; };
const unstubMail = () => { mailer.configured = realMailer.configured; mailer.send = realMailer.send; };
const lines = (...ls) => ({ lines: ls.map(([id, q, extra]) => ({ supply_item_id: id ? String(id) : '', quantity: String(q), ...(extra || {}) })) });

test.before(async () => {
  await knex.migrate.rollback(undefined, true);
  await knex.migrate.latest();
  ctx = await clinic('owner@purchasing.test', 'Purchasing Clinic');
  other = await clinic('owner2@purchasing.test', 'Other Clinic');
  const v = await makeVendor('rep@purchasing.test', 'active');
  vendor = v.row; vctx = { vendorId: vendor.id, userId: v.userId };
  pendingVendor = (await makeVendor('pending@purchasing.test', 'pending')).row;
  supplierId = await supplies.saveSupplier(ctx, null, { name: 'Medical Supplies Co', email: 'sales@supplier.test', phone: '0790000000', is_active: '1' });
  plainSupplierId = await supplies.saveSupplier(ctx, null, { name: 'No E-mail Supplier', is_active: '1' });
  vendorSupplierId = await supplies.saveSupplier(ctx, null, { name: 'Registered Warehouse', is_active: '1' });
  await knex('suppliers').where({ id: vendorSupplierId }).update({ vendor_id: vendor.id });
  gloves = await supplies.saveItem(ctx, null, { name: 'Nitrile gloves', unit: 'box', supplier_id: String(supplierId), current_stock: '3', reorder_level: '10', unit_cost: '4' });
  syringes = await supplies.saveItem(ctx, null, { name: 'Syringes 5 ml', unit: 'pack', supplier_id: String(vendorSupplierId), current_stock: '1', reorder_level: '5', unit_cost: '2' });
  masks = await supplies.saveItem(ctx, null, { name: 'Face masks', unit: 'box', current_stock: '0', reorder_level: '4', unit_cost: '1' });
  await supplies.saveItem(ctx, null, { name: 'Gauze', unit: 'pack', supplier_id: String(supplierId), current_stock: '50', reorder_level: '10', unit_cost: '1' });
});

test.after(async () => { unstubMail(); await knex.destroy(); });

test('suggested quantity: max(2 × reorder level − stock, reorder level), only for low items', () => {
  assert.equal(po.suggestQty(3, 10), 17);
  assert.equal(po.suggestQty(9, 10), 11);
  assert.equal(po.suggestQty(10, 10), 10, 'at the level: back to twice the level');
  assert.equal(po.suggestQty(0, 4), 8);
  assert.equal(po.suggestQty(11, 10), 0, 'above the level: nothing suggested');
  assert.equal(po.suggestQty(0, 0), 0, 'no reorder level: nothing suggested');
  assert.equal(po.suggestQty(1.5, 2.5), 4, 'rounded up');
});

test('a draft keeps only lines with a quantity, validates them and has no number yet', async () => {
  await assert.rejects(po.saveDraft(ctx, null, { supplier_id: String(supplierId), ...lines([gloves, 0]) }), { code: 'VALIDATION_FAILED' });
  await assert.rejects(po.saveDraft(ctx, null, { supplier_id: String(supplierId), ...lines([gloves, 'abc']) }), (e) => e.code === 'VALIDATION_FAILED' && e.details['lines.0.quantity'] === 'Enter a number.');
  await assert.rejects(po.saveDraft(ctx, null, { supplier_id: String(supplierId), ...lines([null, 2]) }), (e) => e.details['lines.0.name'] === 'Required.');
  await assert.rejects(po.saveDraft(other, null, { supplier_id: String(supplierId), ...lines([gloves, 2]) }), { code: 'NOT_FOUND' }, 'another clinic cannot use this supplier');
  const id = await po.saveDraft(ctx, null, { supplier_id: String(supplierId), notes: 'Call before coming', ...lines([gloves, 17], [masks, 0], [null, 2, { name: 'Dental bibs', unit: 'box' }]) });
  const d = await po.get(ctx, id);
  assert.equal(d.status, 'draft');
  assert.equal(d.po_number, null);
  assert.deepEqual(d.lines.map((l) => [l.name, Number(l.quantity), l.supply_item_id]), [['Nitrile gloves', 17, gloves], ['Dental bibs', 2, null]]);
  assert.ok(await knex('audit_logs').where({ business_id: ctx.businessId, action: 'purchase_order.created', entity_id: String(id) }).first());
  await assert.rejects(po.get(other, id), { code: 'NOT_FOUND' });
});

test('sending without e-mail and without a registered vendor changes nothing; mark as sent claims a number', async () => {
  unstubMail();
  const id = await po.saveDraft(ctx, null, { supplier_id: String(plainSupplierId), ...lines([masks, 8]) });
  await assert.rejects(po.send(ctx, id), { code: 'MAIL_NOT_CONFIGURED' });
  let d = await po.get(ctx, id);
  assert.equal(d.status, 'draft');
  assert.equal(d.po_number, null);
  stubMail();
  await assert.rejects(po.send(ctx, id), { code: 'PO_NO_EMAIL' }, 'mail on, but the supplier has no address');
  const r = await po.markSent(ctx, id);
  d = await po.get(ctx, id);
  assert.equal(d.status, 'sent');
  assert.equal(d.po_number, r.number);
  assert.equal(d.sent_to_email, null);
  assert.equal(d.contact_name, 'Owner');
  await assert.rejects(po.saveDraft(ctx, id, { supplier_id: String(plainSupplierId), ...lines([masks, 9]) }), { code: 'PO_NOT_DRAFT' });
});

test('purchase-order numbers are sequential per clinic, even when sent at the same moment', async () => {
  const before = (await knex('businesses').where({ id: ctx.businessId }).first('po_next_number')).po_next_number;
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push(await po.saveDraft(ctx, null, { supplier_id: String(vendorSupplierId), ...lines([syringes, i + 1]) })); // eslint-disable-line no-await-in-loop
  const results = await Promise.all(ids.map((id) => po.markSent(ctx, id)));
  const numbers = results.map((r) => r.number).sort((a, b) => a - b);
  assert.deepEqual(numbers, [0, 1, 2, 3, 4, 5].map((k) => before + k));
  assert.equal((await knex('businesses').where({ id: ctx.businessId }).first('po_next_number')).po_next_number, before + 6);
  // Another clinic starts at 1.
  const s2 = await supplies.saveSupplier(other, null, { name: 'Other supplier', is_active: '1' });
  const o = await po.saveDraft(other, null, { supplier_id: String(s2), ...lines([null, 1, { name: 'Paper rolls' }]) });
  assert.equal((await po.markSent(other, o)).number, 1);
});

test('e-mail: bilingual, lists items and quantities, clinic contact and vendor link — no costs, no patient data', async () => {
  stubMail();
  sent.length = 0;
  await knex('patients').insert({ business_id: ctx.businessId, full_name: 'Zainab Secret-Patient', phone: '0791112233' });
  await knex('businesses').where({ id: ctx.businessId }).update({ address: 'Mecca St. 12', phone: '065550000' });
  businesses.forget(ctx.businessId);
  await knex('vendors').where({ id: vendor.id }).update({ email: 'orders@warehouse.test' });
  const id = await po.saveDraft(ctx, null, { supplier_id: String(vendorSupplierId), notes: 'Ring the bell', ...lines([syringes, 9, { unit_cost: '2.75' }], [null, 3, { name: 'Dental bibs', unit: 'box' }]) });
  const r = await po.send(ctx, id, { baseUrl: 'https://clinic.example' });
  assert.equal(r.emailed, true);
  assert.equal(r.portal, true);
  assert.equal(r.to, 'orders@warehouse.test', 'no supplier e-mail → the linked vendor e-mail');
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.to, 'orders@warehouse.test');
  assert.match(m.subject, new RegExp(`#${r.number}`));
  for (const s of ['Syringes 5 ml', 'Dental bibs', '>9<', '>3<', 'Purchasing Clinic', 'Mecca St. 12', '065550000', 'Ring the bell', 'Owner', `/vendor/orders/${id}`, 'dir="rtl"', 'Please confirm']) assert.ok(m.html.includes(s), `e-mail contains ${s}`);
  assert.ok(!m.html.includes('Zainab'), 'no patient data');
  assert.ok(!m.html.includes('2.75'), 'no costs');
  const d = await po.get(ctx, id);
  assert.equal(d.status, 'sent');
  assert.equal(d.sent_to_email, 'orders@warehouse.test');
  assert.equal(d.vendor_id, vendor.id);
  const text = po.orderText(d, await businesses.get(ctx.businessId), 'en');
  assert.match(text, /Syringes 5 ml \(pack\): 9/);
});

test('a failed e-mail puts the order back to draft', async () => {
  stubMail(true);
  const id = await po.saveDraft(ctx, null, { supplier_id: String(supplierId), ...lines([gloves, 4]) });
  await assert.rejects(po.send(ctx, id), { code: 'PO_MAIL_FAILED' });
  const d = await po.get(ctx, id);
  assert.equal(d.status, 'draft');
  assert.equal(d.sent_at, null);
  stubMail();
  const r = await po.send(ctx, id);
  assert.equal(r.number, d.po_number, 'the number claimed on the first attempt is kept');
});

test('receiving part of an order adds stock movements "PO #n"; the rest completes it', async () => {
  stubMail();
  const id = await po.saveDraft(ctx, null, { supplier_id: String(supplierId), ...lines([gloves, 10], [null, 2, { name: 'Dental bibs' }]) });
  const { number } = await po.send(ctx, id);
  const d = await po.get(ctx, id);
  const [gl, bibs] = d.lines;
  const stock0 = Number((await knex('supply_items').where({ id: gloves }).first()).current_stock);
  await assert.rejects(po.receive(ctx, id, { recv: { [`l${gl.id}`]: '11' } }), { code: 'VALIDATION_FAILED' }, 'more than ordered');
  await assert.rejects(po.receive(ctx, id, { recv: { [`l${gl.id}`]: '0' } }), { code: 'PO_NOTHING_RECEIVED' });
  let r = await po.receive(ctx, id, { recv: { [`l${gl.id}`]: '6', [`l${bibs.id}`]: '0' } });
  assert.equal(r.complete, false);
  let after = await po.get(ctx, id);
  assert.equal(after.status, 'sent');
  assert.equal(after.progress.partial, true);
  assert.equal(Number((await knex('supply_items').where({ id: gloves }).first()).current_stock), stock0 + 6);
  const mv = await knex('stock_movements').where({ item_id: gloves, type: 'in' }).orderBy('id', 'desc').first();
  assert.equal(mv.note, `PO #${number}`);
  assert.equal(Number(mv.quantity), 6);
  r = await po.receive(ctx, id, { recv: { [`l${gl.id}`]: '4', [`l${bibs.id}`]: '2' } });
  assert.equal(r.complete, true);
  after = await po.get(ctx, id);
  assert.equal(after.status, 'received');
  assert.ok(after.received_at);
  assert.equal(Number((await knex('supply_items').where({ id: gloves }).first()).current_stock), stock0 + 10);
  await assert.rejects(po.receive(ctx, id, { recv: { [`l${gl.id}`]: '1' } }), { code: 'PO_NOT_OPEN' });
  await assert.rejects(po.cancel(ctx, id), { code: 'PO_NOT_OPEN' });
  assert.ok(await knex('audit_logs').where({ action: 'purchase_order.received', entity_id: String(id) }).first());
});

test('the vendor sees only its own sent orders — never drafts, other suppliers or while pending', async () => {
  const draftId = await po.saveDraft(ctx, null, { supplier_id: String(vendorSupplierId), ...lines([syringes, 2]) });
  const { rows } = await po.vendorList(vendor, {}, { perPage: 100 });
  assert.ok(rows.length >= 7);
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes(draftId), 'drafts are invisible');
  const theirs = await knex('purchase_orders').whereIn('id', ids).select('vendor_id', 'status');
  assert.ok(theirs.every((r) => r.vendor_id === vendor.id && r.status !== 'draft'));
  await assert.rejects(po.vendorGet(vendor, draftId), { code: 'NOT_FOUND' });
  const foreign = await knex('purchase_orders').where({ supplier_id: supplierId }).whereNot('status', 'draft').first('id');
  await assert.rejects(po.vendorGet(vendor, foreign.id), { code: 'NOT_FOUND' });
  assert.equal((await po.vendorList(pendingVendor)).rows.length, 0);
  await assert.rejects(po.vendorGet({ ...vendor, status: 'pending' }, ids[0]), { code: 'NOT_FOUND' });
  const one = await po.vendorGet(vendor, ids[0]);
  assert.equal(one.clinic_name, 'Purchasing Clinic');
  assert.ok(one.lines.length);
  assert.ok(!('unit_cost' in one.lines[0]), 'costs are not exposed');
  assert.ok(!Object.keys(one).some((k) => /patient/.test(k)));
});

test('the vendor confirms an order (with a note) and the clinic is notified', async () => {
  const id = (await knex('purchase_orders').where({ vendor_id: vendor.id, status: 'sent' }).first('id')).id;
  await po.acknowledge(vendor, vctx, id, { note: 'Available, coming Tuesday' });
  const d = await po.get(ctx, id);
  assert.equal(d.status, 'acknowledged');
  assert.ok(d.acknowledged_at);
  assert.equal(d.vendor_note, 'Available, coming Tuesday');
  await assert.rejects(po.acknowledge(vendor, vctx, id, {}), { code: 'PO_NOT_SENT' });
  const n = await knex('notifications').where({ business_id: ctx.businessId, type: 'purchasing.acknowledged' }).orderBy('id', 'desc').first();
  assert.equal(n.permission, 'supplies.manage');
  assert.equal(n.link, `/app/supplies/orders/${id}`);
  await po.vendorNote(vendor, vctx, id, { note: 'Now Wednesday' });
  assert.equal((await po.get(ctx, id)).vendor_note, 'Now Wednesday');
  const log = await knex('audit_logs').where({ action: 'purchase_order.acknowledged', entity_id: String(id) }).first();
  assert.equal(log.business_id, ctx.businessId);
  assert.equal(log.user_id, vctx.userId);
  // An acknowledged order can still be received and cancelled by the clinic.
  await po.cancel(ctx, id);
  assert.equal((await po.get(ctx, id)).status, 'cancelled');
});

test('"order low-stock items" prepares one draft per supplier and skips items already ordered', async () => {
  const c = await clinic('owner3@purchasing.test', 'Low Stock Clinic');
  const sA = await supplies.saveSupplier(c, null, { name: 'Supplier A', email: 'a@s.test', is_active: '1' });
  const sB = await supplies.saveSupplier(c, null, { name: 'Supplier B', is_active: '1' });
  const a1 = await supplies.saveItem(c, null, { name: 'A1', supplier_id: String(sA), current_stock: '1', reorder_level: '5' });
  await supplies.saveItem(c, null, { name: 'A2', supplier_id: String(sA), current_stock: '2', reorder_level: '3' });
  await supplies.saveItem(c, null, { name: 'A3', supplier_id: String(sA), current_stock: '30', reorder_level: '3' });
  const b1 = await supplies.saveItem(c, null, { name: 'B1', supplier_id: String(sB), current_stock: '0', reorder_level: '2' });
  await supplies.saveItem(c, null, { name: 'Loose', current_stock: '0', reorder_level: '2' });
  // B1 is already on a sent order.
  const open = await po.saveDraft(c, null, { supplier_id: String(sB), ...lines([b1, 4]) });
  await po.markSent(c, open);
  const r = await po.draftLowStock(c);
  assert.equal(r.drafts.length, 1);
  assert.equal(r.noSupplier, 1);
  assert.equal(r.alreadyOrdered, 1);
  const d = await po.get(c, r.drafts[0]);
  assert.equal(d.supplier_id, sA);
  assert.deepEqual(d.lines.map((l) => [l.name, Number(l.quantity)]).sort(), [['A1', 9], ['A2', 4]]);
  // Running it again reuses the same draft instead of opening another.
  const again = await po.draftLowStock(c);
  assert.deepEqual(again.drafts, r.drafts);
  assert.equal((await po.get(c, r.drafts[0])).lines.length, 2);
  assert.equal(a1 > 0, true);
});

test('receiving records the supplier bill as an expense linked to the order; older orders can be expensed after', async () => {
  stubMail();
  const id = await po.saveDraft(ctx, null, { supplier_id: String(supplierId), ...lines([gloves, 10, { unit_cost: '2.5' }]) });
  const { number } = await po.send(ctx, id);
  const [gl] = (await po.get(ctx, id)).lines;
  const r1 = await po.receive(ctx, id, { recv: { [`l${gl.id}`]: '4' }, payment_method: 'bank_transfer', invoice_number: 'S-77' });
  assert.equal(r1.expense.amount, 10);
  const e1 = await knex('expenses').where({ id: r1.expense.id }).first();
  assert.equal(e1.category, 'medical_supplies');
  assert.equal(e1.purchase_order_id, id);
  assert.equal(e1.payment_method, 'bank_transfer');
  assert.equal(e1.invoice_number, 'S-77');
  assert.match(e1.title, new RegExp(`#${number}`));
  const r2 = await po.receive(ctx, id, { recv: { [`l${gl.id}`]: '6' }, expense_amount: '16' }); // the bill differs from the order prices
  assert.equal(r2.expense.amount, 16);
  let st = await po.expenseState(ctx, id);
  assert.deepEqual([st.received, st.expensed, st.open, st.rows.length], [25, 26, 0, 2]);
  // Received without an expense (turned off) → recorded afterwards from the order page.
  const id2 = await po.saveDraft(ctx, null, { supplier_id: String(supplierId), ...lines([gloves, 3, { unit_cost: '4' }]) });
  await po.send(ctx, id2);
  const [g2] = (await po.get(ctx, id2)).lines;
  const r3 = await po.receive(ctx, id2, { recv: { [`l${g2.id}`]: '3' }, record_expense: '0' });
  assert.equal(r3.expense, null);
  st = await po.expenseState(ctx, id2);
  assert.equal(st.open, 12);
  await assert.rejects(po.recordExpense(ctx, id2, { amount: '' }), { code: 'VALIDATION_FAILED' });
  await po.recordExpense(ctx, id2, { amount: String(st.open), payment_method: 'cash' });
  assert.equal((await po.expenseState(ctx, id2)).open, 0);
  // Without permission to add expenses, receiving does not create one.
  const noExp = { ...ctx, permissions: new Set([...ctx.permissions].filter((p) => p !== 'expenses.manage')) };
  const id3 = await po.saveDraft(ctx, null, { supplier_id: String(supplierId), ...lines([gloves, 1, { unit_cost: '9' }]) });
  await po.send(ctx, id3);
  const [g3] = (await po.get(ctx, id3)).lines;
  assert.equal((await po.receive(noExp, id3, { recv: { [`l${g3.id}`]: '1' } })).expense, null);
});
