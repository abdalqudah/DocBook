const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const exporter = require('../../core/exporter');
const knex = require('../../db/knex');
const svc = require('./sales.service');

const router = express.Router();
router.use(can('customers.view'));

async function render(req, res, extra = {}) {
  const { rows, meta } = await svc.customers.list(req.ctx, req.query);
  const stats = await svc.customerStats(req.ctx, rows.map((r) => r.id));
  const all = await svc.customerStats(req.ctx);
  const regions = (await knex('customers').where({ business_id: req.ctx.businessId }).whereNotNull('region').whereNot('region', '').distinct('region').orderBy('region')).map((r) => r.region);
  const groups = (await knex('customers').where({ business_id: req.ctx.businessId }).whereNotNull('group_name').whereNot('group_name', '').distinct('group_name').orderBy('group_name')).map((r) => r.group_name);
  const values = Object.values(all);
  const summary = { customers: meta.total, buyers: values.length, repeat: values.filter((v) => v.orders > 1).length, ltv: values.length ? values.reduce((s, v) => s + v.spent, 0) / values.length : 0 };
  res.page('pages/customers/index', { title: req.t('nav.customers'), rows, meta, stats, regions, groups, summary, filtered: ['q', 'region', 'group'].some((k) => req.query[k] && req.query[k] !== 'all'), ...extra });
}

router.get('/', wrap((req, res) => render(req, res)));
router.get('/export', can('data.export'), wrap(async (req, res) => {
  const { rows } = await svc.customers.list(req.ctx, req.query, { all: true });
  const stats = await svc.customerStats(req.ctx);
  const t = req.t;
  exporter.send(req, res, {
    name: t('nav.customers'),
    header: [t('common.name'), t('common.phone'), t('common.email'), t('customers.city'), t('customers.region'), t('customers.group'), t('customers.address'), t('customers.orders'), t('customers.spent'), t('customers.last_order')],
    rows: rows.map((r) => { const s = stats[r.id] || {}; return [r.name, r.phone || '', r.email || '', r.city || '', r.region || '', r.group_name || '', r.address || '', s.orders || 0, s.spent || 0, s.lastOrder || '']; }),
  });
}));
const rerender = (req, res, extra) => render(req, res, { ...extra, openDialog: 'customer-dialog', formAction: req.originalUrl });
router.post('/', can('customers.manage'), form(async (req, res) => {
  const id = await svc.saveCustomer(req.ctx, null, req.body);
  flash(req, 'success', req.t('customers.saved'));
  res.redirect(`/app/customers/${id}`);
}, rerender));
router.post('/:id(\\d+)', can('customers.manage'), form(async (req, res) => {
  await svc.saveCustomer(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(req.body._return || `/app/customers/${req.params.id}`);
}, rerender));
router.post('/:id(\\d+)/delete', can('customers.manage'), wrap(async (req, res) => {
  await svc.removeCustomer(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('customers.deleted'));
  res.redirect('/app/customers');
}));
router.get('/:id(\\d+)', wrap(async (req, res) => {
  const customer = await svc.customers.get(req.ctx, Number(req.params.id));
  const orders = await knex('orders').where({ business_id: req.ctx.businessId, customer_id: customer.id }).orderBy('date', 'desc');
  const valid = orders.filter((o) => o.payment_status !== 'refunded');
  const spent = valid.reduce((s, o) => s + Number(o.total_amount), 0);
  res.page('pages/customers/show', { title: customer.name, customer, orders, spent, avg: valid.length ? spent / valid.length : 0, canSales: req.ctx.permissions.has('sales.view') });
}));

module.exports = router;
