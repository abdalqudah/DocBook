// Purchase orders: a clinic picks a supplier, the items and quantities it needs (low-stock items get a suggested
// quantity), and sends the order by e-mail — or, when the supplier is a registered vendor, straight to the vendor's
// portal too. Numbers are claimed per clinic only when an order is sent. Received quantities become stock movements.
// Vendors only ever see their own sent orders: clinic contact, items and quantities — never patient data or costs.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const brand = require('../../config/brand');
const { translator } = require('../../core/i18n');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const supplies = require('../clinic/supplies.service');
const notifications = require('../notifications/notification.service');
const businesses = require('../businesses/business.service');

const STATUSES = ['draft', 'sent', 'acknowledged', 'received', 'cancelled'];
const OPEN = ['sent', 'acknowledged'];
const EPS = 1e-9;

const conflict = (code) => E.conflict(code, code);
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Suggested quantity for an item at or below its reorder level: enough to get back to twice the reorder level,
 * and never less than one reorder level — max(2 × level − stock, level), rounded up. Items above the level: 0.
 */
function suggestQty(stock, level) {
  const s = num(stock); const l = num(level);
  if (l <= 0 || s > l) return 0;
  return Math.ceil(Math.max(l * 2 - s, l) - EPS);
}

// ---------------------------------------------------------------- suppliers & items
async function getSupplier(ctx, id, trx = knex) {
  const s = await trx('suppliers as s').leftJoin('vendors as v', 'v.id', 's.vendor_id').where({ 's.id': id, 's.business_id': ctx.businessId })
    .first('s.*', 'v.name as vendor_name', 'v.email as vendor_email', 'v.phone as vendor_phone', 'v.status as vendor_status');
  if (!s) throw E.notFound('Supplier');
  return s;
}
/** A supplier's vendor only counts once the platform approved it (pending vendors receive nothing). */
const activeVendorId = (s) => (s && s.vendor_id && s.vendor_status === 'active' ? s.vendor_id : null);
const recipientOf = (s) => (s ? s.email || (activeVendorId(s) ? s.vendor_email : null) || null : null);

const listSuppliers = (ctx) => knex('suppliers as s').leftJoin('vendors as v', 'v.id', 's.vendor_id').where('s.business_id', ctx.businessId)
  .orderBy('s.name').select('s.id', 's.name', 's.email', 's.phone', 's.is_active', 's.vendor_id', 'v.status as vendor_status', 'v.email as vendor_email');

const listItems = (ctx) => knex('supply_items').where('business_id', ctx.businessId).orderBy('name')
  .select('id', 'name', 'unit', 'supplier_id', 'current_stock', 'reorder_level', 'unit_cost', 'vendor_product_id');

/** Items that are ordered but not received yet (open orders), by item id → quantity still to come. */
async function onOrder(ctx) {
  const rows = await knex('purchase_order_items as l').join('purchase_orders as p', 'p.id', 'l.purchase_order_id')
    .where('p.business_id', ctx.businessId).whereIn('p.status', OPEN).whereNotNull('l.supply_item_id')
    .groupBy('l.supply_item_id').select('l.supply_item_id').sum({ q: knex.raw('l.quantity - l.received_quantity') });
  return Object.fromEntries(rows.map((r) => [r.supply_item_id, num(r.q)]));
}

// ---------------------------------------------------------------- reading
async function get(ctx, id, trx = knex) {
  const po = await trx('purchase_orders as p').leftJoin('users as c', 'c.id', 'p.created_by').leftJoin('vendors as v', 'v.id', 'p.vendor_id')
    .where({ 'p.id': id, 'p.business_id': ctx.businessId }).first('p.*', 'c.name as created_by_name', 'v.name as vendor_name', 'v.status as vendor_status');
  if (!po) throw E.notFound('Purchase order');
  po.lines = await trx('purchase_order_items').where({ purchase_order_id: id }).orderBy('id');
  po.progress = progress(po);
  return po;
}

function progress(po) {
  const ordered = po.lines.reduce((a, l) => a + num(l.quantity), 0);
  const received = po.lines.reduce((a, l) => a + Math.min(num(l.received_quantity), num(l.quantity)), 0);
  const complete = po.lines.length > 0 && po.lines.every((l) => num(l.received_quantity) + EPS >= num(l.quantity));
  return { ordered, received, complete, partial: received > 0 && !complete };
}

async function list(ctx, params = {}, { perPage = 25, all = false } = {}) {
  const base = knex('purchase_orders as p').where('p.business_id', ctx.businessId);
  if (STATUSES.includes(params.status)) base.andWhere('p.status', params.status);
  if (params.status === 'open') base.whereIn('p.status', OPEN);
  if (/^\d+$/.test(String(params.supplier || ''))) base.andWhere('p.supplier_id', Number(params.supplier));
  if (params.q && /^\d+$/.test(String(params.q).replace(/^#/, ''))) base.andWhere('p.po_number', Number(String(params.q).replace(/^#/, '')));
  const [{ n }] = await base.clone().count({ n: '*' });
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, Number(params.page) || 1), pages);
  let q = base.clone().select('p.*',
    knex.raw('(SELECT COUNT(*) FROM purchase_order_items l WHERE l.purchase_order_id = p.id) as line_count'),
    knex.raw('(SELECT COALESCE(SUM(l.quantity), 0) FROM purchase_order_items l WHERE l.purchase_order_id = p.id) as qty_total'),
    knex.raw('(SELECT COALESCE(SUM(LEAST(l.received_quantity, l.quantity)), 0) FROM purchase_order_items l WHERE l.purchase_order_id = p.id) as qty_received'),
    knex.raw('(SELECT COALESCE(SUM(l.quantity * l.unit_cost), 0) FROM purchase_order_items l WHERE l.purchase_order_id = p.id) as cost_total'))
    .orderByRaw("CASE WHEN p.status = 'draft' THEN 0 ELSE 1 END").orderByRaw('COALESCE(p.sent_at, p.created_at) DESC').orderBy('p.id', 'desc');
  if (!all) q = q.limit(perPage).offset((page - 1) * perPage);
  const rows = (await q).map((r) => ({ ...r, line_count: num(r.line_count), qty_total: num(r.qty_total), qty_received: num(r.qty_received), cost_total: num(r.cost_total) }));
  const counts = Object.fromEntries((await knex('purchase_orders').where('business_id', ctx.businessId).groupBy('status').select('status').count({ n: '*' })).map((r) => [r.status, Number(r.n)]));
  return { rows, counts, meta: { total, page, pages, perPage } };
}

// ---------------------------------------------------------------- drafts
const qty = () => z.preprocess((v) => (v === '' || v === undefined || v === null ? 0 : Number(String(v).replace(/,/g, ''))),
  z.number({ invalid_type_error: 'Enter a number.' }).finite('Enter a number.').min(0, 'Must be zero or more.').max(1e9, 'Too large.'));
const optMoney = () => z.preprocess((v) => (v === '' || v === undefined || v === null ? undefined : Number(String(v).replace(/,/g, ''))),
  z.number({ invalid_type_error: 'Enter a number.' }).finite('Enter a number.').min(0, 'Must be zero or more.').max(1e10, 'Too large.').optional());
const lineSchema = z.object({
  supply_item_id: z.preprocess(emptyToUndefined, z.coerce.number({ invalid_type_error: 'Choose a valid value.' }).int().positive().optional()),
  name: optionalString(190), unit: optionalString(40), quantity: qty(), unit_cost: optMoney(),
});

const rawLines = (input) => {
  const l = input && input.lines;
  if (!l) return [];
  return Array.isArray(l) ? l.map((v, i) => [String(i), v]) : Object.entries(l);
};

/** Validates the submitted lines; keeps those with a quantity; item lines take the item's current name/unit. */
async function resolveLines(ctx, input, trx = knex) {
  const errors = {};
  const out = [];
  const byItem = new Map();
  const itemRows = await trx('supply_items').where('business_id', ctx.businessId).select('id', 'name', 'unit', 'vendor_product_id', 'unit_cost');
  const items = new Map(itemRows.map((r) => [r.id, r]));
  for (const [key, raw] of rawLines(input)) {
    const r = lineSchema.safeParse(raw || {});
    if (!r.success) { for (const is of r.error.issues) errors[`lines.${key}.${is.path.join('.')}`] = errors[`lines.${key}.${is.path.join('.')}`] || is.message; continue; } // eslint-disable-line no-continue
    const d = r.data;
    if (d.quantity <= 0) continue; // eslint-disable-line no-continue
    if (d.supply_item_id) {
      const it = items.get(d.supply_item_id);
      if (!it) { errors[`lines.${key}.supply_item_id`] = 'Choose a valid value.'; continue; } // eslint-disable-line no-continue
      if (byItem.has(it.id)) { const prev = byItem.get(it.id); prev.quantity = round2(prev.quantity + d.quantity); continue; } // eslint-disable-line no-continue
      const line = { supply_item_id: it.id, vendor_product_id: it.vendor_product_id || null, name: it.name, unit: it.unit || null, quantity: round2(d.quantity), unit_cost: d.unit_cost !== undefined ? d.unit_cost : null };
      byItem.set(it.id, line);
      out.push(line);
    } else {
      if (!d.name) { errors[`lines.${key}.name`] = 'Required.'; continue; } // eslint-disable-line no-continue
      out.push({ supply_item_id: null, vendor_product_id: null, name: d.name, unit: d.unit || null, quantity: round2(d.quantity), unit_cost: d.unit_cost !== undefined ? d.unit_cost : null });
    }
  }
  if (Object.keys(errors).length) throw E.validation(errors);
  if (!out.length) throw E.validation({ lines: 'Add at least one item.' });
  return out;
}

const lineSummary = (lines) => lines.map((l) => `${l.name} × ${num(l.quantity)}`).join('; ').slice(0, 2000);

/** Creates (id = null) or replaces a draft: supplier, notes and lines. Only drafts can be edited. */
async function saveDraft(ctx, id, input) {
  const head = validate(z.object({
    supplier_id: z.preprocess(emptyToUndefined, z.coerce.number({ required_error: 'Required.', invalid_type_error: 'Required.' }).int().positive('Required.')),
    notes: optionalString(3000),
  }), input);
  const supplier = await getSupplier(ctx, head.supplier_id);
  const lines = await resolveLines(ctx, input);
  return knex.transaction(async (trx) => {
    const row = { supplier_id: supplier.id, supplier_name: supplier.name, vendor_id: activeVendorId(supplier), notes: head.notes || null };
    let poId = id;
    if (id) {
      const before = await trx('purchase_orders').where({ id, business_id: ctx.businessId }).forUpdate().first();
      if (!before) throw E.notFound('Purchase order');
      if (before.status !== 'draft') throw conflict('PO_NOT_DRAFT');
      const oldLines = await trx('purchase_order_items').where({ purchase_order_id: id });
      await trx('purchase_order_items').where({ purchase_order_id: id }).del();
      await trx('purchase_orders').where({ id }).update({ ...row, updated_at: new Date() });
      await audit.record(ctx, 'purchase_order.updated', { entityType: 'purchase_order', entityId: id, oldValues: { supplier: before.supplier_name, lines: lineSummary(oldLines) }, newValues: { supplier: supplier.name, lines: lineSummary(lines) } }, trx);
    } else {
      [poId] = await trx('purchase_orders').insert({ ...row, business_id: ctx.businessId, po_number: null, status: 'draft', created_by: ctx.userId });
      await audit.record(ctx, 'purchase_order.created', { entityType: 'purchase_order', entityId: poId, newValues: { supplier: supplier.name, lines: lineSummary(lines) } }, trx);
    }
    await trx('purchase_order_items').insert(lines.map((l) => ({ ...l, purchase_order_id: poId })));
    return poId;
  });
}

/**
 * "Order low-stock items": one draft per supplier with every low item (suggested quantity), skipping items already
 * on an open order. Lines are added to an existing draft of that supplier instead of opening a second one.
 * Returns { drafts: [ids], noSupplier: n, alreadyOrdered: n }.
 */
async function draftLowStock(ctx) {
  const low = await knex('supply_items').where('business_id', ctx.businessId).whereRaw('current_stock <= reorder_level').orderBy('name')
    .select('id', 'name', 'unit', 'supplier_id', 'current_stock', 'reorder_level', 'vendor_product_id');
  const pending = await onOrder(ctx);
  const groups = new Map();
  let noSupplier = 0; let alreadyOrdered = 0;
  for (const it of low) {
    const q = suggestQty(it.current_stock, it.reorder_level);
    if (!q) continue; // eslint-disable-line no-continue
    if (pending[it.id] > 0) { alreadyOrdered += 1; continue; } // eslint-disable-line no-continue
    if (!it.supplier_id) { noSupplier += 1; continue; } // eslint-disable-line no-continue
    if (!groups.has(it.supplier_id)) groups.set(it.supplier_id, []);
    groups.get(it.supplier_id).push({ supply_item_id: it.id, vendor_product_id: it.vendor_product_id || null, name: it.name, unit: it.unit || null, quantity: q, unit_cost: null });
  }
  const drafts = [];
  for (const [supplierId, lines] of groups) {
    const supplier = await getSupplier(ctx, supplierId); // eslint-disable-line no-await-in-loop
    const id = await knex.transaction(async (trx) => { // eslint-disable-line no-await-in-loop
      const draft = await trx('purchase_orders').where({ business_id: ctx.businessId, supplier_id: supplierId, status: 'draft' }).orderBy('id', 'desc').forUpdate().first('id');
      let poId = draft && draft.id;
      if (poId) {
        const have = new Set((await trx('purchase_order_items').where({ purchase_order_id: poId }).whereNotNull('supply_item_id').select('supply_item_id')).map((r) => r.supply_item_id));
        const add = lines.filter((l) => !have.has(l.supply_item_id));
        if (add.length) {
          await trx('purchase_order_items').insert(add.map((l) => ({ ...l, purchase_order_id: poId })));
          await trx('purchase_orders').where({ id: poId }).update({ updated_at: new Date() });
          await audit.record(ctx, 'purchase_order.updated', { entityType: 'purchase_order', entityId: poId, newValues: { added: lineSummary(add), source: 'low_stock' } }, trx);
        }
      } else {
        [poId] = await trx('purchase_orders').insert({ business_id: ctx.businessId, po_number: null, status: 'draft', supplier_id: supplier.id, supplier_name: supplier.name, vendor_id: activeVendorId(supplier), created_by: ctx.userId });
        await trx('purchase_order_items').insert(lines.map((l) => ({ ...l, purchase_order_id: poId })));
        await audit.record(ctx, 'purchase_order.created', { entityType: 'purchase_order', entityId: poId, newValues: { supplier: supplier.name, lines: lineSummary(lines), source: 'low_stock' } }, trx);
      }
      return poId;
    });
    drafts.push(id);
  }
  return { drafts, noSupplier, alreadyOrdered };
}

async function removeDraft(ctx, id) {
  await knex.transaction(async (trx) => {
    const po = await trx('purchase_orders').where({ id, business_id: ctx.businessId }).forUpdate().first();
    if (!po) throw E.notFound('Purchase order');
    if (po.status !== 'draft') throw conflict('PO_NOT_DRAFT');
    const lines = await trx('purchase_order_items').where({ purchase_order_id: id });
    await trx('purchase_orders').where({ id }).del();
    await audit.record(ctx, 'purchase_order.deleted', { entityType: 'purchase_order', entityId: id, oldValues: { supplier: po.supplier_name, lines: lineSummary(lines) } }, trx);
  });
}

// ---------------------------------------------------------------- numbering & sending
/** Next purchase-order number of the clinic, claimed with a row lock (same pattern as invoice numbers). */
async function claimPoNumber(businessId, trx) {
  const row = await trx('businesses').where({ id: businessId }).forUpdate().first('po_next_number');
  const n = Number(row.po_next_number) || 1;
  await trx('businesses').where({ id: businessId }).update({ po_next_number: n + 1 });
  businesses.forget(businessId);
  return n;
}

/** How a draft would go out right now: e-mail (configured + recipient) and/or the vendor portal. */
async function dispatchPlan(ctx, po) {
  const supplier = po.supplier_id ? await getSupplier(ctx, po.supplier_id).catch(() => null) : null;
  const to = supplier ? recipientOf(supplier) : po.sent_to_email;
  const vendorId = supplier ? activeVendorId(supplier) : po.vendor_id;
  return { supplier, to: to || null, vendorId: vendorId || null, mail: mailer.configured() && Boolean(to), mailConfigured: mailer.configured() };
}

async function senderContact(ctx) {
  const u = await knex('users').where({ id: ctx.userId }).first('name', 'email', 'phone');
  const clinic = await businesses.get(ctx.businessId);
  return { contact_name: (u && u.name) || null, contact_phone: (u && u.phone) || clinic.phone || null, contact_email: (u && u.email) || clinic.email || null };
}

async function markOut(ctx, id, { to, vendorId, action }) {
  const contact = await senderContact(ctx);
  return knex.transaction(async (trx) => {
    const po = await trx('purchase_orders').where({ id, business_id: ctx.businessId }).forUpdate().first();
    if (!po) throw E.notFound('Purchase order');
    if (po.status !== 'draft') throw conflict('PO_NOT_DRAFT');
    const [{ n }] = await trx('purchase_order_items').where({ purchase_order_id: id }).count({ n: '*' });
    if (!Number(n)) throw E.validation({ lines: 'Add at least one item.' });
    const number = po.po_number || await claimPoNumber(ctx.businessId, trx);
    const now = new Date();
    await trx('purchase_orders').where({ id }).update({ po_number: number, status: 'sent', sent_at: now, sent_by: ctx.userId, sent_to_email: to || null, vendor_id: vendorId || null, ...contact, updated_at: now });
    await audit.record(ctx, action, { entityType: 'purchase_order', entityId: id, oldValues: { status: 'draft' }, newValues: { status: 'sent', po_number: number, to: to || null, vendor_id: vendorId || null } }, trx);
    return number;
  });
}

async function mailOrder(ctx, id, to, baseUrl, kind = 'order') {
  const po = await get(ctx, id);
  const clinic = await businesses.get(ctx.businessId);
  const vendorLink = po.vendor_id && po.vendor_status === 'active' && baseUrl ? `${String(baseUrl).replace(/\/+$/, '')}/vendor/orders/${po.id}` : null;
  const { subject, html } = buildEmail({ po, clinic, vendorLink, kind });
  await mailer.send({ to, subject, html });
}

/**
 * Sends a draft. E-mail goes out when SMTP is configured and the supplier (or its vendor) has an address; an
 * approved vendor also sees the order in its portal. With neither, nothing changes (MAIL_NOT_CONFIGURED /
 * PO_NO_EMAIL) and the page offers copy / print / WhatsApp. If the e-mail fails, the order goes back to draft.
 */
async function send(ctx, id, { baseUrl = '' } = {}) {
  const po = await get(ctx, id);
  if (po.status !== 'draft') throw conflict('PO_NOT_DRAFT');
  const plan = await dispatchPlan(ctx, po);
  if (!plan.mail && !plan.vendorId) throw conflict(plan.mailConfigured ? 'PO_NO_EMAIL' : 'MAIL_NOT_CONFIGURED');
  const number = await markOut(ctx, id, { to: plan.mail ? plan.to : null, vendorId: plan.vendorId, action: 'purchase_order.sent' });
  if (plan.mail) {
    try {
      await mailOrder(ctx, id, plan.to, baseUrl);
    } catch (err) {
      await knex.transaction(async (trx) => {
        await trx('purchase_orders').where({ id, business_id: ctx.businessId, status: 'sent' }).update({ status: 'draft', sent_at: null, sent_to_email: null, vendor_id: plan.vendorId, updated_at: new Date() });
        await audit.record(ctx, 'purchase_order.send_failed', { entityType: 'purchase_order', entityId: id, newValues: { to: plan.to, error: String(err.message || err).slice(0, 200) } }, trx);
      });
      throw new AppError('PO_MAIL_FAILED', 'The e-mail could not be sent.', 502);
    }
  }
  return { number, emailed: plan.mail, to: plan.to, portal: Boolean(plan.vendorId) };
}

/** The clinic shared the order itself (WhatsApp, print, phone): record it as sent, honestly without an e-mail. */
async function markSent(ctx, id) {
  const po = await get(ctx, id);
  const plan = await dispatchPlan(ctx, po);
  const number = await markOut(ctx, id, { to: null, vendorId: plan.vendorId, action: 'purchase_order.marked_sent' });
  return { number, portal: Boolean(plan.vendorId) };
}

async function resend(ctx, id, { baseUrl = '' } = {}) {
  const po = await get(ctx, id);
  if (!OPEN.includes(po.status)) throw conflict('PO_NOT_OPEN');
  const plan = await dispatchPlan(ctx, po);
  if (!plan.mailConfigured) throw conflict('MAIL_NOT_CONFIGURED');
  if (!plan.to) throw conflict('PO_NO_EMAIL');
  try { await mailOrder(ctx, id, plan.to, baseUrl); } catch { throw new AppError('PO_MAIL_FAILED', 'The e-mail could not be sent.', 502); }
  await knex('purchase_orders').where({ id }).update({ sent_to_email: plan.to, updated_at: new Date() });
  await audit.record(ctx, 'purchase_order.resent', { entityType: 'purchase_order', entityId: id, newValues: { to: plan.to } });
  return { to: plan.to };
}

async function cancel(ctx, id, { baseUrl = '' } = {}) {
  const po = await knex.transaction(async (trx) => {
    const row = await trx('purchase_orders').where({ id, business_id: ctx.businessId }).forUpdate().first();
    if (!row) throw E.notFound('Purchase order');
    if (!OPEN.includes(row.status)) throw conflict('PO_NOT_OPEN');
    await trx('purchase_orders').where({ id }).update({ status: 'cancelled', cancelled_at: new Date(), updated_at: new Date() });
    await audit.record(ctx, 'purchase_order.cancelled', { entityType: 'purchase_order', entityId: id, oldValues: { status: row.status }, newValues: { status: 'cancelled' } }, trx);
    return row;
  });
  // Tell the supplier when it was e-mailed the order (best effort).
  if (po.sent_to_email && mailer.configured()) await mailOrder(ctx, id, po.sent_to_email, baseUrl, 'cancel').catch(() => {});
}

// ---------------------------------------------------------------- receiving
/** Records what arrived (per line, full or partial): stock-in movements "PO #n" and, when complete, status received. */
async function receive(ctx, id, input) {
  return knex.transaction(async (trx) => {
    const po = await trx('purchase_orders').where({ id, business_id: ctx.businessId }).forUpdate().first();
    if (!po) throw E.notFound('Purchase order');
    if (!OPEN.includes(po.status)) throw conflict('PO_NOT_OPEN');
    const lines = await trx('purchase_order_items').where({ purchase_order_id: id }).orderBy('id');
    const recv = (input && input.recv) || {};
    const errors = {};
    const plan = [];
    for (const l of lines) {
      const r = qty().safeParse(recv[`l${l.id}`] !== undefined ? recv[`l${l.id}`] : recv[l.id]); // "l<id>" keys: numeric keys would be compacted into an array
      if (!r.success) { errors[`recv.${l.id}`] = r.error.issues[0].message; continue; } // eslint-disable-line no-continue
      const remaining = round2(num(l.quantity) - num(l.received_quantity));
      if (r.data > remaining + EPS) { errors[`recv.${l.id}`] = 'Too large.'; continue; } // eslint-disable-line no-continue
      if (r.data > 0) plan.push({ line: l, q: round2(r.data) });
    }
    if (Object.keys(errors).length) throw E.validation(errors);
    if (!plan.length) throw conflict('PO_NOTHING_RECEIVED');
    for (const { line, q } of plan) {
      await trx('purchase_order_items').where({ id: line.id }).update({ received_quantity: round2(num(line.received_quantity) + q) }); // eslint-disable-line no-await-in-loop
      line.received_quantity = round2(num(line.received_quantity) + q);
      const item = line.supply_item_id ? await trx('supply_items').where({ id: line.supply_item_id, business_id: ctx.businessId }).first('id') : null; // eslint-disable-line no-await-in-loop
      if (item) await supplies.move(ctx, item.id, { type: 'in', quantity: q, note: `PO #${po.po_number}` }, trx); // eslint-disable-line no-await-in-loop
    }
    const complete = lines.every((l) => num(l.received_quantity) + EPS >= num(l.quantity));
    const now = new Date();
    await trx('purchase_orders').where({ id }).update({ status: complete ? 'received' : po.status, received_at: complete ? now : null, updated_at: now });
    await audit.record(ctx, 'purchase_order.received', { entityType: 'purchase_order', entityId: id, oldValues: { status: po.status }, newValues: { status: complete ? 'received' : po.status, received: plan.map((p) => `${p.line.name} × ${p.q}`).join('; ').slice(0, 2000) } }, trx);
    return { complete, lines: plan.length };
  });
}

// ---------------------------------------------------------------- texts (e-mail, copy, WhatsApp)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const qfmt = (n) => { const v = num(n); return Number.isInteger(v) ? String(v) : String(round2(v)); };

function dateIn(d, timezone) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d ? new Date(d) : new Date()); } catch { return new Date().toISOString().slice(0, 10); }
}

const clinicName = (clinic, locale) => (locale === 'en' && clinic.name_en ? clinic.name_en : clinic.name);
const poTitle = (t, po) => (po.po_number ? t('purchasing.po_no', { n: po.po_number }) : t('purchasing.draft_po'));

/** Plain-text order (copy / WhatsApp / e-mail fallback), in one language. */
function orderText(po, clinic, locale = 'ar') {
  const t = translator(locale);
  const out = [`${poTitle(t, po)} — ${clinicName(clinic, locale)}`, `${t('purchasing.txt.date')}: ${dateIn(po.sent_at || po.created_at, clinic.timezone)}`, `${t('purchasing.txt.to')}: ${po.supplier_name}`, ''];
  po.lines.forEach((l, i) => out.push(`${i + 1}. ${l.name}${l.unit ? ` (${l.unit})` : ''}: ${qfmt(l.quantity)}`));
  if (po.notes) out.push('', `${t('purchasing.txt.notes')}: ${po.notes}`);
  const contact = [po.contact_name, po.contact_phone || clinic.phone, clinic.address].filter(Boolean).join(' · ');
  if (contact) out.push('', `${t('purchasing.txt.contact')}: ${contact}`);
  out.push('', t('purchasing.txt.please_confirm'));
  return out.join('\n');
}

/** Bilingual (Arabic + English) HTML e-mail: clinic contact, number, date, items, notes, confirm request. No costs. */
function buildEmail({ po, clinic, vendorLink = null, kind = 'order' }) {
  const c = brand.colors.light;
  const block = (locale) => {
    const t = translator(locale);
    const dir = locale === 'ar' ? 'rtl' : 'ltr';
    const align = locale === 'ar' ? 'right' : 'left';
    const th = `style="text-align:${align};padding:8px 10px;border-bottom:1px solid ${c.border};font-size:12px;color:${c.textMuted}"`;
    const td = `style="text-align:${align};padding:8px 10px;border-bottom:1px solid ${c.border};font-size:14px"`;
    const rows = po.lines.map((l, i) => `<tr><td ${td}>${i + 1}</td><td ${td}>${esc(l.name)}</td><td ${td}>${esc(l.unit || '—')}</td><td ${td}><b>${esc(qfmt(l.quantity))}</b></td></tr>`).join('');
    const info = [
      [t('purchasing.mail.clinic'), clinicName(clinic, locale)],
      [t('purchasing.mail.address'), [clinic.address, clinic.city].filter(Boolean).join('، ')],
      [t('purchasing.mail.phone'), clinic.phone],
      [t('purchasing.mail.contact'), [po.contact_name, po.contact_phone, po.contact_email].filter(Boolean).join(' · ')],
      [t('purchasing.mail.number'), po.po_number ? `#${po.po_number}` : ''],
      [t('purchasing.mail.date'), dateIn(po.sent_at || po.created_at, clinic.timezone)],
    ].filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:3px 0;color:${c.textMuted};font-size:13px;width:34%;vertical-align:top">${esc(k)}</td><td style="padding:3px 0;font-size:13px">${esc(v)}</td></tr>`).join('');
    if (kind === 'cancel') {
      return `<div dir="${dir}" style="text-align:${align}"><h2 style="font-size:17px;margin:0 0 10px">${esc(t('purchasing.mail.cancel_title', { n: po.po_number, clinic: clinicName(clinic, locale) }))}</h2>
<p style="line-height:1.7;margin:0 0 12px">${esc(t('purchasing.mail.cancel_body'))}</p><table style="width:100%;border-collapse:collapse;margin:0 0 8px">${info}</table></div>`;
    }
    return `<div dir="${dir}" style="text-align:${align}">
<h2 style="font-size:17px;margin:0 0 6px">${esc(t('purchasing.mail.title', { n: po.po_number || '', clinic: clinicName(clinic, locale) }))}</h2>
<p style="line-height:1.7;margin:0 0 14px;color:${c.textMuted}">${esc(t('purchasing.mail.intro', { supplier: po.supplier_name }))}</p>
<table style="width:100%;border-collapse:collapse;margin:0 0 16px">${info}</table>
<table style="width:100%;border-collapse:collapse;margin:0 0 16px"><thead><tr><th ${th}>#</th><th ${th}>${esc(t('purchasing.item'))}</th><th ${th}>${esc(t('purchasing.unit'))}</th><th ${th}>${esc(t('purchasing.quantity'))}</th></tr></thead><tbody>${rows}</tbody></table>
${po.notes ? `<p style="line-height:1.7;margin:0 0 14px"><b>${esc(t('purchasing.txt.notes'))}:</b> ${esc(po.notes)}</p>` : ''}
<p style="line-height:1.7;margin:0 0 14px;font-weight:bold">${esc(t('purchasing.mail.please_confirm'))}</p>
${vendorLink ? `<p style="margin:0 0 8px"><a href="${esc(vendorLink)}" style="display:inline-block;background:${c.primary};color:${c.primaryInk};padding:9px 16px;border-radius:999px;text-decoration:none;font-weight:bold">${esc(t('purchasing.mail.open_portal'))}</a></p>` : ''}
</div>`;
  };
  const subject = kind === 'cancel'
    ? `${translator('ar')('purchasing.mail.cancel_subject', { n: po.po_number })} / ${translator('en')('purchasing.mail.cancel_subject', { n: po.po_number })} — ${clinic.name}`
    : `${translator('ar')('purchasing.po_no', { n: po.po_number })} / ${translator('en')('purchasing.po_no', { n: po.po_number })} — ${clinic.name}`;
  const html = `<!doctype html><html><body style="margin:0;background:${c.background};font-family:Arial,Tahoma,sans-serif;color:${c.text}">
<div style="max-width:620px;margin:24px auto;background:${c.surface};border:1px solid ${c.border};border-radius:12px;padding:28px">
<div style="font-weight:800;font-size:16px;color:${c.primary};margin-bottom:18px">${esc(brand.name)}</div>
${block('ar')}<hr style="border:0;border-top:1px solid ${c.border};margin:22px 0">${block('en')}
</div></body></html>`;
  return { subject, html };
}

// ---------------------------------------------------------------- vendor portal
const vendorScope = (vendorId) => knex('purchase_orders as p').where('p.vendor_id', vendorId).whereNot('p.status', 'draft');

async function vendorList(vendor, params = {}, { perPage = 25 } = {}) {
  if (!vendor || vendor.status !== 'active') return { rows: [], counts: {}, meta: { total: 0, page: 1, pages: 1, perPage } };
  const base = vendorScope(vendor.id);
  if (['sent', 'acknowledged', 'received', 'cancelled'].includes(params.status)) base.andWhere('p.status', params.status);
  const [{ n }] = await base.clone().count({ n: '*' });
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, Number(params.page) || 1), pages);
  const rows = await base.clone().join('businesses as b', 'b.id', 'p.business_id')
    .select('p.id', 'p.po_number', 'p.status', 'p.sent_at', 'p.acknowledged_at', 'p.received_at', 'p.cancelled_at', 'b.name as clinic_name', 'b.name_en as clinic_name_en', 'b.city as clinic_city', 'b.timezone as clinic_timezone',
      knex.raw('(SELECT COUNT(*) FROM purchase_order_items l WHERE l.purchase_order_id = p.id) as line_count'))
    .orderBy('p.sent_at', 'desc').orderBy('p.id', 'desc').limit(perPage).offset((page - 1) * perPage);
  const counts = Object.fromEntries((await vendorScope(vendor.id).groupBy('p.status').select('p.status').count({ n: '*' })).map((r) => [r.status, Number(r.n)]));
  return { rows: rows.map((r) => ({ ...r, line_count: num(r.line_count) })), counts, meta: { total, page, pages, perPage } };
}

/** One order as the vendor sees it — explicit fields only (clinic contact, items, quantities; no costs, no patients). */
async function vendorGet(vendor, id) {
  if (!vendor || vendor.status !== 'active') throw E.notFound('Purchase order');
  const p = await vendorScope(vendor.id).where('p.id', id).join('businesses as b', 'b.id', 'p.business_id')
    .first('p.id', 'p.business_id', 'p.po_number', 'p.status', 'p.notes', 'p.sent_at', 'p.acknowledged_at', 'p.received_at', 'p.cancelled_at', 'p.vendor_note', 'p.vendor_noted_at',
      'p.contact_name', 'p.contact_phone', 'p.contact_email', 'p.supplier_name',
      'b.name as clinic_name', 'b.name_en as clinic_name_en', 'b.city as clinic_city', 'b.address as clinic_address', 'b.phone as clinic_phone', 'b.email as clinic_email', 'b.map_url as clinic_map_url', 'b.timezone as clinic_timezone');
  if (!p) throw E.notFound('Purchase order');
  p.lines = await knex('purchase_order_items as l').leftJoin('vendor_products as vp', function j() { this.on('vp.id', 'l.vendor_product_id').andOn('vp.vendor_id', knex.raw('?', [vendor.id])); })
    .where('l.purchase_order_id', id).orderBy('l.id').select('l.id', 'l.name', 'l.unit', 'l.quantity', 'l.received_quantity', 'vp.sku as product_sku', 'vp.name as product_name');
  return p;
}

const vctxAudit = (vctx, businessId) => ({ businessId, userId: vctx.userId, ip: vctx.ip, userAgent: vctx.userAgent });

async function notifyClinic(po, vendor, key, trx) {
  const ar = translator('ar'); const en = translator('en');
  await notifications.notify(po.business_id, {
    permission: 'supplies.manage', type: `purchasing.${key}`, severity: 'info', link: `/app/supplies/orders/${po.id}`,
    title: `${ar(`purchasing.notify.${key}`, { n: po.po_number, vendor: vendor.name })} · ${en(`purchasing.notify.${key}`, { n: po.po_number, vendor: vendor.name_en || vendor.name })}`,
    body: po.vendor_note ? String(po.vendor_note).slice(0, 250) : null,
  }, trx);
}

const noteSchema = z.object({ note: optionalString(1000) });

/** The vendor confirms a sent order (optionally with a note to the clinic). */
async function acknowledge(vendor, vctx, id, input = {}) {
  const d = validate(noteSchema, input);
  if (!vendor || vendor.status !== 'active') throw E.notFound('Purchase order');
  return knex.transaction(async (trx) => {
    const po = await trx('purchase_orders').where({ id, vendor_id: vendor.id }).whereNot('status', 'draft').forUpdate().first();
    if (!po) throw E.notFound('Purchase order');
    if (po.status !== 'sent') throw conflict('PO_NOT_SENT');
    const now = new Date();
    const patch = { status: 'acknowledged', acknowledged_at: now, updated_at: now, ...(d.note ? { vendor_note: d.note, vendor_noted_at: now } : {}) };
    await trx('purchase_orders').where({ id }).update(patch);
    await audit.record(vctxAudit(vctx, po.business_id), 'purchase_order.acknowledged', { entityType: 'purchase_order', entityId: id, oldValues: { status: 'sent' }, newValues: { status: 'acknowledged', vendor_id: vendor.id, note: d.note || null } }, trx);
    await notifyClinic({ ...po, ...patch }, vendor, 'acknowledged', trx);
  });
}

/** The vendor leaves (or updates) a note for the clinic on an order that is still active. */
async function vendorNote(vendor, vctx, id, input = {}) {
  const d = validate(z.object({ note: z.string().trim().min(1, 'Required.').max(1000, 'Too large.') }), input);
  if (!vendor || vendor.status !== 'active') throw E.notFound('Purchase order');
  return knex.transaction(async (trx) => {
    const po = await trx('purchase_orders').where({ id, vendor_id: vendor.id }).whereNot('status', 'draft').forUpdate().first();
    if (!po) throw E.notFound('Purchase order');
    if (po.status === 'cancelled') throw conflict('PO_NOT_OPEN');
    const now = new Date();
    await trx('purchase_orders').where({ id }).update({ vendor_note: d.note, vendor_noted_at: now, updated_at: now });
    await audit.record(vctxAudit(vctx, po.business_id), 'purchase_order.vendor_note', { entityType: 'purchase_order', entityId: id, oldValues: { note: po.vendor_note }, newValues: { note: d.note, vendor_id: vendor.id } }, trx);
    await notifyClinic({ ...po, vendor_note: d.note }, vendor, 'note', trx);
  });
}

module.exports = {
  STATUSES, OPEN, suggestQty, getSupplier, activeVendorId, recipientOf, listSuppliers, listItems, onOrder, get, list, progress,
  saveDraft, draftLowStock, removeDraft, claimPoNumber, dispatchPlan, send, markSent, resend, cancel, receive,
  orderText, buildEmail, dateIn, vendorList, vendorGet, acknowledge, vendorNote,
};
