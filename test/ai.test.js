// AI clinical assistant: de-identification, request shape (Claude Opus 5.5 rules), response parsing (refusal,
// max_tokens, bad JSON, fallback), typed SDK error mapping, access/limit rules, and the full run() flow against the
// test database with a FAKE client (no network): saved rows, audit without clinical text, disabled states, roles,
// permissions, doctor scope, monthly cap and hourly limit.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Anthropic } = require('@anthropic-ai/sdk');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const { clinicNow } = require('../src/modules/clinic/scheduling');
const ai = require('../src/modules/ai/ai.service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PATIENT = 'ليلى سمير الخطيب';
let ctx; let docA; let docB; let patientId; let visit; let visitEmpty; let visitOther; let today; let savedPlatform = null;

/** Fake SDK client: records calls; answers with `reply(params)` or throws `error`. */
function fakeClient(reply, error) {
  const calls = [];
  return { calls, beta: { messages: { create: async (params) => { calls.push(params); if (error) throw error; return reply(params); } } } };
}
const okReply = (obj, extra = {}) => () => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_details: null,
  content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: JSON.stringify(obj) }],
  usage: { input_tokens: 812, output_tokens: 240 }, ...extra,
});
const SUMMARY = { chief_complaint: 'Cough and fever', key_findings: ['Crackles right base'], assessment: 'Likely pneumonia', plan: ['Chest X-ray'], medications: ['Clarithromycin 500 mg'], follow_up: '48 hours', summary_text: 'Adult with probable right lower lobe pneumonia.' };

async function makeClinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), slug: `ai-${tag}` });
  businesses.forget(businessId);
  today = clinicNow('Asia/Amman').date;
  return { businessId, userId, roleKey: 'owner', permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, locale: 'en', today };
}

async function addVisit(doctorId, withNote = true) {
  const [id] = await knex('appointments').insert({
    business_id: ctx.businessId, doctor_id: doctorId, patient_id: patientId, patient_name: PATIENT, patient_phone: '0795551234',
    appointment_date: today, appointment_time: '09:00', duration_minutes: 20, status: 'confirmed',
  });
  if (withNote) {
    await knex('consultations').insert({
      business_id: ctx.businessId, appointment_id: id, doctor_id: doctorId, patient_id: patientId, patient_name: PATIENT, patient_phone: '0795551234',
      vital_signs: JSON.stringify({ weightKg: 82, heightCm: 165, temperatureC: 38.4, bloodPressure: '142/88' }),
      diagnosis: 'Community-acquired pneumonia?',
      subjective: 'Cough 5 days. Call ليلى on 0791112233 or layla@example.com. Seen at عيادة الذكاء before. Born 1988-04-12.',
      objective: 'Crackles right lower zone.', assessment: 'Likely RLL pneumonia', plan_text: 'CXR, CBC, CRP',
    });
    await knex('prescriptions').insert({
      business_id: ctx.businessId, appointment_id: id, doctor_id: doctorId, patient_id: patientId, patient_name: PATIENT, patient_phone: '0795551234',
      items: JSON.stringify([{ medicationName: 'Clarithromycin', dosage: '500 mg', frequency: 'twice daily', duration: '7 days', instructions: '' }, { medicationName: 'Atorvastatin', dosage: '40 mg', frequency: 'at night', duration: '', instructions: '' }]),
    });
  }
  return id;
}

async function setPlatform(patch = {}) {
  await ai.savePlatform({ businessId: null, userId: ctx.userId }, { enabled: '1', api_key: 'sk-ant-api03-TESTKEY-not-real-000011112222', model: 'claude-opus-5-5', monthly_cap: '100', hourly_limit: '20', ...patch });
}
async function setClinic(body) {
  const roles = (await rbac.listRoles(ctx.businessId)).filter((r) => r.permissions.includes('clinical.view'));
  await ai.saveClinic(ctx, body, roles);
}
const rejects = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code); return true; });

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const row = await knex('platform_settings').where({ key: 'ai' }).first('value');
  savedPlatform = row ? row.value : null;
  ctx = await makeClinic(`ai${tag}@t.test`, 'عيادة الذكاء');
  docA = await doctors.saveDoctor(ctx, null, { full_name: 'د. سامر يوسف', full_name_en: 'Dr. Samer Yousef', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
  docB = await doctors.saveDoctor(ctx, null, { full_name: 'د. باسم', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
  [patientId] = await knex('patients').insert({
    business_id: ctx.businessId, full_name: PATIENT, phone: '0795551234', email: 'layla@example.com', national_id: '9988776655',
    date_of_birth: '1988-04-12', gender: 'female', allergies: 'Penicillin', chronic_conditions: 'Type 2 diabetes',
  });
  visit = await addVisit(docA);
  visitEmpty = await addVisit(docA, false);
  visitOther = await addVisit(docB);
});
test.after(async () => {
  if (savedPlatform === null) await knex('platform_settings').where({ key: 'ai' }).del();
  else await knex('platform_settings').where({ key: 'ai' }).update({ value: savedPlatform });
  ai.forget();
  await knex.destroy();
});

// ---------------------------------------------------------------- pure helpers
test('scrubText removes phones, e-mails, links, ID numbers and names but keeps clinical numbers', () => {
  const phrases = ai.namePhrases({ people: [PATIENT, 'Dr. Samer Yousef'], orgs: ['عيادة الذكاء'] });
  const s = ai.scrubText('ليلى الخطيب, 0791112233 / +962 79 555 1234, a.b@c.com, https://x.io/p, ID 9988776655. BP 120/80, glucose 188, 500 mg, since 2026-09-01. Dr. Samer Yousef at عيادة الذكاء. Born 1988-04-12', phrases, ['1988-04-12']);
  for (const leak of ['ليلى', 'الخطيب', '0791112233', '555 1234', 'a.b@c.com', 'x.io', '9988776655', 'Samer', 'Yousef', 'عيادة الذكاء', '1988-04-12']) assert.ok(!s.includes(leak), `leaked ${leak}: ${s}`);
  for (const keep of ['120/80', '188', '500 mg', '2026-09-01']) assert.ok(s.includes(keep), `lost ${keep}: ${s}`);
  assert.equal(ai.scrubText('', phrases), '');
});

test('ageLabel gives years, months or weeks — never the date of birth', () => {
  assert.equal(ai.ageLabel('1988-04-12', '2026-09-30'), '38 years');
  assert.equal(ai.ageLabel('1988-10-12', '2026-09-30'), '37 years');
  assert.equal(ai.ageLabel('2025-03-01', '2026-09-30'), '18 months');
  assert.equal(ai.ageLabel('2026-09-02', '2026-09-30'), '4 weeks');
  assert.equal(ai.ageLabel(null, '2026-09-30'), null);
  assert.equal(ai.ageLabel('2027-01-01', '2026-09-30'), null);
});

test('composeInput is de-identified and tailored to the action', async () => {
  const d = await ai.visitData(ctx, visit);
  const full = ai.composeInput({ ...d, kind: 'second_opinion' });
  for (const leak of ['ليلى', 'الخطيب', PATIENT, '0795551234', '0791112233', 'layla@example.com', '9988776655', '1988-04-12', 'سامر', 'Samer', 'عيادة الذكاء']) assert.ok(!full.includes(leak), `leaked ${leak}`);
  assert.match(full, /Patient: female, \d+ years/);
  assert.match(full, /Known allergies: Penicillin/);
  assert.match(full, /Chronic conditions: Type 2 diabetes/);
  assert.match(full, /temperature 38.4 °C/);
  assert.match(full, /BMI 30.1/);
  assert.match(full, /Subjective: Cough 5 days/);
  assert.match(full, /1\. Clarithromycin — 500 mg — twice daily — 7 days/);
  const rx = ai.composeInput({ ...d, kind: 'rx_check' });
  assert.ok(!rx.includes('Subjective') && !rx.includes('Plan:'), 'rx check sends no SOAP free text');
  assert.match(rx, /Atorvastatin/);
  assert.equal(ai.hasContent('rx_check', d), true);
  const empty = await ai.visitData(ctx, visitEmpty);
  assert.equal(ai.hasContent('rx_check', empty), false);
  assert.equal(ai.hasContent('second_opinion', empty), false);
});

test('request follows the Claude Opus 5.5 rules: structured output, effort, fallbacks, no prefill/thinking toggles', () => {
  for (const kind of ai.KINDS) {
    const p = ai.requestParams({ kind, model: 'claude-opus-5-5', locale: 'ar', text: 'Patient: female, 38 years' });
    assert.equal(p.model, 'claude-opus-5-5');
    assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(p.fallbacks, 'default');
    assert.equal(p.output_config.format.type, 'json_schema');
    assert.deepEqual(p.output_config.format.schema, ai.SCHEMAS[kind]);
    assert.equal(p.output_config.effort, kind === 'summary' ? 'low' : 'medium');
    assert.ok(p.max_tokens >= 4000 && p.max_tokens <= 8000);
    assert.equal(p.messages.at(-1).role, 'user'); // no assistant prefill
    for (const banned of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'tools']) assert.equal(p[banned], undefined, banned);
    assert.match(p.system, /Modern Standard Arabic/);
  }
  assert.match(ai.requestParams({ kind: 'summary', locale: 'en', text: 'x' }).system, /in English/);
  assert.equal(ai.requestParams({ kind: 'summary', locale: 'en', text: 'x' }).model, 'claude-opus-5-5');
  // Every object in every schema is closed (structured outputs requirement).
  const walk = (s) => { if (s.type === 'object') { assert.equal(s.additionalProperties, false); assert.deepEqual(s.required, Object.keys(s.properties)); Object.values(s.properties).forEach(walk); } if (s.type === 'array') walk(s.items); };
  Object.values(ai.SCHEMAS).forEach(walk);
});

test('parseResponse handles success, refusal, max_tokens, bad JSON and fallback', () => {
  const ok = ai.parseResponse(okReply(SUMMARY)());
  assert.equal(ok.status, 'ok'); assert.deepEqual(ok.result, SUMMARY); assert.deepEqual(ok.usage, { input: 812, output: 240 }); assert.equal(ok.fallback, false);
  const refused = ai.parseResponse({ model: 'claude-opus-5-5', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio', explanation: null }, content: [], usage: { input_tokens: 10, output_tokens: 0 } });
  assert.equal(refused.status, 'refused'); assert.equal(refused.code, 'AI_REFUSED'); assert.equal(refused.refusal.category, 'bio'); assert.equal(refused.result, null);
  const nullDetails = ai.parseResponse({ stop_reason: 'refusal', stop_details: null, content: [{ type: 'text', text: '{"partial":' }], usage: {} });
  assert.equal(nullDetails.status, 'refused'); assert.equal(nullDetails.refusal.category, null);
  const cut = ai.parseResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":' }], usage: { input_tokens: 5, output_tokens: 4000 } });
  assert.equal(cut.status, 'truncated'); assert.equal(cut.code, 'AI_TRUNCATED'); assert.equal(cut.usage.output, 4000);
  assert.equal(ai.parseResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: {} }).code, 'AI_BAD_OUTPUT');
  assert.equal(ai.parseResponse({ stop_reason: 'end_turn', content: [], usage: {} }).code, 'AI_BAD_OUTPUT');
  assert.equal(ai.parseResponse(null).status, 'error');
  const fb = ai.parseResponse(okReply(SUMMARY, { model: 'claude-opus-4-8', content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }, { type: 'text', text: JSON.stringify(SUMMARY) }] })());
  assert.equal(fb.status, 'ok'); assert.equal(fb.fallback, true); assert.equal(fb.model, 'claude-opus-4-8');
});

test('typed SDK errors map to stable codes', () => {
  const h = new Headers();
  assert.equal(ai.errorCode(new Anthropic.AuthenticationError(401, {}, 'bad key', h)), 'AI_AUTH');
  assert.equal(ai.errorCode(new Anthropic.PermissionDeniedError(403, {}, 'no', h)), 'AI_FORBIDDEN');
  assert.equal(ai.errorCode(new Anthropic.NotFoundError(404, {}, 'model', h)), 'AI_MODEL_NOT_FOUND');
  assert.equal(ai.errorCode(new Anthropic.RateLimitError(429, {}, 'slow down', h)), 'AI_PROVIDER_RATE_LIMIT');
  assert.equal(ai.errorCode(new Anthropic.BadRequestError(400, {}, 'bad', h)), 'AI_BAD_REQUEST');
  assert.equal(ai.errorCode(new Anthropic.InternalServerError(500, {}, 'oops', h)), 'AI_PROVIDER_DOWN');
  assert.equal(ai.errorCode(new Anthropic.APIError(529, {}, 'overloaded', h)), 'AI_PROVIDER_DOWN');
  assert.equal(ai.errorCode(new Anthropic.APIConnectionTimeoutError()), 'AI_TIMEOUT');
  assert.equal(ai.errorCode(new Anthropic.APIConnectionError({ message: 'down' })), 'AI_NETWORK');
  assert.equal(ai.errorCode(new Error('boom')), 'AI_API_ERROR');
});

test('accessCheck and limitCheck', () => {
  const perms = new Set(['clinical.view']);
  const platform = { enabled: true, hasKey: true };
  const clinic = { enabled: true, allowed_roles: ['doctor'] };
  assert.equal(ai.accessCheck({ platform, clinic, roleKey: 'doctor', permissions: perms }), null);
  assert.equal(ai.accessCheck({ platform: { ...platform, enabled: false }, clinic, roleKey: 'doctor', permissions: perms }), 'AI_PLATFORM_OFF');
  assert.equal(ai.accessCheck({ platform: { ...platform, hasKey: false }, clinic, roleKey: 'doctor', permissions: perms }), 'AI_NOT_CONFIGURED');
  assert.equal(ai.accessCheck({ platform, clinic: { ...clinic, enabled: false }, roleKey: 'doctor', permissions: perms }), 'AI_CLINIC_OFF');
  assert.equal(ai.accessCheck({ platform, clinic, roleKey: 'doctor', permissions: new Set() }), 'AI_NO_PERMISSION');
  assert.equal(ai.accessCheck({ platform, clinic, roleKey: 'nurse', permissions: perms }), 'AI_ROLE_NOT_ALLOWED');
  assert.equal(ai.limitCheck({ monthCount: 99, cap: 100, hourCount: 0, hourly: 20 }), null);
  assert.equal(ai.limitCheck({ monthCount: 100, cap: 100, hourCount: 0, hourly: 20 }), 'AI_MONTHLY_CAP');
  assert.equal(ai.limitCheck({ monthCount: 5000, cap: 0, hourCount: 0, hourly: 20 }), null); // 0 = no monthly cap
  assert.equal(ai.limitCheck({ monthCount: 0, cap: 100, hourCount: 20, hourly: 20 }), 'AI_HOURLY_LIMIT');
  const ms = ai.monthStart('Asia/Amman', new Date('2026-09-30T12:00:00Z'));
  assert.equal(ms.toISOString(), '2026-08-31T21:00:00.000Z');
});

// ---------------------------------------------------------------- settings
test('platform settings: key encrypted, never returned, validation', async () => {
  await rejects(ai.savePlatform({ businessId: null, userId: ctx.userId }, { enabled: '1', api_key: '', model: 'claude-opus-5-5', remove_key: '1' }), 'VALIDATION_FAILED');
  await rejects(ai.savePlatform({ businessId: null, userId: ctx.userId }, { enabled: '0', model: 'bad model id!' }), 'VALIDATION_FAILED');
  await setPlatform();
  const raw = (await knex('platform_settings').where({ key: 'ai' }).first('value')).value;
  assert.ok(!raw.includes('TESTKEY'), 'key stored encrypted');
  const s = await ai.platformSettings();
  assert.equal(s.active, true); assert.equal(s.keyHint, '•••• 2222'); assert.equal(s.model, 'claude-opus-5-5');
  // Saving without a key keeps the stored one.
  await setPlatform({ api_key: '' });
  assert.equal((await ai.platformSettings()).keyHint, '•••• 2222');
  const log = await knex('audit_logs').where({ action: 'platform.ai_updated' }).orderBy('id', 'desc').first('new_values');
  assert.ok(!JSON.stringify(log.new_values).includes('TESTKEY'));
});

test('clinic settings: off by default, acknowledgement required, roles limited to clinical roles', async () => {
  const c0 = await ai.clinicSettings(ctx.businessId);
  assert.equal(c0.enabled, false); assert.deepEqual(c0.allowed_roles, ['doctor']);
  await rejects(setClinic({ enabled: '1', roles: ['doctor'] }), 'VALIDATION_FAILED');
  await rejects(setClinic({ enabled: '1', acknowledge: '1', roles: ['receptionist'] }), 'VALIDATION_FAILED'); // no clinical.view → dropped → none left
  await setClinic({ enabled: '1', acknowledge: '1', roles: ['doctor', 'owner', 'receptionist'] });
  const c1 = await ai.clinicSettings(ctx.businessId);
  assert.equal(c1.enabled, true); assert.deepEqual(c1.allowed_roles, ['doctor', 'owner']); assert.ok(c1.acknowledged_at); assert.equal(c1.acknowledged_by, ctx.userId);
  // Already acknowledged: changing roles does not ask again.
  await setClinic({ enabled: '1', roles: ['doctor', 'owner'] });
});

// ---------------------------------------------------------------- run()
test('run: sends only de-identified text, saves the result, audits without clinical text', async () => {
  const client = fakeClient(okReply(SUMMARY));
  const out = await ai.run(ctx, visit, 'summary', { client, locale: 'ar' });
  assert.deepEqual(out.result, SUMMARY);
  assert.equal(client.calls.length, 1);
  const sent = JSON.stringify(client.calls[0]);
  for (const leak of [PATIENT, 'ليلى', '0795551234', '0791112233', 'layla@example.com', '9988776655', '1988-04-12', 'سامر', 'عيادة الذكاء', 'TESTKEY']) assert.ok(!sent.includes(leak), `sent ${leak}`);
  assert.equal(client.calls[0].fallbacks, 'default');
  const row = await knex('ai_requests').where({ id: out.id }).first();
  assert.equal(row.status, 'ok'); assert.equal(row.kind, 'summary'); assert.equal(row.input_tokens, 812); assert.equal(row.output_tokens, 240);
  assert.equal(row.model, 'claude-opus-5-5'); assert.equal(row.user_id, ctx.userId); assert.equal(row.appointment_id, visit); assert.equal(row.locale, 'ar');
  const last = await ai.lastResults(ctx, visit);
  assert.equal(last.summary.result.summary_text, SUMMARY.summary_text);
  const logs = await knex('audit_logs').where({ business_id: ctx.businessId, action: 'ai.request' }).select('new_values');
  assert.equal(logs.length, 1);
  const lv = typeof logs[0].new_values === 'string' ? logs[0].new_values : JSON.stringify(logs[0].new_values);
  assert.match(lv, /"kind":"summary"/);
  for (const clinicalText of ['Cough', 'pneumonia', 'Clarithromycin', 'Penicillin']) assert.ok(!lv.includes(clinicalText), 'audit has no clinical text');
});

test('run: refusal, max_tokens and API errors are saved and reported with codes', async () => {
  await rejects(ai.run(ctx, visit, 'second_opinion', { client: fakeClient(() => ({ model: 'claude-opus-5-5', stop_reason: 'refusal', stop_details: { category: 'bio' }, content: [], usage: { input_tokens: 20, output_tokens: 0 } })) }), 'AI_REFUSED');
  await rejects(ai.run(ctx, visit, 'second_opinion', { client: fakeClient(() => ({ model: 'claude-opus-5-5', stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"differentials":[' }], usage: { input_tokens: 20, output_tokens: 8000 } })) }), 'AI_TRUNCATED');
  await rejects(ai.run(ctx, visit, 'rx_check', { client: fakeClient(null, new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key', new Headers())) }), 'AI_AUTH');
  await rejects(ai.run(ctx, visit, 'rx_check', { client: fakeClient(null, new Anthropic.RateLimitError(429, {}, 'rate', new Headers())) }), 'AI_PROVIDER_RATE_LIMIT');
  const rows = await knex('ai_requests').where({ business_id: ctx.businessId }).orderBy('id').select('status', 'error_code', 'kind');
  assert.deepEqual(rows.slice(-4).map((r) => [r.status, r.error_code]), [['refused', 'AI_REFUSED'], ['truncated', 'AI_TRUNCATED'], ['error', 'AI_AUTH'], ['error', 'AI_PROVIDER_RATE_LIMIT']]);
  assert.equal((await ai.lastResults(ctx, visit)).second_opinion, undefined, 'failed answers are not shown as results');
});

test('run: nothing to send, unknown action, doctor scope', async () => {
  const client = fakeClient(okReply(SUMMARY));
  await rejects(ai.run(ctx, visitEmpty, 'rx_check', { client }), 'AI_NOTHING_TO_SEND');
  await rejects(ai.run(ctx, visit, 'diagnose', { client }), 'NOT_FOUND');
  const doctorCtx = { ...ctx, roleKey: 'doctor', permissions: new Set(['appointments.view', 'clinical.view']), ownDoctorId: docA, doctorId: docA };
  await rejects(ai.run(doctorCtx, visitOther, 'summary', { client }), 'NOT_FOUND');
  assert.equal(client.calls.length, 0);
  await ai.run(doctorCtx, visit, 'rx_check', { client: fakeClient(okReply({ overall: 'no_concerns', interactions: [], dose_concerns: [], allergy_concerns: [], condition_concerns: [], notes: '' })) });
});

test('run: disabled states, role and permission checks block before any call', async () => {
  const client = fakeClient(okReply(SUMMARY));
  await rejects(ai.run({ ...ctx, roleKey: 'nurse' }, visit, 'summary', { client }), 'AI_ROLE_NOT_ALLOWED');
  await rejects(ai.run({ ...ctx, permissions: new Set(['appointments.view']) }, visit, 'summary', { client }), 'AI_NO_PERMISSION');
  await setClinic({ enabled: '0', roles: ['doctor', 'owner'] });
  await rejects(ai.run(ctx, visit, 'summary', { client }), 'AI_CLINIC_OFF');
  await setClinic({ enabled: '1', acknowledge: '1', roles: ['doctor', 'owner'] });
  await setPlatform({ enabled: '0' });
  await rejects(ai.run(ctx, visit, 'summary', { client }), 'AI_PLATFORM_OFF');
  await setPlatform();
  assert.equal(client.calls.length, 0);
});

test('run: monthly cap and per-user hourly limit', async () => {
  const client = fakeClient(okReply(SUMMARY));
  const billed = (await ai.usage(ctx.businessId, ctx.timezone)).total;
  await setPlatform({ monthly_cap: String(billed + 1), hourly_limit: '100' });
  await ai.run(ctx, visit, 'summary', { client });
  await rejects(ai.run(ctx, visit, 'summary', { client }), 'AI_MONTHLY_CAP');
  const hour = (await ai.counts(ctx)).hourCount;
  await setPlatform({ monthly_cap: '0', hourly_limit: String(hour) });
  await rejects(ai.run(ctx, visit, 'summary', { client }), 'AI_HOURLY_LIMIT');
  assert.equal(client.calls.length, 1);
  const blocked = await knex('audit_logs').where({ business_id: ctx.businessId, action: 'ai.request_blocked' }).count({ n: '*' });
  assert.equal(Number(blocked[0].n), 2);
  await setPlatform();
});

test('testConnection reports success and typed errors', async () => {
  const s = await ai.platformSettings();
  const good = await ai.testConnection(s, { client: fakeClient(() => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }], usage: {} })) });
  assert.equal(good.ok, true); assert.equal(good.model, 'claude-opus-5-5');
  const bad = await ai.testConnection(s, { client: fakeClient(null, new Anthropic.NotFoundError(404, {}, 'model: nope', new Headers())) });
  assert.equal(bad.ok, false); assert.equal(bad.code, 'AI_MODEL_NOT_FOUND');
});
