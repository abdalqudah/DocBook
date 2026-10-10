const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can, ownerOnly } = require('../../middleware/context');
const exporter = require('../../core/exporter');
const charts = require('../../core/charts');
const fmt = require('../../core/format');
const svc = require('./expense.service');
const recurring = require('./recurring.service');

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
  const dueRows = await recurring.due(req.ctx);
  // all branches: the new expense's branch is chosen on the form (in a branch, it is that branch's)
  const bs = require('../clinic/branches.service'); // eslint-disable-line global-require
  const expBranches = !req.ctx.workBranch && await bs.multi(req.ctx.businessId) ? (await bs.options(req.business, req.t, req.locale)).map((o) => ({ value: o.value === '' ? 'main' : o.value, label: o.short || o.label })) : null;
  res.page('pages/expenses/index', {
    dueCount: dueRows.length, expBranches,
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
router.post('/:id(\\d+)/delete', can('expenses.manage'), ownerOnly, wrap(async (req, res) => {
  await svc.expenses.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(backTo(req.body._return));
}));
router.post('/categories', can('expenses.manage'), form(async (req, res) => {
  await svc.addCategory(req.ctx, req.body.name);
  flash(req, 'success', req.t('expenses.category_added'));
  res.redirect('/app/expenses');
}, (req, res, extra) => render(req, res, { ...extra, openDialog: 'category-dialog' })));

// Recurring expenses: rent, phone, internet… recorded on their date by themselves or after a click.
async function renderRecurring(req, res, extra = {}) {
  const { system, custom } = await svc.categories(req.ctx.businessId);
  const [rows, dueRows] = await Promise.all([recurring.list(req.ctx), recurring.due(req.ctx)]);
  const active = rows.filter((r) => r.is_active);
  const perMonth = { week: 52 / 12, month: 1, quarter: 1 / 3, year: 1 / 12 };
  const monthly = active.reduce((s, r) => s + Number(r.amount) * perMonth[r.every], 0);
  res.page('pages/expenses/recurring', {
    title: req.t('recurring.title'), rows, dueRows, monthly, activeCount: active.length, system, custom, catName: catLabel(res, custom),
    methods: svc.PAYMENT_METHODS, everyList: recurring.EVERY, modes: recurring.MODES, pageStyles: ['/css/finance.css'], ...extra,
  });
}
router.get('/recurring', wrap((req, res) => renderRecurring(req, res)));
const recurringAgain = (req, res, extra) => renderRecurring(req, res, { ...extra, openDialog: 'recurring-dialog', formAction: req.originalUrl });
router.post('/recurring', can('expenses.manage'), form(async (req, res) => {
  await recurring.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('recurring.saved'));
  res.redirect('/app/expenses/recurring');
}, recurringAgain));
router.post('/recurring/:id(\\d+)', can('expenses.manage'), form(async (req, res) => {
  await recurring.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect('/app/expenses/recurring');
}, recurringAgain));
router.post('/recurring/:id(\\d+)/delete', can('expenses.manage'), ownerOnly, wrap(async (req, res) => {
  await recurring.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect('/app/expenses/recurring');
}));
// One due occurrence: record it (the amount can differ this time, e.g. the phone bill) or skip it.
router.post('/recurring/:id(\\d+)/post', can('expenses.manage'), wrap(async (req, res) => {
  const r = await recurring.get(req.ctx, Number(req.params.id));
  await recurring.post(req.ctx, r, { amount: req.body.amount });
  flash(req, 'success', req.t('recurring.posted', { title: r.title }));
  res.redirect(backTo(req.body._return || '/app/expenses/recurring'));
}));
router.post('/recurring/:id(\\d+)/skip', can('expenses.manage'), wrap(async (req, res) => {
  const r = await recurring.get(req.ctx, Number(req.params.id));
  await recurring.skip(req.ctx, r);
  flash(req, 'success', req.t('recurring.skipped', { title: r.title }));
  res.redirect(backTo(req.body._return || '/app/expenses/recurring'));
}));

module.exports = router;
