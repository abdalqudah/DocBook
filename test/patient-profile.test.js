// The fuller patient file: profile fields and their checks, automatic file numbers, groups, the important note on
// booking, the photo (type, size, access), the standing discount at the cash desk, and the advanced list filters.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const appts = require('../src/modules/clinic/appointments.service');
const profile = require('../src/modules/clinic/patient-profile');
const { clinicNow } = require('../src/modules/clinic/scheduling');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let ctx; let other; let server; let base;

async function makeClinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date() });
  businesses.forget(businessId);
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, locale: 'en', today: clinicNow('Asia/Amman').date };
}
async function staff(businessId, roleKey, email) {
  const userId = await knex.transaction((trx) => auth.createUser(trx, { name: roleKey, email, password: 'Passw0rd!x' }));
  const role = await rbac.getRoleByKey(businessId, roleKey);
  await knex('memberships').insert({ business_id: businessId, user_id: userId, role_id: role.id });
  await knex('users').where({ id: userId }).update({ last_business_id: businessId });
  return userId;
}
function client() {
  const jar = {};
  let csrf = '';
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const read = async (res) => {
    for (const h of res.headers.getSetCookie()) { const [kv] = h.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const type = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    const text = /text|json/.test(type) ? buf.toString('utf8') : '';
    const m = text.match(/name="csrf-token" content="([^"]+)"/); if (m) csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text, type, buf };
  };
  return {
    csrf: () => csrf,
    get: async (path) => read(await fetch(base + path, { headers: { cookie: cookie(), accept: 'text/html' }, redirect: 'manual' })),
    post: async (path, data = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: csrf, ...data })) [].concat(v).forEach((x) => body.append(k, x));
      return read(await fetch(base + path, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' }));
    },
    upload: async (path, field, buf, name, extra = {}) => {
      const fd = new FormData();
      fd.append('_csrf', csrf);
      Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
      fd.append(field, new Blob([buf]), name);
      return read(await fetch(base + path, { method: 'POST', headers: { cookie: cookie() }, body: fd, redirect: 'manual' }));
    },
  };
}
async function signIn(email) {
  const c = client();
  await c.get('/login');
  assert.equal((await c.post('/login', { email, password: 'Passw0rd!x' })).status, 302);
  return c;
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ctx = await makeClinic(`pp${tag}@t.test`, 'Profile clinic');
  other = await makeClinic(`pp-other${tag}@t.test`, 'Other clinic');
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await knex.destroy(); });

test('profile fields: saved, checked, file numbers given in order and unique per clinic, groups', async () => {
  const a = await appts.savePatient(ctx, null, { full_name: 'رغد عماد', phone: '0787404637', profile_form: '1', groups_form: '1', new_group: 'Implant', name_en: 'Raghad Emad', category: 'vip', nationality: 'JO', smoker: 'no', blood_group: 'O+', discount_percent: '10', important_note: 'Allergic to latex gloves', important_on_booking: '1', reminders_form: '1', reminders: '1' });
  const b = await appts.savePatient(ctx, null, { full_name: 'Second', profile_form: '1' });
  const [pa, pb] = await Promise.all([knex('patients').where({ id: a }).first(), knex('patients').where({ id: b }).first()]);
  assert.equal(pa.file_number, '1'); assert.equal(pb.file_number, '2');
  assert.equal(pa.name_en, 'Raghad Emad'); assert.equal(pa.category, 'vip'); assert.equal(Number(pa.discount_percent), 10);
  assert.equal(pa.important_on_booking, 1); assert.equal(pa.messaging_opt_out, 0); assert.equal(pa.updated_by, ctx.userId);
  assert.deepEqual((await profile.groupsOf(ctx.businessId, a)).map((g) => g.name), ['Implant']);
  // Another clinic starts its own numbers.
  const c = await appts.savePatient(other, null, { full_name: 'Elsewhere', profile_form: '1' });
  assert.equal((await knex('patients').where({ id: c }).first()).file_number, '1');
  // Typed numbers: unique in the clinic, plain characters.
  await assert.rejects(() => appts.savePatient(ctx, b, { full_name: 'Second', profile_form: '1', file_number: '1' }), (e) => e.code === 'PATIENT_FILE_NUMBER_TAKEN');
  await assert.rejects(() => appts.savePatient(ctx, b, { full_name: 'Second', profile_form: '1', file_number: '<x>' }), (e) => Boolean(e.details.file_number));
  await assert.rejects(() => appts.savePatient(ctx, b, { full_name: 'Second', profile_form: '1', discount_percent: '150' }), (e) => Boolean(e.details.discount_percent));
  await assert.rejects(() => appts.savePatient(ctx, b, { full_name: 'Second', profile_form: '1', nationality: 'XX' }), (e) => Boolean(e.details.nationality));
  await assert.rejects(() => appts.savePatient(ctx, b, { full_name: 'Second', profile_form: '1', case_manager_id: String(other.userId) }), (e) => Boolean(e.details.case_manager_id), 'a case manager from another clinic');
  await appts.savePatient(ctx, b, { full_name: 'Second', profile_form: '1', file_number: 'A-77', reminders_form: '1' });
  const pb2 = await knex('patients').where({ id: b }).first();
  assert.equal(pb2.file_number, 'A-77'); assert.equal(pb2.messaging_opt_out, 1, 'reminders unticked → off');
  // A form without the profile (e.g. another screen) leaves the profile as it is.
  await appts.savePatient(ctx, a, { full_name: 'رغد عماد غيث', phone: '0787404637' });
  assert.equal((await knex('patients').where({ id: a }).first()).name_en, 'Raghad Emad');
  // Groups: only this clinic's; the change is audited.
  const og = (await knex('patient_groups').insert({ business_id: other.businessId, name: 'Theirs' }))[0];
  await appts.savePatient(ctx, a, { full_name: 'رغد عماد غيث', profile_form: '1', groups_form: '1', groups: [String(og)], new_group: 'Ortho' });
  assert.deepEqual((await profile.groupsOf(ctx.businessId, a)).map((g) => g.name), ['Ortho']);
  assert.ok(await knex('audit_logs').where({ business_id: ctx.businessId, action: 'patient.groups_changed' }).first());
});

test('HTTP: profile on the file, important note when booking, photo, filters, standing discount', async () => {
  await staff(ctx.businessId, 'accountant', `pp-rec${tag}@t.test`);
  const owner = await signIn(`pp${tag}@t.test`);
  await owner.get('/app/patients');
  let r = await owner.post('/app/patients', { full_name: 'Http Patient', phone: '0790001122', gender: 'female', date_of_birth: '1990-04-12', profile_form: '1', groups_form: '1', reminders_form: '1', reminders: '1', new_group: 'Hospital', city: 'Amman', area: 'Abdali', category: 'staff', important_note: 'Needs a wheelchair', important_on_booking: '1', referral_source: 'instagram', pregnant: 'no' });
  assert.equal(r.status, 302);
  const id = Number(r.location.split('/').pop());
  r = await owner.get(`/app/patients/${id}?lang=en`);
  assert.match(r.text, /Needs a wheelchair/); assert.match(r.text, /Hospital/); assert.match(r.text, /Instagram/); assert.match(r.text, /Staff/);
  r = await owner.get(`/app/appointments/patient-lookup?id=${id}`);
  assert.equal(JSON.parse(r.text).data[0].note, 'Needs a wheelchair');
  r = await owner.get('/app/appointments/patient-lookup?q=Http');
  assert.equal(JSON.parse(r.text).data[0].file, (await knex('patients').where({ id }).first()).file_number);

  // Photo: images only, those who edit patients; served to the clinic only.
  await owner.get(`/app/patients/${id}/edit`);
  r = await owner.upload(`/app/patients/${id}/photo`, 'photo', Buffer.from('<svg onload=alert(1)>'), 'x.svg');
  assert.equal(r.status, 302);
  assert.equal(await knex('patient_photos').where({ patient_id: id }).first(), undefined, 'not an image: refused');
  r = await owner.upload(`/app/patients/${id}/photo`, 'photo', PNG, 'me.png');
  assert.equal(r.status, 302);
  r = await owner.get(`/app/patients/${id}/photo`);
  assert.equal(r.status, 200); assert.equal(r.type, 'image/png'); assert.ok(r.buf.equals(PNG));
  const rec = await signIn(`pp-rec${tag}@t.test`);
  await rec.get('/app/billing');
  assert.equal((await rec.upload(`/app/patients/${id}/photo`, 'photo', PNG, 'me.png')).status, 403);
  const stranger = await signIn(`pp-other${tag}@t.test`);
  await stranger.get('/app/patients');
  assert.equal((await stranger.get(`/app/patients/${id}/photo`)).status, 404);
  r = await owner.upload(`/app/patients/${id}/photo`, 'photo', PNG, 'me.png', { remove: '1' });
  assert.equal(await knex('patient_photos').where({ patient_id: id }).first(), undefined);

  // Filters on the list.
  const has = async (qs) => (await owner.get(`/app/patients?${qs}`)).text.includes(`/app/patients/${id}"`);
  assert.ok(await has('category=staff'));
  assert.ok(!(await has('category=vip')));
  assert.ok(await has('city=abdali'));
  assert.ok(await has('month=4'));
  assert.ok(!(await has('month=5')));
  assert.ok(await has('tag=important'));
  assert.ok(await has('referral=instagram'));
  assert.ok(await has('mobile=1122'));
  assert.ok(await has(`group=${(await knex('patient_groups').where({ business_id: ctx.businessId, name: 'Hospital' }).first()).id}`));
  assert.ok(!(await has('group=none')));
  assert.ok(await has(`from=${ctx.today}&to=${ctx.today}`));
  assert.ok(!(await has('from=2001-01-01&to=2001-01-02')));
  assert.equal((await owner.get('/app/patients?sort=file&dir=asc&month=13&from=bad')).status, 200, 'bad values are ignored');

  // The standing discount starts the cash desk's discount.
  await knex('patients').where({ id }).update({ discount_percent: 15 });
  const [apptId] = await knex('appointments').insert({ business_id: ctx.businessId, patient_id: id, patient_name: 'Http Patient', patient_phone: '0790001122', appointment_date: ctx.today, appointment_time: '10:00', duration_minutes: 30, status: 'confirmed', checked_in: true });
  r = await owner.get(`/app/cashier/screen/panel/${apptId}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /name="discount_value"[^>]*value="15"/);
});

test('only the clinic owner deletes an appointment, voids an invoice or refunds a payment', async () => {
  await staff(ctx.businessId, 'clinic_manager', `pp-mgr${tag}@t.test`);
  const mgr = await signIn(`pp-mgr${tag}@t.test`);
  const [aid] = await knex('appointments').insert({ business_id: ctx.businessId, patient_name: 'Owner Only', patient_phone: '0790009999', appointment_date: ctx.today, appointment_time: '11:00', duration_minutes: 30, status: 'confirmed' });
  let r = await mgr.get(`/app/appointments/${aid}`);
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, new RegExp(`/app/appointments/${aid}/delete`), 'no delete button for the manager');
  assert.equal((await mgr.post(`/app/appointments/${aid}/delete`)).status, 403);
  assert.equal((await mgr.post('/app/billing/1/void', { confirm_name: '1' })).status, 403);
  assert.equal((await mgr.post('/app/payments/1/refund')).status, 403);
  assert.ok(await knex('appointments').where({ id: aid }).first());
  const owner = await signIn(`pp${tag}@t.test`);
  r = await owner.get(`/app/appointments/${aid}`);
  assert.match(r.text, new RegExp(`/app/appointments/${aid}/delete`));
  assert.equal((await owner.post(`/app/appointments/${aid}/delete`)).status, 302);
  assert.equal(await knex('appointments').where({ id: aid }).first(), undefined);
});
