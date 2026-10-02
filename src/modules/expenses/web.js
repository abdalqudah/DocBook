const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const exporter = require('../../core/exporter');
const charts = require('../../core/charts');
const fmt = require('../../core/format');
const svc = require('./expense.service');

const router = express.Router();
router.use(can('expenses.view'));
// Where to go after saving: an /app page only (e.g. back to the cash screen), else the expenses list.
const backTo = (v) => (typeof v === 'string' && /^\/app(\/[\w\-/?=&.%]*)?$/.test(v) && !v.startsWith('//') ? v : '/app/expenses');

function catLabel(res, custom) {
  const map = Object.fromEntries(custom.map((c) => [c.key, c.name]));
  return (key) => map[key] || res.locals.label('categories', key);
}

async function render(req, res, extra = {}) {
  const { system, custom } = await svc.categories(req.ctx.businessId);
  const { rows, totals, meta } = await svc.expenses.list(req.ctx, req.query);
  const catName = catLabel(res, custom);
  // Breakdown of the filtered set by category (ignores pagination).
  const byCat = await svc.expenses.applyFilters(svc.expenses.scoped(req.ctx), req.ctx, req.query)
    .select('category').sum({ total: 'amount' }).groupBy('category').orderBy('total', 'desc');
  const breakdown = charts.bars({ items: byCat.slice(0, 8).map((r) => ({ label: catName(r.category), value: Number(r.total) })), fmt: (v) => fmt.formatCompact(v, req.business.currency, req.locale) });
  res.page('pages/expenses/index', {
    title: req.t('nav.expenses'), rows, totals, meta, system, custom, catName, breakdown, hasBreakdown: byCat.length > 0,
    methods: svc.PAYMENT_METHODS, filtered: ['q', 'category', 'method', 'from', 'to', 'month'].some((k) => req.query[k] && req.query[k] !== 'all'), ...extra,
  });
}

router.get('/', wrap((req, res) => render(req, res)));

router.get('/export', can('data.export'), wrap(async (req, res) => {
  const { custom } = await svc.categories(req.ctx.businessId);
  const catName = catLabel(res, custom);
  const { rows } = await svc.expenses.list(req.ctx, req.query, { all: true });
  const t = req.t;
  exporter.send(req, res, {
    name: t('nav.expenses'),
    header: [t('common.date'), t('common.category'), t('expenses.title_field'), t('common.amount'), t('expenses.payment_method'), t('expenses.invoice'), t('expenses.recorded_by'), t('common.notes')],
    rows: rows.map((r) => [r.date, catName(r.category), r.title, Number(r.amount), res.locals.label('payment_methods', r.payment_method), r.invoice_number || '', r.recorded_by || '', r.notes || '']),
  });
}));

const rerender = (req, res, extra) => render(req, res, { ...extra, openDialog: 'expense-dialog', formAction: req.originalUrl });
router.post('/', can('expenses.manage'), form(async (req, res) => {
  await svc.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('expenses.saved'));
  res.redirect(backTo(req.body._return));
}, rerender));
router.post('/:id(\\d+)', can('expenses.manage'), form(async (req, res) => {
  await svc.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(backTo(req.body._return));
}, rerender));
router.post('/:id(\\d+)/delete', can('expenses.manage'), wrap(async (req, res) => {
  await svc.expenses.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(backTo(req.body._return));
}));
router.post('/categories', can('expenses.manage'), form(async (req, res) => {
  await svc.addCategory(req.ctx, req.body.name);
  flash(req, 'success', req.t('expenses.category_added'));
  res.redirect('/app/expenses');
}, (req, res, extra) => render(req, res, { ...extra, openDialog: 'category-dialog' })));

module.exports = router;
