// One medical centre without the server's own SMTP: the centre's verified mailbox (Settings → Clinic e-mail) sends
// every e-mail — account e-mails (reset links, sign-in details) too — so "e-mail is not set up" never shows when the
// clinic connected its address. The staff sign-in is /login (old /<address>/login redirects).
process.env.NODE_ENV = 'test';
process.env.APP_EDITION = 'center';
delete process.env.SMTP_HOST;
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const tenant = require('../src/db/tenant');
const mailer = require('../src/core/mailer');
const secrets = require('../src/core/secrets');
const clinicmail = require('../src/modules/clinicmail/clinicmail.service');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const centers = require('../src/modules/center/center.service');
const { mainSlug } = require('../src/middleware/edition');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const out = [];
let app; let main;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  let row = await knex('businesses').whereNot('status', 'deleted').where({ kind: 'center_admin' }).whereNotNull('slug').orderBy('id').first('id', 'slug');
  if (!row) {
    const uid = await knex.transaction((trx) => auth.createUser(trx, { name: 'C', email: `mb-${tag}@t.test`, password: 'Passw0rd!x' }));
    const id = await knex.transaction(async (trx) => {
      const b = await businesses.create(uid, { name: 'مركز البريد', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
      await centers.create({ businessId: b, userId: uid }, { name: 'مركز البريد' }, trx);
      await trx('businesses').where({ id: b }).update({ kind: 'center_admin', onboarding_completed_at: new Date(), status: 'active' });
      return b;
    });
    row = await knex('businesses').where({ id }).first('id', 'slug');
  }
  main = row;
  assert.equal(await mainSlug(), main.slug);
  clinicmail._setBuild(() => ({ sendMail: async (m) => { out.push(m); return { messageId: `t-${out.length}` }; }, close() {} }));
  await tenant.runFor(main.id, () => knex('clinic_mail_accounts').insert({ business_id: main.id, provider: 'smtp', from_address: `info-${tag}@clinic.test`, smtp_host: 'smtp.clinic.test', smtp_port: 465, smtp_security: 'ssl', smtp_user: 'info', secret_enc: secrets.encrypt('pw'), status: 'verified', verified_at: new Date() })
    .onConflict('business_id').merge());
  app = await serve();
});
test.after(async () => {
  await tenant.runFor(main.id, () => knex('clinic_mail_accounts').where({ business_id: main.id }).del());
  if (app) await app.close(); await knex.destroy();
});

test('no server SMTP: the centre\'s mailbox sends account e-mails and counts as "set up"', async () => {
  assert.equal(await mailer.refreshInstallationMailbox(), main.id);
  assert.equal(mailer.configured(), true);
  assert.equal(await mailer.configuredFor(main.id), true);
  assert.equal(await mailer.send({ to: `staff-${tag}@t.test`, subject: 'Reset', html: '<p>x</p>' }), true);
  assert.equal(out.length, 1);
  assert.equal(out[0].to, `staff-${tag}@t.test`);
  assert.equal(out[0].from.address, `info-${tag}@clinic.test`, 'from the clinic\'s own address');
  // disconnected → not set up any more
  await tenant.runFor(main.id, () => knex('clinic_mail_accounts').where({ business_id: main.id }).update({ status: 'failed' }));
  assert.equal(await mailer.refreshInstallationMailbox(), null);
  assert.equal(mailer.configured(), false);
  await tenant.runFor(main.id, () => knex('clinic_mail_accounts').where({ business_id: main.id }).update({ status: 'verified' }));
  await mailer.refreshInstallationMailbox();
});

test('staff sign-in is /login; the old /<address>/login redirects', async () => {
  const r = await app.agent().get(`/${main.slug}/login?as=doctor`);
  assert.equal(r.status, 301);
  assert.equal(r.location, '/login?as=doctor');
  assert.equal((await app.agent().get('/login')).status, 200);
});
