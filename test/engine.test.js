// Pins the DocBook formulas ported into src/modules/finance/engine.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/modules/finance/engine');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('toMonthKey normalises DocBook date formats', () => {
  assert.equal(E.toMonthKey('2026-09-14'), '2026-09');
  assert.equal(E.toMonthKey('2026-9-1'), '2026-09');
  assert.equal(E.toMonthKey('2026-09-14T10:00:00Z'), '2026-09');
  assert.equal(E.toMonthKey('25/09/2026'), '2026-09'); // day > 12 → DD/MM
  assert.equal(E.toMonthKey('09/05/2026'), '2026-09'); // ambiguous → first part is the month
  assert.equal(E.toMonthKey(''), '');
  assert.equal(E.toMonthKey(null), '');
});

const data = () => ({
  partners: [
    { id: 1, name: 'A', initialInvestment: 10000, additionalContributions: 2000, totalWithdrawn: 500, currentEquityPercent: 60 },
    { id: 2, name: 'B', initialInvestment: 5000, additionalContributions: 0, totalWithdrawn: 0, currentEquityPercent: 40 },
  ],
  orders: [
    { id: 11, date: '2026-09-02', totalAmount: 1000, totalCogs: 400, commissionEarned: 50, deliveryCost: 7 },
    { id: 12, date: '2026-09-10', totalAmount: 500, totalCogs: 200, commissionEarned: 0, deliveryCost: 5 }, // shipped below → cost excluded
    { id: 13, date: '2026-08-30', totalAmount: 9999, totalCogs: 1, commissionEarned: 999, deliveryCost: 99 },
  ],
  expenses: [
    { date: '2026-09-01', category: 'rent', amount: 300 },
    { date: '2026-09-03', category: 'marketing', amount: 1000 }, // excluded from OPEX
    { date: '2026-09-04', category: 'salaries', amount: 1000 },  // excluded from OPEX
    { date: '2026-09-05', category: 'deliveries', amount: 1000 },// excluded from OPEX
    { date: '2026-08-05', category: 'rent', amount: 300 },
  ],
  employees: [
    { status: 'active', baseSalary: 400, bonus: 50, deductions: 30, paidMonths: ['2026-09', '2026-08'] },
    { status: 'on_leave', baseSalary: 200, bonus: 0, deductions: 0, paidMonths: ['2026-09'] },
    { status: 'inactive', baseSalary: 999, bonus: 0, deductions: 0, paidMonths: ['2026-09'] },
    { status: 'active', baseSalary: 100, bonus: 0, deductions: 0, paidMonths: [] },
  ],
  campaigns: [
    { startDate: '2026-08-20', endDate: '2026-09-05', cost: 120 }, // ends in Sept → counts
    { startDate: '2026-07-01', endDate: '2026-07-30', cost: 999 },
  ],
  deliveries: [
    { date: '2026-09-11', orderId: 12, deliveryFeePaid: 4, deliveryFeeCollected: 6 },
  ],
  purchases: [
    { date: '2026-09-01', totalCost: 800, shippingCost: 50, paidAmount: 600 },
  ],
});

test('computeMetrics reproduces the DocBook P&L for a month', () => {
  const m = E.computeMetrics(data(), '2026-09');
  assert.equal(m.totalRevenue, 1500);
  assert.equal(m.totalCogs, 600);
  assert.equal(m.grossProfit, 900);
  close(m.grossMarginPercent, 60);
  assert.equal(m.totalDailyExpenses, 300);
  assert.equal(m.totalSalaries, 420 + 200); // active paid + on_leave paid; inactive never; unpaid never
  assert.equal(m.totalCommissions, 50);
  assert.equal(m.totalPayroll, 670);
  assert.equal(m.totalPayrollObligation, 420 + 200 + 100 + 50);
  assert.equal(m.totalMarketingCost, 120);
  assert.equal(m.totalDeliveryCostPaid, 4 + 7); // shipment fee + order 11's own delivery cost (order 12 has a shipment)
  assert.equal(m.totalDeliveryFeeCollected, 6);
  assert.equal(m.netDeliveryExpense, 11);
  assert.equal(m.totalInventoryPurchased, 600);
  assert.equal(m.totalInventoryCommitment, 850);
  assert.equal(m.totalInventoryDue, 250);
  assert.equal(m.totalOperatingExpenses, 300 + 670 + 120 + 11);
  assert.equal(m.netProfit, 900 - 1101);
  close(m.netMarginPercent, (-201 / 1500) * 100);
  assert.equal(m.totalCashOutflow, 300 + 670 + 120 + 11 + 600);
  const [a, b] = m.partnerAllocations;
  close(a.allocatedProfit, -201 * 0.6);
  close(a.netPayable, 10000 + 2000 + (-201 * 0.6) - 500);
  close(b.allocatedProfit, -201 * 0.4);
});

test('computeMetrics with no period multiplies salaries by paid months', () => {
  const m = E.computeMetrics(data(), '');
  assert.equal(m.totalSalaries, 420 * 2 + 200);
  assert.equal(m.totalRevenue, 11499);
});

test('campaignMetrics', () => {
  const c = E.campaignMetrics({ cost: 200, revenueGenerated: 900, clicks: 400, impressions: 20000, conversions: 10 });
  assert.equal(c.roas, 4.5);
  assert.equal(c.roi, 350);
  assert.equal(c.cpc, 0.5);
  assert.equal(c.cpa, 20);
  assert.equal(c.ctr, 2);
  assert.equal(c.netProfit, 700);
  const z = E.campaignMetrics({ cost: 0 });
  assert.deepEqual([z.roas, z.roi, z.cpc, z.cpa, z.ctr], [0, 0, 0, 0, 0]);
});

test('budgetStatus uses module-specific spend and threshold rules', () => {
  const budgets = [
    { id: 1, category: 'rent', monthlyBudget: 350, alertThresholdPercent: 80 },
    { id: 2, category: 'marketing', monthlyBudget: 100, alertThresholdPercent: 80 },
    { id: 3, category: 'payroll', monthlyBudget: 2000, alertThresholdPercent: 80 },
    { id: 4, category: 'inventory_purchase', monthlyBudget: 600, alertThresholdPercent: 90 },
    { id: 5, category: 'delivery', monthlyBudget: 0, alertThresholdPercent: 80 },
  ];
  const [rent, mkt, pay, inv, del] = E.budgetStatus(budgets, data(), '2026-09');
  assert.equal(rent.actualSpent, 300); assert.ok(rent.isWarning); assert.ok(!rent.isExceeded); close(rent.remaining, 50);
  assert.equal(mkt.actualSpent, 120); assert.ok(mkt.isExceeded); assert.ok(!mkt.isWarning); assert.equal(mkt.remaining, 0);
  assert.equal(pay.actualSpent, 670); assert.ok(!pay.isWarning);
  assert.equal(inv.actualSpent, 600); assert.ok(inv.isWarning); assert.ok(!inv.isExceeded); // exactly at the cap is not "exceeded"
  assert.equal(del.usagePercent, 0); assert.ok(del.isExceeded); // any spend over a zero cap is exceeded
});

test('order totals and commission (region rate overrides default)', () => {
  const t = E.orderTotals([{ unitPrice: 10, unitCost: 4, quantity: 3 }, { unitPrice: 5, unitCost: 1, quantity: 2 }], 5, 3);
  assert.deepEqual(t, { subtotal: 40, totalCogs: 14, totalAmount: 38 });
  assert.equal(E.orderTotals([{ unitPrice: 1, quantity: 1 }], 10, 0).totalAmount, 0); // never negative
  const rep = { commissionType: 'percentage', commissionRate: 5, regionCommissionRates: { North: 8 } };
  close(E.orderCommission(rep, 200, ''), 10);
  close(E.orderCommission(rep, 200, 'North'), 16);
  close(E.orderCommission(rep, 200, 'South'), 10);
  assert.equal(E.orderCommission({ commissionType: 'fixed_per_order', commissionRate: 3 }, 999, ''), 3);
  assert.equal(E.orderCommission(null, 100, ''), 0);
});

test('purchase totals derive payable, remaining and status', () => {
  assert.deepEqual(E.purchaseTotals({ unitCost: 10, quantity: 5, shippingCost: 5, paidAmount: 0 }), { totalCost: 50, payable: 55, remaining: 55, paymentStatus: 'due' });
  assert.equal(E.purchaseTotals({ unitCost: 10, quantity: 5, shippingCost: 5, paidAmount: 20 }).paymentStatus, 'partial');
  assert.equal(E.purchaseTotals({ unitCost: 10, quantity: 5, shippingCost: 5, paidAmount: 55 }).paymentStatus, 'paid');
});
