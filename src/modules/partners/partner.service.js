// Partners: profiles, capital ledger and profit distributions.
// DocBook stores running totals on the partner (additional_contributions, total_withdrawn); here every
// movement is also a ledger row, and the totals are updated in the same transaction so they never drift.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { repo } = require('../../core/crud');
const { z, validate, money, isoDate, optionalString } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const engine = require('../finance/engine');
const fin = require('../finance/finance.data');

const partners = repo({ table: 'partners', entity: 'partner', searchable: ['name', 'phone', 'email'], sortable: { name: 'name', equity: 'current_equity_percent' }, defaultSort: ['name', 'asc'] });

const schema = z.object({
  name: z.string().trim().min(1, 'Required.').max(160),
  phone: optionalString(40),
  email: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().email('Enter a valid email address.').max(190).optional()),
  initial_investment: money(),
  current_equity_percent: z.preprocess((v) => Number(v), z.number({ invalid_type_error: 'Enter a number.' }).min(0, 'Must be between 0 and 100.').max(100, 'Must be between 0 and 100.')),
  join_date: z.preprocess((v) => (v === '' ? undefined : v), isoDate().optional()),
  notes: optionalString(5000),
  color: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()),
});

async function equityOfOthers(ctx, exceptId, trx = knex) {
  const q = trx('partners').where({ business_id: ctx.businessId });
  if (exceptId) q.whereNot({ id: exceptId });
  const [{ s }] = await q.sum({ s: 'current_equity_percent' });
  return Number(s) || 0;
}

async function save(ctx, id, input) {
  const d = validate(schema, input);
  return knex.transaction(async (trx) => {
    const others = await equityOfOthers(ctx, id, trx);
    if (others + d.current_equity_percent > 100.0001) {
      throw new AppError('EQUITY_OVER_100', 'Total partner equity cannot exceed 100%.', 422, { current_equity_percent: `Available: ${(100 - others).toFixed(2)}%` });
    }
    const row = { ...d, phone: d.phone || null, email: d.email || null, join_date: d.join_date || null, notes: d.notes || null, color: d.color || null };
    if (id) { await partners.update(ctx, id, row, trx); return id; }
    return partners.create(ctx, row, trx);
  });
}

const txSchema = z.object({
  type: z.enum(['contribution', 'withdrawal'], { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  amount: money().refine((v) => v > 0, 'Must be zero or more.'),
  date: isoDate(),
  reference: optionalString(100),
  note: optionalString(500),
  allow_overdraw: z.any().optional(),
});

/** Available balance = what the partner is owed right now (all-time, DocBook's net payable). */
async function availableBalance(ctx, partnerId) {
  const d = await fin.load(ctx.businessId);
  const m = engine.computeMetrics(d, '');
  const a = m.partnerAllocations.find((p) => String(p.partnerId) === String(partnerId));
  return a ? a.netPayable : 0;
}

async function addTransaction(ctx, partnerId, input, { distributionId = null, trx: outer = null } = {}) {
  const d = validate(txSchema, input);
  const run = async (trx) => {
    const p = await partners.get(ctx, partnerId, trx);
    if (d.type === 'withdrawal' && !d.allow_overdraw && !distributionId) {
      const available = await availableBalance(ctx, partnerId);
      if (d.amount > available + 0.0005) throw new AppError('WITHDRAWAL_EXCEEDS', 'The withdrawal is larger than this partner\'s available balance.', 422, { amount: `Available: ${available.toFixed(3)}` });
    }
    const [txId] = await trx('partner_transactions').insert({
      business_id: ctx.businessId, partner_id: p.id, type: d.type, amount: d.amount, date: d.date, reference: d.reference || null, note: d.note || null, distribution_id: distributionId, created_by: ctx.userId,
    });
    const col = d.type === 'contribution' ? 'additional_contributions' : 'total_withdrawn';
    await trx('partners').where({ id: p.id }).update({ [col]: trx.raw('?? + ?', [col, d.amount]), updated_at: new Date() });
    await audit.record(ctx, `partner.${d.type}`, { entityType: 'partner', entityId: p.id, newValues: { amount: d.amount, date: d.date, reference: d.reference } }, trx);
    return txId;
  };
  return outer ? run(outer) : knex.transaction(run);
}

async function deleteTransaction(ctx, partnerId, txId) {
  return knex.transaction(async (trx) => {
    const tx = await trx('partner_transactions').where({ id: txId, partner_id: partnerId, business_id: ctx.businessId }).first();
    if (!tx) throw E.notFound('Transaction');
    if (tx.type === 'opening') throw E.conflict('OPENING_LOCKED', 'Opening balances cannot be deleted.');
    const col = tx.type === 'contribution' ? 'additional_contributions' : 'total_withdrawn';
    await trx('partners').where({ id: partnerId }).update({ [col]: trx.raw('GREATEST(0, ?? - ?)', [col, tx.amount]) });
    await trx('partner_transactions').where({ id: txId }).del();
    await audit.record(ctx, 'partner.transaction_deleted', { entityType: 'partner', entityId: partnerId, oldValues: { type: tx.type, amount: Number(tx.amount), date: tx.date } }, trx);
  });
}

const transactions = (ctx, partnerId) => knex('partner_transactions as t').leftJoin('users as u', 'u.id', 't.created_by')
  .where({ 't.business_id': ctx.businessId, 't.partner_id': partnerId }).orderBy([{ column: 't.date', order: 'desc' }, { column: 't.id', order: 'desc' }]).select('t.*', 'u.name as created_by_name');

// ---------------------------------------------------------------- profit distribution workflow
async function preview(ctx, month) {
  const d = await fin.load(ctx.businessId);
  const metrics = engine.computeMetrics(d, month);
  return { metrics, equityTotal: engine.equityTotal(d.partners), partners: d.partners };
}

/**
 * Records a distribution statement for a period (snapshot of the engine's allocation). Optionally pays out
 * each selected partner's positive allocation, which is recorded as a withdrawal in their ledger.
 */
async function recordDistribution(ctx, month, { payout = [], note } = {}) {
  const period = month || 'all';
  const { metrics } = await preview(ctx, month);
  const payIds = new Set((Array.isArray(payout) ? payout : [payout]).filter(Boolean).map(String));
  return knex.transaction(async (trx) => {
    const [id] = await trx('profit_distributions').insert({
      business_id: ctx.businessId, period, revenue: metrics.totalRevenue, gross_profit: metrics.grossProfit, net_profit: metrics.netProfit,
      status: payIds.size ? 'paid' : 'recorded', note: note || null, created_by: ctx.userId,
    });
    for (const a of metrics.partnerAllocations) {
      const paid = payIds.has(String(a.partnerId)) && a.allocatedProfit > 0 ? Math.round(a.allocatedProfit * 1000) / 1000 : 0;
      await trx('profit_distribution_lines').insert({ // eslint-disable-line no-await-in-loop
        distribution_id: id, partner_id: a.partnerId, partner_name: a.partnerName, equity_percent: a.equityPercent,
        allocated_profit: a.allocatedProfit, withdrawn: a.withdrawn, net_payable: a.netPayable, paid_out: paid,
      });
      if (paid > 0) {
        await addTransaction(ctx, a.partnerId, { type: 'withdrawal', amount: paid, date: new Date().toISOString().slice(0, 10), reference: `DIST-${id}`, note: `Profit distribution ${period}` }, { distributionId: id, trx }); // eslint-disable-line no-await-in-loop
      }
    }
    await audit.record(ctx, 'partner.distribution_recorded', { entityType: 'distribution', entityId: id, newValues: { period, net_profit: metrics.netProfit, paid_out: [...payIds].join(',') } }, trx);
    return id;
  });
}

const distributions = (ctx) => knex('profit_distributions as d').leftJoin('users as u', 'u.id', 'd.created_by').where('d.business_id', ctx.businessId)
  .orderBy('d.id', 'desc').select('d.*', 'u.name as created_by_name');

async function distribution(ctx, id) {
  const d = await knex('profit_distributions as d').leftJoin('users as u', 'u.id', 'd.created_by').where({ 'd.business_id': ctx.businessId, 'd.id': id }).first('d.*', 'u.name as created_by_name');
  if (!d) throw E.notFound('Distribution');
  d.lines = await knex('profit_distribution_lines').where({ distribution_id: id }).orderBy('id');
  return d;
}

async function remove(ctx, id) {
  return knex.transaction(async (trx) => partners.remove(ctx, id, trx));
}

module.exports = { partners, save, addTransaction, deleteTransaction, transactions, preview, recordDistribution, distributions, distribution, availableBalance, remove };
