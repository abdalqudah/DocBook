// Message texts: the clinic writes its own wording (Arabic / English) and it is what patients get; the e-mail wears the
// clinic's logo / colour and reads right to left in Arabic; where the review link goes (Google or the website).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const texts = require('../src/modules/messaging/texts.service');
const msg = require('../src/modules/messaging/messaging.service');
const mailer = require('../src/core/mailer');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = `mt-${tag}@t.test`;
let app; let businessId;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: mail, password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'عيادة النص', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: userId }).update({ email_verified_at: new Date() });
  ({ last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id'));
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), color: '#1e3a8a' });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('the clinic writes its own messages; empty or unchanged = DocBook text; review link choice', async () => {
  const o = app.agent(); await o.login(mail);
  let r = await o.get('/app/settings/messaging/texts?lang=ar');
  assert.equal(r.status, 200);
  assert.match(r.text, /name="t\[messaging.text.reminder\]\[ar\]"/);
  r = await o.submit('/app/settings/messaging/texts', '/app/settings/messaging/texts', {
    review_target: 'site',
    't[messaging.text.reminder][ar]': 'أهلاً! نذكّرك بموعدك في {clinic} يوم {date} الساعة {time}: {link}',
    't[messaging.text.reminder][en]': '',
    't[share.mail_subject][ar]': 'أوراقك من {clinic}\nسطر',
  });
  assert.equal(r.status, 302);
  const tAr = await texts.translatorFor(businessId, 'ar');
  assert.equal(tAr('messaging.text.reminder', { clinic: 'عيادة النص', date: 'الأحد', time: '10:00', link: 'L' }), 'أهلاً! نذكّرك بموعدك في عيادة النص يوم الأحد الساعة 10:00: L');
  assert.equal(tAr('share.mail_subject', { clinic: 'ع' }), 'أوراقك من ع سطر', 'a one-line field stays on one line');
  const tEn = await texts.translatorFor(businessId, 'en');
  assert.match(tEn('messaging.text.reminder', { clinic: 'C', doctor: 'D', date: 'x', time: 't', link: 'L' }), /^Reminder/i, 'English left empty = DocBook text');
  assert.equal(await texts.reviewTarget(businessId), 'site');
  assert.equal(await texts.googleReviewLink(businessId, { manual: true }), null, 'site = never Google');
  // composeText uses the clinic wording when given its translator.
  assert.match(msg.composeText('reminder', { clinic: 'X', date: 'd', time: 't' }, 'L', 'ar', { t: tAr, stop: false }), /^أهلاً!/);
});

test('patient e-mail: clinic colour and logo, right to left in Arabic', () => {
  const html = mailer.layout({ locale: 'ar', title: 'مستنداتك', body: 'مرحباً', cta: 'فتح', href: 'https://x.test/d/1', base: 'https://doc.test',
    clinic: { name: 'عيادة', color: '#1e3a8a', slug: 'abc', logo_mime: 'image/png', logo_version: 3 } });
  assert.match(html, /<div dir="rtl" style="[^"]*direction:rtl;text-align:right/);
  assert.match(html, /background:#1e3a8a/);
  assert.match(html, /src="https:\/\/doc\.test\/abc\/logo\?v=3"/);
  assert.ok(!/DocBook/.test(html), 'no platform name on a clinic e-mail');
  const en = mailer.layout({ locale: 'en', title: 'T', body: 'B' });
  assert.match(en, /text-align:left/);
});
