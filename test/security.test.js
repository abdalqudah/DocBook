// Security regressions (review of 2026-10): accounts are never taken over through another clinic, ids from other
// clinics are refused, the SMS gateway cannot reach internal addresses, lock-outs do not reveal accounts.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const appts = require('../src/modules/clinic/appointments.service');
const rbac = require('../src/modules/rbac/rbac.service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `sec-${k}-${tag}@t.test`;
let A; let B;

async function clinic(k) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: mail(k), password: 'Passw0rd!x' });
    await businesses.create(id, { name: `Sec ${k}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  const ctx = { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), timezone: 'Asia/Amman', currency: 'JOD', today: '2026-10-05', baseUrl: 'http://x' };
  return { businessId, userId, ctx };
}

test.before(async () => { await knex.migrate.latest(); cache.forgetPrefix(''); A = await clinic('a'); B = await clinic('b'); });
test.after(async () => { await knex.destroy(); });

test('an existing account is invited, never attached; a clinic never gets an on-screen reset link for an admin', async () => {
  const [adminId] = await knex('users').insert({ name: 'Platform', email: mail('admin'), password_hash: 'x', is_platform_admin: true });
  const role = await knex('roles').where({ business_id: A.businessId, key: 'receptionist' }).first('id');
  const out = await businesses.addStaff(A.ctx, { name: 'X', email: mail('admin'), roleId: role.id, mode: 'password', locale: 'en' });
  assert.ok(out.link && !out.password, 'an invitation, not an account with a temporary password');
  assert.equal(await knex('memberships').where({ business_id: A.businessId, user_id: adminId }).first(), undefined, 'not attached');
  // even if an admin did accept an invitation, the clinic only e-mails a reset link
  const [mid] = await knex('memberships').insert({ business_id: A.businessId, user_id: adminId, role_id: role.id });
  await assert.rejects(businesses.adminResetLink(A.ctx, mid), (e) => e.code === 'RESET_NEEDS_EMAIL');
  // the answer does not tell which addresses have accounts
  const fresh = await businesses.addStaff(A.ctx, { name: 'Y', email: mail('nobody'), roleId: role.id, mode: 'invite', locale: 'en' });
  assert.ok(fresh.link && !fresh.added);
});

test('ids of another clinic are refused (service, doctor, insurance company)', async () => {
  const [svcB] = await knex('services').insert({ business_id: B.businessId, name: 'B only', price: 9, duration_minutes: 30, is_active: true });
  const [insB] = await knex('insurance_providers').insert({ business_id: B.businessId, name: 'B Insurance', coverage_percent: 50, is_active: true });
  await assert.rejects(appts.book(A.ctx, { patient_name: 'P', patient_phone: '0791234567', appointment_date: '2026-12-01', appointment_time: '10:00', service_id: svcB }), (e) => e.code === 'VALIDATION_FAILED');
  await assert.rejects(appts.savePatient(A.ctx, null, { full_name: 'P2', phone: '0791234568', insurance_provider_id: insB }), (e) => e.code === 'VALIDATION_FAILED');
});

test('the SMS gateway address cannot point at the server or its network', async () => {
  const http = require('../src/core/http');
  for (const u of ['http://169.254.169.254/latest', 'https://127.0.0.1:8080/x', 'https://localhost/x', 'https://10.0.0.5/sms']) assert.ok(http.validateUrl(u).error, u);
  const ch = require('../src/modules/messaging/channels');
  const r = await ch.sendSms({ url: 'https://127.0.0.1/sms', method: 'POST', contentType: 'application/json', bodyTemplate: '{"to":"{to}"}' }, '962790000000', 'x');
  assert.deepEqual(r, { ok: false, error: 'blocked_url' });
});

test('sign-in lock-out looks the same for an address with or without an account', async () => {
  const unknown = `ghost-${tag}@t.test`;
  for (let i = 0; i < 10; i += 1) await assert.rejects(auth.authenticate({ email: unknown, password: 'nope' })); // eslint-disable-line no-await-in-loop
  await assert.rejects(auth.authenticate({ email: unknown, password: 'nope' }), (e) => e.code === 'TOO_MANY_ATTEMPTS');
});

test('a clinic cannot add Google Tag Manager to its pages', async () => {
  const mkt = require('../src/modules/website/marketing.service');
  assert.ok(!mkt.PIXELS.includes('gtm'));
  await knex('businesses').where({ id: A.businessId }).update({ marketing: JSON.stringify({ pixels: { gtm: 'GTM-ABC123', ga4: 'G-ABC1234567' } }) });
  cache.forgetPrefix('');
  const m = await mkt.get(A.businessId);
  assert.equal(m.pixels.gtm, undefined);
  assert.equal(m.pixels.ga4, 'G-ABC1234567');
});

test('a clinic\'s own backup: restores that clinic only, can bring a deleted clinic back, and only this server reads it', async () => {
  process.env.CLINIC_BACKUP_DIR = require('path').join(require('os').tmpdir(), `dbk-${tag}`);
  delete require.cache[require.resolve('../src/modules/platformops/clinic-backup')];
  const backup = require('../src/modules/platformops/clinic-backup');
  const [pa] = await knex('patients').insert({ business_id: A.businessId, full_name: 'Backup Patient A', phone: '0790001111' });
  const [pb] = await knex('patients').insert({ business_id: B.businessId, full_name: 'Patient B', phone: '0790002222' });
  const made = await backup.createBackup(A.businessId, { reason: 'manual' });
  assert.ok(made.rows > 0);
  assert.equal(backup.list(A.businessId).length, 1);
  // A changes after the backup; B changes too
  await knex('patients').where({ id: pa }).del();
  await knex('patients').insert({ business_id: A.businessId, full_name: 'Added later', phone: '0790003333' });
  await knex('patients').where({ id: pb }).update({ full_name: 'Patient B renamed' });
  const r = await backup.restore(backup.read(A.businessId, made.name), { businessId: A.businessId });
  assert.equal(r.businessId, A.businessId);
  assert.ok(await knex('patients').where({ id: pa, business_id: A.businessId }).first(), 'A is back');
  assert.equal(await knex('patients').where({ business_id: A.businessId, full_name: 'Added later' }).first(), undefined);
  assert.equal((await knex('patients').where({ id: pb }).first('full_name')).full_name, 'Patient B renamed', 'B untouched');
  await assert.rejects(backup.restore(backup.read(A.businessId, made.name), { businessId: B.businessId }), (e) => e.code === 'BACKUP_OTHER_CLINIC');
  await assert.rejects(backup.restore(Buffer.from('not a backup at all, really not')), (e) => e.code === 'BACKUP_INVALID');
  const raw = backup.read(A.businessId, made.name);
  assert.ok(!raw.includes(Buffer.from('Backup Patient A')), 'encrypted on disk');
  // a deleted clinic comes back from its file
  await knex.transaction(async (trx) => { await trx.raw('SET FOREIGN_KEY_CHECKS=0'); await trx('patients').where({ business_id: A.businessId }).del(); await trx('memberships').where({ business_id: A.businessId }).del(); await trx('businesses').where({ id: A.businessId }).del(); await trx.raw('SET FOREIGN_KEY_CHECKS=1'); });
  await backup.restore(raw);
  assert.ok(await knex('businesses').where({ id: A.businessId }).first('id'));
  assert.ok(await knex('patients').where({ id: pa }).first('id'));
  assert.ok(await knex('memberships').where({ business_id: A.businessId, user_id: A.userId }).first('id'), 'the owner can sign in again');
  require('fs').rmSync(process.env.CLINIC_BACKUP_DIR, { recursive: true, force: true });
});
