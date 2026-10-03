// Recurring expenses (rent, phone, internet, subscriptions…): each one has an amount, a category, how often it comes
// (weekly / monthly / quarterly / yearly) and its next date. On that date it is either recorded as an expense by
// itself ("auto") or waits on the expenses page for a click ("confirm" — record or skip, e.g. when the bill differs).
// A missed date (the server was off) is caught up, at most 12 times per run. Every change and every posting is audited.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { z, validate, money, isoDate, optionalString } = require('../../core/validate');
const scheduling = require('../clinic/scheduling');
const exp = require('./expense.service');

const EVERY = ['week', 'month', 'quarter', 'year'];
const MODES = ['auto', 'confirm'];

const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12
/** The date after `date` for this rhythm (the month day is kept, or the month's last day when shorter). */
function nextOf(date, every, day) {
  const [y, m, d] = String(date).split('-').map(Number);
  if (every === 'week') return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  const step = every === 'year' ? 12 : every === 'quarter' ? 3 : 1;
  const total = (m - 1) + step;
  const ny = y + Math.floor(total / 12); const nm = (total % 12) + 1;
  const nd = Math.min(Number(day) || d, daysIn(ny, nm));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

async function schema(businessId) {
  const keys = await exp.allCategoryKeys(businessId);
  return z.object({
    title: z.string().trim().min(1, 'Required.').max(255),
    category: z.string().refine((v) => keys.includes(v), 'Choose a valid value.'),
    amount: money(),
    payment_method: z.enum(exp.PAYMENT_METHODS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
    every: z.enum(EVERY, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
    next_date: isoDate(),
    end_date: z.preprocess((v) => (v === '' ? undefined : v), isoDate().optional()),
    mode: z.enum(MODES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
    notes: optionalString(2000),
  });
}

const list = (ctx) => knex('recurring_expenses').where({ business_id: ctx.businessId }).orderBy([{ column: 'is_active', order: 'desc' }, { column: 'next_date' }]);

async function get(ctx, id) {
  const r = await knex('recurring_expenses').where({ id: Number(id) || 0, business_id: ctx.businessId }).first();
  if (!r) throw E.notFound('Recurring expense');
  return r;
}

async function save(ctx, id, input) {
  const d = validate(await schema(ctx.businessId), input);
  const row = { ...d, end_date: d.end_date || null, notes: d.notes || null, day_of_month: Number(d.next_date.slice(8)), is_active: input._has_active ? ['1', 'on', true].includes(input.is_active) : true };
  if (id) {
    const before = await get(ctx, id);
    await knex('recurring_expenses').where({ id: before.id }).update({ ...row, updated_at: new Date() });
    await audit.record(ctx, 'recurring_expense.updated', { entityType: 'recurring_expense', entityId: before.id, oldValues: { amount: Number(before.amount), every: before.every, next_date: before.next_date }, newValues: { amount: row.amount, every: row.every, next_date: row.next_date } });
    return before.id;
  }
  const [newId] = await knex('recurring_expenses').insert({ ...row, business_id: ctx.businessId, created_by: ctx.userId });
  await audit.record(ctx, 'recurring_expense.created', { entityType: 'recurring_expense', entityId: newId, newValues: { title: row.title, amount: row.amount, every: row.every } });
  return newId;
}

async function remove(ctx, id) {
  const r = await get(ctx, id);
  await knex('recurring_expenses').where({ id: r.id }).del();
  await audit.record(ctx, 'recurring_expense.deleted', { entityType: 'recurring_expense', entityId: r.id, oldValues: { title: r.title, amount: Number(r.amount) } });
}

/** Records this occurrence as an expense (amount may be changed for this time) and moves to the next date. */
async function post(ctx, r, { amount } = {}) {
  const date = String(r.next_date);
  const value = amount !== undefined && amount !== '' && Number(amount) > 0 ? Math.round(Number(amount) * 1000) / 1000 : Number(r.amount);
  await knex.transaction(async (trx) => {
    const [eid] = await trx('expenses').insert({
      business_id: r.business_id, date, category: r.category, title: r.title, amount: value, payment_method: r.payment_method,
      notes: r.notes || null, recorded_by: ctx.userName || null, recorded_by_user_id: ctx.userId || null,
    });
    const next = nextOf(date, r.every, r.day_of_month);
    const ended = r.end_date && next > String(r.end_date);
    await trx('recurring_expenses').where({ id: r.id }).update({ last_posted: date, next_date: next, is_active: ended ? false : r.is_active, updated_at: new Date() });
    await audit.record({ ...ctx, businessId: r.business_id }, 'recurring_expense.posted', { entityType: 'expense', entityId: eid, newValues: { recurring_id: r.id, date, amount: value } }, trx);
  });
}

/** This occurrence is not recorded (e.g. no bill this month); the next date comes. */
async function skip(ctx, r) {
  const next = nextOf(String(r.next_date), r.every, r.day_of_month);
  await knex('recurring_expenses').where({ id: r.id }).update({ next_date: next, is_active: r.end_date && next > String(r.end_date) ? false : r.is_active, updated_at: new Date() });
  await audit.record(ctx, 'recurring_expense.skipped', { entityType: 'recurring_expense', entityId: r.id, newValues: { date: String(r.next_date) } });
}

/** Occurrences waiting for a click (mode "confirm") on or before today. */
async function due(ctx) {
  const today = ctx.today || scheduling.clinicNow(ctx.timezone || 'Asia/Amman').date;
  return knex('recurring_expenses').where({ business_id: ctx.businessId, is_active: true, mode: 'confirm' }).where('next_date', '<=', today).orderBy('next_date');
}

/** Hourly: records the "auto" ones whose date came, in each clinic's own time zone (catching up missed dates). */
async function runDue() {
  const rows = await knex('recurring_expenses as r').join('businesses as b', 'b.id', 'r.business_id')
    .where({ 'r.is_active': true, 'r.mode': 'auto' }).select('r.*', 'b.timezone');
  let posted = 0;
  for (const r0 of rows) { // eslint-disable-line no-restricted-syntax
    const today = scheduling.clinicNow(r0.timezone || 'Asia/Amman').date;
    let r = r0;
    for (let i = 0; i < 12 && r && r.is_active && String(r.next_date) <= today; i += 1) {
      await post({ businessId: r.business_id, userId: null, userName: null }, r); // eslint-disable-line no-await-in-loop
      posted += 1;
      r = await knex('recurring_expenses').where({ id: r.id }).first(); // eslint-disable-line no-await-in-loop
    }
  }
  return posted;
}

module.exports = { EVERY, MODES, nextOf, list, get, save, remove, post, skip, due, runDue };
