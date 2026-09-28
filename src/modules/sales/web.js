const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const exporter = require('../../core/exporter');
const charts = require('../../core/charts');
const fmt = require('../../core/format');
const knex = require('../../db/knex');
const engine = require('../finance/engine');
const fin = require('../finance/finance.data');
const svc = require('./sales.service');

const router = express.Router();
router.use(can('sales.view'));

router.get('/', wrap(async (req, res) => {
  const { rows, totals, meta } = await svc.orders.list(req.ctx, req.query);
  const reps = await knex('employees').where({ business_id: req.ctx.businessId }).orderBy('name').select('id', 'name');
  const d = await fin.load(req.ctx.businessId);
  const series = fin.monthSeries(d, 12).map((s) => ({ label: fmt.formatMonth(s.month, req.locale), short: fmt.formatDate(`${s.month}-01`, req.locale, { month: 'short' }), value: s.totalRevenue }));
  const chart = charts.line({ points: series, title: req.t('sales.revenue_trend'), fmt: (v) => fmt.formatCompact(v, req.business.currency, req.locale), height: 180, width: 720 });
  const repName = Object.fromEntries(reps.map((r) => [r.id, r.name]));
  const shipped = new Set((await knex('deliveries').where({ business_id: req.ctx.businessId }).whereNotNull('order_id').select('order_id', 'status')).map((s) => s.order_id));
  res.page('pages/sales/index', {
    title: req.t('nav.sales'), rows, totals, meta, reps, repName, chart, hasChart: series.some((s) => s.value), shipped,
    statuses: svc.PAYMENT_STATUSES, filtered: ['q', 'payment', 'rep', 'from', 'to', 'channel'].some((k) => req.query[k] && req.query[k] !== 'all'), showProfit: req.ctx.permissions.has('profits.view'),
  });
}));

router.get('/export', can('data.export'), wrap(async (req, res) => {
  const { rows } = await svc.orders.list(req.ctx, req.query, { all: true });
  const reps = Object.fromEntries((await knex('employees').where({ business_id: req.ctx.businessId }).select('id', 'name')).map((r) => [r.id, r.name]));
  const t = req.t; const lbl = res.locals.label;
  const profit = req.ctx.permissions.has('profits.view');
  exporter.send(req, res, {
    name: t('nav.sales'),
    header: [t('sales.order_number'), t('common.date'), t('sales.customer'), t('common.phone'), t('sales.items'), t('sales.subtotal'), t('sales.discount'), t('sales.delivery_fee'), t('sales.total'), ...(profit ? [t('kpi.cogs'), t('sales.gross_margin')] : []), t('sales.rep'), t('sales.commission'), t('sales.payment_status'), t('sales.courier'), t('sales.delivery_cost')],
    rows: rows.map((r) => [r.order_number, r.date, r.customer_name, r.customer_phone || '', (r.items || []).map((i) => `${i.itemName} ×${i.quantity}`).join('; '), Number(r.subtotal), Number(r.discount), Number(r.delivery_fee), Number(r.total_amount),
      ...(profit ? [Number(r.total_cogs), Number(r.total_amount) - Number(r.total_cogs)] : []), reps[r.employee_id] || '', Number(r.commission_earned), lbl('sales.payment_statuses', r.payment_status), r.delivery_courier || '', Number(r.delivery_cost)]),
  });
}));

const renderForm = async (req, res, extra = {}) => {
  const order = req.params.id ? await svc.orders.get(req.ctx, Number(req.params.id)) : null;
  const fd = await svc.formData(req.ctx);
  let prefill = null;
  if (!order && req.query.customer) prefill = fd.custs.find((c) => String(c.id) === String(req.query.customer)) || null;
  res.page('pages/sales/form', { title: order ? req.t('sales.edit') : req.t('sales.new'), order, prefill, ...fd, statuses: svc.PAYMENT_STATUSES, channels: svc.CHANNELS, ...extra });
};
router.get('/new', can('sales.manage'), wrap((req, res) => renderForm(req, res)));
router.post('/new', can('sales.manage'), form(async (req, res) => {
  const id = await svc.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('sales.saved'));
  res.redirect(`/app/sales/${id}`);
}, renderForm));
router.get('/:id(\\d+)/edit', can('sales.manage'), wrap((req, res) => renderForm(req, res)));
router.post('/:id(\\d+)/edit', can('sales.manage'), form(async (req, res) => {
  await svc.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(`/app/sales/${req.params.id}`);
}, renderForm));

router.get('/:id(\\d+)', wrap(async (req, res) => {
  const order = await svc.orders.get(req.ctx, Number(req.params.id));
  const [rep, shipments, customer] = await Promise.all([
    order.employee_id ? knex('employees').where({ id: order.employee_id, business_id: req.ctx.businessId }).first('id', 'name') : null,
    knex('deliveries').where({ business_id: req.ctx.businessId, order_id: order.id }).orderBy('id', 'desc'),
    order.customer_id ? knex('customers').where({ id: order.customer_id, business_id: req.ctx.businessId }).first() : null,
  ]);
  res.page('pages/sales/show', { title: `${req.t('sales.order')} ${order.order_number}`, order, rep, shipments, customer, statuses: svc.PAYMENT_STATUSES, printable: true, showProfit: req.ctx.permissions.has('profits.view') });
}));
router.post('/:id(\\d+)/status', can('sales.manage'), wrap(async (req, res) => {
  await svc.setPaymentStatus(req.ctx, Number(req.params.id), req.body.payment_status);
  flash(req, 'success', req.t('sales.status_updated'));
  res.redirect(`/app/sales/${req.params.id}`);
}));
router.post('/:id(\\d+)/delete', can('sales.manage'), wrap(async (req, res) => {
  await svc.removeOrder(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('sales.deleted'));
  res.redirect('/app/sales');
}));

module.exports = router;
