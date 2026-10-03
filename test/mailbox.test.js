// A member's own e-mail: connect (IMAP + SMTP checked, password stored encrypted), inbox and folders, a message in a
// sandboxed frame, reply, write with a clinic paper attached (from the prescription page), a copy in Sent; another
// member never sees it. Uses a fake mail server.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const mailbox = require('../src/modules/mailbox/mailbox.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `mb-${k}-${tag}@t.test`;
let app; let B; let rxId; let visit;
const sent = []; const appended = []; const logins = [];
const RAW = Buffer.from([
  'From: Lab One <results@lab.test>', 'To: me@clinic.test', 'Subject: CBC results', 'Message-ID: <abc@lab.test>', 'Date: Sat, 03 Oct 2026 10:00:00 +0300',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=XX', '', '--XX', 'Content-Type: text/html; charset=utf-8', '',
  '<p>Results attached.</p><script>alert(1)</script><img src="https://tracker.test/p.gif">', '--XX',
  'Content-Type: application/pdf; name=cbc.pdf', 'Content-Disposition: attachment; filename=cbc.pdf', 'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4 fake').toString('base64'), '--XX--', '',
].join('\r\n'));

function fakeImap(opts) {
  return {
    async connect() { logins.push(opts.auth); if (opts.auth.pass !== 'app-pass') throw Object.assign(new Error('Invalid credentials'), { responseText: 'AUTHENTICATIONFAILED' }); },
    async logout() {},
    async list() { return [{ path: 'INBOX', name: 'INBOX', flags: new Set() }, { path: 'Sent', name: 'Sent', specialUse: '\\Sent', flags: new Set() }, { path: 'Trash', name: 'Trash', specialUse: '\\Trash', flags: new Set() }]; },
    async status() { return { unseen: 1 }; },
    async mailboxOpen() { return { exists: 1 }; },
    async search() { return [1]; },
    async* fetch() { yield { uid: 7, envelope: { subject: 'CBC results', from: [{ name: 'Lab One', address: 'results@lab.test' }], to: [{ address: 'me@clinic.test' }], date: new Date('2026-10-03T07:00:00Z') }, flags: new Set(), size: 900, bodyStructure: { disposition: 'attachment' } }; },
    async fetchOne() { return { uid: 7, flags: new Set(), source: RAW }; },
    async messageFlagsAdd() {},
    async messageMove() {},
    async append(path, raw) { appended.push({ path, raw: String(raw) }); },
  };
}
function fakeSmtp() { return { async verify() { return true; }, async sendMail(m) { sent.push(m); return { messageId: 'x' }; }, close() {} }; }

async function clinic(k) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Dr Mail', email: mail(k), password: 'Passw0rd!x' });
    await businesses.create(id, { name: `Mail ${k}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: userId }).update({ email_verified_at: new Date() });
  const { last_business_id: b } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date() });
  return b;
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  mailbox.setDeps({ imap: fakeImap, smtp: fakeSmtp, resolve: async () => '93.184.216.34' });
  B = await clinic('a');
  const today = scheduling.clinicNow('Asia/Amman').date;
  const [doc] = await knex('doctors').insert({ business_id: B, full_name: 'Dr M', is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()), slot_duration_minutes: 30 });
  const [pid] = await knex('patients').insert({ business_id: B, full_name: 'Mail Patient', phone: '0791234567', email: 'patient@home.test' });
  [visit] = await knex('appointments').insert({ business_id: B, doctor_id: doc, patient_id: pid, patient_name: 'Mail Patient', patient_phone: '0791234567', appointment_date: today, appointment_time: '10:00', status: 'completed', appointment_type: 'in_person', source: 'staff' });
  [rxId] = await knex('prescriptions').insert({ business_id: B, appointment_id: visit, doctor_id: doc, patient_id: pid, patient_name: 'Mail Patient', items: JSON.stringify([{ medicationName: 'Amoxicillin', dosage: '500 mg' }]) });
  // A second member of the same clinic.
  const role = await rbac.getRoleByKey(B, 'receptionist');
  const other = await knex.transaction((trx) => auth.createUser(trx, { name: 'Recep', email: mail('r'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: other }).update({ last_business_id: B, email_verified_at: new Date() });
  await knex('memberships').insert({ business_id: B, user_id: other, role_id: role.id });
  rbac.invalidate(B);
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('my e-mail: connect, read, send with a clinic paper; private to the member', async () => {
  const o = app.agent(); await o.login(mail('a'));
  let r = await o.get('/app/mail');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/app/mail/settings');
  r = await o.submit('/app/mail/settings', '/app/mail/settings', { email: 'dr@myclinic.test', password: 'wrong' });
  assert.equal(r.status, 422, 'a wrong password is refused');
  assert.match(r.text, /AUTHENTICATIONFAILED/);
  r = await o.submit('/app/mail/settings', '/app/mail/settings', { email: 'dr@myclinic.test', password: 'app-pass', display_name: 'Dr Mail', signature: 'Dr Mail, Clinic' });
  assert.equal(r.status, 302);
  const row = await knex('staff_mailboxes').where({ business_id: B }).first();
  assert.equal(row.imap_host, 'mail.myclinic.test', 'servers guessed from the address');
  assert.ok(!String(row.secret_enc).includes('app-pass'), 'password stored encrypted');

  r = await o.get('/app/mail?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /CBC results/);
  assert.match(r.text, /Lab One/);
  assert.ok(r.text.indexOf('>Inbox<') < r.text.indexOf('>Sent<') && r.text.indexOf('>Sent<') < r.text.indexOf('>Trash<'), 'inbox first, then sent, then trash');
  r = await o.get('/app/mail/m?f=INBOX&uid=7&lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /sandbox="allow-popups allow-popups-to-escape-sandbox"/);
  assert.match(r.text, /cbc\.pdf/);
  r = await o.get('/app/mail/m/body?f=INBOX&uid=7');
  assert.match(r.text, /Results attached/);
  r = await o.get('/app/mail/m/file?f=INBOX&uid=7&i=0');
  assert.equal(r.status, 200);

  // From the prescription page: "send from my e-mail" → the composer with the paper and the patient's address.
  r = await o.get(`/app/visits/${visit}/prescriptions/${rxId}?lang=en`);
  assert.match(r.text, new RegExp(`/app/mail/compose\\?attach=prescription:${rxId}`));
  r = await o.get(`/app/mail/compose?attach=prescription:${rxId}&lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /value="patient@home\.test"/);
  assert.match(r.text, new RegExp(`name="papers" value="prescription:${rxId}" checked`));
  r = await o.submit('/app/mail/compose', '/app/mail/send', { to: 'patient@home.test', subject: 'Your prescription', text: 'Attached.', papers: `prescription:${rxId}` });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const m = sent.pop();
  assert.deepEqual(m.to, ['patient@home.test']);
  assert.equal(m.from.address, 'dr@myclinic.test');
  assert.match(m.text, /Dr Mail, Clinic/, 'signature');
  assert.equal(m.attachments.length, 1);
  assert.match(m.attachments[0].filename, /\.pdf$/);
  assert.ok(m.attachments[0].content.subarray(0, 4).toString() === '%PDF');
  assert.ok(appended.some((a) => a.path === 'Sent' && /Your prescription/.test(a.raw)), 'a copy in Sent');

  // Reply keeps the thread.
  r = await o.get('/app/mail/compose?reply=INBOX%7C7&lang=en');
  assert.match(r.text, /value="results@lab\.test"/);
  assert.match(r.text, /Re: CBC results/);
  assert.match(r.text, /name="in_reply_to" value="&lt;abc@lab\.test&gt;"/);

  // Another member of the clinic has no access to it.
  const other = app.agent(); await other.login(mail('r'));
  r = await other.get('/app/mail');
  assert.equal(r.location, '/app/mail/settings');
  r = await other.get('/app/mail/m?f=INBOX&uid=7');
  assert.equal(r.location, '/app/mail/settings');
  assert.equal((await knex('staff_mailboxes').where({ business_id: B }).count({ n: '*' }))[0].n, 1);
});
