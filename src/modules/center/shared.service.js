// Medical centre — what the centre's admin (the founding account) runs for everyone:
//   • adding a doctor: a separate practice account (own team, patients, money, website) with the doctor's own login;
//   • shared staff (reception, cashier, cleaner…): their salaries, and a login in the admin account that reaches the
//     shared reception and the shared cash screen — never inside a doctor's practice;
//   • shared expenses (rent, electricity, the shared salaries…), split equally, by percentage or by custom amounts.
//     Each practice sees what it owes; paying records the amount as an expense in that practice's own books.
// Every query is scoped by the centre of the signed-in practice (never an id from the form alone).
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const config = require('../../config');
const { AppError, E } = require('../../core/errors');
const { z, validate, optionalString, email: emailField } = require('../../core/validate');
const { clinicNow } = require('../clinic/scheduling');
const centers = require('./center.service');

const SPLITS = ['equal', 'percent', 'custom'];
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/** The centre of the signed-in practice when it is the founding (admin) account — else 403. */
async function adminCenter(ctx) {
  const c = await centers.ofBusiness(ctx.businessId);
  if (!c) throw E.notFound('Centre');
  if (!centers.isFounder(c, ctx.businessId)) throw E.forbidden('center.manage');
  return c;
}

// ---------------------------------------------------------------- adding a doctor (a separate practice + login)
const doctorSchema = z.object({
  doctor_name: z.string({ required_error: 'Required.' }).trim().min(2, 'Required.').max(160),
  email: emailField(),
  practice_name: optionalString(160),
  specialization: optionalString(120),
  phone: optionalString(40),
});

/**
 * Opens a practice for a doctor inside the centre: the doctor's own account (a new login with a link to choose a
 * password), the practice (same currency, time zone and country as the centre), the doctor's profile linked to that
 * login. An e-mail that already has an account gets an invitation instead (no account is taken over).
 */
async function addDoctor(ctx, input, { locale = 'ar', t = null } = {}) {
  const c = await adminCenter(ctx);
  // "I am a doctor too": the centre's admin opens their own practice with the login they already use.
  if (['1', 'on', true].includes(input && input.is_me)) {
    const me = await knex('users').where({ id: ctx.userId || 0 }).first('id', 'name', 'email');
    if (!me) throw E.forbidden('center.manage');
    input = { ...input, email: me.email, doctor_name: String(input.doctor_name || '').trim() || me.name }; // eslint-disable-line no-param-reassign
  }
  const d = validate(doctorSchema, input);
  const self = ctx.userId && (await knex('users').where({ id: ctx.userId }).first('email')).email === d.email;
  if (self) return addOwnPractice(ctx, c, d, locale);
  const existing = await knex('users').where({ email: d.email }).first('id');
  if (existing) {
    const inv = await centers.invite(ctx, d.email, { base: ctx.baseUrl, locale, t });
    return { invited: true, link: inv.link, email: d.email };
  }
  const businesses = require('../businesses/business.service'); // eslint-disable-line global-require
  const rbac = require('../rbac/rbac.service'); // eslint-disable-line global-require
  const setup = require('../onboarding/setup.service'); // eslint-disable-line global-require
  const { hashPassword } = require('../auth/auth.service'); // eslint-disable-line global-require
  const founder = await knex('businesses').where({ id: ctx.businessId }).first('currency', 'timezone', 'country', 'city', 'specialty');
  const name = d.practice_name || (locale === 'en' ? `Dr. ${d.doctor_name.replace(/^(dr\.?|د\.)\s*/i, '')} clinic` : `عيادة ${d.doctor_name}`);
  const token = crypto.randomBytes(32).toString('base64url');
  const out = await knex.transaction(async (trx) => {
    const [userId] = await trx('users').insert({
      name: d.doctor_name, email: d.email, phone: d.phone || null, password_hash: await hashPassword(crypto.randomBytes(24).toString('hex')),
      must_change_password: true, locale,
    });
    const bid = await businesses.create(userId, { name, currency: founder.currency, timezone: founder.timezone, country: founder.country, city: founder.city, specialty: founder.specialty }, trx);
    await trx('businesses').where({ id: bid }).update({ center_id: c.id, center_joined_at: new Date(), onboarding_completed_at: new Date(), center_share_cash: true }); // on the shared cash screen (the doctor can turn it off)
    await trx('password_resets').insert({ user_id: userId, token_hash: sha(token), created_by: ctx.userId || null, expires_at: new Date(Date.now() + 7 * 86_400_000) });
    await audit.record(ctx, 'center.doctor_added', { entityType: 'center', entityId: c.id, newValues: { doctor: d.doctor_name, email: d.email, practice: bid } }, trx);
    await audit.record({ businessId: bid, userId: ctx.userId }, 'center.joined', { entityType: 'center', entityId: c.id, newValues: { center: c.name, added_by_center: true } }, trx);
    return { userId, bid };
  });
  // The doctor's profile in their practice, linked to their login.
  const dctx = { businessId: out.bid, userId: out.userId, permissions: await rbac.getUserPermissions(out.bid, out.userId), timezone: founder.timezone, currency: founder.currency, locale };
  await setup.addDoctor(dctx, { full_name: d.doctor_name, specialization: d.specialization || '', consultation_fee: '0', slot_duration_minutes: '30', is_me: '1' }).catch(() => null);
  businesses.forget(out.bid);
  const link = `${String(ctx.baseUrl || config.appUrl).replace(/\/+$/, '')}/reset/${token}`;
  let emailed = false;
  try {
    const mailer = require('../../core/mailer'); // eslint-disable-line global-require
    if (t && mailer.configured()) {
      const vars = { center: (locale === 'en' && c.name_en) || c.name, name: d.doctor_name };
      await mailer.send({ to: d.email, subject: t('center.mail.account_subject', vars), html: mailer.layout({ locale, title: t('center.mail.account_subject', vars), body: t('center.mail.account_body', vars), cta: t('center.mail.account_cta'), href: link }) });
      emailed = true;
    }
  } catch { /* the link is shown to copy */ }
  return { created: true, practiceId: out.bid, link, emailed, email: d.email };
}

/** The admin's own practice in the centre (same login; they switch between the centre and their clinic). */
async function addOwnPractice(ctx, c, d, locale) {
  const businesses = require('../businesses/business.service'); // eslint-disable-line global-require
  const rbac = require('../rbac/rbac.service'); // eslint-disable-line global-require
  const setup = require('../onboarding/setup.service'); // eslint-disable-line global-require
  const founder = await knex('businesses').where({ id: ctx.businessId }).first('currency', 'timezone', 'country', 'city', 'specialty');
  const name = d.practice_name || (locale === 'en' ? `Dr. ${d.doctor_name.replace(/^(dr\.?|د\.)\s*/i, '')} clinic` : `عيادة ${d.doctor_name}`);
  const bid = await knex.transaction(async (trx) => {
    const id = await businesses.create(ctx.userId, { name, currency: founder.currency, timezone: founder.timezone, country: founder.country, city: founder.city, specialty: founder.specialty }, trx);
    await trx('businesses').where({ id }).update({ center_id: c.id, center_joined_at: new Date(), onboarding_completed_at: new Date(), center_share_cash: true });
    await trx('users').where({ id: ctx.userId }).update({ last_business_id: ctx.businessId }); // still lands on the centre
    await audit.record(ctx, 'center.doctor_added', { entityType: 'center', entityId: c.id, newValues: { doctor: d.doctor_name, email: d.email, practice: id, own: true } }, trx);
    return id;
  });
  const dctx = { businessId: bid, userId: ctx.userId, permissions: await rbac.getUserPermissions(bid, ctx.userId), timezone: founder.timezone, currency: founder.currency, locale };
  await setup.addDoctor(dctx, { full_name: d.doctor_name, specialization: d.specialization || '', consultation_fee: '0', slot_duration_minutes: '30', is_me: '1' }).catch(() => null);
  businesses.forget(bid);
  return { created: true, own: true, practiceId: bid, link: null, emailed: false, email: d.email };
}

// ---------------------------------------------------------------- shared staff
const staffSchema = z.object({
  name: z.string({ required_error: 'Required.' }).trim().min(2, 'Required.').max(160),
  job_title: optionalString(120), phone: optionalString(40),
  salary_monthly: z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(String(v).replace(/,/g, ''))), z.number({ invalid_type_error: 'Enter a number.' }).min(0, 'Must be zero or more.').max(1e7, 'Too large.')),
});
const listStaff = (centerId) => knex('center_staff as s').leftJoin('users as u', 'u.id', 's.user_id').where('s.center_id', centerId).orderBy([{ column: 's.is_active', order: 'desc' }, { column: 's.name' }])
  .select('s.*', 'u.email as login_email');

/** Adds or edits a shared staff member; `login` = an e-mail to give them a reception login in the admin account. */
async function saveStaff(ctx, id, input) {
  const c = await adminCenter(ctx);
  const d = validate(staffSchema, input);
  const row = { name: d.name, job_title: d.job_title || null, phone: d.phone || null, salary_monthly: r3(d.salary_monthly), is_active: input.is_active === undefined ? true : ['1', 'on', true].includes(input.is_active) };
  let sid = Number(id) || null;
  if (sid) {
    const cur = await knex('center_staff').where({ id: sid, center_id: c.id }).first('id');
    if (!cur) throw E.notFound('Staff member');
    await knex('center_staff').where({ id: sid }).update({ ...row, updated_at: new Date() });
  } else [sid] = await knex('center_staff').insert({ ...row, center_id: c.id });
  let login = null;
  const loginEmail = String(input.login_email || '').trim().toLowerCase();
  if (loginEmail) {
    const businesses = require('../businesses/business.service'); // eslint-disable-line global-require
    const rbac = require('../rbac/rbac.service'); // eslint-disable-line global-require
    const role = await rbac.getRoleByKey(ctx.businessId, ['accountant', 'nurse'].includes(input.login_role) ? input.login_role : 'receptionist');
    login = await businesses.addStaff(ctx, { name: d.name, email: loginEmail, phone: d.phone || null, roleId: role && role.id, jobTitle: d.job_title || null, mode: 'password', locale: ctx.locale || 'ar' });
    if (login && login.userId) await knex('center_staff').where({ id: sid }).update({ user_id: login.userId });
  }
  await audit.record(ctx, id ? 'center.staff_updated' : 'center.staff_added', { entityType: 'center_staff', entityId: sid, newValues: { name: d.name, salary: row.salary_monthly, login: Boolean(loginEmail) } });
  return { id: sid, login };
}
async function removeStaff(ctx, id) {
  const c = await adminCenter(ctx);
  const s = await knex('center_staff').where({ id: Number(id) || 0, center_id: c.id }).first();
  if (!s) throw E.notFound('Staff member');
  await knex('center_staff').where({ id: s.id }).update({ is_active: false, updated_at: new Date() });
  await audit.record(ctx, 'center.staff_removed', { entityType: 'center_staff', entityId: s.id, oldValues: { name: s.name } });
}

// ---------------------------------------------------------------- splitting
/** Amounts per practice: equal, by the practices' percentages, or custom amounts. The rounding rest goes to the largest. */
function splitAmounts(amount, practices, mode, custom = {}) {
  const total = r3(amount);
  if (!practices.length) return [];
  let out;
  if (mode === 'custom') out = practices.map((p) => ({ business_id: p.id, amount: r3(custom[p.id]) }));
  else if (mode === 'percent') {
    const sum = practices.reduce((t, p) => t + (Number(p.center_percent) || 0), 0);
    if (Math.abs(sum - 100) > 0.01) throw new AppError('CENTER_PERCENT_100', 'The practices\' percentages must add up to 100.', 422);
    out = practices.map((p) => ({ business_id: p.id, amount: r3((total * (Number(p.center_percent) || 0)) / 100) }));
  } else out = practices.map((p) => ({ business_id: p.id, amount: r3(total / practices.length) }));
  if (mode !== 'custom') {
    const rest = r3(total - out.reduce((t, x) => t + x.amount, 0));
    if (rest) { const top = out.reduce((a, b) => (b.amount >= a.amount ? b : a)); top.amount = r3(top.amount + rest); }
  } else if (Math.abs(out.reduce((t, x) => t + x.amount, 0) - total) > 0.0005) throw new AppError('CENTER_CUSTOM_TOTAL', 'The amounts must add up to the total.', 422);
  return out.filter((x) => x.amount > 0);
}

async function setSplit(ctx, input) {
  const c = await adminCenter(ctx);
  const mode = input.split_mode === 'percent' ? 'percent' : 'equal';
  const members = await centers.members(c.id);
  if (mode === 'percent') {
    let sum = 0;
    for (const m of members) { const v = Math.max(0, Math.min(100, Number(input[`pct_${m.id}`]) || 0)); sum += v; m.pct = Math.round(v * 100) / 100; } // eslint-disable-line no-restricted-syntax
    if (Math.abs(sum - 100) > 0.01) throw new AppError('CENTER_PERCENT_100', 'The practices\' percentages must add up to 100.', 422);
    await knex.transaction(async (trx) => { for (const m of members) await trx('businesses').where({ id: m.id, center_id: c.id }).update({ center_percent: m.pct }); }); // eslint-disable-line no-restricted-syntax, no-await-in-loop
  }
  await knex('centers').where({ id: c.id }).update({ split_mode: mode, updated_at: new Date() });
  await audit.record(ctx, 'center.split_updated', { entityType: 'center', entityId: c.id, newValues: { mode, ...(mode === 'percent' ? Object.fromEntries(members.map((m) => [m.id, m.pct])) : {}) } });
}

// ---------------------------------------------------------------- shared expenses
const expenseSchema = z.object({
  title: z.string({ required_error: 'Required.' }).trim().min(2, 'Required.').max(190),
  amount: z.preprocess((v) => Number(String(v || '').replace(/,/g, '')), z.number({ invalid_type_error: 'Enter a number.' }).positive('Must be more than zero.').max(1e8, 'Too large.')),
  date: z.preprocess((v) => v || undefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.').optional()),
  category: z.preprocess((v) => v || 'miscellaneous', z.string().max(40)),
  split_mode: z.preprocess((v) => (SPLITS.includes(v) ? v : undefined), z.enum(SPLITS).optional()),
  note: optionalString(500),
});

async function addExpense(ctx, input, { period = null } = {}) {
  const c = await adminCenter(ctx);
  const d = validate(expenseSchema, input);
  const members = await knex('businesses').where({ center_id: c.id, status: 'active' }).whereNot('kind', 'center_admin').orderBy('center_joined_at').select('id', 'center_percent');
  const mode = d.split_mode || c.split_mode || 'equal';
  const custom = Object.fromEntries(members.map((m) => [m.id, input[`share_${m.id}`]]));
  const shares = splitAmounts(d.amount, members, mode, custom);
  const date = d.date || clinicNow((await knex('businesses').where({ id: ctx.businessId }).first('timezone')).timezone || 'Asia/Amman').date;
  const id = await knex.transaction(async (trx) => {
    const [eid] = await trx('center_expenses').insert({ center_id: c.id, date, title: d.title, category: d.category, amount: r3(d.amount), split_mode: mode, period, note: d.note || null, created_by: ctx.userId || null });
    if (shares.length) await trx('center_expense_shares').insert(shares.map((s) => ({ expense_id: eid, business_id: s.business_id, amount: s.amount })));
    await audit.record(ctx, 'center.expense_added', { entityType: 'center_expense', entityId: eid, newValues: { title: d.title, amount: r3(d.amount), split: mode, shares: shares.map((s) => `${s.business_id}:${s.amount}`).join(',') } }, trx);
    return eid;
  });
  // Each practice's managers are told what they owe.
  const notifications = require('../notifications/notification.service'); // eslint-disable-line global-require
  for (const s of shares) await notifications.notify(s.business_id, { permission: 'expenses.manage', type: 'center.share', title: `حصة من مصروف المركز · Centre cost share — ${d.title}`, body: `${s.amount}`, link: '/app/center/costs', dedupeKey: `cshare:${id}:${s.business_id}` }).catch(() => {}); // eslint-disable-line no-await-in-loop
  return id;
}

async function removeExpense(ctx, id) {
  const c = await adminCenter(ctx);
  const e = await knex('center_expenses').where({ id: Number(id) || 0, center_id: c.id }).first();
  if (!e) throw E.notFound('Expense');
  const paid = await knex('center_expense_shares').where({ expense_id: e.id }).whereNotNull('paid_at').first('id');
  if (paid) throw new AppError('CENTER_SHARE_PAID', 'A practice already paid its share of this expense.', 409);
  await knex('center_expenses').where({ id: e.id }).del();
  await audit.record(ctx, 'center.expense_removed', { entityType: 'center_expense', entityId: e.id, oldValues: { title: e.title, amount: Number(e.amount) } });
}

/** The month's salaries of the active shared staff as one shared expense (once per month). */
async function postSalaries(ctx, month, { t = null } = {}) {
  const c = await adminCenter(ctx);
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw E.validation({ month: 'Enter a valid month.' });
  if (await knex('center_expenses').where({ center_id: c.id, period: month }).first('id')) throw new AppError('CENTER_SALARIES_DONE', 'This month\'s shared salaries are already recorded.', 409);
  const staff = await knex('center_staff').where({ center_id: c.id, is_active: true }).where('salary_monthly', '>', 0).select('name', 'salary_monthly');
  const total = r3(staff.reduce((t, s) => t + Number(s.salary_monthly), 0));
  if (!(total > 0)) throw new AppError('CENTER_NO_SALARIES', 'No shared staff with a salary.', 422);
  return addExpense(ctx, { title: t ? t('center.salaries_expense', { month }) : `رواتب الموظفين المشتركين ${month}`, amount: total, date: `${month}-01`, category: 'staff_salaries', note: staff.map((s) => `${s.name}: ${Number(s.salary_monthly)}`).join(' · ') }, { period: month });
}

/** Admin view: the shared expenses with each practice's share and whether it is paid. */
async function expenses(centerId, { limit = 100 } = {}) {
  const rows = await knex('center_expenses').where({ center_id: centerId }).orderBy([{ column: 'date', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit);
  const shares = rows.length ? await knex('center_expense_shares').whereIn('expense_id', rows.map((r) => r.id)).select('expense_id', 'business_id', 'amount', 'paid_at') : [];
  rows.forEach((r) => { r.shares = shares.filter((s) => s.expense_id === r.id); });
  return rows;
}
/** Owed / paid per practice (admin summary). */
async function balances(centerId) {
  return knex('center_expense_shares as s').join('center_expenses as e', 'e.id', 's.expense_id').where('e.center_id', centerId)
    .groupBy('s.business_id').select('s.business_id')
    .select(knex.raw('COALESCE(SUM(CASE WHEN s.paid_at IS NULL THEN s.amount ELSE 0 END), 0) as owed'), knex.raw('COALESCE(SUM(CASE WHEN s.paid_at IS NOT NULL THEN s.amount ELSE 0 END), 0) as paid'));
}

// ---------------------------------------------------------------- a practice's own side
/** What this practice owes (and has paid) — only its own shares. */
async function myShares(ctx) {
  return knex('center_expense_shares as s').join('center_expenses as e', 'e.id', 's.expense_id').where('s.business_id', ctx.businessId)
    .orderBy([{ column: 'e.date', order: 'desc' }, { column: 's.id', order: 'desc' }]).limit(200)
    .select('s.id', 's.amount', 's.paid_at', 's.practice_expense_id', 'e.title', 'e.date', 'e.category', 'e.amount as total', 'e.split_mode', 'e.note');
}

/** Pays one share: recorded as an expense of this practice ("Medical centre share"), once. */
async function payShare(ctx, shareId, input = {}) {
  const s = await knex('center_expense_shares as s').join('center_expenses as e', 'e.id', 's.expense_id').where({ 's.id': Number(shareId) || 0, 's.business_id': ctx.businessId })
    .first('s.*', 'e.title', 'e.date', 'e.category');
  if (!s) throw E.notFound('Share');
  if (s.paid_at) throw new AppError('CENTER_SHARE_PAID', 'This share is already paid.', 409);
  const method = ['cash', 'bank_transfer', 'card', 'digital_wallet'].includes(input.payment_method) ? input.payment_method : 'cash';
  const today = clinicNow(ctx.timezone || 'Asia/Amman').date;
  await knex.transaction(async (trx) => {
    const won = await trx('center_expense_shares').where({ id: s.id }).whereNull('paid_at').update({ paid_at: new Date(), paid_by: ctx.userId || null });
    if (!won) throw new AppError('CENTER_SHARE_PAID', 'This share is already paid.', 409);
    const [eid] = await trx('expenses').insert({
      business_id: ctx.businessId, date: today, category: 'center_share', title: `${s.title}`.slice(0, 255), amount: r3(s.amount), payment_method: method,
      recorded_by: ctx.userName || null, recorded_by_user_id: ctx.userId || null, notes: `center_share:${s.id}`,
    });
    await trx('center_expense_shares').where({ id: s.id }).update({ practice_expense_id: eid });
    await audit.record(ctx, 'center.share_paid', { entityType: 'center_share', entityId: s.id, newValues: { amount: r3(s.amount), expense: eid, method } }, trx);
  });
}

module.exports = { SPLITS, adminCenter, addDoctor, listStaff, saveStaff, removeStaff, splitAmounts, setSplit, addExpense, removeExpense, postSalaries, expenses, balances, myShares, payShare };
