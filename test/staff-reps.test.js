// Printing (day sheet, patient list, patient file summary), staff chat inside one clinic, and medical reps reaching
// every clinic open to them: exact rep times where set, otherwise a request at a suggested time within the doctor's
// working hours (the clinic decides). Through HTTP against the test database.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `sr-${k}-${tag}@t.test`;
let app; let businessId; let otherBiz; let patientId; let doc; let today; let ownerId; let nurseId; let repUser; let vendorId;

async function user(k, name) {
  const id = await knex.transaction((trx) => auth.createUser(trx, { name, email: mail(k), password: 'Passw0rd!x' }));
  await knex('users').where({ id }).update({ email_verified_at: new Date() });
  return id;
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ownerId = await user('owner', 'Owner One');
  await knex.transaction((trx) => businesses.create(ownerId, { name: `Reps Clinic ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  businessId = (await knex('users').where({ id: ownerId }).first('last_business_id')).last_business_id;
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), slug: `sr-${tag}`.slice(0, 40), directory_listed: true, booking_enabled: true });
  const o2 = await user('owner2', 'Owner Two');
  await knex.transaction((trx) => businesses.create(o2, { name: `Other ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  otherBiz = (await knex('users').where({ id: o2 }).first('last_business_id')).last_business_id;
  await knex('businesses').where({ id: otherBiz }).update({ onboarding_completed_at: new Date() });
  // a nurse on the team (for the chat)
  nurseId = await user('nurse', 'Nurse Noor');
  const role = await knex('roles').where({ business_id: businessId, key: 'nurse' }).first('id') || await knex('roles').where({ business_id: businessId }).whereNot('key', 'owner').first('id');
  await knex('memberships').insert({ business_id: businessId, user_id: nurseId, role_id: role.id, status: 'active' });
  await knex('users').where({ id: nurseId }).update({ last_business_id: businessId });
  if (rbac.forget) rbac.forget(businessId);
  today = scheduling.clinicNow('Asia/Amman').date;
  const wh = scheduling.defaultWorkingHours(); // 09:00–17:00, Friday off
  [doc] = await knex('doctors').insert({ business_id: businessId, full_name: 'Dr Hours', is_active: true, working_hours: JSON.stringify(wh), slot_duration_minutes: 30 });
  [patientId] = await knex('patients').insert({ business_id: businessId, full_name: 'Print Patient', phone: '0793333333', allergies: 'Penicillin' });
  await knex('appointments').insert({ business_id: businessId, doctor_id: doc, patient_id: patientId, patient_name: 'Print Patient', patient_phone: '0793333333', appointment_date: today, appointment_time: '10:00', status: 'confirmed', appointment_type: 'in_person', source: 'staff' });
  // an active rep
  repUser = await user('rep', 'Rep Rami');
  [vendorId] = await knex('vendors').insert({ type: 'rep', name: `Pharma ${tag}`, email: mail('vendor'), phone: '0790000000', status: 'active', approved_at: new Date() });
  await knex('vendor_users').insert({ vendor_id: vendorId, user_id: repUser, role: 'owner' });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('printing: day sheet, patient list and patient file summary on the letterhead', async () => {
  const o = app.agent(); await o.login(mail('owner'));
  let r = await o.get(`/app/appointments/print?from=${today}&to=${today}&print=1&lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /print-letterhead/);
  assert.match(r.text, /Print Patient/);
  r = await o.get('/app/appointments?lang=en');
  assert.match(r.text, /\/app\/appointments\/print\?/, 'print button on the appointments page');
  r = await o.get('/app/patients/print?print=1&q=Print');
  assert.equal(r.status, 200);
  assert.match(r.text, /Print Patient/);
  r = await o.get(`/app/patients/${patientId}/summary?print=1&lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Patient file summary/);
  assert.match(r.text, /Penicillin/);
  r = await o.get(`/app/patients/${patientId}?lang=en`);
  assert.match(r.text, new RegExp(`/app/patients/${patientId}/summary`));
});

test('staff chat: room and one-to-one inside the clinic; unread badge; other clinics never see it', async () => {
  const owner = app.agent(); await owner.login(mail('owner'));
  let r = await owner.get('/app/chat?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /Clinic room/);
  const roomId = Number(r.text.match(/data-chat="(\d+)"/)[1]);
  r = await owner.submit('/app/chat', `/app/chat/${roomId}`, { body: 'Good morning team' });
  assert.equal(r.status, 302);
  r = await owner.get(`/app/chat?u=${nurseId}`);
  assert.equal(r.status, 302);
  const dm = Number(r.location.match(/c=(\d+)/)[1]);
  await owner.submit(`/app/chat?c=${dm}`, `/app/chat/${dm}`, { body: 'Please prepare room 2' });
  const nurse = app.agent(); await nurse.login(mail('nurse'));
  r = await nurse.get('/app/chat/unread');
  assert.equal(JSON.parse(r.text).unread, 2);
  r = await nurse.get(`/app/chat/${dm}/messages?after=0`, { accept: 'application/json' });
  assert.equal(JSON.parse(r.text).data[0].body, 'Please prepare room 2');
  r = await nurse.get('/app/chat/unread');
  assert.equal(JSON.parse(r.text).unread, 1, 'reading the conversation clears its count');
  // empty messages refused; another clinic's owner cannot open or write to this clinic's conversations
  await owner.submit(`/app/chat?c=${dm}`, `/app/chat/${dm}`, { body: '   ' });
  assert.equal(Number((await knex('staff_chat_messages').where({ chat_id: dm }).count({ n: '*' }))[0].n), 1);
  const stranger = app.agent(); await stranger.login(mail('owner2'));
  r = await stranger.get(`/app/chat/${dm}/messages`);
  assert.equal(r.status, 404);
  r = await stranger.get(`/app/chat?u=${nurseId}`);
  assert.equal(r.status, 404);
});

test('reps: a listed clinic without rep times takes a request within the doctor hours; the clinic sees it; it can be turned off', async () => {
  const rep = app.agent(); await rep.login(mail('rep'));
  let r = await rep.get('/vendor/visits/new?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`Reps Clinic ${tag}`));
  assert.match(r.text, /Request a time/);
  r = await rep.get(`/vendor/visits/new?clinic=${businessId}&lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Dr Hours/);
  assert.match(r.text, /09:00–17:00/);
  // next Sunday (working day) at 08:00 → outside hours; at 11:00 → accepted
  const d = new Date(`${today}T00:00:00Z`); do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 0);
  const sunday = d.toISOString().slice(0, 10);
  r = await rep.submit(`/vendor/visits/new?clinic=${businessId}`, '/vendor/visits', { business_id: String(businessId), doctor_id: String(doc), visit_date: sunday, visit_time: '08:00', purpose: 'New product' });
  assert.ok(!(await knex('rep_visits').where({ business_id: businessId, vendor_id: vendorId }).first()), 'outside working hours refused');
  r = await rep.submit(`/vendor/visits/new?clinic=${businessId}`, '/vendor/visits', { business_id: String(businessId), doctor_id: String(doc), visit_date: sunday, visit_time: '11:00', purpose: 'New product' });
  assert.equal(r.status, 302);
  const v = await knex('rep_visits').where({ business_id: businessId, vendor_id: vendorId }).first();
  assert.equal(v.status, 'requested');
  assert.equal(Boolean(v.flexible), true);
  const owner = app.agent(); await owner.login(mail('owner'));
  r = await owner.get('/app/rep-visits?lang=en');
  assert.match(r.text, /Suggested time/);
  // turned off → the clinic disappears for reps
  await knex('businesses').where({ id: businessId }).update({ rep_requests_off: true });
  r = await rep.get('/vendor/visits/new?lang=en');
  assert.doesNotMatch(r.text, new RegExp(`Reps Clinic ${tag}`));
});

test('sidebar: reps sit under patients with the offers next to them; the home page invites reps to register', async () => {
  const o = app.agent(); await o.login(mail('owner'));
  const r = await o.get('/app/rep-visits?lang=en');
  const i = r.text.indexOf('href="/app/patients"'); const j = r.text.indexOf('Medical reps');
  assert.ok(i > 0 && j > i, 'reps after patients in the sidebar');
  assert.match(r.text, /href="\/app\/marketplace"/);
  const home = await app.agent().get('/?lang=ar');
  assert.match(home.text, /href="\/vendors\/signup"/);
  assert.match(home.text, /href="\/vendors"/);
});

test('chat: a new conversation shows the person at the top before its first message; images and files are sent', async () => {
  const owner = app.agent(); await owner.login(mail('owner'));
  const accId = await user('acc', 'Accountant Amal');
  const role = await knex('roles').where({ business_id: businessId }).whereNot('key', 'owner').first('id');
  await knex('memberships').insert({ business_id: businessId, user_id: accId, role_id: role.id, status: 'active' });
  let r = await owner.get(`/app/chat?u=${accId}`);
  assert.equal(r.status, 302);
  const cid = Number(r.location.match(/c=(\d+)/)[1]);
  r = await owner.get(`${r.location}&lang=en`);
  assert.match(r.text, new RegExp(`<h2>Accountant Amal</h2>`), 'the chosen person is the open conversation');
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005fe02fe0d0a2db40000000049454e44ae426082', 'hex');
  r = await owner.upload(`/app/chat?c=${cid}`, `/app/chat/${cid}/upload`, { body: 'Scan of the invoice' }, { files: { buffer: PNG, name: 'scan.png' } });
  assert.equal(r.status, 302, r.text.slice(0, 200));
  r = await owner.upload(`/app/chat?c=${cid}`, `/app/chat/${cid}/upload`, {}, { files: { buffer: Buffer.from('%PDF-1.4\n%%EOF\n'), name: 'report.pdf' } });
  assert.equal(r.status, 302);
  const files = await knex('staff_chat_files').where({ chat_id: cid }).orderBy('id').select('id', 'mime', 'name');
  assert.deepEqual(files.map((f) => f.mime), ['image/png', 'application/pdf']);
  r = await owner.upload(`/app/chat?c=${cid}`, `/app/chat/${cid}/upload`, {}, { files: { buffer: Buffer.from('MZ fake executable bytes'), name: 'virus.pdf' } });
  assert.equal((await knex('staff_chat_files').where({ chat_id: cid }).count({ n: '*' }))[0].n, 2, 'a disguised file is refused');
  const acc = app.agent(); await acc.login(mail('acc'));
  r = await acc.get(`/app/chat/files/${files[0].id}`);
  assert.equal(r.status, 200);
  assert.match(r.type, /image\/png/);
  r = await acc.get(`/app/chat/${cid}/messages?after=0`);
  assert.equal(JSON.parse(r.text).data[0].files[0].name, 'scan.png');
  const nurse = app.agent(); await nurse.login(mail('nurse'));
  r = await nurse.get(`/app/chat/files/${files[0].id}`);
  assert.equal(r.status, 404, 'not part of that conversation');
});

test('clinic working hours live in the Clinic workspace', async () => {
  const owner = app.agent(); await owner.login(mail('owner'));
  let r = await owner.get('/app/clinic/hours?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /Working hours/);
  assert.match(r.text, /href="\/app\/clinic\/hours"/, 'a tab in the Clinic workspace');
  r = await owner.submit('/app/clinic/hours', '/app/clinic/hours', { hours_layout: 'same', days: 'sun', s1: '08:00', e1: '14:00' });
  assert.equal(r.status, 302);
  const b = await knex('businesses').where({ id: businessId }).first('default_working_hours');
  const wh = typeof b.default_working_hours === 'string' ? JSON.parse(b.default_working_hours) : b.default_working_hours;
  assert.equal(wh.sun.shifts[0].start, '08:00');
  assert.equal(wh.mon.enabled, false);
});

test('top bar: the bell opens a drop-down of notifications; the chat icon has its own count', async () => {
  const notifications = require('../src/modules/notifications/notification.service'); // eslint-disable-line global-require
  await notifications.notify(businessId, { userId: ownerId, type: 'test.bell', title: `Bell check ${tag}`, body: 'Drop-down body', link: '/app/patients' });
  const owner = app.agent(); await owner.login(mail('owner'));
  let r = await owner.get('/app?lang=en');
  assert.match(r.text, /<details class="dropdown notif-dd" data-notif>/);
  assert.match(r.text, /data-notif-bell/);
  r = await owner.get('/app/notifications/panel?back=/app/patients');
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`Bell check ${tag}`));
  assert.doesNotMatch(r.text, /<html/, 'a fragment, not a page');
  const n = await knex('notifications').where({ business_id: businessId, title: `Bell check ${tag}` }).first('id');
  r = await owner.submit('/app', '/app/notifications/read', { id: String(n.id), go: '/app/patients' });
  assert.equal(r.location, '/app/patients');
  // the counts are separate: notifications vs chat messages
  r = await owner.get('/app/teamops/unread');
  const d = JSON.parse(r.text);
  assert.equal(typeof d.count, 'number');
  assert.equal(typeof d.chat, 'number');
  assert.equal(d.chat, await require('../src/modules/chat/chat.service').unreadTotal({ businessId, userId: ownerId })); // eslint-disable-line global-require
  r = await owner.submit('/app', '/app/notifications/read', { back: '/app/appointments' });
  assert.equal(r.location, '/app/appointments');
  r = await owner.submit('/app', '/app/notifications/read', { back: 'https://evil.example/' });
  assert.equal(r.location, '/app/notifications', 'never leaves the app');
});

test('chat: every active team member is listed to start a conversation (no hidden names)', async () => {
  const owner = app.agent(); await owner.login(mail('owner'));
  const ids = (await knex('memberships').where({ business_id: businessId, status: 'active' }).whereNot('user_id', ownerId).pluck('user_id'));
  const r = await owner.get('/app/chat?lang=en');
  const withChat = new Set([...r.text.matchAll(/href="\/app\/chat\?c=(\d+)"/g)].map((m) => m[1]));
  for (const id of ids) {
    const listed = r.text.includes(`href="/app/chat?u=${id}"`);
    const dm = await knex('staff_chats').where({ business_id: businessId, kind: 'direct' }).whereIn('pair_key', [`${Math.min(id, ownerId)}:${Math.max(id, ownerId)}`]).first('id', 'last_message_id');
    assert.ok(listed || (dm && withChat.has(String(dm.id))), `member ${id} can be reached`);
  }
});
