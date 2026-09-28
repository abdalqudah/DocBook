// Report builders. Every figure comes from the same engine as the dashboard, so reports always agree with the app.
const engine = require('../finance/engine');
const fin = require('../finance/finance.data');

/** DocBook's 10-line income statement for a period. */
function pnlLines(m) {
  return [
    { key: 'revenue', value: m.totalRevenue, kind: 'total' },
    { key: 'cogs', value: -m.totalCogs, kind: 'line' },
    { key: 'gross', value: m.grossProfit, kind: 'total', pct: m.grossMarginPercent },
    { key: 'opex_daily', value: -m.totalDailyExpenses, kind: 'line' },
    { key: 'salaries', value: -m.totalSalaries, kind: 'sub' },
    { key: 'commissions', value: -m.totalCommissions, kind: 'sub' },
    { key: 'marketing', value: -m.totalMarketingCost, kind: 'line' },
    { key: 'delivery', value: -m.netDeliveryExpense, kind: 'line' },
    { key: 'financing', value: -m.totalFinancingPaid, kind: 'line' },
    { key: 'opex_total', value: -m.totalOperatingExpenses, kind: 'total' },
    { key: 'net', value: m.netProfit, kind: 'grand', pct: m.netMarginPercent },
  ];
}

async function pnl(businessId, month) {
  const d = await fin.load(businessId);
  const m = engine.computeMetrics(d, month);
  let prev = null;
  if (month) {
    const dt = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1));
    prev = engine.computeMetrics(d, dt.toISOString().slice(0, 7));
  }
  const byCategory = {};
  d.expenses.filter((e) => (!month || engine.toMonthKey(e.date) === month) && !engine.NON_OPEX_EXPENSE_CATEGORIES.has(e.category))
    .forEach((e) => { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount; });
  return { data: d, metrics: m, prev, lines: pnlLines(m), prevLines: prev ? pnlLines(prev) : null, byCategory };
}

function monthly(d, months) {
  return fin.monthSeries(d, months);
}

/** Sales analysis for a period: by product, by rep, by channel, by payment status. */
function salesAnalysis(d, month) {
  const orders = d.orders.filter((o) => !month || engine.toMonthKey(o.date) === month);
  const products = {}; const reps = {}; const channels = {}; const payments = {};
  const repName = Object.fromEntries(d.employees.map((e) => [e.id, e.name]));
  for (const o of orders) {
    for (const it of o.items) {
      const k = (it.sku || it.itemName || '').trim() || '—';
      const p = products[k] || (products[k] = { name: it.itemName, sku: it.sku, qty: 0, revenue: 0, cogs: 0 });
      p.qty += Number(it.quantity) || 0; p.revenue += (Number(it.unitPrice) || 0) * (Number(it.quantity) || 0); p.cogs += (Number(it.unitCost) || 0) * (Number(it.quantity) || 0);
    }
    const r = reps[o.employeeId || 0] || (reps[o.employeeId || 0] = { name: o.employeeId ? repName[o.employeeId] || '—' : null, orders: 0, revenue: 0, commission: 0 });
    r.orders += 1; r.revenue += o.totalAmount; r.commission += o.commissionEarned;
    const c = channels[o.channel || 'manual'] || (channels[o.channel || 'manual'] = { orders: 0, revenue: 0 });
    c.orders += 1; c.revenue += o.totalAmount;
    const ps = payments[o.paymentStatus] || (payments[o.paymentStatus] = { orders: 0, revenue: 0 });
    ps.orders += 1; ps.revenue += o.totalAmount;
  }
  return {
    orders,
    products: Object.values(products).sort((a, b) => b.revenue - a.revenue),
    reps: Object.entries(reps).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.revenue - a.revenue),
    channels: Object.entries(channels).map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.revenue - a.revenue),
    payments: Object.entries(payments).map(([k, v]) => ({ key: k, ...v })),
  };
}

/** Expense matrix: category × last N months. */
function expenseMatrix(d, months = 6) {
  const series = fin.monthSeries(d, months).map((s) => s.month);
  const cats = {};
  for (const e of d.expenses) {
    const k = engine.toMonthKey(e.date);
    if (!series.includes(k)) continue; // eslint-disable-line no-continue
    const row = cats[e.category] || (cats[e.category] = Object.fromEntries(series.map((m) => [m, 0])));
    row[k] += e.amount;
  }
  return { months: series, rows: Object.entries(cats).map(([category, vals]) => ({ category, vals, total: Object.values(vals).reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total) };
}

module.exports = { pnl, pnlLines, monthly, salesAnalysis, expenseMatrix };
