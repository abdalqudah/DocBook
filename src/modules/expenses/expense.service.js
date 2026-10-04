const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { repo } = require('../../core/crud');
const { z, validate, money, isoDate, optionalString } = require('../../core/validate');
const { E } = require('../../core/errors');

// Built-in clinic expense categories (kept as keys; labels are translated). Each clinic can add its own.
const SYSTEM_CATEGORIES = ['rent', 'utilities', 'medical_supplies', 'lab_fees', 'equipment', 'maintenance', 'cleaning', 'software', 'staff_salaries', 'advertising',
  'licences', 'tax', 'insurance_premiums', 'office', 'hospitality', 'transport', 'center_share', 'miscellaneous']; // center_share: a medical centre's shared cost paid by this practice
const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'digital_wallet'];

const expenses = repo({
  table: 'expenses', entity: 'expense', searchable: ['title', 'invoice_number', 'recorded_by', 'notes'], dateColumn: 'date',
  filters: { category: 'category', method: 'payment_method' },
  sortable: { date: 'date', amount: 'amount', title: 'title' }, defaultSort: ['date', 'desc'], sums: ['amount'],
});

async function categories(businessId) {
  const custom = await knex('expense_categories').where({ business_id: businessId }).orderBy('name');
  return { system: SYSTEM_CATEGORIES, custom };
}

async function allCategoryKeys(businessId) {
  const { system, custom } = await categories(businessId);
  return [...system, ...custom.map((c) => c.key)];
}

async function schema(businessId) {
  const keys = await allCategoryKeys(businessId);
  return z.object({
    date: isoDate(),
    category: z.string().refine((v) => keys.includes(v), 'Choose a valid value.'),
    title: z.string().trim().min(1, 'Required.').max(255),
    amount: money(),
    payment_method: z.enum(PAYMENT_METHODS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
    invoice_number: optionalString(100),
    notes: optionalString(5000),
  });
}

async function save(ctx, id, input) {
  const data = validate(await schema(ctx.businessId), input);
  const row = { ...data, invoice_number: data.invoice_number || null, notes: data.notes || null };
  if (id) { await expenses.update(ctx, id, row); return id; }
  return expenses.create(ctx, { ...row, recorded_by: ctx.userName, recorded_by_user_id: ctx.userId });
}

async function addCategory(ctx, name) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) throw E.validation({ name: 'Required.' });
  const key = `c_${clean.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 40)}`;
  const exists = await knex('expense_categories').where({ business_id: ctx.businessId, key }).first();
  if (exists) return exists.key;
  await knex('expense_categories').insert({ business_id: ctx.businessId, key, name: clean });
  await audit.record(ctx, 'expense_category.created', { entityType: 'expense_category', entityId: key, newValues: { name: clean } });
  return key;
}

module.exports = { expenses, categories, allCategoryKeys, save, addCategory, SYSTEM_CATEGORIES, PAYMENT_METHODS };
