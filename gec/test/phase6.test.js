const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { knex, resetDb, makeStaff, staffAgent, agent, outbox } = require('./helpers');

let counsellor; let other; let admin; let finance; let lead; let student;
test.before(async () => {
  await resetDb();
  await require('../src/db/seeds/demo-catalog').run();
  counsellor = await makeStaff({ role: 'counsellor', name: 'Lina Mansour' });
  other = await makeStaff({ role: 'counsellor', name: 'Other Counsellor' });
  admin = await makeStaff({ role: 'super_admin' });
  finance = await makeStaff({ role: 'finance' });
  const leads = require('../src/modules/crm/leads.service');
  ({ lead } = await leads.capture({ userId: null }, { first_name: 'Maya', last_name: 'Haddad', email: 'maya@example.com', phone: '0791234567' }, { source: 'consultation' }, {}));
  await knex('leads').where({ id: lead.id }).update({ counsellor_id: counsellor.employee.id });
  const students = require('../src/modules/crm/students.service');
  student = await students.convertLead({ userId: null }, { employee: { dataScope: 'all' }, permissions: new Set() }, lead.id);
  await knex('students').where({ id: student.id }).update({ counsellor_id: counsellor.employee.id });
});
test.after(() => knex.destroy());

test('channels report "not connected" honestly; e-mail is sent, logged and on the timeline', async () => {
  const a = await staffAgent(counsellor);
  const t = await a.token();
  const page = await a.get(`/staff/students/${student.id}`);
  assert.match(page.text, /id="compose-dialog"/);
  outbox.length = 0;
  let r = await a.post('/staff/messages/send').type('form').send({ _csrf: t, student_id: student.id, channel: 'sms', body: 'Hello Maya' });
  assert.equal(r.status, 302);
  assert.equal(outbox.length, 0, 'nothing pretends to be sent');
  const m1 = await knex('messages').orderBy('id', 'desc').first();
  assert.equal(m1.status, 'not_configured');
  r = await a.post('/staff/messages/send').type('form').send({ _csrf: t, student_id: student.id, channel: 'email', subject: 'Your documents', body: 'Please upload your passport.' });
  assert.equal(r.status, 302);
  assert.equal(outbox.length, 1);
  const m2 = await knex('messages').orderBy('id', 'desc').first();
  assert.equal(m2.status, 'sent'); assert.equal(m2.to_address, 'maya@example.com'); assert.equal(m2.sent_by, counsellor.user.id);
  const act = await knex('activities').where({ student_id: student.id, type: 'email', title: 'message' }).first();
  assert.ok(act, 'on the timeline');
  // template rendering for the composer fills the person's variables
  const rendered = await a.get(`/staff/messages/render?student_id=${student.id}&key=welcome&channel=email`);
  assert.match(rendered.body.body, /Maya Haddad/);
  // another counsellor cannot see or message this student
  const o = await staffAgent(other);
  assert.equal((await o.get(`/staff/messages/${m2.id}`)).status, 404);
  const ot = await o.token();
  assert.equal((await o.post('/staff/messages/send').type('form').send({ _csrf: ot, student_id: student.id, channel: 'email', subject: 'x', body: 'y' })).status, 404);
});

test('connecting SMS stores the token encrypted; numbers are normalised; WhatsApp click-to-chat is logged', async () => {
  const ad = await staffAgent(admin);
  const t = await ad.token();
  const r = await ad.post('/staff/settings/sms').type('form').send({ _csrf: t, enabled: '1', account_sid: 'AC123', auth_token: 'super-secret-token', from_number: '+15550001111', default_country_code: '962' });
  assert.equal(r.status, 302);
  const row = await knex('settings').where({ key: 'integration.sms' }).first();
  const raw = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
  assert.doesNotMatch(raw, /super-secret-token/, 'token is not stored in clear text');
  const audit = await knex('audit_logs').where({ action: 'settings.updated', entity_id: 'integration.sms' }).first();
  assert.doesNotMatch(JSON.stringify(audit), /super-secret-token/);
  outbox.length = 0;
  await ad.post('/staff/messages/send').type('form').send({ _csrf: t, student_id: student.id, channel: 'sms', body: 'Your offer arrived' });
  assert.deepEqual(outbox.map((x) => [x.channel, x.to]), [['sms', '+962791234567']]);
  const wa = await ad.post('/staff/messages/whatsapp-link').type('form').send({ _csrf: t, student_id: student.id, body: 'مرحبا' });
  assert.equal(wa.status, 302);
  assert.match(wa.headers.location, /^https:\/\/wa\.me\/962791234567\?text=/);
  assert.equal((await knex('messages').orderBy('id', 'desc').first()).status, 'manual');
  // the settings page never shows the saved token
  const page = await ad.get('/staff/settings/sms');
  assert.doesNotMatch(page.text, /super-secret-token/);
});

test('webhooks: signatures are required; an unknown WhatsApp sender becomes a lead with the message in the inbox', async () => {
  const ad = await staffAgent(admin);
  const t = await ad.token();
  await ad.post('/staff/settings/whatsapp').type('form').send({ _csrf: t, enabled: '1', phone_number_id: '1234567890', access_token: 'EAAG-token', app_secret: 'app-secret', default_country_code: '962' });
  const a = await agent();
  const s = await knex('settings').where({ key: 'integration.whatsapp' }).first();
  const conf = typeof s.value === 'string' ? JSON.parse(s.value) : s.value;
  const verify = await a.get(`/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=${conf.verify_token}&hub.challenge=42`);
  assert.equal(verify.text, '42');
  assert.equal((await a.get('/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42')).status, 403);
  const body = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '962777000111', profile: { name: 'Omar Saleh' } }], messages: [{ from: '962777000111', id: 'wamid.ABC', type: 'text', text: { body: 'Hi, I want to study in Canada' } }] } }] }] });
  const forged = await a.post('/hooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', 'sha256=deadbeef').send(body);
  assert.equal(forged.status, 401);
  assert.equal(await knex('leads').where({ first_name: 'Omar' }).first(), undefined);
  const sig = `sha256=${crypto.createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
  const okRes = await a.post('/hooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(body);
  assert.equal(okRes.status, 200);
  await a.post('/hooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(body); // provider retry
  const newLead = await knex('leads').where({ first_name: 'Omar' }).first();
  assert.equal(newLead.source, 'whatsapp');
  const inbound = await knex('messages').where({ direction: 'in', lead_id: newLead.id });
  assert.equal(inbound.length, 1, 'retries are not duplicated');
  const page = await ad.get('/staff/messages');
  assert.match(page.text, /Omar Saleh|Omar/);
  await ad.get(`/staff/messages/${inbound[0].id}`);
  assert.ok((await knex('messages').where({ id: inbound[0].id }).first()).read_at, 'opening marks it read');
  // Twilio inbound with a valid signature
  const params = { From: '+962791234567', Body: 'Thanks!', MessageSid: 'SM1' };
  const url = `${require('../src/config').appUrl}/hooks/sms/twilio`;
  const tsig = crypto.createHmac('sha1', 'super-secret-token').update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');
  const tw = await a.post('/hooks/sms/twilio').set('Content-Type', 'application/x-www-form-urlencoded').set('X-Twilio-Signature', tsig).send(new URLSearchParams(params).toString());
  assert.equal(tw.status, 200);
  assert.ok(await knex('messages').where({ direction: 'in', channel: 'sms', student_id: student.id }).first(), 'matched to the existing student by phone');
  assert.equal((await a.post('/hooks/sms/twilio').set('Content-Type', 'application/x-www-form-urlencoded').set('X-Twilio-Signature', 'bad').send('From=1&Body=x')).status, 401);
});

test('templates: an Arabic edit is used for Arabic speakers; reset restores the built-in text', async () => {
  const ad = await staffAgent(admin);
  const t = await ad.token();
  const templates = require('../src/modules/comms/templates');
  await ad.post('/staff/templates/welcome').type('form').send({ _csrf: t, channel: 'email', subject_en: templates.DEFAULTS.welcome.en.subject, body_en: templates.DEFAULTS.welcome.en.body, cta_en: templates.DEFAULTS.welcome.en.cta, subject_ar: 'أهلاً {{student_name}}', body_ar: 'نص مخصص', cta_ar: '' });
  assert.equal((await knex('message_templates').where({ key: 'welcome' })).length, 1, 'unchanged English is not stored');
  assert.equal((await templates.render('welcome', 'ar', { student_name: 'مايا' })).subject, 'أهلاً مايا');
  await ad.post('/staff/templates/welcome/reset').type('form').send({ _csrf: t, channel: 'email' });
  assert.equal((await templates.render('welcome', 'ar', { company_name: 'GEC' })).subject, 'مرحباً بك في GEC');
  const c = await staffAgent(counsellor);
  assert.equal((await c.get('/staff/templates')).status, 403);
});

test('invoices: totals, numbering, issue, partial and full payment, receipt e-mail, public link, refund, void rules', async () => {
  const f = await staffAgent(finance);
  const t = await f.token();
  const r = await f.post('/staff/invoices').type('form').send({ _csrf: t, student_id: student.id, currency: 'USD', locale: 'en', item_description: ['Application service', 'Visa guidance', ''], item_quantity: ['1', '2', '1'], item_unit_price: ['500', '125.50', ''], discount: '51', tax_rate: '10' });
  assert.equal(r.status, 302);
  const inv = await knex('invoices').orderBy('id', 'desc').first();
  assert.match(inv.number, new RegExp(`^INV-${new Date().getUTCFullYear()}-0001$`));
  assert.deepEqual([Number(inv.subtotal), Number(inv.discount), Number(inv.tax), Number(inv.total)], [751, 51, 70, 770]);
  assert.equal(inv.status, 'draft');
  const a = await agent();
  assert.equal((await a.get(`/invoices/${inv.public_token}`)).status, 404, 'drafts are not public');
  assert.equal((await f.post(`/staff/invoices/${inv.id}/payments`).type('form').send({ _csrf: t, amount: '100', method: 'cash' })).status, 302);
  assert.equal(Number((await knex('invoices').where({ id: inv.id }).first()).paid), 0, 'cannot pay a draft');
  await f.post(`/staff/invoices/${inv.id}/issue`).type('form').send({ _csrf: t });
  await f.post(`/staff/invoices/${inv.id}/payments`).type('form').send({ _csrf: t, amount: '800', method: 'cash' });
  assert.equal((await knex('payments').where({ invoice_id: inv.id })).length, 0, 'overpayment refused');
  outbox.length = 0;
  await f.post(`/staff/invoices/${inv.id}/payments`).type('form').send({ _csrf: t, amount: '300', method: 'bank_transfer', reference: 'TRX-1' });
  assert.equal((await knex('invoices').where({ id: inv.id }).first()).status, 'partially_paid');
  await f.post(`/staff/invoices/${inv.id}/payments`).type('form').send({ _csrf: t, amount: '470', method: 'card' });
  const paid = await knex('invoices').where({ id: inv.id }).first();
  assert.equal(paid.status, 'paid'); assert.equal(Number(paid.paid), 770);
  const pays = await knex('payments').where({ invoice_id: inv.id }).orderBy('id');
  assert.deepEqual(pays.map((p) => p.receipt_no), [`RC-${new Date().getUTCFullYear()}-0001`, `RC-${new Date().getUTCFullYear()}-0002`]);
  assert.ok(outbox.some((m) => m.to === 'maya@example.com' && /Payment received/.test(m.subject)), 'payment confirmation e-mailed');
  assert.ok(await knex('activities').where({ student_id: student.id, type: 'payment', title: 'payment_received' }).first());
  const pub = await a.get(`/invoices/${inv.public_token}`);
  assert.equal(pub.status, 200); assert.match(pub.text, /770/);
  assert.equal((await f.post(`/staff/invoices/${inv.id}/void`).type('form').send({ _csrf: t, reason: 'mistake' })).status, 302);
  assert.equal((await knex('invoices').where({ id: inv.id }).first()).status, 'paid', 'cannot void with payments');
  await f.post(`/staff/payments/${pays[1].id}/refund`).type('form').send({ _csrf: t, reason: 'Card chargeback' });
  const after = await knex('invoices').where({ id: inv.id }).first();
  assert.equal(after.status, 'partially_paid'); assert.equal(Number(after.paid), 300);
  const csv = await f.get('/staff/payments?format=csv');
  assert.match(csv.text, /TRX-1/);
  // counsellors have no finance access
  const c = await staffAgent(counsellor);
  assert.equal((await c.get('/staff/invoices')).status, 403);
  assert.equal((await c.get(`/staff/students/${student.id}`)).text.includes('href="?tab=finance"'), false, 'no Finance tab');
  assert.equal((await f.get(`/staff/students/${student.id}`)).status, 200);
});

test('partners and commissions: finance only; enrolling at a partner university creates the expected commission', async () => {
  const program = await knex('programs').where('slug', 'like', 'msc-data-science-university-of-manchester%').first();
  const ad = await staffAgent(admin);
  const t = await ad.token();
  const p = await ad.post('/staff/partners').type('form').send({ _csrf: t, university_id: program.university_id, status: 'active', commission_type: 'percent', commission_rate: '15', currency: 'GBP', payment_terms_days: '60' });
  assert.equal(p.status, 302);
  const apps = require('../src/modules/admissions/applications.service');
  const staffCtx = { employee: { dataScope: 'all', id: 0 }, permissions: new Set() };
  const app = await apps.create({ userId: admin.user.id }, staffCtx, { studentId: student.id, programId: program.id, intake: '2027-09' });
  const enrolled = await knex('application_stages').where({ key: 'enrolled' }).first();
  await apps.moveStage({ userId: admin.user.id }, staffCtx, app.id, enrolled.id);
  const c = await knex('commissions').where({ application_id: app.id }).first();
  assert.ok(c, 'commission expected');
  assert.equal(Number(c.expected_amount), Math.round(Number(program.tuition_fee) * 15) / 100);
  assert.equal(c.currency, program.currency);
  const fin = await staffAgent(finance);
  const ft = await fin.token();
  assert.equal((await fin.get('/staff/commissions')).status, 200);
  await fin.post(`/staff/commissions/${c.id}`).type('form').send({ _csrf: ft, status: 'received', received_amount: '4000', received_on: '2027-11-01' });
  const done = await knex('commissions').where({ id: c.id }).first();
  assert.equal(done.status, 'received'); assert.equal(Number(done.received_amount), 4000);
  const co = await staffAgent(counsellor);
  assert.equal((await co.get('/staff/commissions')).status, 403);
  assert.equal((await co.get('/staff/partners')).status, 403);
});
