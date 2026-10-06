const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, staffAgent, agent, outbox } = require('./helpers');

const form = async (a, url, body) => { const t = await a.token(); return a.post(url).type('form').send({ _csrf: t, ...body }); };
const tokenOf = async (a, url) => /name="_csrf" value="([^"]+)"/.exec((await a.get(url)).text)[1];
let marketing;
test.before(async () => { await resetDb(); await require('../src/db/seeds/demo-catalog').run(); marketing = await makeStaff({ role: 'marketing' }); });
test.after(() => knex.destroy());

test('newsletter: double opt-in — nobody is subscribed until they press the button in the e-mail', async () => {
  const v = await agent();
  assert.match((await v.get('/?lang=en')).text, /action="\/newsletter"/, 'footer form');
  let t = await tokenOf(v, '/newsletter');
  await v.post('/newsletter').type('form').send({ _csrf: t, email: 'bot@spam.test', consent: '1', website: 'http://x' });
  assert.equal(await knex('newsletter_subscribers').where({ email: 'bot@spam.test' }).first(), undefined, 'honeypot');
  t = await tokenOf(v, '/newsletter');
  const noConsent = await v.post('/newsletter').type('form').send({ _csrf: t, email: 'rana@example.com' });
  assert.equal(noConsent.status, 422);
  const before = outbox.length;
  t = await tokenOf(v, '/newsletter');
  const r = await v.post('/newsletter').type('form').send({ _csrf: t, email: 'Rana@Example.com', name: 'Rana', interests: ['GB', 'CA'], degree: 'master', consent: '1', from: 'footer' });
  assert.equal(r.headers.location, '/newsletter?sent=1');
  const s = await knex('newsletter_subscribers').where({ email: 'rana@example.com' }).first();
  assert.equal(s.status, 'pending');
  const mail = outbox.slice(before).find((m) => m.to === 'rana@example.com');
  const link = /\/newsletter\/confirm\/([A-Za-z0-9_-]+)/.exec(mail.html);
  assert.ok(link);
  // Opening the link (as a mail scanner would) does not confirm.
  const page = await v.get(link[0]);
  assert.equal(page.status, 200);
  assert.equal((await knex('newsletter_subscribers').where({ id: s.id }).first()).status, 'pending');
  t = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  await v.post(link[0]).type('form').send({ _csrf: t });
  const c = await knex('newsletter_subscribers').where({ id: s.id }).first();
  assert.equal(c.status, 'confirmed');
  assert.equal(c.confirm_token, null, 'link works once');
  assert.equal((await v.get(link[0])).status, 404);
  // Subscribing again does not reveal or reset anything.
  t = await tokenOf(v, '/newsletter');
  await v.post('/newsletter').type('form').send({ _csrf: t, email: 'rana@example.com', consent: '1' });
  assert.equal((await knex('newsletter_subscribers').where({ id: s.id }).first()).status, 'confirmed');
});

test('campaign to newsletter subscribers: only confirmed addresses, filters apply, unsubscribe works everywhere', async () => {
  await knex('newsletter_subscribers').insert([
    { email: 'pending@example.com', status: 'pending', manage_token: 'm'.repeat(30), interests: '["GB"]' },
    { email: 'gone@example.com', status: 'unsubscribed', manage_token: 'n'.repeat(30), interests: '["GB"]' },
    { email: 'de@example.com', status: 'confirmed', manage_token: 'o'.repeat(30), interests: '["DE"]', confirmed_at: new Date() },
  ]);
  const m = await staffAgent(marketing);
  await form(m, '/staff/campaigns', { name: 'UK scholarships', channel: 'email', audience: 'subscribers', countries: ['GB'], subject_en: 'New UK scholarships', body_en: 'Hello {{first_name}}, new scholarships are open.' });
  const camp = await knex('campaigns').where({ name: 'UK scholarships' }).first();
  assert.equal((typeof camp.segment === 'string' ? JSON.parse(camp.segment) : camp.segment).audience, 'subscribers');
  const view = await m.get(`/staff/campaigns/${camp.id}?lang=en`);
  assert.match(view.text, /1 /, 'preview counts one person');
  const campaigns = require('../src/modules/growth/campaigns.service');
  assert.equal(await campaigns.launch({ userId: null }, camp.id), 1);
  const rec = await knex('campaign_recipients').where({ campaign_id: camp.id }).first();
  assert.equal(rec.address, 'rana@example.com');
  assert.ok(rec.subscriber_id);
  const before = outbox.length;
  await campaigns.tick();
  const sent = outbox.slice(before).find((x) => x.to === 'rana@example.com');
  assert.ok(sent);
  assert.match(sent.html, /Hello Rana/);
  assert.match(sent.html, /\/u\//);
  assert.equal((await knex('campaign_recipients').where({ id: rec.id }).first()).status, 'sent');
  // SMS/WhatsApp campaigns cannot target subscribers (e-mail only).
  assert.equal((await campaigns.preview({ audience: 'subscribers' }, 'sms')).count, 0);
  // One-click unsubscribe from the e-mail.
  const v = await agent();
  await v.post(`/u/${rec.token}`).type('form').send({ 'List-Unsubscribe': 'One-Click' });
  assert.equal((await knex('newsletter_subscribers').where({ email: 'rana@example.com' }).first()).status, 'unsubscribed');
});

test('a lead who unsubscribes from a campaign is also removed from the newsletter', async () => {
  const campaigns = require('../src/modules/growth/campaigns.service');
  await knex('newsletter_subscribers').where({ email: 'de@example.com' }).update({ status: 'confirmed' });
  const stage = await knex('lead_stages').first('id');
  const [leadId] = await knex('leads').insert({ ref: 'L-P16', first_name: 'Dana', email: 'de@example.com', consent_marketing: true, stage_id: stage.id });
  const [cid] = await knex('campaigns').insert({ name: 'x', slug: 'x', channel: 'email', status: 'sent', segment: '{}' });
  const [rid] = await knex('campaign_recipients').insert({ campaign_id: cid, lead_id: leadId, address: 'de@example.com', token: 't'.repeat(30) });
  assert.ok(rid);
  await campaigns.unsubscribe('t'.repeat(30));
  assert.equal((await knex('newsletter_subscribers').where({ email: 'de@example.com' }).first()).status, 'unsubscribed');
});

test('staff: subscribers list + CSV export, manage link unsubscribes, UTM builder with results', async () => {
  const m = await staffAgent(marketing);
  const list = await m.get('/staff/subscribers?lang=en');
  assert.equal(list.status, 200);
  assert.match(list.text, /rana@example\.com/);
  const csv = await m.get('/staff/subscribers/export.csv');
  assert.match(csv.text, /email,name/);
  assert.match(csv.text, /rana@example\.com/);

  const v = await agent();
  const s = await knex('newsletter_subscribers').where({ email: 'pending@example.com' }).first();
  await knex('newsletter_subscribers').where({ id: s.id }).update({ status: 'confirmed' });
  const t = await tokenOf(v, `/newsletter/manage/${s.manage_token}`);
  await v.post(`/newsletter/manage/${s.manage_token}`).type('form').send({ _csrf: t });
  assert.equal((await knex('newsletter_subscribers').where({ id: s.id }).first()).status, 'unsubscribed');

  await form(m, '/staff/utm', { name: 'Instagram UK', url: '/programs?country=GB', utm_source: 'Instagram', utm_medium: 'social', utm_campaign: 'UK Sep 2027' });
  const l = await knex('utm_links').where({ name: 'Instagram UK' }).first();
  assert.equal(l.utm_source, 'instagram');
  assert.equal(l.utm_campaign, 'uk_sep_2027');
  await form(m, '/staff/utm', { name: 'Bad', url: 'javascript:alert(1)', utm_source: 'x', utm_medium: 'y', utm_campaign: 'z' });
  assert.equal(await knex('utm_links').where({ name: 'Bad' }).first(), undefined);
  const stage = await knex('lead_stages').first('id');
  await knex('leads').insert({ ref: 'L-UTM1', first_name: 'Omar', utm_source: 'instagram', utm_medium: 'social', utm_campaign: 'uk_sep_2027', stage_id: stage.id });
  const page = await m.get('/staff/utm?lang=en');
  assert.match(page.text, /programs\?country=GB&amp;utm_source=instagram&amp;utm_medium=social&amp;utm_campaign=uk_sep_2027/);
  assert.match(page.text, /<td class="text-end num" data-label="Leads">1<\/td>/);
  const c = await staffAgent(await makeStaff({ role: 'counsellor' }));
  assert.equal((await c.get('/staff/subscribers')).status, 403);
});
