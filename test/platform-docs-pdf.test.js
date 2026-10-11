// A ready PDF (a presentation, a brochure) uploaded as a document: it gets its own link with the message above the
// file, the file opens in the browser sandboxed (or downloads), only PDFs are taken, and the message stays editable.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `ppdf-${k}-${tag}@t.test`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let app;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const admin = await knex.transaction((trx) => auth.createUser(trx, { name: 'Pdf Admin', email: mail('a'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: admin }).update({ is_platform_admin: true, email_verified_at: new Date() });
  app = await serve();
});
test.after(async () => {
  await knex('sales_documents').where('title', 'like', `%${tag}%`).del();
  await app.close(); await knex.destroy();
});

test('a PDF becomes a document with its link and message; other files are refused', async () => {
  const a = app.agent(); await a.login(mail('a'));
  const list = await a.get('/admin/documents?lang=en');
  assert.match(list.text, /action="\/admin\/documents\/upload"/);
  const bad = await a.upload('/admin/documents', '/admin/documents/upload', { title: `Bad ${tag}` }, { file: { buffer: Buffer.from('not a pdf'), name: 'x.pdf' } });
  assert.equal(bad.status, 302);
  assert.equal(await knex('sales_documents').where({ title: `Bad ${tag}` }).first('id'), undefined);
  const r = await a.upload('/admin/documents', '/admin/documents/upload', { title: `Deck SA ${tag}`, body: `Try MedWorks free for 14 days ${tag}` }, { file: { buffer: PDF, name: 'deck-sa.pdf' } });
  assert.equal(r.status, 302);
  const d = await knex('sales_documents').where({ title: `Deck SA ${tag}` }).first();
  assert.equal(d.filename, 'deck-sa.pdf');
  const pub = await app.agent().get(`/document/${d.token}?lang=en`);
  assert.match(pub.text, new RegExp(`Try MedWorks free for 14 days ${tag}`));
  assert.match(pub.text, new RegExp(`href="/document/${d.token}/download"`));
  const file = await app.agent().get(`/document/${d.token}/download`);
  assert.equal(file.type, 'application/pdf');
  assert.match(file.csp, /sandbox/);
  assert.equal(file.body.slice(0, 5).toString(), '%PDF-');
  const page = await a.get(`/admin/documents/${d.id}?lang=en`);
  await a.post(`/admin/documents/${d.id}`, { _csrf: a.csrf(page.text), title: `Deck SA ${tag}`, body: `New message ${tag}` });
  assert.equal((await knex('sales_documents').where({ id: d.id }).first('body')).body, `New message ${tag}`);
});
