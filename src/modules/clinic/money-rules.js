// ============================================================================
// DocBook clinic money rules (pure functions, unit-tested in test/money-rules.test.js):
//   checkoutAmounts()  ← healthcare.ts checkoutAppointment (discount maths)
//   commission()       ← commissions.ts calculateCommission
//   payroll()          ← payroll.ts calculatePayroll
// ============================================================================
const n = (v) => Number(v) || 0;
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Checkout. `amountPaid` is what the patient actually pays (already after the discount), exactly as the
 * DocBook front desk enters it; the pre-discount price and the discount amount are derived from it.
 */
function checkoutAmounts(amountPaid, discountPercent) {
  const amount = n(amountPaid);
  const pct = n(discountPercent) > 0 ? Math.min(100, n(discountPercent)) : 0;
  if (pct >= 100) return { amount, discountPercent: 100, discountAmount: 0, originalAmount: amount };
  const originalAmount = pct > 0 ? amount / (1 - pct / 100) : amount;
  const discountAmount = pct > 0 ? r2(originalAmount - amount) : 0;
  return { amount, discountPercent: pct, discountAmount, originalAmount: r2(originalAmount) };
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
    lines.push({ ...inv, amount, basisApplied, rateApplied, commission: c });
    totalCommission += c;
  }
  if (rule && rule.basis === 'fixed_per_patient') totalCommission = patients.size * n(rule.rate);
  return { hasRule: Boolean(rule), totalRevenue, totalCommission, visitCount: invoices.length, uniquePatientCount: patients.size, lines };
}

/** Net doctor pay for a period: base + commission + approved bonuses − approved deductions − approved advances. */
function payroll(baseSalary, commissionTotal, adjustments = []) {
  const approved = adjustments.filter((a) => a.approvalStatus === 'approved' || a.approval_status === 'approved');
  const sum = (type) => approved.filter((a) => a.type === type).reduce((s, a) => s + n(a.amount), 0);
  const bonuses = sum('bonus');
  const deductions = sum('deduction');
  const advances = sum('advance');
  return { baseSalary: n(baseSalary), commission: n(commissionTotal), bonuses, deductions, advances, netPayroll: n(baseSalary) + n(commissionTotal) + bonuses - deductions - advances };
}

/** First and last day of a 'YYYY-MM' period. */
function periodRange(period) {
  if (!/^\d{4}-\d{2}$/.test(String(period))) return null;
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}

module.exports = { checkoutAmounts, commission, payroll, periodRange, BASES };
