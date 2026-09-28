// Loads a workspace's records in the camelCase shape the DocBook engine expects, and caches the
// result briefly (any successful write clears the `fin:<businessId>` prefix — see middleware/context).
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const engine = require('./engine');

const num = (v) => Number(v) || 0;
const arr = (v) => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v || '[]'); } catch { return []; } })());
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : (() => { try { const o = JSON.parse(v || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } })());

const mapPartner = (r) => ({ id: r.id, name: r.name, phone: r.phone, email: r.email, initialInvestment: num(r.initial_investment), additionalContributions: num(r.additional_contributions), totalWithdrawn: num(r.total_withdrawn), currentEquityPercent: num(r.current_equity_percent), joinDate: r.join_date, notes: r.notes, color: r.color, status: r.status });
const mapExpense = (r) => ({ id: r.id, date: r.date, category: r.category, title: r.title, amount: num(r.amount), paymentMethod: r.payment_method, invoiceNumber: r.invoice_number, recordedBy: r.recorded_by, notes: r.notes });
const mapEmployee = (r) => ({ id: r.id, name: r.name, role: r.role, phone: r.phone, email: r.email, baseSalary: num(r.base_salary), commissionType: r.commission_type, commissionRate: num(r.commission_rate), deductions: num(r.deductions), bonus: num(r.bonus), hireDate: r.hire_date, status: r.status, bankAccount: r.bank_account, notes: r.notes, paidMonths: arr(r.paid_months), regionCommissionRates: obj(r.region_commission_rates) });
const mapPurchase = (r) => ({ id: r.id, date: r.date, supplierName: r.supplier_name, supplierPhone: r.supplier_phone, itemName: r.item_name, sku: r.sku, category: r.category, unitCost: num(r.unit_cost), quantity: num(r.quantity), totalCost: num(r.total_cost), shippingCost: num(r.shipping_cost), paidAmount: num(r.paid_amount), paymentStatus: r.payment_status, invoiceRef: r.invoice_ref, notes: r.notes });
const mapCampaign = (r) => ({ id: r.id, campaignName: r.campaign_name, platform: r.platform, startDate: r.start_date, endDate: r.end_date, cost: num(r.cost), impressions: num(r.impressions), clicks: num(r.clicks), conversions: num(r.conversions), revenueGenerated: num(r.revenue_generated), status: r.status, targetProduct: r.target_product, notes: r.notes });
const mapOrder = (r) => ({ id: r.id, orderNumber: r.order_number, date: r.date, customerId: r.customer_id, customerName: r.customer_name, customerPhone: r.customer_phone, customerEmail: r.customer_email, items: arr(r.items), subtotal: num(r.subtotal), discount: num(r.discount), deliveryFee: num(r.delivery_fee), totalAmount: num(r.total_amount), totalCogs: num(r.total_cogs), employeeId: r.employee_id, commissionEarned: num(r.commission_earned), deliveryCourier: r.delivery_courier, deliveryCost: num(r.delivery_cost), paymentStatus: r.payment_status, channel: r.channel, notes: r.notes });
const mapDelivery = (r) => ({ id: r.id, orderId: r.order_id, courierCompany: r.courier_company, courierName: r.courier_name, courierPhone: r.courier_phone, trackingNumber: r.tracking_number, customerName: r.customer_name, customerPhone: r.customer_phone, destinationCity: r.destination_city, address: r.address, deliveryFeePaid: num(r.delivery_fee_paid), deliveryFeeCollected: num(r.delivery_fee_collected), status: r.status, date: r.date, notes: r.notes, cashRemitted: Boolean(r.cash_remitted) });
const mapBudget = (r) => ({ id: r.id, category: r.category, monthlyBudget: num(r.monthly_budget), alertThresholdPercent: num(r.alert_threshold_percent), periodMonth: r.period_month || '' });

async function loadRaw(businessId) {
  const w = { business_id: businessId };
  const [partners, expenses, employees, purchases, campaigns, orders, deliveries, budgets] = await Promise.all([
    knex('partners').where(w).orderBy('id'),
    knex('expenses').where(w).orderBy('date', 'desc'),
    knex('employees').where(w).orderBy('name'),
    knex('purchases').where(w).orderBy('date', 'desc'),
    knex('campaigns').where(w).orderBy('start_date', 'desc'),
    knex('orders').where(w).orderBy('date', 'desc'),
    knex('deliveries').where(w).orderBy('date', 'desc'),
    knex('budgets').where(w).orderBy('id'),
  ]);
  return {
    partners: partners.map(mapPartner), expenses: expenses.map(mapExpense), employees: employees.map(mapEmployee), purchases: purchases.map(mapPurchase),
    campaigns: campaigns.map(mapCampaign), orders: orders.map(mapOrder), deliveries: deliveries.map(mapDelivery), budgets: budgets.map(mapBudget), financing: [],
  };
}

/** All of a workspace's records (engine shape). Cached ~30 s; invalidated on every write. */
const load = (businessId) => cache.remember(`fin:${businessId}:data`, () => loadRaw(businessId), 30_000);

/** Budgets that apply to a period: those for that month plus recurring ones (no month set). */
const budgetsFor = (budgets, month) => budgets.filter((b) => !b.periodMonth || !month || b.periodMonth === month);

async function snapshot(businessId, month) {
  const d = await load(businessId);
  const metrics = engine.computeMetrics(d, month);
  const budgetLines = engine.budgetStatus(budgetsFor(d.budgets, month), d, month);
  return { data: d, metrics, budgetLines };
}

/** Months that have any activity (newest first), plus the current month — for period pickers. */
function periodOptions(d) {
  const set = new Set([new Date().toISOString().slice(0, 7)]);
  for (const list of [d.orders, d.expenses, d.purchases, d.deliveries]) for (const r of list) { const k = engine.toMonthKey(r.date); if (k) set.add(k); }
  for (const c of d.campaigns) { const k = engine.toMonthKey(c.startDate); if (k) set.add(k); }
  for (const e of d.employees) for (const m of e.paidMonths) set.add(m);
  return [...set].filter(Boolean).sort().reverse().slice(0, 36);
}

/** Month series (oldest → newest) for trend charts. */
function monthSeries(d, months = 12) {
  const now = new Date();
  const keys = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(dt.toISOString().slice(0, 7));
  }
  return keys.map((k) => ({ month: k, ...engine.computeMetrics(d, k) }));
}

/** ?month=YYYY-MM | all ; default = current month. */
function monthFromQuery(q, fallback = new Date().toISOString().slice(0, 7)) {
  if (q === 'all') return '';
  return /^\d{4}-\d{2}$/.test(q || '') ? q : fallback;
}

module.exports = { load, snapshot, periodOptions, monthSeries, monthFromQuery, budgetsFor, mapPartner, mapExpense, mapEmployee, mapPurchase, mapCampaign, mapOrder, mapDelivery, mapBudget };
