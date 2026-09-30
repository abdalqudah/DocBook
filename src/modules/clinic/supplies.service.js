// Clinic supplies — DocBook's supplies.ts: suppliers, items with stock and reorder level. When an item falls to its
// reorder level, a low-stock alert is raised once (and the supplier is e-mailed when e-mail is configured); the
// flag clears when stock goes back above the level. Every stock change is kept as a movement.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const { repo } = require('../../core/crud');
const { z, validate, money, optionalString, emptyToUndefined } = require('../../core/validate');
const { E } = require('../../core/errors');
const notifications = require('../notifications/notification.service');
const businesses = require('../businesses/business.service');

const suppliers = repo({ table: 'suppliers', entity: 'supplier', searchable: ['name', 'email', 'phone'], defaultSort: ['name', 'asc'] });
const items = repo({ table: 'supply_items', entity: 'supply_item', searchable: ['name', 'unit'], filters: { supplier: 'supplier_id', low: (q, v) => v === 'yes' && q.whereRaw('supply_items.current_stock <= supply_items.reorder_level') }, defaultSort: ['name', 'asc'] });

const bool = () => z.preprocess((v) => v === '1' || v === 'on' || v === true, z.boolean());
const qty = () => z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(String(v).replace(/,/g, ''))), z.number({ invalid_type_error: 'Enter a number.' }).min(0, 'Must be zero or more.').max(1e9, 'Too large.'));

async function saveSupplier(ctx, id, input) {
  const d = validate(z.object({ name: z.string().trim().min(1, 'Required.').max(190), email: z.preprocess(emptyToUndefined, z.string().trim().email('Enter a valid email address.').optional()), phone: optionalString(40), notes: optionalString(3000), is_active: bool() }), input);
  const row = { ...d, email: d.email || null, phone: d.phone || null, notes: d.notes || null };
  if (id) { await suppliers.update(ctx, id, row); return id; }
  return suppliers.create(ctx, row);
}

async function lowStockCheck(ctx, itemId, trx = knex) {
  const it = await trx('supply_items as i').leftJoin('suppliers as s', 's.id', 'i.supplier_id').where({ 'i.id': itemId, 'i.business_id': ctx.businessId }).first('i.*', 's.name as supplier_name', 's.email as supplier_email');
  const low = Number(it.current_stock) <= Number(it.reorder_level);
  if (low && !it.last_reorder_requested_at) {
    await trx('supply_items').where({ id: it.id }).update({ last_reorder_requested_at: new Date() });
    await notifications.notify(ctx.businessId, { permission: 'supplies.view', type: 'supplies.low_stock', severity: 'warning', dedupeKey: `low:${it.id}:${Date.now()}`, title: `${it.name}: ${Number(it.current_stock)} ${it.unit || ''}`.trim(), body: `≤ ${Number(it.reorder_level)}`, link: '/app/supplies?low=yes' }, trx);
    if (it.supplier_email) {
      const clinic = await businesses.get(ctx.businessId);
      mailer.send({ businessId: ctx.businessId, kind: 'suppliers', to: it.supplier_email, subject: `Restock request — ${it.name} — ${clinic.name}`,
        html: mailer.layout({ locale: 'ar', title: `طلب إعادة تعبئة — ${it.name}`, body: `${it.supplier_name || ''}: وصل مخزون ${it.name} في ${clinic.name} إلى ${Number(it.current_stock)} ${it.unit || ''} (حد إعادة الطلب ${Number(it.reorder_level)}). سيصلكم أمر شراء بالكميات المطلوبة قريبًا. / Stock of ${it.name} reached ${Number(it.current_stock)} ${it.unit || ''} (reorder level ${Number(it.reorder_level)}). A purchase order with the quantities will follow.` }) }).catch(() => {});
    }
  } else if (!low && it.last_reorder_requested_at) {
    await trx('supply_items').where({ id: it.id }).update({ last_reorder_requested_at: null });
  }
}

async function saveItem(ctx, id, input) {
  const d = validate(z.object({ name: z.string().trim().min(1, 'Required.').max(190), unit: optionalString(40), supplier_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()), reorder_level: qty(), unit_cost: money(), current_stock: qty() }), input);
  if (d.supplier_id) await suppliers.get(ctx, d.supplier_id);
  return knex.transaction(async (trx) => {
    let itemId = id;
    const row = { name: d.name, unit: d.unit || null, supplier_id: d.supplier_id || null, reorder_level: d.reorder_level, unit_cost: d.unit_cost };
    if (id) {
      const before = await items.get(ctx, id, trx);
      await items.update(ctx, id, row, trx);
      if (Number(before.current_stock) !== d.current_stock) await move(ctx, id, { type: 'adjust', quantity: d.current_stock, note: 'edit' }, trx);
    } else {
      itemId = await items.create(ctx, { ...row, current_stock: d.current_stock }, trx);
      await trx('stock_movements').insert({ business_id: ctx.businessId, item_id: itemId, type: 'adjust', quantity: d.current_stock, stock_after: d.current_stock, note: 'opening', created_by: ctx.userId });
    }
    await lowStockCheck(ctx, itemId, trx);
    return itemId;
  });
}

/** Stock in (delivery), out (used) or adjust (count). */
async function move(ctx, itemId, input, outer = null) {
  const d = validate(z.object({ type: z.enum(['in', 'out', 'adjust'], { errorMap: () => ({ message: 'Choose a valid value.' }) }), quantity: qty(), note: optionalString(255) }), input);
  const run = async (trx) => {
    const it = await trx('supply_items').where({ id: itemId, business_id: ctx.businessId }).forUpdate().first();
    if (!it) throw E.notFound('Item');
    const current = Number(it.current_stock);
    const after = d.type === 'in' ? current + d.quantity : d.type === 'out' ? current - d.quantity : d.quantity;
    if (after < 0) throw E.validation({ quantity: 'Too large.' });
    await trx('supply_items').where({ id: it.id }).update({ current_stock: after, updated_at: new Date() });
    await trx('stock_movements').insert({ business_id: ctx.businessId, item_id: it.id, type: d.type, quantity: d.quantity, stock_after: after, note: d.note || null, created_by: ctx.userId });
    await audit.record(ctx, `supply.stock_${d.type}`, { entityType: 'supply_item', entityId: it.id, oldValues: { stock: current }, newValues: { stock: after } }, trx);
    await lowStockCheck(ctx, it.id, trx);
  };
  return outer ? run(outer) : knex.transaction(run);
}

const movements = (ctx, itemId) => knex('stock_movements as m').leftJoin('users as u', 'u.id', 'm.created_by').where({ 'm.business_id': ctx.businessId, 'm.item_id': itemId }).orderBy('m.id', 'desc').limit(50).select('m.*', 'u.name as by_name');

module.exports = { suppliers, items, saveSupplier, saveItem, move, movements };
