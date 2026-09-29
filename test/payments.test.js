// Online payments (PayTabs / HyperPay, stubbed — no network) and patient documents (PDF) against docbook_test:
// provider verification and signatures, idempotent settlement (one invoice however many callbacks), amount
// mismatch, failures, refunds, releasing unpaid holds, PDF output (valid, text layer, pages) and token-scoped
// access to the documents shared with the patient.
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
const scheduling = require('../src/modules/clinic/scheduling');
const clinical = require('../src/modules/clinic/clinical.service');
const tele = require('../src/modules/telehealth/telehealth.service');
const pay = require('../src/modules/payments/payments.service');
const http = require('../src/modules/payments/providers/http');
const paytabs = require('../src/modules/payments/providers/paytabs');
const hyperpay = require('../src/modules/payments/providers/hyperpay');
const docs = require('../src/modules/patientdocs/docs.service');
const { visualRuns, paragraphDir } = require('../src/modules/patientdocs/pdf');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const SERVER_KEY = 'STJN-TEST-SERVER-KEY-123';
let ctx; let clinic; let doctorId; let day; let server; let base; let slotIdx = 0;

async function makeClinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), booking_enabled: true, online_enabled: true, online_payment_required: true, online_payment_instructions: 'CliQ: CLINIC' });
  businesses.forget(businessId);
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, locale: 'en' };
}

function nextSunday() {
  const d = new Date(`${scheduling.clinicNow('Asia/Amman').date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const TIMES = ['09:00', '09:20', '09:40', '10:00', '10:20', '10:40', '11:00', '11:20', '11:40', '12:00', '12:20', '12:40'];
async function bookOne(extra = {}) {
  const time = TIMES[slotIdx++]; // eslint-disable-line no-plusplus
  const b = await tele.bookOnline({ businessId: ctx.businessId, timezone: 'Asia/Amman', permissions: new Set(), locale: 'en' }, clinic, {
    doctor_id: doctorId, appointment_date: day, appointment_time: time, patient_name: 'Sara Haddad', patient_phone: `+96279${tag.slice(-6)}${slotIdx}`,
    patient_email: 'sara@example.com', patient_country: 'JO', patient_timezone: 'Asia/Amman', reason: 'Follow-up', ...extra,
  }, []);
  return { ...b, row: await tele.byToken(b.token) };
}

// ---------------------------------------------------------------- provider simulator (stubbed fetch)
const sim = { tx: {}, checkouts: {}, calls: [], refundOk: true };
const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
function ptTx(t) {
  return { tran_ref: t.ref, tran_type: 'Sale', cart_id: t.cart_id, cart_amount: String(t.amount), cart_currency: t.currency, payment_result: { response_status: t.status || 'P', response_message: t.status === 'A' ? 'Authorised' : 'Declined' }, payment_info: { card_scheme: 'Visa', payment_description: '4111 11## #### 1111' } };
}
async function fakeFetch(url, opts = {}) {
  const u = new URL(url);
  sim.calls.push(`${opts.method || 'GET'} ${u.pathname}`);
  if (u.pathname === '/payment/request') {
    assert.equal(opts.headers.authorization, SERVER_KEY);
    const j = JSON.parse(opts.body);
    if (j.tran_type === 'refund') return reply({ tran_ref: 'RFD1', cart_id: j.cart_id, cart_amount: j.cart_amount, cart_currency: j.cart_currency, payment_result: { response_status: sim.refundOk ? 'A' : 'D', response_message: sim.refundOk ? 'Refunded' : 'Refund declined' } });
    const ref = `TST${Object.keys(sim.tx).length + 1}${tag}`;
    sim.tx[ref] = { ref, cart_id: j.cart_id, amount: j.cart_amount, currency: j.cart_currency, callback: j.callback, ret: j.return };
    return reply({ tran_ref: ref, redirect_url: `https://secure-jordan.paytabs.com/payment/page/${ref}` });
  }
  if (u.pathname === '/payment/query') {
    const t = sim.tx[JSON.parse(opts.body).tran_ref];
    return t ? reply(ptTx(t)) : reply({ code: 4, message: 'Invalid tran_ref' }, 400);
  }
  if (u.pathname === '/v1/checkouts' && opts.method === 'POST') {
    const p = new URLSearchParams(opts.body);
    const id = `${crypto.randomBytes(8).toString('hex').toUpperCase()}.uat01`;
    sim.checkouts[id] = { amount: p.get('amount'), currency: p.get('currency'), mtid: p.get('merchantTransactionId'), entity: p.get('entityId'), code: '000.200.000' };
    return reply({ id, result: { code: '000.200.100', description: 'successfully created checkout' } });
  }
  let m = u.pathname.match(/^\/v1\/checkouts\/(.+)\/payment$/);
  if (m) {
    const c = sim.checkouts[decodeURIComponent(m[1])];
    if (!c) return reply({ result: { code: '200.300.404', description: 'invalid' } });
    return reply({ id: `PAY-${m[1]}`, paymentType: 'DB', amount: c.amount, currency: c.currency, merchantTransactionId: c.mtid, result: { code: c.code, description: 'x' }, card: { bin: '420000', last4Digits: '0000' } });
  }
  m = u.pathname.match(/^\/v1\/payments\/(.+)$/);
  if (m) { const p = new URLSearchParams(opts.body); return reply({ id: 'RF-1', paymentType: p.get('paymentType'), amount: p.get('amount'), currency: p.get('currency'), result: { code: sim.refundOk ? '000.100.110' : '800.100.100', description: 'r' } }); }
  return reply({ message: 'not found' }, 404);
}

const setPaytabs = () => pay.saveGateway(ctx, { provider: 'paytabs', mode: 'test', hold_minutes: '30', pt_region: 'JOR', pt_profile_id: '98765', pt_server_key: SERVER_KEY });
const setHyperpay = () => pay.saveGateway(ctx, { provider: 'hyperpay', mode: 'test', hold_minutes: '30', hp_entity_card: '8ac7a4c9aaaaaaaaaaaaaaaaaaaaaaaa', hp_entity_mada: '8ac7a4c9bbbbbbbbbbbbbbbbbbbbbbbb', hp_access_token: 'T0K3N' });
const signBody = (body) => crypto.createHmac('sha256', SERVER_KEY).update(body).digest('hex');
const invoicesOf = (apptId) => knex('invoices').where({ appointment_id: apptId }).select('id', 'payment_method', 'amount');

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  http.setFetch(fakeFetch);
  ctx = await makeClinic(`pay${tag}@t.test`, 'Pay clinic');
  await knex('businesses').where({ id: ctx.businessId }).update({ slug: `pay-${tag}` });
  businesses.forget(ctx.businessId);
  clinic = await businesses.get(ctx.businessId);
  doctorId = await doctors.saveDoctor(ctx, null, {
    full_name: 'د. ليلى حداد', full_name_en: 'Dr. Layla Haddad', slot_duration_minutes: '20', consultation_fee: '20', base_salary: '0', is_active: '1',
    online_form: '1', online_enabled: '1', online_fee: '30', online_duration_minutes: '20', online_method: 'builtin',
    ow: { sun: { enabled: '1', s1: '09:00', e1: '13:00' } },
  });
  day = nextSunday();
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { http.setFetch(null); server.close(); await knex.destroy(); });

test('signatures: PayTabs callback HMAC over the raw body, return fields sorted like http_build_query', () => {
  const c = paytabs.client({ region: 'JOR', profileId: '1', serverKey: SERVER_KEY });
  const body = Buffer.from('{"tran_ref":"TST1","cart_id":"x","payment_result":{"response_status":"A"}}');
  assert.equal(c.verifyCallback(body, signBody(body)), true);
  assert.equal(c.verifyCallback(body, signBody(Buffer.from(`${body} `))), false, 'a changed body fails');
  assert.equal(c.verifyCallback(body, ''), false);
  const fields = { tranRef: 'TST1', cartId: 'DB1-abc', respStatus: 'A', respMessage: 'Authorised ok', acquirerRRN: '', customerEmail: 'a+b@x.com' };
  const q = 'cartId=DB1-abc&customerEmail=a%2Bb%40x.com&respMessage=Authorised+ok&respStatus=A&tranRef=TST1';
  const signature = crypto.createHmac('sha256', SERVER_KEY).update(q).digest('hex');
  assert.equal(c.verifyReturn({ ...fields, signature }), true);
  assert.equal(c.verifyReturn({ ...fields, respStatus: 'D', signature }), false, 'tampered status');
  // HyperPay result codes
  assert.equal(hyperpay.statusOf('000.000.000'), 'paid');
  assert.equal(hyperpay.statusOf('000.100.110'), 'paid');
  assert.equal(hyperpay.statusOf('000.200.000'), 'pending');
  assert.equal(hyperpay.statusOf('800.100.151'), 'failed');
  assert.equal(hyperpay.amountOf(12.5), '12.50');
});

test('gateway settings: secrets encrypted, kept when left empty, never shown', async () => {
  await setPaytabs();
  const row = await knex('payment_gateways').where({ business_id: ctx.businessId }).first();
  assert.ok(!row.credentials_enc.includes(SERVER_KEY), 'the key is not stored in clear');
  await pay.saveGateway(ctx, { provider: 'paytabs', mode: 'test', hold_minutes: '45', pt_region: 'JOR', pt_profile_id: '98765', pt_server_key: '' });
  const gw = await pay.gateway(ctx.businessId);
  assert.equal(gw.creds.serverKey, SERVER_KEY, 'empty field keeps the saved key');
  assert.equal(gw.holdMinutes, 45);
  const view = await pay.gatewayView(ctx.businessId);
  assert.equal(JSON.stringify(view).includes(SERVER_KEY), false);
  assert.equal(view.ready, true);
  await assert.rejects(() => pay.saveGateway(ctx, { provider: 'hyperpay', mode: 'test', hp_entity_card: '', hp_access_token: '' }), (e) => e.code === 'VALIDATION_FAILED');
  const audit = await knex('audit_logs').where({ business_id: ctx.businessId, action: 'payments.gateway_updated' }).orderBy('id', 'desc').first();
  assert.ok(audit && !String(audit.new_values).includes(SERVER_KEY));
});

test('PayTabs: verified callback marks paid once, confirms, one invoice; tampered signature and duplicates change nothing', async () => {
  await setPaytabs();
  const b = await bookOne();
  assert.equal(tele.stateOf(b.row), 'awaiting_payment');
  const started = await pay.start(clinic, b.row, { baseUrl: 'https://clinic.example', state: 'awaiting_payment' });
  assert.match(started.redirectUrl, /^https:\/\/secure-jordan\.paytabs\.com\//);
  const p = await knex('payments').where({ id: started.id }).first();
  assert.equal(p.status, 'initiated');
  assert.equal(Number(p.amount), 30);
  const t = sim.tx[p.provider_ref];
  assert.equal(t.callback, `https://clinic.example/pay/callback/paytabs/${p.public_id}`);

  // Tampered signature: rejected before anything is asked or changed.
  t.status = 'A';
  const body = JSON.stringify(ptTx(t));
  const bad = await pay.paytabsCallback(p.public_id, Buffer.from(body), 'f'.repeat(64));
  assert.equal(bad.status, 401);
  assert.equal((await knex('payments').where({ id: p.id }).first()).status, 'initiated');

  // A body claiming success is not enough: the state comes from /payment/query.
  t.status = 'D';
  const r0 = await pay.paytabsCallback(p.public_id, Buffer.from(body), signBody(body));
  assert.equal(r0.result, 'failed');
  assert.equal((await knex('appointments').where({ id: b.appointmentId }).first()).payment_status, 'unpaid');

  t.status = 'A';
  const r1 = await pay.paytabsCallback(p.public_id, Buffer.from(body), signBody(body));
  assert.equal(r1.result, 'paid');
  const r2 = await pay.paytabsCallback(p.public_id, Buffer.from(body), signBody(body));
  assert.equal(r2.result, 'already');
  const r3 = await pay.paytabsReturn(p.public_id, {});
  assert.equal(r3.result, 'already');
  await Promise.all([pay.verify(p), pay.verify(p), pay.verify(p)]); // concurrent callbacks
  const invs = await invoicesOf(b.appointmentId);
  assert.equal(invs.length, 1, 'exactly one invoice');
  assert.equal(invs[0].payment_method, 'card');
  const a = await knex('appointments').where({ id: b.appointmentId }).first();
  assert.equal(a.payment_status, 'paid');
  assert.equal(a.status, 'confirmed', 'paid consultation is confirmed (not completed)');
  const paid = await knex('payments').where({ id: p.id }).first();
  assert.equal(paid.invoice_id, invs[0].id);
  assert.equal(paid.raw_result.includes('4111 11'), false, 'no card number stored');
  // Nothing more to pay.
  const now = await tele.byToken(b.token);
  await assert.rejects(() => pay.start(clinic, now, { state: tele.stateOf(now) }), (e) => e.code === 'PAY_NOT_DUE');
});

test('PayTabs: amount mismatch is never marked paid; the return path verifies too', async () => {
  await setPaytabs();
  const b = await bookOne();
  const s = await pay.start(clinic, b.row, { baseUrl: 'https://clinic.example', state: 'awaiting_payment' });
  const p = await knex('payments').where({ id: s.id }).first();
  sim.tx[p.provider_ref].status = 'A';
  sim.tx[p.provider_ref].amount = '3.000'; // provider says 3 JOD for a 30 JOD booking
  const r = await pay.paytabsReturn(p.public_id, {});
  assert.equal(r.result, 'mismatch');
  assert.equal((await knex('payments').where({ id: p.id }).first()).status, 'failed');
  assert.equal((await knex('appointments').where({ id: b.appointmentId }).first()).payment_status, 'unpaid');
  assert.equal((await invoicesOf(b.appointmentId)).length, 0);
  // Unknown payment id / wrong provider: nothing happens.
  assert.equal((await pay.paytabsCallback('x'.repeat(32), Buffer.from('{}'), '')).status, 404);
});

test('HyperPay: checkout id must match, success verified with resultCode; failed payment can be retried', async () => {
  await setHyperpay();
  const b = await bookOne();
  const s1 = await pay.start(clinic, b.row, { brand: 'mada', state: 'awaiting_payment' });
  assert.equal(s1.provider, 'hyperpay');
  assert.equal(s1.brandList, 'MADA');
  assert.equal(sim.checkouts[s1.checkoutId].entity, '8ac7a4c9bbbbbbbbbbbbbbbbbbbbbbbb', 'mada uses its own entity');
  assert.equal(sim.checkouts[s1.checkoutId].amount, '30.00');
  const wrong = await pay.hyperpayReturn(s1.publicId, 'SOMEOTHERCHECKOUT.uat01');
  assert.equal(wrong.result, 'failed');
  sim.checkouts[s1.checkoutId].code = '800.100.151'; // declined
  assert.equal((await pay.hyperpayReturn(s1.publicId, s1.checkoutId)).result, 'failed');
  assert.equal((await knex('payments').where({ id: s1.id }).first()).status, 'failed');
  // Retry with a card.
  const s2 = await pay.start(clinic, await tele.byToken(b.token), { brand: 'card', state: 'awaiting_payment' });
  sim.checkouts[s2.checkoutId].code = '000.100.110';
  assert.equal((await pay.hyperpayReturn(s2.publicId, s2.checkoutId)).result, 'paid');
  assert.equal((await pay.hyperpayReturn(s2.publicId, s2.checkoutId)).result, 'already');
  assert.equal((await invoicesOf(b.appointmentId)).length, 1);
  const p2 = await knex('payments').where({ id: s2.id }).first();
  assert.equal(p2.provider_payment_id, `PAY-${s2.checkoutId}`);
});

test('refund: through the provider, audited, invoice voided; only once; refused refund changes nothing', async () => {
  await setHyperpay();
  const b = await bookOne();
  const s = await pay.start(clinic, b.row, { state: 'awaiting_payment' });
  sim.checkouts[s.checkoutId].code = '000.000.000';
  await pay.hyperpayReturn(s.publicId, s.checkoutId);
  const staff = { ...ctx, ip: '127.0.0.1' };
  sim.refundOk = false;
  await assert.rejects(() => pay.refund(staff, s.id), (e) => e.code === 'PAY_REFUND_FAILED');
  assert.equal((await knex('payments').where({ id: s.id }).first()).status, 'paid');
  assert.equal((await invoicesOf(b.appointmentId)).length, 1);
  sim.refundOk = true;
  const r = await pay.refund(staff, s.id);
  assert.equal(r.voided, true);
  const p = await knex('payments').where({ id: s.id }).first();
  assert.equal(p.status, 'refunded');
  assert.equal(Number(p.refunded_amount), 30);
  assert.equal((await invoicesOf(b.appointmentId)).length, 0);
  assert.equal((await knex('appointments').where({ id: b.appointmentId }).first()).payment_status, 'unpaid');
  assert.ok(await knex('audit_logs').where({ business_id: ctx.businessId, action: 'payment.refunded', entity_id: String(b.appointmentId) }).first());
  await assert.rejects(() => pay.refund(staff, s.id), (e) => e.code === 'PAY_NOT_REFUNDABLE');
});

test('holds: unpaid online bookings past the hold time are released; recent payment attempts and hold 0 keep them', async () => {
  await setPaytabs();
  const old = await bookOne();
  const trying = await bookOne();
  const fresh = await bookOne();
  const past = new Date(Date.now() - 45 * 60_000);
  await knex('appointments').whereIn('id', [old.appointmentId, trying.appointmentId]).update({ created_at: past });
  await pay.start(clinic, trying.row, { state: 'awaiting_payment' }); // the patient is on the payment page right now
  await pay.expireHolds(Date.now());
  const st = async (id) => (await knex('appointments').where({ id }).first()).status;
  assert.equal(await st(old.appointmentId), 'cancelled');
  assert.equal(await st(trying.appointmentId), 'pending');
  assert.equal(await st(fresh.appointmentId), 'pending');
  assert.ok(await knex('audit_logs').where({ business_id: ctx.businessId, action: 'payment.hold_expired', entity_id: String(old.appointmentId) }).first());
  // The released time can be booked again.
  const slots = await tele.onlineSlots(clinic, doctorId, day);
  assert.ok(slots.includes(old.row.appointment_time));
  // hold 0 = never released
  await knex('payment_gateways').where({ business_id: ctx.businessId }).update({ hold_minutes: 0 });
  await knex('appointments').where({ id: fresh.appointmentId }).update({ created_at: past });
  await pay.expireHolds(Date.now());
  assert.equal(await st(fresh.appointmentId), 'pending');
});

test('a late or duplicate payment is kept and flagged for a refund, never a second invoice', async () => {
  await setPaytabs();
  const b = await bookOne();
  const s1 = await pay.start(clinic, b.row, { state: 'awaiting_payment' });
  const p1 = await knex('payments').where({ id: s1.id }).first();
  const s2 = await pay.start(clinic, b.row, { state: 'awaiting_payment' }); // second tab: the first attempt is closed
  const p2 = await knex('payments').where({ id: s2.id }).first();
  assert.equal((await knex('payments').where({ id: p1.id }).first()).status, 'cancelled');
  sim.tx[p1.provider_ref].status = 'A';
  sim.tx[p2.provider_ref].status = 'A';
  assert.equal(await pay.verify(p1), 'paid'); // the patient paid in the first tab after all
  assert.equal(await pay.verify(p2), 'paid');
  const n2 = await knex('payments').where({ id: p2.id }).first();
  assert.equal(n2.note, 'duplicate');
  assert.equal((await invoicesOf(b.appointmentId)).length, 1);
  assert.ok(await knex('notifications').where({ business_id: ctx.businessId, type: 'payment.problem' }).first());
});

test('bidi: mixed Arabic/English lines are split into runs in visual order', () => {
  const runs = visualRuns('الجرعة 500mg مرتين', 'rtl');
  assert.deepEqual(runs.map((r) => r.font), ['ar', 'lat', 'ar']);
  assert.equal(runs[1].text, '500mg');
  assert.equal(runs[0].text, ' مرتين', 'Arabic runs are kept in logical order for the shaper');
  assert.equal(paragraphDir('Paracetamol بعد الأكل'), 'ltr');
  assert.equal(paragraphDir('بعد الأكل Paracetamol'), 'rtl');
  assert.equal(paragraphDir('123'), null);
  // Brackets of a right-to-left run are mirrored here, because the shaper reverses the run without mirroring.
  assert.deepEqual(visualRuns('(بعد)', 'rtl').map((r) => r.text), [')بعد(']);
});

test('documents: prescription and report PDFs are valid, with a text layer; shared ones open only with the right link', async () => {
  const b = await bookOne();
  const staff = { ...ctx, permissions: new Set([...ctx.permissions]) };
  await clinical.saveNote(staff, b.appointmentId, { diagnosis: 'Acute sinusitis', assessment: 'Viral, likely', plan_text: 'Saline spray twice a day. Review in one week.', subjective: 'Headache for five days' });
  const rxId = await clinical.prescribe(staff, b.appointmentId, { items: [{ medicationName: 'Amoxicillin 500mg', dosage: '1 capsule', frequency: 'every 8 hours', duration: '7 days', instructions: 'after food' }, { medicationName: 'باراسيتامول', dosage: 'قرص', frequency: 'عند اللزوم' }], diagnosis: 'Acute sinusitis' });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const textOf = async (buf) => {
    const d = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, isEvalSupported: false, disableFontFace: true }).promise;
    const out = [];
    for (let i = 1; i <= d.numPages; i += 1) out.push((await (await d.getPage(i)).getTextContent()).items.map((x) => x.str).join(' ')); // eslint-disable-line no-await-in-loop
    return { pages: d.numPages, text: out.join('\n') };
  };
  const rx = await docs.render(staff, b.appointmentId, { kind: 'prescription', ref_id: rxId }, 'en');
  assert.equal(rx.pdf.subarray(0, 5).toString(), '%PDF-');
  const rt = await textOf(rx.pdf);
  assert.equal(rt.pages, 1);
  for (const s of ['Prescription', 'Amoxicillin 500mg', 'Sara Haddad', 'Dr. Layla Haddad', 'every 8 hours', 'Prescribed after an online']) assert.ok(rt.text.includes(s), `text layer has "${s}"`);
  const rep = await docs.render(staff, b.appointmentId, { kind: 'report', options: { sections: ['diagnosis', 'plan_text'] } }, 'en');
  const pt = await textOf(rep.pdf);
  assert.ok(pt.text.includes('Acute sinusitis') && pt.text.includes('Saline spray'));
  assert.equal(pt.text.includes('Headache'), false, 'sections the doctor did not choose are left out');
  // Arabic document: renders and embeds the Arabic font.
  const ar = await docs.render(staff, b.appointmentId, { kind: 'prescription', ref_id: rxId }, 'ar');
  assert.ok(ar.pdf.includes(Buffer.from('NotoNaskhArabic')));
  // Long notes flow onto more pages.
  const long = await docs.render(staff, b.appointmentId, { kind: 'report', options: { sections: ['plan_text'] } }, 'en');
  assert.equal((await textOf(long.pdf)).pages, 1);
  await clinical.saveNote(staff, b.appointmentId, { plan_text: 'Rest and fluids. '.repeat(400) });
  assert.ok((await textOf((await docs.render(staff, b.appointmentId, { kind: 'report', options: { sections: ['plan_text'] } }, 'en')).pdf)).pages >= 2);

  // Share → visible with this consultation's link only.
  await assert.rejects(() => docs.share(staff, b.appointmentId, {}), (e) => e.code === 'VALIDATION_FAILED');
  const r = await docs.share(staff, b.appointmentId, { rx: [String(rxId)], report: '1', sections: ['diagnosis'], locale: 'en', email: '0' });
  assert.equal(r.shared, 2);
  const shared = await docs.sharedList(ctx.businessId, b.appointmentId);
  const other = await bookOne();
  const res = await fetch(`${base}/c/${b.token}/docs/${shared[0].id}.pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal((await fetch(`${base}/c/${other.token}/docs/${shared[0].id}.pdf`)).status, 404, 'another patient\'s link cannot open it');
  assert.equal((await fetch(`${base}/c/${'A'.repeat(43)}/docs/${shared[0].id}.pdf`)).status, 404);
  const page = await (await fetch(`${base}/c/${b.token}`)).text();
  assert.ok(page.includes(`/c/${b.token}/docs/${shared[0].id}.pdf`), 'listed under "Your documents"');
  assert.equal((await knex('patient_documents').where({ id: shared[0].id }).first()).downloads, 1);
  assert.ok(await knex('audit_logs').where({ business_id: ctx.businessId, action: 'patient_docs.downloaded', entity_id: String(b.appointmentId) }).first());
  await docs.revoke(staff, b.appointmentId, shared[0].id);
  assert.equal((await fetch(`${base}/c/${b.token}/docs/${shared[0].id}.pdf`)).status, 404, 'withdrawn documents are gone');
});

test('patient page: "Pay online" appears with a gateway and redirects through /pay/<id>', async () => {
  await setPaytabs();
  const b = await bookOne();
  const res = await fetch(`${base}/c/${b.token}`);
  const html = await res.text();
  assert.ok(html.includes(`action="/c/${b.token}/pay"`));
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const post = await fetch(`${base}/c/${b.token}/pay`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, brand: 'card' }) });
  assert.equal(post.status, 303);
  const loc = post.headers.get('location');
  assert.match(loc, /^\/pay\/[A-Za-z0-9_-]{32}$/);
  const page = await (await fetch(base + loc, { headers: { cookie } })).text();
  assert.ok(page.includes('https://secure-jordan.paytabs.com/payment/page/'));
  // PayTabs posts the browser back (no CSRF token): verified on the server, then back to the patient page.
  const pid = loc.split('/').pop();
  const p = await knex('payments').where({ public_id: pid }).first();
  sim.tx[p.provider_ref].status = 'A';
  const back = await fetch(`${base}/pay/return/paytabs/${pid}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'tranRef=x' });
  assert.equal(back.status, 303);
  assert.equal(back.headers.get('location'), `/c/${b.token}?pay=paid`);
  // Server callback over HTTP with the raw body signature.
  const body = JSON.stringify({ tran_ref: p.provider_ref, payment_result: { response_status: 'A' } });
  const cb = await fetch(`${base}/pay/callback/paytabs/${pid}`, { method: 'POST', headers: { 'content-type': 'application/json', signature: signBody(body) }, body });
  assert.equal(cb.status, 200);
  assert.equal((await cb.json()).result, 'already');
  const tampered = await fetch(`${base}/pay/callback/paytabs/${pid}`, { method: 'POST', headers: { 'content-type': 'application/json', signature: signBody(body) }, body: body.replace('"A"', '"D"') });
  assert.equal(tampered.status, 401);
  assert.equal((await invoicesOf(b.appointmentId)).length, 1);
});
