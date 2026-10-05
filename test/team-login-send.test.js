// Team → send sign-in details: by e-mail to the person's own address (sign-in address, username, a one-time link to
// set the password, valid 72 hours), or by WhatsApp — a ready wa.me message to their own number — only for members
// the clinic may manage fully; never a password in clear text. Audited.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const mailer = require('../src/core/mailer');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (n) => `${n}-${tag}@ls.test`;
const sent = [];
let app; let bid; let rec; let nophone; let shared;

async function member(roleKey, name, phone) {
  const id = await knex.transaction((trx) => auth.createUser(trx, { name, email: mail(name), password: 'Passw0rd!x' }));
  await knex('users').where({ id }).update({ email_verified_at: new Date(), last_business_id: bid, phone: phone || null });
  const [mid] = await knex('memberships').insert({ business_id: bid, user_id: id, role_id: (await rbac.getRoleByKey(bid, roleKey)).id, status: 'active' });
  rbac.invalidate(bid);
  return { userId: id, membershipId: mid };
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  mailer.configured = () => true;
  mailer.send = async (m) => { sent.push(m); return true; };
  const uid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Owner', email: mail('owner'), password: 'Passw0rd!x' }));
  bid = await knex.transaction((trx) => businesses.create(uid, { name: 'عيادة الدخول', currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  await knex('businesses').where({ id: bid }).update({ onboarding_completed_at: new Date(), slug: `ls${tag}`.slice(0, 40), country: 'JO' });
  await knex('users').where({ id: uid }).update({ email_verified_at: new Date(), last_business_id: bid });
  rec = await member('receptionist', 'rec', '0791234567');
  nophone = await member('nurse', 'nophone');
  shared = await member('accountant', 'shared', '0797654321');
  const other = await knex.transaction((trx) => businesses.create(uid, { name: 'Other', currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  await knex('memberships').insert({ business_id: other, user_id: shared.userId, role_id: (await rbac.getRoleByKey(other, 'accountant')).id, status: 'active' });
  await knex('users').where({ id: uid }).update({ last_business_id: bid });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

const post = async (agent, path, body) => { const page = await agent.get('/app/clinic/team'); return agent.post(path, { _csrf: agent.csrf(page.text), ...body }); };

test('WhatsApp: a ready message to the member\'s own number with a one-time link', async () => {
  const o = app.agent(); await o.login(mail('owner'));
  const page = await o.get('/app/clinic/team');
  assert.match(page.text, /data-open-dialog="send-dialog"/);
  const r = await post(o, `/app/clinic/team/${rec.membershipId}/send-login`, { channel: 'whatsapp' });
  assert.equal(r.status, 302);
  assert.match(r.location, /^https:\/\/wa\.me\/962791234567\?text=/);
  const text = decodeURIComponent(r.location.split('text=')[1]);
  assert.ok(text.includes(mail('rec')), 'the username');
  assert.match(text, /\/reset\/[A-Za-z0-9_-]{20,}/, 'a link to set the password');
  assert.ok(text.includes(`/ls${tag}/login`.slice(0, 20)), 'the clinic sign-in address');
  assert.doesNotMatch(text, /Passw0rd/);
  const pr = await knex('password_resets').where({ user_id: rec.userId }).orderBy('id', 'desc').first();
  assert.ok(new Date(pr.expires_at) - Date.now() > 70 * 3600_000);
  assert.ok(await knex('audit_logs').where({ business_id: bid, action: 'staff.login_details_sent', entity_id: rec.userId }).first('id'));
  // no number → asked to add one; shared account → e-mail only (no link handed to the clinic)
  let x = await post(o, `/app/clinic/team/${nophone.membershipId}/send-login`, { channel: 'whatsapp' });
  assert.equal(x.status, 422);
  x = await post(o, `/app/clinic/team/${shared.membershipId}/send-login`, { channel: 'whatsapp' });
  assert.notEqual(x.status, 302);
  assert.ok(!String(x.location || '').startsWith('https://wa.me'));
});

test('e-mail: one person, or the whole team / a group, each to their own address', async () => {
  const o = app.agent(); await o.login(mail('owner'));
  sent.length = 0;
  let r = await post(o, `/app/clinic/team/${shared.membershipId}/send-login`, { channel: 'email' });
  assert.equal(r.status, 302);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, mail('shared'), 'only to the person\'s own address');
  assert.match(sent[0].html, /reset\//);
  sent.length = 0;
  r = await post(o, '/app/clinic/team/send-logins', { group: 'all' });
  assert.equal(r.status, 302);
  assert.deepEqual(sent.map((m) => m.to).sort(), [mail('nophone'), mail('rec'), mail('shared')].sort(), 'everyone but the sender');
  sent.length = 0;
  await post(o, '/app/clinic/team/send-logins', { group: 'nurses' });
  assert.deepEqual(sent.map((m) => m.to), [mail('nophone')]);
});
