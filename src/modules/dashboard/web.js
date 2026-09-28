const express = require('express');
const { wrap } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const charts = require('../../core/charts');
const fmt = require('../../core/format');
const engine = require('../finance/engine');
const fin = require('../finance/finance.data');

const router = express.Router();

router.get('/', can('dashboard.view'), wrap(async (req, res) => {
  const perms = req.ctx.permissions;
  const month = fin.monthFromQuery(req.query.month);
  const { data, metrics, budgetLines } = await fin.snapshot(req.ctx.businessId, month);
  const prevKey = month ? new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7) : null;
  const prev = prevKey ? engine.computeMetrics(data, prevKey) : null;
  const series = fin.monthSeries(data, 12);
  const cur = req.business.currency;
  const L = req.locale;
  const money = (v) => fmt.formatCompact(v, cur, L);
  const short = (k) => fmt.formatDate(`${k}-01`, L, { month: 'short' });

  const showProfit = perms.has('profits.view');
  const trend = charts.columns({
    points: series.map((s) => ({ label: fmt.formatMonth(s.month, L), short: short(s.month), value: s.totalRevenue, value2: showProfit ? s.netProfit : null })),
    series: showProfit ? [{ key: 'value', cls: '' }, { key: 'value2', cls: 's2' }] : [{ key: 'value', cls: '' }],
    title: req.t('dashboard.trend_title'), fmt: money, height: 240, width: 720,
    tipFmt: (p) => (showProfit ? `${req.t('kpi.revenue')}: ${money(p.value)} · ${req.t('kpi.net_profit')}: ${money(p.value2)}` : money(p.value)),
  });

  // Where the money went (the components of operating expenses).
  const opexByCat = {};
  data.expenses.filter((e) => (!month || engine.toMonthKey(e.date) === month) && !engine.NON_OPEX_EXPENSE_CATEGORIES.has(e.category))
    .forEach((e) => { opexByCat[e.category] = (opexByCat[e.category] || 0) + e.amount; });
  const lbl = res.locals.label;
  const spend = [
    ...Object.entries(opexByCat).map(([k, v]) => ({ label: lbl('categories', k), value: v })),
    { label: req.t('categories.payroll'), value: metrics.totalPayroll },
    { label: req.t('categories.marketing'), value: metrics.totalMarketingCost },
    { label: req.t('categories.delivery'), value: metrics.netDeliveryExpense },
  ];
  const spendChart = charts.donut({ items: spend, fmt: money, title: req.t('dashboard.spend_title'), otherLabel: req.t('dashboard.other') });

  const campaigns = data.campaigns.filter((c) => !month || engine.toMonthKey(c.startDate) === month || engine.toMonthKey(c.endDate) === month);
  const campCost = campaigns.reduce((s, c) => s + c.cost, 0);
  const campRev = campaigns.reduce((s, c) => s + c.revenueGenerated, 0);
  const roas = campCost > 0 ? campRev / campCost : 0;
  const partnerCapital = data.partners.reduce((s, p) => s + p.initialInvestment + p.additionalContributions, 0);
  const pendingDeliveries = data.deliveries.filter((d) => d.status === 'pending' || d.status === 'out_for_delivery');
  const alertsList = budgetLines.filter((b) => b.isWarning || b.isExceeded).sort((a, b) => b.usagePercent - a.usagePercent);
  const orders = data.orders.filter((o) => !month || engine.toMonthKey(o.date) === month);
  const recentOrders = data.orders.slice(0, 6);
  const topCampaigns = campaigns.map((c) => ({ ...c, m: engine.campaignMetrics(c) })).sort((a, b) => b.m.roas - a.m.roas).slice(0, 4);
  const delta = (a, b) => (b ? ((a - b) / Math.abs(b)) * 100 : null);

  res.page('pages/dashboard/index', {
    title: req.t('nav.dashboard'), month, periodOptions: fin.periodOptions(data), metrics, prev, showProfit,
    trend, spendChart, roas, campCost, campRev, partnerCapital, pendingDeliveries, alertsList, budgetLines, orders, recentOrders, topCampaigns,
    hasTrend: series.some((s) => s.totalRevenue || s.netProfit), delta, counts: { partners: data.partners.length, employees: data.employees.filter((e) => e.status !== 'inactive').length, orders: orders.length, customers: 0 },
    isEmpty: !data.orders.length && !data.expenses.length && !data.partners.length && !data.employees.length && !data.purchases.length,
  });
}));

module.exports = router;
