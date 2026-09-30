// AI finance & management assistant for clinic owners, managers and accountants.
//
//  • Reuses the clinical assistant's platform settings (switch, API key, model, monthly cap, per-user hourly limit),
//    its SDK client factory, error mapping and response parser (./ai.service). Every request is logged in
//    ai_requests (kind fin_analysis | fin_chat) so it counts toward the same monthly cap and hourly limit.
//  • Clinic opt-in: ai_finance_settings (off by default, acknowledgement, allowed roles; finance.view required).
//  • Monthly analysis: aggregated figures of OUR tables (invoices, expenses, payroll, appointments) — never patient
//    names, phones or ids — sent with a json_schema output format; the result is saved in ai_finance_runs.
//  • Chat: manual agentic loop (tool_use → tool_result, max 6 iterations) with strict tools. Read tools answer from
//    the database; write tools (add_expense, add_supplier) only create a PENDING action. The action runs when the
//    user presses Confirm: permission re-checked at that moment, validated by the normal services, audited.
//
// The SDK client is injectable (`{ client }`) so tests use a fake object with beta.messages.create.
const { z } = require('zod');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { translator } = require('../../core/i18n');
const { AppError, E } = require('../../core/errors');
const lib = require('../clinic/records.lib');
const payParts = require('../clinic/payment-parts');
const expenseSvc = require('../expenses/expense.service');
const supplies = require('../clinic/supplies.service');
const ai = require('./ai.service');

const DEFAULT_ROLES = ['owner', 'clinic_manager', 'accountant'];
const KIND_ANALYSIS = 'fin_analysis';
const KIND_CHAT = 'fin_chat';
const MAX_ITERATIONS = 6;
const HISTORY_MESSAGES = 20;     // last 10 turns are resent to the model
const MAX_MESSAGE = 2000;
const MAX_ACTIONS_PER_TURN = 3;
const ACTION_TTL_HOURS = 24;
const BUSY_SECONDS = 90;         // one request at a time per user
const ACTION_PERMS = { add_expense: 'expenses.manage', add_supplier: 'supplies.manage' };

const fail = (code, status, message) => new AppError(code, message || code, status);
const num = (v) => Number(v) || 0;
const round2 = (v) => Math.round(num(v) * 100) / 100;
const pct = (a, b) => (b ? Math.round((a * 1000) / b) / 10 : null);
const change = (cur, prev) => (prev ? Math.round(((cur - prev) * 1000) / Math.abs(prev)) / 10 : null);
const isMonth = (m) => lib.MONTH.test(String(m || ''));

// ---------------------------------------------------------------- clinic settings
const parseJson = (v, dflt) => { try { const r = typeof v === 'string' ? JSON.parse(v) : v; return r ?? dflt; } catch { return dflt; } };

async function settings(businessId) {
  const row = await knex('ai_finance_settings').where({ business_id: businessId }).first();
  const roles = row ? parseJson(row.allowed_roles, null) : null;
  return {
    enabled: Boolean(row && row.enabled),
    allowed_roles: Array.isArray(roles) && roles.length ? roles.map(String) : DEFAULT_ROLES.slice(),
    acknowledged_at: row ? row.acknowledged_at : null,
    acknowledged_by: row ? row.acknowledged_by : null,
    exists: Boolean(row),
  };
}

/** Saves the clinic opt-in. `roles` = the clinic's roles holding finance.view ({ key }). */
async function saveSettings(ctx, body, roles) {
  const cur = await settings(ctx.businessId);
  const on = body.fin_enabled === '1';
  const ack = body.fin_acknowledge === '1';
  const valid = new Set(roles.map((r) => r.key));
  const picked = [].concat(body.fin_roles || []).map(String).filter((k) => valid.has(k));
  const errors = {};
  const needsAck = on && (!cur.enabled || !cur.acknowledged_at);
  if (needsAck && !ack) errors.fin_acknowledge = 'Confirm that you have read the data-processing notice.';
  if (on && !picked.length) errors.fin_roles = 'Choose at least one role.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const allowed = picked.length ? picked : cur.allowed_roles;
  const patch = {
    enabled: on, allowed_roles: JSON.stringify(allowed), updated_at: new Date(),
    ...(needsAck ? { acknowledged_at: new Date(), acknowledged_by: ctx.userId } : {}),
  };
  if (cur.exists) await knex('ai_finance_settings').where({ business_id: ctx.businessId }).update(patch);
  else await knex('ai_finance_settings').insert({ business_id: ctx.businessId, ...patch });
  await audit.record(ctx, 'aifin.settings_updated', {
    entityType: 'ai_finance_settings', entityId: ctx.businessId,
    oldValues: { enabled: cur.enabled, allowed_roles: cur.allowed_roles.join(',') },
    newValues: { enabled: on, allowed_roles: allowed.join(','), ...(needsAck ? { acknowledged: true } : {}) },
  });
}

// ---------------------------------------------------------------- access & limits
/** Pure: null when the user may use the finance assistant, else an error code. */
function accessCheck({ platform, fin, roleKey, permissions }) {
  if (!platform || !platform.enabled) return 'AI_PLATFORM_OFF';
  if (!platform.hasKey) return 'AI_NOT_CONFIGURED';
  if (!fin || !fin.enabled) return 'AIFIN_CLINIC_OFF';
  if (!permissions || !permissions.has('finance.view')) return 'AIFIN_NO_PERMISSION';
  if (!roleKey || !(fin.allowed_roles || []).includes(roleKey)) return 'AI_ROLE_NOT_ALLOWED';
  return null;
}

async function access(ctx) {
  const [platform, fin] = await Promise.all([ai.platformSettings(), settings(ctx.businessId)]);
  return { platform, fin, code: accessCheck({ platform, fin, roleKey: ctx.roleKey, permissions: ctx.permissions }) };
}

const HTTP = {
  AI_PLATFORM_OFF: 403, AI_NOT_CONFIGURED: 403, AIFIN_CLINIC_OFF: 403, AIFIN_NO_PERMISSION: 403, AI_ROLE_NOT_ALLOWED: 403,
  AI_MONTHLY_CAP: 429, AI_HOURLY_LIMIT: 429, AIFIN_BUSY: 429, AI_REFUSED: 422, AI_TRUNCATED: 422, AIFIN_EMPTY_MESSAGE: 422,
  AIFIN_MESSAGE_TOO_LONG: 422, AIFIN_BAD_MONTH: 422, AIFIN_ACTION_GONE: 409, AIFIN_ACTION_EXPIRED: 409, AI_BAD_OUTPUT: 502,
};
const httpFor = (code) => HTTP[code] || ai.httpFor(code);

/** Throws when the user may not send a request now (monthly cap, hourly limit, a request already running). */
async function checkLimits(ctx, platform, kind) {
  const cnt = await ai.counts(ctx);
  let code = ai.limitCheck({ ...cnt, cap: platform.monthly_cap, hourly: platform.hourly_limit });
  if (!code) {
    const since = new Date(Date.now() - BUSY_SECONDS * 1000);
    const busy = await knex('ai_requests').where({ business_id: ctx.businessId, user_id: ctx.userId, status: 'pending' })
      .whereIn('kind', [KIND_ANALYSIS, KIND_CHAT]).where('created_at', '>=', since).first('id');
    if (busy) code = 'AIFIN_BUSY';
  }
  if (code) {
    await audit.record(ctx, 'aifin.request_blocked', { entityType: 'ai_finance', entityId: ctx.businessId, newValues: { kind, reason: code } });
    throw fail(code, httpFor(code));
  }
}

async function startRequest(ctx, platform, kind, locale) {
  const [id] = await knex('ai_requests').insert({ business_id: ctx.businessId, user_id: ctx.userId, appointment_id: null, kind, model: platform.model, locale, status: 'pending' });
  return id;
}

/** Closes the ai_requests row and audits kind / status / tokens only (never financial text). */
async function finishRequest(ctx, id, kind, platform, patch, extra = {}) {
  await knex('ai_requests').where({ id }).update(patch);
  await audit.record(ctx, 'aifin.request', {
    entityType: 'ai_finance', entityId: id,
    newValues: {
      kind, status: patch.status, model: patch.model || platform.model, input_tokens: patch.input_tokens || 0, output_tokens: patch.output_tokens || 0,
      error_code: patch.error_code || null, ...extra,
    },
  });
}

// ---------------------------------------------------------------- figures (read-only, no patient data)
const DOCTOR_SCOPE = (ctx, q, col) => { if (ctx.ownDoctorId) q.where(col, ctx.ownDoctorId); return q; };
const invBase = (ctx, from, to) => DOCTOR_SCOPE(ctx, lib.whereLocalDates(knex('invoices as i').where('i.business_id', ctx.businessId), 'i.created_at', from, to, ctx.timezone), 'i.doctor_id');
const apptBase = (ctx, from, to) => DOCTOR_SCOPE(ctx, knex('appointments as a').where('a.business_id', ctx.businessId).whereNot('a.appointment_type', 'blocked')
  .whereBetween('a.appointment_date', [from, to]), 'a.doctor_id');

const STAFF_TABLES = ['staff_payroll_lines', 'staff_salary_payments', 'staff_payroll_payments', 'staff_payments', 'staff_payroll', 'staff_salaries'];
/** Staff (non-doctor) salaries paid in the range when the finance module's table exists, else null. */
async function staffSalaries(ctx, from, to) {
  for (const table of STAFF_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await knex.schema.hasTable(table))) continue;
    // eslint-disable-next-line no-await-in-loop
    const cols = Object.keys(await knex(table).columnInfo());
    const amount = ['net_pay', 'net_amount', 'net', 'amount', 'total', 'salary'].find((c) => cols.includes(c));
    if (!amount || !cols.includes('business_id')) continue;
    const q = knex(table).where({ business_id: ctx.businessId });
    if (cols.includes('period')) q.whereBetween('period', [from.slice(0, 7), to.slice(0, 7)]);
    else {
      const dateCol = ['paid_on', 'payment_date', 'date', 'paid_at', 'created_at'].find((c) => cols.includes(c));
      if (!dateCol) continue;
      if (['paid_at', 'created_at'].includes(dateCol)) lib.whereLocalDates(q, dateCol, from, to, ctx.timezone);
      else q.whereBetween(dateCol, [from, to]);
    }
    if (cols.includes('status')) q.whereNotIn('status', ['cancelled', 'void', 'draft', 'pending']);
    // eslint-disable-next-line no-await-in-loop
    const row = await q.first(knex.raw(`COALESCE(SUM(??),0) as v`, [amount]), knex.raw('COUNT(*) as n'));
    return { total: round2(row.v), count: num(row.n) };
  }
  return null;
}

/** Category key → label in the given locale (custom categories use their own name). */
async function categoryLabeler(businessId, locale) {
  const { custom } = await expenseSvc.categories(businessId);
  const t = translator(locale === 'en' ? 'en' : 'ar');
  const map = Object.fromEntries(custom.map((c) => [c.key, c.name]));
  return (key) => { if (map[key]) return map[key]; const s = t(`categories.${key}`); return s === `categories.${key}` ? key : s; };
}

/** Raw aggregates of a date range from the database. */
async function periodData(ctx, from, to, locale = 'ar') {
  const hasPayments = await knex.schema.hasTable('payments');
  const [methodRows, discount, docRev, docAppts, doctors, statusRows, sourceRows, expRows, payroll, staff, refunds, catLabel] = await Promise.all([
    // By payment method from the payment parts (a cash + card invoice counts under both; never "mixed").
    payParts.totalsByMethod(invBase(ctx, from, to), 'i.id', ctx.businessId),
    invBase(ctx, from, to).first(knex.raw('COALESCE(SUM(i.discount_amount),0) as total'), knex.raw('SUM(CASE WHEN i.discount_amount > 0 THEN 1 ELSE 0 END) as n'),
      knex.raw('COALESCE(AVG(CASE WHEN i.discount_percent > 0 THEN i.discount_percent END),0) as avg_pct')),
    invBase(ctx, from, to).groupBy('i.doctor_id').select('i.doctor_id', knex.raw('MAX(i.doctor_name) as doctor_name')).sum({ v: 'i.amount' }).count({ n: '*' }),
    apptBase(ctx, from, to).groupBy('a.doctor_id').select('a.doctor_id').count({ n: '*' })
      .select(knex.raw("SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as done"), knex.raw("SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) as no_show"),
        knex.raw("SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled")),
    knex('doctors').where({ business_id: ctx.businessId }).select('id', 'full_name', 'full_name_en'),
    apptBase(ctx, from, to).groupBy('a.status').select('a.status').count({ n: '*' }),
    apptBase(ctx, from, to).groupBy('a.source').select('a.source').count({ n: '*' }),
    knex('expenses').where({ business_id: ctx.businessId }).whereBetween('date', [from, to]).groupBy('category').select('category').sum({ v: 'amount' }).count({ n: '*' }),
    DOCTOR_SCOPE(ctx, knex('payroll_payments').where({ business_id: ctx.businessId }).whereBetween('period', [from.slice(0, 7), to.slice(0, 7)]), 'doctor_id')
      .first(knex.raw('COALESCE(SUM(net_pay),0) as v'), knex.raw('COUNT(*) as n')),
    staffSalaries(ctx, from, to),
    hasPayments
      ? lib.whereLocalDates(knex('payments').where({ business_id: ctx.businessId, status: 'refunded' }), 'refunded_at', from, to, ctx.timezone)
        .first(knex.raw('COALESCE(SUM(refunded_amount),0) as v'), knex.raw('COUNT(*) as n'))
      : null,
    categoryLabeler(ctx.businessId, locale),
  ]);
  const en = locale === 'en';
  const docName = Object.fromEntries(doctors.map((d) => [d.id, (en && d.full_name_en) || d.full_name]));
  return {
    from, to, currency: ctx.currency, en,
    methodRows: methodRows.rows.map((r) => ({ payment_method: r.method, v: r.amount, n: r.invoices })), invoiceCount: methodRows.count, discount, docRev, docAppts, docName, statusRows, sourceRows, payroll, staff, refunds,
    expRows: expRows.map((r) => ({ ...r, label: catLabel(r.category) })),
  };
}

const STATUSES = ['pending', 'confirmed', 'completed', 'no_show', 'cancelled'];

/**
 * Pure: turns raw aggregates into the compact figures sent to the model and shown on the page.
 * Contains amounts, counts, payment methods, expense categories and doctor names — no patient data.
 */
function composeFigures(d) {
  const byMethod = d.methodRows.map((r) => ({ method: r.payment_method, amount: round2(r.v), invoices: num(r.n) })).sort((a, b) => b.amount - a.amount);
  const revenue = round2(byMethod.reduce((s, r) => s + r.amount, 0));
  // An invoice paid in two ways appears under both methods: count invoices once when the total is known.
  const invoices = d.invoiceCount !== undefined ? num(d.invoiceCount) : byMethod.reduce((s, r) => s + r.invoices, 0);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  (d.statusRows || []).forEach((r) => { byStatus[r.status] = num(r.n); });
  const apptTotal = Object.values(byStatus).reduce((s, v) => s + v, 0);
  const attended = byStatus.completed + byStatus.no_show;
  const bySource = {};
  (d.sourceRows || []).forEach((r) => { bySource[r.source || 'staff'] = num(r.n); });

  const docs = new Map();
  const drow = (id, name) => {
    const k = id || 0;
    if (!docs.has(k)) docs.set(k, { doctor: (id && d.docName[id]) || name || (d.en ? 'No doctor' : 'بدون طبيب'), revenue: 0, invoices: 0, appointments: 0, completed: 0, no_show: 0, cancelled: 0 });
    return docs.get(k);
  };
  (d.docRev || []).forEach((r) => { const x = drow(r.doctor_id, r.doctor_name); x.revenue = round2(r.v); x.invoices = num(r.n); });
  (d.docAppts || []).forEach((r) => { const x = drow(r.doctor_id); x.appointments = num(r.n); x.completed = num(r.done); x.no_show = num(r.no_show); x.cancelled = num(r.cancelled); });
  const byDoctor = [...docs.values()].sort((a, b) => b.revenue - a.revenue || b.appointments - a.appointments);

  const byCategory = (d.expRows || []).map((r) => ({ category: r.label || r.category, amount: round2(r.v), count: num(r.n) })).sort((a, b) => b.amount - a.amount);
  const expenses = round2(byCategory.reduce((s, r) => s + r.amount, 0));
  const payroll = round2(d.payroll && d.payroll.v);
  const staff = d.staff ? round2(d.staff.total) : 0;
  const refunds = d.refunds ? round2(d.refunds.v) : 0;
  const net = round2(revenue - refunds - expenses - payroll - staff);
  return {
    period: { from: d.from, to: d.to },
    currency: d.currency,
    revenue: {
      total: revenue, invoices, average_invoice: invoices ? round2(revenue / invoices) : 0, by_method: byMethod,
      discounts: { total: round2(d.discount && d.discount.total), invoices_with_discount: num(d.discount && d.discount.n), average_percent: round2(d.discount && d.discount.avg_pct) },
      online_refunds: refunds,
    },
    expenses: { total: expenses, entries: byCategory.reduce((s, r) => s + r.count, 0), by_category: byCategory },
    doctor_payroll_paid: { total: payroll, payments: num(d.payroll && d.payroll.n) },
    staff_salaries_paid: d.staff ? { total: staff, payments: d.staff.count } : 'not tracked separately',
    net_result: net,
    margin_percent: revenue ? Math.round((net * 1000) / revenue) / 10 : null,
    appointments: {
      total: apptTotal, by_status: byStatus, by_source: bySource,
      no_show_rate_percent: pct(byStatus.no_show, attended), cancellation_rate_percent: pct(byStatus.cancelled, apptTotal),
    },
    by_doctor: byDoctor,
  };
}

/** Figures for a month and the month before, plus the changes between them. */
async function monthlyFigures(ctx, month, locale) {
  if (!isMonth(month)) throw fail('AIFIN_BAD_MONTH', 422);
  const cur = lib.monthBounds(month);
  const prevMonth = lib.addMonths(month, -1);
  const prev = lib.monthBounds(prevMonth);
  const [a, b] = await Promise.all([periodData(ctx, cur.from, cur.to, locale), periodData(ctx, prev.from, prev.to, locale)]);
  const current = composeFigures(a);
  const previous = composeFigures(b);
  return {
    month, previous_month: prevMonth, current, previous,
    changes_percent: {
      revenue: change(current.revenue.total, previous.revenue.total),
      expenses: change(current.expenses.total, previous.expenses.total),
      net_result: change(current.net_result, previous.net_result),
      appointments: change(current.appointments.total, previous.appointments.total),
    },
    partial_month: ctx.today && ctx.today.slice(0, 7) === month ? { days_elapsed: Number(ctx.today.slice(8, 10)), days_in_month: Number(cur.to.slice(8, 10)) } : null,
  };
}

/** The figures as sent to the model (previous month trimmed to totals). */
function analysisInput(f) {
  const p = f.previous;
  return {
    month: f.month,
    currency: f.current.currency,
    partial_month: f.partial_month,
    current: f.current,
    previous_month: {
      month: f.previous_month, revenue: p.revenue.total, invoices: p.revenue.invoices, discounts: p.revenue.discounts.total, expenses: p.expenses.total,
      expenses_by_category: p.expenses.by_category.slice(0, 8), doctor_payroll_paid: p.doctor_payroll_paid.total, net_result: p.net_result,
      appointments: p.appointments.total, no_show_rate_percent: p.appointments.no_show_rate_percent,
    },
    changes_percent: f.changes_percent,
  };
}

// ---------------------------------------------------------------- prompts & schemas
const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const ANALYSIS_SCHEMA = obj({ summary: str, strengths: strArr, warnings: strArr, action_steps: strArr, metrics_notes: str });

const langLine = (locale) => (locale === 'en'
  ? 'Write in clear, plain English.'
  : 'Write in clear Modern Standard Arabic suitable for clinic management; keep numbers in Western digits.');

function analysisSystem(locale) {
  return [
    'You are the finance and management advisor inside DocBook, a clinic management system. You help the owner, manager or accountant of a medical clinic understand one month of results.',
    'You receive aggregated figures only (revenue by payment method and by doctor, discounts, expenses by category, doctor payroll, staff salaries when tracked, appointment counts, no-show and cancellation rates, booking sources) and the previous month for comparison. There is no patient information.',
    'Base every statement on the figures given. Do not invent numbers, benchmarks or causes that are not supported by the data; when something cannot be concluded, say what is missing. If partial_month is set, the month is still in progress — compare pace, not totals.',
    '"summary": 3-5 sentences on the month. "strengths" and "warnings": short, specific points with the figures that support them (0-5 each). "action_steps": 3-6 concrete, practical steps for the clinic, most important first. "metrics_notes": caveats about the data (e.g. unrecorded expenses, partial month, payroll not yet paid).',
    'This is management guidance, not accounting, tax, legal or investment advice.',
    langLine(locale),
  ].join('\n');
}

function analysisParams({ model, locale, input }) {
  return {
    model: model || ai.DEFAULT_MODEL,
    max_tokens: 8000,
    system: analysisSystem(locale),
    messages: [{ role: 'user', content: `Clinic figures (JSON, amounts in ${input.currency}):\n\n${JSON.stringify(input)}` }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } },
    betas: [ai.FALLBACK_BETA],
    fallbacks: 'default',
  };
}

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

/** Tool definitions (strict). The expense categories are the clinic's own keys. */
function toolDefs(categoryKeys) {
  const month = { type: 'string', description: 'Month as YYYY-MM.' };
  return [
    {
      name: 'get_period_summary',
      description: 'Aggregated figures for a date range: revenue by payment method and doctor, discounts, refunds, expenses by category, payroll, net result, appointment counts and rates. Call this whenever the user asks about results for a period other than what you already have, or to compare periods.',
      strict: true,
      input_schema: obj({ from: { type: 'string', format: 'date', description: 'First day (YYYY-MM-DD).' }, to: { type: 'string', format: 'date', description: 'Last day (YYYY-MM-DD), at most 366 days after from.' } }),
    },
    {
      name: 'list_top_expenses',
      description: 'The largest individual expense entries of a month (date, category, description, amount, payment method). Call this when the user asks what the money was spent on or which expenses were biggest.',
      strict: true,
      input_schema: obj({ month }),
    },
    {
      name: 'doctor_revenue',
      description: 'Per-doctor figures for a month: revenue, invoices, average invoice, appointments, completed visits, no-shows, cancellations and payroll paid. Call this for questions about doctors\' performance or payroll.',
      strict: true,
      input_schema: obj({ month }),
    },
    {
      name: 'no_show_stats',
      description: 'Attendance for a month: appointments by status, no-show and cancellation rates overall, by doctor, by weekday and by booking source (staff or website). Call this for questions about no-shows, cancellations or bookings.',
      strict: true,
      input_schema: obj({ month }),
    },
    {
      name: 'add_expense',
      description: 'Proposes a new expense entry. It is NOT saved: the user sees a confirmation card and must press Confirm. Call it only when the user clearly asks to record an expense and you know the amount and what it was for; ask for missing details instead of guessing.',
      strict: true,
      input_schema: obj({
        date: { type: 'string', format: 'date', description: 'Expense date (YYYY-MM-DD). Use today when the user does not say.' },
        category: { type: 'string', enum: categoryKeys, description: 'Expense category key (see the list in the instructions).' },
        amount: { type: 'number', description: 'Amount in the clinic currency, greater than zero.' },
        description: { type: 'string', description: 'Short description of the expense.' },
        method: { type: 'string', enum: expenseSvc.PAYMENT_METHODS, description: 'Payment method; cash when the user does not say.' },
      }),
    },
    {
      name: 'add_supplier',
      description: 'Proposes a new supplier. It is NOT saved: the user sees a confirmation card and must press Confirm. Call it only when the user clearly asks to add a supplier.',
      strict: true,
      input_schema: obj({
        name: { type: 'string', description: 'Supplier name.' },
        phone: nullable({ type: 'string', description: 'Phone number, or null.' }),
        email: nullable({ type: 'string', description: 'E-mail address, or null.' }),
      }),
    },
  ];
}

function chatSystem({ locale, today, currency, categories }) {
  return [
    'You are the finance and management assistant inside DocBook, a clinic management system. You talk with the clinic\'s owner, manager or accountant.',
    `Today is ${today} (clinic time). The clinic currency is ${currency}.`,
    'Answer questions about the clinic\'s revenue, expenses, payroll, discounts, doctors\' performance, appointments and no-shows. Use the read tools to get figures; never invent numbers. Patient information is not available to you and must not be requested.',
    'You can PROPOSE two actions: add_expense and add_supplier. Proposing never saves anything — the user reviews a confirmation card and presses Confirm or Cancel. After proposing, tell the user briefly what you prepared and that it will be saved only after they confirm. Never say an action was saved unless a later message says it was confirmed.',
    'Only propose an action when the user clearly asks for it. Ask for missing essentials (such as the amount) instead of guessing. Propose at most three actions per message.',
    `Expense category keys: ${categories.map((c) => `${c.key} = ${c.label}`).join('; ')}.`,
    'Keep answers short and practical (a few sentences or a short list). Plain text only — no Markdown tables or headings. This is management guidance, not accounting, tax, legal or investment advice.',
    langLine(locale),
  ].join('\n');
}

function chatParams({ model, locale, system, tools }) {
  return {
    model: model || ai.DEFAULT_MODEL,
    max_tokens: 8000,
    system,
    tools,
    output_config: { effort: 'low' },
    betas: [ai.FALLBACK_BETA],
    fallbacks: 'default',
  };
}

// ---------------------------------------------------------------- the tool loop
const textOf = (content) => (content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();

/**
 * Manual agentic loop. Appends the full response.content before tool results, runs every tool_use of a turn and
 * sends all results back in one user message. Stops on end_turn, refusal, max_tokens or after `maxIterations` calls.
 * @param {object} o { client, params, messages (mutated), execute(name, input) → { content, isError }, maxIterations }
 * @returns {Promise<{ status: 'ok'|'refused'|'truncated'|'loop_limit', text, usage, model, iterations, tools, fallback }>}
 */
async function toolLoop({ client, params, messages, execute, maxIterations = MAX_ITERATIONS }) {
  const usage = { input: 0, output: 0 };
  const tools = [];
  let model = null; let fallback = false; let lastText = '';
  for (let i = 1; i <= maxIterations; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await client.beta.messages.create({ ...params, messages });
    const u = (resp && resp.usage) || {};
    usage.input += num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    usage.output += num(u.output_tokens);
    model = (resp && resp.model) || model;
    const content = (resp && resp.content) || [];
    if (content.some((b) => b && b.type === 'fallback') || (u.iterations || []).some((x) => x && x.type === 'fallback_message')) fallback = true;
    const text = textOf(content);
    if (text) lastText = text;
    const base = { usage, model, iterations: i, tools, fallback };
    if (!resp || resp.stop_reason === 'refusal') return { ...base, status: 'refused', text: '', refusal: { category: (resp && resp.stop_details && resp.stop_details.category) || null } };
    const toolUses = content.filter((b) => b && b.type === 'tool_use');
    // A tool input cut off at max_tokens may parse as a valid partial object — never run it.
    if (resp.stop_reason === 'max_tokens') return { ...base, status: 'truncated', text: toolUses.length ? '' : text };
    if (resp.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content }); continue; } // eslint-disable-line no-continue
    if (resp.stop_reason === 'tool_use' && toolUses.length) {
      messages.push({ role: 'assistant', content });
      const results = [];
      for (const tu of toolUses) {
        tools.push(tu.name);
        let r;
        try {
          // eslint-disable-next-line no-await-in-loop
          r = await execute(tu.name, tu.input || {});
        } catch (err) {
          r = { isError: true, content: { error: err && err.code ? err.code : 'TOOL_FAILED' } };
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content), ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
      continue; // eslint-disable-line no-continue
    }
    return { ...base, status: 'ok', text };
  }
  return { usage, model, iterations: maxIterations, tools, fallback, status: 'loop_limit', text: lastText };
}

// ---------------------------------------------------------------- tool implementations
const monthInput = z.object({ month: z.string().regex(lib.MONTH) });
const rangeInput = z.object({ from: z.string().refine(lib.isIso), to: z.string().refine(lib.isIso) });
const expenseInput = (keys) => z.object({
  date: z.string().refine(lib.isIso, 'Enter a valid date.'),
  category: z.string().refine((v) => keys.includes(v), 'Choose a valid value.'),
  amount: z.number().finite().positive('Must be more than zero.').max(1e9, 'Too large.'),
  description: z.string().trim().min(1, 'Required.').max(255),
  method: z.enum(expenseSvc.PAYMENT_METHODS),
});
const supplierInput = z.object({
  name: z.string().trim().min(1, 'Required.').max(190),
  phone: z.string().trim().max(40).nullable(),
  email: z.string().trim().max(190).nullable(),
});
const invalid = (issues) => ({ isError: true, content: { error: 'INVALID_INPUT', issues: issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`) } });

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

async function topExpenses(ctx, month) {
  const { from, to } = lib.monthBounds(month);
  const label = await categoryLabeler(ctx.businessId, ctx.locale);
  const rows = await knex('expenses').where({ business_id: ctx.businessId }).whereBetween('date', [from, to]).orderBy('amount', 'desc').limit(10)
    .select('date', 'category', 'title', 'amount', 'payment_method');
  return rows.map((r) => ({ date: r.date, category: label(r.category), description: ai.scrubText(r.title), amount: round2(r.amount), method: r.payment_method }));
}

async function doctorRevenue(ctx, month) {
  const { from, to } = lib.monthBounds(month);
  const [d, pay] = await Promise.all([
    periodData(ctx, from, to, ctx.locale),
    DOCTOR_SCOPE(ctx, knex('payroll_payments').where({ business_id: ctx.businessId, period: month }), 'doctor_id').select('doctor_id', 'net_pay'),
  ]);
  const f = composeFigures(d);
  const paid = Object.fromEntries(pay.map((p) => [d.docName[p.doctor_id], round2(p.net_pay)]));
  return f.by_doctor.map((x) => ({ ...x, average_invoice: x.invoices ? round2(x.revenue / x.invoices) : 0, payroll_paid: paid[x.doctor] ?? null }));
}

async function noShowStats(ctx, month) {
  const { from, to } = lib.monthBounds(month);
  const [d, days] = await Promise.all([
    periodData(ctx, from, to, ctx.locale),
    apptBase(ctx, from, to).groupBy('a.appointment_date').select('a.appointment_date as d').count({ n: '*' })
      .select(knex.raw("SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) as no_show"), knex.raw("SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as done")),
  ]);
  const f = composeFigures(d);
  const byDay = Object.fromEntries(WEEKDAYS.map((k) => [k, { appointments: 0, no_show: 0, completed: 0 }]));
  days.forEach((r) => { const k = WEEKDAYS[new Date(`${String(r.d).slice(0, 10)}T00:00:00Z`).getUTCDay()]; byDay[k].appointments += num(r.n); byDay[k].no_show += num(r.no_show); byDay[k].completed += num(r.done); });
  const sources = await apptBase(ctx, from, to).groupBy('a.source').select('a.source').count({ n: '*' })
    .select(knex.raw("SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) as no_show"), knex.raw("SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as done"));
  return {
    month, ...f.appointments,
    by_doctor: f.by_doctor.filter((x) => x.appointments).map((x) => ({ doctor: x.doctor, appointments: x.appointments, no_show: x.no_show, cancelled: x.cancelled, no_show_rate_percent: pct(x.no_show, x.completed + x.no_show) })),
    by_weekday: Object.entries(byDay).filter(([, v]) => v.appointments).map(([k, v]) => ({ weekday: k, ...v, no_show_rate_percent: pct(v.no_show, v.completed + v.no_show) })),
    by_source: sources.map((s) => ({ source: s.source, appointments: num(s.n), no_show: num(s.no_show), no_show_rate_percent: pct(num(s.no_show), num(s.done) + num(s.no_show)) })),
  };
}

/** Creates a pending action (never executes it). */
async function proposeAction(ctx, kind, payload) {
  const [id] = await knex('ai_finance_actions').insert({ business_id: ctx.businessId, user_id: ctx.userId, kind, payload: JSON.stringify(payload), status: 'pending' });
  await audit.record(ctx, 'aifin.action_proposed', { entityType: 'ai_finance_action', entityId: id, newValues: { kind } });
  return id;
}

/** Executor for one chat turn. `state.actions` collects proposed action ids. */
function makeExecutor(ctx, { categoryKeys, state }) {
  return async (name, input) => {
    if (name === 'get_period_summary') {
      const p = rangeInput.safeParse(input);
      if (!p.success) return invalid(p.error.issues);
      const { from, to } = p.data;
      if (to < from || lib.daysBetween(from, to) > 366) return { isError: true, content: { error: 'INVALID_RANGE', message: 'to must be on or after from and at most 366 days later.' } };
      return { content: composeFigures(await periodData(ctx, from, to, ctx.locale)) };
    }
    if (['list_top_expenses', 'doctor_revenue', 'no_show_stats'].includes(name)) {
      const p = monthInput.safeParse(input);
      if (!p.success) return invalid(p.error.issues);
      const { month } = p.data;
      if (name === 'list_top_expenses') return { content: { month, expenses: await topExpenses(ctx, month) } };
      if (name === 'doctor_revenue') return { content: { month, doctors: await doctorRevenue(ctx, month) } };
      return { content: await noShowStats(ctx, month) };
    }
    if (name === 'add_expense' || name === 'add_supplier') {
      if (state.actions.length >= MAX_ACTIONS_PER_TURN) return { isError: true, content: { error: 'TOO_MANY_ACTIONS', message: `At most ${MAX_ACTIONS_PER_TURN} actions per message.` } };
      if (name === 'add_expense') {
        const p = expenseInput(categoryKeys).safeParse(input);
        if (!p.success) return invalid(p.error.issues);
        const d = p.data;
        const id = await proposeAction(ctx, 'add_expense', { date: d.date, category: d.category, amount: round2(d.amount), description: d.description, method: d.method });
        state.actions.push(id);
        return { content: { status: 'pending_confirmation', action_id: id, message: 'Nothing has been saved. The user sees a confirmation card and must press Confirm.' } };
      }
      const p = supplierInput.safeParse(input);
      if (!p.success) return invalid(p.error.issues);
      const d = p.data;
      const dup = await knex('suppliers').where({ business_id: ctx.businessId }).whereRaw('LOWER(name) = ?', [d.name.toLowerCase()]).first('id');
      if (dup) return { isError: true, content: { error: 'SUPPLIER_EXISTS', message: 'A supplier with this name already exists; tell the user instead of adding a duplicate.' } };
      const id = await proposeAction(ctx, 'add_supplier', { name: d.name, phone: d.phone || null, email: d.email || null });
      state.actions.push(id);
      return { content: { status: 'pending_confirmation', action_id: id, message: 'Nothing has been saved. The user sees a confirmation card and must press Confirm.' } };
    }
    return { isError: true, content: { error: 'UNKNOWN_TOOL' } };
  };
}

// ---------------------------------------------------------------- analysis
async function analyze(ctx, month, { client, locale } = {}) {
  const { platform, code: denied } = await access(ctx);
  if (denied) throw fail(denied, httpFor(denied));
  if (!isMonth(month)) throw fail('AIFIN_BAD_MONTH', 422);
  const lang = locale === 'en' ? 'en' : 'ar';
  await checkLimits(ctx, platform, KIND_ANALYSIS);
  const figures = await monthlyFigures(ctx, month, lang);
  const input = analysisInput(figures);
  const id = await startRequest(ctx, platform, KIND_ANALYSIS, lang);
  let resp;
  try {
    const c = client || ai.makeClient(platform);
    resp = await c.beta.messages.create(analysisParams({ model: platform.model, locale: lang, input }));
  } catch (err) {
    const code = ai.errorCode(err);
    await finishRequest(ctx, id, KIND_ANALYSIS, platform, { status: 'error', error_code: code });
    throw fail(code, httpFor(code), err && err.message);
  }
  const r = ai.parseResponse(resp);
  let result = r.result;
  if (r.status === 'ok') {
    const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 10) : []);
    result = { summary: String(result.summary || ''), strengths: arr(result.strengths), warnings: arr(result.warnings), action_steps: arr(result.action_steps), metrics_notes: String(result.metrics_notes || '') };
    if (!result.summary) r.status = 'error';
  }
  const status = r.status === 'error' ? 'error' : r.status;
  const code = status === 'ok' ? null : (r.code || 'AI_BAD_OUTPUT');
  await finishRequest(ctx, id, KIND_ANALYSIS, platform, {
    status, error_code: code, model: r.model || platform.model, input_tokens: r.usage.input, output_tokens: r.usage.output,
    result: r.refusal ? JSON.stringify({ _refusal: r.refusal }) : null,
  }, { month });
  if (status !== 'ok') throw fail(code, httpFor(code));
  const [runId] = await knex('ai_finance_runs').insert({
    business_id: ctx.businessId, user_id: ctx.userId, request_id: id, month, model: r.model || platform.model, locale: lang,
    result: JSON.stringify({ ...result, _meta: { fallback: r.fallback } }), figures: JSON.stringify(input),
  });
  return { id: runId, month, result, model: r.model || platform.model };
}

async function lastRun(ctx, month) {
  const row = await knex('ai_finance_runs as r').leftJoin('users as u', 'u.id', 'r.user_id')
    .where({ 'r.business_id': ctx.businessId, 'r.month': month }).orderBy('r.id', 'desc')
    .first('r.id', 'r.month', 'r.model', 'r.locale', 'r.result', 'r.created_at', 'u.name as user_name');
  if (!row) return null;
  const result = parseJson(row.result, null);
  return result ? { ...row, result } : null;
}

// ---------------------------------------------------------------- chat
function actionNote(a) {
  return `[Proposed action #${a.id} ${a.kind}: ${a.status === 'done' ? 'confirmed and saved by the user' : a.status === 'cancelled' ? 'cancelled by the user' : a.status === 'failed' ? 'failed' : 'waiting for the user to confirm'}]`;
}

/** The last in-context turns as API messages (text only). Must start with a user message. */
async function historyMessages(ctx) {
  const rows = (await knex('ai_finance_messages').where({ business_id: ctx.businessId, user_id: ctx.userId, in_context: true })
    .orderBy('id', 'desc').limit(HISTORY_MESSAGES).select('id', 'role', 'content', 'action_ids')).reverse();
  while (rows.length && rows[0].role !== 'user') rows.shift();
  const ids = rows.flatMap((r) => parseJson(r.action_ids, []) || []);
  const acts = ids.length ? await knex('ai_finance_actions').where({ business_id: ctx.businessId }).whereIn('id', ids).select('id', 'kind', 'status') : [];
  const byId = Object.fromEntries(acts.map((a) => [a.id, a]));
  return rows.map((r) => {
    const notes = (parseJson(r.action_ids, []) || []).map((id) => byId[id]).filter(Boolean).map(actionNote);
    return { role: r.role, content: [r.content, ...notes].filter(Boolean).join('\n') || '…' };
  });
}

const DECLINED = { en: 'The assistant could not help with this request. Try rephrasing it.', ar: 'تعذّر على المساعد تلبية هذا الطلب. جرّب صياغته بطريقة أخرى.' };
const CUT = { en: '(The answer was cut short.)', ar: '(انقطعت الإجابة قبل اكتمالها.)' };
const LOOP = { en: 'The assistant needed too many steps for this question. Try a narrower question.', ar: 'احتاج المساعد إلى خطوات كثيرة لهذا السؤال. جرّب سؤالًا أكثر تحديدًا.' };

/**
 * One chat turn: user message → tool loop → saved assistant reply.
 * @returns {Promise<{ status, reply, actionIds, userMessageId, assistantMessageId }>}
 */
async function chat(ctx, message, { client, locale } = {}) {
  const { platform, code: denied } = await access(ctx);
  if (denied) throw fail(denied, httpFor(denied));
  const text = String(message || '').replace(/\r\n/g, '\n').trim();
  if (!text) throw fail('AIFIN_EMPTY_MESSAGE', 422);
  if (text.length > MAX_MESSAGE) throw fail('AIFIN_MESSAGE_TOO_LONG', 422);
  const lang = locale === 'en' ? 'en' : 'ar';
  await checkLimits(ctx, platform, KIND_CHAT);
  const lctx = { ...ctx, locale: lang };
  const { system: sysCats, custom } = await expenseSvc.categories(ctx.businessId);
  const label = await categoryLabeler(ctx.businessId, lang);
  const categories = [...sysCats.map((k) => ({ key: k, label: label(k) })), ...custom.map((c) => ({ key: c.key, label: c.name }))];
  const categoryKeys = categories.map((c) => c.key);
  const history = await historyMessages(ctx);
  const messages = [...history, { role: 'user', content: text }];
  const params = chatParams({
    model: platform.model, locale: lang,
    system: chatSystem({ locale: lang, today: ctx.today || new Date().toISOString().slice(0, 10), currency: ctx.currency, categories }),
    tools: toolDefs(categoryKeys),
  });
  const state = { actions: [] };
  const id = await startRequest(ctx, platform, KIND_CHAT, lang);
  let out;
  try {
    const c = client || ai.makeClient(platform);
    out = await toolLoop({ client: c, params, messages, execute: makeExecutor(lctx, { categoryKeys, state }) });
  } catch (err) {
    const code = ai.errorCode(err);
    if (state.actions.length) await knex('ai_finance_actions').whereIn('id', state.actions).update({ status: 'cancelled', decided_at: new Date() });
    await finishRequest(ctx, id, KIND_CHAT, platform, { status: 'error', error_code: code }, { actions: state.actions.length });
    throw fail(code, httpFor(code), err && err.message);
  }
  let reply = out.text; let status = out.status; let keep = true;
  if (status === 'refused') {
    reply = DECLINED[lang]; keep = false;
    if (state.actions.length) await knex('ai_finance_actions').whereIn('id', state.actions).update({ status: 'cancelled', decided_at: new Date() });
    state.actions = [];
  } else if (status === 'truncated') {
    reply = reply ? `${reply}\n${CUT[lang]}` : CUT[lang];
    keep = Boolean(out.text);
  } else if (status === 'loop_limit') {
    reply = reply || LOOP[lang];
    status = 'ok';
  }
  if (!reply && state.actions.length) reply = lang === 'en' ? 'Please review and confirm:' : 'يرجى المراجعة والتأكيد:';
  if (!reply) { reply = LOOP[lang]; keep = false; }
  const reqStatus = { ok: 'ok', refused: 'refused', truncated: 'truncated' }[status] || 'ok';
  await finishRequest(ctx, id, KIND_CHAT, platform, {
    status: reqStatus, error_code: reqStatus === 'ok' ? null : (reqStatus === 'refused' ? 'AI_REFUSED' : 'AI_TRUNCATED'),
    model: out.model || platform.model, input_tokens: out.usage.input, output_tokens: out.usage.output,
    result: out.refusal ? JSON.stringify({ _refusal: out.refusal }) : null,
  }, { iterations: out.iterations, tool_calls: out.tools.length, actions: state.actions.length });
  const [userMessageId] = await knex('ai_finance_messages').insert({ business_id: ctx.businessId, user_id: ctx.userId, role: 'user', content: text, status: 'ok', in_context: keep });
  const [assistantMessageId] = await knex('ai_finance_messages').insert({
    business_id: ctx.businessId, user_id: ctx.userId, role: 'assistant', content: reply, status: reqStatus, in_context: keep,
    action_ids: state.actions.length ? JSON.stringify(state.actions) : null,
  });
  return { status: reqStatus, reply, actionIds: state.actions, userMessageId, assistantMessageId };
}

/** Recent chat messages with their action cards, oldest first. */
async function conversation(ctx, { limit = 40, afterId = 0 } = {}) {
  const rows = (await knex('ai_finance_messages').where({ business_id: ctx.businessId, user_id: ctx.userId }).where('id', '>', afterId)
    .orderBy('id', 'desc').limit(limit).select('id', 'role', 'content', 'status', 'action_ids', 'created_at')).reverse();
  const ids = rows.flatMap((r) => parseJson(r.action_ids, []) || []);
  const acts = ids.length ? await actionsByIds(ctx, ids) : {};
  return rows.map((r) => ({ ...r, actions: (parseJson(r.action_ids, []) || []).map((id) => acts[id]).filter(Boolean) }));
}

async function actionsByIds(ctx, ids) {
  const rows = await knex('ai_finance_actions').where({ business_id: ctx.businessId, user_id: ctx.userId }).whereIn('id', ids);
  return Object.fromEntries(rows.map((a) => [a.id, decorate(a)]));
}

function decorate(a) {
  const payload = parseJson(a.payload, {}) || {};
  const expired = a.status === 'pending' && (Date.now() - new Date(a.created_at).getTime()) > ACTION_TTL_HOURS * 3_600_000;
  return { id: a.id, kind: a.kind, payload, status: expired ? 'expired' : a.status, entity_id: a.entity_id, error_code: a.error_code, created_at: a.created_at, perm: ACTION_PERMS[a.kind] };
}

async function clearConversation(ctx) {
  await knex('ai_finance_messages').where({ business_id: ctx.businessId, user_id: ctx.userId }).del();
  await knex('ai_finance_actions').where({ business_id: ctx.businessId, user_id: ctx.userId, status: 'pending' }).update({ status: 'cancelled', decided_at: new Date() });
  await audit.record(ctx, 'aifin.chat_cleared', { entityType: 'ai_finance', entityId: ctx.businessId });
}

// ---------------------------------------------------------------- confirm / cancel
async function loadAction(ctx, id) {
  const a = await knex('ai_finance_actions').where({ id, business_id: ctx.businessId, user_id: ctx.userId }).first();
  if (!a) throw E.notFound('Action');
  return a;
}

/**
 * Executes a pending action for the user who proposed it. The permission is checked NOW (not when proposed) and
 * the normal service validates the data. Returns the decorated action.
 */
async function confirmAction(ctx, id) {
  const a = await loadAction(ctx, id);
  const perm = ACTION_PERMS[a.kind];
  if (!perm || !ctx.permissions.has(perm)) throw E.forbidden(perm || 'unknown');
  const d = decorate(a);
  if (d.status === 'expired') throw fail('AIFIN_ACTION_EXPIRED', 409);
  if (a.status !== 'pending') throw fail('AIFIN_ACTION_GONE', 409);
  const claimed = await knex('ai_finance_actions').where({ id: a.id, status: 'pending' }).update({ status: 'confirming' });
  if (!claimed) throw fail('AIFIN_ACTION_GONE', 409);
  const p = d.payload;
  let entityId;
  try {
    if (a.kind === 'add_expense') {
      entityId = await expenseSvc.save(ctx, null, { date: p.date, category: p.category, title: p.description, amount: String(p.amount), payment_method: p.method, notes: '' });
    } else {
      entityId = await supplies.saveSupplier(ctx, null, { name: p.name, phone: p.phone || '', email: p.email || '', notes: '', is_active: '1' });
    }
  } catch (err) {
    await knex('ai_finance_actions').where({ id: a.id }).update({ status: 'pending' });
    throw err;
  }
  await knex('ai_finance_actions').where({ id: a.id }).update({ status: 'done', entity_id: entityId, decided_at: new Date() });
  await audit.record(ctx, 'aifin.action_confirmed', {
    entityType: a.kind === 'add_expense' ? 'expense' : 'supplier', entityId,
    newValues: { action_id: a.id, kind: a.kind, via: 'ai_finance_assistant' },
  });
  return decorate(await loadAction(ctx, id));
}

async function cancelAction(ctx, id) {
  const a = await loadAction(ctx, id);
  if (a.status !== 'pending') throw fail('AIFIN_ACTION_GONE', 409);
  await knex('ai_finance_actions').where({ id: a.id, status: 'pending' }).update({ status: 'cancelled', decided_at: new Date() });
  await audit.record(ctx, 'aifin.action_cancelled', { entityType: 'ai_finance_action', entityId: a.id, newValues: { kind: a.kind } });
  return decorate(await loadAction(ctx, id));
}

async function usage(ctx) {
  const since = ai.monthStart(ctx.timezone);
  const [[{ n }], all] = await Promise.all([
    knex('ai_requests').where({ business_id: ctx.businessId }).whereIn('kind', [KIND_ANALYSIS, KIND_CHAT]).whereIn('status', ['ok', 'refused', 'truncated'])
      .where('created_at', '>=', since).count({ n: '*' }),
    ai.counts(ctx),
  ]);
  return { finance: Number(n), month: all.monthCount, hour: all.hourCount };
}

module.exports = {
  DEFAULT_ROLES, KIND_ANALYSIS, KIND_CHAT, MAX_ITERATIONS, ACTION_PERMS, ANALYSIS_SCHEMA,
  settings, saveSettings, accessCheck, access, httpFor, checkLimits,
  periodData, composeFigures, monthlyFigures, analysisInput, analysisParams, analysisSystem, toolDefs, chatSystem, chatParams,
  toolLoop, makeExecutor, topExpenses, doctorRevenue, noShowStats,
  analyze, lastRun, chat, conversation, clearConversation, confirmAction, cancelAction, usage, decorate,
};
