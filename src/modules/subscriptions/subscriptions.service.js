// SaaS subscriptions: the platform sells DocBook to clinics.
//
// Rules that matter:
//  • OFF by default (platform_settings "subscriptions".enabled). While off, nothing here changes behaviour:
//    hasFeature → true, checkLimit → ok, no rows are created, the scheduled job does nothing.
//  • A clinic's row is created lazily the first time it is seen while subscriptions are on — a fresh trial of
//    `trialDays` days. So new clinics and the clinics that existed when the platform enabled subscriptions both
//    start with a trial, and the signup code does not need to know about subscriptions.
//  • Lifecycle (pure, see evaluate): trialing → expired after trial_ends_at; active → past_due after
//    current_period_end, → expired after the grace period (graceDays). comped never expires. cancelled keeps access
//    until the end of the paid period (or trial), then the clinic is read-only.
//  • Expired (or cancelled past its end) = read-only: data stays readable and exportable, only writes are blocked
//    (enforce.js). Medical data is never held hostage.
//  • Payments are manual (bank transfer / CliQ / cash): the clinic may report a payment with its reference, the
//    platform admin confirms it, and that extends current_period_end. Every change is audited.
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const { translator } = require('../../core/i18n');
const { clinicNow } = require('../clinic/scheduling');

const entitlements = require('./entitlements');
const branchPricing = require('./branch-pricing');
// The six clinic features (their keys predate the entitlement registry, which lists them first).
const FEATURES = ['online_consultations', 'online_payments', 'reminders', 'ai_assistant', 'specialty_modules', 'data_sync'];
const STATUSES = ['trialing', 'active', 'past_due', 'expired', 'cancelled', 'comped'];
const CYCLES = ['monthly', 'yearly'];
const METHODS = ['bank_transfer', 'cliq', 'cash'];
const LIMITS = { doctors: 'max_doctors', staff: 'max_staff', appointments: 'max_appointments_month', patients: 'limits.max_patients', branches: 'clinic.max_branches' }; // patients: an entitlement in plan.features
const REMIND_DAYS = [7, 3, 1];
const KEY = 'subscriptions';
const DEFAULTS = {
  enabled: false, trialDays: 30, graceDays: 7, trialNoCard: true, trialPlanId: null,
  billingName: '', bankName: '', accountName: '', iban: '', swift: '', cliqAlias: '', cliqName: '', instructions: '', instructions_en: '',
};

// ---------------------------------------------------------------- dates (clinic calendar dates, 'YYYY-MM-DD')
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + Number(n)); return iso(d); };
const diffDays = (a, b) => Math.round((toDate(b) - toDate(a)) / 86_400_000); // b − a
function addMonths(s, n) {
  const d = toDate(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Number(n));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d);
}
/**
 * Last day covered by a period that starts on `start` (monthly: to the day before the same day next month). When
 * that month has no such day (a 31st, or 29 Feb a year on), the period runs to the month's last day — never short.
 */
function periodEnd(start, cycle) {
  const same = addMonths(start, cycle === 'yearly' ? 12 : 1);
  return Number(same.slice(8)) < Number(String(start).slice(8, 10)) ? same : addDays(same, -1);
}
const dateStr = (v) => (v instanceof Date ? iso(new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()))) : v ? String(v).slice(0, 10) : null);
let nowFn = () => new Date();
/** Replaces the clock (tests only). */
const setNow = (fn) => { nowFn = fn || (() => new Date()); };
const todayOf = (business) => clinicNow((business && business.timezone) || 'Asia/Amman', nowFn()).date;

// ---------------------------------------------------------------- platform settings
async function settings() {
  return cache.remember('subs:settings', async () => {
    const row = await knex('platform_settings').where({ key: KEY }).first('value');
    let v = {};
    try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
    return { ...DEFAULTS, ...v };
  }, 15_000);
}
const forgetSettings = () => cache.forgetPrefix('subs:');

const txt = (max) => z.preprocess((v) => (v === undefined || v === null ? '' : String(v).trim()), z.string().max(max, 'Too long.'));
const intIn = (min, max) => z.preprocess((v) => (v === '' || v === undefined ? undefined : Number(v)), z.number({ invalid_type_error: 'Enter a number.', required_error: 'Required.' }).int('Enter a number.').min(min, 'Too small.').max(max, 'Too large.'));
const settingsSchema = z.object({
  enabled: z.preprocess((v) => v === '1' || v === true || v === 'on', z.boolean()),
  trialDays: intIn(1, 365),
  graceDays: intIn(0, 90),
  trialNoCard: z.preprocess((v) => v === '1' || v === true || v === 'on', z.boolean()),
  trialPlanId: z.preprocess((v) => (v === '' || v === undefined || v === null ? null : Number(v)), z.number().int().positive().nullable()),
  billingName: txt(160), bankName: txt(160), accountName: txt(160), iban: txt(60), swift: txt(20), cliqAlias: txt(60), cliqName: txt(160),
  instructions: txt(1000), instructions_en: txt(1000),
});

async function saveSettings(ctx, input) {
  const d = validate(settingsSchema, input);
  if (d.trialPlanId && !(await knex('subscription_plans').where({ id: d.trialPlanId }).first('id'))) throw E.validation({ trialPlanId: 'Choose a valid value.' });
  const cur = await settings();
  const value = JSON.stringify({ ...cur, ...d });
  await knex('platform_settings').insert({ key: KEY, value }).onConflict('key').merge({ value, updated_at: new Date() });
  forgetSettings();
  const changed = Object.fromEntries(Object.entries(d).filter(([k, v]) => JSON.stringify(cur[k]) !== JSON.stringify(v)));
  await audit.record(ctx, 'platform.subscriptions_settings', { entityType: 'platform_settings', entityId: KEY, oldValues: Object.fromEntries(Object.keys(changed).map((k) => [k, cur[k]])), newValues: changed });
  return d;
}

// ---------------------------------------------------------------- plans
const parseFeatures = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v) || {}; } catch { return {}; } };
const planOut = (p) => (p ? { ...p, features: parseFeatures(p.features), price_monthly: Number(p.price_monthly), price_yearly: Number(p.price_yearly) } : null);

async function listPlans({ activeOnly = false, publicOnly = false } = {}) {
  const q = knex('subscription_plans').orderBy([{ column: 'sort_order' }, { column: 'id' }]);
  if (activeOnly) q.where({ is_active: true });
  if (publicOnly) q.where({ is_public: true });
  return (await q).map(planOut);
}
const getPlan = async (id) => (id ? planOut(await knex('subscription_plans').where({ id }).first()) : null);

const limitField = z.preprocess((v) => (v === '' || v === undefined || v === null ? null : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(0, 'Must be zero or more.').max(100000, 'Too large.').nullable());
const price = z.preprocess((v) => (v === '' || v === undefined || v === null ? 0 : Number(String(v).replace(/,/g, ''))), z.number({ invalid_type_error: 'Enter a number.' }).finite('Enter a number.').min(0, 'Must be zero or more.').max(1e7, 'Too large.'));
const planSchema = z.object({
  name: z.string({ required_error: 'Required.' }).trim().min(1, 'Required.').max(120),
  name_en: optionalString(120),
  description: optionalString(500),
  description_en: optionalString(500),
  price_monthly: price,
  price_yearly: price,
  currency: z.preprocess((v) => String(v || 'JOD').trim().toUpperCase(), z.string().regex(/^[A-Z]{3}$/, 'Choose a valid value.')),
  max_doctors: limitField, max_staff: limitField, max_appointments_month: limitField,
  is_active: z.preprocess((v) => v === '1' || v === true || v === 'on', z.boolean()),
  is_public: z.preprocess((v) => v === '1' || v === true || v === 'on', z.boolean()),
  is_featured: z.preprocess((v) => v === '1' || v === true || v === 'on', z.boolean()),
  sort_order: z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(-1000).max(1000)),
});

async function savePlan(ctx, id, input) {
  const d = validate(planSchema, input);
  const features = entitlements.fromForm(input); // every key of the registry, typed (src/modules/subscriptions/entitlements.js)
  const row = { ...d, name_en: d.name_en || null, description: d.description || null, description_en: d.description_en || null, features: JSON.stringify(features),
    branch_prices: JSON.stringify(branchPricing.fromForm(input)), updated_at: new Date() };
  if (id) {
    const before = await knex('subscription_plans').where({ id }).first();
    if (!before) throw E.notFound('Plan');
    await knex('subscription_plans').where({ id }).update(row);
    const { oldValues, newValues } = audit.diff({ ...before, features: JSON.stringify(parseFeatures(before.features)) }, row);
    delete oldValues.updated_at; delete newValues.updated_at;
    await audit.record(ctx, 'platform.plan_updated', { entityType: 'subscription_plan', entityId: id, oldValues, newValues });
    return Number(id);
  }
  const [newId] = await knex('subscription_plans').insert(row);
  await audit.record(ctx, 'platform.plan_created', { entityType: 'subscription_plan', entityId: newId, newValues: { ...d, features } });
  return newId;
}

/** Deletes a plan nobody uses; a plan in use (or on an invoice) is hidden and deactivated instead. */
async function deletePlan(ctx, id) {
  const p = await knex('subscription_plans').where({ id }).first();
  if (!p) throw E.notFound('Plan');
  const [{ n }] = await knex('clinic_subscriptions').where({ plan_id: id }).count({ n: '*' });
  const [{ m }] = await knex('platform_invoices').where({ plan_id: id }).count({ m: '*' });
  const st = await settings();
  if (Number(n) || Number(m) || Number(st.trialPlanId) === Number(id)) {
    await knex('subscription_plans').where({ id }).update({ is_active: false, is_public: false, updated_at: new Date() });
    await audit.record(ctx, 'platform.plan_retired', { entityType: 'subscription_plan', entityId: id, oldValues: { is_active: p.is_active, is_public: p.is_public }, newValues: { is_active: false, is_public: false, name: p.name } });
    return 'retired';
  }
  await knex('subscription_plans').where({ id }).del();
  await audit.record(ctx, 'platform.plan_deleted', { entityType: 'subscription_plan', entityId: id, oldValues: { name: p.name, price_monthly: p.price_monthly } });
  return 'deleted';
}

// ---------------------------------------------------------------- lifecycle (pure)
const subOut = (s) => (s ? { ...s, trial_ends_at: dateStr(s.trial_ends_at), current_period_start: dateStr(s.current_period_start), current_period_end: dateStr(s.current_period_end), grace_ends_at: dateStr(s.grace_ends_at) } : null);

/**
 * The status a subscription should have on `today` (pure). Returns the fields to change, or null.
 * @param {object} sub  row with status, trial_ends_at, current_period_end, grace_ends_at
 */
function evaluate(sub, today, graceDays = DEFAULTS.graceDays) {
  if (!sub) return null;
  if (sub.status === 'trialing') {
    return sub.trial_ends_at && today > sub.trial_ends_at ? { status: 'expired' } : null;
  }
  if (sub.status === 'active' || sub.status === 'past_due') {
    if (!sub.current_period_end || today <= sub.current_period_end) return sub.status === 'past_due' ? { status: 'active', grace_ends_at: null } : null;
    const grace = sub.grace_ends_at || addDays(sub.current_period_end, graceDays);
    if (today > grace) return { status: 'expired', grace_ends_at: grace };
    return sub.status === 'past_due' && sub.grace_ends_at === grace ? null : { status: 'past_due', grace_ends_at: grace };
  }
  return null;
}

/** The last day the clinic can work normally (null = no end, e.g. comped). */
function accessEnd(sub) {
  if (!sub) return null;
  if (sub.status === 'comped') return null;
  if (sub.status === 'trialing') return sub.trial_ends_at;
  if (sub.status === 'past_due') return sub.grace_ends_at;
  if (sub.status === 'active') return sub.current_period_end;
  if (sub.status === 'cancelled') return sub.current_period_end && (!sub.trial_ends_at || sub.current_period_end > sub.trial_ends_at) ? sub.current_period_end : sub.trial_ends_at;
  return null;
}

/** True when the clinic may only read (and export) its data. */
function isReadOnly(sub, today) {
  if (!sub) return false;
  if (sub.status === 'expired') return true;
  if (sub.status === 'cancelled') { const end = accessEnd(sub); return !end || today > end; }
  return false;
}

// Paths under /app that stay writable while read-only: paying, the person's own account and security, sign-out,
// notifications, and getting the data out (export, copy to the clinic's own database).
const WRITABLE = [/^\/settings\/subscription(\/|$)/, /^\/settings\/account(\/|$)/, /^\/settings\/security(\/|$)/, /^\/settings\/preferences(\/|$)/,
  /^\/settings\/data\/export(\/|$)/, /^\/settings\/database(\/|$)/, /^\/notifications(\/|$)/, /^\/logout(\/|$)/, /^\/workspaces(\/|$)/];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Pure: may this request go through while the clinic is read-only? (`path` is relative to /app) */
function allowedWhileReadOnly(method, path) {
  if (SAFE_METHODS.has(String(method).toUpperCase())) return true;
  return WRITABLE.some((re) => re.test(path));
}

/** Pure: which plan limit a create request touches (relative to /app), or null. */
function limitFor(method, path, body = {}) {
  if (String(method).toUpperCase() !== 'POST') return null;
  if (/^\/doctors\/new\/?$/.test(path)) return body.is_active === undefined || body.is_active === '1' || body.is_active === 'on' ? 'doctors' : null;
  // Team lives at /clinic/team (old address /settings/team still accepts posts).
  if (/^\/(?:settings|clinic)\/team\/?$/.test(path)) return 'staff';
  if (/^\/(?:settings|clinic)\/team\/\d+\/status\/?$/.test(path)) return body.status === 'active' ? 'staff' : null;
  if (/^\/(?:settings|clinic)\/team\/invitations\/\d+\/renew\/?$/.test(path)) return 'staff';
  // Only the explicit "new patient" form: a booking or a walk-in never stops at a limit (patient care comes first).
  if (/^\/patients\/?$/.test(path)) return 'patients';
  if (/^\/appointments\/new\/?$/.test(path)) return body.appointment_type === 'blocked' ? null : 'appointments';
  return null;
}

// ---------------------------------------------------------------- rows
async function row(businessId) { return subOut(await knex('clinic_subscriptions').where({ business_id: businessId }).first()); }

/** The clinic's subscription, created (fresh trial) when missing, with its status brought up to date. */
async function ensure(business, today = todayOf(business), st = null) {
  const cfg = st || await settings();
  let sub = await row(business.id);
  if (!sub) {
    const trialEnd = addDays(today, cfg.trialDays - 1); // the start day counts: a 30-day trial ends on day 30
    const plan = cfg.trialPlanId ? await knex('subscription_plans').where({ id: cfg.trialPlanId }).first('id') : null;
    await knex('clinic_subscriptions').insert({ business_id: business.id, plan_id: plan ? plan.id : null, status: 'trialing', trial_ends_at: trialEnd })
      .onConflict('business_id').ignore();
    sub = await row(business.id);
    if (sub && sub.trial_ends_at === trialEnd && sub.status === 'trialing') {
      await audit.record({ businessId: business.id, userId: null }, 'subscription.trial_started', { entityType: 'subscription', entityId: sub.id, newValues: { trial_ends_at: trialEnd, plan_id: sub.plan_id } });
    }
  }
  const patch = evaluate(sub, today, cfg.graceDays);
  if (patch) {
    const n = await knex('clinic_subscriptions').where({ id: sub.id, status: sub.status }).update({ ...patch, updated_at: new Date() });
    if (n) await audit.record({ businessId: business.id, userId: null }, 'subscription.status_changed', { entityType: 'subscription', entityId: sub.id, oldValues: { status: sub.status }, newValues: patch });
    sub = await row(business.id);
  }
  return sub;
}

/** Branches the clinic may run: the plan's limit; once paying, the number of branches it pays for (within that limit). */
function branchLimit(sub, plan) {
  const max = entitlements.valueIn(plan.features, 'clinic.max_branches');
  if (!sub || sub.status === 'trialing' || sub.status === 'comped') return max;
  const paid = Math.max(1, Number(sub.branches) || 1);
  return max === null ? paid : Math.min(max, paid);
}

function limitsOf(sub, plan) {
  if (!plan || (sub && sub.status === 'comped' && !sub.plan_id)) return { doctors: null, staff: null, appointments: null, patients: null, branches: null };
  return { doctors: plan.max_doctors, staff: plan.max_staff, appointments: plan.max_appointments_month, patients: entitlements.valueIn(plan.features, 'limits.max_patients'), branches: branchLimit(sub, plan) };
}

async function usage(businessId, today) {
  const month = String(today).slice(0, 7);
  const count = async (q) => Number((await q.count({ n: '*' }))[0].n);
  const [doctors, members, invites, appointments, patients, branches] = await Promise.all([
    count(knex('doctors').where({ business_id: businessId, is_active: true })),
    count(knex('memberships').where({ business_id: businessId, status: 'active' })),
    count(knex('invitations').where({ business_id: businessId }).whereNull('accepted_at').whereNull('revoked_at').where('expires_at', '>', new Date())),
    count(knex('appointments').where({ business_id: businessId }).whereNot('appointment_type', 'blocked').whereNot('status', 'cancelled')
      .whereBetween('appointment_date', [`${month}-01`, `${month}-31`])),
    count(knex('patients').where({ business_id: businessId })),
    count(knex('clinic_branches').where({ business_id: businessId, is_active: true })),
  ]);
  return { doctors, staff: members + invites, appointments, patients, branches: branches + 1 }; // + the main branch
}

/** Everything the pages need about a clinic's subscription (null when subscriptions are off). */
async function state(business, today = todayOf(business)) {
  const cfg = await settings();
  if (!cfg.enabled) return null;
  const sub = await ensure(business, today, cfg);
  const plan = await getPlan(sub.plan_id);
  const end = accessEnd(sub);
  return {
    sub, plan, settings: cfg, today, readOnly: isReadOnly(sub, today), accessEnd: end,
    daysLeft: end ? Math.max(0, diffDays(today, end) + 1) : null, // the end day itself still counts
    trialDaysLeft: sub.status === 'trialing' && sub.trial_ends_at ? Math.max(0, diffDays(today, sub.trial_ends_at) + 1) : null,
    limits: limitsOf(sub, plan),
  };
}

// ---------------------------------------------------------------- helpers for other modules
/**
 * Is a feature included for this clinic? Always true while subscriptions are off, during a trial without a
 * trial plan, and for a comped clinic without a plan; false when read-only.
 * Keys: online_consultations, online_payments, reminders, ai_assistant, specialty_modules, data_sync.
 */
async function hasFeature(business, key) {
  const cfg = await settings();
  if (!cfg.enabled || !business) return true;
  const today = todayOf(business);
  const sub = await ensure(business, today, cfg);
  if (isReadOnly(sub, today)) return false;
  const plan = await getPlan(sub.plan_id);
  if (!plan) return true;
  return Boolean(plan.features[key]);
}

/**
 * Plan limit check for creating one more doctor / staff login / appointment this month.
 * → { ok, limit, used }. Always ok while subscriptions are off or the plan has no limit.
 */
async function checkLimit(req, kind) {
  if (!LIMITS[kind]) throw new Error(`Unknown limit ${kind}`);
  const cfg = await settings();
  if (!cfg.enabled) return { ok: true, limit: null, used: null };
  const business = req.business;
  const today = (req.ctx && req.ctx.today) || todayOf(business);
  const sub = await ensure(business, today, cfg);
  const limit = limitsOf(sub, await getPlan(sub.plan_id))[kind];
  if (limit === null || limit === undefined) return { ok: true, limit: null, used: null };
  const used = (await usage(business.id, today))[kind];
  return { ok: used < limit, limit, used };
}

/**
 * How many branches (the main one included) the clinic may run: null = no limit (subscriptions off, no plan, comped
 * without a plan); otherwise the plan's limit, or the number of branches the clinic pays for once it is paying.
 */
async function branchAllowance(business) {
  const cfg = await settings();
  if (!cfg.enabled || !business) return null;
  const today = todayOf(business);
  const sub = await ensure(business, today, cfg);
  return limitsOf(sub, await getPlan(sub.plan_id)).branches;
}

/** Public online booking: false for a read-only clinic (expired subscription). Always true while subscriptions are off. */
async function acceptsBookings(clinic) {
  const cfg = await settings();
  if (!cfg.enabled || !clinic) return true;
  const today = todayOf(clinic);
  return !isReadOnly(await ensure(clinic, today, cfg), today);
}

// ---------------------------------------------------------------- invoices
const INV_PREFIX = 'PL';
async function numberInvoice(id, trx = knex) {
  const number = `${INV_PREFIX}-${new Date().getUTCFullYear()}-${String(id).padStart(6, '0')}`;
  await trx('platform_invoices').where({ id }).update({ number });
  return number;
}

async function listInvoices(businessId, limit = 50) {
  return (await knex('platform_invoices').where({ business_id: businessId }).orderBy('id', 'desc').limit(limit))
    .map((i) => ({ ...i, amount: Number(i.amount), period_start: dateStr(i.period_start), period_end: dateStr(i.period_end) }));
}
async function getInvoice(businessId, id) {
  const i = await knex('platform_invoices').where({ id, ...(businessId ? { business_id: businessId } : {}) }).first();
  if (!i) throw E.notFound('Invoice');
  return { ...i, amount: Number(i.amount), period_start: dateStr(i.period_start), period_end: dateStr(i.period_end) };
}

/** Where the next paid period starts: right after the current one while it is active / in grace, else today. */
function nextPeriodStart(sub, today) {
  if (sub && ['active', 'past_due'].includes(sub.status) && sub.current_period_end) return addDays(sub.current_period_end, 1);
  // A cancelled subscription still paid ahead: the new period starts after the days already paid for.
  if (sub && sub.status === 'cancelled' && sub.current_period_end && dateStr(sub.current_period_end) >= today) return addDays(dateStr(sub.current_period_end), 1);
  if (sub && sub.status === 'trialing' && sub.trial_ends_at && sub.trial_ends_at >= today) return addDays(sub.trial_ends_at, 1);
  return today;
}

const chooseSchema = z.object({
  plan_id: z.coerce.number({ invalid_type_error: 'Choose a valid value.' }).int().positive('Choose a valid value.'),
  billing_cycle: z.enum(CYCLES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  branches: z.preprocess((v) => (v === '' || v === undefined ? 1 : Number(v)), z.number({ invalid_type_error: 'Choose a valid value.' }).int().min(1, 'Choose a valid value.').max(branchPricing.MAX_CHOICE, 'Choose a valid value.')),
});

/** A branch count the plan allows (1 … clinic.max_branches), or a validation error. */
function checkBranches(plan, branches) {
  const max = entitlements.valueIn(plan.features, 'clinic.max_branches');
  if (max !== null && branches > Math.max(1, max)) throw E.validation({ branches: 'This plan does not include that many branches.' });
  return branches;
}

/** The clinic picks a plan and cycle: an open invoice for the next period (earlier open invoices are voided). */
async function choosePlan(ctx, business, input) {
  const d = validate(chooseSchema, input);
  const plan = await getPlan(d.plan_id);
  if (!plan || !plan.is_active || !plan.is_public) throw E.validation({ plan_id: 'Choose a valid value.' });
  const today = ctx.today || todayOf(business);
  const sub = await ensure(business, today);
  const branches = checkBranches(plan, d.branches);
  const used = (await usage(business.id, today)).branches;
  if (branches < used) throw E.validation({ branches: 'The clinic already has more active branches. Turn some off first.' });
  const amount = branchPricing.priceFor(plan, branches, d.billing_cycle);
  const start = nextPeriodStart(sub, today);
  return knex.transaction(async (trx) => {
    const voided = await trx('platform_invoices').where({ business_id: business.id, status: 'open' }).update({ status: 'void', updated_at: new Date() });
    const [id] = await trx('platform_invoices').insert({
      business_id: business.id, plan_id: plan.id, plan_name: plan.name, plan_name_en: plan.name_en, billing_cycle: d.billing_cycle,
      period_start: start, period_end: periodEnd(start, d.billing_cycle), amount, currency: plan.currency, status: 'open', created_by: ctx.userId || null, branches,
    });
    const number = await numberInvoice(id, trx);
    await audit.record(ctx, 'subscription.plan_chosen', { entityType: 'platform_invoice', entityId: id, newValues: { number, plan_id: plan.id, billing_cycle: d.billing_cycle, branches, amount, voided_open_invoices: voided } }, trx);
    return id;
  });
}

const noticeSchema = z.object({
  method: z.enum(METHODS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  reference: z.string({ required_error: 'Required.' }).trim().min(2, 'Required.').max(120),
  notice_note: optionalString(500),
});

/** The clinic reports that it paid an open invoice (the platform admin confirms it later). */
async function reportPayment(ctx, businessId, invoiceId, input) {
  const d = validate(noticeSchema, input);
  const inv = await getInvoice(businessId, invoiceId);
  if (!['open', 'reported'].includes(inv.status)) throw new AppError('INVOICE_CLOSED', 'This invoice is already closed.', 409);
  await knex('platform_invoices').where({ id: inv.id }).update({ status: 'reported', method: d.method, reference: d.reference, notice_note: d.notice_note || null, reported_at: new Date(), reported_by: ctx.userId, updated_at: new Date() });
  await audit.record(ctx, 'subscription.payment_reported', { entityType: 'platform_invoice', entityId: inv.id, oldValues: { status: inv.status }, newValues: { status: 'reported', method: d.method, reference: d.reference, amount: inv.amount } });
}

// ---------------------------------------------------------------- platform admin actions (ctx.businessId = null)
async function adminSub(businessId) {
  const b = await knex('businesses').where({ id: businessId }).first('id', 'name', 'timezone', 'currency');
  if (!b) throw E.notFound('Clinic');
  const today = todayOf(b);
  const sub = await ensure(b, today);
  return { b, sub, today };
}
const adminAudit = (ctx, action, b, sub, oldValues, newValues) => audit.record({ ...ctx, businessId: null }, action, { entityType: 'clinic', entityId: b.id, oldValues, newValues: { ...newValues, clinic: b.name } })
  .then(() => audit.record({ businessId: b.id, userId: ctx.userId, ip: ctx.ip, userAgent: ctx.userAgent }, action, { entityType: 'subscription', entityId: sub.id, oldValues, newValues }));

async function extendTrial(ctx, businessId, input) {
  const d = validate(z.object({ days: intIn(1, 365) }), input);
  const { b, sub, today } = await adminSub(businessId);
  const running = sub.status === 'trialing' && sub.trial_ends_at && sub.trial_ends_at >= today;
  const trialEnd = running ? addDays(sub.trial_ends_at, d.days) : addDays(today, d.days - 1);
  await knex('clinic_subscriptions').where({ id: sub.id }).update({ status: 'trialing', trial_ends_at: trialEnd, grace_ends_at: null, cancelled_at: null, updated_at: new Date() });
  await adminAudit(ctx, 'platform.subscription_trial_extended', b, sub, { status: sub.status, trial_ends_at: sub.trial_ends_at }, { status: 'trialing', trial_ends_at: trialEnd, days: d.days });
  return trialEnd;
}

async function changePlan(ctx, businessId, input) {
  const d = validate(z.object({
    plan_id: z.preprocess((v) => (v === '' || v === undefined ? null : Number(v)), z.number().int().positive().nullable()),
    billing_cycle: z.enum(CYCLES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
    branches: chooseSchema.shape.branches,
  }), input);
  const plan = d.plan_id ? await getPlan(d.plan_id) : null;
  if (d.plan_id && !plan) throw E.validation({ plan_id: 'Choose a valid value.' });
  if (plan) checkBranches(plan, d.branches);
  const { b, sub } = await adminSub(businessId);
  await knex('clinic_subscriptions').where({ id: sub.id }).update({ plan_id: d.plan_id, billing_cycle: d.billing_cycle, branches: d.branches, updated_at: new Date() });
  await adminAudit(ctx, 'platform.subscription_plan_changed', b, sub, { plan_id: sub.plan_id, billing_cycle: sub.billing_cycle, branches: sub.branches }, { plan_id: d.plan_id, billing_cycle: d.billing_cycle, branches: d.branches });
}

const paymentSchema = z.object({
  invoice_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  plan_id: z.preprocess((v) => (v === '' || v === undefined ? null : Number(v)), z.number().int().positive().nullable()),
  billing_cycle: z.enum(CYCLES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  branches: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(branchPricing.MAX_CHOICE).optional()),
  amount: price,
  method: z.enum(METHODS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  reference: optionalString(120),
  period_start: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.').optional()),
  period_end: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.').optional()),
});

/**
 * A manual payment received by the platform (bank transfer / CliQ / cash). Marks the given invoice paid (or issues a
 * paid invoice) and extends current_period_end to the end of the period covered. The subscription becomes active.
 */
async function recordPayment(ctx, businessId, input) {
  const d = validate(paymentSchema, input);
  const { b, sub, today } = await adminSub(businessId);
  let inv = d.invoice_id ? await getInvoice(businessId, d.invoice_id) : null;
  if (inv && !['open', 'reported'].includes(inv.status)) throw new AppError('INVOICE_CLOSED', 'This invoice is already closed.', 409);
  const planId = inv ? inv.plan_id : d.plan_id || sub.plan_id;
  const plan = await getPlan(planId);
  const cycle = inv ? inv.billing_cycle : d.billing_cycle;
  const start = d.period_start || (inv && inv.period_start && inv.period_start >= today ? inv.period_start : nextPeriodStart(sub, today));
  const end = d.period_end || periodEnd(start, cycle);
  if (end < start) throw E.validation({ period_end: 'Enter a valid date.' });
  const branches = inv ? Number(inv.branches) || 1 : d.branches || Number(sub.branches) || 1;
  if (plan && !inv) checkBranches(plan, branches);
  // A blank amount means the price of what is paid for (the invoice's, else the plan's for these branches and cycle).
  const blank = input.amount === undefined || input.amount === null || String(input.amount).trim() === '';
  const amount = !blank ? d.amount : inv ? inv.amount : plan ? branchPricing.priceFor(plan, branches, cycle) : 0;
  await knex.transaction(async (trx) => {
    const paid = { status: 'paid', method: d.method, reference: d.reference || (inv && inv.reference) || null, amount, period_start: start, period_end: end, paid_at: new Date(), confirmed_by: ctx.userId, updated_at: new Date() };
    if (inv) {
      await trx('platform_invoices').where({ id: inv.id }).update(paid);
    } else {
      const [id] = await trx('platform_invoices').insert({
        business_id: b.id, plan_id: plan ? plan.id : null, plan_name: plan ? plan.name : null, plan_name_en: plan ? plan.name_en : null, billing_cycle: cycle,
        currency: plan ? plan.currency : b.currency || 'JOD', created_by: ctx.userId, branches, ...paid,
      });
      await numberInvoice(id, trx);
      inv = { id };
    }
    await trx('clinic_subscriptions').where({ id: sub.id }).update({
      status: 'active', plan_id: plan ? plan.id : sub.plan_id, billing_cycle: cycle, branches, current_period_start: start, current_period_end: end, grace_ends_at: null, cancelled_at: null, updated_at: new Date(),
    });
  });
  await adminAudit(ctx, 'platform.subscription_payment', b, sub, { status: sub.status, current_period_end: sub.current_period_end },
    { status: 'active', invoice_id: inv.id, amount, branches, method: d.method, reference: d.reference || null, period_start: start, period_end: end });
  return { invoiceId: inv.id, start, end };
}

async function comp(ctx, businessId, input = {}) {
  const note = String(input.note || '').trim().slice(0, 500) || null;
  const { b, sub } = await adminSub(businessId);
  await knex('clinic_subscriptions').where({ id: sub.id }).update({ status: 'comped', grace_ends_at: null, cancelled_at: null, note, updated_at: new Date() });
  await adminAudit(ctx, 'platform.subscription_comped', b, sub, { status: sub.status }, { status: 'comped', note });
}

async function cancel(ctx, businessId) {
  const { b, sub } = await adminSub(businessId);
  if (sub.status === 'cancelled') return;
  await knex.transaction(async (trx) => {
    await trx('clinic_subscriptions').where({ id: sub.id }).update({ status: 'cancelled', cancelled_at: new Date(), updated_at: new Date() });
    await trx('platform_invoices').where({ business_id: b.id }).whereIn('status', ['open']).update({ status: 'void', updated_at: new Date() });
  });
  await adminAudit(ctx, 'platform.subscription_cancelled', b, sub, { status: sub.status }, { status: 'cancelled' });
}

async function voidInvoice(ctx, invoiceId) {
  const inv = await getInvoice(null, invoiceId);
  if (!['open', 'reported'].includes(inv.status)) throw new AppError('INVOICE_CLOSED', 'This invoice is already closed.', 409);
  await knex('platform_invoices').where({ id: inv.id }).update({ status: 'void', updated_at: new Date() });
  await audit.record({ ...ctx, businessId: null }, 'platform.invoice_voided', { entityType: 'platform_invoice', entityId: inv.id, oldValues: { status: inv.status }, newValues: { status: 'void', number: inv.number, business_id: inv.business_id } });
  return inv;
}

/** Admin list of clinics with their subscription (rows are created lazily, so clinics without one show "—"). */
async function adminList({ q = '', status = '', page = 1, perPage = 25 } = {}) {
  const like = `%${String(q).trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const base = knex('businesses as b').leftJoin('clinic_subscriptions as s', 's.business_id', 'b.id').leftJoin('subscription_plans as p', 'p.id', 's.plan_id')
    .modify((qb) => {
      if (q) qb.andWhere((w) => w.where('b.name', 'like', like).orWhere('b.name_en', 'like', like).orWhere('b.slug', 'like', like).orWhere('b.email', 'like', like));
      if (status === 'reported') qb.whereExists(knex('platform_invoices as i').whereRaw('i.business_id = b.id').where('i.status', 'reported'));
      else if (status === 'none') qb.whereNull('s.id');
      else if (STATUSES.includes(status)) qb.where('s.status', status);
    });
  const [{ n }] = await base.clone().count({ n: '*' });
  const pages = Math.max(1, Math.ceil(Number(n) / perPage));
  const cur = Math.min(Math.max(1, Number(page) || 1), pages);
  const rows = await base.clone().orderByRaw('s.id is null, b.created_at desc').limit(perPage).offset((cur - 1) * perPage).select(
    'b.id', 'b.name', 'b.name_en', 'b.slug', 'b.status as clinic_status', 'b.currency', 'b.timezone', 'b.created_at',
    's.id as sub_id', 's.status', 's.billing_cycle', 's.trial_ends_at', 's.current_period_end', 's.grace_ends_at', 's.plan_id', 's.note',
    'p.name as plan_name', 'p.name_en as plan_name_en',
    knex('platform_invoices').max('paid_at').whereRaw('business_id = b.id').where('status', 'paid').as('last_paid_at'),
    knex('platform_invoices').count('*').whereRaw('business_id = b.id').where('status', 'reported').as('reported'),
  );
  const counts = Object.fromEntries((await knex('clinic_subscriptions').groupBy('status').select('status').count({ n: '*' })).map((r) => [r.status, Number(r.n)]));
  const [{ r }] = await knex('platform_invoices').where({ status: 'reported' }).countDistinct({ r: 'business_id' });
  counts.reported = Number(r);
  return { rows: rows.map((x) => ({ ...subOut(x), id: x.id, reported: Number(x.reported) })), meta: { total: Number(n), page: cur, pages, perPage }, counts };
}

// ---------------------------------------------------------------- scheduled job
async function owners(businessId) {
  return knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').join('users as u', 'u.id', 'm.user_id')
    .where({ 'm.business_id': businessId, 'm.status': 'active', 'r.key': 'owner' }).where('u.status', 'active')
    .select('u.id', 'u.name', 'u.email', 'u.locale');
}

/** "Your trial / subscription ends in N days" to each owner (in-app, and e-mail when SMTP is set), once per day mark. */
async function remind(b, sub, kind, end, days) {
  for (const o of await owners(b.id)) { // eslint-disable-line no-restricted-syntax
    const dedupeKey = `subs:${kind}:${end}:${days}:${o.id}`;
    const exists = await knex('notifications').where({ business_id: b.id, dedupe_key: dedupeKey }).first('id'); // eslint-disable-line no-await-in-loop
    if (exists) continue; // eslint-disable-line no-continue
    const locale = o.locale === 'en' ? 'en' : 'ar';
    const t = translator(locale);
    const title = t(`subscriptions.remind_${kind}_title`, { n: days });
    const body = t(`subscriptions.remind_${kind}_body`, { date: end, clinic: b.name });
    await require('../notifications/notification.service').notify(b.id, { userId: o.id, type: `subscription.${kind}_ending`, title, body, link: '/app/settings/subscription', severity: days <= 3 ? 'warning' : 'info', dedupeKey }); // eslint-disable-line global-require, no-await-in-loop
    if (mailer.configured() && o.email) {
      const href = `${String(require('../../config').appUrl || '').replace(/\/+$/, '')}/app/settings/subscription`; // eslint-disable-line global-require
      await mailer.send({ to: o.email, subject: title, html: mailer.layout({ locale, title, body, cta: t('subscriptions.remind_cta'), href }) }) // eslint-disable-line no-await-in-loop
        .catch((e) => console.error('[subscriptions] mail:', e.message)); // eslint-disable-line no-console
    }
  }
}

/**
 * Runs every hour (src/server.js): starts trials for clinics without a row, moves statuses on, and sends the
 * 7 / 3 / 1-day reminders. `now` is injectable for tests.
 */
async function runDue(now = new Date()) {
  const cfg = await settings();
  if (!cfg.enabled) return { checked: 0 };
  const clinics = await knex('businesses').where({ status: 'active' }).select('id', 'name', 'timezone');
  let checked = 0;
  for (const b of clinics) { // eslint-disable-line no-restricted-syntax
    const today = clinicNow(b.timezone || 'Asia/Amman', now).date;
    const sub = await ensure(b, today, cfg); // eslint-disable-line no-await-in-loop
    checked += 1;
    const kind = sub.status === 'trialing' ? 'trial' : sub.status === 'active' ? 'period' : null;
    const end = kind === 'trial' ? sub.trial_ends_at : kind === 'period' ? sub.current_period_end : null;
    if (!end) continue; // eslint-disable-line no-continue
    const days = diffDays(today, end) + 1; // days of access left, the end day included
    if (REMIND_DAYS.includes(days)) await remind(b, sub, kind, end, days); // eslint-disable-line no-await-in-loop
  }
  return { checked };
}

module.exports = {
  FEATURES, STATUSES, CYCLES, METHODS, LIMITS, DEFAULTS,
  settings, saveSettings, forgetSettings,
  listPlans, getPlan, savePlan, deletePlan,
  evaluate, accessEnd, isReadOnly, allowedWhileReadOnly, limitFor, addDays, addMonths, periodEnd, diffDays, nextPeriodStart,
  ensure, state, usage, limitsOf, hasFeature, checkLimit, acceptsBookings, branchAllowance, todayOf, setNow,
  listInvoices, getInvoice, choosePlan, reportPayment,
  extendTrial, changePlan, recordPayment, comp, cancel, voidInvoice, adminList, runDue,
};
