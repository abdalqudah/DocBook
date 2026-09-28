// Sales orders & customers (CRM).
// Totals and the rep's commission are computed on the server with DocBook's rules (engine.orderTotals /
// engine.orderCommission), so a tampered form can never change the numbers.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { repo } = require('../../core/crud');
const { z, validate, money, isoDate, optionalString, emptyToUndefined } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const engine = require('../finance/engine');
const fin = require('../finance/finance.data');
const businesses = require('../businesses/business.service');

const PAYMENT_STATUSES = ['paid', 'cash_on_delivery', 'pending', 'refunded'];
const CHANNELS = ['manual', 'phone', 'social', 'website', 'store', 'marketplace', 'import'];

const orders = repo({
  table: 'orders', entity: 'order', searchable: ['order_number', 'customer_name', 'customer_phone', 'customer_email', 'notes'], dateColumn: 'date',
  filters: { payment: 'payment_status', rep: 'employee_id', channel: 'channel', customer: 'customer_id' },
  sortable: { date: 'date', total: 'total_amount', number: 'order_number' }, defaultSort: ['date', 'desc'], sums: ['total_amount', 'total_cogs', 'commission_earned', 'discount'],
});

const customers = repo({
  table: 'customers', entity: 'customer', searchable: ['name', 'phone', 'email', 'city', 'region', 'group_name'], filters: { region: 'region', group: 'group_name', city: 'city' },
  sortable: { name: 'name', created: 'created_at' }, defaultSort: ['name', 'asc'],
});

// ---------------------------------------------------------------- customers
const customerSchema = z.object({
  name: z.string().trim().min(1, 'Required.').max(160),
  phone: optionalString(40),
  email: z.preprocess(emptyToUndefined, z.string().trim().email('Enter a valid email address.').max(190).optional()),
  address: optionalString(500),
  city: optionalString(100),
  region: optionalString(100),
  group_name: optionalString(100),
  category: optionalString(100),
  notes: optionalString(5000),
});

async function saveCustomer(ctx, id, input, trx = knex) {
  const d = validate(customerSchema, input);
  const row = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === undefined ? null : v]));
  if (id) { await customers.update(ctx, id, row, trx); return id; }
  return customers.create(ctx, row, trx);
}

/** Customers with their order stats (computed from orders, never stored twice). */
async function customerStats(ctx, ids) {
  const q = knex('orders').where({ business_id: ctx.businessId }).whereNotNull('customer_id').whereNot('payment_status', 'refunded')
    .groupBy('customer_id').select('customer_id', knex.raw('COUNT(*) as orders'), knex.raw('SUM(total_amount) as spent'), knex.raw('MAX(date) as last_order'));
  if (ids) q.whereIn('customer_id', ids);
  const rows = await q;
  return Object.fromEntries(rows.map((r) => [r.customer_id, { orders: Number(r.orders), spent: Number(r.spent), lastOrder: r.last_order }]));
}

async function removeCustomer(ctx, id) {
  return knex.transaction(async (trx) => {
    await customers.remove(ctx, id, trx);
    await trx('orders').where({ business_id: ctx.businessId, customer_id: id }).update({ customer_id: null }); // orders keep the name/phone
  });
}

// ---------------------------------------------------------------- orders
const itemSchema = z.object({
  itemName: z.string().trim().min(1, 'Required.').max(190),
  sku: optionalString(100),
  quantity: money().refine((v) => v > 0, 'Must be zero or more.'),
  unitPrice: money(),
  unitCost: money(),
});

const orderSchema = z.object({
  date: isoDate(),
  order_number: optionalString(60),
  customer_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  customer_name: z.string().trim().min(1, 'Required.').max(160),
  customer_phone: optionalString(40),
  customer_email: z.preprocess(emptyToUndefined, z.string().trim().email('Enter a valid email address.').max(190).optional()),
  items: z.array(itemSchema).min(1, 'Add at least one item.'),
  discount: money(),
  delivery_fee: money(),
  employee_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  delivery_courier: optionalString(160),
  delivery_cost: money(),
  payment_status: z.enum(PAYMENT_STATUSES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  channel: z.preprocess(emptyToUndefined, z.enum(CHANNELS).optional()),
  notes: optionalString(5000),
  save_customer: z.any().optional(),
  create_shipment: z.any().optional(),
});

/** Normalises items[] posted either as an array or as items[0][field] objects; drops empty lines. */
function collectItems(input) {
  const raw = Array.isArray(input.items) ? input.items : Object.values(input.items || {});
  return raw.filter((it) => it && String(it.itemName || '').trim() !== '');
}

async function save(ctx, id, input) {
  const d = validate(orderSchema, { ...input, items: collectItems(input) });
  return knex.transaction(async (trx) => {
    // Customer: explicit pick, else match by phone, else create (unless the user opted out).
    let customerId = d.customer_id || null;
    let region = null;
    if (customerId) {
      const c = await trx('customers').where({ id: customerId, business_id: ctx.businessId }).first();
      if (!c) throw E.validation({ customer_id: 'Choose a valid value.' });
      region = c.region;
    } else if (d.customer_phone) {
      const c = await trx('customers').where({ business_id: ctx.businessId, phone: d.customer_phone }).first();
      if (c) { customerId = c.id; region = c.region; }
    }
    if (!customerId && d.save_customer) {
      customerId = await saveCustomer(ctx, null, { name: d.customer_name, phone: d.customer_phone, email: d.customer_email }, trx);
    }

    const items = d.items.map((it) => ({ itemName: it.itemName, sku: it.sku || '', quantity: it.quantity, unitPrice: it.unitPrice, unitCost: it.unitCost }));
    const totals = engine.orderTotals(items, d.discount, d.delivery_fee);
    let commission = 0;
    if (d.employee_id) {
      const rep = await trx('employees').where({ id: d.employee_id, business_id: ctx.businessId }).first();
      if (!rep) throw E.validation({ employee_id: 'Choose a valid value.' });
      commission = engine.orderCommission(fin.mapEmployee(rep), totals.totalAmount, region);
    }
    const row = {
      date: d.date, customer_id: customerId, customer_name: d.customer_name, customer_phone: d.customer_phone || null, customer_email: d.customer_email || null,
      items: JSON.stringify(items), subtotal: totals.subtotal, discount: d.discount, delivery_fee: d.delivery_fee, total_amount: totals.totalAmount, total_cogs: totals.totalCogs,
      employee_id: d.employee_id || null, commission_earned: Math.round(commission * 1000) / 1000, delivery_courier: d.delivery_courier || null, delivery_cost: d.delivery_cost,
      payment_status: d.payment_status, channel: d.channel || 'manual', notes: d.notes || null,
    };
    let orderId = id;
    if (id) {
      if (d.order_number) {
        const clash = await trx('orders').where({ business_id: ctx.businessId, order_number: d.order_number }).whereNot({ id }).first();
        if (clash) throw new AppError('ORDER_NUMBER_TAKEN', 'This order number is already used.', 409);
        row.order_number = d.order_number;
      }
      await orders.update(ctx, id, row, trx);
    } else {
      let number = d.order_number;
      if (number) {
        const clash = await trx('orders').where({ business_id: ctx.businessId, order_number: number }).first();
        if (clash) throw new AppError('ORDER_NUMBER_TAKEN', 'This order number is already used.', 409);
      } else number = await businesses.claimInvoiceNumber(ctx.businessId, trx);
      orderId = await orders.create(ctx, { ...row, order_number: number }, trx);
      if (d.create_shipment) {
        const [shipId] = await trx('deliveries').insert({
          business_id: ctx.businessId, order_id: orderId, courier_company: d.delivery_courier || null, customer_name: d.customer_name, customer_phone: d.customer_phone || null,
          delivery_fee_paid: d.delivery_cost, delivery_fee_collected: d.delivery_fee, status: 'pending', date: d.date,
        });
        await audit.record(ctx, 'delivery.created', { entityType: 'delivery', entityId: shipId, newValues: { order_id: orderId } }, trx);
      }
    }
    return orderId;
  });
}

async function setPaymentStatus(ctx, id, status) {
  if (!PAYMENT_STATUSES.includes(status)) throw E.validation({ payment_status: 'Choose a valid value.' });
  await orders.update(ctx, id, { payment_status: status });
}

async function removeOrder(ctx, id) {
  return knex.transaction(async (trx) => {
    await orders.remove(ctx, id, trx);
    await trx('deliveries').where({ business_id: ctx.businessId, order_id: id }).update({ order_id: null }); // shipments keep their own costs
  });
}

async function formData(ctx) {
  const [reps, custs, business] = await Promise.all([
    knex('employees').where({ business_id: ctx.businessId }).whereNot('status', 'inactive').orderBy('name'),
    knex('customers').where({ business_id: ctx.businessId }).orderBy('name').limit(2000),
    businesses.get(ctx.businessId),
  ]);
  const couriers = (await knex('deliveries').where({ business_id: ctx.businessId }).whereNotNull('courier_company').whereNot('courier_company', '').distinct('courier_company').limit(50)).map((r) => r.courier_company);
  return { reps, custs, business, couriers };
}

module.exports = { orders, customers, saveCustomer, customerStats, removeCustomer, save, setPaymentStatus, removeOrder, formData, collectItems, PAYMENT_STATUSES, CHANNELS };
