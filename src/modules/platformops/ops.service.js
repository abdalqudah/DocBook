// Clinic modules on/off, invoice print template and service categories (worker: platformops).
//
// Modules: optional areas a clinic can hide. Core areas (appointments, patients, settings, team) are not listed and
// can never be turned off. Turning an area off hides its menu items and blocks its pages (gate.js) — the data stays.
// "Online booking" is the clinic's existing booking switch (businesses.booking_enabled), so there is one source of
// truth. An area whose feature the clinic's subscription plan does not include is unavailable whatever the toggle says.
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { z, validate, optionalString } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const businesses = require('../businesses/business.service');
const subs = require('../subscriptions/subscriptions.service');
const entitlements = require('../subscriptions/entitlements');

// Path prefix (relative to /app) that matches the segment and everything under it.
const seg = (p) => new RegExp(`^/${p}(?:/|$)`);

// nav: keys of src/routes/nav.js items; feature: subscriptions plan feature; paths: /app sub-paths that are blocked.
const MODULES = [
  { key: 'online_booking', icon: 'globe', proxy: 'booking_enabled', paths: [seg('settings/booking-links'), seg('website/booking/links'), seg('reports/bookings')] },
  { key: 'online_consultations', icon: 'video', feature: 'online_consultations', paths: [seg('telehealth')] },
  { key: 'billing', icon: 'banknote', nav: ['cashier', 'billing', 'payments_all', 'cash_closings'], actions: ['collect_payment'], paths: [seg('cashier'), seg('billing'), seg('payments'), seg('settings/payments')] },
  { key: 'doctor_payroll', icon: 'wallet', nav: ['payroll'], paths: [seg('payroll')] },
  { key: 'staff_salaries', icon: 'users', nav: ['staff_payroll'], paths: [seg('staff-payroll')] },
  { key: 'finance', icon: 'receipt-text', nav: ['expenses', 'budgets', 'profit_loss', 'partners'], actions: ['new_expense'], paths: [seg('expenses'), seg('budgets'), seg('finance'), seg('partners')] },
  { key: 'supplies', icon: 'package', nav: ['supplies'], paths: [seg('supplies')] },
  { key: 'marketplace', icon: 'package-search', nav: ['marketplace', 'rep_visits'], paths: [seg('marketplace'), seg('rep-visits')] },
  { key: 'certificates', icon: 'badge-check', nav: ['certificates'], actions: ['new_certificate'], paths: [seg('certificates')] },
  { key: 'reviews', icon: 'star', nav: ['reviews'], paths: [seg('reviews'), seg('website/reviews')] },
  { key: 'specialty_records', icon: 'heart-pulse', feature: 'specialty_modules', paths: [seg('specialty'), /^\/patients\/\d+\/(?:dental|growth|pregnancy)(?:\/|$)/] },
  { key: 'ai_assistant', icon: 'sparkles', feature: 'ai_assistant', paths: [seg('settings/ai'), /^\/visits\/\d+\/ai(?:\/|$)/, seg('finance/assistant'), seg('ai')] },
  { key: 'attendance', icon: 'clock', nav: ['attendance'], paths: [seg('attendance')] },
  { key: 'queue_screens', icon: 'monitor', paths: [seg('queue-screens')] },
  { key: 'staff_chat', icon: 'message-circle', paths: [seg('chat')] },
  { key: 'patient_sharing', icon: 'send', paths: [seg('share')] },
  { key: 'staff_mail', icon: 'mail', paths: [seg('mail')] },
  { key: 'centres', icon: 'pill-bottle', paths: [seg('centres'), seg('settings/partners')] },
  { key: 'reports', icon: 'chart-pie', nav: ['reports'], paths: [seg('reports')] },
];
const KEYS = MODULES.map((m) => m.key);
const CORE = ['appointments', 'patients', 'settings', 'team'];
const byKey = Object.fromEntries(MODULES.map((m) => [m.key, m]));

// ---------------------------------------------------------------- stored settings (one row per clinic)
const parse = (v, fallback) => { if (!v) return fallback; if (typeof v === 'object') return v; try { return JSON.parse(v) ?? fallback; } catch { return fallback; } };

const row = (businessId) => cache.remember(`pops:${businessId}`, async () => {
  const r = await knex('clinic_ops_settings').where({ business_id: businessId }).first();
  return { disabled: parse(r && r.disabled_modules, []).filter((k) => KEYS.includes(k)), invoice: parse(r && r.invoice_template, {}) };
}, 60_000);
const forget = (businessId) => cache.forgetPrefix(`pops:${businessId}`);

async function write(businessId, userId, patch, trx = knex) {
  const now = new Date();
  await trx('clinic_ops_settings').insert({ business_id: businessId, updated_by: userId || null, ...patch, created_at: now, updated_at: now })
    .onConflict('business_id').merge({ ...patch, updated_by: userId || null, updated_at: now });
  forget(businessId);
}

/** Plan features of the clinic (null = everything included: subscriptions off, trial without a plan, comped…). */
async function planFeatures(business) {
  const cfg = await subs.settings();
  if (!cfg.enabled || !business) return null;
  return cache.remember(`pops:${business.id}:plan`, async () => {
    const today = subs.todayOf(business);
    const sub = await subs.ensure(business, today, cfg);
    const plan = await subs.getPlan(sub && sub.plan_id);
    return plan ? plan.features : null;
  }, 30_000);
}

/**
 * A plan entitlement for this clinic (src/modules/subscriptions/entitlements.js): bool, limit (null = none) or list
 * ('*' = all). Everything is included while subscriptions are off, without a plan, or for a comped clinic.
 */
async function entitled(business, key) {
  return entitlements.valueIn(await planFeatures(business), key);
}

/**
 * The clinic's module state → { on: Set, off: Set, notInPlan: Set, list:[{key, on, inPlan, toggled}] }.
 * `business` is the clinic row (req.business); online booking follows business.booking_enabled.
 */
async function state(business) {
  const [{ disabled }, features] = await Promise.all([row(business.id), planFeatures(business)]);
  const off = new Set(); const notInPlan = new Set();
  const list = MODULES.map((m) => {
    const inPlan = !m.feature || !features || Boolean(features[m.feature]);
    const toggled = m.proxy ? Boolean(business[m.proxy]) : !disabled.includes(m.key);
    if (!inPlan) notInPlan.add(m.key);
    if (!inPlan || !toggled) off.add(m.key);
    return { key: m.key, icon: m.icon, feature: m.feature || null, on: inPlan && toggled, toggled, inPlan };
  });
  return { off, notInPlan, list, on: new Set(KEYS.filter((k) => !off.has(k))) };
}

/** Which module (if any) owns an /app sub-path. */
function moduleForPath(path) {
  // A longer, more specific prefix wins (e.g. /reports/bookings is online booking, /finance/assistant is the AI).
  let best = null; let len = -1;
  for (const m of MODULES) {
    for (const re of m.paths) {
      const hit = re.exec(path);
      if (hit && hit[0].length > len) { best = m.key; len = hit[0].length; }
    }
  }
  return best;
}

/** Nav keys / quick actions hidden by the modules that are off. */
function hiddenNav(off) {
  const nav = new Set();
  for (const k of off) for (const n of [...(byKey[k].nav || []), ...(byKey[k].actions || [])]) nav.add(n);
  return nav;
}

/** Saves the toggles. `input[key] === '1'` means on. Areas outside the plan keep their stored value. */
async function saveModules(ctx, business, input) {
  const cur = await state(business);
  const { disabled: before } = await row(business.id);
  const wantOn = (k) => input[k] === '1' || input[k] === 'on' || input[k] === true;
  const disabled = MODULES.filter((m) => !m.proxy).filter((m) => (cur.notInPlan.has(m.key) ? before.includes(m.key) : !wantOn(m.key))).map((m) => m.key);
  const turnedOff = disabled.filter((k) => !before.includes(k));
  const turnedOn = before.filter((k) => !disabled.includes(k));
  await knex.transaction(async (trx) => {
    await write(business.id, ctx.userId, { disabled_modules: JSON.stringify(disabled) }, trx);
    if (turnedOff.length || turnedOn.length) {
      await audit.record(ctx, 'clinic.modules_updated', { entityType: 'clinic', entityId: business.id, oldValues: { disabled: before }, newValues: { disabled, turned_off: turnedOff, turned_on: turnedOn } }, trx);
    }
    // Online consultations off: stop taking new online bookings too (turning it back on leaves that to its own settings page).
    if (turnedOff.includes('online_consultations') && business.online_enabled) {
      await trx('businesses').where({ id: business.id }).update({ online_enabled: false, updated_at: new Date() });
      await audit.record(ctx, 'clinic.updated', { entityType: 'clinic', entityId: business.id, oldValues: { online_enabled: true }, newValues: { online_enabled: false } }, trx);
    }
  });
  // Online booking is the clinic's booking switch itself (audited by updateProfile).
  const booking = wantOn('online_booking');
  if (Boolean(business.booking_enabled) !== booking) await businesses.updateProfile(ctx, { booking_enabled: booking });
  businesses.forget(business.id);
  forget(business.id);
  return { turnedOff, turnedOn };
}

// ---------------------------------------------------------------- invoice template
const PAPERS = ['a4', 'a5', 'receipt80'];
const FIELDS = ['show_logo', 'show_name', 'show_contact', 'show_tax', 'show_doctor', 'show_service', 'show_insurance', 'show_discount', 'show_method', 'show_stamp'];
// Letterhead layout: where the logo and the clinic name (with its address) sit — start / center / end of the page
// width — and the logo size. The invoice title, number and date take the free side.
const PLACES = ['start', 'center', 'end'];
const LOGO_SIZES = ['s', 'm', 'l', 'xl'];
const INVOICE_DEFAULTS = { paper: 'a4', prefix: '', footer: '', footer_en: '', logo_pos: 'start', name_pos: 'start', logo_size: 'm', ...Object.fromEntries(FIELDS.map((f) => [f, true])) };

async function invoiceTemplate(businessId) {
  const { invoice } = await row(businessId);
  return { ...INVOICE_DEFAULTS, ...invoice };
}

const bool = z.preprocess((v) => v === '1' || v === 'on' || v === true, z.boolean());
const invoiceSchema = z.object({
  paper: z.enum(PAPERS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  prefix: z.preprocess((v) => String(v ?? '').trim(), z.string().max(12, 'Too long.').regex(/^[A-Za-z0-9\-/_.]*$/, 'Choose a valid value.')),
  footer: z.preprocess((v) => String(v ?? '').trim(), z.string().max(300, 'Too long.')),
  footer_en: z.preprocess((v) => String(v ?? '').trim(), z.string().max(300, 'Too long.')),
  tax_number: optionalString(60),
  next_number: z.preprocess((v) => (v === '' || v === undefined || v === null ? undefined : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(1, 'Too small.').max(4_000_000_000, 'Too large.').optional()),
  logo_pos: z.preprocess((v) => v || 'start', z.enum(PLACES, { errorMap: () => ({ message: 'Choose a valid value.' }) })),
  name_pos: z.preprocess((v) => v || 'start', z.enum(PLACES, { errorMap: () => ({ message: 'Choose a valid value.' }) })),
  logo_size: z.preprocess((v) => v || 'm', z.enum(LOGO_SIZES, { errorMap: () => ({ message: 'Choose a valid value.' }) })),
  ...Object.fromEntries(FIELDS.map((f) => [f, bool])),
});

/**
 * Raises the next invoice number. It can only go up (never reuse or skip back over issued numbers); audited.
 * Throws INVOICE_NUMBER_DOWN (422) when the new value is not above the current one.
 */
async function raiseInvoiceNumber(ctx, next) {
  const n = Number(next);
  if (!Number.isInteger(n) || n < 1) throw E.validation({ next_number: 'Enter a number.' });
  return knex.transaction(async (trx) => {
    const b = await trx('businesses').where({ id: ctx.businessId }).forUpdate().first('invoice_next_number');
    const cur = Number(b.invoice_next_number);
    if (n === cur) return cur;
    const [{ top }] = await trx('invoices').where({ business_id: ctx.businessId }).max({ top: 'invoice_number' });
    if (n < cur || n <= Number(top || 0)) throw new AppError('INVOICE_NUMBER_DOWN', 'The next invoice number can only be raised.', 422, { next_number: 'INVOICE_NUMBER_DOWN', current: cur });
    await trx('businesses').where({ id: ctx.businessId }).update({ invoice_next_number: n, updated_at: new Date() });
    await audit.record(ctx, 'clinic.invoice_number_raised', { entityType: 'clinic', entityId: ctx.businessId, oldValues: { invoice_next_number: cur }, newValues: { invoice_next_number: n } }, trx);
    businesses.forget(ctx.businessId);
    return n;
  });
}

async function saveInvoiceTemplate(ctx, input) {
  const d = validate(invoiceSchema, input);
  const { tax_number: tax, next_number: next, ...tpl } = d;
  if (next !== undefined) {
    // Check the number first so that a refused number saves nothing (raiseInvoiceNumber re-checks under a lock).
    const b = await knex('businesses').where({ id: ctx.businessId }).first('invoice_next_number');
    if (next < Number(b.invoice_next_number)) throw new AppError('INVOICE_NUMBER_DOWN', 'The next invoice number can only be raised.', 422, { next_number: 'INVOICE_NUMBER_DOWN', current: Number(b.invoice_next_number) });
  }
  const before = await invoiceTemplate(ctx.businessId);
  await write(ctx.businessId, ctx.userId, { invoice_template: JSON.stringify(tpl) });
  const { oldValues, newValues, changed } = audit.diff(before, tpl);
  if (changed) await audit.record(ctx, 'clinic.invoice_template_updated', { entityType: 'clinic', entityId: ctx.businessId, oldValues, newValues });
  await businesses.updateProfile(ctx, { tax_number: tax || null });
  if (next !== undefined) await raiseInvoiceNumber(ctx, next);
  return tpl;
}

// ---------------------------------------------------------------- service categories
const categorySchema = z.object({
  name: z.string({ required_error: 'Required.' }).trim().min(1, 'Required.').max(120, 'Too long.'),
  name_en: optionalString(120),
  sort_order: z.preprocess((v) => (v === '' || v === undefined || v === null ? 0 : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(-1000, 'Too small.').max(1000, 'Too large.')),
  is_active: bool,
});

const listCategories = (businessId, { activeOnly = false } = {}) => {
  const q = knex('service_categories').where({ business_id: businessId }).orderBy([{ column: 'sort_order' }, { column: 'name' }, { column: 'id' }]);
  if (activeOnly) q.where({ is_active: true });
  return q;
};

async function saveCategory(ctx, id, input) {
  const d = validate(categorySchema, input);
  const data = { ...d, name_en: d.name_en || null };
  if (input && input.site_field === '1') data.show_on_site = ['1', 'on', true].includes(input.show_on_site);
  if (id) {
    const before = await knex('service_categories').where({ id, business_id: ctx.businessId }).first();
    if (!before) throw E.notFound('Category');
    await knex('service_categories').where({ id, business_id: ctx.businessId }).update({ ...data, updated_at: new Date() });
    const { oldValues, newValues, changed } = audit.diff(before, data);
    if (changed) await audit.record(ctx, 'service_category.updated', { entityType: 'service_category', entityId: id, oldValues, newValues });
    return id;
  }
  const [newId] = await knex('service_categories').insert({ ...data, business_id: ctx.businessId });
  await audit.record(ctx, 'service_category.created', { entityType: 'service_category', entityId: newId, newValues: data });
  return newId;
}

/** Deletes a category; its services stay and simply have no category. */
async function removeCategory(ctx, id) {
  const before = await knex('service_categories').where({ id, business_id: ctx.businessId }).first();
  if (!before) throw E.notFound('Category');
  await knex.transaction(async (trx) => {
    await trx('services').where({ business_id: ctx.businessId, category_id: id }).update({ category_id: null });
    await trx('service_categories').where({ id, business_id: ctx.businessId }).del();
    await audit.record(ctx, 'service_category.deleted', { entityType: 'service_category', entityId: id, oldValues: { name: before.name, name_en: before.name_en } }, trx);
  });
}

/** The category id from a form value (null for none); throws 422 when it is not one of the clinic's categories. */
async function checkCategory(ctx, categoryId) {
  const cid = categoryId === '' || categoryId === undefined || categoryId === null ? null : Number(categoryId);
  if (cid !== null && (!Number.isInteger(cid) || !(await knex('service_categories').where({ id: cid, business_id: ctx.businessId }).first('id')))) throw E.validation({ category_id: 'Choose a valid value.' });
  return cid;
}

/** Sets (or clears) a service's category; the category must belong to the clinic. */
async function setServiceCategory(ctx, serviceId, categoryId) {
  const cid = await checkCategory(ctx, categoryId);
  const s = await knex('services').where({ id: serviceId, business_id: ctx.businessId }).first('id', 'category_id');
  if (!s || (s.category_id ?? null) === cid) return;
  await knex('services').where({ id: serviceId, business_id: ctx.businessId }).update({ category_id: cid });
  await audit.record(ctx, 'service.updated', { entityType: 'service', entityId: serviceId, oldValues: { category_id: s.category_id }, newValues: { category_id: cid } });
}

/**
 * Groups rows by category: [{ category|null, items }], categories in their order, "other" (no/inactive category) last.
 * `catOf(row)` returns the row's category id.
 */
function groupByCategory(rows, categories, catOf = (r) => r.category_id) {
  const groups = categories.map((c) => ({ category: c, items: [] }));
  const idx = Object.fromEntries(categories.map((c, i) => [c.id, i]));
  const other = { category: null, items: [] };
  for (const r of rows) { const i = idx[catOf(r)]; if (i !== undefined) groups[i].items.push(r); else other.items.push(r); }
  return [...groups.filter((g) => g.items.length), ...(other.items.length ? [other] : [])];
}

module.exports = {
  entitled,
  MODULES, KEYS, CORE, state, moduleForPath, hiddenNav, saveModules, forget,
  PAPERS, FIELDS, PLACES, LOGO_SIZES, INVOICE_DEFAULTS, invoiceTemplate, saveInvoiceTemplate, raiseInvoiceNumber,
  listCategories, saveCategory, removeCategory, checkCategory, setServiceCategory, groupByCategory,
};
