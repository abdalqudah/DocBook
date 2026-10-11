// CRM → bulk e-mail: a campaign is created, CRM contacts (by filter) and pasted addresses are added (no duplicates, no
// unsubscribed address), a test e-mail goes out, and the minute timer sends within the campaign's hourly and daily
// limits and the platform's overall limit; the unsubscribe link stops every later e-mail to that address.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const mailer = require('../src/core/mailer');
const campaigns = require('../src/modules/crm/campaigns.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `pcamp-${k}-${tag}@t.test`;
let app; let saved; const sent = [];
const real = { send: mailer.send, configuredFor: mailer.configuredFor };

test.before(async () => {
  await knex.migrate.latest();
  saved = await knex('platform_settings').where({ key: campaigns.KEY }).first();
  await knex('platform_settings').where({ key: campaigns.KEY }).del();
  await knex('mail_campaigns').where({ status: 'sending' }).update({ status: 'paused' }); // left by an earlier run
  const admin = await knex.transaction((trx) => auth.createUser(trx, { name: 'Camp Admin', email: mail('a'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: admin }).update({ is_platform_admin: true, email_verified_at: new Date() });
  await knex('crm_contacts').insert([1, 2, 3, 4].map((i) => ({ kind: 'prospect', name: `Camp Dr ${i} ${tag}`, organization: `Clinic ${i}`, email: mail(`c${i}`), stage: i === 4 ? 'lost' : 'new', country: 'JO' })));
  mailer.configuredFor = async () => true;
  mailer.send = async (m) => { sent.push(m); return true; };
  app = await serve();
});
test.after(async () => {
  Object.assign(mailer, real);
  await knex('mail_campaigns').where('name', 'like', `%${tag}%`).del();
  await knex('mail_unsubscribes').where('email', 'like', `%${tag}%`).del();
  await knex('crm_contacts').where('name', 'like', `Camp Dr % ${tag}`).del();
  await knex('platform_settings').where({ key: campaigns.KEY }).del();
  if (saved) await knex('platform_settings').insert(saved);
  await app.close(); await knex.destroy();
});

test('a campaign: recipients by filter and pasted, a test e-mail, then sent within its limits; unsubscribe stops it', async () => {
  const a = app.agent(); await a.login(mail('a'));
  let page = await a.get('/admin/crm/campaigns?lang=en');
  assert.equal(page.status, 200);
  assert.match(page.text, /href="\/admin\/crm\/campaigns" class="[^"]*active/, 'the sidebar entry is active');
  await a.post('/admin/crm/campaigns/settings', { _csrf: a.csrf(page.text), per_hour: '3', per_day: '50' });
  assert.deepEqual(await campaigns.settings(), { per_hour: 3, per_day: 50 });

  page = await a.get('/admin/crm/campaigns/new?lang=en');
  const bad = await a.post('/admin/crm/campaigns/new', { _csrf: a.csrf(page.text), name: '', subject: 'x', body: 'y', per_hour: '10', per_day: '5' });
  assert.equal(bad.status, 422);
  let r = await a.post('/admin/crm/campaigns/new', { _csrf: a.csrf(page.text), name: `Launch ${tag}`, locale: 'ar', subject: 'أهلاً {name}', body: 'عرض خاص لـ {organization}', cta_label: 'جرّب مجاناً', cta_url: 'https://medworks.app/signup', per_hour: '2', per_day: '3' });
  assert.equal(r.status, 302);
  const id = Number(r.location.split('/').pop());
  page = await a.get(`/admin/crm/campaigns/${id}?lang=en&q=${tag}`);
  assert.match(page.text, new RegExp(`Camp Dr 1 ${tag}`));
  // every contact matching the filter (stage new: 3 of 4), and pasted addresses (one already in, one invalid)
  r = await a.post(`/admin/crm/campaigns/${id}/recipients`, { _csrf: a.csrf(page.text), scope: 'filter', q: tag, stage: 'new' });
  assert.equal((await knex('mail_campaign_recipients').where({ campaign_id: id })).length, 3);
  await a.post(`/admin/crm/campaigns/${id}/recipients`, { _csrf: a.csrf(page.text), scope: 'ticked', emails: `${mail('c1')}\nOther Doc <${mail('x')}>\nnot-an-email` });
  const rows = await knex('mail_campaign_recipients').where({ campaign_id: id }).orderBy('id');
  assert.equal(rows.length, 4);
  assert.equal(rows[3].name, 'Other Doc'); assert.equal(rows[3].contact_id, null);

  await a.post(`/admin/crm/campaigns/${id}/test`, { _csrf: a.csrf(page.text), test_to: mail('me') });
  assert.equal(sent.length, 1); assert.equal(sent[0].to, mail('me'));
  assert.equal((await knex('mail_campaign_recipients').where({ campaign_id: id, status: 'sent' })).length, 0, 'a test is not counted');

  await a.post(`/admin/crm/campaigns/${id}/start`, { _csrf: a.csrf(page.text) });
  assert.equal((await knex('mail_campaigns').where({ id }).first()).status, 'sending');
  sent.length = 0;
  const t0 = new Date();
  // per_hour 2 → one a minute; the campaign's hourly limit (2) stops the third minute
  await campaigns.tick(t0); await campaigns.tick(new Date(t0.getTime() + 60_000)); await campaigns.tick(new Date(t0.getTime() + 120_000));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].subject, `أهلاً Camp Dr 1 ${tag}`);
  assert.match(sent[0].html, /عرض خاص لـ Clinic 1/);
  assert.match(sent[0].html, /href="https:\/\/medworks\.app\/signup"/);
  const first = await knex('mail_campaign_recipients').where({ campaign_id: id, email: mail('c1') }).first();
  assert.match(sent[0].html, new RegExp(`/unsubscribe/${first.token}`));
  assert.equal(sent[0].headers['List-Unsubscribe'].includes(first.token), true);
  assert.equal((await knex('crm_activities').where({ kind: 'email' }).whereIn('contact_id', knex('crm_contacts').where({ email: mail('c1') }).select('id'))).length, 1, 'logged on the contact');

  // the third address unsubscribes from its link before its turn
  const third = await knex('mail_campaign_recipients').where({ campaign_id: id, status: 'queued' }).orderBy('id').first();
  const v = app.agent();
  const un = await v.get(`/unsubscribe/${third.token}?lang=en`);
  assert.equal(un.status, 200); assert.match(un.text, /Stop promotional e-mails/);
  await v.post(`/unsubscribe/${third.token}`, { _csrf: v.csrf(un.text) });
  assert.ok(await knex('mail_unsubscribes').where({ email: third.email }).first());
  assert.equal((await knex('mail_campaign_recipients').where({ id: third.id }).first()).status, 'skipped');
  assert.equal((await app.agent().get(`/unsubscribe/${'0'.repeat(40)}`)).status, 404);

  // an hour later: the daily limit (3) lets one more go, then the campaign is done and the admin is told
  await campaigns.tick(new Date(t0.getTime() + 61 * 60_000));
  assert.equal(sent.length, 3);
  assert.equal((await knex('mail_campaigns').where({ id }).first()).status, 'done');
  assert.ok(await knex('platform_notifications').where({ kind: 'campaign_done', dedupe_key: `campaign_done:${id}` }).first());

  // an unsubscribed address cannot be added to another campaign
  const id2 = await campaigns.create({ userId: null }, { name: `Second ${tag}`, subject: 's', body: 'b', per_hour: '10', per_day: '10' });
  const add = await campaigns.addRecipients({ userId: null }, id2, { emails: `${third.email}\n${mail('new')}` });
  assert.deepEqual(add, { added: 1, skipped: 1 });
});

test('the platform limit covers every campaign together', async () => {
  await campaigns.saveSettings({ userId: null }, { per_hour: '1', per_day: '1' });
  const ids = [];
  for (const k of ['p', 'q']) { // eslint-disable-line no-restricted-syntax
    const id = await campaigns.create({ userId: null }, { name: `Limit ${k} ${tag}`, subject: 's', body: 'b', per_hour: '60', per_day: '100' }); // eslint-disable-line no-await-in-loop
    await campaigns.addRecipients({ userId: null }, id, { emails: `${mail(`${k}1`)}\n${mail(`${k}2`)}` }); // eslint-disable-line no-await-in-loop
    await campaigns.setStatus({ userId: null }, id, 'start'); // eslint-disable-line no-await-in-loop
    ids.push(id);
  }
  await knex('mail_campaign_recipients').where('sent_at', '>', new Date(Date.now() - 86_400_000)).whereNotIn('campaign_id', ids).update({ sent_at: new Date(Date.now() - 2 * 86_400_000) }); // the first test's sends out of the window
  sent.length = 0;
  await campaigns.tick(new Date());
  assert.equal(sent.length, 1, 'one e-mail in total across both campaigns');
  for (const id of ids) await campaigns.setStatus({ userId: null }, id, 'cancel'); // eslint-disable-line no-restricted-syntax, no-await-in-loop
  assert.equal((await knex('mail_campaign_recipients').whereIn('campaign_id', ids).where({ status: 'queued' })).length, 0);
});
