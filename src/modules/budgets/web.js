const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const fmt = require('../../core/format');
const fin = require('../finance/finance.data');
const engine = require('../finance/engine');
const expenses = require('../expenses/expense.service');
const svc = require('./budget.service');

const router = express.Router();
router.use(can('budgets.view'));

async function render(req, res, extra = {}) {
  const month = fin.monthFromQuery(req.query.month) || fmt.currentMonth();
  const d = await fin.load(req.ctx.businessId);
  const lines = engine.budgetStatus(fin.budgetsFor(d.budgets, month), d, month);
  const byId = Object.fromEntries(d.budgets.map((b) => [b.id, b]));
  const { custom } = await expenses.categories(req.ctx.businessId);
  const customName = Object.fromEntries(custom.map((c) => [c.key, c.name]));
  const keys = await svc.categoryKeys(req.ctx.businessId);
  const totals = lines.reduce((t, l) => ({ limit: t.limit + l.monthlyLimit, spent: t.spent + l.actualSpent }), { limit: 0, spent: 0 });
  res.page('pages/budgets/index', {
    title: req.t('nav.budgets'), month, lines, byId, keys, customName, totals, all: d.budgets,
    counts: { exceeded: lines.filter((l) => l.isExceeded).length, warning: lines.filter((l) => l.isWarning).length, safe: lines.filter((l) => !l.isWarning && !l.isExceeded).length },
    history: await svc.alertHistory(req.ctx), ...extra,
  });
}

router.get('/', wrap((req, res) => render(req, res)));
const rerender = (req, res, extra) => render(req, res, { ...extra, openDialog: 'budget-dialog', formAction: req.originalUrl });
router.post('/', can('budgets.manage'), form(async (req, res) => {
  await svc.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('budgets.saved'));
  res.redirect(req.body._return || '/app/budgets');
}, rerender));
router.post('/:id(\\d+)', can('budgets.manage'), form(async (req, res) => {
  await svc.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(req.body._return || '/app/budgets');
}, rerender));
router.post('/:id(\\d+)/delete', can('budgets.manage'), wrap(async (req, res) => {
  await svc.budgets.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(req.body._return || '/app/budgets');
}));

module.exports = router;
