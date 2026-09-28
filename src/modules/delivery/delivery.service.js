// Delivery & logistics: shipments, courier fees paid vs delivery fees collected, COD cash remittance.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { repo } = require('../../core/crud');
const { z, validate, money, isoDate, optionalString, emptyToUndefined } = require('../../core/validate');
const { E } = require('../../core/errors');

const STATUSES = ['pending', 'out_for_delivery', 'delivered', 'returned', 'cancelled'];

const deliveries = repo({
  table: 'deliveries', entity: 'delivery', searchable: ['tracking_number', 'customer_name', 'customer_phone', 'courier_company', 'courier_name', 'destination_city'], dateColumn: 'date',
  filters: {
    status: (q, v) => (v === 'open' ? q.whereIn('deliveries.status', ['pending', 'out_for_delivery']) : q.where('deliveries.status', v)),
    courier: 'courier_company',
    remitted: (q, v) => q.where('deliveries.cash_remitted', v === 'yes' ? 1 : 0),
  },
  sortable: { date: 'date', status: 'status' }, defaultSort: ['date', 'desc'], sums: ['delivery_fee_paid', 'delivery_fee_collected'],
});

const schema = z.object({
  date: isoDate(),
  order_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  courier_company: optionalString(160),
  courier_name: optionalString(160),
  courier_phone: optionalString(40),
  tracking_number: optionalString(100),
  customer_name: z.string().trim().min(1, 'Required.').max(160),
  customer_phone: optionalString(40),
  destination_city: optionalString(100),
  address: optionalString(500),
  delivery_fee_paid: money(),
  delivery_fee_collected: money(),
  status: z.enum(STATUSES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  notes: optionalString(5000),
});

async function save(ctx, id, input) {
  const d = validate(schema, input);
  if (d.order_id) {
    const o = await knex('orders').where({ id: d.order_id, business_id: ctx.businessId }).first('id');
    if (!o) throw E.validation({ order_id: 'Choose a valid value.' });
  }
  const row = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === undefined ? null : v]));
  if (id) { await deliveries.update(ctx, id, row); return id; }
  return deliveries.create(ctx, row);
}

async function setStatus(ctx, id, status) {
  if (!STATUSES.includes(status)) throw E.validation({ status: 'Choose a valid value.' });
  await deliveries.update(ctx, id, { status });
}

/** Marks cash collected by the courier as handed over to the business (cash on delivery). */
async function setRemitted(ctx, id, remitted) {
  const s = await deliveries.get(ctx, id);
  await knex('deliveries').where({ id: s.id }).update({ cash_remitted: remitted ? 1 : 0, cash_remitted_at: remitted ? new Date() : null, updated_at: new Date() });
  await audit.record(ctx, remitted ? 'delivery.cash_remitted' : 'delivery.cash_unremitted', { entityType: 'delivery', entityId: s.id });
}

/** Per-courier performance: shipments, delivered/returned rates, fees paid vs collected. */
async function couriers(ctx, params = {}) {
  const q = deliveries.applyFilters(deliveries.scoped(ctx), ctx, { ...params, courier: undefined, status: undefined });
  const rows = await q.groupBy('courier_company').select(knex.raw('COALESCE(NULLIF(courier_company, \'\'), \'—\') as courier'), knex.raw('COUNT(*) as shipments'),
    knex.raw("SUM(status = 'delivered') as delivered"), knex.raw("SUM(status = 'returned') as returned"), knex.raw("SUM(status IN ('pending','out_for_delivery')) as open"),
    knex.raw('SUM(delivery_fee_paid) as paid'), knex.raw('SUM(delivery_fee_collected) as collected')).orderBy('shipments', 'desc');
  return rows.map((r) => ({ ...r, shipments: Number(r.shipments), delivered: Number(r.delivered), returned: Number(r.returned), open: Number(r.open), paid: Number(r.paid), collected: Number(r.collected) }));
}

async function statusCounts(ctx) {
  const rows = await knex('deliveries').where({ business_id: ctx.businessId }).groupBy('status').select('status').count({ n: '*' });
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

module.exports = { deliveries, save, setStatus, setRemitted, couriers, statusCounts, STATUSES };
