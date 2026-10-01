// Package price by number of branches. One branch costs the plan's own price (price_monthly / price_yearly); the
// platform admin can set the full price for 2, 3 … branches (ROWS rows) and a price for each branch beyond those.
// Stored in subscription_plans.branch_prices as { tiers: { "2": { m, y }, … }, extra: { m, y } | null }.
// Rule for N branches: the tier price for N when set, else the price for N−1 plus the "each extra branch" price
// (nothing added when that is not set either). How many branches a plan allows is the entitlement clinic.max_branches.
const ROWS = [2, 3, 4, 5];
const MAX_CHOICE = 50; // a plan without a branch limit still offers a finite list

const num = (v) => { if (v === '' || v === undefined || v === null) return null; const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) && n >= 0 && n <= 1e7 ? Math.round(n * 1000) / 1000 : null; };

function parse(v) {
  let o = v;
  if (typeof v === 'string') { try { o = JSON.parse(v); } catch { o = null; } }
  const tiers = {};
  if (o && o.tiers && typeof o.tiers === 'object') {
    for (const [k, t] of Object.entries(o.tiers)) {
      const n = Number(k);
      if (Number.isInteger(n) && n >= 2 && n <= MAX_CHOICE && t) { const m = num(t.m); const y = num(t.y); if (m !== null || y !== null) tiers[n] = { m, y }; }
    }
  }
  const extra = o && o.extra ? { m: num(o.extra.m), y: num(o.extra.y) } : null;
  return { tiers, extra: extra && (extra.m !== null || extra.y !== null) ? extra : null };
}

/** The admin plan form (bp_m_<n>, bp_y_<n>, bp_extra_m, bp_extra_y) → the stored shape. */
function fromForm(input) {
  const tiers = {};
  for (const n of ROWS) { const m = num(input[`bp_m_${n}`]); const y = num(input[`bp_y_${n}`]); if (m !== null || y !== null) tiers[n] = { m, y }; }
  const extra = { m: num(input.bp_extra_m), y: num(input.bp_extra_y) };
  return { tiers, extra: extra.m !== null || extra.y !== null ? extra : null };
}

/** Price of `plan` for `branches` branches and a billing cycle ('monthly' | 'yearly'). */
function priceFor(plan, branches, cycle) {
  const k = cycle === 'yearly' ? 'y' : 'm';
  const bp = parse(plan.branch_prices);
  let p = Number(cycle === 'yearly' ? plan.price_yearly : plan.price_monthly) || 0;
  for (let n = 2; n <= Math.max(1, Number(branches) || 1); n += 1) {
    const tier = bp.tiers[n];
    if (tier && tier[k] !== null && tier[k] !== undefined) p = tier[k];
    else if (bp.extra && bp.extra[k] !== null) p += bp.extra[k];
  }
  return Math.round(p * 1000) / 1000;
}

/** The branch counts a plan offers (1 … its limit; a plan without a limit offers up to MAX_CHOICE). */
const choices = (maxBranches) => Array.from({ length: Math.min(MAX_CHOICE, maxBranches === null || maxBranches === undefined ? MAX_CHOICE : Math.max(1, maxBranches)) }, (_, i) => i + 1);

/** The plan's price list for the branch counts it offers (for the plan cards: { 1: { m, y }, 2: … }), up to `upTo`. */
function table(plan, maxBranches, upTo = 10) {
  return Object.fromEntries(choices(maxBranches).slice(0, upTo).map((n) => [n, { m: priceFor(plan, n, 'monthly'), y: priceFor(plan, n, 'yearly') }]));
}

module.exports = { ROWS, MAX_CHOICE, parse, fromForm, priceFor, choices, table };
