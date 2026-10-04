// Medical reps, drug warehouses and supplier companies ("vendors"): accounts, profile, products, offers,
// platform moderation — and the read helpers the clinic side uses (catalog by specialty, offers).
//
// ─── Clinic-side read helpers (stable API, used by src/modules/marketplace/*) ──────────────────────────────
//   TARGET_SPECIALTIES                      specialty keys a product/offer can target (auth.json → specialties.*)
//   scopeForClinic(clinicSpecialty)         → the specialty to filter by, or null = everything ('multi'/'general'/'other'/none)
//   productsForSpecialty({ specialty, q, vendorId, limit = 24, offset = 0 })
//                                           → { rows: [publicProduct], total }   active vendors + active products only;
//                                             specialty null/'' = all specialties
//   product(id)                             → publicProduct | null               (same visibility rules)
//   vendorPublic(id)                        → publicVendor | null                (active vendors only)
//   offersForSpecialty(specialty, { today, businessId, includeDismissed = false, limit = 20 })
//                                           → [publicOffer]  published, active vendor, starts_on ≤ today ≤ ends_on (open ends allowed);
//                                             with businessId each row has seen_at / dismissed_at for that clinic
//   countNewOffers(specialty, businessId, today) → number of visible offers that clinic has not seen yet
//   offer(id, { today } = {})               → publicOffer | null                 (published + active vendor; within dates when today given)
//   recordOfferView(offerId, businessId)    → marks an offer seen by a clinic (idempotent, keeps the first seen_at)
//   dismissOffer(offerId, businessId)       → marks it seen + dismissed for that clinic
//
//   publicProduct = { id, vendor_id, name, name_en, brand, sku, unit, pack_size, price, currency, description, description_en,
//                     has_image, image_url, specialties: [key], vendor: { id, type, name, name_en, city, has_logo, logo_url } }
//   publicVendor  = { id, type, name, name_en, contact_name, email, phone, whatsapp, country, city, about, about_en,
//                     has_logo, logo_url, specialties: [key] }
//   publicOffer   = { id, vendor_id, title, title_en, body, body_en, has_image, image_url, starts_on, ends_on, published_at,
//                     specialties: [key], products: [{ id, name, name_en }], vendor: {…as above}, seen_at?, dismissed_at? }
//
// ─── Images ─────────────────────────────────────────────────────────────────────────────────────────────────
//   IMAGE_MAX_BYTES (1 MB), sniffImage(buf) → 'image/png' | 'image/jpeg' | 'image/webp' | null (never SVG)
//   productImageUrl(row) / offerImageUrl(row) / logoUrl(row) → '/vendors/media/<kind>/<id>/<version>.<ext>' | null
//   (rows need id, image_mime|logo_mime and updated_at). Served by vendors/public.web.js with nosniff.
//   mediaFile(kind, id, viewer) → { mime, data, version, isPublic } | null
//
// Vendors never see patient data: nothing here reads patients, appointments or clinical tables.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const authService = require('../auth/auth.service');
const { SPECIALTIES, COUNTRIES, ZONES } = require('../settings/options');
const { CURRENCIES } = require('../../core/money');
const { z, validate, optionalString, emptyToUndefined, isoDate, email, password } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const billing = require('../vendorbilling/billing.service');
const notifications = require('../notifications/notification.service');
const pnotify = require('../platformnotify/notify.service');

const TYPES = ['rep', 'warehouse', 'company', 'events']; // events: conferences, exhibitions and medical events organisers
const STATUSES = ['pending', 'active', 'suspended'];
const OFFER_STATUSES = ['draft', 'published', 'archived'];
const TARGET_SPECIALTIES = SPECIALTIES.filter((s) => s !== 'multi');
const OPEN_SPECIALTIES = ['multi', 'general', 'other'];
const IMAGE_MAX_BYTES = 1024 * 1024;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// ---------------------------------------------------------------- small helpers
const like = (q) => `%${String(q).trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
const now = () => new Date();

/** Real type from the first bytes (PNG, JPEG, WebP only — never SVG or anything else). */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Checks an uploaded file; throws a field validation error. Returns { data, mime } or null when no file. */
function checkImage(file, field = 'image', uploadError = null) {
  if (uploadError === 'too_big') throw E.validation({ [field]: 'The image must be 1 MB or smaller.' });
  if (uploadError) throw E.validation({ [field]: 'Use a PNG, JPEG or WebP image.' });
  if (!file || !file.buffer || !file.buffer.length) return null;
  if (file.buffer.length > IMAGE_MAX_BYTES) throw E.validation({ [field]: 'The image must be 1 MB or smaller.' });
  const mime = sniffImage(file.buffer);
  if (!mime) throw E.validation({ [field]: 'Use a PNG, JPEG or WebP image.' });
  return { data: file.buffer, mime };
}

const version = (updatedAt) => Math.floor(new Date(updatedAt || 0).getTime() / 1000).toString(36);
const mediaUrl = (kind, id, mime, updatedAt) => (mime && EXT[mime] ? `/vendors/media/${kind}/${id}/${version(updatedAt)}.${EXT[mime]}` : null);
const productImageUrl = (p) => mediaUrl('product', p.id, p.image_mime, p.updated_at);
const offerImageUrl = (o) => mediaUrl('offer', o.id, o.image_mime, o.updated_at);
const logoUrl = (v) => mediaUrl('logo', v.id, v.logo_mime, v.updated_at);

/** Vendor "today": the vendor's country time zone (Amman when unknown). */
function todayFor(vendor) {
  const zone = ((vendor && vendor.country && ZONES.find((zz) => zz[1] === vendor.country)) || ['Asia/Amman'])[0];
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); }
}

const scopeForClinic = (specialty) => (!specialty || OPEN_SPECIALTIES.includes(specialty) || !TARGET_SPECIALTIES.includes(specialty) ? null : specialty);

async function specialtiesOf(table, key, ids) {
  if (!ids.length) return {};
  const rows = await knex(table).whereIn(key, ids).select(key, 'specialty');
  const out = {};
  for (const r of rows) (out[r[key]] = out[r[key]] || []).push(r.specialty);
  for (const k of Object.keys(out)) out[k].sort((a, b) => TARGET_SPECIALTIES.indexOf(a) - TARGET_SPECIALTIES.indexOf(b));
  return out;
}

async function replaceSpecialties(trx, table, key, id, list) {
  await trx(table).where({ [key]: id }).del();
  if (list.length) await trx(table).insert([...new Set(list)].map((s) => ({ [key]: id, specialty: s })));
}

// ---------------------------------------------------------------- validation
const specialtiesField = () => z.preprocess((v) => (v === undefined || v === null || v === '' ? [] : [].concat(v)),
  z.array(z.enum(TARGET_SPECIALTIES, { errorMap: () => ({ message: 'Choose a valid value.' }) })).min(1, 'Choose at least one specialty.'));
const phoneField = () => z.preprocess(emptyToUndefined, z.string().trim().max(40).regex(/^\+?[0-9 ()-]{6,40}$/, 'Enter a valid phone number.').optional());
const optionalDate = () => z.preprocess(emptyToUndefined, isoDate().optional());

const profileSchema = {
  type: z.enum(TYPES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  name: z.string().trim().min(2, 'Enter the company or trade name.').max(190),
  name_en: optionalString(190),
  contact_name: z.string().trim().min(2, 'Enter the contact person\'s name.').max(190),
  phone: phoneField(),
  whatsapp: phoneField(),
  country: z.preprocess(emptyToUndefined, z.enum(COUNTRIES, { errorMap: () => ({ message: 'Choose a valid value.' }) }).optional()),
  city: optionalString(100),
  specialties: specialtiesField(),
};

const vendorFields = (d) => ({
  type: d.type, name: d.name, name_en: d.name_en || null, contact_name: d.contact_name, phone: d.phone || null, whatsapp: d.whatsapp || null,
  country: d.country || null, city: d.city || null,
});

// ---------------------------------------------------------------- registration
/**
 * New account + vendor (pending) + owner link + target specialties, in one transaction.
 * `input` is the raw form body (validated here). Returns { userId, vendorId }.
 */
async function signup(input, { locale = 'ar', ctx = {} } = {}) {
  const d = validate(z.object({
    ...profileSchema,
    email: email(),
    password: password(),
    terms: z.literal('on', { errorMap: () => ({ message: 'Please accept the terms to continue.' }) }),
  }), input);
  if (await knex('users').where({ email: d.email }).first('id')) throw E.conflict('VENDOR_EMAIL_TAKEN', 'An account with this e-mail already exists. Sign in first, then register as a rep.');
  const out = await knex.transaction(async (trx) => {
    const userId = await authService.createUser(trx, { name: d.contact_name, email: d.email, password: d.password, locale });
    if (d.phone) await trx('users').where({ id: userId }).update({ phone: d.phone });
    const [vendorId] = await trx('vendors').insert({ ...vendorFields(d), email: d.email, status: 'pending' });
    await trx('vendor_users').insert({ vendor_id: vendorId, user_id: userId, role: 'owner' });
    await replaceSpecialties(trx, 'vendor_specialties', 'vendor_id', vendorId, d.specialties);
    await audit.record({ ...ctx, businessId: null, userId }, 'vendor.registered', { entityType: 'vendor', entityId: vendorId, newValues: { name: d.name, type: d.type, email: d.email } }, trx);
    await pnotify.admin('vendor_signup', { name: d.name, type: d.type }, { link: `/admin/vendors/${vendorId}`, severity: 'warning' }, trx);
    return { userId, vendorId };
  });
  return out;
}

/** A signed-in account (no vendor yet) registers as a rep / warehouse. Returns the vendor id. */
async function registerExisting(user, input, { ctx = {} } = {}) {
  const d = validate(z.object({
    ...profileSchema,
    terms: z.literal('on', { errorMap: () => ({ message: 'Please accept the terms to continue.' }) }),
  }), input);
  if (await vendorOfUser(user.id)) throw E.conflict('VENDOR_EXISTS', 'This account already belongs to a rep or supplier.');
  return knex.transaction(async (trx) => {
    const [vendorId] = await trx('vendors').insert({ ...vendorFields(d), email: user.email, status: 'pending' });
    await trx('vendor_users').insert({ vendor_id: vendorId, user_id: user.id, role: 'owner' });
    await replaceSpecialties(trx, 'vendor_specialties', 'vendor_id', vendorId, d.specialties);
    await audit.record({ ...ctx, businessId: null, userId: user.id }, 'vendor.registered', { entityType: 'vendor', entityId: vendorId, newValues: { name: d.name, type: d.type, email: user.email } }, trx);
    await pnotify.admin('vendor_signup', { name: d.name, type: d.type }, { link: `/admin/vendors/${vendorId}`, severity: 'warning' }, trx);
    return vendorId;
  });
}

/** The vendor row (any status) a user belongs to, or null. */
const vendorOfUser = (userId) => knex('vendor_users as vu').join('vendors as v', 'v.id', 'vu.vendor_id').where('vu.user_id', userId)
  .orderBy('vu.id').first('v.id', 'v.status', 'v.name', 'vu.role');

// ---------------------------------------------------------------- vendor portal: profile
const PROFILE_COLS = ['id', 'type', 'name', 'name_en', 'contact_name', 'email', 'phone', 'whatsapp', 'country', 'city', 'about', 'about_en',
  'logo_mime', 'status', 'approved_at', 'created_at', 'updated_at'];

async function getProfile(vendorId) {
  const v = await knex('vendors').where({ id: vendorId }).first(PROFILE_COLS);
  if (!v) throw E.notFound('Vendor');
  v.specialties = (await specialtiesOf('vendor_specialties', 'vendor_id', [v.id]))[v.id] || [];
  v.logo_url = logoUrl(v);
  return v;
}

async function updateProfile(ctx, input) {
  const d = validate(z.object({
    ...profileSchema,
    email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(190),
    about: optionalString(3000),
    about_en: optionalString(3000),
  }), input);
  const before = await knex('vendors').where({ id: ctx.vendorId }).first(PROFILE_COLS);
  const values = { ...vendorFields(d), email: d.email, about: d.about || null, about_en: d.about_en || null };
  await knex.transaction(async (trx) => {
    await trx('vendors').where({ id: ctx.vendorId }).update({ ...values, updated_at: now() });
    await replaceSpecialties(trx, 'vendor_specialties', 'vendor_id', ctx.vendorId, d.specialties);
  });
  const { oldValues, newValues } = audit.diff(before, values);
  await audit.record({ ...ctx, businessId: null }, 'vendor.profile_updated', { entityType: 'vendor', entityId: ctx.vendorId, oldValues, newValues: { ...newValues, specialties: d.specialties.join(',') } });
}

async function setLogo(ctx, image) {
  await knex('vendors').where({ id: ctx.vendorId }).update(image ? { logo: image.data, logo_mime: image.mime, updated_at: now() } : { logo: null, logo_mime: null, updated_at: now() });
  await audit.record({ ...ctx, businessId: null }, image ? 'vendor.logo_updated' : 'vendor.logo_removed', { entityType: 'vendor', entityId: ctx.vendorId, newValues: image ? { mime: image.mime, size: image.data.length } : {} });
}

// ---------------------------------------------------------------- vendor portal: products
const PRODUCT_COLS = ['id', 'vendor_id', 'name', 'name_en', 'brand', 'sku', 'unit', 'pack_size', 'price', 'currency', 'description', 'description_en',
  'image_mime', 'is_active', 'created_at', 'updated_at'];
const PER_PAGE = 20;
const pageMeta = (total, p, per = PER_PAGE) => { const pages = Math.max(1, Math.ceil(total / per)); const page = Math.min(Math.max(1, Number(p) || 1), pages); return { total, page, pages, perPage: per }; };

async function listProducts(ctx, { q = '', status = '', page = 1 } = {}) {
  const base = knex('vendor_products as p').where('p.vendor_id', ctx.vendorId).modify((qb) => {
    if (q) qb.andWhere((w) => w.where('p.name', 'like', like(q)).orWhere('p.name_en', 'like', like(q)).orWhere('p.brand', 'like', like(q)).orWhere('p.sku', 'like', like(q)));
    if (status === 'active') qb.where('p.is_active', true);
    if (status === 'inactive') qb.where('p.is_active', false);
  });
  const [{ n }] = await base.clone().count({ n: '*' });
  const meta = pageMeta(Number(n), page);
  const rows = await base.clone().orderBy('p.id', 'desc').limit(meta.perPage).offset((meta.page - 1) * meta.perPage)
    .select(...PRODUCT_COLS.map((c) => `p.${c}`), knex('supply_items').count('*').where('vendor_product_id', knex.ref('p.id')).as('used_by'));
  const sp = await specialtiesOf('vendor_product_specialties', 'product_id', rows.map((r) => r.id));
  for (const r of rows) { r.specialties = sp[r.id] || []; r.image_url = productImageUrl(r); r.used_by = Number(r.used_by); }
  return { rows, meta };
}

async function ownProduct(ctx, id) {
  const p = await knex('vendor_products').where({ id, vendor_id: ctx.vendorId }).first(PRODUCT_COLS);
  if (!p) throw E.notFound('Product');
  p.specialties = (await specialtiesOf('vendor_product_specialties', 'product_id', [p.id]))[p.id] || [];
  p.image_url = productImageUrl(p);
  const [{ n }] = await knex('supply_items').where({ vendor_product_id: p.id }).count({ n: '*' });
  p.used_by = Number(n);
  return p;
}

const productSchema = z.object({
  name: z.string().trim().min(2, 'Enter the product name.').max(190),
  name_en: optionalString(190),
  brand: optionalString(120),
  sku: optionalString(80),
  unit: optionalString(40),
  pack_size: optionalString(80),
  price: z.preprocess((v) => (emptyToUndefined(v) === undefined ? undefined : Number(String(v).replace(/,/g, ''))),
    z.number({ invalid_type_error: 'Enter a number.' }).finite('Enter a number.').min(0, 'Must be zero or more.').max(1e9, 'Too large.').optional()),
  currency: z.preprocess(emptyToUndefined, z.enum(CURRENCIES, { errorMap: () => ({ message: 'Choose a currency.' }) }).optional()),
  description: optionalString(4000),
  description_en: optionalString(4000),
  specialties: specialtiesField(),
  is_active: z.any().optional(),
  remove_image: z.any().optional(),
});

/** Create (id null) or update a product. `image` = { data, mime } from checkImage, or null. Returns the id. */
async function saveProduct(ctx, id, input, image = null) {
  const d = validate(productSchema, input);
  if (d.price !== undefined && !d.currency) throw E.validation({ currency: 'Choose a currency.' });
  const values = {
    name: d.name, name_en: d.name_en || null, brand: d.brand || null, sku: d.sku || null, unit: d.unit || null, pack_size: d.pack_size || null,
    price: d.price === undefined ? null : d.price, currency: d.price === undefined ? (d.currency || null) : d.currency,
    description: d.description || null, description_en: d.description_en || null,
    is_active: ['1', 'on', 'true', true].includes(d.is_active),
  };
  const imgValues = image ? { image: image.data, image_mime: image.mime } : (['1', 'on'].includes(d.remove_image) ? { image: null, image_mime: null } : {});
  let before = null;
  if (id) before = await ownProduct(ctx, id);
  const pid = await knex.transaction(async (trx) => {
    let rowId = id;
    if (id) await trx('vendor_products').where({ id, vendor_id: ctx.vendorId }).update({ ...values, ...imgValues, updated_at: now() });
    else [rowId] = await trx('vendor_products').insert({ ...values, ...imgValues, vendor_id: ctx.vendorId });
    await replaceSpecialties(trx, 'vendor_product_specialties', 'product_id', rowId, d.specialties);
    return rowId;
  });
  const { oldValues, newValues } = audit.diff(before || {}, values);
  await audit.record({ ...ctx, businessId: null }, id ? 'vendor.product_updated' : 'vendor.product_created', { entityType: 'vendor_product', entityId: pid, oldValues: id ? oldValues : undefined, newValues: { ...newValues, specialties: d.specialties.join(','), image: imgValues.image_mime !== undefined ? (imgValues.image_mime || 'removed') : undefined } });
  return pid;
}

async function setProductActive(ctx, id, active) {
  const p = await ownProduct(ctx, id);
  await knex('vendor_products').where({ id: p.id }).update({ is_active: Boolean(active), updated_at: now() });
  await audit.record({ ...ctx, businessId: null }, active ? 'vendor.product_activated' : 'vendor.product_deactivated', { entityType: 'vendor_product', entityId: p.id, newValues: { name: p.name } });
}

/** Deletes a product. Clinics' supply items that came from it keep their own data (vendor_product_id → NULL). */
async function deleteProduct(ctx, id) {
  const p = await ownProduct(ctx, id);
  await knex('vendor_products').where({ id: p.id }).del();
  await audit.record({ ...ctx, businessId: null }, 'vendor.product_deleted', { entityType: 'vendor_product', entityId: p.id, oldValues: { name: p.name, used_by: p.used_by } });
  return p;
}

const productChoices = (ctx) => knex('vendor_products').where({ vendor_id: ctx.vendorId }).orderBy('name').select('id', 'name', 'name_en', 'is_active');

// ---------------------------------------------------------------- vendor portal: offers
const OFFER_COLS = ['id', 'vendor_id', 'target', 'title', 'title_en', 'body', 'body_en', 'image_mime', 'starts_on', 'ends_on', 'status', 'published_at', 'created_at', 'updated_at'];

async function listOffers(ctx, { status = '' } = {}) {
  const rows = await knex('vendor_offers as o').where('o.vendor_id', ctx.vendorId).modify((qb) => { if (OFFER_STATUSES.includes(status)) qb.where('o.status', status); })
    .orderByRaw("FIELD(o.status, 'published', 'draft', 'archived')").orderBy('o.id', 'desc')
    .select(...OFFER_COLS.map((c) => `o.${c}`), knex('vendor_offer_views').count('*').where('offer_id', knex.ref('o.id')).as('views'),
      knex('vendor_offer_products').count('*').where('offer_id', knex.ref('o.id')).as('products'));
  const sp = await specialtiesOf('vendor_offer_specialties', 'offer_id', rows.map((r) => r.id));
  for (const r of rows) { r.specialties = sp[r.id] || []; r.image_url = offerImageUrl(r); r.views = Number(r.views); r.products = Number(r.products); }
  const counts = await knex('vendor_offers').where({ vendor_id: ctx.vendorId }).groupBy('status').select('status').count({ n: '*' });
  return { rows, counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) };
}

async function ownOffer(ctx, id) {
  const o = await knex('vendor_offers').where({ id, vendor_id: ctx.vendorId }).first(OFFER_COLS);
  if (!o) throw E.notFound('Offer');
  o.specialties = (await specialtiesOf('vendor_offer_specialties', 'offer_id', [o.id]))[o.id] || [];
  o.product_ids = (await knex('vendor_offer_products').where({ offer_id: o.id }).pluck('product_id')).map(Number);
  o.image_url = offerImageUrl(o);
  o.cities = await knex('vendor_offer_cities').where({ offer_id: o.id }).orderBy('city').pluck('city');
  o.clinics = await knex('vendor_offer_targets as t').join('businesses as b', 'b.id', 't.business_id').where('t.offer_id', o.id).select('b.id', 'b.name', 'b.name_en', 'b.city').orderBy('b.name');
  o.clinic_ids = o.clinics.map((c) => c.id);
  const [{ n }] = await knex('vendor_offer_views').where({ offer_id: o.id }).count({ n: '*' });
  o.views = Number(n);
  return o;
}

const offerSchema = z.object({
  title: z.string().trim().min(2, 'Enter the offer title.').max(190),
  title_en: optionalString(190),
  body: optionalString(4000),
  body_en: optionalString(4000),
  starts_on: optionalDate(),
  ends_on: optionalDate(),
  specialties: z.preprocess((v) => (v === undefined || v === null || v === '' ? [] : [].concat(v)), z.array(z.enum(TARGET_SPECIALTIES, { errorMap: () => ({ message: 'Choose a valid value.' }) }))),
  product_ids: z.preprocess((v) => (v === undefined || v === null || v === '' ? [] : [].concat(v)), z.array(z.coerce.number().int().positive()).max(100)),
  target: z.preprocess((v) => (v === 'clinics' ? 'clinics' : 'specialty'), z.enum(['specialty', 'clinics'])),
  clinic_ids: z.preprocess((v) => (v === undefined || v === null || v === '' ? [] : [].concat(v)), z.array(z.coerce.number().int().positive()).max(1000)),
  remove_image: z.any().optional(),
});

/** Clinics a vendor can send an offer to (the same clinics open to reps), for the offer form's picker. */
async function offerClinicChoices() {
  const { openToReps } = require('../marketplace/rep-visits.service'); // eslint-disable-line global-require
  return openToReps(knex('businesses as b')).select('b.id', 'b.name', 'b.name_en', 'b.city', 'b.specialty').orderBy('b.city').orderBy('b.name').limit(1000);
}
async function checkTargets(ctx, target, specialties, clinicIds) {
  if (target === 'specialty') {
    if (!specialties.length) throw E.validation({ specialties: 'Choose at least one specialty.' });
    return [];
  }
  const want = [...new Set(clinicIds)];
  if (!want.length) throw E.validation({ clinic_ids: 'Choose at least one clinic.' });
  const max = await billing.maxOfferClinics(ctx.vendorId);
  if (max !== null && want.length > max) throw new AppError('VENDOR_LIMIT_CLINICS', `Your plan allows up to ${max} clinics per offer.`, 422, { clinic_ids: `Your plan allows up to ${max} clinics per offer.` });
  const ok = new Set((await offerClinicChoices()).map((c) => c.id));
  if (want.some((id) => !ok.has(id))) throw E.validation({ clinic_ids: 'Choose a valid value.' });
  return want;
}
/** Tell the clinics an offer was sent to (target 'clinics') once, when it is published. */
async function tellTargets(offerId, title, vendorName) {
  const ids = await knex('vendor_offer_targets').where({ offer_id: offerId }).pluck('business_id');
  for (const bid of ids) {
    await notifications.notify(bid, { permission: 'vendors.view', type: 'vendor_offer.sent', title: `عرض جديد لعيادتك · New offer for your clinic — ${vendorName}`, body: title, link: `/app/marketplace/offers/${offerId}`, dedupeKey: `voffer:${offerId}:${bid}` }).catch(() => {});
  }
}

/**
 * Create (id null) or update an offer; `publish` asks to publish it right away. Only approved (active) vendors
 * can publish — a pending vendor's offer is saved as a draft. Returns { id, status, publishBlocked }.
 */
async function saveOffer(ctx, id, input, image = null, { publish = false, vendorStatus = 'pending', today } = {}) {
  const d = validate(offerSchema, input);
  if (d.starts_on && d.ends_on && d.ends_on < d.starts_on) throw E.validation({ ends_on: 'The end date must be on or after the start date.' });
  const own = d.product_ids.length ? (await knex('vendor_products').where({ vendor_id: ctx.vendorId }).whereIn('id', d.product_ids).pluck('id')).map(Number) : [];
  if (own.length !== new Set(d.product_ids).size) throw E.validation({ product_ids: 'Choose a valid value.' });
  const before = id ? await ownOffer(ctx, id) : null;
  const clinicIds = await checkTargets(ctx, d.target, d.specialties, d.clinic_ids);
  const cities = d.target === 'specialty' ? billing.lowerList(input.cities).slice(0, 30) : [];
  let status = before ? before.status : 'draft';
  let publishBlocked = false;
  if (publish) {
    if (vendorStatus !== 'active') publishBlocked = true;
    else {
      if (d.ends_on && today && d.ends_on < today) throw E.validation({ ends_on: 'The end date has already passed.' });
      if (!before || before.status !== 'published') await billing.assertCan(ctx.vendorId, 'offer');
      status = 'published';
    }
  }
  const values = {
    title: d.title, title_en: d.title_en || null, body: d.body || null, body_en: d.body_en || null,
    starts_on: d.starts_on || null, ends_on: d.ends_on || null, status, target: d.target,
  };
  if (status === 'published' && (!before || before.status !== 'published')) values.published_at = now();
  const imgValues = image ? { image: image.data, image_mime: image.mime } : (['1', 'on'].includes(d.remove_image) ? { image: null, image_mime: null } : {});
  const oid = await knex.transaction(async (trx) => {
    let rowId = id;
    if (id) await trx('vendor_offers').where({ id, vendor_id: ctx.vendorId }).update({ ...values, ...imgValues, updated_at: now() });
    else [rowId] = await trx('vendor_offers').insert({ ...values, ...imgValues, vendor_id: ctx.vendorId });
    await replaceSpecialties(trx, 'vendor_offer_specialties', 'offer_id', rowId, d.specialties);
    await trx('vendor_offer_products').where({ offer_id: rowId }).del();
    if (own.length) await trx('vendor_offer_products').insert(own.map((pid) => ({ offer_id: rowId, product_id: pid })));
    await trx('vendor_offer_targets').where({ offer_id: rowId }).del();
    if (clinicIds.length) await trx('vendor_offer_targets').insert(clinicIds.map((bid) => ({ offer_id: rowId, business_id: bid })));
    await trx('vendor_offer_cities').where({ offer_id: rowId }).del();
    if (cities.length) await trx('vendor_offer_cities').insert(cities.map((c) => ({ offer_id: rowId, city: c.slice(0, 100) })));
    return rowId;
  });
  if (values.published_at && d.target === 'clinics') await tellTargets(oid, d.title, await vendorName(ctx.vendorId));
  const { oldValues, newValues } = audit.diff(before || {}, values);
  await audit.record({ ...ctx, businessId: null }, id ? 'vendor.offer_updated' : 'vendor.offer_created', { entityType: 'vendor_offer', entityId: oid, oldValues: id ? oldValues : undefined, newValues: { ...newValues, specialties: d.specialties.join(','), clinics: clinicIds.join(','), cities: cities.join(',') } });
  return { id: oid, status, publishBlocked };
}

/** publish | archive | draft. Publishing needs an approved vendor and an end date that has not passed. */
async function setOfferStatus(ctx, id, next, { vendorStatus = 'pending', today } = {}) {
  const o = await ownOffer(ctx, id);
  if (!OFFER_STATUSES.includes(next)) throw E.validation({ status: 'Choose a valid value.' });
  if (next === 'published') {
    if (vendorStatus !== 'active') throw new AppError('VENDOR_NOT_APPROVED', 'Your account is awaiting approval. You can publish offers once it is approved.', 409);
    if (o.target !== 'clinics' && !o.specialties.length) throw new AppError('OFFER_NO_SPECIALTY', 'Choose at least one specialty for this offer first.', 409);
    if (o.target === 'clinics' && !o.clinic_ids.length) throw new AppError('OFFER_NO_CLINICS', 'Choose at least one clinic for this offer first.', 409);
    if (o.ends_on && today && o.ends_on < today) throw new AppError('OFFER_ENDED', 'This offer has already ended. Change its end date first.', 409);
  }
  if (next === o.status) return o;
  if (next === 'published') {
    await billing.assertCan(ctx.vendorId, 'offer');
    const max = o.target === 'clinics' ? await billing.maxOfferClinics(ctx.vendorId) : null;
    if (max !== null && o.clinic_ids.length > max) throw new AppError('VENDOR_LIMIT_CLINICS', `Your plan allows up to ${max} clinics per offer.`, 409);
  }
  const values = { status: next, updated_at: now() };
  if (next === 'published') values.published_at = now();
  await knex('vendor_offers').where({ id: o.id }).update(values);
  await audit.record({ ...ctx, businessId: null }, `vendor.offer_${next}`, { entityType: 'vendor_offer', entityId: o.id, oldValues: { status: o.status }, newValues: { status: next, title: o.title } });
  if (next === 'published' && o.target === 'clinics') await tellTargets(o.id, o.title, await vendorName(ctx.vendorId));
  return o;
}

const vendorName = async (vendorId) => ((await knex('vendors').where({ id: vendorId }).first('name')) || {}).name || '';

async function duplicateOffer(ctx, id) {
  const o = await ownOffer(ctx, id);
  const full = await knex('vendor_offers').where({ id: o.id }).first('image', 'image_mime');
  const newId = await knex.transaction(async (trx) => {
    const [nid] = await trx('vendor_offers').insert({
      vendor_id: ctx.vendorId, title: o.title.slice(0, 180), title_en: o.title_en, body: o.body, body_en: o.body_en,
      image: full.image, image_mime: full.image_mime, starts_on: null, ends_on: null, status: 'draft', target: o.target || 'specialty',
    });
    if (o.clinic_ids.length) await trx('vendor_offer_targets').insert(o.clinic_ids.map((bid) => ({ offer_id: nid, business_id: bid })));
    if (o.cities.length) await trx('vendor_offer_cities').insert(o.cities.map((c) => ({ offer_id: nid, city: c })));
    await replaceSpecialties(trx, 'vendor_offer_specialties', 'offer_id', nid, o.specialties);
    if (o.product_ids.length) await trx('vendor_offer_products').insert(o.product_ids.map((pid) => ({ offer_id: nid, product_id: pid })));
    return nid;
  });
  await audit.record({ ...ctx, businessId: null }, 'vendor.offer_duplicated', { entityType: 'vendor_offer', entityId: newId, newValues: { from: o.id, title: o.title } });
  return newId;
}

async function deleteOffer(ctx, id) {
  const o = await ownOffer(ctx, id);
  await knex('vendor_offers').where({ id: o.id }).del();
  await audit.record({ ...ctx, businessId: null }, 'vendor.offer_deleted', { entityType: 'vendor_offer', entityId: o.id, oldValues: { title: o.title, status: o.status, views: o.views } });
}

// ---------------------------------------------------------------- vendor portal: dashboard
const n0 = async (q) => Number((await q.count({ n: '*' }))[0].n);

async function dashboard(ctx, today) {
  const v = ctx.vendorId;
  const [products, offers, views, visits, orders, drafts, nextVisits, topOffers] = await Promise.all([
    n0(knex('vendor_products').where({ vendor_id: v, is_active: true })),
    n0(knex('vendor_offers').where({ vendor_id: v, status: 'published' }).andWhere((w) => w.whereNull('ends_on').orWhere('ends_on', '>=', today))),
    n0(knex('vendor_offer_views as w').join('vendor_offers as o', 'o.id', 'w.offer_id').where('o.vendor_id', v)),
    n0(knex('rep_visits').where({ vendor_id: v }).whereIn('status', ['requested', 'confirmed']).where('visit_date', '>=', today)),
    n0(knex('purchase_orders').where({ vendor_id: v }).whereIn('status', ['sent', 'acknowledged'])),
    n0(knex('vendor_offers').where({ vendor_id: v, status: 'draft' })),
    // Only doctor name, clinic name/city and date/time — never anything about patients.
    knex('rep_visits as r').join('businesses as b', 'b.id', 'r.business_id').leftJoin('doctors as d', function j() { this.on('d.id', 'r.doctor_id').andOn('d.business_id', 'r.business_id'); })
      .where('r.vendor_id', v).whereIn('r.status', ['requested', 'confirmed']).where('r.visit_date', '>=', today)
      .orderBy('r.visit_date').orderBy('r.visit_time').limit(5)
      .select('r.id', 'r.visit_date', 'r.visit_time', 'r.status', 'r.business_id', 'r.doctor_id', 'b.name as clinic_name', 'b.name_en as clinic_name_en', 'b.city as clinic_city', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en')
      .then((rows) => require('../../db/cross').fillDoctors(rows)), // eslint-disable-line global-require -- names from each clinic's own database
    knex('vendor_offers as o').where({ 'o.vendor_id': v, 'o.status': 'published' }).orderBy('o.published_at', 'desc').limit(5)
      .select('o.id', 'o.title', 'o.title_en', 'o.ends_on', knex('vendor_offer_views').count('*').where('offer_id', knex.ref('o.id')).as('views')),
  ]);
  const [{ n: productsAll }] = await knex('vendor_products').where({ vendor_id: v }).count({ n: '*' });
  return {
    counts: { products, offers, views, visits, orders, drafts, productsAll: Number(productsAll) },
    nextVisits, topOffers: topOffers.map((o) => ({ ...o, views: Number(o.views) })),
  };
}

// ---------------------------------------------------------------- clinic-side read helpers
const VENDOR_PUBLIC_COLS = ['id', 'type', 'name', 'name_en', 'contact_name', 'email', 'phone', 'whatsapp', 'country', 'city', 'about', 'about_en', 'logo_mime', 'updated_at'];
const vendorBrief = (r, p = 'v_') => ({
  id: r[`${p}id`], type: r[`${p}type`], name: r[`${p}name`], name_en: r[`${p}name_en`], city: r[`${p}city`],
  has_logo: Boolean(r[`${p}logo_mime`]), logo_url: mediaUrl('logo', r[`${p}id`], r[`${p}logo_mime`], r[`${p}updated_at`]),
});
const vendorJoinCols = ['v.id as v_id', 'v.type as v_type', 'v.name as v_name', 'v.name_en as v_name_en', 'v.city as v_city', 'v.logo_mime as v_logo_mime', 'v.updated_at as v_updated_at'];

function publicProductRow(r, sp) {
  return {
    id: r.id, vendor_id: r.vendor_id, name: r.name, name_en: r.name_en, brand: r.brand, sku: r.sku, unit: r.unit, pack_size: r.pack_size,
    price: r.price === null ? null : Number(r.price), currency: r.currency, description: r.description, description_en: r.description_en,
    has_image: Boolean(r.image_mime), image_url: productImageUrl(r), specialties: sp[r.id] || [], vendor: vendorBrief(r),
  };
}

function productBase({ specialty, q, vendorId } = {}) {
  return knex('vendor_products as p').join('vendors as v', 'v.id', 'p.vendor_id')
    .where('v.status', 'active').where('p.is_active', true)
    .modify((qb) => {
      if (specialty) qb.whereExists(knex('vendor_product_specialties as s').whereRaw('s.product_id = p.id').where('s.specialty', specialty));
      if (vendorId) qb.where('p.vendor_id', vendorId);
      if (q && String(q).trim()) {
        qb.andWhere((w) => w.where('p.name', 'like', like(q)).orWhere('p.name_en', 'like', like(q)).orWhere('p.brand', 'like', like(q))
          .orWhere('p.sku', 'like', like(q)).orWhere('v.name', 'like', like(q)).orWhere('v.name_en', 'like', like(q)));
      }
    });
}

async function productsForSpecialty({ specialty = null, q = '', vendorId = null, limit = 24, offset = 0 } = {}) {
  const base = productBase({ specialty, q, vendorId });
  const [{ n }] = await base.clone().count({ n: '*' });
  const rows = await base.clone().orderBy('p.updated_at', 'desc').orderBy('p.id', 'desc')
    .limit(Math.min(Math.max(1, Number(limit) || 24), 200)).offset(Math.max(0, Number(offset) || 0))
    .select(...PRODUCT_COLS.map((c) => `p.${c}`), ...vendorJoinCols);
  const sp = await specialtiesOf('vendor_product_specialties', 'product_id', rows.map((r) => r.id));
  return { rows: rows.map((r) => publicProductRow(r, sp)), total: Number(n) };
}

async function product(id) {
  const r = await productBase().where('p.id', Number(id) || 0).first(...PRODUCT_COLS.map((c) => `p.${c}`), ...vendorJoinCols);
  if (!r) return null;
  return publicProductRow(r, await specialtiesOf('vendor_product_specialties', 'product_id', [r.id]));
}

async function vendorPublic(id) {
  const v = await knex('vendors').where({ id: Number(id) || 0, status: 'active' }).first(VENDOR_PUBLIC_COLS);
  if (!v) return null;
  const { logo_mime: lm, updated_at: ua, ...rest } = v;
  return { ...rest, has_logo: Boolean(lm), logo_url: logoUrl(v), specialties: (await specialtiesOf('vendor_specialties', 'vendor_id', [v.id]))[v.id] || [] };
}

function offerBase(specialty, today) {
  return knex('vendor_offers as o').join('vendors as v', 'v.id', 'o.vendor_id')
    .where('o.status', 'published').where('v.status', 'active')
    .modify((qb) => {
      if (today) qb.andWhere((w) => w.whereNull('o.starts_on').orWhere('o.starts_on', '<=', today)).andWhere((w) => w.whereNull('o.ends_on').orWhere('o.ends_on', '>=', today));
      if (specialty) qb.whereExists(knex('vendor_offer_specialties as s').whereRaw('s.offer_id = o.id').where('s.specialty', specialty));
    });
}

async function decorateOffers(rows) {
  const ids = rows.map((r) => r.id);
  const sp = await specialtiesOf('vendor_offer_specialties', 'offer_id', ids);
  const prods = ids.length ? await knex('vendor_offer_products as op').join('vendor_products as p', 'p.id', 'op.product_id')
    .whereIn('op.offer_id', ids).where('p.is_active', true).select('op.offer_id', 'p.id', 'p.name', 'p.name_en') : [];
  return rows.map((r) => {
    const out = {
      id: r.id, vendor_id: r.vendor_id, title: r.title, title_en: r.title_en, body: r.body, body_en: r.body_en,
      has_image: Boolean(r.image_mime), image_url: offerImageUrl(r), starts_on: r.starts_on, ends_on: r.ends_on, published_at: r.published_at,
      specialties: sp[r.id] || [], products: prods.filter((p) => p.offer_id === r.id).map((p) => ({ id: p.id, name: p.name, name_en: p.name_en })),
      vendor: vendorBrief(r),
    };
    if ('seen_at' in r) { out.seen_at = r.seen_at; out.dismissed_at = r.dismissed_at; }
    return out;
  });
}

async function offersForSpecialty(specialty, { today, businessId = null, includeDismissed = false, limit = 20 } = {}) {
  const q = offerBase(specialty, today).orderBy('o.published_at', 'desc').orderBy('o.id', 'desc').limit(Math.min(Math.max(1, Number(limit) || 20), 100))
    .select(...OFFER_COLS.map((c) => `o.${c}`), ...vendorJoinCols);
  if (businessId) {
    q.leftJoin('vendor_offer_views as w', (j) => j.on('w.offer_id', 'o.id').andOn('w.business_id', knex.raw('?', [businessId])))
      .select('w.seen_at', 'w.dismissed_at');
    if (!includeDismissed) q.whereNull('w.dismissed_at');
  }
  return decorateOffers(await q);
}

async function countNewOffers(specialty, businessId, today) {
  return n0(offerBase(specialty, today).whereNotExists(knex('vendor_offer_views as w').whereRaw('w.offer_id = o.id').where('w.business_id', businessId)));
}

async function offer(id, { today } = {}) {
  const r = await offerBase(null, today).where('o.id', Number(id) || 0).first(...OFFER_COLS.map((c) => `o.${c}`), ...vendorJoinCols);
  return r ? (await decorateOffers([r]))[0] : null;
}

async function recordOfferView(offerId, businessId) {
  await knex.raw('INSERT IGNORE INTO vendor_offer_views (offer_id, business_id, seen_at) VALUES (?, ?, ?)', [Number(offerId), Number(businessId), now()]);
}

async function dismissOffer(offerId, businessId) {
  await recordOfferView(offerId, businessId);
  await knex('vendor_offer_views').where({ offer_id: Number(offerId), business_id: Number(businessId) }).update({ dismissed_at: now() });
}

// ---------------------------------------------------------------- media (logo / product / offer images)
/**
 * The bytes of an image, if `viewer` may see it: public when the vendor is approved and the item is visible to
 * clinics (active product / published offer); otherwise only the vendor's own users and platform admins.
 * viewer = { userId, isPlatformAdmin }.
 */
async function mediaFile(kind, id, viewer = {}) {
  let row;
  if (kind === 'logo') {
    row = await knex('vendors as v').where('v.id', id).first('v.id as vendor_id', 'v.status as vendor_status', 'v.logo as data', 'v.logo_mime as mime', 'v.updated_at');
    if (row) row.visible = row.vendor_status === 'active';
  } else if (kind === 'product') {
    row = await knex('vendor_products as p').join('vendors as v', 'v.id', 'p.vendor_id').where('p.id', id)
      .first('p.vendor_id', 'v.status as vendor_status', 'p.is_active', 'p.image as data', 'p.image_mime as mime', 'p.updated_at');
    if (row) row.visible = row.vendor_status === 'active' && Boolean(row.is_active);
  } else if (kind === 'offer') {
    row = await knex('vendor_offers as o').join('vendors as v', 'v.id', 'o.vendor_id').where('o.id', id)
      .first('o.vendor_id', 'v.status as vendor_status', 'o.status', 'o.image as data', 'o.image_mime as mime', 'o.updated_at');
    if (row) row.visible = row.vendor_status === 'active' && row.status === 'published';
  }
  if (!row || !row.data || !EXT[row.mime]) return null;
  let allowed = row.visible;
  if (!allowed && viewer.isPlatformAdmin) allowed = true;
  if (!allowed && viewer.userId) allowed = Boolean(await knex('vendor_users').where({ vendor_id: row.vendor_id, user_id: viewer.userId }).first('id'));
  if (!allowed) return null;
  return { mime: row.mime, data: row.data, version: version(row.updated_at), isPublic: row.visible };
}

// ---------------------------------------------------------------- platform moderation (/admin/vendors)
async function adminList({ q = '', status = '', page = 1, perPage = 25 } = {}) {
  const base = knex('vendors as v').modify((qb) => {
    if (q) qb.andWhere((w) => w.where('v.name', 'like', like(q)).orWhere('v.name_en', 'like', like(q)).orWhere('v.email', 'like', like(q)).orWhere('v.phone', 'like', like(q)).orWhere('v.contact_name', 'like', like(q)));
    if (STATUSES.includes(status)) qb.where('v.status', status);
  });
  const [{ n }] = await base.clone().count({ n: '*' });
  const meta = pageMeta(Number(n), page, perPage);
  const rows = await base.clone().orderByRaw("FIELD(v.status, 'pending', 'active', 'suspended')").orderBy('v.created_at', 'desc')
    .limit(meta.perPage).offset((meta.page - 1) * meta.perPage)
    .select('v.id', 'v.type', 'v.name', 'v.name_en', 'v.contact_name', 'v.email', 'v.phone', 'v.city', 'v.status', 'v.created_at', 'v.logo_mime', 'v.updated_at',
      knex('vendor_products').count('*').where('vendor_id', knex.ref('v.id')).as('products'),
      knex('vendor_offers').count('*').where('vendor_id', knex.ref('v.id')).where('status', 'published').as('offers'));
  const sp = await specialtiesOf('vendor_specialties', 'vendor_id', rows.map((r) => r.id));
  for (const r of rows) { r.specialties = sp[r.id] || []; r.products = Number(r.products); r.offers = Number(r.offers); r.logo_url = logoUrl(r); }
  const counts = await knex('vendors').groupBy('status').select('status').count({ n: '*' });
  return { rows, meta, counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) };
}

async function adminDetail(id) {
  const v = await knex('vendors as v').leftJoin('users as a', 'a.id', 'v.approved_by').where('v.id', id)
    .first(...PROFILE_COLS.map((c) => `v.${c}`), 'a.name as approved_by_name');
  if (!v) throw E.notFound('Vendor');
  v.specialties = (await specialtiesOf('vendor_specialties', 'vendor_id', [v.id]))[v.id] || [];
  v.logo_url = logoUrl(v);
  const [users, products, offers, visits, orders] = await Promise.all([
    knex('vendor_users as vu').join('users as u', 'u.id', 'vu.user_id').where('vu.vendor_id', v.id)
      .select('u.id', 'u.name', 'u.email', 'u.status', 'u.last_login_at', 'u.email_verified_at', 'vu.role'),
    knex('vendor_products').where({ vendor_id: v.id }).orderBy('id', 'desc').limit(200).select(PRODUCT_COLS),
    knex('vendor_offers as o').where({ vendor_id: v.id }).orderBy('id', 'desc').limit(100)
      .select(...OFFER_COLS.map((c) => `o.${c}`), knex('vendor_offer_views').count('*').where('offer_id', knex.ref('o.id')).as('views')),
    n0(knex('rep_visits').where({ vendor_id: v.id })),
    n0(knex('purchase_orders').where({ vendor_id: v.id })),
  ]);
  const psp = await specialtiesOf('vendor_product_specialties', 'product_id', products.map((p) => p.id));
  const osp = await specialtiesOf('vendor_offer_specialties', 'offer_id', offers.map((o) => o.id));
  products.forEach((p) => { p.specialties = psp[p.id] || []; p.image_url = productImageUrl(p); });
  offers.forEach((o) => { o.specialties = osp[o.id] || []; o.image_url = offerImageUrl(o); o.views = Number(o.views); });
  return { v, users, products, offers, counts: { visits, orders } };
}

/** Platform admin: approve (active), suspend or reactivate. ctx is the platform scope (businessId null). */
async function setStatus(ctx, id, next) {
  if (!STATUSES.includes(next) || next === 'pending') throw E.validation({ status: 'Choose a valid value.' });
  const v = await knex('vendors').where({ id }).first('id', 'status', 'name', 'email', 'approved_at');
  if (!v) throw E.notFound('Vendor');
  if (v.status === next) return { vendor: v, changed: false, firstApproval: false };
  const values = { status: next, updated_at: now() };
  const firstApproval = next === 'active' && !v.approved_at;
  if (next === 'active' && !v.approved_at) { values.approved_at = now(); values.approved_by = ctx.userId || null; }
  await knex('vendors').where({ id: v.id }).update(values);
  const action = next === 'suspended' ? 'platform.vendor_suspended' : (v.status === 'pending' ? 'platform.vendor_approved' : 'platform.vendor_reactivated');
  await audit.record({ ...ctx, businessId: null }, action, { entityType: 'vendor', entityId: v.id, oldValues: { status: v.status }, newValues: { status: next, name: v.name } });
  await pnotify.vendor(v.id, next === 'suspended' ? 'account_suspended' : 'account_approved', {}, { link: '/vendor', severity: next === 'suspended' ? 'warning' : 'success' });
  return { vendor: v, changed: true, firstApproval, action };
}

async function hideProduct(ctx, id) {
  const p = await knex('vendor_products').where({ id }).first('id', 'vendor_id', 'name', 'is_active');
  if (!p) throw E.notFound('Product');
  if (p.is_active) {
    await knex('vendor_products').where({ id: p.id }).update({ is_active: false, updated_at: now() });
    await audit.record({ ...ctx, businessId: null }, 'platform.vendor_product_hidden', { entityType: 'vendor_product', entityId: p.id, oldValues: { is_active: 1 }, newValues: { is_active: 0, name: p.name, vendor_id: p.vendor_id } });
  }
  return p;
}

async function hideOffer(ctx, id) {
  const o = await knex('vendor_offers').where({ id }).first('id', 'vendor_id', 'title', 'status');
  if (!o) throw E.notFound('Offer');
  if (o.status !== 'archived') {
    await knex('vendor_offers').where({ id: o.id }).update({ status: 'archived', updated_at: now() });
    await audit.record({ ...ctx, businessId: null }, 'platform.vendor_offer_hidden', { entityType: 'vendor_offer', entityId: o.id, oldValues: { status: o.status }, newValues: { status: 'archived', title: o.title, vendor_id: o.vendor_id } });
  }
  return o;
}

module.exports = {
  TYPES, STATUSES, OFFER_STATUSES, TARGET_SPECIALTIES, OPEN_SPECIALTIES, IMAGE_MAX_BYTES,
  // images
  sniffImage, checkImage, productImageUrl, offerImageUrl, logoUrl, mediaFile, todayFor,
  // registration & portal
  signup, registerExisting, vendorOfUser, getProfile, updateProfile, setLogo,
  listProducts, ownProduct, saveProduct, setProductActive, deleteProduct, productChoices,
  listOffers, ownOffer, saveOffer, setOfferStatus, offerClinicChoices, duplicateOffer, deleteOffer, dashboard,
  // clinic-side read helpers
  scopeForClinic, productsForSpecialty, product, vendorPublic, offersForSpecialty, countNewOffers, offer, recordOfferView, dismissOffer,
  // platform moderation
  adminList, adminDetail, setStatus, hideProduct, hideOffer,
};
