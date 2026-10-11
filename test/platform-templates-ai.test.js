// Document templates (text with {placeholders} → a document for a CRM contact with its own link, sent by e-mail or
// WhatsApp; markup in a template is never rendered) and the AI summary of a CRM contact (structured output, contact
// details removed before sending, kept on the contact; refused politely when the platform's AI is off).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const mailer = require('../src/core/mailer');
const secrets = require('../src/core/secrets');
const auth = require('../src/modules/auth/auth.service');
const insights = require('../src/modules/crm/insights.service');
const AdmZip = require('adm-zip');
const docx = require('../src/core/docx');
const { serve } = require('./_http');

/** A small Word file: a placeholder split across runs (as Word does), a hyperlink and a picture that must survive. */
function wordFile() {
  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
  z.addFile('word/document.xml', Buffer.from('<?xml version="1.0"?><w:document xmlns:w="w"><w:body>'
    + '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Agreement with {comp</w:t></w:r><w:r><w:t>any_name} &amp; partners</w:t></w:r></w:p>'
    + '<w:p><w:hyperlink r:id="rId9"><w:r><w:t>Chat on WhatsApp</w:t></w:r></w:hyperlink></w:p>'
    + '<w:p><w:r><w:t>Plan: {plan}</w:t></w:r></w:p></w:body></w:document>'));
  z.addFile('word/_rels/document.xml.rels', Buffer.from('<Relationships><Relationship Id="rId9" Type="hyperlink" Target="https://wa.me/962790000000" TargetMode="External"/></Relationships>'));
  z.addFile('word/media/image1.png', Buffer.from('PNGDATA'));
  return z.toBuffer();
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `ptpl-${k}-${tag}@t.test`;
const realSend = mailer.send;
let app; let sent = []; let contactId; let savedAi;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  savedAi = await knex('platform_settings').where({ key: 'ai' }).first();
  const admin = await knex.transaction((trx) => auth.createUser(trx, { name: 'Tpl Admin', email: mail('a'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: admin }).update({ is_platform_admin: true, email_verified_at: new Date() });
  [contactId] = await knex('crm_contacts').insert({ kind: 'clinic', name: `Dr Template ${tag}`, organization: `Smile Clinic ${tag}`, email: mail('c'), whatsapp: '0791112233', country: 'JO', stage: 'interested' });
  await knex('crm_activities').insert({ contact_id: contactId, kind: 'call', body: 'Called him on 0791112233, wants the yearly plan. Mail: x@y.com' });
  mailer.send = async (o) => { sent.push(o); return true; };
  app = await serve();
});
test.after(async () => {
  mailer.send = realSend;
  insights.setClient(null);
  await knex('platform_settings').where({ key: 'ai' }).del();
  if (savedAi) await knex('platform_settings').insert(savedAi);
  await knex('sales_documents').where({ contact_id: contactId }).del();
  await knex('document_templates').where('name', 'like', `%${tag}%`).del();
  await knex('document_templates').where('filename', 'agreement.docx').where('name', 'like', `%${tag}%`).del();
  await knex('crm_contacts').where({ id: contactId }).del();
  cache.forgetPrefix('');
  if (app) await app.close();
  await knex.destroy();
});

test('a template made for a CRM contact: placeholders filled, its own link, sent, markup escaped', async () => {
  const a = app.agent(); await a.login(mail('a'));
  let page = await a.get('/admin/templates/new?lang=en');
  assert.equal(page.status, 200); assert.match(page.text, /data-template-form/);
  let r = await a.post('/admin/templates/new', { _csrf: a.csrf(page.text), name: '', body: '' });
  assert.equal(r.status, 422);
  r = await a.post('/admin/templates/new', { _csrf: a.csrf(page.text), name: `Agreement ${tag}`, locale: 'en', active: '1',
    body: '# Service agreement\nBetween **{seller_name}** and {company_name}, on {date}.\n\n- Plan: {plan}\n- Contact: {customer_name}\n<script>alert(1)</script>' });
  assert.equal(r.status, 302);
  const tid = Number(r.location.split('/').pop());
  page = await a.get(`/admin/templates/${tid}?contact=${contactId}&lang=en`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`value="Smile Clinic ${tag}"`), 'company from the CRM');
  assert.doesNotMatch(page.text, /<script>alert/);
  // a field of the template's own must be filled
  const fields = [['_csrf', a.csrf(page.text)], ['contact_id', String(contactId)], ['field_name', 'seller_name'], ['field_value', 'MedWorks'], ['field_name', 'company_name'], ['field_value', `Smile Clinic ${tag}`], ['field_name', 'date'], ['field_value', '11 October 2026'], ['field_name', 'customer_name'], ['field_value', 'Dr Template']];
  r = await a.post(`/admin/templates/${tid}/generate`, [...fields, ['field_name', 'plan'], ['field_value', '']]);
  assert.equal(r.status, 422);
  r = await a.post(`/admin/templates/${tid}/generate`, [...fields, ['field_name', 'plan'], ['field_value', 'Pro yearly']]);
  assert.equal(r.status, 302);
  const did = Number(r.location.split('/').pop());
  const d = await knex('sales_documents').where({ id: did }).first();
  assert.equal(d.contact_id, contactId); assert.match(d.body, /Between \*\*MedWorks\*\* and Smile Clinic/); assert.match(d.body, /Plan: Pro yearly/);

  page = await a.get(`/admin/documents/${did}?lang=en`);
  assert.equal(page.status, 200); assert.match(page.text, new RegExp(`/document/${d.token}`));
  sent = [];
  r = await a.post(`/admin/documents/${did}/email`, { _csrf: a.csrf(page.text), to: mail('c'), subject: 'Your agreement', body: 'Please see the agreement.' });
  assert.equal(r.status, 302); assert.equal(sent.length, 1); assert.match(sent[0].html, new RegExp(`/document/${d.token}`));
  r = await a.post(`/admin/documents/${did}/whatsapp`, { _csrf: a.csrf(page.text) }, { accept: 'application/json' });
  assert.match(JSON.parse(r.text).href, /^https:\/\/wa\.me\/962791112233\?text=/);
  assert.deepEqual((await knex('document_sends').where({ doc_type: 'document', doc_id: did }).orderBy('id')).map((x) => x.channel), ['email', 'whatsapp']);

  const pub = await app.agent().get(`/document/${d.token}`);
  assert.equal(pub.status, 200);
  assert.match(pub.text, /<h2>Service agreement<\/h2>/); assert.match(pub.text, /<strong>MedWorks<\/strong>/); assert.match(pub.text, /<li>Plan: Pro yearly<\/li>/);
  assert.doesNotMatch(pub.text, /<script>alert/); assert.match(pub.text, /&lt;script&gt;alert/);
  assert.equal((await knex('sales_documents').where({ id: did }).first('view_count')).view_count, 1);
  // edited on the same link
  await a.post(`/admin/documents/${did}`, { _csrf: a.csrf(page.text), title: d.title, body: '# Updated agreement' });
  assert.match((await app.agent().get(`/document/${d.token}`)).text, /Updated agreement/);
  for (const p of [`/admin/templates?contact=${contactId}`, '/admin/documents', `/admin/templates/${tid}/edit`]) { // eslint-disable-line no-restricted-syntax
    const x = await a.get(p); // eslint-disable-line no-await-in-loop
    assert.equal(x.status, 200, p); assert.match(x.text, new RegExp(`Agreement ${tag}`), p);
  }
  const cpage = await a.get(`/admin/crm/${contactId}?lang=en`);
  assert.match(cpage.text, /data-crm-docs/); assert.match(cpage.text, new RegExp(`/admin/documents/${did}`));
  await a.post(`/admin/documents/${did}/delete`, { _csrf: a.csrf(page.text) });
  assert.equal((await app.agent().get(`/document/${d.token}`)).status, 404);
});

test('a Word template: placeholders read across runs, filled for a customer; pictures and links kept; downloaded from the link', async () => {
  assert.deepEqual(docx.placeholders(wordFile()).sort(), ['company_name', 'plan']);
  assert.equal(docx.placeholders(Buffer.from('not a zip')), null);
  const a = app.agent(); await a.login(mail('a'));
  let r = await a.upload('/admin/templates?lang=en', '/admin/templates/upload', { name: `Word ${tag}`, locale: 'en' }, { file: { buffer: Buffer.from('hello'), name: 'notes.txt' } });
  assert.equal(r.status, 302); assert.equal(r.location, '/admin/templates');
  assert.equal(await knex('document_templates').where({ name: `Word ${tag}` }).first('id'), undefined);
  r = await a.upload('/admin/templates?lang=en', '/admin/templates/upload', { name: `Word ${tag}`, locale: 'en' }, { file: { buffer: wordFile(), name: 'agreement.docx' } });
  assert.equal(r.status, 302);
  const tid = Number(r.location.split('/').pop());
  const page = await a.get(`/admin/templates/${tid}?contact=${contactId}&lang=en`);
  assert.equal(page.status, 200); assert.match(page.text, /Agreement with \{company_name\}/); assert.match(page.text, /Download Word/);
  r = await a.post(`/admin/templates/${tid}/generate`, [['_csrf', a.csrf(page.text)], ['contact_id', String(contactId)], ['field_name', 'company_name'], ['field_value', 'Smile & Co <1>'], ['field_name', 'plan'], ['field_value', 'Pro']]);
  assert.equal(r.status, 302);
  const did = Number(r.location.split('/').pop());
  const d = await knex('sales_documents').where({ id: did }).first();
  assert.ok(d.file); assert.match(d.filename, /\.docx$/);
  const out = new AdmZip(d.file);
  const xml = out.getEntry('word/document.xml').getData().toString('utf8');
  assert.match(xml, /Agreement with Smile &amp; Co &lt;1&gt; &amp; partners/); assert.match(xml, /<w:b\/>/, 'formatting of the first run kept');
  assert.match(xml, /Chat on WhatsApp/); assert.equal(out.getEntry('word/media/image1.png').getData().toString(), 'PNGDATA');
  assert.match(out.getEntry('word/_rels/document.xml.rels').getData().toString(), /wa\.me\/962790000000/);
  const pub = await app.agent().get(`/document/${d.token}`);
  assert.equal(pub.status, 200); assert.match(pub.text, /data-word-download/);
  const dl = await app.agent().get(`/document/${d.token}/download`);
  assert.equal(dl.status, 200); assert.match(dl.type, /wordprocessingml/); assert.ok(dl.body.length > 100);
  assert.equal((await a.get(`/admin/documents/${did}/download`)).status, 200);
  const edit = await a.get(`/admin/templates/${tid}/edit?lang=en`);
  assert.equal(edit.status, 200); assert.match(edit.text, /Replace the Word file/); assert.doesNotMatch(edit.text, /data-template-body/);
  const show = await a.get(`/admin/documents/${did}?lang=en`);
  assert.equal(show.status, 200); assert.match(show.text, /data-word-download/);
});

test('online templates: pictures uploaded into the text, links and linked icons; nothing else becomes markup', async () => {
  const a = app.agent(); await a.login(mail('a'));
  const r = await a.upload('/admin/templates/new?lang=en', '/admin/templates/images', {}, { file: { buffer: PNG, name: 'logo.png' } });
  assert.equal(r.status, 200);
  const { token, markup } = JSON.parse(r.text);
  assert.match(markup, /^!\[\]\(img:[A-Za-z0-9]+\)$/);
  const img = await app.agent().get(`/document-image/${token}`);
  assert.equal(img.status, 200); assert.match(img.type, /^image\//);
  const bad = await a.upload('/admin/templates/new?lang=en', '/admin/templates/images', {}, { file: { buffer: Buffer.from('<svg onload=alert(1)>'), name: 'x.svg' } });
  assert.equal(bad.status, 422);
  const tpl = require('../src/modules/sales/templates.service'); // eslint-disable-line global-require
  const html = tpl.render(`${markup}\n[Our site](https://medworks.app)\n[icon:whatsapp|Chat](https://wa.me/962790000000) [icon:nope](https://x.y)\n[bad](javascript:alert(1))`);
  assert.match(html, new RegExp(`<img class="doc-img" src="/document-image/${token}"`));
  assert.match(html, /<a href="https:\/\/medworks\.app" target="_blank" rel="noopener">Our site<\/a>/);
  assert.match(html, /class="doc-icon" href="https:\/\/wa\.me\/962790000000"[^>]*><svg class="icon"[^>]*><use href="\/icons\.svg#i-message-circle">/);
  assert.doesNotMatch(html, /href="javascript/); assert.doesNotMatch(html, /i-nope/);
  await knex('template_images').where({ token }).del();
});

test('AI summary of a contact: structured result kept on the contact; contact details removed; off → a clear message', async () => {
  const a = app.agent(); await a.login(mail('a'));
  await knex('platform_settings').where({ key: 'ai' }).del();
  cache.forgetPrefix('');
  let page = await a.get(`/admin/crm/${contactId}?lang=en`);
  assert.match(page.text, /data-crm-ai/); assert.match(page.text, /Switch on the AI/);
  let r = await a.post(`/admin/crm/${contactId}/ai-summary`, { _csrf: a.csrf(page.text) });
  assert.equal(r.status, 302);
  assert.equal((await knex('crm_contacts').where({ id: contactId }).first('ai_summary')).ai_summary, null);

  await knex('platform_settings').insert({ key: 'ai', value: JSON.stringify({ enabled: true, model: 'claude-opus-5-5', api_key_enc: secrets.encrypt('sk-test-key') }) });
  cache.forgetPrefix('');
  const calls = [];
  const result = { summary: 'Interested clinic, asked about the yearly plan.', interest_level: 'high', next_action: 'Send the yearly quotation', suggested_message: 'مرحبا دكتور، هذا عرض الباقة السنوية', risks: ['Price'] };
  insights.setClient({ beta: { messages: { create: async (p) => { calls.push(p); return { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result) }], usage: { input_tokens: 300, output_tokens: 90 } }; } } } });
  page = await a.get(`/admin/crm/${contactId}?lang=en`);
  r = await a.post(`/admin/crm/${contactId}/ai-summary`, { _csrf: a.csrf(page.text) });
  assert.equal(r.status, 302);
  assert.equal(calls.length, 1);
  const sentText = calls[0].messages[0].content;
  assert.match(sentText, /wants the yearly plan/); assert.doesNotMatch(sentText, /0791112233|x@y\.com/);
  assert.equal(calls[0].output_config.format.type, 'json_schema'); assert.equal(calls[0].fallbacks, 'default');
  const saved = JSON.parse((await knex('crm_contacts').where({ id: contactId }).first('ai_summary')).ai_summary);
  assert.equal(saved.interest_level, 'high');
  page = await a.get(`/admin/crm/${contactId}?lang=en`);
  assert.match(page.text, /data-ai-summary/); assert.match(page.text, /Send the yearly quotation/); assert.match(page.text, /Very interested/);
  // a refusal is reported, the last summary kept
  insights.setClient({ beta: { messages: { create: async () => ({ model: 'claude-opus-5-5', stop_reason: 'refusal', stop_details: { category: null }, content: [], usage: { input_tokens: 1, output_tokens: 0 } }) } } });
  await a.post(`/admin/crm/${contactId}/ai-summary`, { _csrf: a.csrf(page.text) });
  assert.equal(JSON.parse((await knex('crm_contacts').where({ id: contactId }).first('ai_summary')).ai_summary).interest_level, 'high');
});
