// Surgeries: a time block marked as a surgery (patient, procedure, hospital), the Surgeries page, a doctor login
// booking their own, sending the date to the hospital by e-mail (clinic mail) or WhatsApp, moving the block, and
// cancelling (the doctor's time is freed, the surgery stays in the list).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const appts = require('../src/modules/clinic/appointments.service');
const mailer = require('../src/core/mailer');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `sx-${k}-${tag}@t.test`;
let app; let B; let doc; let doc2; let pid; let hosp; let date;
const sent = [];

/** The next working day (Sat–Thu) at least `ahead` days from today. */
function workday(ahead) {
  let d = new Date(`${scheduling.clinicNow('Asia/Amman').date}T12:00:00Z`);
  d = new Date(d.getTime() + ahead * 86_400_000);
  while (d.getUTCDay() === 5) d = new Date(d.getTime() + 86_400_000);
  return d.toISOString().slice(0, 10);
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const owner = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: mail('o'), password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'عيادة الجراحة', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: owner }).update({ email_verified_at: new Date() });
  ({ last_business_id: B } = await knex('users').where({ id: owner }).first('last_business_id'));
  await knex('businesses').where({ id: B }).update({ onboarding_completed_at: new Date() });
  const wh = JSON.stringify(scheduling.defaultWorkingHours());
  [doc] = await knex('doctors').insert({ business_id: B, full_name: 'د. سامي', is_active: true, working_hours: wh, slot_duration_minutes: 30 });
  [doc2] = await knex('doctors').insert({ business_id: B, full_name: 'د. ريم', is_active: true, working_hours: wh, slot_duration_minutes: 30 });
  [pid] = await knex('patients').insert({ business_id: B, full_name: 'خالد عمر', phone: '0791112223' });
  [hosp] = await knex('clinic_partners').insert({ business_id: B, kind: 'hospital', name: 'مستشفى الأمل', email: 'or@hope-hospital.test', phone: '0795556667', is_active: true });
  // A doctor login linked to doc2.
  const dUser = await knex.transaction((trx) => auth.createUser(trx, { name: 'Dr Reem', email: mail('d'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: dUser }).update({ last_business_id: B, email_verified_at: new Date() });
  await knex('memberships').insert({ business_id: B, user_id: dUser, role_id: (await rbac.getRoleByKey(B, 'doctor')).id, doctor_id: doc2 });
  mailer.configuredFor = async () => true;
  mailer.send = async (m) => { sent.push(m); return true; };
  date = workday(3);
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('a time block as a surgery: listed under Surgeries with patient, procedure and hospital', async () => {
  const o = app.agent(); await o.login(mail('o'));
  const cal = await o.get('/app/appointments?surgery=1');
  assert.equal(cal.status, 200);
  assert.match(cal.text, /name="kind" value="surgery" checked/);
  assert.match(cal.text, /مستشفى الأمل/);
  const r = await o.post('/app/appointments/blocks', {
    _csrf: o.csrf(cal.text), doctor_id: String(doc), appointment_date: date, appointment_time: '10:00', duration_minutes: '120',
    kind: 'surgery', patient_id: String(pid), procedure_name: 'خلع ضرس عقل', hospital_id: String(hosp), notes: 'تخدير عام',
  });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const s = await knex('surgeries').where({ business_id: B }).first();
  assert.ok(s);
  assert.equal(s.patient_id, pid);
  assert.equal(s.hospital_name, 'مستشفى الأمل');
  assert.equal(s.surgery_time, '10:00');
  const block = await knex('appointments').where({ id: s.appointment_id }).first();
  assert.equal(block.appointment_type, 'blocked');
  assert.match(block.patient_name, /خلع ضرس عقل — خالد عمر/);

  const list = await o.get('/app/surgeries');
  assert.equal(list.status, 200);
  assert.match(list.text, /خالد عمر/);
  assert.match(list.text, /خلع ضرس عقل/);
  assert.match(list.text, /10:00–12:00/);
  const nav = await o.get('/app/patients');
  assert.match(nav.text, /href="\/app\/surgeries"/);

  // A surgery form without a procedure is refused and nothing is reserved.
  const before = await knex('appointments').where({ business_id: B, appointment_type: 'blocked' }).count({ n: '*' });
  const bad = await o.post('/app/appointments/blocks', { _csrf: o.csrf(cal.text), doctor_id: String(doc), appointment_date: date, appointment_time: '14:00', duration_minutes: '60', kind: 'surgery', patient_name: 'x' });
  assert.equal(bad.status, 422);
  const after = await knex('appointments').where({ business_id: B, appointment_type: 'blocked' }).count({ n: '*' });
  assert.equal(Number(after[0].n), Number(before[0].n));
});

test('send to the hospital by e-mail (clinic mail) and WhatsApp; moving the block moves the surgery; cancel frees the time', async () => {
  const o = app.agent(); await o.login(mail('o'));
  const s = await knex('surgeries').where({ business_id: B }).first();
  const page = await o.get(`/app/surgeries/${s.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /or@hope-hospital\.test/);
  assert.match(page.text, /name="procedure_name" value="خلع ضرس عقل"/); // the form holds the surgery
  let r = await o.post(`/app/surgeries/${s.id}/send`, { _csrf: o.csrf(page.text), channel: 'email', to_email: 'or@hope-hospital.test', lang_msg: 'ar' });
  assert.equal(r.status, 302);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'or@hope-hospital.test');
  assert.match(sent[0].subject, /خالد عمر/);
  assert.match(sent[0].html, /خلع ضرس عقل/);
  assert.match(sent[0].html, /مستشفى الأمل/);
  assert.ok((await knex('surgeries').where({ id: s.id }).first()).sent_at);
  r = await o.post(`/app/surgeries/${s.id}/send`, { _csrf: o.csrf(page.text), channel: 'whatsapp', to_phone: '0795556667', lang_msg: 'ar' });
  assert.equal(r.status, 200);
  assert.match(r.text, /wa\.me\/9627/);

  const ctx = { businessId: B, userId: 1, timezone: 'Asia/Amman', permissions: new Set(['appointments.manage']), ownDoctorId: null };
  await appts.move(ctx, s.appointment_id, { doctor_id: doc, appointment_date: date, appointment_time: '11:00' });
  assert.equal((await knex('surgeries').where({ id: s.id }).first()).surgery_time, '11:00');

  r = await o.post(`/app/surgeries/${s.id}/status`, { _csrf: o.csrf(page.text), status: 'cancelled' });
  assert.equal(r.status, 302);
  const c = await knex('surgeries').where({ id: s.id }).first();
  assert.equal(c.status, 'cancelled');
  assert.equal(c.appointment_id, null);
  assert.equal(await knex('appointments').where({ id: s.appointment_id }).first(), undefined);
  const past = await o.get('/app/surgeries?when=all');
  assert.match(past.text, /ملغاة|Cancelled/);
});

test('a doctor login books a surgery on their own time and sees only their own surgeries', async () => {
  const d = app.agent(); await d.login(mail('d'));
  const cal = await d.get('/app/appointments?surgery=1');
  assert.equal(cal.status, 200);
  assert.match(cal.text, /id="block-dialog"/);
  const r = await d.post('/app/appointments/blocks', {
    _csrf: d.csrf(cal.text), doctor_id: String(doc2), appointment_date: date, appointment_time: '09:00', duration_minutes: '60',
    kind: 'surgery', patient_name: 'سارة', patient_phone: '0790001112', procedure_name: 'زراعة', hospital_id: 'other', hospital_name: 'مستشفى الشفاء',
  });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const mine = await knex('surgeries').where({ business_id: B, doctor_id: doc2 }).first();
  assert.equal(mine.hospital_name, 'مستشفى الشفاء');
  assert.equal(mine.hospital_id, null);
  const list = await d.get('/app/surgeries?when=all');
  assert.match(list.text, /زراعة/);
  assert.doesNotMatch(list.text, /خلع ضرس عقل/);
  const other = await knex('surgeries').where({ business_id: B, doctor_id: doc }).first();
  assert.equal((await d.get(`/app/surgeries/${other.id}`)).status, 404);
  // Not someone else's time.
  const r2 = await d.post('/app/appointments/blocks', { _csrf: d.csrf(cal.text), doctor_id: String(doc), appointment_date: date, appointment_time: '15:00', duration_minutes: '60', kind: 'surgery', patient_name: 'x', procedure_name: 'y' });
  assert.equal(r2.status, 403);
});
