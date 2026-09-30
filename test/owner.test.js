// Owner setup journey (worker: owner) against the test database: the setup wizard's step services — validation,
// saving twice never duplicates, the owner linking themselves as the doctor, clinic hours given to doctors,
// suggested services saved only when ticked, staff logins through the staff service (no double invitations),
// the saved position never moving backwards, and the home-page checklist.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const setup = require('../src/modules/onboarding/setup.service');
const team = require('../src/modules/settings/team.web');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let ctx; let other;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');

async function makeClinic(email, name, specialty = 'dentistry') {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Dr Laila Mansour', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman', specialty }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  return { businessId, userId, userName: 'Dr Laila Mansour', roleKey: 'owner', ownDoctorId: null, permissions: await rbac.getUserPermissions(businessId, userId), locale: 'en', timezone: 'Asia/Amman', currency: 'JOD' };
}
const errOf = async (p) => { try { await p; } catch (e) { return e; } return null; };

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ctx = await makeClinic(`owner${tag}@t.test`, 'عيادة الابتسامة');
  other = await makeClinic(`owner-other${tag}@t.test`, 'عيادة أخرى', 'cardiology');
});
test.after(async () => { await knex.destroy(); });

test('clinic basics: validation, then saved with the logo', async () => {
  let e = await errOf(setup.saveClinic(ctx, { name: 'x', phone: 'abc' }));
  assert.equal(e.code, 'VALIDATION_FAILED');
  assert.ok(e.details.name && e.details.phone);
  e = await errOf(setup.saveClinic(ctx, { name: 'عيادة الابتسامة', logo_data: 'data:image/png;base64,AAAA' }));
  assert.ok(e.details.logo, 'a PNG header is required');
  assert.throws(() => setup.parseLogo('data:image/gif;base64,R0lGOD'), (x) => Boolean(x.details.logo));
  await setup.saveClinic(ctx, { name: 'عيادة الابتسامة', name_en: 'Smile Clinic', specialty: 'dentistry', phone: '0791234567', whatsapp: '0791234567', city: 'Amman', address: 'Gardens St.', logo_data: `data:image/png;base64,${PNG.toString('base64')}` });
  const b = await knex('businesses').where({ id: ctx.businessId }).first();
  assert.equal(b.address, 'Gardens St.');
  assert.equal(b.logo_mime, 'image/png');
  assert.equal(b.country, null, 'no time zone sent → country untouched');
});

test('hours: validation and the clinic week given to doctors', async () => {
  let e = await errOf(setup.saveHours(ctx, { days: [], s1: '09:00', e1: '17:00' }));
  assert.ok(e.details.days);
  e = await errOf(setup.saveHours(ctx, { days: ['sat'], s1: '17:00', e1: '09:00' }));
  assert.ok(e.details.e1);
  e = await errOf(setup.saveHours(ctx, { days: ['sat'], s1: '09:00', e1: '13:00', split: '1', s2: '12:00', e2: '20:00' }));
  assert.ok(e.details.s2, 'the evening shift starts after the first one');
  const r = await setup.saveHours(ctx, { days: ['sat', 'sun', 'mon', 'tue', 'wed', 'thu'], s1: '09:00', e1: '13:00', split: '1', s2: '16:00', e2: '20:00' });
  assert.equal(r.applied, 0);
  const week = await setup.clinicHours(ctx.businessId);
  assert.equal(week.fri.enabled, false);
  assert.deepEqual(week.sat.shifts, [{ start: '09:00', end: '13:00' }, { start: '16:00', end: '20:00' }]);
  const f = setup.hoursForm(week);
  assert.equal(f.split, true);
  assert.equal(f.days.length, 6);
});

test('doctors: the owner as the doctor, duplicates refused, clinic hours used', async () => {
  const e = await errOf(setup.addDoctor(ctx, { full_name: '' }));
  assert.ok(e.details.full_name);
  const id = await setup.addDoctor(ctx, { full_name: 'Dr Laila Mansour', consultation_fee: '20', slot_duration_minutes: '30', is_me: '1' });
  const m = await knex('memberships').where({ business_id: ctx.businessId, user_id: ctx.userId }).first();
  assert.equal(m.doctor_id, id);
  const d = await knex('doctors').where({ id }).first();
  assert.equal(Number(d.consultation_fee), 20);
  const wh = typeof d.working_hours === 'string' ? JSON.parse(d.working_hours) : d.working_hours;
  assert.equal(wh.sat.shifts.length, 2, 'the clinic week, not the generic default');
  const dup = await errOf(setup.addDoctor(ctx, { full_name: '  dr laila   mansour ' }));
  assert.ok(dup.details.full_name, 'same name again is refused');
  const again = await errOf(setup.addDoctor(ctx, { full_name: 'Dr Karim Odeh', is_me: '1' }));
  assert.ok(again.details.is_me, 'the login is already linked');
  assert.ok(await errOf(setup.addDoctor(ctx, { full_name: 'Dr Karim Odeh', slot_duration_minutes: '7' })));
  await setup.addDoctor(ctx, { full_name: 'Dr Karim Odeh', consultation_fee: '15', slot_duration_minutes: '20' });
  assert.equal((await setup.listDoctors(ctx.businessId)).length, 2);
  // Re-saving the hours with "apply to doctors" updates both.
  const r = await setup.saveHours(ctx, { days: ['sun', 'mon'], s1: '10:00', e1: '18:00', apply_doctors: '1' });
  assert.equal(r.applied, 2);
});

test('services: only ticked suggestions are saved, a second save adds nothing', async () => {
  assert.equal(setup.suggestions('dentistry').some((s) => s.key === 'cleaning'), true);
  assert.equal(setup.suggestions(null), setup.CATALOG.general);
  let e = await errOf(setup.saveSuggested(ctx, 'dentistry', { pick: [] }));
  assert.ok(e.details.pick);
  e = await errOf(setup.saveSuggested(ctx, 'dentistry', { pick: ['cleaning'], svc: { cleaning: { price: '' } } }));
  assert.ok(e.details['svc.cleaning.price'], 'a ticked service needs a price');
  assert.equal((await setup.listServices(ctx.businessId)).length, 0, 'nothing saved after an error');
  const r = await setup.saveSuggested(ctx, 'dentistry', {
    pick: ['consult', 'cleaning', 'not-a-key'],
    svc: { consult: { price: '0' }, cleaning: { price: '25', min: '45', name: 'Deep cleaning' }, filling: { price: '35' } },
  }, 'en');
  assert.equal(r.added.length, 2);
  const rows = await setup.listServices(ctx.businessId);
  assert.equal(rows.length, 2, 'the priced but unticked filling is not saved');
  const consult = rows.find((s) => s.name_en === 'Dental check-up');
  assert.equal(consult.name, 'كشف وفحص أسنان', 'unchanged names are saved in both languages');
  assert.equal(Number(consult.price), 0);
  const clean = rows.find((s) => s.name === 'Deep cleaning');
  assert.equal(clean.duration_minutes, 45);
  const again = await setup.saveSuggested(ctx, 'dentistry', { pick: ['consult'], svc: { consult: { price: '10' } } }, 'ar');
  assert.deepEqual(again.added, []);
  assert.equal(again.skipped.length, 1);
  assert.equal((await setup.listServices(ctx.businessId)).length, 2);
  assert.ok((await errOf(setup.addOwnService(ctx, { name: 'Deep cleaning', price: '5' }))).details.name);
  assert.ok((await errOf(setup.addOwnService(ctx, { name: 'Home visit' }))).details.price);
  await setup.addOwnService(ctx, { name: 'Home visit', price: '40', duration_minutes: '60' });
  assert.equal((await setup.listServices(ctx.businessId)).length, 3);
  assert.equal((await setup.listServices(other.businessId)).length, 0, 'other clinics untouched');
});

test('staff logins: through the staff service, never twice', async () => {
  const roles = await setup.staffRoles(ctx.businessId);
  assert.deepEqual(roles.map((r) => r.key), setup.STAFF_ROLES);
  const rec = roles.find((r) => r.key === 'receptionist');
  const otherRole = (await setup.staffRoles(other.businessId))[0];
  assert.ok((await errOf(setup.checkStaff(ctx, { role_id: otherRole.id, email: 'x@t.test' }))).details.role_id, "another clinic's role is refused");
  const owner = await knex('roles').where({ business_id: ctx.businessId, key: 'owner' }).first();
  assert.ok(await errOf(setup.checkStaff(ctx, { role_id: owner.id })), 'the owner role is not offered');
  const req = { ctx };
  const body = { role_id: String(rec.id), name: 'Sara Khalil', email: `sara${tag}@t.test`, phone: '0799999999', mode: 'password', locale: 'ar' };
  await setup.checkStaff(ctx, body);
  const r = await team.addLogin(req, body);
  assert.equal(r.type, 'password');
  assert.ok(r.password.length >= 8);
  const dup = await errOf(setup.checkStaff(ctx, { ...body, email: body.email.toUpperCase() }));
  assert.ok(dup.details.email, 'already has a login');
  const nurse = roles.find((x) => x.key === 'nurse');
  const inv = { role_id: String(nurse.id), name: 'Rana', email: `rana${tag}@t.test`, mode: 'invite', locale: 'en' };
  await setup.checkStaff(ctx, inv);
  assert.equal((await team.addLogin(req, inv)).type, 'invite');
  assert.ok((await errOf(setup.checkStaff(ctx, inv))).details.email, 'already invited');
  const acc = roles.find((x) => x.key === 'accountant');
  assert.equal((await errOf(team.addLogin(req, { role_id: String(acc.id), name: 'M', email: 'bad', mode: 'password' }))).code, 'VALIDATION_FAILED');
});

test('progress never moves back; finishing is recorded once; checklist', async () => {
  let b = await knex('businesses').where({ id: ctx.businessId }).first();
  assert.equal(setup.stepOf(b.onboarding_step), 'clinic');
  assert.equal(setup.stepOf('region'), 'hours');
  assert.equal(setup.stepOf('page'), 'booking');
  assert.equal(await setup.advance(ctx.businessId, 'clinic', 'services'), 'team');
  await setup.advance(ctx.businessId, 'team', 'clinic');
  b = await knex('businesses').where({ id: ctx.businessId }).first();
  assert.equal(b.onboarding_step, 'team');

  await businesses.updateProfile(ctx, { booking_enabled: false });
  let list = await setup.checklist(ctx.businessId);
  const byKey = Object.fromEntries(list.items.map((i) => [i.key, i.done]));
  assert.deepEqual(byKey, { clinic: true, logo: true, hours: true, doctors: true, services: true, team: true, booking: false, first_appointment: false });
  assert.equal(list.percent, 75);

  const current = await businesses.get(ctx.businessId);
  assert.ok(await errOf(setup.saveBooking(ctx, current, { slug: 'app', booking_enabled: '1' })), 'reserved address refused');
  await setup.saveBooking(ctx, current, { slug: `smile-${tag}`.slice(0, 40), booking_enabled: '1' });
  list = await setup.checklist(ctx.businessId);
  assert.equal(list.items.find((i) => i.key === 'booking').done, true);

  assert.equal(await setup.complete(ctx), true);
  assert.equal(await setup.complete(ctx), false, 'second time is a no-op');
  const audits = await knex('audit_logs').where({ business_id: ctx.businessId, action: 'clinic.setup_completed' }).count({ n: '*' }).first();
  assert.equal(Number(audits.n), 1);

  await setup.dismissChecklist(ctx);
  assert.equal((await setup.checklist(ctx.businessId)).dismissed, true);
  assert.equal((await setup.checklist(other.businessId)).dismissed, false);
});
