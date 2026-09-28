// Purchases / inventory — supplier invoices feeding cost of goods and payables.
// DocBook: total_cost = unit × qty (shipping kept separate); commitment = total + shipping; payable = commitment − paid.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { repo } = require('../../core/crud');
const { z, validate, money, isoDate, optionalString } = require('../../core/validate');
const engine = require('../finance/engine');

const STATUSES = ['paid', 'partial', 'due'];

const purchases = repo({
  table: 'purchases', entity: 'purchase', searchable: ['supplier_name', 'item_name', 'sku', 'invoice_ref', 'category'], dateColumn: 'date',
  filters: { status: 'payment_status', supplier: 'supplier_name', category: 'category' },
  sortable: { date: 'date', total: 'total_cost', supplier: 'supplier_name' }, defaultSort: ['date', 'desc'], sums: ['total_cost', 'shipping_cost', 'paid_amount'],
});

const schema = z.object({
  date: isoDate(),
  supplier_name: z.string().trim().min(1, 'Required.').max(160),
  supplier_phone: optionalString(40),
  item_name: z.string().trim().min(1, 'Required.').max(190),
  sku: optionalString(100),
  category: optionalString(100),
  unit_cost: money(),
  quantity: money(),
  shipping_cost: money(),
  paid_amount: money(),
  invoice_ref: optionalString(100),
  notes: optionalString(5000),
});

async function save(ctx, id, input) {
  const d = validate(schema, input);
  const t = engine.purchaseTotals({ unitCost: d.unit_cost, quantity: d.quantity, shippingCost: d.shipping_cost, paidAmount: d.paid_amount });
  const row = { ...d, supplier_phone: d.supplier_phone || null, sku: d.sku || null, category: d.category || null, invoice_ref: d.invoice_ref || null, notes: d.notes || null,
    total_cost: Math.round(t.totalCost * 1000) / 1000, payment_status: t.paymentStatus };
  if (id) { await purchases.update(ctx, id, row); return id; }
  return purchases.create(ctx, row);
}

/** Records a supplier payment against a purchase (adds to paid_amount and re-derives the status). */
async function pay(ctx, id, amount) {
  const d = validate(z.object({ amount: money().refine((v) => v > 0, 'Must be zero or more.') }), { amount });
  return knex.transaction(async (trx) => {
    const p = await purchases.get(ctx, id, trx);
    const paid = Math.min(Number(p.paid_amount) + d.amount, Number(p.total_cost) + Number(p.shipping_cost));
    const t = engine.purchaseTotals({ unitCost: p.unit_cost, quantity: p.quantity, shippingCost: p.shipping_cost, paidAmount: paid });
    await trx('purchases').where({ id: p.id }).update({ paid_amount: paid, payment_status: t.paymentStatus, updated_at: new Date() });
    await audit.record(ctx, 'purchase.payment', { entityType: 'purchase', entityId: p.id, oldValues: { paid_amount: Number(p.paid_amount) }, newValues: { paid_amount: paid } }, trx);
  });
}

/** Supplier summary: invoices, committed, paid, outstanding. */
async function suppliers(ctx) {
  const rows = await knex('purchases').where({ business_id: ctx.businessId }).groupBy('supplier_name')
    .select('supplier_name', knex.raw('MAX(supplier_phone) as phone'), knex.raw('COUNT(*) as invoices'), knex.raw('SUM(total_cost + shipping_cost) as committed'), knex.raw('SUM(paid_amount) as paid'), knex.raw('MAX(date) as last_date'))
    .orderBy('committed', 'desc');
  return rows.map((r) => ({ ...r, committed: Number(r.committed), paid: Number(r.paid), due: Math.max(0, Number(r.committed) - Number(r.paid)) }));
}

/** Stock items: purchased quantities and weighted average unit cost per item (by SKU, else by name). */
async function items(ctx) {
  const rows = await knex('purchases').where({ business_id: ctx.businessId })
    .select(knex.raw('COALESCE(NULLIF(sku, \'\'), item_name) as item_key'), knex.raw('MAX(item_name) as item_name'), knex.raw('MAX(sku) as sku'), knex.raw('MAX(category) as category'),
      knex.raw('SUM(quantity) as qty'), knex.raw('SUM(total_cost) as cost'), knex.raw('SUM(shipping_cost) as shipping'), knex.raw('MAX(date) as last_date'))
    .groupBy('item_key').orderBy('cost', 'desc');
  // Units sold, matched from order lines by SKU or item name.
  const orders = await knex('orders').where({ business_id: ctx.businessId }).select('items');
  const sold = {};
  for (const o of orders) {
    const list = Array.isArray(o.items) ? o.items : [];
    for (const it of list) { const k = (it.sku || it.itemName || '').trim().toLowerCase(); if (k) sold[k] = (sold[k] || 0) + (Number(it.quantity) || 0); }
  }
  return rows.map((r) => {
    const qty = Number(r.qty); const cost = Number(r.cost) + Number(r.shipping);
    const soldQty = sold[String(r.sku || r.item_name).toLowerCase()] || sold[String(r.item_name).toLowerCase()] || 0;
    return { ...r, qty, landedCost: cost, avgUnitCost: qty > 0 ? cost / qty : 0, sold: soldQty, onHand: qty - soldQty };
  });
}

module.exports = { purchases, save, pay, suppliers, items, STATUSES };
