// The platform's sales (Admin → Quotations, Services, Seller details, Invoices, E-mail log): a quotation with lines and
// VAT, sent by e-mail and WhatsApp, opened on its link (counted), negotiated, answered by the team, accepted with a drawn
// signature (the CRM contact becomes a customer); declined with a reason; a subscription invoice's link; the e-mail
// log; and on signup the welcome e-mail with the account in the CRM.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const mailer = require('../src/core/mailer');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const welcome = require('../src/modules/crm/welcome.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `psales-${k}-${tag}@t.test`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const realSend = mailer.send;
let app; let sent = []; let contactId; let bid; const quoteIds = [];

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const admin = await knex.transaction((trx) => auth.createUser(trx, { name: 'Sales Admin', email: mail('a'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: admin }).update({ is_platform_admin: true, email_verified_at: new Date() });
  const owner = await knex.transaction((trx) => auth.createUser(trx, { name: 'Invoice Owner', email: mail('o'), password: 'Passw0rd!x' }));
  bid = await knex.transaction((trx) => businesses.create(owner, { name: `عيادة الفواتير ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  await knex('businesses').where({ id: bid }).update({ phone: '0790000000', country: 'JO' });
  [contactId] = await knex('crm_contacts').insert({ kind: 'prospect', name: `Dr Quote ${tag}`, organization: 'Quote Clinic', email: mail('c'), whatsapp: '0791234567', country: 'JO', stage: 'interested' });
  mailer.send = async (o) => { sent.push(o); return true; };
  app = await serve();
});
test.after(async () => {
  mailer.send = realSend;
  if (quoteIds.length) await knex('quotes').whereIn('id', quoteIds).del();
  await knex('document_sends').where({ doc_type: 'invoice' }).whereIn('doc_id', knex('platform_invoices').where({ business_id: bid }).select('id')).del();
  await knex('crm_contacts').where({ id: contactId }).orWhere({ business_id: bid }).del();
  await knex('email_log').where('to_addr', 'like', `psales-%-${tag}@t.test`).del();
  cache.forgetPrefix('');
  if (app) await app.close();
  await knex.destroy();
});

const lines = (csrf, extra = []) => [['_csrf', csrf], ['contact_id', String(contactId)], ['customer_name', 'Dr Quote'], ['customer_email', mail('c')], ['customer_phone', '0791234567'],
  ['item_description', 'MedWorks Pro — yearly'], ['item_quantity', '1'], ['item_price', '300'], ['item_service_id', ''],
  ['item_description', 'Setup and training'], ['item_quantity', '2'], ['item_price', '50'], ['item_service_id', ''],
  ['discount', '20'], ['tax_rate', '16'], ['currency', 'JOD'], ['locale', 'en'], ...extra];

test('a quotation: totals, sent by e-mail and WhatsApp, opened, negotiated, answered, revised and accepted with a signature', async () => {
  const a = app.agent(); await a.login(mail('a'));
  let page = await a.get(`/admin/quotes/new?contact=${contactId}&lang=en`);
  assert.equal(page.status, 200); assert.match(page.text, /data-quote-form/); assert.match(page.text, new RegExp(`Dr Quote ${tag}`));
  let r = await a.post('/admin/quotes/new', [['_csrf', a.csrf(page.text)], ['customer_name', '']]);
  assert.equal(r.status, 422);
  r = await a.post('/admin/quotes/new', lines(a.csrf(page.text)));
  assert.equal(r.status, 302);
  const id = Number(r.location.split('/').pop()); quoteIds.push(id);
  let q = await knex('quotes').where({ id }).first();
  assert.match(q.number, /^Q-\d{4}-\d{4}$/);
  assert.equal(Number(q.subtotal), 400); assert.equal(Number(q.discount), 20); assert.equal(Number(q.tax), 60.8); assert.equal(Number(q.total), 440.8);
  assert.equal(q.status, 'draft');
  // a draft's link is not public
  const anon = app.agent();
  assert.equal((await anon.get(`/quote/${q.token}`)).status, 404);

  page = await a.get(`/admin/quotes/${id}?lang=en`);
  assert.equal(page.status, 200); assert.match(page.text, new RegExp(`/quote/${q.token}`));
  sent = [];
  r = await a.post(`/admin/quotes/${id}/email`, { _csrf: a.csrf(page.text), to: mail('c'), subject: 'Your quotation', body: 'Please see the quotation.', locale: 'en' });
  assert.equal(r.status, 302);
  assert.equal(sent.length, 1); assert.equal(sent[0].to, mail('c')); assert.match(sent[0].html, new RegExp(`/quote/${q.token}`));
  q = await knex('quotes').where({ id }).first();
  assert.equal(q.status, 'sent');
  r = await a.post(`/admin/quotes/${id}/whatsapp`, { _csrf: a.csrf(page.text), phone: '0791234567', locale: 'en' }, { accept: 'application/json' });
  assert.equal(r.status, 200);
  const wa = JSON.parse(r.text);
  assert.ok(wa.ok); assert.match(wa.href, /^https:\/\/wa\.me\/962791234567\?text=/);
  const sends = await knex('document_sends').where({ doc_type: 'quote', doc_id: id }).orderBy('id');
  assert.deepEqual(sends.map((s) => `${s.channel}:${s.status}`), ['email:sent', 'whatsapp:opened']);
  const timeline = await knex('crm_activities').where({ contact_id: contactId }).pluck('kind');
  assert.ok(timeline.includes('quote') && timeline.includes('email') && timeline.includes('whatsapp'));

  // the customer opens it (counted; the team's views are not), and negotiates
  let pub = await anon.get(`/quote/${q.token}`);
  assert.equal(pub.status, 200); assert.match(pub.text, /data-sign-pad/); assert.match(pub.text, /440\.8/);
  await a.get(`/quote/${q.token}`);
  q = await knex('quotes').where({ id }).first();
  assert.equal(q.view_count, 1); assert.ok(q.first_viewed_at);
  pub = await anon.get(`/quote/${q.token}?tab=negotiate`);
  r = await anon.post(`/quote/${q.token}/negotiate`, { _csrf: anon.csrf(pub.text), name: 'Dr Quote', amount: '400', message: 'Can you do 400?' });
  assert.equal(r.status, 302);
  assert.equal((await knex('quotes').where({ id }).first('status')).status, 'negotiating');
  // the team replies and revises on the same link
  page = await a.get(`/admin/quotes/${id}?lang=en`);
  assert.match(page.text, /Can you do 400\?/);
  await a.post(`/admin/quotes/${id}/reply`, { _csrf: a.csrf(page.text), message: 'We can do 420.' });
  const form = await a.get(`/admin/quotes/${id}/edit?lang=en`);
  assert.match(form.text, /Save revision/);
  r = await a.post(`/admin/quotes/${id}/edit`, lines(a.csrf(form.text), [['revision_note', 'Discount raised']]).map(([k, v]) => [k, k === 'discount' ? '40' : v]));
  assert.equal(r.status, 302);
  q = await knex('quotes').where({ id }).first();
  assert.equal(q.revision, 2); assert.equal(Number(q.total), 417.6);
  assert.deepEqual(await knex('quote_events').where({ quote_id: id }).orderBy('id').pluck('type'), ['negotiation', 'reply', 'revised']);

  // accept: name, signature and agreement required
  pub = await anon.get(`/quote/${q.token}`);
  assert.match(pub.text, /We can do 420\./); assert.match(pub.text, /Discount raised/);
  r = await anon.post(`/quote/${q.token}/accept`, { _csrf: anon.csrf(pub.text), name: 'Dr Quote', signature: 'data:image/png;base64,AAAA', agree: '1' });
  assert.equal(r.status, 422);
  sent = [];
  r = await anon.post(`/quote/${q.token}/accept`, { _csrf: anon.csrf(pub.text), name: 'Dr Quote', title: 'Owner', signature: PNG, agree: '1' });
  assert.equal(r.status, 302);
  q = await knex('quotes').where({ id }).first();
  assert.equal(q.status, 'accepted'); assert.equal(q.response_name, 'Dr Quote'); assert.ok(q.signature.length > 8);
  assert.ok(sent.some((m) => m.to === mail('c')), 'a copy to the customer');
  assert.equal((await knex('crm_contacts').where({ id: contactId }).first('stage')).stage, 'customer');
  const sig = await anon.get(`/quote/${q.token}/signature.png`);
  assert.equal(sig.status, 200); assert.match(sig.type, /image\/png/);
  pub = await anon.get(`/quote/${q.token}`);
  assert.match(pub.text, /data-quote-accepted/); assert.doesNotMatch(pub.text, /data-sign-pad/);
  r = await anon.post(`/quote/${q.token}/decline`, { _csrf: anon.csrf(pub.text), reason: 'price' });
  assert.equal(r.status, 409, 'answered once');
  // locked; a copy starts a new draft
  r = await a.post(`/admin/quotes/${id}/edit`, lines(a.csrf(form.text)));
  assert.equal(r.status, 409);
  r = await a.post(`/admin/quotes/${id}/duplicate`, { _csrf: a.csrf(page.text) });
  const copy = Number(r.location.split('/').slice(-2)[0]); quoteIds.push(copy);
  assert.equal((await knex('quotes').where({ id: copy }).first('status')).status, 'draft');
  // the CRM contact lists its quotations
  const cpage = await a.get(`/admin/crm/${contactId}?lang=en`);
  assert.match(cpage.text, /data-crm-quotes/); assert.match(cpage.text, new RegExp(q.number));
  const list = await a.get('/admin/quotes?state=accepted&lang=en');
  assert.match(list.text, new RegExp(q.number));
});

test('a quotation declined with a reason; services and seller details', async () => {
  const a = app.agent(); await a.login(mail('a'));
  let page = await a.get('/admin/sales-services?lang=en');
  assert.equal(page.status, 200);
  await a.post('/admin/sales-services', { _csrf: a.csrf(page.text), name_ar: `خدمة ${tag}`, name_en: `Service ${tag}`, price: '99', active: '1' });
  const svc = await knex('sales_services').where({ name_ar: `خدمة ${tag}` }).first();
  assert.ok(svc); assert.equal(Number(svc.price), 99); assert.ok(svc.active);
  await a.post('/admin/sales-services', { _csrf: a.csrf(page.text), id: String(svc.id), name_ar: `خدمة ${tag}`, price: '99', active: '0' });
  assert.ok(!(await knex('sales_services').where({ id: svc.id }).first('active')).active);
  await a.post(`/admin/sales-services/${svc.id}/delete`, { _csrf: a.csrf(page.text) });
  assert.equal(await knex('sales_services').where({ id: svc.id }).first('id'), undefined);

  page = await a.get('/admin/sales-profile?lang=en');
  let r = await a.post('/admin/sales-profile', { _csrf: a.csrf(page.text), legal_name_en: 'MedWorks LLC', iban: 'not an iban', tax_rate: '16', valid_days: '15', currency: 'JOD' });
  assert.equal(r.status, 422);
  const saved = await knex('platform_settings').where({ key: 'sales_profile' }).first();
  try {
    r = await a.post('/admin/sales-profile', { _csrf: a.csrf(page.text), legal_name_en: 'MedWorks LLC', iban: 'JO94CBJO0010000000000131000302', tax_rate: '16', valid_days: '15', currency: 'JOD' });
    assert.equal(r.status, 302);
    page = await a.get('/admin/quotes/new?lang=en');
    r = await a.post('/admin/quotes/new', [['_csrf', a.csrf(page.text)], ['customer_name', 'Walk-in'], ['item_description', 'Basic'], ['item_quantity', '1'], ['item_price', '10']]);
    const id = Number(r.location.split('/').pop()); quoteIds.push(id);
    const q = await knex('quotes').where({ id }).first();
    const days = Math.round((new Date(q.valid_until) - new Date(q.issue_date)) / 86_400_000);
    assert.equal(days, 15, 'validity from the seller details');
    await knex('quotes').where({ id }).update({ status: 'sent' });
    const anon = app.agent();
    const pub = await anon.get(`/quote/${q.token}?tab=decline`);
    assert.match(pub.text, /MedWorks LLC/); assert.match(pub.text, /JO94CBJO0010000000000131000302/);
    r = await anon.post(`/quote/${q.token}/decline`, { _csrf: anon.csrf(pub.text), reason: 'nope' });
    assert.equal(r.status, 422);
    r = await anon.post(`/quote/${q.token}/decline`, { _csrf: anon.csrf(pub.text), reason: 'timing', note: 'Next year' });
    assert.equal(r.status, 302);
    const d = await knex('quotes').where({ id }).first();
    assert.equal(d.status, 'declined'); assert.equal(d.decline_reason, 'timing');
  } finally {
    await knex('platform_settings').where({ key: 'sales_profile' }).del();
    if (saved) await knex('platform_settings').insert(saved);
    cache.forgetPrefix('');
  }
});

test('a subscription invoice: its link (counted) and sending it', async () => {
  const [inv] = await knex('platform_invoices').insert({ number: `INV-${tag}`, business_id: bid, plan_name: 'Pro', billing_cycle: 'monthly', period_start: '2026-10-01', period_end: '2026-10-31', amount: 25, currency: 'JOD', status: 'open' });
  const a = app.agent(); await a.login(mail('a'));
  const page = await a.get(`/admin/sales-invoices/${inv}?lang=en`);
  assert.equal(page.status, 200);
  const { share_token: token } = await knex('platform_invoices').where({ id: inv }).first('share_token');
  assert.ok(token); assert.match(page.text, new RegExp(`/invoice/${token}`));
  sent = [];
  const r = await a.post(`/admin/sales-invoices/${inv}/email`, { _csrf: a.csrf(page.text), to: mail('o'), subject: 'Invoice', body: 'Your invoice' });
  assert.equal(r.status, 302); assert.equal(sent.length, 1);
  const pub = await app.agent().get(`/invoice/${token}`);
  assert.equal(pub.status, 200); assert.match(pub.text, new RegExp(`INV-${tag}`));
  assert.equal((await knex('platform_invoices').where({ id: inv }).first('view_count')).view_count, 1);
  assert.equal((await app.agent().get('/invoice/not-a-real-token-at-all-xx')).status, 404);
  const list = await a.get('/admin/sales-invoices?lang=en');
  assert.match(list.text, new RegExp(`INV-${tag}`));
});

test('signup: the account joins the CRM with a welcome e-mail; every e-mail is in the log', async () => {
  sent = [];
  await welcome.onSignup({ businessId: bid, owner: { name: 'Invoice Owner', email: mail('o'), locale: 'en' }, base: 'https://medworks.app' });
  const c = await knex('crm_contacts').where({ business_id: bid }).first();
  assert.ok(c);
  const acts = await knex('crm_activities').where({ contact_id: c.id }).pluck('kind');
  assert.ok(acts.includes('event')); assert.ok(acts.includes('email'));
  assert.equal(sent.length, 1); assert.equal(sent[0].kind, 'welcome'); assert.match(sent[0].subject, /Welcome to MedWorks/); assert.match(sent[0].html, /https:\/\/medworks\.app\/app/);
  // the real mailer (no e-mail set up in tests): logged as not sent
  mailer.send = realSend;
  try { await mailer.send({ kind: 'welcome', to: mail('log'), subject: 'Hello', html: '<p>x</p>' }); } finally { mailer.send = async (o) => { sent.push(o); return true; }; }
  await new Promise((ok) => { setTimeout(ok, 100); });
  const row = await knex('email_log').where({ to_addr: mail('log') }).first();
  assert.ok(row); assert.equal(row.kind, 'welcome');
  const a = app.agent(); await a.login(mail('a'));
  const page = await a.get(`/admin/email-log?q=${encodeURIComponent(mail('log'))}&lang=en`);
  assert.equal(page.status, 200); assert.match(page.text, new RegExp(mail('log').replace(/[.]/g, '\\.')));
});
