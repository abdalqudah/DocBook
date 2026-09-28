const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const exporter = require('../../core/exporter');
const fin = require('../finance/finance.data');
const engine = require('../finance/engine');
const svc = require('./purchase.service');

const router = express.Router();
router.use(can('purchases.view'));

async function render(req, res, extra = {}) {
  const tab = ['suppliers', 'items'].includes(req.query.tab) ? req.query.tab : 'invoices';
  const d = await fin.load(req.ctx.businessId);
  const month = fin.monthFromQuery(req.query.month, '');
  const m = engine.computeMetrics(d, month);
  const data = { title: req.t('nav.purchases'), tab, metrics: m, month, periodOptions: fin.periodOptions(d), statuses: svc.STATUSES, ...extra };
  if (tab === 'invoices') Object.assign(data, await svc.purchases.list(req.ctx, req.query), { filtered: ['q', 'status', 'from', 'to'].some((k) => req.query[k] && req.query[k] !== 'all') });
  if (tab === 'suppliers') data.suppliers = await svc.suppliers(req.ctx);
  if (tab === 'items') data.items = await svc.items(req.ctx);
  data.supplierNames = [...new Set(d.purchases.map((p) => p.supplierName))].sort();
  res.page('pages/purchases/index', data);
}

router.get('/', wrap((req, res) => render(req, res)));
router.get('/export', can('data.export'), wrap(async (req, res) => {
  const { rows } = await svc.purchases.list(req.ctx, req.query, { all: true });
  const t = req.t;
  exporter.send(req, res, {
    name: t('nav.purchases'),
    header: [t('common.date'), t('purchases.supplier'), t('purchases.supplier_phone'), t('purchases.item'), 'SKU', t('common.category'), t('purchases.unit_cost'), t('purchases.quantity'), t('purchases.total_cost'), t('purchases.shipping'), t('purchases.paid'), t('purchases.remaining'), t('common.status'), t('purchases.invoice_ref')],
    rows: rows.map((r) => [r.date, r.supplier_name, r.supplier_phone || '', r.item_name, r.sku || '', r.category || '', Number(r.unit_cost), Number(r.quantity), Number(r.total_cost), Number(r.shipping_cost), Number(r.paid_amount), Math.max(0, Number(r.total_cost) + Number(r.shipping_cost) - Number(r.paid_amount)), res.locals.label('purchases.statuses', r.payment_status), r.invoice_ref || '']),
  });
}));
const rerender = (req, res, extra) => render(req, res, { ...extra, openDialog: 'purchase-dialog', formAction: req.originalUrl });
router.post('/', can('purchases.manage'), form(async (req, res) => {
  await svc.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('purchases.saved'));
  res.redirect(req.body._return || '/app/purchases');
}, rerender));
router.post('/:id(\\d+)', can('purchases.manage'), form(async (req, res) => {
  await svc.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(req.body._return || '/app/purchases');
}, rerender));
router.post('/:id(\\d+)/pay', can('purchases.manage'), form(async (req, res) => {
  await svc.pay(req.ctx, Number(req.params.id), req.body.amount);
  flash(req, 'success', req.t('purchases.payment_saved'));
  res.redirect(req.body._return || '/app/purchases');
}, (req, res, extra) => render(req, res, extra)));
router.post('/:id(\\d+)/delete', can('purchases.manage'), wrap(async (req, res) => {
  await svc.purchases.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(req.body._return || '/app/purchases');
}));

module.exports = router;
