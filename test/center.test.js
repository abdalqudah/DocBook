// Medical centre: sign-up as a centre, invite a doctor (new practice by sign-up, or an existing clinic), the shared
// reception acting on any practice of the centre (and nothing outside it), the shared cash screen only for practices
// that share their payments (the invoice stays in the visit's practice), and the centre-wide waiting screen.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const centers = require('../src/modules/center/center.service');
const queue = require('../src/modules/queue/queue.service');
const mailer = require('../src/core/mailer');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `ce-${k}-${tag}@t.test`;
let app; let A; let Bp; let C; let X; let center; let apptB; let apptA;
const today = () => scheduling.clinicNow('Asia/Amman').date;
mailer.configured = () => false;

async function owned(email, name) {
  const id = await knex.transaction(async (trx) => {
    const u = await auth.createUser(trx, { name: 'Dr', email, password: 'Passw0rd!x' });
    await businesses.create(u, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return u;
  });
  await knex('users').where({ id }).update({ email_verified_at: new Date() });
  const { last_business_id: b } = await knex('users').where({ id }).first('last_business_id');
  await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date() });
  return b;
}
async function visit(b, name, extra = {}) {
  const [doc] = await knex('doctors').insert({ business_id: b, full_name: `د. ${name}`, is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()) });
  const [id] = await knex('appointments').insert({ business_id: b, doctor_id: doc, patient_name: name, patient_phone: '0790000000', appointment_date: today(), appointment_time: '10:00', duration_minutes: 20, status: 'confirmed', ...extra });
  return id;
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('sign up as a medical centre: the first practice and the centre', async () => {
  const a = app.agent();
  const page = await a.get('/signup');
  assert.match(page.text, /account_type/);
  const r = await a.post('/signup', { _csrf: a.csrf(page.text), name: 'Dr Mansour', email: mail('a'), password: 'Passw0rd!x-Long', clinic_name: 'عيادة د. منصور', center_name: 'مجمع الشفاء', account_type: 'center', currency: 'JOD', timezone: 'Asia/Amman', terms: 'on' });
  assert.equal(r.status, 302);
  const u = await knex('users').where({ email: mail('a') }).first();
  A = u.last_business_id;
  const b = await knex('businesses').where({ id: A }).first();
  assert.ok(b.center_id);
  center = await knex('centers').where({ id: b.center_id }).first();
  assert.equal(center.name, 'مجمع الشفاء');
  assert.equal(center.owner_business_id, A);
  await knex('users').where({ id: u.id }).update({ email_verified_at: new Date() });
  await knex('businesses').where({ id: A }).update({ onboarding_completed_at: new Date() });
});

test('an invited doctor signs up into the centre; another brings the clinic they own', async () => {
  const a = app.agent(); await a.login(mail('a'), 'Passw0rd!x-Long');
  const pg = await a.get('/app/center');
  assert.equal(pg.status, 200);
  let r = await a.post('/app/center/invite', { _csrf: a.csrf(pg.text), email: mail('b') });
  assert.equal(r.status, 302);
  const link = (await a.get('/app/center')).text.match(/\/workspaces\/center\/([A-Za-z0-9_-]+)/)[1];
  // New doctor: the invitation leads to sign-up, the new practice joins.
  const b = app.agent();
  r = await b.get(`/workspaces/center/${link}`);
  assert.equal(r.status, 302);
  assert.match(r.location, /\/signup\?center=/);
  const su = await b.get(r.location);
  assert.match(su.text, /مجمع الشفاء/);
  r = await b.post('/signup', { _csrf: b.csrf(su.text), name: 'Dr Lama', email: mail('b'), password: 'Passw0rd!x-Long', clinic_name: 'عيادة د. لما', center_token: link, currency: 'JOD', timezone: 'Asia/Amman', terms: 'on' });
  assert.equal(r.status, 302);
  Bp = (await knex('users').where({ email: mail('b') }).first()).last_business_id;
  assert.equal((await knex('businesses').where({ id: Bp }).first()).center_id, center.id);
  await knex('businesses').where({ id: Bp }).update({ onboarding_completed_at: new Date() });
  await knex('users').where({ email: mail('b') }).update({ email_verified_at: new Date() });
  // The link is used: it cannot be used twice.
  assert.equal(await centers.inviteByToken(link), null);
  // An existing clinic joins with a second invitation.
  C = await owned(mail('c'), 'Clinic C');
  const inv = await centers.invite({ businessId: A, userId: null }, mail('c'), { base: 'http://x' });
  const tok = inv.link.split('/').pop();
  const c = app.agent(); await c.login(mail('c'));
  const jp = await c.get(`/workspaces/center/${tok}`);
  assert.equal(jp.status, 200);
  r = await c.post(`/workspaces/center/${tok}`, { _csrf: c.csrf(jp.text), mode: 'existing', business_id: String(C) });
  assert.equal(r.status, 302);
  assert.equal((await knex('businesses').where({ id: C }).first()).center_id, center.id);
  assert.ok(await knex('audit_logs').where({ business_id: C, action: 'center.joined' }).first());
});

test('shared reception: sees every practice today and checks in / sends in their patients; nothing outside the centre', async () => {
  apptA = await visit(A, 'Ahmad');
  apptB = await visit(Bp, 'Farah');
  X = await owned(mail('x'), 'Outside');
  const apptX = await visit(X, 'Outsider');
  // A receptionist of practice A only.
  const rid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Rec', email: mail('r'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: rid }).update({ last_business_id: A, email_verified_at: new Date() });
  await knex('memberships').insert({ business_id: A, user_id: rid, role_id: (await rbac.getRoleByKey(A, 'receptionist')).id });
  const r = app.agent(); await r.login(mail('r'));
  const desk = await r.get('/app/center/desk');
  assert.equal(desk.status, 200);
  assert.match(desk.text, /Ahmad/);
  assert.match(desk.text, /Farah/);
  assert.doesNotMatch(desk.text, /Outsider/);
  let p = await r.post(`/app/center/desk/${Bp}/${apptB}/check-in`, { _csrf: r.csrf(desk.text) });
  assert.equal(p.status, 302);
  assert.equal(Boolean((await knex('appointments').where({ id: apptB }).first()).checked_in), true);
  p = await r.post(`/app/center/desk/${Bp}/${apptB}/call-in`, { _csrf: r.csrf(desk.text) });
  assert.equal(Boolean((await knex('appointments').where({ id: apptB }).first()).with_doctor), true);
  assert.ok(await knex('audit_logs').where({ business_id: Bp, action: 'appointment.checked_in' }).first()); // in B's own log
  // Outside the centre, or a wrong practice id for the visit: refused.
  await r.post(`/app/center/desk/${X}/${apptX}/check-in`, { _csrf: r.csrf(desk.text) });
  assert.equal(Boolean((await knex('appointments').where({ id: apptX }).first()).checked_in), false);
  await r.post(`/app/center/desk/${Bp}/${apptA}/check-in`, { _csrf: r.csrf(desk.text) }); // A's visit under B's id
  assert.equal(Boolean((await knex('appointments').where({ id: apptA }).first()).checked_in), false);
  // Still nothing else is shared: B's patients list stays B's.
  assert.equal((await r.get(`/app/appointments/${apptB}`)).status, 404);
});

test('shared cash screen: only practices that share their payments; the invoice stays in the visit\'s practice', async () => {
  await knex('appointments').where({ id: apptB }).update({ with_doctor: false, status: 'completed', doctor_finished_at: new Date(), amount_due: 30 });
  const a = app.agent(); await a.login(mail('a'), 'Passw0rd!x-Long');
  let data = JSON.parse((await a.get('/app/cashier/screen/data?scope=center')).text);
  assert.ok(!data.visits.some((v) => v.id === apptB)); // B keeps its own screen
  const page = await a.get('/app/cashier/screen?scope=center');
  assert.equal(page.status, 200);
  const deny = await a.post('/app/cashier/screen/checkout', { _csrf: a.csrf(page.text), payment_method: 'cash', 'lines[0][appointment_id]': String(apptB), 'lines[0][amount]': '30' }, { accept: 'application/json' });
  assert.notEqual(deny.status, 200);
  await knex('businesses').where({ id: Bp }).update({ center_share_cash: true });
  cache.forgetPrefix('');
  data = JSON.parse((await a.get('/app/cashier/screen/data?scope=center')).text);
  const v = data.visits.find((x) => x.id === apptB);
  assert.ok(v);
  assert.match(v.practice, /لما/);
  const res = await a.post('/app/cashier/screen/checkout', { _csrf: a.csrf(page.text), payment_method: 'cash', amount_received: '30', 'lines[0][appointment_id]': String(apptB), 'lines[0][amount]': '30' }, { accept: 'application/json' });
  const out = JSON.parse(res.text);
  assert.equal(out.ok, true, res.text);
  const inv = await knex('invoices').where({ id: out.invoices[0].id }).first();
  assert.equal(inv.business_id, Bp);
  assert.equal((await a.get(out.printUrl)).status, 200); // the receipt opens from the shared screen
});

test('a waiting screen for the whole centre shows every practice; a clinic screen only its own', async () => {
  await knex('appointments').where({ id: apptA }).update({ checked_in: true, arrived_at: new Date() });
  await visit(Bp, 'Sara', { checked_in: true, arrived_at: new Date() });
  const clinic = await businesses.get(A);
  const both = await queue.board({ scope: 'center', name_style: 'full' }, clinic);
  const own = await queue.board({ scope: 'clinic', name_style: 'full' }, clinic);
  const names = (bd) => [bd.now, bd.next, ...bd.waiting, ...bd.rooms].filter(Boolean).map((x) => x.name);
  assert.ok(names(own).includes('Ahmad'));
  assert.ok(!names(own).includes('Sara'));
  assert.ok(names(both).includes('Ahmad'));
  assert.ok(names(both).includes('Sara'));
});
