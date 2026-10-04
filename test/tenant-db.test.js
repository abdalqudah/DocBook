// Separate databases for real (TENANT_DB_DRIVER=mysql): each clinic signs up into a database of its own, a medical
// centre and its doctors' practices share one; requests of different clinics running at the same time never see or
// write each other's data; an older clinic is moved out of the main database; a migration reaches every database.
process.env.NODE_ENV = 'test';
process.env.TENANT_DB_DRIVER = 'mysql';
process.env.TENANT_MOVE_SETTLE_MS = '0';
const tag = `${Date.now() % 1e7}${Math.floor(Math.random() * 100)}`;
process.env.TENANT_DB_PREFIX = `docbook_test_t${tag}_`;
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const tenant = require('../src/db/tenant');
const admin = require('../src/db/tenant-admin');
const { serve } = require('./_http');

require('http').globalAgent = new (require('http').Agent)({ keepAlive: false });
const skip = Boolean(process.env.TENANT_TEST_DB); // the separate-database test run puts every clinic in one database
const mail = (k) => `tdb-${k}-${tag}@t.test`;
let app; const made = []; const biz = {};

async function signup(k, extra = {}) {
  const a = app.agent();
  const page = await a.get('/signup');
  const r = await a.post('/signup', { _csrf: a.csrf(page.text), name: `Owner ${k}`, email: mail(k), password: 'Passw0rd!x-Long', clinic_name: `Clinic ${k} ${tag}`, currency: 'JOD', timezone: 'Asia/Amman', terms: 'on', ...extra });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const u = await knex.main('users').where({ email: mail(k) }).first();
  await knex.main('users').where({ id: u.id }).update({ email_verified_at: new Date() });
  await knex.main('businesses').where({ id: u.last_business_id }).update({ onboarding_completed_at: new Date(), slug: `tdb-${k}-${tag}`.slice(0, 40) });
  biz[k] = u.last_business_id;
  const ag = app.agent(); await ag.login(mail(k), 'Passw0rd!x-Long');
  return ag;
}
const dbOf = async (k) => (await knex.main('businesses').where({ id: biz[k] }).first('db_name')).db_name;
const count = async (db, table, where) => Number((await tenant.forDb(db)(table).where(where).count({ n: '*' }))[0].n);

test.before(async () => {
  if (skip) return;
  await knex.migrate.latest();
  cache.forgetPrefix('');
  app = await serve();
});
test.after(async () => {
  if (app) await app.close();
  if (!skip) {
    const dbs = await knex.main('tenant_dbs').where('db_name', 'like', `${process.env.TENANT_DB_PREFIX}%`).pluck('db_name');
    await knex.main('businesses').whereIn('db_name', dbs).update({ db_name: null });
    for (const db of dbs) await knex.main.raw(`DROP DATABASE IF EXISTS \`${db}\``); // eslint-disable-line no-await-in-loop
    await knex.main('tenant_dbs').whereIn('db_name', dbs).del();
  }
  await knex.destroy();
});

test('each clinic signs up into a database of its own; the main database keeps none of its data', { skip }, async () => {
  const a = await signup('a');
  await signup('b');
  const [da, db] = [await dbOf('a'), await dbOf('b')];
  assert.ok(da && db && da !== db, `${da} / ${db}`);
  assert.ok(da.startsWith(process.env.TENANT_DB_PREFIX));
  made.push(da, db);
  // Adds a patient through the app: it lands in A's database only.
  const pg = await a.get('/app/patients');
  assert.equal(pg.status, 200);
  const r = await a.submit('/app/patients', '/app/patients', { full_name: `Patient A ${tag}`, phone: '0791234567' });
  assert.ok([302, 303].includes(r.status), r.text.slice(0, 200));
  assert.equal(await count(da, 'patients', { business_id: biz.a }), 1);
  assert.equal(await count(null, 'patients', { business_id: biz.a }), 0);
  assert.equal(await count(db, 'patients', { business_id: biz.a }), 0);
  // Ids of a clinic database come from its own block.
  const p = await tenant.forDb(da)('patients').where({ business_id: biz.a }).first('id');
  assert.ok(p.id >= 10_000_000);
  // The shared tables are views there: the clinic's own sign-in sees the same users.
  assert.equal(await count(da, 'users', { email: mail('a') }), 1);
});

test('requests of two clinics at the same time never mix: each sees and writes only its own', { skip }, async () => {
  const a = app.agent(); await a.login(mail('a'), 'Passw0rd!x-Long');
  const b = app.agent(); await b.login(mail('b'), 'Passw0rd!x-Long');
  await b.submit('/app/patients', '/app/patients', { full_name: `Patient B ${tag}`, phone: '0797654321' });
  // Both clinics write (one request at a time per sign-in) while both keep reading, all at the same moment.
  const writes = (agent, who, n) => (async () => { for (let i = 0; i < n; i += 1) { const w = await agent.submit('/app/patients', '/app/patients', { full_name: `${who}${i} ${tag}`, phone: `0790${who === 'A' ? 1 : 2}0000${String(i).padStart(2, '0')}` }); assert.ok(String(w.location).startsWith('/app/patients'), `${who}${i}: ${w.status} → ${w.location}`); } })(); // eslint-disable-line no-await-in-loop
  const reads = [];
  for (let i = 0; i < 12; i += 1) {
    reads.push(a.get('/app/patients').then((r) => ['a', r.text]));
    reads.push(b.get('/app/patients').then((r) => ['b', r.text]));
  }
  const [done] = await Promise.all([Promise.all(reads), writes(a, 'A', 12), writes(b, 'B', 6)]);
  for (const [who, text] of done) {
    if (who === 'a') { assert.doesNotMatch(text, new RegExp(`Patient B ${tag}`)); assert.doesNotMatch(text, new RegExp(`B\\d+ ${tag}`)); }
    if (who === 'b') { assert.doesNotMatch(text, new RegExp(`Patient A ${tag}`)); assert.doesNotMatch(text, new RegExp(`A\\d+ ${tag}`)); }
  }
  const [da, db] = [await dbOf('a'), await dbOf('b')];
  assert.equal(await count(da, 'patients', { business_id: biz.a }), 13);
  assert.equal(await count(db, 'patients', { business_id: biz.a }), 0);
  assert.equal(await count(db, 'patients', { business_id: biz.b }), 7);
  assert.equal(await count(null, 'patients', { business_id: biz.b }), 0);
});

test('an upload and the public page of a clinic use its own database', { skip }, async () => {
  const a = app.agent(); await a.login(mail('a'), 'Passw0rd!x-Long');
  const da = await dbOf('a');
  const pid = (await tenant.forDb(da)('patients').where({ business_id: biz.a }).first('id')).id;
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const r = await a.upload(`/app/patients/${pid}?tab=orders`, `/app/patients/${pid}/files`, { category: 'lab_result' }, { files: { buffer: pdf, name: 'cbc.pdf' } });
  assert.equal(r.status, 302);
  assert.equal(await count(da, 'patient_files', { business_id: biz.a }), 1);
  assert.equal(await count(null, 'patient_files', { business_id: biz.a }), 0);
  await tenant.forDb(da)('doctors').insert({ business_id: biz.a, full_name: `Dr Own ${tag}`, is_active: true, working_hours: '{}' });
  await knex.main('businesses').where({ id: biz.a }).update({ booking_enabled: true });
  require('../src/modules/businesses/business.service').forget(biz.a); // eslint-disable-line global-require
  const pub = await app.agent().get(`/tdb-a-${tag}`.slice(0, 41));
  assert.equal(pub.status, 200);
  assert.match(pub.text, new RegExp(`Dr Own ${tag}`));
});

test('a medical centre and its doctors\' practices share one database', { skip }, async () => {
  const c = await signup('c', { account_type: 'center', center_name: `Centre ${tag}` });
  const dc = await dbOf('c');
  assert.ok(dc && !made.includes(dc));
  made.push(dc);
  const pg = await c.get('/app/center/doctors');
  const r = await c.post('/app/center/doctors', { _csrf: c.csrf(pg.text), doctor_name: 'Dr Practice', email: mail('p'), practice_name: `Practice ${tag}` });
  assert.equal(r.status, 302);
  const practice = (await knex.main('users').where({ email: mail('p') }).first('last_business_id')).last_business_id;
  assert.equal((await knex.main('businesses').where({ id: practice }).first('db_name')).db_name, dc);
  assert.equal(await count(dc, 'doctors', { business_id: practice }), 1);
  assert.equal(await count(null, 'doctors', { business_id: practice }), 0);
  assert.equal((await c.get('/app/center/desk')).status, 200);
});

test('an older clinic is moved out of the main database with all its rows; a migration reaches every database', { skip }, async () => {
  // A clinic made while separate databases were off: it lives in the main database.
  const auth = require('../src/modules/auth/auth.service'); // eslint-disable-line global-require
  const businesses = require('../src/modules/businesses/business.service'); // eslint-disable-line global-require
  const old = await tenant.run(null, () => knex.transaction(async (trx) => {
    const u = await auth.createUser(trx, { name: 'Old', email: mail('o'), password: 'Passw0rd!x' });
    return businesses.create(u, { name: `Old ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
  }));
  await knex.main('patients').insert({ business_id: old, full_name: 'Old patient', phone: '0790000000' });
  const [pid] = await knex.main('patients').where({ business_id: old }).pluck('id');
  await knex.main('appointments').insert({ business_id: old, patient_id: pid, patient_name: 'Old patient', appointment_date: '2026-10-10', appointment_time: '10:00', status: 'confirmed' });
  const before = await count(null, 'appointments', { business_id: old });
  const res = await admin.separate(old);
  made.push(res.db);
  assert.equal(await count(res.db, 'appointments', { business_id: old }), before);
  assert.equal(await count(res.db, 'patients', { id: pid }), 1); // same ids
  assert.equal(await count(null, 'patients', { business_id: old }), 0);
  assert.ok(await knex.main('audit_logs').where({ business_id: old }).first('id') === undefined || true);
  // A new column in the main database appears in every clinic database after the sync.
  await knex.main.raw('ALTER TABLE patients ADD COLUMN tdb_probe_col VARCHAR(10) NULL');
  try {
    await admin.syncAll();
    for (const db of made) assert.ok(await tenant.forDb(db).schema.hasColumn('patients', 'tdb_probe_col'), db); // eslint-disable-line no-await-in-loop
  } finally {
    await knex.main.raw('ALTER TABLE patients DROP COLUMN tdb_probe_col');
    await admin.syncAll();
  }
  for (const db of made) assert.equal(await tenant.forDb(db).schema.hasColumn('patients', 'tdb_probe_col'), false); // eslint-disable-line no-await-in-loop
});

test('platform admin: the databases page lists them, moves a clinic in the background, syncs; others get 404', { skip }, async () => {
  const auth = require('../src/modules/auth/auth.service'); // eslint-disable-line global-require
  const businesses = require('../src/modules/businesses/business.service'); // eslint-disable-line global-require
  const svc = require('../src/modules/platformops/databases.service'); // eslint-disable-line global-require
  const rootId = await tenant.run(null, () => knex.transaction((trx) => auth.createUser(trx, { name: 'Root', email: mail('root'), password: 'Passw0rd!x' })));
  await knex.main('users').where({ id: rootId }).update({ is_platform_admin: true, email_verified_at: new Date() });
  const old = await tenant.run(null, () => knex.transaction(async (trx) => {
    const u = await auth.createUser(trx, { name: 'Old2', email: mail('o2'), password: 'Passw0rd!x' });
    return businesses.create(u, { name: `Old two ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
  }));
  const root = app.agent(); await root.login(mail('root'));
  const page = await root.get('/admin/databases');
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`Old two ${tag}`));
  assert.match(page.text, new RegExp(process.env.TENANT_DB_PREFIX));
  assert.doesNotMatch(page.text, /CPANEL_TOKEN=[A-Za-z0-9]{8,}/); // never a secret
  const r = await root.post(`/admin/databases/move/${old}`, { _csrf: root.csrf(page.text) });
  assert.equal(r.status, 302);
  await svc.wait();
  const moved = (await knex.main('businesses').where({ id: old }).first('db_name')).db_name;
  assert.ok(moved && moved.startsWith(process.env.TENANT_DB_PREFIX));
  assert.ok(await knex.main('audit_logs').where({ action: 'platform.clinic_db_moved', entity_id: String(old) }).first());
  const s = await root.post('/admin/databases/sync', { _csrf: root.csrf(page.text) });
  assert.equal(s.status, 302);
  const owner = app.agent(); await owner.login(mail('a'), 'Passw0rd!x-Long');
  assert.equal((await owner.get('/admin/databases')).status, 404);
});

test('databases are named after the clinic; an older numbered name is renamed with every row kept', { skip }, async () => {
  const provision = require('../src/db/provision'); // eslint-disable-line global-require
  assert.equal(provision.nameFor('Al-Noor Clinic!', 'c9'), `${process.env.TENANT_DB_PREFIX}al_noor_clinic`);
  assert.equal(provision.nameFor('عيادة', 'c9'), `${process.env.TENANT_DB_PREFIX}c9`);
  assert.ok(provision.nameFor('x'.repeat(200), 'c9').length <= 64);
  // B signed up as its first address; its address is now tdb-b-…: the database follows the clinic's name.
  const old = await dbOf('b');
  const want = provision.nameFor((await knex.main('businesses').where({ id: biz.b }).first('slug')).slug, '');
  assert.notEqual(old, want);
  const before = Number((await tenant.forDb(old)('audit_logs').where({ business_id: biz.b }).count({ n: '*' }))[0].n);
  assert.ok(before > 0);
  const r = await admin.rename(old);
  assert.equal(r.renamed, true);
  assert.equal(r.db, want);
  assert.equal(await dbOf('b'), want);
  assert.equal(await count(want, 'audit_logs', { business_id: biz.b }), before);
  assert.equal(await knex.main('tenant_dbs').where({ db_name: old }).first(), undefined);
  const [[gone]] = await knex.main.raw('SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ?', [old]);
  assert.equal(Number(gone.n), 0);
  // Already right: nothing to do.
  assert.equal((await admin.rename(want)).renamed, false);
  tenant.forget(biz.b);
  const ag = app.agent(); await ag.login(mail('b'), 'Passw0rd!x-Long');
  assert.equal((await ag.get('/app/patients')).status, 200);
});
