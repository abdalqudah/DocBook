const express = require('express');
const { wrap } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { E } = require('../../core/errors');
const csv = require('../../core/csv');
const xlsx = require('../../core/xlsx');
const charts = require('../../core/charts');
const fmt = require('../../core/format');
const engine = require('../finance/engine');
const fin = require('../finance/finance.data');
const svc = require('./report.service');

const router = express.Router();
router.use(can('reports.view'));
const needProfit = (req, res, next) => (req.ctx.permissions.has('profits.view') ? next() : next(E.forbidden('profits.view')));

router.get('/', wrap(async (req, res) => {
  const month = fin.monthFromQuery(req.query.month);
  const { metrics, data } = await fin.snapshot(req.ctx.businessId, month);
  res.page('pages/reports/index', { title: req.t('nav.reports'), month, metrics, periodOptions: fin.periodOptions(data), showProfit: req.ctx.permissions.has('profits.view') });
}));

// ---- Income statement (P&L)
router.get('/pnl', needProfit, wrap(async (req, res) => {
  const month = fin.monthFromQuery(req.query.month);
  const r = await svc.pnl(req.ctx.businessId, month);
  const t = req.t; const lbl = res.locals.label;
  if (req.query.format) {
    if (!req.ctx.permissions.has('data.export')) throw E.forbidden('data.export');
    const header = [t('reports.line'), `${t('common.amount')} (${req.business.currency})`];
    const rows = r.lines.map((l) => [t(`reports.pnl.${l.key}`), Math.round(l.value * 1000) / 1000]);
    const alloc = r.metrics.partnerAllocations.map((a) => [a.partnerName, a.equityPercent, a.allocatedProfit, a.withdrawn, a.netPayable]);
    const name = `${t('reports.pnl_title')} ${month || 'all'}`;
    if (req.query.format === 'xlsx') {
      return xlsx.send(res, `pnl-${month || 'all'}.xlsx`, [
        { name: t('reports.pnl_title'), header, rows },
        { name: t('reports.allocation'), header: [t('partners.partner'), t('partners.equity'), t('partners.allocated'), t('partners.withdrawn'), t('partners.net_payable')], rows: alloc },
        { name: t('reports.opex_breakdown'), header: [t('common.category'), t('common.amount')], rows: Object.entries(r.byCategory).map(([k, v]) => [lbl('categories', k), v]) },
      ], { rtl: req.locale === 'ar' });
    }
    return csv.send(res, `${name}.csv`, header, rows);
  }
  res.page('pages/reports/pnl', { title: t('reports.pnl_title'), month, periodOptions: fin.periodOptions(r.data), ...r, printable: true });
}));

// ---- Monthly summary (12 or 24 months)
router.get('/monthly', needProfit, wrap(async (req, res) => {
  const months = req.query.months === '24' ? 24 : 12;
  const d = await fin.load(req.ctx.businessId);
  const series = svc.monthly(d, months);
  const t = req.t;
  if (req.query.format) {
    if (!req.ctx.permissions.has('data.export')) throw E.forbidden('data.export');
    const header = [t('common.month'), t('kpi.revenue'), t('kpi.cogs'), t('kpi.gross_profit'), t('kpi.daily_opex'), t('kpi.payroll'), t('nav.marketing'), t('kpi.delivery_net'), t('kpi.opex'), t('kpi.net_profit'), t('kpi.net_margin')];
    const rows = series.map((s) => [s.month, s.totalRevenue, s.totalCogs, s.grossProfit, s.totalDailyExpenses, s.totalPayroll, s.totalMarketingCost, s.netDeliveryExpense, s.totalOperatingExpenses, s.netProfit, Number(s.netMarginPercent.toFixed(2))]);
    if (req.query.format === 'xlsx') return xlsx.send(res, `monthly-summary-${months}.xlsx`, [{ name: t('reports.monthly_title'), header, rows }], { rtl: req.locale === 'ar' });
    return csv.send(res, `monthly-summary-${months}.csv`, header, rows);
  }
  const money = (v) => fmt.formatCompact(v, req.business.currency, req.locale);
  const chart = charts.columns({ points: series.map((s) => ({ label: fmt.formatMonth(s.month, req.locale), short: fmt.formatDate(`${s.month}-01`, req.locale, { month: 'short' }), value: s.netProfit })), title: t('kpi.net_profit'), fmt: money, height: 200, width: 900 });
  res.page('pages/reports/monthly', { title: t('reports.monthly_title'), series, months, chart, printable: true });
}));

// ---- Sales analysis
router.get('/sales', can('sales.view'), wrap(async (req, res) => {
  const month = fin.monthFromQuery(req.query.month, '');
  const d = await fin.load(req.ctx.businessId);
  const a = svc.salesAnalysis(d, month);
  res.page('pages/reports/sales', { title: req.t('reports.sales_title'), month, periodOptions: fin.periodOptions(d), a, showProfit: req.ctx.permissions.has('profits.view'), printable: true });
}));

// ---- Expense analysis
router.get('/expenses', can('expenses.view'), wrap(async (req, res) => {
  const d = await fin.load(req.ctx.businessId);
  res.page('pages/reports/expenses', { title: req.t('reports.expenses_title'), matrix: svc.expenseMatrix(d, 6), printable: true });
}));

// ---- Complete financial workbook (Excel): every table + the P&L, as DocBook's "full export"
router.get('/workbook', can('data.export'), wrap(async (req, res) => {
  const month = fin.monthFromQuery(req.query.month, '');
  const d = await fin.load(req.ctx.businessId);
  const m = engine.computeMetrics(d, month);
  const t = req.t; const lbl = res.locals.label; const profit = req.ctx.permissions.has('profits.view'); const p = req.ctx.permissions;
  const sheets = [];
  if (profit) {
    sheets.push({ name: t('reports.pnl_title'), header: [t('reports.line'), t('common.amount')], rows: svc.pnlLines(m).map((l) => [t(`reports.pnl.${l.key}`), l.value]) });
    sheets.push({ name: t('reports.allocation'), header: [t('partners.partner'), t('partners.equity'), t('partners.allocated'), t('partners.withdrawn'), t('partners.net_payable')], rows: m.partnerAllocations.map((a) => [a.partnerName, a.equityPercent, a.allocatedProfit, a.withdrawn, a.netPayable]) });
  }
  const inP = (date) => !month || engine.toMonthKey(date) === month;
  if (p.has('partners.view')) sheets.push({ name: t('nav.partners'), header: [t('common.name'), t('common.phone'), t('common.email'), t('partners.initial'), t('partners.additional'), t('partners.equity'), t('partners.withdrawn'), t('partners.join_date')], rows: d.partners.map((x) => [x.name, x.phone || '', x.email || '', x.initialInvestment, x.additionalContributions, x.currentEquityPercent, x.totalWithdrawn, x.joinDate || '']) });
  if (p.has('expenses.view')) sheets.push({ name: t('nav.expenses'), header: [t('common.date'), t('common.category'), t('expenses.title_field'), t('common.amount'), t('expenses.payment_method'), t('expenses.invoice'), t('expenses.recorded_by')], rows: d.expenses.filter((e) => inP(e.date)).map((e) => [e.date, lbl('categories', e.category), e.title, e.amount, lbl('payment_methods', e.paymentMethod), e.invoiceNumber || '', e.recordedBy || '']) });
  if (p.has('payroll.view')) sheets.push({ name: t('nav.payroll'), header: [t('common.name'), t('payroll.role'), t('common.phone'), t('payroll.base_salary'), t('payroll.commission_type'), t('payroll.commission_rate'), t('payroll.bonus'), t('payroll.deductions'), t('common.status'), t('payroll.months_paid')], rows: d.employees.map((e) => [e.name, e.role || '', e.phone || '', e.baseSalary, lbl('payroll.types', e.commissionType), e.commissionRate, e.bonus, e.deductions, lbl('payroll.statuses', e.status), e.paidMonths.join(', ')]) });
  if (p.has('purchases.view')) sheets.push({ name: t('nav.purchases'), header: [t('common.date'), t('purchases.supplier'), t('purchases.item'), 'SKU', t('purchases.quantity'), t('purchases.unit_cost'), t('purchases.total_cost'), t('purchases.shipping'), t('purchases.paid'), t('common.status')], rows: d.purchases.filter((x) => inP(x.date)).map((x) => [x.date, x.supplierName, x.itemName, x.sku || '', x.quantity, x.unitCost, x.totalCost, x.shippingCost, x.paidAmount, lbl('purchases.statuses', x.paymentStatus)]) });
  if (p.has('marketing.view')) sheets.push({ name: t('nav.marketing'), header: [t('marketing.campaign'), t('marketing.platform'), t('marketing.spend'), t('marketing.impressions'), t('marketing.clicks'), t('marketing.conversions'), t('marketing.revenue'), 'ROAS', t('common.status')], rows: d.campaigns.filter((c) => inP(c.startDate) || inP(c.endDate)).map((c) => [c.campaignName, lbl('platforms', c.platform), c.cost, c.impressions, c.clicks, c.conversions, c.revenueGenerated, Number(engine.campaignMetrics(c).roas.toFixed(2)), lbl('marketing.statuses', c.status)]) });
  if (p.has('sales.view')) sheets.push({ name: t('nav.sales'), header: [t('sales.order_number'), t('common.date'), t('sales.customer'), t('common.phone'), t('sales.subtotal'), t('sales.discount'), t('sales.delivery_fee'), t('sales.total'), ...(profit ? [t('kpi.cogs')] : []), t('sales.commission'), t('sales.payment_status')], rows: d.orders.filter((o) => inP(o.date)).map((o) => [o.orderNumber, o.date, o.customerName, o.customerPhone || '', o.subtotal, o.discount, o.deliveryFee, o.totalAmount, ...(profit ? [o.totalCogs] : []), o.commissionEarned, lbl('sales.payment_statuses', o.paymentStatus)]) });
  if (p.has('delivery.view')) sheets.push({ name: t('nav.delivery'), header: [t('common.date'), t('delivery.courier_company'), t('delivery.tracking'), t('delivery.recipient'), t('delivery.city'), t('delivery.fee_paid'), t('delivery.fee_collected'), t('common.status')], rows: d.deliveries.filter((x) => inP(x.date)).map((x) => [x.date, x.courierCompany || '', x.trackingNumber || '', x.customerName, x.destinationCity || '', x.deliveryFeePaid, x.deliveryFeeCollected, lbl('delivery.statuses', x.status)]) });
  if (p.has('budgets.view')) sheets.push({ name: t('nav.budgets'), header: [t('budgets.category'), t('budgets.monthly_cap'), t('budgets.threshold'), t('budgets.period')], rows: d.budgets.map((b) => [lbl('categories', b.category), b.monthlyBudget, b.alertThresholdPercent, b.periodMonth || t('budgets.every_month')]) });
  xlsx.send(res, `${req.business.name.replace(/[^\p{L}\p{N}]+/gu, '-')}-${month || 'all'}.xlsx`, sheets, { rtl: req.locale === 'ar' });
}));

module.exports = router;
