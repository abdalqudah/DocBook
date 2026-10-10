// Tenant-scoped repository used by every business module: list (search, filters, date range, sort,
// pagination, totals), get, create, update, delete — each write recorded in the audit log.
const knex = require('../db/knex');
const audit = require('./audit');
const { E } = require('./errors');

function repo({ table, entity, searchable = [], dateColumn = null, filters = {}, sortable = {}, defaultSort = ['id', 'desc'], sums = [], scope = null }) {
  // scope(q, ctx): narrows every read / change further (e.g. the branch the member works in)
  const scoped = (ctx, trx = knex) => { const q = trx(table).where(`${table}.business_id`, ctx.businessId); return scope ? scope(q, ctx) : q; };

  function applyFilters(q, ctx, params) {
    if (params.q && searchable.length) {
      const term = `%${String(params.q).trim().replace(/[%_]/g, (m) => `\\${m}`)}%`;
      q.andWhere((w) => { searchable.forEach((c) => w.orWhere(`${table}.${c}`, 'like', term)); });
    }
    if (dateColumn && /^\d{4}-\d{2}-\d{2}$/.test(params.from || '')) q.andWhere(`${table}.${dateColumn}`, '>=', params.from);
    if (dateColumn && /^\d{4}-\d{2}-\d{2}$/.test(params.to || '')) q.andWhere(`${table}.${dateColumn}`, '<=', params.to);
    if (dateColumn && /^\d{4}-\d{2}$/.test(params.month || '')) q.andWhere(`${table}.${dateColumn}`, 'like', `${params.month}-%`);
    for (const [key, col] of Object.entries(filters)) {
      const v = params[key];
      if (v === undefined || v === '' || v === 'all') continue; // eslint-disable-line no-continue
      if (typeof col === 'function') col(q, v); else q.andWhere(`${table}.${col}`, v);
    }
    return q;
  }

  async function list(ctx, params = {}, { perPage = 25, all = false } = {}) {
    const base = applyFilters(scoped(ctx), ctx, params);
    const [{ n }] = await base.clone().count({ n: '*' });
    const total = Number(n);
    const page = Math.max(1, Number(params.page) || 1);
    const pages = Math.max(1, Math.ceil(total / perPage));
    const [sortKey, sortDir] = sortable[params.sort] ? [sortable[params.sort], params.dir === 'asc' ? 'asc' : 'desc'] : defaultSort;
    let q = base.clone().select(`${table}.*`).orderBy(sortKey, sortDir).orderBy(`${table}.id`, 'desc');
    if (!all) q = q.limit(perPage).offset((Math.min(page, pages) - 1) * perPage);
    const rows = await q;
    let totals = {};
    if (sums.length) {
      const [row] = await base.clone().select(sums.map((c) => knex.raw('COALESCE(SUM(??), 0) as ??', [`${table}.${c}`, c])));
      totals = Object.fromEntries(sums.map((c) => [c, Number(row[c]) || 0]));
    }
    return { rows, totals, meta: { total, page: Math.min(page, pages), pages, perPage } };
  }

  async function get(ctx, id, trx = knex) {
    const row = await scoped(ctx, trx).where(`${table}.id`, id).first();
    if (!row) throw E.notFound(entity);
    return row;
  }

  async function create(ctx, data, trx = knex) {
    const [id] = await trx(table).insert({ ...data, business_id: ctx.businessId });
    await audit.record(ctx, `${entity}.created`, { entityType: entity, entityId: id, newValues: data }, trx);
    return id;
  }

  async function update(ctx, id, data, trx = knex) {
    const before = await get(ctx, id, trx);
    const { oldValues, newValues, changed } = audit.diff(before, data);
    if (!changed) return false;
    await trx(table).where({ id, business_id: ctx.businessId }).update({ ...data, updated_at: new Date() });
    await audit.record(ctx, `${entity}.updated`, { entityType: entity, entityId: id, oldValues, newValues }, trx);
    return true;
  }

  async function remove(ctx, id, trx = knex) {
    const before = await get(ctx, id, trx);
    await trx(table).where({ id, business_id: ctx.businessId }).del();
    const { business_id: _b, created_at: _c, updated_at: _u, ...snapshot } = before;
    await audit.record(ctx, `${entity}.deleted`, { entityType: entity, entityId: id, oldValues: snapshot }, trx);
    return before;
  }

  return { table, entity, scoped, list, get, create, update, remove, applyFilters };
}

module.exports = { repo };
