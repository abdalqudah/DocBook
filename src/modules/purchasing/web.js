// Purchase orders (clinic side), mounted at /app/supplies/orders.
//   GET  /                 list (status, supplier filters)                       supplies.view
//   GET  /export           CSV / XLSX                                            supplies.view + data.export
//   GET  /new?supplier=    new order for a supplier (suggested quantities)       supplies.manage
//   POST /                 save draft (intent=send → send right away)            supplies.manage
//   POST /low-stock        one draft per supplier for every low-stock item       supplies.manage
//   GET  /:id              order page (timeline, items, fallbacks; ?print=1)     supplies.view
//   GET  /:id/edit, POST /:id          edit a draft                              supplies.manage
//   POST /:id/send | /mark-sent | /resend | /cancel | /delete | /receive         supplies.manage
const express = require('express');
const knex = require('../../db/knex');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const exporter = require('../../core/exporter');
const mailer = require('../../core/mailer');
const svc = require('./purchasing.service');

const router = express.Router();
router.use(can('supplies.view'));

const ASSETS = { pageScripts: ['/js/purchasing.js'], pageStyles: ['/css/purchasing.css'] };
const BASE = '/app/supplies/orders';

function whenFn(req) {
  const f = new Intl.DateTimeFormat(req.locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: req.business.timezone || 'UTC' });
  return (v) => { if (!v) return '—'; try { return f.format(new Date(v)); } catch { return '—'; } };
}

/** Translates our own error codes (errors_purchasing.*), then the shared table, then the raw message. */
function errText(req, err) {
  const own = req.t(`errors_purchasing.${err.code}`);
  if (own !== `errors_purchasing.${err.code}`) return own;
  const shared = req.t(`errors.${err.code}`);
  return shared !== `errors.${err.code}` ? shared : err.message;
}

/** Runs an action; business errors become a flash message and a redirect back to the order (or the fallback). */
const act = (fn, fallback) => wrap(async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (!(err instanceof AppError) || (err.status >= 500 && err.code !== 'PO_MAIL_FAILED') || err.status === 403) throw err;
    if (err.code === 'VALIDATION_FAILED') flash(req, 'error', Object.values(err.details || {}).map((m) => translateMessage(req.locale, m))[0] || errText(req, err));
    else flash(req, 'error', errText(req, err));
    res.redirect(typeof fallback === 'function' ? fallback(req) : fallback || BASE);
  }
});
const orderUrl = (req) => `${BASE}/${Number(req.params.id)}`;
const baseUrlOf = (res) => res.locals.baseUrl || '';

// ---------------------------------------------------------------- list
// an order of another branch (the branch chosen in the account menu) is not found
router.param('id', (req, res, next, id) => { svc.get(req.ctx, Number(id) || 0).then(() => next(), next); });
router.get('/', wrap(async (req, res) => {
  const [{ rows, counts, meta }, suppliers, onOrder] = await Promise.all([svc.list(req.ctx, req.query), svc.listSuppliers(req.ctx), svc.onOrder(req.ctx)]);
  // Low items not yet on an open order or a draft: what "Order low-stock items" would still add.
  const low = await knex('supply_items').where({ business_id: req.ctx.businessId }).whereRaw('current_stock <= reorder_level').select('id');
  const inDrafts = new Set((await knex('purchase_order_items as l').join('purchase_orders as p', 'p.id', 'l.purchase_order_id')
    .where({ 'p.business_id': req.ctx.businessId, 'p.status': 'draft' }).whereNotNull('l.supply_item_id').select('l.supply_item_id')).map((r) => r.supply_item_id));
  const lowToOrder = low.filter((r) => !(onOrder[r.id] > 0) && !inDrafts.has(r.id)).length;
  res.page('pages/purchasing/index', {
    title: req.t('purchasing.title'), rows, counts, meta, suppliers, lowToOrder, when: whenFn(req),
    filtered: ['status', 'supplier', 'q'].some((k) => req.query[k] && req.query[k] !== 'all'), ...ASSETS,
  });
}));

router.get('/export', can('data.export'), wrap(async (req, res) => {
  const { rows } = await svc.list(req.ctx, req.query, { all: true });
  const t = req.t;
  const withCost = req.ctx.permissions.has('finance.view');
  const d = (v) => (v ? svc.dateIn(v, req.business.timezone) : '');
  exporter.send(req, res, {
    name: t('purchasing.title'),
    header: [t('purchasing.number'), t('purchasing.supplier'), t('common.status'), t('purchasing.lines'), t('purchasing.qty_ordered'), t('purchasing.qty_received'),
      t('purchasing.created'), t('purchasing.sent_at'), t('purchasing.sent_to'), t('purchasing.received_at'), ...(withCost ? [t('purchasing.est_cost')] : []), t('common.notes')],
    rows: rows.map((r) => [r.po_number || '', r.supplier_name, t(`purchasing.status.${r.status}`), r.line_count, r.qty_total, r.qty_received,
      d(r.created_at), d(r.sent_at), r.sent_to_email || '', d(r.received_at), ...(withCost ? [r.cost_total] : []), r.notes || '']),
  });
}));

// ---------------------------------------------------------------- builder (new / edit draft)
/**
 * Rows of the order form: the supplier's items (with stock, reorder level and suggestion), then any other clinic
 * items and free-text lines. `source` = lines to show (draft lines or the submitted form); null = suggestions.
 */
async function builder(req, res, { po = null, supplierId = null, source = null, extra = {} } = {}) {
  const [suppliers, items, onOrder] = await Promise.all([svc.listSuppliers(req.ctx), svc.listItems(req.ctx), svc.onOrder(req.ctx)]);
  const supplier = supplierId ? suppliers.find((s) => s.id === supplierId) || null : null;
  const byId = new Map(items.map((i) => [i.id, i]));
  const info = (it) => ({ stock: Number(it.current_stock), level: Number(it.reorder_level), suggested: svc.suggestQty(it.current_stock, it.reorder_level), low: Number(it.current_stock) <= Number(it.reorder_level), onOrder: onOrder[it.id] || 0 });
  const src = source ? source.filter((l) => l && (l.supply_item_id || l.name || l.quantity)) : null;
  const srcFor = new Map();
  const extras = [];
  (src || []).forEach((l) => {
    const iid = Number(l.supply_item_id) || null;
    const it = iid && byId.get(iid);
    if (it && supplier && it.supplier_id === supplier.id && !srcFor.has(iid) && l.kind !== 'other') srcFor.set(iid, l);
    else if (iid && it) extras.push({ kind: 'other', supply_item_id: iid, quantity: l.quantity, unit_cost: l.unit_cost, ...info(it) });
    else if (l.name || l.kind === 'free') extras.push({ kind: 'free', name: l.name || '', unit: l.unit || '', quantity: l.quantity, unit_cost: l.unit_cost });
  });
  const own = supplier ? items.filter((i) => i.supplier_id === supplier.id).map((it) => {
    const s = srcFor.get(it.id);
    const inf = info(it);
    const quantity = src ? (s ? s.quantity : '') : (inf.suggested && !inf.onOrder ? inf.suggested : '');
    return { kind: 'item', supply_item_id: it.id, name: it.name, unit: it.unit, quantity, unit_cost: s ? s.unit_cost : '', ...inf };
  }).sort((a, b) => (b.low - a.low) || a.name.localeCompare(b.name)) : [];
  const others = items.filter((i) => !supplier || i.supplier_id !== supplier.id).map((it) => ({ id: it.id, name: it.name, unit: it.unit || '', ...info(it) }));
  const plan = supplier ? { to: svc.recipientOf(supplier), vendor: Boolean(svc.activeVendorId(supplier)), mailConfigured: mailer.configured() } : null;
  res.page('pages/purchasing/form', {
    title: po ? req.t('purchasing.edit_draft') : req.t('purchasing.new'), po, suppliers: suppliers.filter((s) => s.is_active || (supplier && s.id === supplier.id)), supplier, own, extras, others, plan,
    lowCount: own.filter((r) => r.low).length, ...ASSETS, ...extra,
  });
}

const bodyLines = (body) => {
  const l = body && body.lines;
  if (!l) return [];
  return (Array.isArray(l) ? l : Object.values(l)).map((x) => x || {});
};

/** Save (create or update) a draft from the form; intent=send tries to send it right away. */
function saveHandler(isUpdate) {
  return wrap(async (req, res) => {
    const id = isUpdate ? Number(req.params.id) : null;
    let poId;
    try {
      poId = await svc.saveDraft(req.ctx, id, req.body);
    } catch (err) {
      if (!(err instanceof AppError) || ![404, 409, 422].includes(err.status)) throw err;
      if (err.code === 'PO_NOT_DRAFT') { flash(req, 'error', errText(req, err)); return res.redirect(`${BASE}/${id}`); }
      res.status(err.status);
      const po = id ? await svc.get(req.ctx, id).catch(() => null) : null;
      return builder(req, res, {
        po, supplierId: Number(req.body.supplier_id) || null, source: bodyLines(req.body),
        extra: {
          errors: err.code === 'VALIDATION_FAILED' ? Object.fromEntries(Object.entries(err.details || {}).map(([k, v]) => [k, translateMessage(req.locale, v)])) : {},
          formError: { code: err.code, message: err.code === 'VALIDATION_FAILED' ? (err.details && err.details.lines ? req.t('purchasing.need_lines') : req.t('purchasing.fix_lines')) : errText(req, err) },
          old: req.body,
        },
      });
    }
    if (req.body.intent !== 'send') {
      flash(req, 'success', req.t('purchasing.draft_saved'));
      return res.redirect(`${BASE}/${poId}`);
    }
    try {
      const r = await svc.send(req.ctx, poId, { baseUrl: baseUrlOf(res) });
      flash(req, 'success', sentMessage(req, r));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      flash(req, 'error', `${req.t('purchasing.saved_not_sent')} ${errText(req, err)}`);
    }
    return res.redirect(`${BASE}/${poId}`);
  });
}

function sentMessage(req, r) {
  if (r.emailed && r.portal) return req.t('purchasing.sent_mail_portal', { n: r.number, to: r.to });
  if (r.emailed) return req.t('purchasing.sent_mail', { n: r.number, to: r.to });
  return req.t('purchasing.sent_portal', { n: r.number });
}

router.get('/new', can('supplies.manage'), wrap((req, res) => builder(req, res, { supplierId: Number(req.query.supplier) || null })));
router.post('/', can('supplies.manage'), saveHandler(false));

router.post('/low-stock', can('supplies.manage'), wrap(async (req, res) => {
  const r = await svc.draftLowStock(req.ctx);
  const notes = [];
  if (r.noSupplier) notes.push(req.t('purchasing.low_no_supplier', { n: r.noSupplier }));
  if (r.alreadyOrdered) notes.push(req.t('purchasing.low_already', { n: r.alreadyOrdered }));
  if (!r.drafts.length) {
    flash(req, 'info', [req.t('purchasing.low_none'), ...notes].join(' '));
    return res.redirect(BASE);
  }
  flash(req, 'success', [req.t('purchasing.low_done', { n: r.drafts.length }), ...notes].join(' '));
  return res.redirect(r.drafts.length === 1 ? `${BASE}/${r.drafts[0]}` : `${BASE}?status=draft`);
}));

// ---------------------------------------------------------------- one order
router.get('/:id(\\d+)', wrap(async (req, res) => {
  const po = await svc.get(req.ctx, Number(req.params.id));
  const plan = await svc.dispatchPlan(req.ctx, po);
  const supplier = plan.supplier;
  const text = svc.orderText(po, req.business, req.locale);
  const phone = supplier && supplier.phone ? String(supplier.phone).replace(/[^0-9]/g, '') : '';
  res.page('pages/purchasing/show', {
    title: po.po_number ? req.t('purchasing.po_no', { n: po.po_number }) : req.t('purchasing.draft_po'),
    po, plan, supplier, text, expense: req.ctx.permissions.has('expenses.view') && po.status !== 'draft' ? await svc.expenseState(req.ctx, po.id) : null, expenseMethods: svc.EXPENSE_METHODS, waUrl: `https://wa.me/${phone}?text=${encodeURIComponent(text)}`, when: whenFn(req), printable: true,
    printMode: req.query.print === '1', openDialog: req.query.receive === '1' ? 'receive-dialog' : '', ...ASSETS,
  });
}));

router.get('/:id(\\d+)/edit', can('supplies.manage'), wrap(async (req, res) => {
  const po = await svc.get(req.ctx, Number(req.params.id));
  if (po.status !== 'draft') { flash(req, 'error', req.t('errors_purchasing.PO_NOT_DRAFT')); return res.redirect(orderUrl(req)); }
  const supplierId = Number(req.query.supplier) || po.supplier_id;
  return builder(req, res, { po, supplierId, source: po.lines.map((l) => ({ supply_item_id: l.supply_item_id, name: l.name, unit: l.unit, quantity: Number(l.quantity), unit_cost: l.unit_cost === null ? '' : Number(l.unit_cost) })), extra: { old: { notes: po.notes } } });
}));
router.post('/:id(\\d+)', can('supplies.manage'), saveHandler(true));

router.post('/:id(\\d+)/send', can('supplies.manage'), act(async (req, res) => {
  const r = await svc.send(req.ctx, Number(req.params.id), { baseUrl: baseUrlOf(res) });
  flash(req, 'success', sentMessage(req, r));
  res.redirect(orderUrl(req));
}, orderUrl));

router.post('/:id(\\d+)/mark-sent', can('supplies.manage'), act(async (req, res) => {
  const r = await svc.markSent(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t(r.portal ? 'purchasing.marked_sent_portal' : 'purchasing.marked_sent', { n: r.number }));
  res.redirect(orderUrl(req));
}, orderUrl));

router.post('/:id(\\d+)/resend', can('supplies.manage'), act(async (req, res) => {
  const r = await svc.resend(req.ctx, Number(req.params.id), { baseUrl: baseUrlOf(res) });
  flash(req, 'success', req.t('purchasing.resent', { to: r.to }));
  res.redirect(orderUrl(req));
}, orderUrl));

router.post('/:id(\\d+)/cancel', can('supplies.manage'), act(async (req, res) => {
  await svc.cancel(req.ctx, Number(req.params.id), { baseUrl: baseUrlOf(res) });
  flash(req, 'success', req.t('purchasing.cancelled'));
  res.redirect(orderUrl(req));
}, orderUrl));

router.post('/:id(\\d+)/delete', can('supplies.manage'), act(async (req, res) => {
  await svc.removeDraft(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('purchasing.draft_deleted'));
  res.redirect(BASE);
}, orderUrl));

router.post('/:id(\\d+)/receive', can('supplies.manage'), act(async (req, res) => {
  const r = await svc.receive(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t(r.complete ? 'purchasing.received_all' : 'purchasing.received_part') + (r.expense ? ` ${req.t('purchasing.expense_added', { amount: res.locals.fmt.money(r.expense.amount) })}` : ''));
  res.redirect(orderUrl(req));
}, (req) => `${orderUrl(req)}?receive=1`));

// The order's bill as an expense (an order received before, or a bill different from the order prices).
router.post('/:id(\\d+)/expense', can('expenses.manage'), act(async (req, res) => {
  const r = await svc.recordExpense(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('purchasing.expense_added', { amount: res.locals.fmt.money(r.amount) }));
  res.redirect(orderUrl(req));
}, orderUrl));

module.exports = router;
