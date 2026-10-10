// Monthly budgets: a limit per expense category, or for staff salaries, doctor payroll and supplies received on
// purchase orders. Usage comes from the same monthly figures as the profit & loss (pnl.service.monthly), so a budget
// and the statement never disagree. When a budget reaches its alert threshold, and again when it is exceeded, people
// holding finance.view (owners, managers, accountants) get ONE notification per budget per month (dedupe key).
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { z, validate, money } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const { translator } = require('../../core/i18n');
const notifications = require('../notifications/notification.service');
const expenses = require('../expenses/expense.service');
const { clinicNow } = require('../clinic/scheduling');
const pnl = require('./pnl.service');
const m = require('./math');

const SPECIAL = ['staff_salaries', 'doctor_payroll', 'supplies'];

/** Every scope a budget can have: special ones first, then the clinic's expense categories. */
async function scopes(businessId) {
  const { system, custom } = await expenses.categories(businessId);
  return [...SPECIAL.map((k) => ({ key: k, special: true })), ...system.map((k) => ({ key: `cat:${k}`, category: k })), ...custom.map((c) => ({ key: `cat:${c.key}`, category: c.key, name: c.name }))];
}

/** Label of a scope in a locale (t = translator); custom category names come from the clinic. */
function scopeLabel(t, scopeKey, customNames = {}) {
  if (SPECIAL.includes(scopeKey)) return t(`budgets.scope.${scopeKey}`);
  const cat = scopeKey.slice(4);
  if (customNames[cat]) return customNames[cat];
  const k = `categories.${cat}`;
  const tr = t(k);
  return tr === k ? cat : tr;
}

async function customNames(businessId) {
  const rows = await knex('expense_categories').where({ business_id: businessId }).select('key', 'name');
  return Object.fromEntries(rows.map((r) => [r.key, r.name]));
}

// Budgets per branch (budgets.branch_key: null = the whole clinic, 'main' or a branch id): a member sees the budgets
// of the branch chosen in the account menu; "all branches" shows the whole clinic's.
const keyOf = (ctx) => (ctx && ctx.workBranch ? String(ctx.workBranch) : null);
const inBranch = (q, ctx) => { if (ctx === undefined) return q; const k = keyOf(ctx); return k ? q.where('branch_key', k) : q.whereNull('branch_key'); };
const list = (businessId, ctx) => inBranch(knex('budgets').where({ business_id: businessId }), ctx).orderBy('id');

async function get(ctx, id) {
  const b = await inBranch(knex('budgets').where({ id, business_id: ctx.businessId }), ctx).first();
  if (!b) throw E.notFound('Budget');
  return b;
}

async function save(ctx, id, input) {
  const keys = (await scopes(ctx.businessId)).map((s) => s.key);
  const d = validate(z.object({
    scope_key: z.string().refine((v) => keys.includes(v), 'Choose a valid value.'),
    monthly_limit: money().refine((v) => v > 0, 'Too small.'),
    threshold_percent: z.preprocess((v) => (v === '' || v === undefined || v === null ? 80 : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(1, 'Must be between 0 and 100.').max(100, 'Must be between 0 and 100.')),
    is_active: z.preprocess((v) => v === true || v === '1' || v === 'on' || v === 'true' || v === 1, z.boolean()),
  }), { ...input, is_active: [].concat(input.is_active).pop() });
  const dup = await inBranch(knex('budgets').where({ business_id: ctx.businessId, scope_key: d.scope_key }), ctx).modify((q) => { if (id) q.whereNot('id', id); }).first('id');
  if (dup) throw new AppError('BUDGET_EXISTS', 'There is already a budget for this category.', 409);
  if (id) {
    const before = await get(ctx, id);
    await knex('budgets').where({ id: before.id }).update({ ...d, updated_at: new Date() });
    await audit.record(ctx, 'budget.updated', { entityType: 'budget', entityId: id, oldValues: { scope: before.scope_key, limit: Number(before.monthly_limit), threshold: before.threshold_percent, active: !!before.is_active }, newValues: { scope: d.scope_key, limit: d.monthly_limit, threshold: d.threshold_percent, active: d.is_active } });
    return before.id;
  }
  const [newId] = await knex('budgets').insert({ ...d, business_id: ctx.businessId, branch_key: keyOf(ctx) });
  await audit.record(ctx, 'budget.created', { entityType: 'budget', entityId: newId, newValues: { scope: d.scope_key, limit: d.monthly_limit, threshold: d.threshold_percent } });
  return newId;
}

async function remove(ctx, id) {
  const b = await get(ctx, id);
  await knex('budgets').where({ id: b.id }).del();
  await audit.record(ctx, 'budget.deleted', { entityType: 'budget', entityId: b.id, oldValues: { scope: b.scope_key, limit: Number(b.monthly_limit) } });
}

/** Amount spent in one month's figures (pnl.monthly entry) against a scope. */
function spentIn(month, scopeKey) {
  if (!month) return 0;
  if (scopeKey === 'staff_salaries') return month.staffSalaries;
  if (scopeKey === 'doctor_payroll') return month.doctorPayroll;
  if (scopeKey === 'supplies') return month.supplies;
  if (scopeKey.startsWith('cat:')) return month.byCat[scopeKey.slice(4)] || 0;
  return 0;
}

/**
 * Budgets of a clinic with their status for `month` and a history of the `historyMonths` months before and including it.
 * @returns [{ ...budget, status, history: [{ month, status }] }]
 */
async function evaluate(businessId, timezone, month, { historyMonths = 6, budgets = null, ctx } = {}) {
  const rows = budgets || await list(businessId, ctx);
  if (!rows.length) return [];
  const first = m.addMonths(month, -(historyMonths - 1));
  // each budget against its own branch's figures (the whole clinic's for a clinic-wide budget)
  const byKey = {};
  for (const k of [...new Set(rows.map((b) => b.branch_key || ''))]) { // eslint-disable-line no-restricted-syntax
    byKey[k] = await pnl.monthly(businessId, timezone, first, month, k ? { businessId, workBranch: k } : null); // eslint-disable-line no-await-in-loop
  }
  return rows.map((b) => ({ months: byKey[b.branch_key || ''], b })).map(({ months, b }) => ({
    ...b,
    monthly_limit: Number(b.monthly_limit),
    status: m.budgetStatus(b.monthly_limit, spentIn(months[month], b.scope_key), b.threshold_percent),
    history: m.monthsBetween(first, month).map((k) => ({ month: k, status: m.budgetStatus(b.monthly_limit, spentIn(months[k], b.scope_key), b.threshold_percent) })),
  }));
}

/**
 * Sends the threshold / exceeded notifications of `month` (idempotent: one of each per budget per month).
 * @returns the number of new notifications
 */
async function check(businessId, timezone, month) {
  const active = (await knex('budgets').where({ business_id: businessId }).orderBy('id')).filter((b) => b.is_active);
  if (!active.length) return 0;
  const evald = await evaluate(businessId, timezone, month, { historyMonths: 1, budgets: active });
  const cfg = await knex('clinic_messaging').where({ business_id: businessId }).first('message_locale').catch(() => null);
  const loc = cfg && cfg.message_locale === 'en' ? 'en' : 'ar';
  const t = translator(loc);
  const names = await customNames(businessId);
  const fmtMoney = require('../../core/format').formatMoney; // eslint-disable-line global-require
  const biz = await knex('businesses').where({ id: businessId }).first('currency');
  let sent = 0;
  for (const b of evald) {
    const s = b.status;
    if (s.state === 'ok') continue; // eslint-disable-line no-continue
    const kind = s.over ? 'over' : 'warn';
    const dedupeKey = `budget:${b.id}:${month}:${kind}`;
    const exists = await knex('notifications').where({ business_id: businessId, dedupe_key: dedupeKey }).first('id'); // eslint-disable-line no-await-in-loop
    if (exists) continue; // eslint-disable-line no-continue
    const label = scopeLabel(t, b.scope_key, names);
    const vars = { name: label, pct: s.usage === null ? '—' : s.usage, spent: fmtMoney(s.spent, biz.currency, loc), limit: fmtMoney(s.limit, biz.currency, loc) };
    await notifications.notify(businessId, { // eslint-disable-line no-await-in-loop
      permission: 'finance.view', type: `budget.${kind}`, severity: s.over ? 'danger' : 'warning',
      title: t(s.over ? 'budgets.notify_over' : 'budgets.notify_warn', vars), body: t('budgets.notify_body', vars), link: `/app/budgets?month=${month}`, dedupeKey, branchKey: b.branch_key || null,
    });
    sent += 1;
  }
  return sent;
}

/** check() for the clinic's current month (after an expense / salary is saved). Never throws. */
async function checkNow(businessId, timezone) {
  try { return await check(businessId, timezone, clinicNow(timezone).date.slice(0, 7)); } catch (e) { console.error('[budgets]', e.message); return 0; } // eslint-disable-line no-console
}

/** Daily job: every clinic with an active budget. */
async function runDue() {
  const rows = await knex('budgets as b').join('businesses as z', 'z.id', 'b.business_id').where('b.is_active', true).distinct('b.business_id', 'z.timezone');
  let n = 0;
  for (const r of rows) n += await checkNow(r.business_id, r.timezone); // eslint-disable-line no-await-in-loop
  return n;
}

module.exports = { SPECIAL, scopes, scopeLabel, customNames, list, get, save, remove, spentIn, evaluate, check, checkNow, runDue };
