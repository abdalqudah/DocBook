// Pure finance rules (no database): staff net pay, partner equity / profit share / balance, budget status, the
// income statement totals. Kept here so the rules are unit-tested on their own.
const round = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const num = (v) => Number(v) || 0;

/** Net pay = base + allowances + bonuses − (fixed deductions + one-off deductions) − advances. */
function netPay({ base = 0, allowances = 0, deductions = 0, bonuses = 0, extraDeductions = 0, advances = 0 }) {
  return round(num(base) + num(allowances) + num(bonuses) - num(deductions) - num(extraDeductions) - num(advances));
}

/** One-off adjustments summed by type. */
function sumAdjustments(adjs = []) {
  return adjs.reduce((t, a) => {
    if (a.type === 'bonus') t.bonuses = round(t.bonuses + num(a.amount));
    else if (a.type === 'deduction') t.extraDeductions = round(t.extraDeductions + num(a.amount));
    else if (a.type === 'advance') t.advances = round(t.advances + num(a.amount));
    return t;
  }, { bonuses: 0, extraDeductions: 0, advances: 0 });
}

/** Figures of a payroll line from its stored fixed parts plus its adjustments. */
function lineFigures(line, adjs = []) {
  const a = sumAdjustments(adjs);
  const f = { base: num(line.base_salary), allowances: num(line.allowances), deductions: num(line.deductions), ...a };
  return { ...f, net: netPay(f) };
}

/**
 * Equity check of the active partners. `total` is the sum; `state`: ok (=100), under (<100), over (>100).
 * Saving is blocked when over; distributions need exactly 100.
 */
function equityState(partners) {
  const total = round(partners.filter((p) => (p.status || 'active') === 'active').reduce((s, p) => s + num(p.equity_percent), 0));
  const state = Math.abs(total - 100) < 0.001 ? 'ok' : total > 100 ? 'over' : 'under';
  return { total, state };
}

/** Would setting `percent` on partner `id` (null for a new one) push the active total over 100? */
function equityAfter(partners, id, percent, status = 'active') {
  const others = partners.filter((p) => p.id !== id && (p.status || 'active') === 'active').reduce((s, p) => s + num(p.equity_percent), 0);
  return round(others + (status === 'active' ? num(percent) : 0));
}

/** Profit share of a partner: net profit × equity %. Losses are shared the same way. */
const profitShare = (netProfit, equityPercent) => round((num(netProfit) * num(equityPercent)) / 100);

/** Allocations of a month's net profit to partners (only active partners with equity). */
function allocate(netProfit, partners) {
  return partners.filter((p) => (p.status || 'active') === 'active' && num(p.equity_percent) > 0)
    .map((p) => ({ partnerId: p.id, name: p.name, equity: num(p.equity_percent), amount: profitShare(netProfit, p.equity_percent) }));
}

/** Balance = initial investment + injections + profit shares allocated − withdrawals. */
function partnerBalance(partner, txs = []) {
  const t = txs.reduce((acc, x) => {
    if (x.type === 'injection') acc.injections = round(acc.injections + num(x.amount));
    else if (x.type === 'withdrawal') acc.withdrawals = round(acc.withdrawals + num(x.amount));
    else if (x.type === 'profit_share') acc.profits = round(acc.profits + num(x.amount));
    return acc;
  }, { injections: 0, withdrawals: 0, profits: 0 });
  return { investment: num(partner.initial_investment), ...t, balance: round(num(partner.initial_investment) + t.injections + t.profits - t.withdrawals) };
}

/**
 * Budget status for a month. warn = at/over the alert threshold but within the limit; over = spent > limit.
 * A zero limit counts any spending as over.
 */
function budgetStatus(limit, spent, threshold = 80) {
  const l = num(limit); const s = round(spent);
  const usage = l > 0 ? (s * 100) / l : (s > 0 ? Infinity : 0);
  const over = s > l + 0.0005;
  const warn = !over && usage >= num(threshold);
  return { limit: l, spent: s, remaining: round(Math.max(0, l - s)), usage: Number.isFinite(usage) ? Math.round(usage * 10) / 10 : null, warn, over, state: over ? 'over' : warn ? 'warn' : 'ok' };
}

/**
 * Income statement totals. Revenue is net of discounts (what was collected); discounts are shown for information.
 * Costs = operating expenses (by category) + doctor payroll + staff salaries. Supplies received on purchase orders are
 * a memo line only: their bills are recorded as expenses, so adding them again would count them twice.
 */
function statement({ revenue = 0, discounts = 0, expenses = [], doctorPayroll = 0, staffSalaries = 0, suppliesReceived = 0 }) {
  const opex = round(expenses.reduce((s, e) => s + num(e.amount), 0));
  const payroll = round(num(doctorPayroll) + num(staffSalaries));
  const costs = round(opex + payroll);
  const net = round(num(revenue) - costs);
  return {
    gross: round(num(revenue) + num(discounts)), discounts: round(discounts), revenue: round(revenue), expenses, opex,
    doctorPayroll: round(doctorPayroll), staffSalaries: round(staffSalaries), payroll, costs, net,
    margin: num(revenue) ? Math.round(((net * 100) / num(revenue)) * 10) / 10 : null, suppliesReceived: round(suppliesReceived),
  };
}

/** Change from a previous value in % (null when there is nothing to compare with). */
function delta(cur, prev) {
  const p = num(prev);
  if (!p) return null;
  return Math.round(((num(cur) - p) * 1000) / Math.abs(p)) / 10;
}

// ---- periods
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
/** Months list from..to inclusive. */
function monthsBetween(from, to) {
  const out = [];
  for (let m = from; m <= to && out.length < 240; m = addMonths(m, 1)) out.push(m);
  return out;
}
/**
 * A reporting period: kind month|quarter|year and a key (YYYY-MM | YYYY-Qn | YYYY) → { kind, key, fromMonth, toMonth,
 * from, to, prev } ; unknown input falls back to the month of `today`.
 */
function resolvePeriod(kind, key, today) {
  const cur = String(today).slice(0, 7);
  if (kind === 'year' && /^\d{4}$/.test(String(key))) {
    const p = { kind, key: String(key), fromMonth: `${key}-01`, toMonth: `${key}-12` };
    return finish(p, 'year', String(Number(key) - 1));
  }
  if (kind === 'quarter' && /^\d{4}-Q[1-4]$/.test(String(key))) {
    const [y, q] = String(key).split('-Q').map(Number);
    const fm = `${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}`;
    const p = { kind, key: String(key), fromMonth: fm, toMonth: addMonths(fm, 2) };
    const prevKey = q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`;
    return finish(p, 'quarter', prevKey);
  }
  const m = isMonth(key) ? key : cur;
  return finish({ kind: 'month', key: m, fromMonth: m, toMonth: m }, 'month', addMonths(m, -1));
}
function finish(p, kind, prevKey) {
  return { ...p, from: `${p.fromMonth}-01`, to: monthEnd(p.toMonth), months: monthsBetween(p.fromMonth, p.toMonth), prevKind: kind, prevKey };
}
const quarterOf = (month) => `${month.slice(0, 4)}-Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}`;

module.exports = {
  round, netPay, sumAdjustments, lineFigures, equityState, equityAfter, profitShare, allocate, partnerBalance, budgetStatus, statement, delta,
  isMonth, addMonths, monthEnd, monthsBetween, resolvePeriod, quarterOf,
};
