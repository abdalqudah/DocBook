// Clinic supplies: items with stock levels and movements, and the suppliers they come from.
const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const exporter = require('../../core/exporter');
const svc = require('./supplies.service');
const branches = require('./branches.service');

const router = express.Router();
router.use(can('supplies.view'));

const assets = { pageScripts: ['/js/ops.js'], pageStyles: ['/css/ops.css'] };
const safeReturn = (req, fallback) => (req.body._return && /^\/app\/supplies(\/|\?|$)/.test(String(req.body._return)) ? String(req.body._return) : fallback);

async function allSuppliers(ctx) {
  const rows = await knex('suppliers as s').leftJoin(branches.scopeKey(knex('supply_items').where('business_id', ctx.businessId), ctx, 'branch_key').select('id', 'supplier_id').as('i'), 'i.supplier_id', 's.id').where('s.business_id', ctx.businessId)
    .groupBy('s.id').orderBy('s.name').select('s.*').count({ items: 'i.id' });
  return rows.map((r) => ({ ...r, items: Number(r.items) }));
}

async function stockSummary(ctx) {
  const [row] = await branches.scopeKey(knex('supply_items').where({ business_id: ctx.businessId }), ctx, 'branch_key')
    .select(knex.raw('COUNT(*) as n'), knex.raw('COALESCE(SUM(CASE WHEN current_stock <= reorder_level THEN 1 ELSE 0 END), 0) as low'),
      knex.raw('COALESCE(SUM(current_stock * unit_cost), 0) as value'), knex.raw('COALESCE(SUM(CASE WHEN current_stock <= 0 THEN 1 ELSE 0 END), 0) as out_n'));
  return { count: Number(row.n), low: Number(row.low), value: Number(row.value), out: Number(row.out_n) };
}

async function renderList(req, res, extra = {}) {
  const tab = req.query.tab === 'suppliers' ? 'suppliers' : 'items';
  const [suppliers, summary] = await Promise.all([allSuppliers(req.ctx), stockSummary(req.ctx)]);
  const supplierName = Object.fromEntries(suppliers.map((s) => [s.id, s.name]));
  let items = { rows: [], meta: { total: 0, page: 1, pages: 1, perPage: 25 } };
  if (tab === 'items') items = await svc.items.list(req.ctx, req.query, { perPage: 30 });
  res.page('pages/clinic/supplies/index', {
    title: req.t('supplies.title'), tab, suppliers, supplierName, summary, rows: items.rows, meta: items.meta,
    filtered: ['q', 'supplier', 'low'].some((k) => req.query[k] && req.query[k] !== 'all'), ...assets, ...extra,
  });
}

router.get('/', wrap((req, res) => renderList(req, res)));

router.get('/export', can('data.export'), wrap(async (req, res) => {
  const { rows } = await svc.items.list(req.ctx, req.query, { all: true });
  const suppliers = await allSuppliers(req.ctx);
  const names = Object.fromEntries(suppliers.map((s) => [s.id, s.name]));
  const t = req.t;
  const withCost = req.ctx.permissions.has('finance.view');
  exporter.send(req, res, {
    name: t('supplies.title'),
    header: [t('supplies.item'), t('supplies.unit'), t('supplies.supplier'), t('supplies.current_stock'), t('supplies.reorder_level'), ...(withCost ? [t('supplies.unit_cost'), t('supplies.stock_value')] : [])],
    rows: rows.map((r) => [r.name, r.unit || '', names[r.supplier_id] || '', Number(r.current_stock), Number(r.reorder_level),
      ...(withCost ? [Number(r.unit_cost), Math.round(Number(r.current_stock) * Number(r.unit_cost) * 1000) / 1000] : [])]),
  });
}));

// ---------------------------------------------------------------- items
const rerenderItems = (dialog) => (req, res, extra) => (req.body._from === 'item' && req.params.id
  ? renderItem(req, res, { ...extra, openDialog: dialog, formAction: req.originalUrl }) // eslint-disable-line no-use-before-define
  : renderList(req, res, { ...extra, openDialog: dialog, formAction: req.originalUrl }));

router.post('/items', can('supplies.manage'), form(async (req, res) => {
  await svc.saveItem(req.ctx, null, req.body);
  flash(req, 'success', req.t('supplies.item_saved'));
  res.redirect(safeReturn(req, '/app/supplies'));
}, rerenderItems('item-dialog')));
router.post('/items/:id(\\d+)', can('supplies.manage'), form(async (req, res) => {
  await svc.saveItem(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect(safeReturn(req, '/app/supplies'));
}, rerenderItems('item-dialog')));
router.post('/items/:id(\\d+)/move', can('supplies.manage'), form(async (req, res) => {
  await svc.move(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('supplies.moved'));
  res.redirect(safeReturn(req, '/app/supplies'));
}, rerenderItems('move-dialog')));
router.post('/items/:id(\\d+)/delete', can('supplies.manage'), wrap(async (req, res) => {
  await svc.items.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('supplies.item_deleted'));
  res.redirect('/app/supplies');
}));

async function renderItem(req, res, extra = {}) {
  const item = await svc.items.get(req.ctx, Number(req.params.id));
  const [movements, suppliers] = await Promise.all([svc.movements(req.ctx, item.id), allSuppliers(req.ctx)]);
  const supplier = suppliers.find((s) => s.id === item.supplier_id) || null;
  const whenFmt = new Intl.DateTimeFormat(req.locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: req.business.timezone || 'UTC' });
  const when = (v) => { try { return whenFmt.format(new Date(v)); } catch { return '—'; } };
  res.page('pages/clinic/supplies/item', { title: item.name, item, movements, supplier, suppliers, when, ...assets, ...extra });
}
router.get('/items/:id(\\d+)', wrap((req, res) => renderItem(req, res)));

// ---------------------------------------------------------------- suppliers
const rerenderSupplier = (req, res, extra) => { req.query.tab = 'suppliers'; return renderList(req, res, { ...extra, openDialog: 'supplier-dialog', formAction: req.originalUrl }); };
router.post('/suppliers', can('supplies.manage'), form(async (req, res) => {
  await svc.saveSupplier(req.ctx, null, req.body);
  flash(req, 'success', req.t('supplies.supplier_saved'));
  res.redirect('/app/supplies?tab=suppliers');
}, rerenderSupplier));
router.post('/suppliers/:id(\\d+)', can('supplies.manage'), form(async (req, res) => {
  await svc.saveSupplier(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.updated'));
  res.redirect('/app/supplies?tab=suppliers');
}, rerenderSupplier));
router.post('/suppliers/:id(\\d+)/delete', can('supplies.manage'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [{ n }] = await knex('supply_items').where({ business_id: req.ctx.businessId, supplier_id: id }).count({ n: '*' });
  if (Number(n) > 0) {
    flash(req, 'error', req.t('errors_ops.SUPPLIER_IN_USE', { n: Number(n) }));
  } else {
    await svc.suppliers.remove(req.ctx, id);
    flash(req, 'success', req.t('supplies.supplier_deleted'));
  }
  res.redirect('/app/supplies?tab=suppliers');
}));

module.exports = router;
