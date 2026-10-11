// The platform's own pages: /demo (a request lands in the CRM as a prospect from the website, with the request on its
// timeline and a follow-up today; the same phone again is the same contact), /switch (free setup, training and data
// migration) and /clinic-management-system (a long page with FAQ structured data), all linked from every public page.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let app;
test.before(async () => { await knex.migrate.latest(); app = await serve(); });
test.after(async () => {
  await knex('crm_contacts').where('organization', 'like', `%${tag}%`).del();
  await app.close(); await knex.destroy();
});

test('book a demo: the form, its checks, the CRM prospect and the admin notification; a robot is ignored', async () => {
  const v = app.agent();
  let page = await v.get('/demo?lang=en');
  assert.equal(page.status, 200); assert.match(page.text, /<h1>See MedWorks on your own clinic<\/h1>/);
  assert.match(page.text, /Free setup, training and data migration with every subscription/);
  const bad = await v.post('/demo', { _csrf: v.csrf(page.text), name: '', clinic: `Clinic ${tag}`, phone: '12' });
  assert.equal(bad.status, 422); assert.match(bad.text, /Enter your name\./); assert.match(bad.text, /Enter a valid mobile number/);
  assert.match(bad.text, new RegExp(`value="Clinic ${tag}"`), 'what was typed stays');
  const r = await v.post('/demo', { _csrf: v.csrf(page.text), name: 'Dr. Sami', clinic: `Smile Center ${tag}`, phone: '+962 79 555 7788', email: `sami-${tag}@clinic.test`, country: 'JO', city: 'Amman', specialty: 'Dental', doctors: '1', current: '2', how: '0', when: '1', message: 'Insurance claims please' });
  assert.equal(r.status, 303); assert.equal(r.location, '/demo?sent=1');
  const c = await knex('crm_contacts').where({ organization: `Smile Center ${tag}` }).first();
  assert.equal(c.kind, 'prospect'); assert.equal(c.source, 'website'); assert.equal(c.stage, 'new'); assert.equal(c.country, 'JO');
  assert.ok(c.next_action_at, 'a follow-up is due');
  const act = await knex('crm_activities').where({ contact_id: c.id }).first();
  assert.match(act.body, /Specialty: Dental/); assert.match(act.body, /Number of doctors: 2–5 doctors/); assert.match(act.body, /Another system/); assert.match(act.body, /Insurance claims please/);
  assert.ok(await knex('platform_notifications').where({ kind: 'demo_request' }).where('link', `/admin/crm/${c.id}`).first());
  const done = await v.get('/demo?sent=1&lang=en');
  assert.match(done.text, /Thank you, we got your request/);
  // the same phone written another way: the same contact, a second request on its timeline
  page = await v.get('/demo?lang=ar');
  await v.post('/demo', { _csrf: v.csrf(page.text), name: 'سامي', clinic: `Smile Center ${tag} 2`, phone: '0795557788' });
  assert.equal((await knex('crm_contacts').where('organization', 'like', `Smile Center ${tag}%`)).length, 1);
  assert.equal((await knex('crm_activities').where({ contact_id: c.id })).length, 2);
  // the hidden field filled in: nothing saved
  await v.post('/demo', { _csrf: v.csrf(page.text), name: 'Bot', clinic: `Bot ${tag}`, phone: '0791111111', website: 'http://spam.test' });
  assert.equal(await knex('crm_contacts').where({ organization: `Bot ${tag}` }).first(), undefined);
});

test('/switch and /clinic-management-system: content, FAQ structured data, links from the footer and pricing', async () => {
  const v = app.agent();
  const sw = await v.get('/switch?lang=ar');
  assert.equal(sw.status, 200);
  assert.match(sw.text, /الإعداد والتدريب ونقل البيانات مشمولة في الاشتراك/);
  assert.match(sw.text, /"@type":"FAQPage"/);
  const cms = await v.get('/clinic-management-system?lang=en');
  assert.equal(cms.status, 200);
  assert.match(cms.text, /<h1>Clinic management system for clinics and medical centres/);
  assert.match(cms.text, /Online appointment booking/); assert.match(cms.text, /Chronic disease follow-up/);
  assert.match(cms.text, /"@type":"FAQPage"/); assert.doesNotMatch(cms.text, /name="robots" content="noindex/);
  const home = await v.get('/?lang=en');
  for (const href of ['/demo', '/switch', '/clinic-management-system']) assert.match(home.text, new RegExp(`href="${href}"`));
  const pricing = await v.get('/pricing?lang=en');
  assert.match(pricing.text, /Free setup, training and data migration with every subscription/);
  const map = await v.get('/sitemap.xml');
  if (map.status === 200 && /\/pricing</.test(map.text)) assert.match(map.text, /\/clinic-management-system</);
});
