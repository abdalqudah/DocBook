// Partners & capital: partners with an initial investment and an equity share (active partners must not exceed
// 100 %; distributing profit needs exactly 100 %), capital injections and withdrawals, and the monthly profit
// distribution — the month's net profit (from the profit & loss) × each partner's equity, recorded once per closed
// month (the unique index on profit_distributions makes it idempotent).
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { z, validate, money, isoDate, optionalString, emptyToUndefined } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const pnl = require('./pnl.service');
const m = require('./math');

const TX_TYPES = ['injection', 'withdrawal'];

const partnerSchema = z.object({
  name: z.string().trim().min(1, 'Required.').max(190),
  phone: optionalString(40),
  email: z.preprocess(emptyToUndefined, z.string().trim().toLowerCase().email('Enter a valid email address.').max(190).optional()),
  initial_investment: money(),
  equity_percent: z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : Number(String(v).replace(/,/g, ''))),
    z.number({ required_error: 'Required.', invalid_type_error: 'Enter a number.' }).min(0, 'Must be between 0 and 100.').max(100, 'Must be between 0 and 100.')),
  joined_on: z.preprocess(emptyToUndefined, isoDate().optional()),
  status: z.enum(['active', 'inactive'], { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  notes: optionalString(2000),
});

const list = (businessId) => knex('partners').where({ business_id: businessId }).orderBy([{ column: 'status' }, { column: 'equity_percent', order: 'desc' }, { column: 'name' }]);

async function get(ctx, id) {
  const p = await knex('partners').where({ id, business_id: ctx.businessId }).first();
  if (!p) throw E.notFound('Partner');
  return p;
}

async function save(ctx, id, input) {
  const d = validate(partnerSchema, input);
  const all = await list(ctx.businessId);
  const total = m.equityAfter(all, id || null, d.equity_percent, d.status);
  if (total > 100.0005) throw new AppError('EQUITY_OVER_100', 'Active partners would hold more than 100% together.', 422, { total });
  const row = { name: d.name, phone: d.phone || null, email: d.email || null, initial_investment: d.initial_investment, equity_percent: d.equity_percent, joined_on: d.joined_on || null, status: d.status, notes: d.notes || null };
  if (id) {
    const before = await get(ctx, id);
    await knex('partners').where({ id: before.id }).update({ ...row, updated_at: new Date() });
    await audit.record(ctx, 'partner.updated', { entityType: 'partner', entityId: id, oldValues: { name: before.name, equity: Number(before.equity_percent), investment: Number(before.initial_investment), status: before.status }, newValues: { name: row.name, equity: row.equity_percent, investment: row.initial_investment, status: row.status } });
    return before.id;
  }
  const [newId] = await knex('partners').insert({ ...row, business_id: ctx.businessId });
  await audit.record(ctx, 'partner.created', { entityType: 'partner', entityId: newId, newValues: { name: row.name, equity: row.equity_percent, investment: row.initial_investment } });
  return newId;
}

async function remove(ctx, id) {
  const p = await get(ctx, id);
  const [{ n }] = await knex('partner_transactions').where({ partner_id: p.id }).count({ n: '*' });
  if (Number(n) > 0) throw new AppError('PARTNER_HAS_HISTORY', 'This partner has transactions on record. Mark them inactive instead.', 409);
  await knex('partners').where({ id: p.id }).del();
  await audit.record(ctx, 'partner.deleted', { entityType: 'partner', entityId: p.id, oldValues: { name: p.name, equity: Number(p.equity_percent) } });
}

const txSchema = z.object({
  type: z.enum(TX_TYPES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  amount: money().refine((v) => v > 0, 'Too small.'),
  date: isoDate(),
  note: optionalString(500),
});

async function addTransaction(ctx, partnerId, input) {
  const p = await get(ctx, partnerId);
  const d = validate(txSchema, input);
  const [id] = await knex('partner_transactions').insert({ business_id: ctx.businessId, partner_id: p.id, type: d.type, amount: d.amount, date: d.date, note: d.note || null, created_by: ctx.userId });
  await audit.record(ctx, `partner.${d.type}`, { entityType: 'partner', entityId: p.id, newValues: { amount: d.amount, date: d.date, note: d.note || '' } });
  return id;
}

async function removeTransaction(ctx, txId) {
  const tx = await knex('partner_transactions').where({ id: txId, business_id: ctx.businessId }).first();
  if (!tx) throw E.notFound('Transaction');
  if (tx.type === 'profit_share') throw new AppError('SHARE_IN_DISTRIBUTION', 'Profit shares are removed by cancelling the month\'s distribution.', 409);
  await knex('partner_transactions').where({ id: tx.id }).del();
  await audit.record(ctx, 'partner.transaction_deleted', { entityType: 'partner', entityId: tx.partner_id, oldValues: { type: tx.type, amount: Number(tx.amount), date: tx.date } });
}

const transactions = (businessId, partnerId = null) => knex('partner_transactions as x').leftJoin('users as u', 'u.id', 'x.created_by')
  .where('x.business_id', businessId).modify((q) => { if (partnerId) q.where('x.partner_id', partnerId); })
  .orderBy([{ column: 'x.date', order: 'desc' }, { column: 'x.id', order: 'desc' }]).select('x.*', 'u.name as created_by_name');

/** Partners with balances, equity state and the live (not yet allocated) share of `netProfit`. */
async function overview(ctx, netProfit = null) {
  const [rows, txs] = await Promise.all([list(ctx.businessId), transactions(ctx.businessId)]);
  const partners = rows.map((p) => {
    const mine = txs.filter((x) => x.partner_id === p.id);
    return { ...p, equity_percent: Number(p.equity_percent), ...m.partnerBalance(p, mine), transactions: mine, share: netProfit === null || p.status !== 'active' ? null : m.profitShare(netProfit, p.equity_percent) };
  });
  const totals = partners.reduce((t, p) => ({ investment: m.round(t.investment + p.investment + p.injections), withdrawals: m.round(t.withdrawals + p.withdrawals), profits: m.round(t.profits + p.profits), balance: m.round(t.balance + p.balance) }),
    { investment: 0, withdrawals: 0, profits: 0, balance: 0 });
  return { partners, equity: m.equityState(rows), totals };
}

const distributions = (businessId) => knex('profit_distributions as d').leftJoin('users as u', 'u.id', 'd.created_by').where('d.business_id', businessId)
  .orderBy('d.period', 'desc').select('d.*', 'u.name as created_by_name');

/**
 * Records the profit shares of a closed month (before the clinic's current month). Idempotent: a month that is
 * already distributed is refused with ALREADY_DISTRIBUTED and nothing changes.
 */
async function distribute(ctx, month) {
  if (!m.isMonth(month)) throw E.validation({ period: 'Enter a valid month.' });
  if (month >= String(ctx.today).slice(0, 7)) throw new AppError('MONTH_NOT_CLOSED', 'Only a month that has ended can be distributed.', 409);
  const rows = await list(ctx.businessId);
  const eq = m.equityState(rows);
  if (!rows.some((p) => p.status === 'active')) throw new AppError('NO_PARTNERS', 'Add the partners first.', 409);
  if (eq.state !== 'ok') throw new AppError('EQUITY_NOT_100', 'Active partners must hold exactly 100% together.', 409, { total: eq.total });
  const s = await pnl.monthNet(ctx, month);
  const allocations = m.allocate(s.net, rows);
  const date = m.monthEnd(month);
  try {
    return await knex.transaction(async (trx) => {
      const [distId] = await trx('profit_distributions').insert({ business_id: ctx.businessId, period: month, revenue: s.revenue, costs: s.costs, net_profit: s.net, created_by: ctx.userId });
      for (const a of allocations) {
        await trx('partner_transactions').insert({ business_id: ctx.businessId, partner_id: a.partnerId, type: 'profit_share', amount: a.amount, date, period: month, distribution_id: distId, equity_percent: a.equity, created_by: ctx.userId }); // eslint-disable-line no-await-in-loop
      }
      await audit.record(ctx, 'partner.profit_distributed', { entityType: 'profit_distribution', entityId: distId, newValues: { period: month, net_profit: s.net, shares: allocations.map((a) => `${a.name}: ${a.amount}`).join('; ') } }, trx);
      return { id: distId, net: s.net, allocations };
    });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') throw new AppError('ALREADY_DISTRIBUTED', 'This month has already been distributed.', 409);
    throw err;
  }
}

async function cancelDistribution(ctx, id) {
  const d = await knex('profit_distributions').where({ id, business_id: ctx.businessId }).first();
  if (!d) throw E.notFound('Distribution');
  await knex.transaction(async (trx) => {
    await trx('partner_transactions').where({ distribution_id: d.id }).del();
    await trx('profit_distributions').where({ id: d.id }).del();
    await audit.record(ctx, 'partner.distribution_cancelled', { entityType: 'profit_distribution', entityId: d.id, oldValues: { period: d.period, net_profit: Number(d.net_profit) } }, trx);
  });
  return d;
}

/** A voucher: one partner transaction with its partner (and the distribution for a profit share). */
async function voucher(ctx, txId) {
  const tx = await knex('partner_transactions as x').leftJoin('users as u', 'u.id', 'x.created_by').where({ 'x.id': txId, 'x.business_id': ctx.businessId }).first('x.*', 'u.name as created_by_name');
  if (!tx) throw E.notFound('Transaction');
  const partner = await knex('partners').where({ id: tx.partner_id }).first();
  const dist = tx.distribution_id ? await knex('profit_distributions').where({ id: tx.distribution_id }).first() : null;
  return { tx: { ...tx, amount: Number(tx.amount) }, partner, dist };
}

module.exports = { TX_TYPES, list, get, save, remove, addTransaction, removeTransaction, transactions, overview, distributions, distribute, cancelDistribution, voucher };
