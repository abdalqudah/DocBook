const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const exporter = require('../../core/exporter');
const knex = require('../../db/knex');
const svc = require('./delivery.service');

const router = express.Router();
router.use(can('delivery.view'));

async function render(req, res, extra = {}) {
  const [{ rows, totals, meta }, counts, couriers] = await Promise.all([svc.deliveries.list(req.ctx, req.query), svc.statusCounts(req.ctx), svc.couriers(req.ctx, req.query)]);
  const orders = await knex('orders').where({ business_id: req.ctx.businessId }).orderBy('id', 'desc').limit(300).select('id', 'order_number', 'customer_name', 'customer_phone', 'delivery_fee', 'delivery_cost', 'delivery_courier');
  const orderById = Object.fromEntries(orders.map((o) => [o.id, o]));
  // Prefill from ?order= (e.g. "Add shipment" on an order page).
  let prefill = null;
  if (req.query.order && orderById[Number(req.query.order)]) {
    const o = orderById[Number(req.query.order)];
    prefill = { order_id: o.id, customer_name: o.customer_name, customer_phone: o.customer_phone, delivery_fee_collected: o.delivery_fee, delivery_fee_paid: o.delivery_cost, courier_company: o.delivery_courier, status: 'pending' };
  }
  const unremitted = await knex('deliveries').where({ business_id: req.ctx.businessId, status: 'delivered', cash_remitted: 0 }).sum({ s: 'delivery_fee_collected' }).count({ n: '*' }).first();
  res.page('pages/delivery/index', {
    title: req.t('nav.delivery'), rows, totals, meta, counts, couriers, orders, orderById, prefill, statuses: svc.STATUSES,
    unremitted: { amount: Number(unremitted.s) || 0, count: Number(unremitted.n) || 0 },
    filtered: ['q', 'status', 'courier', 'from', 'to', 'remitted'].some((k) => req.query[k] && req.query[k] !== 'all'), ...extra,
  });
}

router.get('/', wrap((req, res) => render(req, res)));
router.get('/export', can('data.export'), wrap(async (req, res) => {
  const { rows } = await svc.deliveries.list(req.ctx, req.query, { all: true });
  const t = req.t; const lbl = res.locals.label;
  exporter.send(req, res, {
    name: t('nav.delivery'),
    header: [t('common.date'), t('delivery.tracking'), t('delivery.courier_company'), t('delivery.courier_name'), t('delivery.recipient'), t('common.phone'), t('delivery.city'), t('delivery.fee_paid'), t('delivery.fee_collected'), t('delivery.net'), t('common.status'), t('delivery.remitted')],
    rows: rows.map((r) => [r.date, r.tracking_number || '', r.courier_company || '', r.courier_name || '', r.customer_name, r.customer_phone || '', r.destination_city || '', Number(r.delivery_fee_paid), Number(r.delivery_fee_collected), Number(r.delivery_fee_collected) - Number(r.delivery_fee_paid), lbl('delivery.statuses', r.status), r.cash_remitted ? t('common.yes') : t('common.no')]),
  });
}));
const rerender = (req, res, extra) => render(req, res, { ...extra, openDialog: 'delivery-dialog', formAction: req.originalUrl });
router.post('/', can('delivery.manage'), form(async (req, res) => {
  await svc.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('delivery.saved'));
  res.redirect(req.body._return && !req.body._return.includes('new=1') ? req.body._return : '/app/delivery');
}, rerender));
router.post('/:id(\\d+)', can('delivery.manage'), form(async (req, res) => {
  await svc.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(req.body._return || '/app/delivery');
}, rerender));
router.post('/:id(\\d+)/status', can('delivery.manage'), wrap(async (req, res) => {
  await svc.setStatus(req.ctx, Number(req.params.id), req.body.status);
  flash(req, 'success', req.t('delivery.status_updated'));
  res.redirect(req.body._return || '/app/delivery');
}));
router.post('/:id(\\d+)/remit', can('delivery.manage'), wrap(async (req, res) => {
  await svc.setRemitted(req.ctx, Number(req.params.id), req.body.remitted === '1');
  flash(req, 'success', req.t('delivery.remit_updated'));
  res.redirect(req.body._return || '/app/delivery');
}));
router.post('/:id(\\d+)/delete', can('delivery.manage'), wrap(async (req, res) => {
  await svc.deliveries.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(req.body._return || '/app/delivery');
}));

module.exports = router;
