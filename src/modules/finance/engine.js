// ============================================================================
// DocBook financial engine — ported from the original DocBook client bundle.
//
//   computeMetrics()   ← F$  (P&L, payroll, delivery, inventory, partner allocations)
//   campaignMetrics()  ← I$  (ROAS, ROI, CPC, CPA, CTR, campaign profit)
//   budgetStatus()     ← P$  (per-category spend vs monthly cap, warning/exceeded)
//   orderTotals() + orderCommission() ← the "create sales order" handler
//   toMonthKey()       ← y7  (date → YYYY-MM normaliser)
//
// The formulas, filters and edge cases are kept exactly as DocBook computes them;
// test/engine.test.js pins them. Inputs use DocBook's camelCase record shape
// (see finance.data.js, which maps database rows into it). All functions are pure.
// ============================================================================

/** y7: normalises 'YYYY-MM-DD', ISO timestamps, 'DD/MM/YYYY' or 'MM/DD/YYYY' to 'YYYY-MM'. */
function toMonthKey(value) {
  if (!value) return '';
  const s = String(value).trim();
  if (!s) return '';
  const iso = s.match(/^(\d{4})-(\d{1,2})(?:-|T|\s|$)/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}`;
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    const year = dmy[3];
    const month = a > 12 ? b : a;
    return `${year}-${String(month).padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Expense categories that are already counted through their own module (campaigns, payroll,
// shipments) and are therefore excluded from "daily OPEX" to avoid double counting.
const NON_OPEX_EXPENSE_CATEGORIES = new Set(['marketing', 'salaries', 'deliveries']);

const n = (v) => Number(v) || 0;

/** Monthly salary cost of one employee: base + bonus − deductions (advances are part of deductions). */
const monthlySalary = (e) => n(e.baseSalary) + n(e.bonus) - n(e.deductions);

/** Salaries recognised for the period: only months marked paid count; `inactive` employees never count. */
function salariesFor(employees, month) {
  return employees.reduce((sum, e) => {
    if (e.status === 'inactive') return sum;
    const pay = monthlySalary(e);
    const paid = e.paidMonths || [];
    if (month) return paid.includes(month) ? sum + pay : sum;
    return sum + pay * paid.length;
  }, 0);
}

/**
 * F$ — the complete P&L for a period (month 'YYYY-MM', or all time when `month` is empty).
 * @param {object} d { partners, expenses, employees, purchases, campaigns, orders, deliveries, financing }
 */
function computeMetrics(d, month) {
  const partners = d.partners || [];
  const employees = d.employees || [];
  const financing = d.financing || [];
  const inPeriod = (date) => (month ? toMonthKey(date) === month : true);

  const orders = (d.orders || []).filter((o) => inPeriod(o.date));
  const expenses = (d.expenses || []).filter((e) => inPeriod(e.date));
  const purchases = (d.purchases || []).filter((p) => inPeriod(p.date));
  const campaigns = (d.campaigns || []).filter((c) => inPeriod(c.startDate) || inPeriod(c.endDate));
  const deliveries = (d.deliveries || []).filter((s) => inPeriod(s.date));

  const totalRevenue = orders.reduce((s, o) => s + n(o.totalAmount), 0);
  const totalCogs = orders.reduce((s, o) => s + n(o.totalCogs), 0);
  const grossProfit = totalRevenue - totalCogs;
  const grossMarginPercent = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

  const totalDailyExpenses = expenses.filter((e) => !NON_OPEX_EXPENSE_CATEGORIES.has(e.category)).reduce((s, e) => s + n(e.amount), 0);

  const totalSalaries = salariesFor(employees, month);
  const totalCommissions = orders.reduce((s, o) => s + n(o.commissionEarned), 0);
  const totalPayroll = totalSalaries + totalCommissions;
  const totalPayrollObligation = employees.reduce((s, e) => (e.status === 'inactive' ? s : s + monthlySalary(e)), 0) + totalCommissions;

  const totalMarketingCost = campaigns.reduce((s, c) => s + n(c.cost), 0);

  // Courier cost: every shipment's fee paid, plus the delivery cost typed on orders that have no shipment record.
  const shippedOrderIds = new Set(deliveries.map((s) => String(s.orderId)));
  const shipmentFeesPaid = deliveries.reduce((s, x) => s + n(x.deliveryFeePaid ?? x.deliveryCostPaid), 0);
  const orderDeliveryCosts = orders.filter((o) => !shippedOrderIds.has(String(o.id))).reduce((s, o) => s + n(o.deliveryCost), 0);
  const totalDeliveryCostPaid = shipmentFeesPaid + orderDeliveryCosts;
  const totalDeliveryFeeCollected = deliveries.reduce((s, x) => s + n(x.deliveryFeeCollected), 0);
  const netDeliveryExpense = totalDeliveryCostPaid;

  const totalInventoryPurchased = purchases.reduce((s, p) => s + n(p.paidAmount), 0);
  const totalInventoryCommitment = purchases.reduce((s, p) => s + n(p.totalCost) + n(p.shippingCost), 0);
  const totalInventoryDue = Math.max(0, totalInventoryCommitment - totalInventoryPurchased);

  const totalFinancingPaid = financing.reduce((s, f) => s + n(f.monthlyInstallment), 0);

  const totalOperatingExpenses = totalDailyExpenses + totalPayroll + totalMarketingCost + netDeliveryExpense + totalFinancingPaid;
  const totalCashOutflow = totalDailyExpenses + totalPayroll + totalMarketingCost + totalDeliveryCostPaid + totalInventoryPurchased + totalFinancingPaid;
  const netProfit = grossProfit - totalOperatingExpenses;
  const netMarginPercent = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

  const partnerAllocations = partners.map((p) => {
    const share = n(p.currentEquityPercent) / 100;
    const allocatedProfit = netProfit * share;
    const netPayable = n(p.initialInvestment) + n(p.additionalContributions) + allocatedProfit - n(p.totalWithdrawn);
    return {
      partnerId: p.id,
      partnerName: p.name,
      equityPercent: n(p.currentEquityPercent),
      allocatedProfit,
      withdrawn: n(p.totalWithdrawn),
      netPayable,
    };
  });

  return {
    totalRevenue,
    totalCogs,
    grossProfit,
    grossMarginPercent,
    totalDailyExpenses,
    totalSalaries,
    totalCommissions,
    totalPayroll,
    totalPayrollObligation,
    totalMarketingCost,
    totalDeliveryCostPaid,
    totalDeliveryFeeCollected,
    netDeliveryExpense,
    totalInventoryPurchased,
    totalInventoryDue,
    totalInventoryCommitment,
    totalCashOutflow,
    totalFinancingPaid,
    totalOperatingExpenses,
    netProfit,
    netMarginPercent,
    partnerAllocations,
  };
}

/** I$ — per-campaign performance. */
function campaignMetrics(c) {
  const cost = n(c.cost);
  const revenue = n(c.revenueGenerated);
  const clicks = n(c.clicks);
  const impressions = n(c.impressions);
  const conversions = n(c.conversions);
  const netProfit = revenue - cost;
  return {
    roas: cost > 0 ? revenue / cost : 0,
    roi: cost > 0 ? (netProfit / cost) * 100 : 0,
    cpc: clicks > 0 ? cost / clicks : 0,
    cpa: conversions > 0 ? cost / conversions : 0,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    netProfit,
  };
}

/** Budget categories that are fed by another module rather than by expense records. */
const VIRTUAL_BUDGET_CATEGORIES = ['marketing', 'delivery', 'inventory_purchase', 'payroll'];

/** P$ — budget consumption per budget line for a period. */
function budgetStatus(budgets, d, month = '') {
  const inPeriod = (date) => !month || toMonthKey(date) === month;
  const expenses = (d.expenses || []).filter((e) => inPeriod(e.date));
  const campaigns = (d.campaigns || []).filter((c) => inPeriod(c.startDate) || inPeriod(c.endDate));
  const deliveries = (d.deliveries || []).filter((s) => inPeriod(s.date));
  const purchases = (d.purchases || []).filter((p) => inPeriod(p.date));
  const orders = (d.orders || []).filter((o) => inPeriod(o.date));
  const employees = d.employees || [];

  return budgets.map((b) => {
    let actualSpent = 0;
    if (b.category === 'marketing') actualSpent = campaigns.reduce((s, c) => s + n(c.cost), 0);
    else if (b.category === 'delivery') actualSpent = deliveries.reduce((s, x) => s + n(x.deliveryFeePaid), 0);
    else if (b.category === 'inventory_purchase') actualSpent = purchases.reduce((s, p) => s + n(p.paidAmount), 0);
    else if (b.category === 'payroll') actualSpent = salariesFor(employees, month) + orders.reduce((s, o) => s + n(o.commissionEarned), 0);
    else actualSpent = expenses.filter((e) => e.category === b.category).reduce((s, e) => s + n(e.amount), 0);

    const limit = n(b.monthlyBudget);
    const usagePercent = limit > 0 ? (actualSpent / limit) * 100 : 0;
    const isExceeded = actualSpent > limit;
    const isWarning = !isExceeded && usagePercent >= n(b.alertThresholdPercent);
    return {
      id: b.id,
      category: b.category,
      monthlyLimit: limit,
      actualSpent,
      remaining: Math.max(0, limit - actualSpent),
      usagePercent,
      thresholdPercent: n(b.alertThresholdPercent),
      isWarning,
      isExceeded,
      periodMonth: b.periodMonth || '',
    };
  });
}

/** Order totals exactly as the DocBook order form computes them. */
function orderTotals(items, discount, deliveryFee) {
  const subtotal = items.reduce((s, it) => s + n(it.unitPrice) * n(it.quantity), 0);
  const totalCogs = items.reduce((s, it) => s + n(it.unitCost) * n(it.quantity), 0);
  const totalAmount = Math.max(0, subtotal - n(discount) + n(deliveryFee));
  return { subtotal, totalCogs, totalAmount };
}

/**
 * Sales-rep commission for one order. The customer's region rate (if the rep has one for that region)
 * overrides the rep's default rate. percentage → total × rate / 100; fixed_per_order → the rate itself.
 */
function orderCommission(employee, totalAmount, customerRegion) {
  if (!employee) return 0;
  const regional = customerRegion ? (employee.regionCommissionRates || {})[customerRegion] : undefined;
  const rate = regional !== undefined && regional !== null && regional !== '' ? n(regional) : n(employee.commissionRate);
  return employee.commissionType === 'percentage' ? (n(totalAmount) * rate) / 100 : rate;
}

/** Purchase line: DocBook stores total_cost = unit × qty and derives the payment status from what was paid. */
function purchaseTotals({ unitCost, quantity, shippingCost, paidAmount }) {
  const totalCost = n(unitCost) * n(quantity);
  const payable = totalCost + n(shippingCost);
  const remaining = Math.max(0, payable - n(paidAmount));
  let paymentStatus = 'due';
  if (n(paidAmount) > 0 && remaining > 0.0005) paymentStatus = 'partial';
  else if (payable > 0 && remaining <= 0.0005) paymentStatus = 'paid';
  return { totalCost, payable, remaining, paymentStatus };
}

/** Sum of partner equity (DocBook warns when it is not exactly 100 %). */
const equityTotal = (partners) => partners.reduce((s, p) => s + n(p.currentEquityPercent), 0);

module.exports = {
  toMonthKey,
  computeMetrics,
  campaignMetrics,
  budgetStatus,
  orderTotals,
  orderCommission,
  purchaseTotals,
  equityTotal,
  monthlySalary,
  salariesFor,
  NON_OPEX_EXPENSE_CATEGORIES,
  VIRTUAL_BUDGET_CATEGORIES,
};
