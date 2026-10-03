// Insurance statements: one company's invoices for the period with the insurer's share (from the payment parts),
// Excel / PDF exports, e-mail to the company with both attached, logged and audited; other companies and other
// clinics stay out. Also: partial deliveries count in the P&L memo, and the e-mail logo keeps its proportions.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const mailer = require('../src/core/mailer');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `ic-${k}-${tag}@t.test`;
let app; let B; let ins; let other; let pid;
const sent = [];
let n = 700000;

async function inv(b, { amount, provider, providerName, insurer, at = '2026-09-10T09:00:00Z', patient = 'خالد' }) {
  n += 1;
  const [id] = await knex('invoices').insert({ business_id: b, invoice_number: n, patient_id: pid, patient_name: patient, doctor_name: 'د. سامي', service_name: 'كشفية', amount, payment_method: insurer ? 'mixed' : 'cash', insurance_provider_id: provider, insurance_provider_name: providerName, insurance_coverage_percent: insurer ? 80 : null, created_at: new Date(at) });
  const parts = insurer ? [{ method: 'insurance', amount: insurer }, { method: 'cash', amount: amount - insurer }] : [{ method: 'cash', amount }];
  await knex('invoice_payments').insert(parts.map((p) => ({ business_id: b, invoice_id: id, ...p })));
  return id;
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const owner = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: mail('o'), password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'عيادة التأمين', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: owner }).update({ email_verified_at: new Date() });
  ({ last_business_id: B } = await knex('users').where({ id: owner }).first('last_business_id'));
  await knex('businesses').where({ id: B }).update({ onboarding_completed_at: new Date() });
  [ins] = await knex('insurance_providers').insert({ business_id: B, name: 'نات هيلث', coverage_percent: 80, is_active: true, email: 'claims@nathealth.test' });
  [other] = await knex('insurance_providers').insert({ business_id: B, name: 'MedNet', coverage_percent: 70, is_active: true });
  [pid] = await knex('patients').insert({ business_id: B, full_name: 'خالد', phone: '0790000001', insurance_provider_id: ins, insurance_number: 'NH-55521' });
  await inv(B, { amount: 50, provider: ins, providerName: 'نات هيلث', insurer: 40 });
  await inv(B, { amount: 25.5, provider: ins, providerName: 'نات هيلث', insurer: 20.4, at: '2026-09-30T22:30:00Z' }); // 1 Oct in Amman → not September
  await inv(B, { amount: 30, provider: other, providerName: 'MedNet', insurer: 21 });
  await inv(B, { amount: 15, provider: null, providerName: null }); // no insurance
  mailer.configuredFor = async () => true;
  mailer.send = async (m) => { sent.push(m); return true; };
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('the statement: only this company, only the period (clinic days), insurer share from the payment parts', async () => {
  const o = app.agent(); await o.login(mail('o'));
  const page = await o.get(`/app/insurance-claims?provider=${ins}&from=2026-09-01&to=2026-09-30`);
  assert.equal(page.status, 200);
  assert.match(page.text, /NH-55521/);
  assert.match(page.text, /40\.000/);
  assert.doesNotMatch(page.text, /20\.400/); // 1 October in Amman
  assert.doesNotMatch(page.text, /21\.000/); // MedNet
  const sum = await o.get('/app/insurance-claims?from=2026-09-01&to=2026-09-30');
  assert.match(sum.text, /MedNet/);
  const x = await o.get(`/app/insurance-claims/${ins}/export?format=xlsx&from=2026-09-01&to=2026-09-30`);
  assert.equal(x.status, 200);
  assert.match(x.type, /spreadsheetml/);
  const p = await o.get(`/app/insurance-claims/${ins}/export?format=pdf&from=2026-09-01&to=2026-09-30`);
  assert.match(p.type, /application\/pdf/);
  assert.equal(p.body.slice(0, 4).toString(), '%PDF');
});

test('e-mailed to the company with PDF and Excel attached; logged and audited', async () => {
  const o = app.agent(); await o.login(mail('o'));
  const page = await o.get(`/app/insurance-claims?provider=${ins}&from=2026-09-01&to=2026-10-31`);
  sent.length = 0;
  const r = await o.post(`/app/insurance-claims/${ins}/send`, { _csrf: o.csrf(page.text), from: '2026-09-01', to: '2026-10-31', email_to: 'claims@nathealth.test' });
  assert.equal(r.status, 302);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'claims@nathealth.test');
  assert.deepEqual(sent[0].attachments.map((a) => a.contentType), ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
  const log = await knex('insurance_statements').where({ business_id: B, action: 'email' }).first();
  assert.equal(log.invoices, 2);
  assert.equal(Number(log.total), 60.4);
  assert.ok(await knex('audit_logs').where({ business_id: B, action: 'insurance_statement.emailed' }).first());
  // A company of another clinic is never reachable.
  const x = await knex.transaction(async (trx) => { const id = await auth.createUser(trx, { name: 'X', email: mail('x'), password: 'Passw0rd!x' }); await businesses.create(id, { name: 'Other', currency: 'JOD', timezone: 'Asia/Amman' }, trx); return id; });
  await knex('users').where({ id: x }).update({ email_verified_at: new Date() });
  const { last_business_id: B2 } = await knex('users').where({ id: x }).first('last_business_id');
  await knex('businesses').where({ id: B2 }).update({ onboarding_completed_at: new Date() });
  const xa = app.agent(); await xa.login(mail('x'));
  assert.equal((await xa.get(`/app/insurance-claims/${ins}/export?format=xlsx`)).status, 404);
});

test('the e-mail logo keeps its proportions (fitted, not squeezed)', async () => {
  // 400×100 PNG header is enough for the size reader.
  const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0); png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(400, 16); png.writeUInt32BE(100, 20);
  await knex('businesses').where({ id: B }).update({ logo: png, logo_mime: 'image/png', logo_version: 7 });
  const clinic = await knex('businesses').where({ id: B }).first('id', 'name', 'slug', 'logo_mime', 'logo_version');
  await mailer.warmLogo(clinic);
  const html = mailer.layout({ locale: 'ar', title: 'x', body: 'y', clinic, base: 'https://clinic.example' });
  assert.match(html, /width="170" height="43"/);
});
