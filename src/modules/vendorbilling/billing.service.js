// Reps & warehouses billing: a subscription with a free trial and monthly limits, invoices paid to the platform, and
// paid ads shown to doctors. Off by default (platform admin → Reps billing): while off, nothing is limited.
//   • Trial: every vendor gets one on first use (trialDays, trial plan's limits). When it ends (or a paid period
//     ends) the vendor can still sign in and see everything, but cannot send visit requests, publish offers or run ads.
//   • Limits per calendar month (platform time zone Asia/Amman): visit requests sent, offers published; and the number
//     of clinics one offer can be sent to. Free ad days included in the plan each month.
//   • Invoices: the vendor chooses a plan (or buys an ad) → an open invoice → reports the transfer → the platform admin
//     confirms → the period starts (or the ad runs). Payment details are the platform's (Subscriptions settings).
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { z, validate, optionalString } = require('../../core/validate');
const { clinicNow } = require('../clinic/scheduling');
const pnotify = require('../platformnotify/notify.service');

const KEY = 'vendor_billing';
const DEFAULTS = { enabled: false, trialDays: 14, trialPlanId: null, adPricePerDay: 5, adCurrency: 'JOD', adMaxDays: 60 };
const CYCLES = ['monthly', 'yearly'];
const METHODS = ['bank_transfer', 'cliq', 'cash'];
const TZ = 'Asia/Amman';
const todayOf = () => clinicNow(TZ).date;
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(n)); return d.toISOString().slice(0, 10); };
const addMonths = (s, n) => { const d = new Date(`${s}T00:00:00Z`); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return d.toISOString().slice(0, 10); };
const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const json = (v, d) => { try { const x = typeof v === 'string' ? JSON.parse(v) : v; return x === null || x === undefined ? d : x; } catch { return d; } };

// ---------------------------------------------------------------- settings
async function settings() {
  return cache.remember('vbill:settings', async () => {
    const row = await knex('platform_settings').where({ key: KEY }).first('value');
    return { ...DEFAULTS, ...json(row && row.value, {}) };
  }, 15_000);
}
const num = (min, max) => z.preprocess((v) => (v === '' || v === undefined ? undefined : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).min(min, 'Too small.').max(max, 'Too large.'));
async function saveSettings(ctx, input) {
  const d = validate(z.object({ trialDays: num(0, 365), adPricePerDay: num(0, 100000), adMaxDays: num(1, 365), adCurrency: z.string().trim().length(3).toUpperCase() }), input);
  const trialPlanId = Number(input.trialPlanId) || null;
  if (trialPlanId && !(await knex('vendor_plans').where({ id: trialPlanId }).first('id'))) throw E.validation({ trialPlanId: 'Choose a valid value.' });
  const cur = await settings();
  const value = { ...cur, ...d, trialDays: Math.round(d.trialDays), adMaxDays: Math.round(d.adMaxDays), trialPlanId, enabled: ['1', 'on', true].includes(input.enabled) };
  await knex('platform_settings').insert({ key: KEY, value: JSON.stringify(value) }).onConflict('key').merge({ value: JSON.stringify(value), updated_at: new Date() });
  cache.forgetPrefix('vbill:');
  await audit.record(ctx, 'platform.vendor_billing_settings', { entityType: 'platform_settings', entityId: KEY, oldValues: cur, newValues: value });
  return value;
}

// ---------------------------------------------------------------- plans
const plans = ({ activeOnly = false, publicOnly = false } = {}) => knex('vendor_plans').modify((q) => { if (activeOnly) q.where('is_active', true); if (publicOnly) q.where('is_public', true); }).orderBy([{ column: 'sort_order' }, { column: 'price_monthly' }]);
async function plan(id) { return id ? knex('vendor_plans').where({ id: Number(id) || 0 }).first() : null; }
const limit = () => z.preprocess((v) => (v === '' || v === undefined || v === null ? null : Number(v)), z.number().int().min(0).max(1_000_000).nullable());
const planSchema = z.object({
  name: z.string().trim().min(1, 'Required.').max(120), name_en: optionalString(120), description: optionalString(500), description_en: optionalString(500),
  price_monthly: num(0, 10_000_000), price_yearly: z.preprocess((v) => (v === '' || v === undefined ? null : Number(v)), z.number().min(0).nullable()),
  currency: z.string().trim().length(3).toUpperCase(), max_requests_month: limit(), max_offers_month: limit(), max_offer_clinics: limit(),
  ad_days_month: z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(v)), z.number().int().min(0).max(366)), sort_order: z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(v)), z.number().int().min(0).max(9999)),
});
async function savePlan(ctx, id, input) {
  const d = validate(planSchema, input);
  const row = { ...d, name_en: d.name_en || null, description: d.description || null, description_en: d.description_en || null, is_active: ['1', 'on', true].includes(input.is_active), is_public: ['1', 'on', true].includes(input.is_public) };
  let pid = id;
  if (id) await knex('vendor_plans').where({ id }).update({ ...row, updated_at: new Date() });
  else [pid] = await knex('vendor_plans').insert(row);
  await audit.record(ctx, id ? 'platform.vendor_plan_updated' : 'platform.vendor_plan_created', { entityType: 'vendor_plan', entityId: pid, newValues: { name: row.name, price: row.price_monthly } });
  return pid;
}

// ---------------------------------------------------------------- subscription state
/** The vendor's subscription row, created as a trial on first use. */
async function ensure(vendorId) {
  let sub = await knex('vendor_subscriptions').where({ vendor_id: vendorId }).first();
  if (!sub) {
    const s = await settings();
    const today = todayOf();
    await knex('vendor_subscriptions').insert({ vendor_id: vendorId, plan_id: s.trialPlanId || null, status: 'trialing', trial_ends_at: addDays(today, Math.max(0, s.trialDays - 1)) }).onConflict('vendor_id').ignore();
    sub = await knex('vendor_subscriptions').where({ vendor_id: vendorId }).first();
  }
  return sub;
}

/** Where the vendor stands today: { enabled, sub, plan, status, ok, daysLeft, usage, limits }. */
async function state(vendorId) {
  const s = await settings();
  const today = todayOf();
  const month = today.slice(0, 7);
  const from = new Date(`${month}-01T00:00:00+03:00`);
  const usageOf = async () => {
    const [[{ r }], [{ o }], adDays] = await Promise.all([
      knex('rep_visits').where({ vendor_id: vendorId }).where('created_at', '>=', from).count({ r: '*' }),
      knex('vendor_offers').where({ vendor_id: vendorId }).where('published_at', '>=', from).count({ o: '*' }),
      knex('vendor_ads').where({ vendor_id: vendorId, status: 'approved', price: 0 }).where('starts_on', '>=', `${month}-01`).sum({ d: 'days' }).first(),
    ]);
    return { requests: Number(r), offers: Number(o), freeAdDays: Number((adDays && adDays.d) || 0) };
  };
  // Off: free and unlimited; the trial only starts once the platform turns billing on.
  if (!s.enabled) return { enabled: false, sub: null, plan: null, status: 'free', ok: true, daysLeft: null, usage: await usageOf(), limits: { requests: null, offers: null, offerClinics: null, adDays: 0 }, today };
  const sub = await ensure(vendorId);
  let status = sub.status;
  if (status === 'trialing' && sub.trial_ends_at && String(sub.trial_ends_at) < today) status = 'expired';
  if (status === 'active' && sub.current_period_end && String(sub.current_period_end) < today) status = 'expired';
  if (status !== sub.status) {
    await knex('vendor_subscriptions').where({ id: sub.id }).update({ status, updated_at: new Date() });
    if (status === 'expired') await pnotify.vendor(vendorId, 'sub_expired', {}, { link: '/vendor/billing', severity: 'warning', dedupeKey: `exp:${sub.trial_ends_at || ''}:${sub.current_period_end || ''}` });
  }
  const p = await plan(sub.plan_id || s.trialPlanId);
  const end = status === 'trialing' ? sub.trial_ends_at : sub.current_period_end;
  const daysLeft = end ? Math.max(0, Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86_400_000) + 1) : null;
  const usage = await usageOf();
  if (['trialing', 'active'].includes(status) && daysLeft !== null && daysLeft <= 3) await pnotify.vendor(vendorId, status === 'trialing' ? 'trial_ending' : 'period_ending', { n: daysLeft, date: String(end) }, { link: '/vendor/billing', severity: 'warning', dedupeKey: `end:${end}` });
  const limits = p ? { requests: p.max_requests_month, offers: p.max_offers_month, offerClinics: p.max_offer_clinics, adDays: p.ad_days_month || 0 } : { requests: null, offers: null, offerClinics: null, adDays: 0 };
  return { enabled: true, sub: { ...sub, status }, plan: p || null, status, ok: ['trialing', 'active'].includes(status), daysLeft, usage, limits, today };
}

/** Throws when billing is on and the vendor may not do `kind` now ('request' | 'offer' | 'ad'). */
async function assertCan(vendorId, kind) {
  const st = await state(vendorId);
  if (!st.enabled) return st;
  if (!st.ok) throw new AppError('VENDOR_SUB_EXPIRED', 'Your subscription has ended. Choose a plan to continue.', 409);
  const hit = (what) => pnotify.vendor(vendorId, `limit_${what}`, {}, { link: '/vendor/billing', severity: 'warning', dedupeKey: `limit:${what}:${st.today.slice(0, 7)}` });
  if (kind === 'request' && st.limits.requests !== null && st.usage.requests >= st.limits.requests) { await hit('requests'); throw new AppError('VENDOR_LIMIT_REQUESTS', 'You reached this month\'s visit requests on your plan.', 409); }
  if (kind === 'offer' && st.limits.offers !== null && st.usage.offers >= st.limits.offers) { await hit('offers'); throw new AppError('VENDOR_LIMIT_OFFERS', 'You reached this month\'s offers on your plan.', 409); }
  return st;
}
/** How many clinics one offer may be sent to (null = no limit). */
async function maxOfferClinics(vendorId) { const st = await state(vendorId); return st.enabled ? st.limits.offerClinics : null; }

// ---------------------------------------------------------------- invoices
async function nextNumber(trx = knex) {
  const year = todayOf().slice(0, 4);
  const [{ n }] = await trx('vendor_invoices').where('number', 'like', `VN-${year}-%`).count({ n: '*' });
  return `VN-${year}-${String(Number(n) + 1).padStart(6, '0')}`;
}
const invoices = (vendorId) => knex('vendor_invoices').where({ vendor_id: vendorId }).orderBy('created_at', 'desc').limit(50);

/** The vendor picks a plan and cycle → an open invoice (one open plan invoice at a time). */
async function choosePlan(vctx, planId, cycle) {
  const p = await plan(planId);
  if (!p || !p.is_active || !p.is_public) throw E.validation({ plan_id: 'Choose a valid value.' });
  const c = CYCLES.includes(cycle) ? cycle : 'monthly';
  const amount = c === 'yearly' ? (p.price_yearly !== null ? Number(p.price_yearly) : Number(p.price_monthly) * 12) : Number(p.price_monthly);
  await knex('vendor_invoices').where({ vendor_id: vctx.vendorId, kind: 'plan', status: 'open' }).update({ status: 'void', updated_at: new Date() });
  const number = await nextNumber();
  const [id] = await knex('vendor_invoices').insert({ number, vendor_id: vctx.vendorId, kind: 'plan', plan_id: p.id, billing_cycle: c, description: p.name, amount: r3(amount), currency: p.currency });
  await audit.record({ ...vctx, businessId: null }, 'vendor.plan_chosen', { entityType: 'vendor_invoice', entityId: id, newValues: { plan: p.name, cycle: c, amount } });
  if (!(amount > 0)) await confirmPayment({ userId: vctx.userId }, id, { method: 'cash', reference: 'free' }); // a free plan starts at once
  return id;
}

/** The vendor says it paid (transfer / CliQ reference). */
async function reportPayment(vctx, invoiceId, input) {
  const d = validate(z.object({ method: z.enum(METHODS), reference: optionalString(120) }), input);
  const inv = await knex('vendor_invoices').where({ id: Number(invoiceId) || 0, vendor_id: vctx.vendorId }).first();
  if (!inv) throw E.notFound('Invoice');
  if (inv.status !== 'open') throw new AppError('INVOICE_CLOSED', 'This invoice is already closed.', 409);
  await knex('vendor_invoices').where({ id: inv.id }).update({ status: 'reported', method: d.method, reference: d.reference || null, reported_at: new Date(), updated_at: new Date() });
  await audit.record({ ...vctx, businessId: null }, 'vendor.payment_reported', { entityType: 'vendor_invoice', entityId: inv.id, newValues: { method: d.method, reference: d.reference } });
  const v = await knex('vendors').where({ id: vctx.vendorId }).first('name');
  await pnotify.admin('vendor_payment', { vendor: v ? v.name : '', number: inv.number, amount: `${Number(inv.amount)} ${inv.currency}` }, { link: '/admin/vendor-billing?tab=invoices&status=reported', severity: 'warning' });
}

/** Platform admin: the money arrived. A plan period starts (after the current one); an ad runs. */
async function confirmPayment(ctx, invoiceId, { method, reference } = {}) {
  const inv = await knex('vendor_invoices').where({ id: Number(invoiceId) || 0 }).first();
  if (!inv) throw E.notFound('Invoice');
  if (inv.status === 'paid' || inv.status === 'void') throw new AppError('INVOICE_CLOSED', 'This invoice is already closed.', 409);
  const today = todayOf();
  await knex.transaction(async (trx) => {
    await trx('vendor_invoices').where({ id: inv.id }).update({ status: 'paid', method: method || inv.method || 'bank_transfer', reference: reference || inv.reference || null, paid_at: new Date(), confirmed_by: ctx.userId || null, updated_at: new Date() });
    if (inv.kind === 'plan') {
      const sub = await trx('vendor_subscriptions').where({ vendor_id: inv.vendor_id }).first();
      const after = sub && sub.status === 'active' && sub.current_period_end && String(sub.current_period_end) >= today ? addDays(String(sub.current_period_end), 1) : today;
      const end = addDays(addMonths(after, inv.billing_cycle === 'yearly' ? 12 : 1), -1);
      await trx('vendor_subscriptions').where({ vendor_id: inv.vendor_id }).update({ plan_id: inv.plan_id, status: 'active', billing_cycle: inv.billing_cycle || 'monthly', current_period_start: after, current_period_end: end, updated_at: new Date() });
    } else if (inv.kind === 'ad' && inv.ad_id) {
      await trx('vendor_ads').where({ id: inv.ad_id, status: 'pending_payment' }).update({ status: 'approved', updated_at: new Date() });
    }
  });
  await pnotify.vendor(inv.vendor_id, inv.kind === 'ad' ? 'ad_paid' : 'invoice_paid', { number: inv.number, item: inv.description || '' }, { link: inv.kind === 'ad' ? '/vendor/ads' : '/vendor/billing', severity: 'success' });
  await audit.record(ctx, 'platform.vendor_payment_confirmed', { entityType: 'vendor_invoice', entityId: inv.id, newValues: { vendor: inv.vendor_id, amount: Number(inv.amount), kind: inv.kind } });
}
async function voidInvoice(ctx, invoiceId) {
  const inv = await knex('vendor_invoices').where({ id: Number(invoiceId) || 0 }).first();
  if (!inv || inv.status === 'paid') throw new AppError('INVOICE_CLOSED', 'This invoice is already closed.', 409);
  await knex('vendor_invoices').where({ id: inv.id }).update({ status: 'void', updated_at: new Date() });
  if (inv.kind === 'ad' && inv.ad_id) await knex('vendor_ads').where({ id: inv.ad_id, status: 'pending_payment' }).update({ status: 'cancelled' });
  await audit.record(ctx, 'platform.vendor_invoice_void', { entityType: 'vendor_invoice', entityId: inv.id });
}
async function extendTrial(ctx, vendorId, days) {
  const sub = await ensure(vendorId);
  const n = Math.max(1, Math.min(365, Number(days) || 0));
  const base = sub.trial_ends_at && String(sub.trial_ends_at) >= todayOf() ? String(sub.trial_ends_at) : todayOf();
  await knex('vendor_subscriptions').where({ id: sub.id }).update({ status: 'trialing', trial_ends_at: addDays(base, n), updated_at: new Date() });
  await pnotify.vendor(vendorId, 'trial_extended', { n }, { link: '/vendor/billing', severity: 'success' });
  await audit.record(ctx, 'platform.vendor_trial_extended', { entityType: 'vendor', entityId: vendorId, newValues: { days: n } });
}

// ---------------------------------------------------------------- ads
const IMG = ['image/png', 'image/jpeg', 'image/webp'];
const lowerList = (v) => [...new Set([].concat(v || []).flatMap((x) => String(x).split(/[,،\n]/)).map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 40);
const adSchema = z.object({
  title: z.string().trim().min(2, 'Required.').max(120), title_en: optionalString(120), body: optionalString(300), body_en: optionalString(300),
  starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.'), days: z.preprocess((v) => Number(v), z.number().int().min(1, 'Too small.').max(365, 'Too large.')),
});
/** A new ad. Free while the plan's monthly ad days last; else priced per day and waits for payment. */
async function createAd(vctx, input, image = null) {
  const s = await settings();
  const st = await assertCan(vctx.vendorId, 'ad');
  const d = validate(adSchema, input);
  if (d.days > s.adMaxDays) throw E.validation({ days: 'Too large.' });
  if (d.starts_on < todayOf()) throw E.validation({ starts_on: 'Choose today or a later date.' });
  const offerId = Number(input.offer_id) || null;
  if (offerId && !(await knex('vendor_offers').where({ id: offerId, vendor_id: vctx.vendorId }).first('id'))) throw E.validation({ offer_id: 'Choose a valid value.' });
  const specialties = [].concat(input.specialties || []).map(String).filter(Boolean).slice(0, 20);
  const cities = lowerList(input.cities);
  const freeLeft = st.enabled ? Math.max(0, (st.limits.adDays || 0) - st.usage.freeAdDays) : 0;
  const free = st.enabled ? d.days <= freeLeft : false;
  const price = free ? 0 : r3(d.days * Number(s.adPricePerDay || 0));
  const status = price > 0 ? 'pending_payment' : 'approved';
  const row = {
    vendor_id: vctx.vendorId, offer_id: offerId, title: d.title, title_en: d.title_en || null, body: d.body || null, body_en: d.body_en || null,
    specialties: JSON.stringify(specialties), cities: JSON.stringify(cities), starts_on: d.starts_on, days: d.days, ends_on: addDays(d.starts_on, d.days - 1), price, status,
    ...(image && IMG.includes(image.mime) ? { image: image.data, image_mime: image.mime } : {}),
  };
  const [id] = await knex('vendor_ads').insert(row);
  if (price > 0) {
    const number = await nextNumber();
    await knex('vendor_invoices').insert({ number, vendor_id: vctx.vendorId, kind: 'ad', ad_id: id, description: `${d.title} · ${d.days}`, amount: price, currency: s.adCurrency });
  }
  const vn = await knex('vendors').where({ id: vctx.vendorId }).first('name');
  await pnotify.admin('ad_created', { vendor: vn ? vn.name : '', title: d.title, days: d.days }, { link: '/admin/vendor-billing?tab=ads' });
  await audit.record({ ...vctx, businessId: null }, 'vendor.ad_created', { entityType: 'vendor_ad', entityId: id, newValues: { title: d.title, days: d.days, price, specialties: specialties.join(','), cities: cities.join(',') } });
  return { id, price, status };
}
const vendorAds = (vendorId) => knex('vendor_ads').where({ vendor_id: vendorId }).orderBy('created_at', 'desc').select('id', 'title', 'title_en', 'starts_on', 'ends_on', 'days', 'price', 'status', 'impressions', 'clicks', 'admin_note', 'specialties', 'cities', 'image_mime', 'offer_id');
async function cancelAd(vctx, id) {
  const ad = await knex('vendor_ads').where({ id: Number(id) || 0, vendor_id: vctx.vendorId }).first('id', 'status');
  if (!ad) throw E.notFound('Ad');
  await knex('vendor_ads').where({ id: ad.id }).update({ status: 'cancelled', updated_at: new Date() });
  await knex('vendor_invoices').where({ ad_id: ad.id, status: 'open' }).update({ status: 'void' });
  await audit.record({ ...vctx, businessId: null }, 'vendor.ad_cancelled', { entityType: 'vendor_ad', entityId: ad.id });
}
async function moderateAd(ctx, id, action, note) {
  const ad = await knex('vendor_ads').where({ id: Number(id) || 0 }).first('id', 'status');
  if (!ad) throw E.notFound('Ad');
  const status = action === 'reject' ? 'rejected' : 'approved';
  if (status === 'approved' && ad.status === 'pending_payment') throw new AppError('AD_UNPAID', 'This ad is not paid yet.', 409);
  await knex('vendor_ads').where({ id: ad.id }).update({ status, admin_note: String(note || '').trim().slice(0, 300) || null, updated_at: new Date() });
  const full = await knex('vendor_ads').where({ id: ad.id }).first('vendor_id', 'title');
  await pnotify.vendor(full.vendor_id, `ad_${status}`, { title: full.title, note: String(note || '').trim().slice(0, 300) }, { link: '/vendor/ads', severity: status === 'approved' ? 'success' : 'warning' });
  await audit.record(ctx, `platform.vendor_ad_${status}`, { entityType: 'vendor_ad', entityId: ad.id, newValues: { note } });
}

/** Ads a clinic sees today: running, from active vendors, matching its specialty and city. Counts the impression. */
async function adsFor(business, { limit: n = 1 } = {}) {
  const today = clinicNow(business.timezone || TZ).date;
  const rows = await knex('vendor_ads as a').join('vendors as v', 'v.id', 'a.vendor_id')
    .where({ 'a.status': 'approved', 'v.status': 'active' }).where('a.starts_on', '<=', today).where('a.ends_on', '>=', today)
    .select('a.id', 'a.vendor_id', 'a.offer_id', 'a.title', 'a.title_en', 'a.body', 'a.body_en', 'a.image_mime', 'a.specialties', 'a.cities', 'v.name as vendor_name', 'v.name_en as vendor_name_en');
  const spec = business.specialty || null;
  const city = String(business.city || '').trim().toLowerCase();
  const fit = rows.filter((a) => {
    const sp = json(a.specialties, []); const ct = json(a.cities, []);
    return (!sp.length || (spec && sp.includes(spec)) || ['general', 'multi', 'other', null].includes(spec)) && (!ct.length || (city && ct.includes(city)));
  });
  for (let i = fit.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [fit[i], fit[j]] = [fit[j], fit[i]]; }
  const out = fit.slice(0, n);
  if (out.length) await knex('vendor_ads').whereIn('id', out.map((a) => a.id)).increment('impressions', 1).catch(() => {});
  return out;
}
async function adClick(id) {
  const ad = await knex('vendor_ads').where({ id: Number(id) || 0, status: 'approved' }).first('id', 'offer_id', 'vendor_id');
  if (!ad) return null;
  await knex('vendor_ads').where({ id: ad.id }).increment('clicks', 1);
  return ad;
}
async function adImage(id) { return knex('vendor_ads').where({ id: Number(id) || 0 }).whereIn('status', ['approved', 'pending_payment', 'draft']).first('image', 'image_mime'); }

// ---------------------------------------------------------------- platform admin lists
const adminVendors = () => knex('vendors as v').leftJoin('vendor_subscriptions as s', 's.vendor_id', 'v.id').leftJoin('vendor_plans as p', 'p.id', 's.plan_id')
  .orderBy('v.created_at', 'desc').limit(300).select('v.id', 'v.name', 'v.status as vendor_status', 's.status', 's.trial_ends_at', 's.current_period_end', 'p.name as plan_name');
const adminInvoices = (status) => knex('vendor_invoices as i').join('vendors as v', 'v.id', 'i.vendor_id').modify((q) => { if (status) q.where('i.status', status); })
  .orderBy('i.created_at', 'desc').limit(200).select('i.*', 'v.name as vendor_name');
const adminAds = () => knex('vendor_ads as a').join('vendors as v', 'v.id', 'a.vendor_id').orderBy('a.created_at', 'desc').limit(200)
  .select('a.id', 'a.title', 'a.status', 'a.starts_on', 'a.ends_on', 'a.days', 'a.price', 'a.impressions', 'a.clicks', 'a.admin_note', 'a.image_mime', 'v.name as vendor_name');

module.exports = {
  KEY, DEFAULTS, CYCLES, METHODS, todayOf, settings, saveSettings, plans, plan, savePlan, ensure, state, assertCan, maxOfferClinics,
  invoices, choosePlan, reportPayment, confirmPayment, voidInvoice, extendTrial, createAd, vendorAds, cancelAd, moderateAd, adsFor, adClick, adImage,
  adminVendors, adminInvoices, adminAds, lowerList,
};
