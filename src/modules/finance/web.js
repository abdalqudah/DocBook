// Staff payroll, partners & profit share, budgets, profit & loss (worker: finance)
//   /app/staff-payroll  (payroll.view / payroll.manage)   non-doctor staff salaries, monthly run, payslips
//   /app/partners       (finance.view / finance.manage)   partners, capital, monthly profit distribution, vouchers
//   /app/budgets        (expenses.view / expenses.manage) monthly budgets with usage and alerts
//   /app/finance        (finance.view)                    profit & loss, trend, breakdown, statement (print / PDF / export)
const express = require('express');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const exporter = require('../../core/exporter');
const charts = require('../../core/charts');
const fmt = require('../../core/format');
const expenseSvc = require('../expenses/expense.service');
const staff = require('./staff.service');
const partners = require('./partners.service');
const budgets = require('./budgets.service');
const pnl = require('./pnl.service');
const pdf = require('./pdf');
const m = require('./math');

const router = express.Router();

// ---------------------------------------------------------------- helpers
const monthOf = (req, name = 'period') => [req.query[name], req.body && req.body[name]].find(m.isMonth) || req.ctx.today.slice(0, 7);
const nav = (period) => ({ period, prevPeriod: m.addMonths(period, -1), nextPeriod: m.addMonths(period, 1) });

function errText(req, err) {
  for (const k of [`errors_finance.${err.code}`, `errors.${err.code}`]) { const tr = req.t(k, err.details || {}); if (tr !== k) return tr; }
  return err.message;
}
const safeBack = (req, prefix, fallback) => {
  const r = String((req.body && req.body._return) || '');
  return r.startsWith(prefix) && !r.startsWith('//') ? r : fallback;
};

/**
 * Runs a POST action. Validation errors re-render the page with the messages when `rerender` is given; other
 * expected business errors become an error toast and a redirect back.
 */
const act = (fn, { back, rerender } = {}) => wrap(async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (!(err instanceof AppError) || err.status >= 500 || err.status === 403) throw err;
    const tr = err.preTranslated ? (v) => v : (v) => translateMessage(req.locale, v);
    if (err.code === 'VALIDATION_FAILED' && rerender) {
      res.status(422);
      return rerender(req, res, {
        errors: Object.fromEntries(Object.entries(err.details || {}).map(([k, v]) => [k, tr(v)])),
        formError: { code: err.code, message: req.t('errors.VALIDATION_FAILED') }, old: req.body,
      });
    }
    flash(req, 'error', err.code === 'VALIDATION_FAILED' ? `${req.t('errors.VALIDATION_FAILED')} ${Object.values(err.details || {}).map(tr).join(' ')}` : errText(req, err));
    return res.redirect(back(req));
  }
  return undefined;
});

async function catNamer(req, res) {
  const names = await budgets.customNames(req.ctx.businessId);
  return (key) => names[key] || res.locals.label('categories', key);
}

// ================================================================ STAFF SALARIES
const staffBack = (req) => safeBack(req, '/app/staff-payroll', `/app/staff-payroll?period=${monthOf(req)}`);

async function renderStaff(req, res, extra = {}) {
  const period = monthOf(req);
  const tab = req.query.tab === 'employees' || extra.tab === 'employees' ? 'employees' : 'run';
  const [sh, employees, members] = await Promise.all([staff.sheet(req.ctx, period), staff.listEmployees(req.ctx), req.ctx.permissions.has('payroll.manage') ? staff.memberOptions(req.ctx) : []]);
  const bs = require('../clinic/branches.service'); // eslint-disable-line global-require
  const empBranches = !req.ctx.workBranch && await bs.multi(req.ctx.businessId) ? (await bs.options(req.business, req.t, req.locale)).map((o) => ({ value: o.value === '' ? 'main' : o.value, label: o.short || o.label })) : null;
  res.page('pages/finance/staff', {
    empBranches,
    title: req.t('staffpay.title'), ...nav(period), tab, sheet: sh, employees, members, methods: staff.METHODS, adjTypes: staff.ADJ_TYPES,
    printable: true, pageScripts: ['/js/finance.js'], pageStyles: ['/css/finance.css'], ...extra,
  });
}

router.get('/staff-payroll', can('payroll.view'), wrap((req, res) => renderStaff(req, res)));

router.get('/staff-payroll/export', can('payroll.view'), wrap(async (req, res) => {
  const period = monthOf(req);
  const { rows, totals } = await staff.sheet(req.ctx, period);
  const t = req.t;
  exporter.send(req, res, {
    name: `${t('staffpay.title')} ${period}`,
    header: [t('staffpay.employee'), t('staffpay.job_title'), t('staffpay.base_salary'), t('staffpay.allowances'), t('staffpay.bonuses'), t('staffpay.fixed_deductions'), t('staffpay.extra_deductions'), t('staffpay.advances'), t('staffpay.net_pay'), t('common.status'), t('staffpay.paid_on'), t('staffpay.method'), t('common.reference'), t('staffpay.bank'), t('staffpay.iban')],
    rows: rows.map((r) => [r.employee_name, r.job_title || '', r.f.base, r.f.allowances, r.f.bonuses, r.f.deductions, r.f.extraDeductions, r.f.advances, r.f.net,
      t(`staffpay.status.${r.status}`), r.paid_on || '', r.payment_method ? t(`payment_methods.${r.payment_method}`) : '', r.reference || '', r.bank_name || '', r.iban || ''])
      .concat([[t('common.total'), '', totals.base, totals.allowances, totals.bonuses, totals.fixedDeductions, totals.extraDeductions, totals.advances, totals.net, '', '', '', '', '', '']]),
  });
}));

const staffManage = can('payroll.manage');
router.post('/staff-payroll/prepare', staffManage, act(async (req, res) => {
  const n = await staff.prepare(req.ctx, monthOf(req));
  flash(req, n ? 'success' : 'info', n ? req.t('staffpay.prepared', { n }) : req.t('staffpay.prepared_none'));
  res.redirect(staffBack(req));
}, { back: staffBack }));

router.post('/staff-payroll/pay-all', staffManage, act(async (req, res) => {
  const n = await staff.payAll(req.ctx, monthOf(req), req.body);
  flash(req, 'success', req.t('staffpay.paid_all', { n }));
  budgets.checkNow(req.ctx.businessId, req.ctx.timezone);
  res.redirect(staffBack(req));
}, { back: staffBack }));

router.post('/staff-payroll/lines/:id(\\d+)/adjustments', staffManage, act(async (req, res) => {
  await staff.addAdjustment(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('staffpay.adj_added'));
  res.redirect(staffBack(req));
}, { back: staffBack }));

router.post('/staff-payroll/adjustments/:id(\\d+)/delete', staffManage, act(async (req, res) => {
  await staff.removeAdjustment(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('staffpay.adj_removed'));
  res.redirect(staffBack(req));
}, { back: staffBack }));

router.post('/staff-payroll/lines/:id(\\d+)/pay', staffManage, act(async (req, res) => {
  await staff.markPaid(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('staffpay.marked_paid'));
  budgets.checkNow(req.ctx.businessId, req.ctx.timezone);
  res.redirect(staffBack(req));
}, { back: staffBack }));

router.post('/staff-payroll/lines/:id(\\d+)/reopen', staffManage, act(async (req, res) => {
  await staff.reopen(req.ctx, Number(req.params.id), req.body.reason);
  flash(req, 'success', req.t('staffpay.reopened'));
  res.redirect(staffBack(req));
}, { back: staffBack }));

router.post('/staff-payroll/lines/:id(\\d+)/delete', staffManage, act(async (req, res) => {
  await staff.removeLine(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('staffpay.line_removed'));
  res.redirect(staffBack(req));
}, { back: staffBack }));

const employeesRerender = (req, res, extra) => renderStaff(req, res, { ...extra, tab: 'employees', openDialog: 'employee-dialog', formAction: req.originalUrl });
const employeesBack = () => '/app/staff-payroll?tab=employees';
router.post('/staff-payroll/employees', staffManage, act(async (req, res) => {
  await staff.saveEmployee(req.ctx, null, req.body);
  flash(req, 'success', req.t('staffpay.employee_saved'));
  res.redirect(employeesBack());
}, { back: employeesBack, rerender: employeesRerender }));
router.post('/staff-payroll/employees/:id(\\d+)', staffManage, act(async (req, res) => {
  await staff.saveEmployee(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('staffpay.employee_saved'));
  res.redirect(employeesBack());
}, { back: employeesBack, rerender: employeesRerender }));
router.post('/staff-payroll/employees/:id(\\d+)/delete', staffManage, act(async (req, res) => {
  await staff.removeEmployee(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(employeesBack());
}, { back: employeesBack }));

router.get('/staff-payroll/lines/:id(\\d+)/payslip', can('payroll.view'), wrap(async (req, res) => {
  const data = await staff.payslip(req.ctx, Number(req.params.id));
  if (req.query.format === 'pdf') {
    const buf = await pdf.payslip(req.ctx, data, req.t, req.locale);
    return pdf.send(res, `payslip-${data.line.period}-${data.line.id}`, buf, req.query.download === '1');
  }
  return res.page('pages/finance/payslip', {
    title: `${req.t('staffpay.payslip')} · ${data.line.employee_name} · ${data.line.period}`, ...data, period: data.line.period,
    printable: true, pageStyles: ['/css/finance.css'],
  });
}));

// ================================================================ PARTNERS
const partnersBack = (req) => safeBack(req, '/app/partners', '/app/partners');
const lastClosed = (req) => m.addMonths(req.ctx.today.slice(0, 7), -1);

async function renderPartners(req, res, extra = {}) {
  const month = [req.query.month].find(m.isMonth) || lastClosed(req);
  const s = await pnl.monthNet(req.ctx, month);
  const [ov, dists] = await Promise.all([partners.overview(req.ctx, s.net), partners.distributions(req.ctx.businessId)]);
  const distributed = dists.find((d) => d.period === month) || null;
  res.page('pages/finance/partners', {
    title: req.t('partners.title'), month, monthNet: s, ov, dists, distributed, closed: month < req.ctx.today.slice(0, 7), txTypes: partners.TX_TYPES,
    ...nav(month), pageScripts: ['/js/finance.js'], pageStyles: ['/css/finance.css'], ...extra,
  });
}
router.get('/partners', can('finance.view'), wrap((req, res) => renderPartners(req, res)));

const finManage = can('finance.manage');
const partnerRerender = (req, res, extra) => renderPartners(req, res, { ...extra, openDialog: 'partner-dialog', formAction: req.originalUrl });
async function savePartner(req, res, id) {
  try {
    await partners.save(req.ctx, id, req.body);
  } catch (err) {
    // Too much equity: show it on the field, keep the form open.
    if (err instanceof AppError && err.code === 'EQUITY_OVER_100') throw Object.assign(new AppError('VALIDATION_FAILED', err.message, 422, { equity_percent: req.t('errors_finance.EQUITY_OVER_100', err.details) }), { preTranslated: true });
    throw err;
  }
  flash(req, 'success', req.t('partners.saved'));
  res.redirect(partnersBack(req));
}
router.post('/partners', finManage, act((req, res) => savePartner(req, res, null), { back: partnersBack, rerender: partnerRerender }));
router.post('/partners/:id(\\d+)', finManage, act((req, res) => savePartner(req, res, Number(req.params.id)), { back: partnersBack, rerender: partnerRerender }));
router.post('/partners/:id(\\d+)/delete', finManage, act(async (req, res) => {
  await partners.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(partnersBack(req));
}, { back: partnersBack }));
router.post('/partners/:id(\\d+)/transactions', finManage, act(async (req, res) => {
  await partners.addTransaction(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('partners.tx_saved'));
  res.redirect(partnersBack(req));
}, { back: partnersBack }));
router.post('/partners/transactions/:id(\\d+)/delete', finManage, act(async (req, res) => {
  await partners.removeTransaction(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(partnersBack(req));
}, { back: partnersBack }));
router.post('/partners/distribute', finManage, act(async (req, res) => {
  const month = [req.body.month].find(m.isMonth);
  const r = await partners.distribute(req.ctx, month || '');
  flash(req, 'success', req.t('partners.distributed', { month: fmt.formatMonth(month, req.locale), n: r.allocations.length }));
  res.redirect(`/app/partners?month=${month}`);
}, { back: partnersBack }));
router.post('/partners/distributions/:id(\\d+)/cancel', finManage, act(async (req, res) => {
  const d = await partners.cancelDistribution(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('partners.distribution_cancelled', { month: fmt.formatMonth(d.period, req.locale) }));
  res.redirect(`/app/partners?month=${d.period}`);
}, { back: partnersBack }));

router.get('/partners/transactions/:id(\\d+)/voucher', can('finance.view'), wrap(async (req, res) => {
  const data = await partners.voucher(req.ctx, Number(req.params.id));
  if (req.query.format === 'pdf') {
    const buf = await pdf.voucher(req.ctx, data, req.t, req.locale);
    return pdf.send(res, `voucher-P-${data.tx.id}`, buf, req.query.download === '1');
  }
  return res.page('pages/finance/voucher', { title: `${req.t(`partners.voucher_title.${data.tx.type}`)} · ${data.partner.name}`, ...data, printable: true, pageStyles: ['/css/finance.css'] });
}));

// ================================================================ BUDGETS
const budgetsBack = (req) => safeBack(req, '/app/budgets', '/app/budgets');

async function renderBudgets(req, res, extra = {}) {
  const month = [req.query.month].find(m.isMonth) || req.ctx.today.slice(0, 7);
  const [rows, scopeList, names] = await Promise.all([budgets.evaluate(req.ctx.businessId, req.ctx.timezone, month), budgets.scopes(req.ctx.businessId), budgets.customNames(req.ctx.businessId)]);
  const labelOf = (k) => budgets.scopeLabel(req.t, k, names);
  const totals = rows.filter((b) => b.is_active).reduce((t, b) => ({ limit: m.round(t.limit + b.status.limit), spent: m.round(t.spent + b.status.spent), warn: t.warn + (b.status.warn ? 1 : 0), over: t.over + (b.status.over ? 1 : 0) }), { limit: 0, spent: 0, warn: 0, over: 0 });
  res.page('pages/finance/budgets', {
    title: req.t('budgets.title'), month, ...nav(month), rows, scopeList, labelOf, totals,
    pageScripts: ['/js/finance.js'], pageStyles: ['/css/finance.css'], ...extra,
  });
}
router.get('/budgets', can('expenses.view'), wrap((req, res) => renderBudgets(req, res)));
const budgetRerender = (req, res, extra) => renderBudgets(req, res, { ...extra, openDialog: 'budget-dialog', formAction: req.originalUrl });
const budgetManage = can('expenses.manage');
router.post('/budgets', budgetManage, act(async (req, res) => {
  await budgets.save(req.ctx, null, req.body);
  flash(req, 'success', req.t('budgets.saved'));
  budgets.checkNow(req.ctx.businessId, req.ctx.timezone);
  res.redirect(budgetsBack(req));
}, { back: budgetsBack, rerender: budgetRerender }));
router.post('/budgets/:id(\\d+)', budgetManage, act(async (req, res) => {
  await budgets.save(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('budgets.saved'));
  budgets.checkNow(req.ctx.businessId, req.ctx.timezone);
  res.redirect(budgetsBack(req));
}, { back: budgetsBack, rerender: budgetRerender }));
router.post('/budgets/:id(\\d+)/delete', budgetManage, act(async (req, res) => {
  await budgets.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect(budgetsBack(req));
}, { back: budgetsBack }));

// ================================================================ PROFIT & LOSS
function periodOfQuery(req) {
  const kind = ['month', 'quarter', 'year'].includes(req.query.kind) ? req.query.kind : 'month';
  const today = req.ctx.today;
  const def = { month: today.slice(0, 7), quarter: m.quarterOf(today.slice(0, 7)), year: today.slice(0, 4) }[kind];
  return m.resolvePeriod(kind, req.query.key || def, today);
}
function periodLabel(req, p) {
  if (p.kind === 'year') return req.t('pnl.year_label', { y: p.key });
  if (p.kind === 'quarter') { const [y, q] = p.key.split('-Q'); return req.t('pnl.quarter_label', { q, y }); }
  return fmt.formatMonth(p.key, req.locale);
}
function periodChoices(req, kind) {
  const cur = req.ctx.today.slice(0, 7);
  if (kind === 'year') { const y = Number(cur.slice(0, 4)); return [0, 1, 2, 3, 4].map((i) => String(y - i)).map((k) => ({ key: k, label: periodLabel(req, { kind, key: k }) })); }
  if (kind === 'quarter') { const out = []; let mo = cur; for (let i = 0; i < 8; i += 1) { const k = m.quarterOf(mo); out.push({ key: k, label: periodLabel(req, { kind, key: k }) }); mo = m.addMonths(mo, -3); } return out; }
  return Array.from({ length: 24 }, (_, i) => m.addMonths(cur, -i)).map((k) => ({ key: k, label: fmt.formatMonth(k, req.locale) }));
}
function shiftPeriod(p, n) {
  if (p.kind === 'year') return String(Number(p.key) + n);
  if (p.kind === 'quarter') return m.quarterOf(m.addMonths(p.fromMonth, 3 * n));
  return m.addMonths(p.key, n);
}

router.get('/finance', can('finance.view'), wrap(async (req, res) => {
  const period = periodOfQuery(req);
  const data = await pnl.build(req.ctx, period);
  const catName = await catNamer(req, res);
  const label = periodLabel(req, period);
  if (req.query.format === 'pdf') {
    const buf = await pdf.statement(req.ctx, data, req.t, req.locale, catName, label);
    return pdf.send(res, `profit-loss-${period.key}`, buf, req.query.download === '1');
  }
  const cm = (v) => fmt.formatCompact(v, req.ctx.currency, req.locale);
  const mf = (v) => fmt.formatMoney(v, req.ctx.currency, req.locale);
  const points = data.trend.map((x) => ({ label: fmt.formatMonth(x.month, req.locale), short: fmt.formatDate(`${x.month}-01`, req.locale, { month: 'short' }), revenue: x.revenue, costs: x.costs, net: x.net }));
  const hasTrend = points.some((p) => p.revenue || p.costs);
  const trendChart = hasTrend ? charts.line({
    points, title: req.t('pnl.trend_title'), fmt: cm, width: 760, height: 240,
    series: [{ key: 'revenue', cls: '' }, { key: 'costs', cls: 's2' }, { key: 'net', cls: 's3' }],
    tipFmt: (p) => `${req.t('pnl.revenue')} ${mf(p.revenue)} · ${req.t('pnl.total_costs')} ${mf(p.costs)} · ${req.t('pnl.net')} ${mf(p.net)}`,
  }) : null;
  const costItems = data.cur.expenses.map((e) => ({ label: catName(e.category), value: e.amount }))
    .concat([{ label: req.t('pnl.doctor_payroll'), value: data.cur.doctorPayroll }, { label: req.t('pnl.staff_salaries'), value: data.cur.staffSalaries }]).filter((i) => i.value > 0);
  const donut = costItems.length ? charts.donut({ items: costItems, fmt: mf, title: req.t('pnl.cost_breakdown'), otherLabel: req.t('pnl.other') }) : null;
  const [budgetRows, names, ov] = await Promise.all([
    budgets.evaluate(req.ctx.businessId, req.ctx.timezone, req.ctx.today.slice(0, 7), { historyMonths: 1 }),
    budgets.customNames(req.ctx.businessId), partners.overview(req.ctx, data.cur.net),
  ]);
  const budgetAlerts = budgetRows.filter((b) => b.is_active && b.status.state !== 'ok').map((b) => ({ ...b, label: budgets.scopeLabel(req.t, b.scope_key, names) }));
  return res.page('pages/finance/pnl', {
    title: req.t('pnl.title'), p: period, label, data, catName, trendChart, donut, budgetAlerts, budgetCount: budgetRows.length, ov,
    choices: periodChoices(req, period.kind), prevKey: shiftPeriod(period, -1), nextKey: shiftPeriod(period, 1), prevLabel: periodLabel(req, data.prev),
    printable: true, pageScripts: ['/js/finance.js'], pageStyles: ['/css/finance.css'],
  });
}));

router.get('/finance/export', can('finance.view'), wrap(async (req, res) => {
  const period = periodOfQuery(req);
  const data = await pnl.build(req.ctx, period);
  const catName = await catNamer(req, res);
  const t = req.t;
  const s = data.cur; const b = data.before;
  // Costs are exported as negative numbers; their change % compares the cost amounts (cost = true). Every other line
  // (net profit included, which can be negative) compares the values as they are, as the page does.
  const r = (label, cur, prev, cost = false) => {
    const k = cost ? -1 : 1;
    const d = m.delta(k * (Number(cur) || 0), k * (Number(prev) || 0));
    return [label, cur, prev, d === null ? '' : d];
  };
  const rows = [
    r(t('pnl.gross_revenue'), s.gross, b.gross), r(t('pnl.discounts'), -s.discounts, -b.discounts, true), r(t('pnl.revenue'), s.revenue, b.revenue),
    r(t('pnl.of_which_online'), s.online, b.online),
    ...[...new Set([...(s.byMethod || []), ...(b.byMethod || [])].map((x) => x.method))].map((k) => r(t('invoicex.of_which', { m: t(`invoicex.m.${k}`) }),
      ((s.byMethod || []).find((x) => x.method === k) || {}).amount || 0, ((b.byMethod || []).find((x) => x.method === k) || {}).amount || 0)),
    ...[...new Set([...s.expenses.map((e) => e.category), ...b.expenses.map((e) => e.category)])].map((c) => r(`${t('pnl.operating_expenses')} · ${catName(c)}`,
      -((s.expenses.find((e) => e.category === c) || {}).amount || 0), -((b.expenses.find((e) => e.category === c) || {}).amount || 0), true)),
    r(t('pnl.doctor_payroll'), -s.doctorPayroll, -b.doctorPayroll, true), r(t('pnl.staff_salaries'), -s.staffSalaries, -b.staffSalaries, true),
    r(t('pnl.total_costs'), -s.costs, -b.costs, true), r(t('pnl.net_profit'), s.net, b.net), r(t('pnl.margin'), s.margin ?? '', b.margin ?? ''),
    r(t('pnl.refunds_memo'), s.refunds, b.refunds), r(t('pnl.supplies_memo'), s.suppliesReceived, b.suppliesReceived),
  ];
  exporter.send(req, res, { name: `${t('pnl.title')} ${period.key}`, header: [t('pnl.line'), periodLabel(req, period), periodLabel(req, data.prev), t('pnl.change_pct')], rows });
}));

module.exports = router;
