// Budgets — DocBook's monthly caps with an early-warning threshold (engine.budgetStatus).
const knex = require('../../db/knex');
const { repo } = require('../../core/crud');
const { z, validate, money, emptyToUndefined } = require('../../core/validate');
const engine = require('../finance/engine');
const expenses = require('../expenses/expense.service');

const budgets = repo({ table: 'budgets', entity: 'budget', defaultSort: ['id', 'asc'] });

async function categoryKeys(businessId) {
  return [...engine.VIRTUAL_BUDGET_CATEGORIES, ...(await expenses.allCategoryKeys(businessId)).filter((k) => !['marketing', 'salaries', 'deliveries'].includes(k))];
}

async function save(ctx, id, input) {
  const keys = await categoryKeys(ctx.businessId);
  const d = validate(z.object({
    category: z.string().refine((v) => keys.includes(v), 'Choose a valid value.'),
    monthly_budget: money().refine((v) => v > 0, 'Must be zero or more.'),
    alert_threshold_percent: z.preprocess((v) => Number(v), z.number({ invalid_type_error: 'Enter a number.' }).min(1, 'Must be between 0 and 100.').max(100, 'Must be between 0 and 100.')),
    period_month: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}$/, 'Enter a valid month.').optional()),
  }), input);
  const row = { ...d, period_month: d.period_month || null };
  if (id) { await budgets.update(ctx, id, row); return id; }
  return budgets.create(ctx, row);
}

const alertHistory = (ctx) => knex('notifications').where({ business_id: ctx.businessId }).where('type', 'like', 'budget.%').orderBy('id', 'desc').limit(30);

module.exports = { budgets, save, categoryKeys, alertHistory };
