// Team operations against the test database: support-ticket permissions and status flow, presence visibility
// (same clinic only, hidden members), notification e-mail recipient resolution with a fake mailer, and the
// doctor → patient e-mail (validation, no address, attachments allowed only from shared documents, rate limit).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const tickets = require('../src/modules/teamops/tickets.service');
const presence = require('../src/modules/teamops/presence.service');
const notifyMail = require('../src/modules/teamops/notify-mail');
const patientMail = require('../src/modules/teamops/patient-mail.service');
const { translator } = require('../src/core/i18n');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let owner; let nurse; let reception; let doctor; let other; let business; let patientId; let noMailPatientId;

async function makeClinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date() });
  businesses.forget(businessId);
  return ctxFor(businessId, userId, 'owner', 'Owner');
}
async function ctxFor(businessId, userId, roleKey, name, doctorId = null) {
  return { businessId, userId, userName: name, roleKey, doctorId, ownDoctorId: null, permissions: await rbac.getUserPermissions(businessId, userId), locale: 'en', timezone: 'Asia/Amman', currency: 'JOD' };
}
async function addMember(businessId, roleKey, name, extra = {}) {
  const uid = await knex.transaction((trx) => auth.createUser(trx, { name, email: `${roleKey}.${name.replace(/\W/g, '')}.${tag}@t.test`, password: 'Passw0rd!x' }));
  const role = await rbac.getRoleByKey(businessId, roleKey);
  await knex('memberships').insert({ business_id: businessId, user_id: uid, role_id: role.id, status: 'active', ...extra });
  cache.forgetPrefix('perm:');
  return ctxFor(businessId, uid, roleKey, name, extra.doctor_id || null);
}
const fakeMail = () => {
  const sent = [];
  return { sent, configured: () => true, layout: ({ title }) => `<p>${title}</p>`, send: async (m) => { sent.push(m); return true; } };
};

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  owner = await makeClinic(`teamops${tag}@t.test`, 'عيادة الفريق');
  business = await knex('businesses').where({ id: owner.businessId }).first();
  nurse = await addMember(owner.businessId, 'nurse', 'Nurse');
  reception = await addMember(owner.businessId, 'receptionist', 'Reception');
  const [docId] = await knex('doctors').insert({ business_id: owner.businessId, full_name: 'د. رنا', email: `rana${tag}@t.test`, working_hours: JSON.stringify({}) });
  doctor = await addMember(owner.businessId, 'doctor', 'Doctor', { doctor_id: docId });
  other = await makeClinic(`teamops-other${tag}@t.test`, 'عيادة أخرى');
  [patientId] = await knex('patients').insert({ business_id: owner.businessId, full_name: 'سارة أحمد', email: `sara${tag}@t.test` });
  [noMailPatientId] = await knex('patients').insert({ business_id: owner.businessId, full_name: 'بلا بريد' });
});
test.after(async () => { await knex.destroy(); });

test('tickets: who may see, assign and move a ticket', async () => {
  const tk = await tickets.create(nurse, { subject: 'Printer', category: 'equipment', priority: 'high', description: 'Paper jam' });
  assert.equal(tk.status, 'open');
  await assert.rejects(tickets.create(nurse, { subject: '', category: 'nope', priority: 'normal', description: '' }), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.subject && e.details.category));

  // Not involved → invisible; other clinic → invisible even for its owner.
  await assert.rejects(tickets.load(reception, tk.id), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(tickets.load(other, tk.id), (e) => e.code === 'NOT_FOUND');
  assert.equal((await tickets.list(reception, {})).rows.length, 0);
  assert.equal((await tickets.list(owner, {})).rows.length, 1);

  // Only managers assign; the author can't change it to in progress.
  await assert.rejects(tickets.assign(nurse, tk.id, reception.userId), (e) => e.code === 'PERMISSION_DENIED');
  await assert.rejects(tickets.setStatus(nurse, tk.id, 'in_progress'), (e) => e.code === 'PERMISSION_DENIED');
  await assert.rejects(tickets.assign(owner, tk.id, other.userId), (e) => e.code === 'VALIDATION_FAILED'); // not a member
  await tickets.assign(owner, tk.id, reception.userId);

  // The assignee now sees it, works on it and resolves it; they can't close it.
  assert.equal((await tickets.list(reception, { scope: 'assigned' })).rows.length, 1);
  await tickets.setStatus(reception, tk.id, 'in_progress');
  await tickets.reply(reception, tk.id, { body: 'Replaced the drum.' });
  await tickets.setStatus(reception, tk.id, 'resolved');
  await assert.rejects(tickets.setStatus(reception, tk.id, 'closed'), (e) => e.code === 'PERMISSION_DENIED');

  // Unread marker for the author, cleared when they open it.
  let row = (await tickets.list(nurse, { status: 'all' })).rows[0];
  assert.equal(row.unread, true);
  await tickets.markRead(nurse, tk.id);
  row = (await tickets.list(nurse, { status: 'all' })).rows[0];
  assert.equal(row.unread, false);

  // The author replying on a resolved ticket re-opens it; then closes it; nobody replies on a closed ticket.
  const r = await tickets.reply(nurse, tk.id, { body: 'Still jams.' });
  assert.equal(r.reopened, true);
  assert.equal((await tickets.load(owner, tk.id)).status, 'open');
  await tickets.setStatus(nurse, tk.id, 'closed');
  await assert.rejects(tickets.reply(reception, tk.id, { body: 'x' }), (e) => e.code === 'TICKET_CLOSED');
  await assert.rejects(tickets.setStatus(nurse, tk.id, 'open'), (e) => e.code === 'PERMISSION_DENIED');
  await tickets.setStatus(owner, tk.id, 'open'); // a manager re-opens

  // Notifications reached the assignee and the managers (not the actor).
  const notes = await knex('notifications').where({ business_id: owner.businessId }).where('type', 'like', 'ticket.%').select('user_id', 'type');
  assert.ok(notes.some((n) => n.user_id === owner.userId && n.type === 'ticket.new'));
  assert.ok(notes.some((n) => n.user_id === reception.userId && n.type === 'ticket.assigned'));
  assert.ok(notes.some((n) => n.user_id === nurse.userId && n.type === 'ticket.reply'));
  assert.ok(!notes.some((n) => n.user_id === nurse.userId && n.type === 'ticket.new'));

  // Numbers are per clinic.
  const tk2 = await tickets.create(owner, { subject: 'Wi-Fi', category: 'technical', priority: 'low', description: 'Slow' });
  const tk3 = await tickets.create(other, { subject: 'Wi-Fi', category: 'technical', priority: 'low', description: 'Slow' });
  assert.equal(tk2.number, tk.number + 1);
  assert.equal(tk3.number, 1);
});

test('tickets: platform support only when configured, once', async () => {
  const tk = await tickets.create(nurse, { subject: 'Login issue', category: 'technical', priority: 'normal', description: 'Cannot sign in' });
  const saved = process.env.SUPPORT_EMAIL;
  delete process.env.SUPPORT_EMAIL;
  await assert.rejects(tickets.sendToPlatform(nurse, tk.id, business, { mail: fakeMail() }), (e) => e.code === 'SUPPORT_UNAVAILABLE');
  process.env.SUPPORT_EMAIL = 'support@docbook.test';
  const mail = fakeMail();
  await tickets.sendToPlatform(nurse, tk.id, business, { mail });
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].to, 'support@docbook.test');
  await assert.rejects(tickets.sendToPlatform(nurse, tk.id, business, { mail }), (e) => e.code === 'ALREADY_SENT');
  if (saved === undefined) delete process.env.SUPPORT_EMAIL; else process.env.SUPPORT_EMAIL = saved;
});

test('presence: same clinic only, hidden members are not recorded nor shown', async () => {
  await presence.touch(nurse, { force: true });
  await presence.touch(other, { force: true });
  const map = await presence.forClinic(owner);
  assert.equal(map[nurse.userId].online, true);
  assert.equal(map[other.userId], undefined); // another clinic's member never appears
  assert.equal(map[reception.userId].lastSeenAt, null);

  await presence.savePrefs(nurse, { presence_hidden: '1', sound_enabled: '1' });
  assert.equal(await knex('user_presence').where({ user_id: nurse.userId }).first(), undefined);
  assert.equal(await presence.touch(nurse, { force: true }), false);
  const after = await presence.forClinic(owner);
  assert.equal(after[nurse.userId].hidden, true);
  assert.equal(after[nurse.userId].online, false);
  assert.equal((await presence.forClinic(nurse))[nurse.userId].hidden, false); // they still see themselves

  const t = translator('en');
  const now = Date.now();
  assert.equal(presence.label({ online: true }, t, 'en', now), 'Online');
  assert.equal(presence.label({ online: false, lastSeenAt: new Date(now - 5 * 60000) }, t, 'en', now), 'Last seen 5 minutes ago');
  assert.equal(presence.label({ hidden: true }, t, 'en', now), 'Hidden');
  await presence.savePrefs(nurse, { sound_enabled: '1' });
});

test('notification e-mails: event mapping and recipient resolution', async () => {
  assert.equal(notifyMail.eventFor('appointment.booked_online'), 'booking_online');
  assert.equal(notifyMail.eventFor('budget_alert'), 'budget_alert');
  assert.equal(notifyMail.eventFor('budget.exceeded'), 'budget_alert');
  assert.equal(notifyMail.eventFor('ticket.reply'), 'ticket_reply');
  assert.equal(notifyMail.eventFor('something.else'), null);

  const members = [
    { userId: 1, email: 'Owner@c.test', roleKey: 'owner', permissions: new Set(['billing.manage', 'appointments.manage']), locale: 'en' },
    { userId: 2, email: 'rec@c.test', roleKey: 'receptionist', permissions: new Set(['appointments.manage']), locale: 'ar' },
    { userId: 3, email: 'acc@c.test', roleKey: 'accountant', permissions: new Set(['billing.manage']), locale: 'ar' },
  ];
  const rule = { enabled: true, roles: ['owner', 'receptionist'], user_ids: [3], emails: ['owner@c.test', 'extra@c.test'] };
  // Permission-targeted: only holders of the permission, plus extra addresses (deduplicated case-insensitively).
  let got = notifyMail.resolveRecipients(rule, members, { permission: 'billing.manage' }).map((r) => r.email);
  assert.deepEqual(got.sort(), ['acc@c.test', 'extra@c.test', 'owner@c.test']);
  got = notifyMail.resolveRecipients(rule, members, { permission: 'appointments.manage' }).map((r) => r.email);
  assert.deepEqual(got.sort(), ['extra@c.test', 'owner@c.test', 'rec@c.test']);
  // Person-targeted: that person only (if chosen), never the extra addresses.
  assert.deepEqual(notifyMail.resolveRecipients(rule, members, { user_id: 2 }).map((r) => r.email), ['rec@c.test']);
  assert.deepEqual(notifyMail.resolveRecipients({ ...rule, roles: ['owner'], user_ids: [] }, members, { user_id: 2 }), []);
  assert.deepEqual(notifyMail.resolveRecipients({ ...rule, enabled: false }, members, {}), []);

  const parsed = notifyMail.parseEmails('a@b.co, bad@@x; c@d.org  a@b.co');
  assert.deepEqual(parsed.emails, ['a@b.co', 'c@d.org']);
  assert.deepEqual(parsed.invalid, ['bad@@x']);

  // Stored rule + deliver with a fake mailer.
  const out = await notifyMail.saveRules(owner, { enabled_low_stock: '1', roles_low_stock: ['owner', 'not_a_role'], emails_low_stock: 'stock@c.test' }, { roleKeys: ['owner', 'nurse'], memberIds: [owner.userId] });
  assert.equal(out.invalid, null);
  const mail = fakeMail();
  const sent = await notifyMail.deliver(owner.businessId, { type: 'supplies.low_stock', permission: 'supplies.view', title: 'Gloves: 2', link: '/app/supplies' }, { mail, members: await notifyMail.activeMembers(owner.businessId) });
  assert.deepEqual(sent.sort(), [`teamops${tag}@t.test`, 'stock@c.test'].sort());
  assert.equal(await notifyMail.deliver(owner.businessId, { type: 'review.new', title: 'x' }, { mail }).then((s) => s.length), 0); // not enabled
  const bad = await notifyMail.saveRules(owner, { emails_review_new: 'nope' }, { roleKeys: [], memberIds: [] });
  assert.deepEqual(bad.invalid, { review_new: ['nope'] });
});

test('doctor e-mail: validation, address, attachments and rate limit', async () => {
  const mail = fakeMail();
  const to = { patientId };
  await assert.rejects(patientMail.send(doctor, business, to, { subject: '', body: '' }, { mail }), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.subject && e.details.body));
  await assert.rejects(patientMail.send(doctor, business, { patientId: noMailPatientId }, { subject: 'Hi', body: 'Hello' }, { mail }), (e) => e.code === 'PATIENT_NO_EMAIL');
  await assert.rejects(patientMail.send(other, business, to, { subject: 'Hi', body: 'Hello' }, { mail }), (e) => e.code === 'NOT_FOUND'); // other clinic
  await assert.rejects(patientMail.send(doctor, business, to, { subject: 'Hi', body: 'Hello' }, { mail: { ...mail, configured: () => false } }), (e) => e.code === 'MAIL_NOT_CONFIGURED');
  await assert.rejects(patientMail.send(doctor, business, to, { subject: 'Hi', body: 'Hello', docs: ['999999'] }, { mail }), (e) => e.code === 'VALIDATION_FAILED'); // not a shared document

  const r = await patientMail.send(doctor, business, to, { subject: 'Your results', body: 'All normal.' }, { mail });
  assert.ok(r.id);
  const m = mail.sent[0];
  assert.equal(m.to, `sara${tag}@t.test`);
  assert.equal(m.replyTo, `rana${tag}@t.test`); // the doctor's own address
  assert.match(m.fromName, /د\. رنا/);
  const row = await knex('doctor_emails').where({ id: r.id }).first();
  assert.equal(row.body, 'All normal.');
  assert.equal(row.status, 'sent');
  assert.ok(await knex('audit_logs').where({ business_id: owner.businessId, action: 'patient.emailed' }).first());

  for (let i = 1; i < patientMail.LIMITS.perPatientHour; i += 1) await patientMail.send(reception, business, to, { subject: `S${i}`, body: 'B' }, { mail }); // eslint-disable-line no-await-in-loop
  await assert.rejects(patientMail.send(reception, business, to, { subject: 'one more', body: 'B' }, { mail }), (e) => e.code === 'RATE_LIMITED');
  const hist = await patientMail.history(owner, { patient: { id: patientId } });
  assert.equal(hist.length, 5);
});
