// AI finance assistant: figures builder (no patient identifiers), request shapes (Claude Opus 5.5 rules, strict tools,
// no forced tool_choice), the manual tool loop against a FAKE client (tool_use → tool_result, refusal, max_tokens,
// iteration cap), the pending-confirmation flow (nothing written before Confirm; permission re-checked at confirm),
// access switches, the shared monthly cap / hourly limit and the busy guard. No network.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const { clinicNow } = require('../src/modules/clinic/scheduling');
const lib = require('../src/modules/clinic/records.lib');
const ai = require('../src/modules/ai/ai.service');
const fin = require('../src/modules/ai/finance.service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PATIENT = 'رنا خالد الزعبي';
const PHONE = '0797771234';
let ctx; let docA; let month; let prevMonth; let savedPlatform = null; let invNo = 1;

/** Fake SDK client: `replies` is a list of responses (or functions of params) returned in order. */
function fakeClient(replies, error) {
  const calls = [];
  let i = 0;
  return {
    calls,
    beta: {
      messages: {
        create: async (params) => {
          calls.push(JSON.parse(JSON.stringify(params)));
          if (error) throw error;
          const r = replies[Math.min(i, replies.length - 1)]; i += 1;
          return typeof r === 'function' ? r(params) : r;
        },
      },
    },
  };
}
const msg = (content, stop = 'end_turn', usage = { input_tokens: 300, output_tokens: 80 }) => ({ id: `msg_${Math.random()}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: stop, stop_details: null, content, usage });
const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const text = (s) => ({ type: 'text', text: s });
const ANALYSIS = { summary: 'Revenue grew while expenses stayed flat.', strengths: ['Revenue up'], warnings: ['No-show rate is high'], action_steps: ['Send reminders the day before'], metrics_notes: 'Month in progress.' };
const rejects = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code); return true; });

async function makeClinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), slug: `aifin-${tag}` });
  businesses.forget(businessId);
  const today = clinicNow('Asia/Amman').date;
  return { businessId, userId, userName: 'Owner', roleKey: 'owner', permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, locale: 'en', today };
}

async function setPlatform(patch = {}) {
  await ai.savePlatform({ businessId: null, userId: ctx.userId }, { enabled: '1', api_key: 'sk-ant-api03-TESTKEY-not-real-000011112222', model: 'claude-opus-5-5', monthly_cap: '0', hourly_limit: '500', ...patch });
}
async function setFin(body) {
  const roles = (await rbac.listRoles(ctx.businessId)).filter((r) => r.permissions.includes('finance.view'));
  await fin.saveSettings(ctx, body, roles);
}
async function addAppt(date, status, source = 'staff') {
  const [id] = await knex('appointments').insert({ business_id: ctx.businessId, doctor_id: docA, patient_name: PATIENT, patient_phone: PHONE, appointment_date: date, appointment_time: '10:00', status, source });
  return id;
}
async function addInvoice(amount, method, at, discount = 0) {
  await knex('invoices').insert({ business_id: ctx.businessId, invoice_number: invNo++, doctor_id: docA, doctor_name: 'د. هالة', service_name: 'كشفية', patient_name: PATIENT, patient_phone: PHONE, amount, payment_method: method, discount_amount: discount, discount_percent: discount ? 10 : 0, created_at: at });
}
const dropPending = () => knex('ai_requests').where({ business_id: ctx.businessId, status: 'pending' }).update({ status: 'error' });

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const row = await knex('platform_settings').where({ key: 'ai' }).first('value');
  savedPlatform = row ? row.value : null;
  ctx = await makeClinic(`aifin${tag}@t.test`, 'عيادة المالية');
  month = ctx.today.slice(0, 7);
  prevMonth = lib.addMonths(month, -1);
  docA = await doctors.saveDoctor(ctx, null, { full_name: 'د. هالة', full_name_en: 'Dr. Hala', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '400', is_active: '1' });
  await knex('patients').insert({ business_id: ctx.businessId, full_name: PATIENT, phone: PHONE, national_id: '1122334455' });
  const d1 = `${month}-01`;
  await addAppt(d1, 'completed'); await addAppt(d1, 'completed', 'website'); await addAppt(d1, 'completed'); await addAppt(d1, 'no_show'); await addAppt(d1, 'cancelled');
  await addAppt(`${prevMonth}-10`, 'completed');
  const now = new Date();
  await addInvoice(30, 'cash', now); await addInvoice(20, 'card', now, 5); await addInvoice(25, 'cash', now);
  await addInvoice(40, 'cash', new Date(`${prevMonth}-15T09:00:00Z`));
  await knex('expenses').insert([
    { business_id: ctx.businessId, date: d1, category: 'rent', title: 'Rent — call 0791234567', amount: 300, payment_method: 'bank_transfer' },
    { business_id: ctx.businessId, date: d1, category: 'cleaning', title: 'Cleaning', amount: 15, payment_method: 'cash' },
    { business_id: ctx.businessId, date: `${prevMonth}-05`, category: 'rent', title: 'Rent', amount: 300, payment_method: 'bank_transfer' },
  ]);
  await knex('payroll_payments').insert({ business_id: ctx.businessId, doctor_id: docA, period: month, base_salary: 400, net_pay: 400 });
});
test.after(async () => {
  if (savedPlatform === null) await knex('platform_settings').where({ key: 'ai' }).del();
  else await knex('platform_settings').where({ key: 'ai' }).update({ value: savedPlatform });
  ai.forget();
  await knex.destroy();
});

// ---------------------------------------------------------------- figures
test('monthly figures are correct and contain no patient identifiers', async () => {
  const f = await fin.monthlyFigures(ctx, month, 'en');
  const c = f.current;
  assert.equal(c.revenue.total, 75); assert.equal(c.revenue.invoices, 3); assert.equal(c.revenue.average_invoice, 25);
  assert.deepEqual(c.revenue.by_method.map((m) => [m.method, m.amount]), [['cash', 55], ['card', 20]]);
  assert.equal(c.revenue.discounts.total, 5); assert.equal(c.revenue.discounts.invoices_with_discount, 1);
  assert.equal(c.expenses.total, 315); assert.equal(c.expenses.by_category[0].category, 'Rent');
  assert.equal(c.doctor_payroll_paid.total, 400);
  assert.equal(c.net_result, 75 - 315 - 400);
  assert.equal(c.appointments.total, 5); assert.equal(c.appointments.by_status.no_show, 1);
  assert.equal(c.appointments.no_show_rate_percent, 25); // 1 of 4 attended-or-missed
  assert.equal(c.appointments.by_source.website, 1);
  assert.equal(c.by_doctor[0].doctor, 'Dr. Hala'); assert.equal(c.by_doctor[0].revenue, 75);
  assert.equal(f.previous.revenue.total, 40); assert.equal(f.changes_percent.revenue, 87.5);
  const sent = JSON.stringify(fin.analysisInput(f));
  for (const leak of [PATIENT, 'رنا', 'الزعبي', PHONE, '1122334455']) assert.ok(!sent.includes(leak), `leaked ${leak}`);
  const ar = await fin.monthlyFigures(ctx, month, 'ar');
  assert.equal(ar.current.by_doctor[0].doctor, 'د. هالة'); // doctor names are management data
  await rejects(fin.monthlyFigures(ctx, '2026-13', 'en'), 'AIFIN_BAD_MONTH');
});

test('request shapes follow the Claude Opus 5.5 rules', async () => {
  const input = fin.analysisInput(await fin.monthlyFigures(ctx, month, 'en'));
  const p = fin.analysisParams({ model: 'claude-opus-5-5', locale: 'ar', input });
  assert.equal(p.output_config.effort, 'medium');
  assert.deepEqual(p.output_config.format, { type: 'json_schema', schema: fin.ANALYSIS_SCHEMA });
  assert.deepEqual(p.betas, [ai.FALLBACK_BETA]); assert.equal(p.fallbacks, 'default');
  assert.equal(p.messages.at(-1).role, 'user');
  for (const banned of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'tools']) assert.equal(p[banned], undefined, banned);
  assert.match(p.system, /Modern Standard Arabic/); assert.match(p.system, /not accounting, tax/);
  const tools = fin.toolDefs(['rent', 'cleaning']);
  assert.deepEqual(tools.map((t) => t.name), ['get_period_summary', 'list_top_expenses', 'doctor_revenue', 'no_show_stats', 'add_expense', 'add_supplier']);
  for (const t of tools) {
    assert.equal(t.strict, true);
    assert.equal(t.input_schema.additionalProperties, false);
    assert.deepEqual(t.input_schema.required, Object.keys(t.input_schema.properties));
  }
  assert.deepEqual(tools[4].input_schema.properties.category.enum, ['rent', 'cleaning']);
  const cp = fin.chatParams({ model: 'claude-opus-5-5', locale: 'en', system: 's', tools });
  assert.equal(cp.output_config.effort, 'low'); assert.equal(cp.tool_choice, undefined); assert.equal(cp.thinking, undefined);
  assert.equal(cp.fallbacks, 'default');
});

// ---------------------------------------------------------------- tool loop
test('toolLoop runs every tool_use, returns results with matching ids and resends the full content', async () => {
  const first = msg([thinking, text('Let me check.'), toolUse('tu_1', 'get_period_summary', { from: `${month}-01`, to: ctx.today }), toolUse('tu_2', 'no_show_stats', { month })], 'tool_use');
  const client = fakeClient([first, msg([text('Revenue was 75 JOD.')])]);
  const seen = [];
  const messages = [{ role: 'user', content: 'How did we do?' }];
  const out = await fin.toolLoop({ client, params: { model: 'x' }, messages, execute: async (name, input) => { seen.push([name, input]); return { content: { ok: name } }; } });
  assert.equal(out.status, 'ok'); assert.equal(out.text, 'Revenue was 75 JOD.'); assert.equal(out.iterations, 2);
  assert.deepEqual(seen.map((s) => s[0]), ['get_period_summary', 'no_show_stats']);
  assert.deepEqual(out.usage, { input: 600, output: 160 });
  const second = client.calls[1].messages;
  assert.deepEqual(second[1], { role: 'assistant', content: first.content }); // full content incl. thinking block
  assert.equal(second[2].role, 'user');
  assert.deepEqual(second[2].content.map((r) => [r.type, r.tool_use_id]), [['tool_result', 'tu_1'], ['tool_result', 'tu_2']]);
  assert.equal(second[2].content[0].content, JSON.stringify({ ok: 'get_period_summary' }));
});

test('toolLoop: refusal, max_tokens with a tool call, errors from tools and the iteration cap', async () => {
  let ran = 0;
  const exec = async () => { ran += 1; return { content: 'x' }; };
  const refused = await fin.toolLoop({ client: fakeClient([{ ...msg([]), stop_reason: 'refusal', stop_details: { category: 'cyber' } }]), params: {}, messages: [{ role: 'user', content: 'q' }], execute: exec });
  assert.equal(refused.status, 'refused'); assert.equal(refused.refusal.category, 'cyber');
  const cut = await fin.toolLoop({ client: fakeClient([msg([toolUse('t', 'add_expense', { amount: 1 })], 'max_tokens')]), params: {}, messages: [{ role: 'user', content: 'q' }], execute: exec });
  assert.equal(cut.status, 'truncated'); assert.equal(ran, 0, 'a truncated tool call never runs');
  const cutText = await fin.toolLoop({ client: fakeClient([msg([text('Partial answer')], 'max_tokens')]), params: {}, messages: [{ role: 'user', content: 'q' }], execute: exec });
  assert.equal(cutText.status, 'truncated'); assert.equal(cutText.text, 'Partial answer');
  const always = fakeClient([msg([toolUse('t', 'doctor_revenue', { month })], 'tool_use')]);
  const capped = await fin.toolLoop({ client: always, params: {}, messages: [{ role: 'user', content: 'q' }], execute: exec });
  assert.equal(capped.status, 'loop_limit'); assert.equal(always.calls.length, fin.MAX_ITERATIONS);
  const boom = fakeClient([msg([toolUse('t9', 'doctor_revenue', { month })], 'tool_use'), msg([text('done')])]);
  const handled = await fin.toolLoop({ client: boom, params: {}, messages: [{ role: 'user', content: 'q' }], execute: async () => { throw new Error('db down'); } });
  assert.equal(handled.status, 'ok');
  assert.equal(boom.calls[1].messages[2].content[0].is_error, true);
});

test('read tools answer from the database without patient data', async () => {
  const state = { actions: [] };
  const exec = fin.makeExecutor(ctx, { categoryKeys: ['rent', 'cleaning'], state });
  const top = await exec('list_top_expenses', { month });
  assert.equal(top.content.expenses[0].amount, 300);
  assert.ok(!JSON.stringify(top.content).includes('0791234567'), 'phone numbers are scrubbed from descriptions');
  const docs = await exec('doctor_revenue', { month });
  assert.equal(docs.content.doctors[0].payroll_paid, 400); assert.equal(docs.content.doctors[0].no_show, 1);
  const ns = await exec('no_show_stats', { month });
  assert.equal(ns.content.no_show_rate_percent, 25); assert.ok(ns.content.by_weekday.length >= 1);
  const range = await exec('get_period_summary', { from: `${prevMonth}-01`, to: ctx.today });
  assert.equal(range.content.revenue.total, 115);
  assert.equal((await exec('get_period_summary', { from: '2026-01-01', to: '2025-01-01' })).isError, true);
  assert.equal((await exec('doctor_revenue', { month: 'May' })).isError, true);
  assert.equal((await exec('drop_tables', {})).isError, true);
  const all = JSON.stringify([top, docs, ns, range]);
  for (const leak of [PATIENT, PHONE]) assert.ok(!all.includes(leak));
});

// ---------------------------------------------------------------- settings & access
test('finance settings: off by default, acknowledgement, roles limited to finance roles; access checks', async () => {
  const s0 = await fin.settings(ctx.businessId);
  assert.equal(s0.enabled, false); assert.deepEqual(s0.allowed_roles, ['owner', 'clinic_manager', 'accountant']);
  await rejects(setFin({ fin_enabled: '1', fin_roles: ['owner'] }), 'VALIDATION_FAILED'); // no acknowledgement
  await rejects(setFin({ fin_enabled: '1', fin_acknowledge: '1', fin_roles: ['doctor'] }), 'VALIDATION_FAILED'); // doctor has no finance.view
  await setFin({ fin_enabled: '1', fin_acknowledge: '1', fin_roles: ['owner', 'accountant', 'nurse'] });
  const s1 = await fin.settings(ctx.businessId);
  assert.equal(s1.enabled, true); assert.deepEqual(s1.allowed_roles, ['owner', 'accountant']); assert.equal(s1.acknowledged_by, ctx.userId);
  const platform = { enabled: true, hasKey: true };
  const perms = new Set(['finance.view']);
  assert.equal(fin.accessCheck({ platform, fin: s1, roleKey: 'owner', permissions: perms }), null);
  assert.equal(fin.accessCheck({ platform: { enabled: false }, fin: s1, roleKey: 'owner', permissions: perms }), 'AI_PLATFORM_OFF');
  assert.equal(fin.accessCheck({ platform: { enabled: true, hasKey: false }, fin: s1, roleKey: 'owner', permissions: perms }), 'AI_NOT_CONFIGURED');
  assert.equal(fin.accessCheck({ platform, fin: { ...s1, enabled: false }, roleKey: 'owner', permissions: perms }), 'AIFIN_CLINIC_OFF');
  assert.equal(fin.accessCheck({ platform, fin: s1, roleKey: 'owner', permissions: new Set() }), 'AIFIN_NO_PERMISSION');
  assert.equal(fin.accessCheck({ platform, fin: s1, roleKey: 'clinic_manager', permissions: perms }), 'AI_ROLE_NOT_ALLOWED');
  await setFin({ fin_enabled: '1', fin_roles: ['owner', 'clinic_manager', 'accountant'] }); // already acknowledged
});

test('disabled platform / clinic / role block before any API call', async () => {
  const client = fakeClient([msg([text('hi')])]);
  await setPlatform({ enabled: '0' });
  await rejects(fin.chat(ctx, 'hello', { client }), 'AI_PLATFORM_OFF');
  await setPlatform();
  await setFin({ fin_enabled: '0', fin_roles: ['owner'] });
  await rejects(fin.analyze(ctx, month, { client }), 'AIFIN_CLINIC_OFF');
  await rejects(setFin({ fin_enabled: '1', fin_roles: ['owner'] }), 'VALIDATION_FAILED'); // switching back on asks again
  await setFin({ fin_enabled: '1', fin_acknowledge: '1', fin_roles: ['owner', 'clinic_manager', 'accountant'] });
  await rejects(fin.chat({ ...ctx, roleKey: 'nurse' }, 'hello', { client }), 'AI_ROLE_NOT_ALLOWED');
  await rejects(fin.chat({ ...ctx, permissions: new Set(['dashboard.view']) }, 'hello', { client }), 'AIFIN_NO_PERMISSION');
  await rejects(fin.chat(ctx, '   ', { client }), 'AIFIN_EMPTY_MESSAGE');
  await rejects(fin.chat(ctx, 'x'.repeat(2001), { client }), 'AIFIN_MESSAGE_TOO_LONG');
  assert.equal(client.calls.length, 0);
});

// ---------------------------------------------------------------- analysis
test('analyze saves the structured result, logs usage and audits without financial text', async () => {
  const client = fakeClient([msg([thinking, text(JSON.stringify(ANALYSIS))], 'end_turn', { input_tokens: 1500, output_tokens: 400 })]);
  const out = await fin.analyze(ctx, month, { client, locale: 'en' });
  assert.deepEqual(out.result, ANALYSIS);
  const sent = JSON.stringify(client.calls[0]);
  for (const leak of [PATIENT, PHONE, 'TESTKEY']) assert.ok(!sent.includes(leak));
  const last = await fin.lastRun(ctx, month);
  assert.equal(last.result.summary, ANALYSIS.summary); assert.equal(last.user_name, 'Owner');
  const req = await knex('ai_requests').where({ business_id: ctx.businessId, kind: fin.KIND_ANALYSIS }).orderBy('id', 'desc').first();
  assert.equal(req.status, 'ok'); assert.equal(req.input_tokens, 1500); assert.equal(req.appointment_id, null);
  const log = await knex('audit_logs').where({ business_id: ctx.businessId, action: 'aifin.request' }).orderBy('id', 'desc').first('new_values');
  const lv = typeof log.new_values === 'string' ? log.new_values : JSON.stringify(log.new_values);
  assert.match(lv, /"kind":"fin_analysis"/);
  for (const t of ['Revenue grew', 'reminders', '315', 'Hala']) assert.ok(!lv.includes(t), `audit leaked ${t}`);
  await rejects(fin.analyze(ctx, month, { client: fakeClient([{ ...msg([]), stop_reason: 'refusal', stop_details: { category: null } }]) }), 'AI_REFUSED');
  await rejects(fin.analyze(ctx, month, { client: fakeClient([msg([text('{"summary":')], 'max_tokens')]) }), 'AI_TRUNCATED');
  assert.equal((await fin.lastRun(ctx, month)).id, last.id, 'failed runs do not replace the saved result');
});

// ---------------------------------------------------------------- chat & pending actions
test('chat: add_expense only creates a pending action — nothing is written before Confirm', async () => {
  const before = Number((await knex('expenses').where({ business_id: ctx.businessId }).count({ n: '*' }))[0].n);
  const client = fakeClient([
    msg([thinking, toolUse('tu_e', 'add_expense', { date: ctx.today, category: 'cleaning', amount: 45, description: 'Cleaning supplies', method: 'cash' })], 'tool_use'),
    msg([text('I prepared the expense — press Confirm to save it.')]),
  ]);
  const out = await fin.chat(ctx, 'Record 45 for cleaning supplies today, cash', { client, locale: 'en' });
  assert.equal(out.status, 'ok'); assert.equal(out.actionIds.length, 1);
  const tr = client.calls[1].messages.at(-1).content[0];
  assert.equal(tr.tool_use_id, 'tu_e'); assert.match(tr.content, /pending_confirmation/);
  const after = Number((await knex('expenses').where({ business_id: ctx.businessId }).count({ n: '*' }))[0].n);
  assert.equal(after, before, 'no expense before confirmation');
  const [a] = await knex('ai_finance_actions').where({ id: out.actionIds[0] });
  assert.equal(a.status, 'pending'); assert.equal(a.kind, 'add_expense');
  const conv = await fin.conversation(ctx);
  assert.equal(conv.at(-1).actions[0].status, 'pending');
  assert.equal(conv.at(-1).actions[0].payload.amount, 45);

  // Confirm without expenses.manage (permission re-checked now) → refused, still pending, nothing written.
  const noPerm = { ...ctx, permissions: new Set([...ctx.permissions].filter((p) => p !== 'expenses.manage')) };
  await rejects(fin.confirmAction(noPerm, a.id), 'PERMISSION_DENIED');
  assert.equal((await knex('ai_finance_actions').where({ id: a.id }).first()).status, 'pending');
  // Another user of the same clinic cannot confirm it.
  await rejects(fin.confirmAction({ ...ctx, userId: ctx.userId + 100000 }, a.id), 'NOT_FOUND');
  // Confirm → saved through the expenses service, audited as done via the assistant.
  const done = await fin.confirmAction(ctx, a.id);
  assert.equal(done.status, 'done');
  const exp = await knex('expenses').where({ id: done.entity_id }).first();
  assert.equal(exp.title, 'Cleaning supplies'); assert.equal(Number(exp.amount), 45); assert.equal(exp.category, 'cleaning'); assert.equal(exp.recorded_by_user_id, ctx.userId);
  assert.ok(await knex('audit_logs').where({ business_id: ctx.businessId, action: 'expense.created', entity_id: String(done.entity_id) }).first());
  const conf = await knex('audit_logs').where({ business_id: ctx.businessId, action: 'aifin.action_confirmed' }).orderBy('id', 'desc').first('new_values');
  assert.match(typeof conf.new_values === 'string' ? conf.new_values : JSON.stringify(conf.new_values), /ai_finance_assistant/);
  await rejects(fin.confirmAction(ctx, a.id), 'AIFIN_ACTION_GONE');
});

test('chat: add_supplier pending → cancel; invalid tool input is returned as is_error', async () => {
  const client = fakeClient([
    msg([
      toolUse('bad', 'add_expense', { date: ctx.today, category: 'yachts', amount: -5, description: '', method: 'cash' }),
      toolUse('sup', 'add_supplier', { name: 'Al Noor Medical Supplies', phone: '065551234', email: null }),
    ], 'tool_use'),
    msg([text('The supplier is ready to confirm.')]),
  ]);
  const out = await fin.chat(ctx, 'Add supplier Al Noor', { client, locale: 'en' });
  assert.equal(out.actionIds.length, 1);
  const results = client.calls[1].messages.at(-1).content;
  assert.equal(results[0].tool_use_id, 'bad'); assert.equal(results[0].is_error, true); assert.match(results[0].content, /INVALID_INPUT/);
  assert.equal(results[1].is_error, undefined);
  assert.equal(await knex('suppliers').where({ business_id: ctx.businessId, name: 'Al Noor Medical Supplies' }).first(), undefined);
  const c = await fin.cancelAction(ctx, out.actionIds[0]);
  assert.equal(c.status, 'cancelled');
  await rejects(fin.confirmAction(ctx, out.actionIds[0]), 'AIFIN_ACTION_GONE');
  assert.equal(await knex('suppliers').where({ business_id: ctx.businessId, name: 'Al Noor Medical Supplies' }).first(), undefined);
  // Supplier confirm path + duplicate detection on the next proposal.
  const again = await fin.chat(ctx, 'Add it again', { client: fakeClient([msg([toolUse('s2', 'add_supplier', { name: 'Al Noor Medical Supplies', phone: null, email: 'sales@alnoor.test' })], 'tool_use'), msg([text('ok')])]) });
  const sup = await fin.confirmAction(ctx, again.actionIds[0]);
  assert.equal((await knex('suppliers').where({ id: sup.entity_id }).first()).email, 'sales@alnoor.test');
  const dupClient = fakeClient([msg([toolUse('s3', 'add_supplier', { name: 'al noor medical supplies', phone: null, email: null })], 'tool_use'), msg([text('It already exists.')])]);
  const dup = await fin.chat(ctx, 'Add Al Noor', { client: dupClient });
  assert.equal(dup.actionIds.length, 0); assert.match(dupClient.calls[1].messages.at(-1).content[0].content, /SUPPLIER_EXISTS/);
});

test('chat: history is resent as text with action outcomes; refusal is shown but kept out of context', async () => {
  const client = fakeClient([msg([text('Sure.')])]);
  await fin.chat(ctx, 'And last month?', { client });
  const sent = client.calls[0].messages;
  assert.equal(sent[0].role, 'user');
  assert.equal(sent.at(-1).content, 'And last month?');
  assert.ok(sent.some((m) => m.role === 'assistant' && /confirmed and saved by the user/.test(m.content)), 'confirmed action noted');
  assert.ok(sent.some((m) => m.role === 'assistant' && /cancelled by the user/.test(m.content)), 'cancelled action noted');
  const refusing = fakeClient([
    msg([toolUse('x1', 'add_expense', { date: ctx.today, category: 'rent', amount: 10, description: 'Rent', method: 'cash' })], 'tool_use'),
    { ...msg([]), stop_reason: 'refusal', stop_details: { category: null } },
  ]);
  const r = await fin.chat(ctx, 'something odd', { client: refusing, locale: 'en' });
  assert.equal(r.status, 'refused'); assert.match(r.reply, /could not help/); assert.equal(r.actionIds.length, 0);
  const cancelled = await knex('ai_finance_actions').where({ business_id: ctx.businessId }).orderBy('id', 'desc').first();
  assert.equal(cancelled.status, 'cancelled', 'actions from a refused turn are withdrawn');
  const next = fakeClient([msg([text('ok')])]);
  await fin.chat(ctx, 'next', { client: next });
  assert.ok(!next.calls[0].messages.some((m) => m.content === 'something odd'), 'refused turn not resent');
  const req = await knex('ai_requests').where({ business_id: ctx.businessId, kind: fin.KIND_CHAT, status: 'refused' }).first();
  assert.ok(req);
  await fin.clearConversation(ctx);
  assert.equal((await fin.conversation(ctx)).length, 0);
});

// ---------------------------------------------------------------- limits
test('monthly cap (shared with the clinical assistant), hourly limit and busy guard', async () => {
  const client = fakeClient([msg([text('ok')])]);
  // A clinical request counts toward the same cap.
  await knex('ai_requests').insert({ business_id: ctx.businessId, user_id: ctx.userId, kind: 'summary', status: 'ok', locale: 'en' });
  const used = (await ai.counts(ctx)).monthCount;
  await setPlatform({ monthly_cap: String(used + 1) });
  await fin.chat(ctx, 'one', { client });
  await rejects(fin.chat(ctx, 'two', { client }), 'AI_MONTHLY_CAP');
  await rejects(fin.analyze(ctx, month, { client }), 'AI_MONTHLY_CAP');
  const hour = (await ai.counts(ctx)).hourCount;
  await setPlatform({ monthly_cap: '0', hourly_limit: String(hour) });
  await rejects(fin.chat(ctx, 'three', { client }), 'AI_HOURLY_LIMIT');
  await setPlatform();
  await knex('ai_requests').insert({ business_id: ctx.businessId, user_id: ctx.userId, kind: fin.KIND_CHAT, status: 'pending', locale: 'en' });
  await rejects(fin.chat(ctx, 'four', { client }), 'AIFIN_BUSY');
  await dropPending();
  assert.equal(client.calls.length, 1);
  const blocked = await knex('audit_logs').where({ business_id: ctx.businessId, action: 'aifin.request_blocked' }).count({ n: '*' });
  assert.equal(Number(blocked[0].n), 4);
  const u = await fin.usage(ctx);
  assert.ok(u.finance >= 3);
});
