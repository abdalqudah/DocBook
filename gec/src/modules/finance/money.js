// Money arithmetic in cents (integers), so totals never drift. Values in the database are DECIMAL(12,2).
const cents = (v) => Math.round(Number(v || 0) * 100);
const fromCents = (c) => Math.round(c) / 100;

/** items: [{ quantity, unit_price }] → { items (with amount), subtotal, discount, tax, total } (numbers, 2 dp). */
function totals(items, { discount = 0, taxRate = 0 } = {}) {
  const rows = items.map((it) => ({ ...it, amount: fromCents(Math.round(Number(it.quantity) * cents(it.unit_price))) }));
  const sub = rows.reduce((s, r) => s + cents(r.amount), 0);
  const disc = Math.min(sub, Math.max(0, cents(discount)));
  const tax = Math.round(((sub - disc) * Number(taxRate || 0)) / 100);
  return { items: rows, subtotal: fromCents(sub), discount: fromCents(disc), tax: fromCents(tax), total: fromCents(sub - disc + tax) };
}

module.exports = { cents, fromCents, totals };
