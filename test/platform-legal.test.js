// The platform's Privacy Policy and Terms of Service: public pages in Arabic and English, linked from every public
// page's footer and from sign-up; the privacy policy says which Google data is used (as Google's review asks).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const { serve } = require('./_http');

let app;
test.before(async () => { await knex.migrate.latest(); app = await serve(); });
test.after(async () => { await app.close(); await knex.destroy(); });

test('privacy and terms: both languages, the Google data use, linked from the home page and sign-up', async () => {
  const v = app.agent();
  const p = await v.get('/privacy?lang=en');
  assert.equal(p.status, 200);
  assert.match(p.text, /<h1>Privacy Policy<\/h1>/);
  assert.match(p.text, /Google API Services User Data Policy, including the Limited Use requirements/);
  assert.match(p.text, /gmail\.send/); assert.match(p.text, /drive\.file/);
  assert.match(p.text, /<link rel="canonical" href="[^"]*\/privacy[^"]*"/);
  const ar = await v.get('/privacy?lang=ar');
  assert.match(ar.text, /<h1>سياسة الخصوصية<\/h1>/); assert.match(ar.text, /الاستخدام المحدود/);
  const t = await v.get('/terms?lang=en');
  assert.equal(t.status, 200); assert.match(t.text, /<h1>Terms of Service<\/h1>/); assert.match(t.text, /Hashemite Kingdom of Jordan/);
  const home = await v.get('/?lang=en');
  assert.match(home.text, /href="\/privacy">Privacy Policy<\/a>/); assert.match(home.text, /href="\/terms">Terms of Service<\/a>/);
  const signup = await v.get('/signup?lang=en');
  assert.match(signup.text, /I agree to the <a class="link" href="\/terms"/);
});
