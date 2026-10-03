// Clinic side of the reps & warehouses marketplace: offers and products that registered vendors target at the
// clinic's specialty, the vendors directory, and the two links into the clinic's supplies:
//   • "add vendor as supplier"  → one `suppliers` row per clinic+vendor (vendor_id set), never duplicated
//   • "add product to supplies" → one `supply_items` row per clinic+vendor product (vendor_product_id set)
// Only ACTIVE vendors (approved by the platform) and their active products / published, in-date offers are visible.
// These are read queries against the vendor tables so this module does not depend on the vendor portal's service.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { z, validate, money } = require('../../core/validate');
const supplies = require('../clinic/supplies.service');

const SPECIALTIES = ['general', 'dentistry', 'dermatology', 'paediatrics', 'obgyn', 'orthopaedics', 'ophthalmology', 'ent', 'cardiology',
  'physiotherapy', 'psychiatry', 'nutrition', 'cosmetic', 'multi', 'other'];
// Clinics with one of these (or no) specialty see everything and get a specialty filter.
const BROAD = new Set(['general', 'multi', 'other']);
const TARGETABLE = SPECIALTIES.filter((s) => !['multi', 'other'].includes(s));

/** The specialty a clinic's catalog is limited to, or null when it sees all specialties. */
function clinicSpecialty(business) {
  const s = business && business.specialty;
  return s && SPECIALTIES.includes(s) && !BROAD.has(s) ? s : null;
}

/** The specialty filter actually applied: the clinic's own one, or (for broad clinics) the chosen filter. */
function effectiveSpecialty(business, requested) {
  return clinicSpecialty(business) || (TARGETABLE.includes(requested) ? requested : null);
}

const PER_PAGE = 24;
const page = (p) => Math.max(1, Math.min(1000, Number.parseInt(p, 10) || 1));
const like = (q) => `%${String(q).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ---------------------------------------------------------------- offers
/** Published offers that are valid today (clinic time zone) from active vendors. */
function liveOffers(today, trx = knex) {
  return trx('vendor_offers as o').join('vendors as v', 'v.id', 'o.vendor_id')
    .where({ 'o.status': 'published', 'v.status': 'active' })
    .andWhere((q) => q.whereNull('o.starts_on').orWhere('o.starts_on', '<=', today))
    .andWhere((q) => q.whereNull('o.ends_on').orWhere('o.ends_on', '>=', today));
}

const targets = (table, col, specialty) => function sub() {
  this.select(knex.raw('1')).from(`${table} as ts`).whereRaw(`ts.${col} = ${table === 'vendor_offer_specialties' ? 'o' : 'p'}.id`).andWhere('ts.specialty', specialty);
};

/**
 * Who an offer reaches: target 'clinics' → only the clinics the vendor picked; target 'specialty' → clinics of the
 * offer's specialties (broad clinics: all), limited to the offer's cities when it has any.
 */
function reach(q, business, spec) {
  const bid = Number(business && business.id) || 0;
  const city = String((business && business.city) || '').trim().toLowerCase();
  return q.andWhere((w) => w
    .where((x) => x.where('o.target', 'clinics').whereExists(function sub() { this.select(knex.raw('1')).from('vendor_offer_targets as vt').whereRaw('vt.offer_id = o.id').andWhere('vt.business_id', bid); }))
    .orWhere((x) => {
      x.where('o.target', 'specialty');
      if (spec) x.whereExists(targets('vendor_offer_specialties', 'offer_id', spec));
      x.andWhere((y) => y.whereNotExists(function sub() { this.select(knex.raw('1')).from('vendor_offer_cities as vc').whereRaw('vc.offer_id = o.id'); })
        .orWhereExists(function sub() { this.select(knex.raw('1')).from('vendor_offer_cities as vc').whereRaw('vc.offer_id = o.id').andWhere('vc.city', city); }));
    }));
}

async function offers(ctx, business, { specialty, vendor, show } = {}) {
  const spec = effectiveSpecialty(business, specialty);
  const q = liveOffers(ctx.today)
    .leftJoin('vendor_offer_views as w', function j() { this.on('w.offer_id', 'o.id').andOn('w.business_id', knex.raw('?', [ctx.businessId])); })
    .select('o.id', 'o.vendor_id', 'o.title', 'o.title_en', 'o.body', 'o.body_en', 'o.starts_on', 'o.ends_on', 'o.published_at', 'o.image_mime',
      'v.name as vendor_name', 'v.name_en as vendor_name_en', 'v.type as vendor_type', 'v.logo_mime as vendor_logo_mime', 'w.seen_at', 'w.dismissed_at')
    .orderByRaw('COALESCE(o.published_at, o.created_at) DESC').orderBy('o.id', 'desc').limit(200);
  reach(q, business, spec);
  if (vendor) q.andWhere('o.vendor_id', Number(vendor) || 0);
  if (show === 'dismissed') q.whereNotNull('w.dismissed_at'); else q.whereNull('w.dismissed_at');
  const rows = await q;
  await attachSpecialties(rows, 'vendor_offer_specialties', 'offer_id');
  return rows;
}

/** Badge count: offers this clinic has not opened yet (same targeting rules as the Offers tab). */
async function newOffersCount(ctx, business) {
  const spec = clinicSpecialty(business);
  const q = liveOffers(ctx.today).whereNotExists(function sub() {
    this.select(knex.raw('1')).from('vendor_offer_views as w').whereRaw('w.offer_id = o.id').andWhere('w.business_id', ctx.businessId);
  });
  reach(q, business, spec);
  const [{ c }] = await q.count({ c: 'o.id' });
  return Number(c);
}

/** One live offer (with its vendor and linked products); opening it records the clinic's view once. */
async function offer(ctx, business, id) {
  const spec = clinicSpecialty(business);
  const o = await reach(liveOffers(ctx.today).where('o.id', Number(id) || 0), business, spec)
    .first('o.*', 'v.name as vendor_name', 'v.name_en as vendor_name_en', 'v.type as vendor_type', 'v.logo_mime as vendor_logo_mime');
  if (!o) throw E.notFound('Offer');
  const specs = (await knex('vendor_offer_specialties').where({ offer_id: o.id }).pluck('specialty'));
  delete o.image;
  o.specialties = specs;
  o.products = await productQuery(ctx).whereIn('p.id', knex('vendor_offer_products').where({ offer_id: o.id }).select('product_id')).orderBy('p.name');
  o.vendor = await vendorPublic(o.vendor_id);
  await knex('vendor_offer_views').insert({ offer_id: o.id, business_id: ctx.businessId }).onConflict(['offer_id', 'business_id']).ignore();
  const view = await knex('vendor_offer_views').where({ offer_id: o.id, business_id: ctx.businessId }).first('dismissed_at');
  o.dismissed_at = view ? view.dismissed_at : null;
  return o;
}

async function setDismissed(ctx, business, id, dismissed) {
  const o = await liveOffers(ctx.today).where('o.id', Number(id) || 0).first('o.id');
  if (!o) throw E.notFound('Offer');
  await knex('vendor_offer_views').insert({ offer_id: o.id, business_id: ctx.businessId, dismissed_at: dismissed ? new Date() : null })
    .onConflict(['offer_id', 'business_id']).merge({ dismissed_at: dismissed ? new Date() : null });
  await audit.record(ctx, dismissed ? 'vendor_offer.dismissed' : 'vendor_offer.restored', { entityType: 'vendor_offer', entityId: o.id });
}

// ---------------------------------------------------------------- products
function productQuery(ctx) {
  return knex('vendor_products as p').join('vendors as v', 'v.id', 'p.vendor_id')
    .leftJoin('supply_items as si', function j() { this.on('si.vendor_product_id', 'p.id').andOn('si.business_id', knex.raw('?', [ctx.businessId])); })
    .where({ 'p.is_active': true, 'v.status': 'active' })
    .select('p.id', 'p.vendor_id', 'p.name', 'p.name_en', 'p.brand', 'p.sku', 'p.description', 'p.description_en', 'p.unit', 'p.pack_size', 'p.price', 'p.currency',
      'p.image_mime', 'v.name as vendor_name', 'v.name_en as vendor_name_en', 'v.type as vendor_type', 'si.id as supply_item_id');
}

async function products(ctx, business, { specialty, q, vendor, page: p } = {}) {
  const spec = effectiveSpecialty(business, specialty);
  const base = productQuery(ctx);
  if (spec) base.whereExists(targets('vendor_product_specialties', 'product_id', spec));
  if (vendor) base.andWhere('p.vendor_id', Number(vendor) || 0);
  if (q && String(q).trim()) {
    const s = like(q);
    base.andWhere((w) => w.where('p.name', 'like', s).orWhere('p.name_en', 'like', s).orWhere('p.brand', 'like', s).orWhere('p.sku', 'like', s).orWhere('v.name', 'like', s));
  }
  const [{ c }] = await base.clone().clearSelect().clearOrder().countDistinct({ c: 'p.id' });
  const total = Number(c);
  const current = page(p);
  const rows = await base.orderBy('p.name').orderBy('p.id').limit(PER_PAGE).offset((current - 1) * PER_PAGE);
  await attachSpecialties(rows, 'vendor_product_specialties', 'product_id');
  return { rows, meta: { page: current, perPage: PER_PAGE, total, pages: Math.max(1, Math.ceil(total / PER_PAGE)) } };
}

async function product(ctx, business, id) {
  const p = await productQuery(ctx).where('p.id', Number(id) || 0).first();
  if (!p) throw E.notFound('Product');
  const specs = await knex('vendor_product_specialties').where({ product_id: p.id }).pluck('specialty');
  const spec = clinicSpecialty(business);
  if (spec && !specs.includes(spec)) throw E.notFound('Product');
  p.specialties = specs;
  p.vendor = await vendorPublic(p.vendor_id);
  return p;
}

async function attachSpecialties(rows, table, col) {
  if (!rows.length) return;
  const links = await knex(table).whereIn(col, rows.map((r) => r.id)).select(col, 'specialty');
  const by = {};
  links.forEach((l) => { (by[l[col]] = by[l[col]] || []).push(l.specialty); });
  rows.forEach((r) => { r.specialties = by[r.id] || []; });
}

// ---------------------------------------------------------------- vendors
/** Public profile of an active vendor (contact details a clinic may use). */
async function vendorPublic(id) {
  const v = await knex('vendors').where({ id: Number(id) || 0, status: 'active' })
    .first('id', 'type', 'name', 'name_en', 'contact_name', 'email', 'phone', 'whatsapp', 'city', 'about', 'about_en', 'logo_mime');
  if (!v) return null;
  v.specialties = await knex('vendor_specialties').where({ vendor_id: v.id }).pluck('specialty');
  return v;
}

async function vendors(ctx, business, { specialty, q } = {}) {
  const spec = effectiveSpecialty(business, specialty);
  const counts = knex('vendor_products').where({ is_active: true }).select('vendor_id').count({ n: 'id' }).groupBy('vendor_id').as('pc');
  const query = knex('vendors as v').leftJoin(counts, 'pc.vendor_id', 'v.id')
    .leftJoin('suppliers as s', function j() { this.on('s.vendor_id', 'v.id').andOn('s.business_id', knex.raw('?', [ctx.businessId])); })
    .where('v.status', 'active')
    .select('v.id', 'v.type', 'v.name', 'v.name_en', 'v.contact_name', 'v.email', 'v.phone', 'v.whatsapp', 'v.city', 'v.logo_mime',
      knex.raw('COALESCE(pc.n, 0) as products_count'), 's.id as supplier_id')
    .orderBy('v.name').limit(300);
  if (spec) {
    query.andWhere((w) => w.whereExists(function a() { this.select(knex.raw('1')).from('vendor_specialties as vs').whereRaw('vs.vendor_id = v.id').andWhere('vs.specialty', spec); })
      .orWhereExists(function b() {
        this.select(knex.raw('1')).from('vendor_products as p2').join('vendor_product_specialties as ps', 'ps.product_id', 'p2.id')
          .whereRaw('p2.vendor_id = v.id').andWhere({ 'p2.is_active': true, 'ps.specialty': spec });
      }));
  }
  if (q && String(q).trim()) { const s = like(q); query.andWhere((w) => w.where('v.name', 'like', s).orWhere('v.name_en', 'like', s).orWhere('v.city', 'like', s)); }
  const rows = await query;
  const uniq = [];
  const seen = new Set();
  rows.forEach((r) => { if (!seen.has(r.id)) { seen.add(r.id); uniq.push(r); } });
  return uniq;
}

/** Active vendors that have at least one visible product (for the products tab's vendor filter). */
async function vendorOptions(business, specialty) {
  const spec = effectiveSpecialty(business, specialty);
  const q = knex('vendors as v').join('vendor_products as p', 'p.vendor_id', 'v.id').where({ 'v.status': 'active', 'p.is_active': true })
    .distinct('v.id', 'v.name', 'v.name_en').orderBy('v.name');
  if (spec) q.whereExists(function e() { this.select(knex.raw('1')).from('vendor_product_specialties as ps').whereRaw('ps.product_id = p.id').andWhere('ps.specialty', spec); });
  return q;
}

/** Logo / product image / offer image of an active vendor. */
async function image(kind, id) {
  const n = Number(id) || 0;
  if (kind === 'vendor') return knex('vendors').where({ id: n, status: 'active' }).whereNotNull('logo').first('logo as data', 'logo_mime as mime');
  if (kind === 'product') {
    return knex('vendor_products as p').join('vendors as v', 'v.id', 'p.vendor_id').where({ 'p.id': n, 'p.is_active': true, 'v.status': 'active' })
      .whereNotNull('p.image').first('p.image as data', 'p.image_mime as mime');
  }
  if (kind === 'offer') {
    return knex('vendor_offers as o').join('vendors as v', 'v.id', 'o.vendor_id').where({ 'o.id': n, 'o.status': 'published', 'v.status': 'active' })
      .whereNotNull('o.image').first('o.image as data', 'o.image_mime as mime');
  }
  return null;
}

// ---------------------------------------------------------------- links into the clinic's supplies
async function withLock(name, fn) {
  const conn = await knex.client.acquireConnection();
  try {
    const [[{ got }]] = await knex.raw('SELECT GET_LOCK(?, 10) AS got', [name]).connection(conn);
    if (Number(got) !== 1) throw new AppError('SLOT_BUSY', 'The system is busy — please try again.', 409);
    try { return await fn(); } finally { await knex.raw('SELECT RELEASE_LOCK(?)', [name]).connection(conn); }
  } finally { await knex.client.releaseConnection(conn); }
}

/**
 * The clinic's supplier row for a vendor: the one already linked, else an unlinked supplier with the same e-mail
 * (linked now), else a new one. Returns { id, created }.
 */
async function ensureSupplier(ctx, vendorId) {
  const v = await vendorPublic(vendorId);
  if (!v) throw E.notFound('Vendor');
  return withLock(`mk_sup_${ctx.businessId}_${v.id}`, async () => {
    const linked = await knex('suppliers').where({ business_id: ctx.businessId, vendor_id: v.id }).first('id');
    if (linked) return { id: linked.id, created: false, vendor: v };
    const byEmail = v.email && await knex('suppliers').where({ business_id: ctx.businessId, email: v.email }).whereNull('vendor_id').first('id');
    if (byEmail) {
      await supplies.suppliers.update(ctx, byEmail.id, { vendor_id: v.id });
      return { id: byEmail.id, created: false, linked: true, vendor: v };
    }
    const id = await supplies.suppliers.create(ctx, {
      vendor_id: v.id, name: (v.name || '').slice(0, 190), email: v.email || null, phone: v.phone || v.whatsapp || null,
      contact_name: v.contact_name || null, is_active: true,
    });
    return { id, created: true, vendor: v };
  });
}

/** True when the clinic already has this vendor as a supplier. */
async function supplierFor(ctx, vendorId) {
  return Boolean(await knex('suppliers').where({ business_id: ctx.businessId, vendor_id: vendorId }).first('id'));
}

/**
 * Adds a vendor product to the clinic's supply items (once). The supplier row for its vendor is created/linked first.
 * Returns { id, created }.
 */
async function addToSupplies(ctx, business, productId, input, locale = 'ar') {
  const d = validate(z.object({ reorder_level: money(1e9), current_stock: money(1e9), unit_cost: money() }), input);
  const p = await product(ctx, business, productId);
  const existing = await knex('supply_items').where({ business_id: ctx.businessId, vendor_product_id: p.id }).first('id');
  if (existing) return { id: existing.id, created: false };
  const sup = await ensureSupplier(ctx, p.vendor_id);
  return withLock(`mk_item_${ctx.businessId}_${p.id}`, async () => {
    const again = await knex('supply_items').where({ business_id: ctx.businessId, vendor_product_id: p.id }).first('id');
    if (again) return { id: again.id, created: false };
    const name = (locale === 'en' && p.name_en ? p.name_en : p.name) + (p.pack_size ? ` (${p.pack_size})` : '');
    const id = await supplies.saveItem(ctx, null, {
      name: name.slice(0, 190), unit: p.unit || '', supplier_id: String(sup.id), reorder_level: d.reorder_level, current_stock: d.current_stock, unit_cost: d.unit_cost,
    });
    await knex('supply_items').where({ id, business_id: ctx.businessId }).update({ vendor_product_id: p.id });
    await audit.record(ctx, 'supply_item.linked_vendor_product', { entityType: 'supply_item', entityId: id, newValues: { vendor_product_id: p.id, vendor_id: p.vendor_id } });
    return { id, created: true };
  });
}

module.exports = {
  SPECIALTIES, TARGETABLE, BROAD, clinicSpecialty, effectiveSpecialty, offers, newOffersCount, offer, setDismissed,
  products, product, vendors, vendorOptions, vendorPublic, image, ensureSupplier, supplierFor, addToSupplies, withLock,
};
