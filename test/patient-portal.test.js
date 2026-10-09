// Patient portal: the clinic's activation link, sign-in with mobile or e-mail, lock-out, sign-up and reset with a
// one-time code, the patient sees only their own file and only the sections the clinic shows; staff sign-in button.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const svc = require('../src/modules/patientportal/portal.service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let ctx; let clinic; let server; let base; let pa; let pb;

function client() {
  const jar = {}; let csrf = '';
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const read = async (res) => {
    for (const h of res.headers.getSetCookie()) { const [kv] = h.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = await res.text();
    const m = text.match(/name="_csrf" value="([^"]+)"/) || text.match(/name="csrf-token" content="([^"]+)"/); if (m) csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text };
  };
  return {
    get: async (p) => read(await fetch(base + p, { headers: { cookie: cookie(), accept: 'text/html' }, redirect: 'manual' })),
    post: async (p, data = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: csrf, ...data })) body.append(k, v);
      return read(await fetch(base + p, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' }));
    },
  };
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: `pp-own${tag}@t.test`, password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'عيادة البوابة', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), slug: `ppc${tag}` });
  businesses.forget(businessId);
  ctx = { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), locale: 'ar' };
  clinic = { ...(await businesses.get(businessId)), displayName: 'عيادة البوابة' };
  [pa] = await knex('patients').insert({ business_id: businessId, full_name: 'سارة أحمد', phone: '0791111111', email: 'sara@example.com' });
  [pb] = await knex('patients').insert({ business_id: businessId, full_name: 'مريض آخر', phone: '0792222222' });
  await knex('appointments').insert([
    { business_id: businessId, patient_id: pa, patient_name: 'سارة أحمد', appointment_date: '2026-01-10', appointment_time: '10:00', status: 'completed' },
    { business_id: businessId, patient_id: pb, patient_name: 'مريض آخر', appointment_date: '2026-01-11', appointment_time: '11:00', status: 'completed' },
  ]);
  await knex('prescriptions').insert({ business_id: businessId, patient_id: pa, patient_name: 'سارة أحمد', items: JSON.stringify([{ name: 'Amoxicillin 500', frequency: '3x' }]) });
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await knex.destroy(); });

test('off by default: no portal pages; on: sign-in page with the staff button', async () => {
  const c = client();
  assert.equal((await c.get(`/${clinic.slug}/account/login`)).status, 404);
  await svc.saveSettings(ctx, { enabled: '1', self_signup: '1', show_visits: '1', show_prescriptions: '1', show_plan: '1' });
  const r = await c.get(`/${clinic.slug}/account/login?lang=ar`);
  assert.equal(r.status, 200);
  assert.match(r.text, /data-pw-eye/); assert.match(r.text, new RegExp(`href="/${clinic.slug}/login" data-staff-login`)); assert.match(r.text, /account\/forgot/);
  assert.match((await c.get(`/${clinic.slug}?lang=ar`)).text, new RegExp(`/${clinic.slug}/account"`), 'a "My account" link on the clinic page');
});

test('the clinic\'s activation link → password → the patient sees only their own file', async () => {
  const r = await svc.invite({ ...ctx }, clinic, pa, 'whatsapp', base);
  assert.match(r.waHref, /^https:\/\/wa\.me\/962791111111\?text=/);
  const token = /activate\/([A-Za-z0-9_-]+)/.exec(r.url)[1];
  const c = client();
  await c.get(`/${clinic.slug}/account/activate/${token}`);
  assert.equal((await c.post(`/${clinic.slug}/account/activate/${token}`, { password: 'short', password2: 'short' })).status, 422);
  assert.equal((await c.post(`/${clinic.slug}/account/activate/${token}`, { password: 'Sara-pass-1', password2: 'Sara-pass-1' })).status, 302);
  const home = await c.get(`/${clinic.slug}/account?lang=ar`);
  assert.equal(home.status, 200);
  assert.match(home.text, /سارة أحمد/); assert.match(home.text, /Amoxicillin 500/);
  assert.doesNotMatch(home.text, /مريض آخر/, 'never another patient');
  assert.doesNotMatch(home.text, /data-pp-section="files"/, 'files hidden by default');
  // the link is used once
  assert.match((await client().get(`/${clinic.slug}/account/activate/${token}`)).text, /link_expired|انتهى/);
  // sign in again with the mobile (any form) or the e-mail
  const c2 = client();
  await c2.get(`/${clinic.slug}/account/login`);
  assert.equal((await c2.post(`/${clinic.slug}/account/login`, { identifier: '+962 79 111 1111', password: 'Sara-pass-1' })).status, 302);
  const c3 = client();
  await c3.get(`/${clinic.slug}/account/login`);
  assert.equal((await c3.post(`/${clinic.slug}/account/login`, { identifier: 'SARA@example.com', password: 'Sara-pass-1' })).status, 302);
  // staff pages stay closed to a patient session
  assert.equal((await c3.get('/app')).status, 302);
});

test('wrong passwords lock the account for a while; unknown accounts get the same answer', async () => {
  const c = client();
  await c.get(`/${clinic.slug}/account/login`);
  const unknown = await c.post(`/${clinic.slug}/account/login`, { identifier: '0799999999', password: 'whatever1' });
  const wrong = await c.post(`/${clinic.slug}/account/login`, { identifier: '0791111111', password: 'nope-nope' });
  assert.equal(unknown.status, 401); assert.equal(wrong.status, 401);
  for (let i = 0; i < 4; i += 1) await c.post(`/${clinic.slug}/account/login`, { identifier: '0791111111', password: 'nope-nope' }); // eslint-disable-line no-await-in-loop
  assert.equal((await c.post(`/${clinic.slug}/account/login`, { identifier: '0791111111', password: 'Sara-pass-1' })).status, 429, 'locked even with the right password');
  await knex('patient_accounts').where({ business_id: ctx.businessId, patient_id: pa }).update({ locked_until: null, failed_count: 0 });
});

test('sign-up with a code to the mobile on the file; forgot password with a code', async () => {
  const realInt = crypto.randomInt;
  crypto.randomInt = () => 424242;
  try {
    const c = client();
    await c.get(`/${clinic.slug}/account/signup`);
    assert.equal((await c.post(`/${clinic.slug}/account/signup`, { identifier: '0792222222', channel: 'sms' })).status, 302);
    assert.equal((await c.post(`/${clinic.slug}/account/code`, { code: '111111', password: 'Other-pass-2', password2: 'Other-pass-2' })).status, 422);
    assert.equal((await c.post(`/${clinic.slug}/account/code`, { code: '424242', password: 'Other-pass-2', password2: 'Other-pass-2' })).status, 302);
    const home = await c.get(`/${clinic.slug}/account?lang=ar`);
    assert.match(home.text, /مريض آخر/); assert.doesNotMatch(home.text, /سارة أحمد/);
    // a number on no file: the same next page, and no code works
    const c2 = client();
    await c2.get(`/${clinic.slug}/account/signup`);
    assert.equal((await c2.post(`/${clinic.slug}/account/signup`, { identifier: '0797777777', channel: 'sms' })).status, 302);
    assert.equal((await c2.post(`/${clinic.slug}/account/code`, { code: '424242', password: 'Xyz-pass-12', password2: 'Xyz-pass-12' })).status, 422);
    // forgot password
    const c3 = client();
    await c3.get(`/${clinic.slug}/account/forgot`);
    await c3.post(`/${clinic.slug}/account/forgot`, { identifier: 'sara@example.com', channel: 'email' });
    assert.equal((await c3.post(`/${clinic.slug}/account/code`, { code: '424242', password: 'New-pass-33', password2: 'New-pass-33' })).status, 302);
    const c4 = client();
    await c4.get(`/${clinic.slug}/account/login`);
    assert.equal((await c4.post(`/${clinic.slug}/account/login`, { identifier: '0791111111', password: 'New-pass-33' })).status, 302);
  } finally { crypto.randomInt = realInt; }
  assert.ok(await knex('audit_logs').where({ business_id: ctx.businessId, action: 'patient_portal.login' }).first());
});

test('first time: the mobile alone on the sign-in page → a code → a password → the patient\'s file', async () => {
  const [pc] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'مراجع قديم', phone: '0793333333' });
  const realInt = crypto.randomInt;
  crypto.randomInt = () => 135790;
  try {
    const c = client();
    await c.get(`/${clinic.slug}/account/login`);
    const r = await c.post(`/${clinic.slug}/account/login`, { identifier: '0793333333', password: '' });
    assert.equal(r.status, 302); assert.match(r.location, /\/account\/code$/);
    assert.match((await c.get(`/${clinic.slug}/account/code?lang=ar`)).text, /أهلاً فيك/);
    assert.equal((await c.post(`/${clinic.slug}/account/code`, { code: '135790', password: 'First-pass-1', password2: 'First-pass-1' })).status, 302);
    assert.match((await c.get(`/${clinic.slug}/account?lang=ar`)).text, /مراجع قديم/);
    // next time: the password, as usual (no code)
    const c2 = client();
    await c2.get(`/${clinic.slug}/account/login`);
    assert.equal((await c2.post(`/${clinic.slug}/account/login`, { identifier: '0793333333', password: '' })).status, 401);
    assert.equal((await c2.post(`/${clinic.slug}/account/login`, { identifier: '0793333333', password: 'First-pass-1' })).status, 302);
  } finally { crypto.randomInt = realInt; }
  assert.ok(pc);
});

test('staff: settings and the activation from the patient file (owner)', async () => {
  const c = client();
  await c.get('/login');
  assert.equal((await c.post('/login', { email: `pp-own${tag}@t.test`, password: 'Passw0rd!x' })).status, 302);
  const s = await c.get('/app/settings/patient-portal?lang=ar');
  assert.equal(s.status, 200); assert.match(s.text, /data-patient-portal-settings/);
  assert.equal((await c.post('/app/settings/patient-portal', { enabled: '1', show_visits: '1', show_files: '1' })).status, 302);
  assert.equal((await svc.settings(ctx.businessId)).show_files, true);
  const f = await c.get(`/app/patients/${pb}?lang=ar`);
  assert.match(f.text, /portal-invite/);
  const r = await c.post(`/app/patients/${pb}/portal-invite`, { channel: 'whatsapp' });
  assert.equal(r.status, 302); assert.match(r.location, /^https:\/\/wa\.me\//);
});
