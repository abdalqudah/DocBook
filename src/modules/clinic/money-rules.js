// ============================================================================
// DocBook clinic money rules (pure functions, unit-tested in test/money-rules.test.js):
//   checkoutAmounts()  ← healthcare.ts checkoutAppointment (discount maths)
//   commission()       ← commissions.ts calculateCommission
//   payroll()          ← payroll.ts calculatePayroll
// ============================================================================
const n = (v) => Number(v) || 0;
const { round } = require('../../core/money');

/**
 * Checkout. `amountPaid` is what the patient actually pays (already after the discount), exactly as the
 * DocBook front desk enters it; the pre-discount price and the discount amount are derived from it.
 */
function checkoutAmounts(amountPaid, discountPercent, currency = 'JOD') {
  const amount = n(amountPaid);
  const pct = n(discountPercent) > 0 ? Math.min(100, n(discountPercent)) : 0;
  if (pct >= 100) return { amount, discountPercent: 100, discountAmount: 0, originalAmount: amount };
  const originalAmount = pct > 0 ? amount / (1 - pct / 100) : amount;
  // At the currency's own precision (3 decimals for JOD), as every invoice is.
  const orig = round(originalAmount, currency);
  const discountAmount = pct > 0 ? round(orig - amount, currency) : 0;
  return { amount, discountPercent: pct, discountAmount, originalAmount: orig };
}

const BASES = ['percentage', 'fixed_per_visit', 'fixed_per_patient'];

/**
 * Doctor commission over a list of invoices.
 *  • percentage       → amount × rate / 100 per invoice
 *  • fixed_per_visit  → rate per invoice
 *  • fixed_per_patient→ unique patients × rule rate (replaces the per-line total, as in DocBook)
 * Service overrides (matched on the invoice's service name) replace basis/rate for that line.
 * Without a rule, revenue and counts are still reported but the commission is 0.
 * @param {{ basis, rate, serviceOverrides }|null} rule
 * @param {{ id, amount, serviceName, patientId }[]} invoices
 */
const r3 = (v) => round(Number(v) || 0, 'JOD'); // stored at 3 decimals

function commission(rule, invoices) {
  const patients = new Set();
  let totalRevenue = 0;
  let totalCommission = 0;
  const lines = [];
  for (const inv of invoices) {
    const amount = n(inv.amount);
    totalRevenue += amount;
    if (inv.patientId) patients.add(String(inv.patientId));
    if (!rule) { lines.push({ ...inv, amount, basisApplied: 'percentage', rateApplied: 0, commission: 0 }); continue; } // eslint-disable-line no-continue
    const override = (rule.serviceOverrides || []).find((o) => o.serviceName === inv.serviceName);
    const basisApplied = override ? override.basis : rule.basis;
    const rateApplied = override ? n(override.rate) : n(rule.rate);
    let c = 0;
    if (basisApplied === 'percentage') c = amount * (rateApplied / 100);
    else if (basisApplied === 'fixed_per_visit') c = rateApplied;
    lines.push({ ...inv, amount, basisApplied, rateApplied, commission: r3(c) });
    totalCommission += c;
  }
  if (rule && rule.basis === 'fixed_per_patient') totalCommission = patients.size * n(rule.rate);
  return { hasRule: Boolean(rule), totalRevenue: r3(totalRevenue), totalCommission: r3(totalCommission), visitCount: invoices.length, uniquePatientCount: patients.size, lines };
}

/** Net doctor pay for a period: base + commission + approved bonuses − approved deductions − approved advances. */
function payroll(baseSalary, commissionTotal, adjustments = []) {
  const approved = adjustments.filter((a) => a.approvalStatus === 'approved' || a.approval_status === 'approved');
  const sum = (type) => approved.filter((a) => a.type === type).reduce((s, a) => s + n(a.amount), 0);
  const bonuses = sum('bonus');
  const deductions = sum('deduction');
  const advances = sum('advance');
  // Each part at the stored precision (3 decimals), so net = the shown parts exactly.
  const [b, c, bo, de, ad] = [n(baseSalary), n(commissionTotal), bonuses, deductions, advances].map(r3);
  return { baseSalary: b, commission: c, bonuses: bo, deductions: de, advances: ad, netPayroll: r3(b + c + bo - de - ad) };
}

/** First and last day of a 'YYYY-MM' period. */
function periodRange(period) {
  if (!/^\d{4}-\d{2}$/.test(String(period))) return null;
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}

module.exports = { checkoutAmounts, commission, payroll, periodRange, BASES };
