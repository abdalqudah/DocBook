// Appointment messages (WhatsApp / SMS / e-mail) and verified reviews, against the test database (docbook_test).
// No network: channels.transport.fetch is stubbed. Covers reminder selection per time zone and stage idempotency,
// opt-out, the /r/ and /review/ token rules, rescheduling under the slot lock, verified-visit-only reviews, one review
// per appointment, the clinic's inability to edit/delete reviews, and the WhatsApp Cloud API payload format.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const appts = require('../src/modules/clinic/appointments.service');
const scheduling = require('../src/modules/clinic/scheduling');
const ch = require('../src/modules/messaging/channels');
const msg = require('../src/modules/messaging/messaging.service');
const reviews = require('../src/modules/reviews/reviews.service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let amman; let la; let clinic; let doctorId; let laDoctorId; let server; let base;
const calls = [];
const realFetch = ch.transport.fetch;

async function makeClinic(email, name, timezone) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), booking_enabled: true, slug: `eg-${businessId}-${tag}`.slice(0, 40) });
  businesses.forget(businessId);
  return { businessId, userId, email, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone, ownDoctorId: null, locale: 'en' };
}

/** A working day (Sun–Thu) at least `min` days after the clinic's today. */
function workday(tz, min = 3) {
  const d = new Date(`${scheduling.clinicNow(tz).date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + min);
  while (![0, 1, 2, 3, 4].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const usedDays = new Set();
/** A fresh working day for each test, so bookings of different tests never collide. */
function freshDay(tz = 'Asia/Amman') {
  for (let n = 3; ; n += 1) { const d = workday(tz, n); if (!usedDays.has(`${tz}:${d}`)) { usedDays.add(`${tz}:${d}`); return d; } }
}

let phoneSeq = 0;
const phone = () => { phoneSeq += 1; return `079${tag.slice(-5)}${String(phoneSeq).padStart(2, '0')}`; };
async function book(ctx, doctor, date, time, extra = {}) {
  return appts.book(ctx, { doctor_id: doctor, appointment_date: date, appointment_time: time, patient_name: 'Omar Khaled Saleh', patient_phone: phone(), status: 'pending', ...extra });
}
const row = (id) => knex('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id').where('a.id', id)
  .first('a.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.slot_duration_minutes', 's.duration_minutes as service_duration');

function stubFetch(answer = () => ({ status: 200, body: { messages: [{ id: `wamid.${crypto.randomBytes(4).toString('hex')}` }] } })) {
  calls.length = 0;
  ch.transport.fetch = async (url, init) => {
    calls.push({ url, init });
    const a = answer(url, init);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  };
}

function client() {
  const jar = {};
  let csrf = '';
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const read = async (res) => {
    for (const h of res.headers.getSetCookie()) { const [kv] = h.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = await res.text();
    const m = text.match(/name="csrf-token" content="([^"]+)"/); if (m) csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text };
  };
  return {
    get: async (path) => read(await fetch(base + path, { headers: { cookie: cookie() }, redirect: 'manual' })),
    post: async (path, data = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: csrf, ...data })) body.append(k, v);
      return read(await fetch(base + path, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' }));
    },
    raw: async (path, body, headers = {}) => read(await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, redirect: 'manual' })),
  };
}

const WA = {
  confirmations_enabled: '1', reminders_enabled: '1', reviews_enabled: '1', reminder_1: '24', reminder_2: '2', review_delay_minutes: '120', message_locale: 'ar',
  cancel_cutoff_hours: '3', allow_reschedule: '1', use_whatsapp: '1', use_email: '1', default_dial: '962', wa_phone_number_id: '1234567890', wa_token: 'EAAG-test-token',
  wa_tpl_confirmation: 'appointment_booked', wa_tpl_reminder: 'appointment_reminder', wa_tpl_review: 'visit_review', wa_lang_ar: 'ar', wa_lang_en: 'en', wa_app_secret: 'app-secret-123',
  sms_method: 'POST', sms_content_type: 'application/json',
};

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  amman = await makeClinic(`eg${tag}@t.test`, 'Engage clinic', 'Asia/Amman');
  la = await makeClinic(`eg-la${tag}@t.test`, 'West clinic', 'America/Los_Angeles');
  clinic = await businesses.get(amman.businessId);
  doctorId = await doctors.saveDoctor(amman, null, { full_name: 'Dr. Rami', full_name_en: 'Dr. Rami', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
  laDoctorId = await doctors.saveDoctor(la, null, { full_name: 'Dr. West', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
  await msg.saveSettings(amman, WA);
  await msg.saveSettings(la, { ...WA, default_dial: '1' });
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { ch.transport.fetch = realFetch; server.close(); await knex.destroy(); });

// ---------------------------------------------------------------- pure rules
test('phone numbers are normalised with the clinic country code', () => {
  assert.equal(ch.msisdn('0791234567', '962'), '962791234567');
  assert.equal(ch.msisdn('+962 79 123 4567', '1'), '962791234567');
  assert.equal(ch.msisdn('00962791234567'), '962791234567');
  assert.equal(ch.msisdn('791234567', '962'), '962791234567');
  assert.equal(ch.msisdn('0791234567', null), null);
  assert.equal(ch.msisdn('abc', '962'), null);
});

test('reminder selection: latest due stage only, nothing after the start, nothing booked inside the window', () => {
  const start = Date.UTC(2026, 9, 11, 7, 0); // 10:00 in Amman
  const offsets = [1440, 120];
  const created = start - 5 * 86_400_000;
  assert.deepEqual(msg.dueReminder({ startMs: start, createdMs: created, offsets, now: start - 25 * 3_600_000 }), { send: null, skip: [] });
  assert.deepEqual(msg.dueReminder({ startMs: start, createdMs: created, offsets, now: start - 23 * 3_600_000 }), { send: 'reminder_1440', skip: [] });
  assert.deepEqual(msg.dueReminder({ startMs: start, createdMs: created, offsets, now: start - 3_600_000 }), { send: 'reminder_120', skip: ['reminder_1440'] });
  assert.deepEqual(msg.dueReminder({ startMs: start, createdMs: created, offsets, now: start + 60_000 }), { send: null, skip: [] });
  // booked 5 hours before: the 24 h reminder is never due, the 2 h one is
  assert.deepEqual(msg.dueReminder({ startMs: start, createdMs: start - 5 * 3_600_000, offsets, now: start - 4 * 3_600_000 }), { send: null, skip: [] });
  assert.equal(msg.dueReminder({ startMs: start, createdMs: start - 5 * 3_600_000, offsets, now: start - 90 * 60_000 }).send, 'reminder_120');
});

test('WhatsApp Cloud API template payload and request format', async () => {
  stubFetch();
  const payload = ch.waTemplatePayload({ to: '962791234567', template: 'appointment_reminder', language: 'ar', body: ['Clinic', 'Dr. A', 'Sunday 5 October', '10:30'], urlSuffix: 'TOKEN', quickPayload: 'confirm:TOKEN' });
  assert.deepEqual(payload, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: '962791234567', type: 'template',
    template: { name: 'appointment_reminder', language: { code: 'ar' }, components: [
      { type: 'body', parameters: [{ type: 'text', text: 'Clinic' }, { type: 'text', text: 'Dr. A' }, { type: 'text', text: 'Sunday 5 October' }, { type: 'text', text: '10:30' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'confirm:TOKEN' }] },
      { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'TOKEN' }] },
    ] },
  });
  const r = await ch.sendWhatsApp({ phoneNumberId: '1234567890', token: 'EAAG' }, payload);
  assert.equal(r.ok, true);
  assert.match(r.id, /^wamid\./);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://graph.facebook.com/${ch.GRAPH_VERSION()}/1234567890/messages`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer EAAG');
  assert.deepEqual(JSON.parse(calls[0].init.body), payload);
  // provider error is reported, never faked as sent
  stubFetch(() => ({ status: 400, body: { error: { code: 132001, message: 'Template name does not exist in the translation' } } }));
  const bad = await ch.sendWhatsApp({ phoneNumberId: '1', token: 'x' }, payload);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /132001/);
});

test('generic SMS request: placeholders escaped per body format', () => {
  const j = ch.smsRequest({ url: 'https://sms.example/send', method: 'POST', contentType: 'application/json', bodyTemplate: '{"to":"{to}","msg":"{text}"}', authHeader: 'Authorization', authValue: 'Bearer k' }, '962791234567', 'Hi "you"\nline');
  assert.deepEqual(JSON.parse(j.init.body), { to: '962791234567', msg: 'Hi "you"\nline' });
  assert.equal(j.init.headers.Authorization, 'Bearer k');
  const g = ch.smsRequest({ url: 'https://sms.example/send?key=1', method: 'GET', bodyTemplate: 'to={to}&text={text}' }, '962791234567', 'a b&c');
  assert.equal(g.url, 'https://sms.example/send?key=1&to=962791234567&text=a%20b%26c');
});

// ---------------------------------------------------------------- scheduler
test('reminders per clinic time zone, sent once per stage, idempotent with concurrent runs', async () => {
  const date = freshDay();
  const id = await book(amman, doctorId, date, '10:00');
  await knex('appointments').where({ id }).update({ created_at: new Date(Date.now() - 3 * 86_400_000) });
  const laDate = freshDay('America/Los_Angeles');
  const laId = await book(la, laDoctorId, laDate, '10:00');
  await knex('appointments').where({ id: laId }).update({ created_at: new Date(Date.now() - 3 * 86_400_000) });
  const startAmman = msg.zonedToUtc(date, '10:00', 'Asia/Amman');
  const startLa = msg.zonedToUtc(laDate, '10:00', 'America/Los_Angeles');
  assert.notEqual(startAmman - Date.parse(`${date}T10:00:00Z`), startLa - Date.parse(`${laDate}T10:00:00Z`)); // different offsets
  const cfg = await msg.getConfig(amman.businessId);
  const laCfg = await msg.getConfig(la.businessId);
  stubFetch();
  // 23 hours before the Amman appointment: its 24 h reminder is due; the LA clinic's appointment is judged in LA time.
  const now = startAmman - 23 * 3_600_000;
  await msg.runClinic(cfg, now, base);
  const sentAmman = calls.filter((c) => JSON.parse(c.init.body).template.name === 'appointment_reminder');
  assert.equal(sentAmman.length, 1);
  const body = JSON.parse(sentAmman[0].init.body);
  assert.equal(body.to, ch.msisdn((await row(id)).patient_phone, '962'));
  assert.equal(body.template.language.code, 'ar');
  assert.equal(body.template.components[0].parameters.length, 4);
  assert.equal(body.template.components[0].parameters[3].text, '10:00');
  const url = body.template.components.find((c) => c.sub_type === 'url').parameters[0].text;
  assert.match(url, msg.TOKEN_RE);
  // LA: at the same instant, due only if within 24 h of 10:00 Los Angeles time
  calls.length = 0;
  await msg.runClinic(laCfg, now, base);
  const laDue = startLa - now <= 24 * 3_600_000 && startLa > now;
  assert.equal(calls.length, laDue ? 1 : 0);
  calls.length = 0;
  await msg.runClinic(laCfg, startLa - 23 * 3_600_000, base);
  assert.equal(calls.length, laDue ? 0 : 1);
  // idempotent: running again (twice in parallel) sends nothing new
  calls.length = 0;
  await Promise.all([msg.runClinic(cfg, now + 60_000, base), msg.runClinic(cfg, now + 60_000, base)]);
  assert.equal(calls.length, 0);
  // concurrent claims of the same stage: exactly one wins
  const a = await row(id);
  const results = await Promise.all([msg.sendStage(clinic, cfg, a, 'reminder_120', { base, now }), msg.sendStage(clinic, cfg, a, 'reminder_120', { base, now })]);
  assert.equal(results.filter((r) => r === 'sent').length, 1);
  assert.equal(results.filter((r) => r === null).length, 1);
  const d = await knex('message_dispatches').where({ appointment_id: id }).select('stage', 'status');
  assert.deepEqual(d.map((x) => x.stage).sort(), ['reminder_120', 'reminder_1440']);
  // the log keeps status and a masked number, never the text
  const logs = await knex('message_log').where({ appointment_id: id });
  assert.ok(logs.every((l) => l.status === 'sent' && l.channel === 'whatsapp' && /•/.test(l.recipient)));
  // a moved appointment gets reminders for its new slot
  await knex('appointments').where({ id }).update({ appointment_time: '11:00' });
  calls.length = 0;
  await msg.runClinic(cfg, msg.zonedToUtc(date, '11:00', 'Asia/Amman') - 23 * 3_600_000, base);
  assert.equal(calls.length, 1);
});

test('booking confirmation is sent once, with the /r/ link; blocked times and cancelled bookings get nothing', async () => {
  const date = freshDay();
  const id = await book(amman, doctorId, date, '09:00');
  const cancelled = await book(amman, doctorId, date, '09:30');
  await appts.setStatus(amman, cancelled, 'cancelled');
  await appts.block(amman, { doctor_id: doctorId, appointment_date: date, appointment_time: '12:00', duration_minutes: '30', label: 'Meeting' });
  stubFetch();
  const cfg = await msg.getConfig(amman.businessId);
  await msg.runClinic(cfg, Date.now(), base);
  const to = ch.msisdn((await row(id)).patient_phone, '962');
  const conf = calls.map((c) => JSON.parse(c.init.body)).filter((b) => b.template.name === 'appointment_booked' && b.to === to);
  assert.equal(conf.length, 1);
  assert.match(conf[0].template.components.find((x) => x.sub_type === 'url').parameters[0].text, msg.TOKEN_RE);
  const dispatched = await knex('message_dispatches').whereIn('appointment_id', [id, cancelled]).select('appointment_id', 'stage');
  assert.deepEqual(dispatched.map((x) => [x.appointment_id, x.stage]), [[id, 'confirmation']]);
  calls.length = 0;
  await msg.runClinic(cfg, Date.now(), base);
  assert.equal(calls.filter((c) => JSON.parse(c.init.body).template.name === 'appointment_booked').length, 0);
});

// ---------------------------------------------------------------- opt-out
test('opt-out is respected by automated messages; STOP by WhatsApp (signed webhook) opts out', async () => {
  const date = freshDay();
  const id = await book(amman, doctorId, date, '10:00');
  const a = await row(id);
  const cfg = await msg.getConfig(amman.businessId);
  await msg.setOptOut(amman.businessId, { patientId: a.patient_id }, true);
  stubFetch();
  assert.equal(await msg.sendStage(clinic, cfg, a, 'reminder_1440', { base }), 'opted_out');
  assert.equal(calls.length, 0);
  const log = await knex('message_log').where({ appointment_id: id, status: 'opted_out' }).first();
  assert.ok(log);
  await msg.setOptOut(amman.businessId, { patientId: a.patient_id }, false);

  // STOP through the webhook: bad signature refused, good one opts the number out
  const id2 = await book(amman, doctorId, date, '10:30');
  const b = await row(id2);
  const from = ch.msisdn(b.patient_phone, '962');
  const payload = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from, type: 'text', text: { body: 'STOP' } }] } }] }] });
  const hook = `/hooks/whatsapp/${cfg.wa_hook_key}`;
  const c = client();
  assert.equal((await c.raw(hook, payload, { 'x-hub-signature-256': 'sha256=00' })).status, 401);
  const sig = `sha256=${crypto.createHmac('sha256', 'app-secret-123').update(payload).digest('hex')}`;
  assert.equal((await c.raw(hook, payload, { 'x-hub-signature-256': sig })).status, 200);
  const p = await knex('patients').where({ id: b.patient_id }).first('messaging_opt_out');
  assert.equal(Boolean(p.messaging_opt_out), true);
  assert.equal(await msg.sendStage(clinic, cfg, b, 'reminder_120', { base }), 'opted_out');
  // Meta's verification handshake
  const v = await c.get(`${hook}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(cfg.wa_verify_token)}&hub.challenge=42`);
  assert.equal(v.status, 200);
  assert.equal(v.text, '42');
  assert.equal((await c.get(`${hook}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`)).status, 403);
});

// ---------------------------------------------------------------- /r/ tokens & actions
test('/r/ tokens: unguessable, per appointment, purpose-bound, expire after the appointment', async () => {
  const date = freshDay();
  const id = await book(amman, doctorId, date, '11:00');
  const a = await row(id);
  const { token } = await msg.linkFor(a, 'action');
  assert.match(token, msg.TOKEN_RE);
  assert.equal((await msg.linkFor(a, 'action')).token, token); // same link every message
  const stored = await knex('appointment_links').where({ appointment_id: id, purpose: 'action' }).first();
  assert.notEqual(stored.token_hash, token);
  assert.ok(!String(stored.token_enc).includes(token));
  assert.equal(await msg.byToken(token, 'review'), null); // wrong purpose
  assert.equal(await msg.byToken('x'.repeat(43), 'action'), null);
  const c = client();
  assert.equal((await c.get(`/r/${token}`)).status, 200);
  assert.equal((await c.get(`/review/${token}`)).status, 404);
  assert.equal((await c.get('/r/not-a-token')).status, 404);
  const page = await c.get(`/r/${token}`);
  assert.match(page.text, /noindex/);
  // after the appointment is over the link no longer works
  await knex('appointments').where({ id }).update({ appointment_date: '2020-01-05' });
  assert.equal((await c.get(`/r/${token}`)).status, 404);
  assert.equal((await c.post(`/r/${token}/confirm`)).status, 404);
});

test('patient confirm and cancel (with cut-off), audited and staff notified', async () => {
  const date = freshDay();
  const id = await book(amman, doctorId, date, '14:30');
  const a = await row(id);
  const { token } = await msg.linkFor(a, 'action');
  const c = client();
  await c.get(`/r/${token}`);
  const r = await c.post(`/r/${token}/confirm`);
  assert.equal(r.status, 303);
  assert.equal((await row(id)).status, 'confirmed');
  assert.ok(await knex('audit_logs').where({ business_id: amman.businessId, action: 'engage.patient_confirmed', entity_id: String(id) }).first());
  assert.ok(await knex('notifications').where({ business_id: amman.businessId, type: 'appointment.patient_confirmed', link: `/app/appointments/${id}` }).first());
  const x = await c.post(`/r/${token}/cancel`, { reason: 'Travelling' });
  assert.equal(x.status, 303);
  assert.equal((await row(id)).status, 'cancelled');
  const au = await knex('audit_logs').where({ action: 'engage.patient_cancelled', entity_id: String(id) }).first();
  assert.match(typeof au.new_values === 'string' ? au.new_values : JSON.stringify(au.new_values), /Travelling/);
  // cut-off: an appointment in 2 hours cannot be cancelled online with a 3-hour cut-off
  const cfg = await msg.getConfig(amman.businessId);
  const soon = { ...(await row(await book(amman, doctorId, freshDay(), '10:00'))) };
  const st = msg.actionState(soon, clinic, cfg, msg.startOf(soon, clinic.timezone) - 2 * 3_600_000);
  assert.equal(st.locked, true);
  assert.equal(st.canCancel, false);
  assert.equal(st.canConfirm, true);
});

test('reschedule shows the same doctor’s free times and moves under the slot lock', async () => {
  const date = freshDay();
  const id = await book(amman, doctorId, date, '09:00');
  const other = await book(amman, doctorId, date, '10:00');
  assert.ok(other);
  const a = await row(id);
  const cfg = await msg.getConfig(amman.businessId);
  const slots = await msg.rescheduleSlots(a, clinic, date);
  assert.ok(!slots.includes('10:00'));
  assert.ok(slots.includes('11:00'));
  const orig = scheduling.withSlot;
  let locked = 0;
  scheduling.withSlot = (req, fn) => { locked += 1; return orig(req, fn); };
  try {
    await assert.rejects(msg.patientReschedule(a, clinic, cfg, date, '10:00', {}), (e) => e.code === 'SLOT_TAKEN');
    await msg.patientReschedule(a, clinic, cfg, date, '11:00', {});
  } finally { scheduling.withSlot = orig; }
  assert.equal(locked, 2);
  const moved = await row(id);
  assert.equal(moved.appointment_time, '11:00');
  assert.ok(await knex('audit_logs').where({ action: 'appointment.moved', entity_id: String(id) }).first());
  assert.ok(await knex('audit_logs').where({ action: 'engage.patient_rescheduled', entity_id: String(id) }).first());
});

// ---------------------------------------------------------------- reviews
test('only visited patients can review, once per appointment; review links expire', async () => {
  const date = freshDay();
  const id = await book(amman, doctorId, date, '14:00');
  const a = await row(id);
  const { token } = await msg.linkFor(a, 'review');
  const link = await msg.byToken(token, 'review');
  assert.equal(await reviews.linkState(link), 'not_visited');
  await assert.rejects(reviews.submit(link, { rating: '5' }), (e) => e.code === 'REVIEW_NOT_VISITED');
  await appts.setStatus(amman, id, 'cancelled');
  assert.equal(await reviews.linkState(await msg.byToken(token, 'review')), 'not_visited');
  await knex('appointments').where({ id }).update({ status: 'completed' });
  const c = client();
  assert.equal((await c.get(`/review/${token}`)).status, 200);
  // honeypot: looks accepted, nothing stored
  await c.post(`/review/${token}`, { rating: '1', display_mode: 'full', website: 'http://spam' });
  assert.equal(await knex('reviews').where({ appointment_id: id }).first(), undefined);
  const r = await c.post(`/review/${token}`, { rating: '4', rating_wait: '3', comment: 'Kind doctor, a little waiting.', display_mode: 'initials' });
  assert.equal(r.status, 303);
  const saved = await knex('reviews').where({ appointment_id: id }).first();
  assert.equal(saved.rating, 4);
  assert.equal(saved.display_name, 'O. K. S.');
  assert.equal(saved.doctor_id, doctorId);
  const again = await c.post(`/review/${token}`, { rating: '1', display_mode: 'full' });
  assert.equal(again.status, 409);
  await assert.rejects(reviews.submit(await msg.byToken(token, 'review'), { rating: '2' }), (e) => e.code === 'REVIEW_EXISTS');
  // too long a comment is refused
  const id2 = await book(amman, doctorId, date, '15:00');
  await knex('appointments').where({ id: id2 }).update({ payment_status: 'paid' });
  const t2 = (await msg.linkFor(await row(id2), 'review')).token;
  await assert.rejects(reviews.submit(await msg.byToken(t2, 'review'), { rating: '5', comment: 'x'.repeat(1001) }), (e) => e.code === 'VALIDATION_FAILED');
  // expired after 30 days
  await knex('appointment_links').where({ appointment_id: id2, purpose: 'review' }).update({ expires_at: new Date(Date.now() - 1000) });
  assert.equal(await reviews.linkState(await msg.byToken(t2, 'review')), 'expired');
  assert.equal((await c.get(`/review/${t2}`)).status, 404);
});

test('the clinic replies once and reports, but cannot edit or delete; platform hides with a reason; public summary', async () => {
  const date = freshDay();
  const id = await book(amman, doctorId, date, '16:00');
  await knex('appointments').where({ id }).update({ status: 'completed' });
  const link = await msg.byToken((await msg.linkFor(await row(id), 'review')).token, 'review');
  const rid = await reviews.submit(link, { rating: '2', comment: 'Original words', display_mode: 'anonymous' });
  assert.equal(typeof reviews.update, 'undefined');
  assert.equal(typeof reviews.remove, 'undefined');
  await reviews.reply(amman, rid, { reply: 'Thank you, we are sorry about the wait.' });
  await assert.rejects(reviews.reply(amman, rid, { reply: 'Changed reply' }), (e) => e.code === 'REVIEW_REPLIED');
  await assert.rejects(reviews.reply(la, rid, { reply: 'Other clinic' }), (e) => e.status === 404); // tenant isolation
  await reviews.report(amman, rid, { reason: 'Not about our clinic' });
  const saved = await knex('reviews').where({ id: rid }).first();
  assert.equal(saved.comment, 'Original words');
  assert.equal(saved.display_name, null);
  assert.ok(saved.reported_at);
  // over HTTP: no edit or delete routes for the clinic
  const c = client();
  await c.get('/login');
  assert.equal((await c.post('/login', { email: amman.email, password: 'Passw0rd!x' })).status, 302);
  assert.equal((await c.get('/app/reviews')).status, 200);
  assert.equal((await c.post(`/app/reviews/${rid}/delete`)).status, 404);
  assert.equal((await c.post(`/app/reviews/${rid}/edit`, { comment: 'x' })).status, 404);
  assert.equal((await c.post(`/app/reviews/${rid}/reply`, { reply: 'Second reply' })).status, 409);
  assert.equal((await knex('reviews').where({ id: rid }).first()).comment, 'Original words');
  // public summary: published only, no contact or visit details
  let sum = await reviews.publicSummary(amman.businessId);
  assert.ok(sum.count >= 1);
  const pub = sum.latest.find((x) => x.id === rid);
  assert.ok(pub);
  for (const k of ['patient_phone', 'patient_email', 'patient_id', 'appointment_id', 'visit_date', 'ip_hash']) assert.equal(pub[k], undefined);
  const ld = reviews.jsonLd(sum, 'en');
  assert.equal(ld.aggregateRating['@type'], 'AggregateRating');
  assert.equal(ld.aggregateRating.reviewCount, sum.count);
  // the platform hides it (audited)
  await reviews.moderate({ businessId: null, userId: amman.userId }, rid, 'hide', { reason: 'Offensive language' });
  sum = await reviews.publicSummary(amman.businessId);
  assert.equal(sum.latest.find((x) => x.id === rid), undefined);
  assert.ok(await knex('audit_logs').where({ action: 'platform.review_hidden', entity_id: String(rid) }).first());
  await assert.rejects(reviews.moderate({ businessId: null, userId: 1 }, rid, 'hide', { reason: '' }), (e) => e.code === 'VALIDATION_FAILED');
  // the clinic page shows the rating and JSON-LD
  const page = await c.get(`/${clinic.slug}`);
  assert.equal(page.status, 200);
  if (sum.count) assert.match(page.text, /AggregateRating/);
});

test('review requests go out after the visit delay, once', async () => {
  const date = freshDay();
  const id = await book(amman, doctorId, date, '16:30');
  await knex('appointments').where({ id }).update({ status: 'completed', updated_at: new Date(Date.now() - 3 * 3_600_000) });
  const cfg = await msg.getConfig(amman.businessId);
  stubFetch();
  await msg.runClinic(cfg, Date.now(), base);
  const to = ch.msisdn((await row(id)).patient_phone, '962');
  const sent = calls.map((c) => JSON.parse(c.init.body)).filter((b) => b.template.name === 'visit_review' && b.to === to);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].template.components[0].parameters.length, 2);
  assert.ok(await knex('message_dispatches').where({ appointment_id: id, stage: 'review' }).first());
  calls.length = 0;
  await msg.runClinic(cfg, Date.now(), base);
  assert.equal(calls.filter((c) => JSON.parse(c.init.body).template.name === 'visit_review').length, 0);
});
