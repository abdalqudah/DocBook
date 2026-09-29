// Settings → Your database: a one-way copy of a clinic's data into its own MySQL/PostgreSQL database.
// The end-to-end part uses a second local MariaDB database and user (docbook_sync_target / docbook_sync) standing in
// for the clinic's server, with DATASYNC_ALLOW_PRIVATE=true; it is skipped when that database is not reachable.
// PostgreSQL is covered by checking the generated SQL and connection settings (no server needed).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knexFactory = require('knex');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const sync = require('../src/modules/datasync/datasync.service');

const TARGET = {
  host: process.env.DATASYNC_TEST_HOST || '127.0.0.1', port: Number(process.env.DATASYNC_TEST_PORT || 3306),
  database_name: process.env.DATASYNC_TEST_DB || 'docbook_sync_target', username: process.env.DATASYNC_TEST_USER || 'docbook_sync', password: process.env.DATASYNC_TEST_PASSWORD || 'syncpass',
};
let target; let reachable = false;
let server; let base;
let A; let B; let staffEmail;

async function clinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date() });
  businesses.forget(businessId);
  return { businessId, userId, email, permissions: await rbac.getUserPermissions(businessId, userId), ip: '127.0.0.1' };
}

async function seed(c, tag) {
  const [doctorId] = await knex('doctors').insert({ business_id: c.businessId, full_name: `Dr ${tag}`, slot_duration_minutes: 30, consultation_fee: 20, base_salary: 900, is_active: true, working_hours: '{}' });
  const [serviceId] = await knex('services').insert({ business_id: c.businessId, doctor_id: doctorId, name: `Check-up ${tag}`, price: 25, duration_minutes: 30, is_active: true });
  const patients = [];
  for (const n of ['Sara', 'Omar', 'Lina']) {
    // eslint-disable-next-line no-await-in-loop
    const [id] = await knex('patients').insert({ business_id: c.businessId, full_name: `${n} ${tag}`, phone: `079${Math.floor(Math.random() * 1e7)}`, date_of_birth: '1990-05-17', gender: 'female', allergies: 'Penicillin', chronic_conditions: 'Asthma' });
    patients.push(id);
  }
  const [apptId] = await knex('appointments').insert({ business_id: c.businessId, doctor_id: doctorId, service_id: serviceId, patient_id: patients[0], patient_name: `Sara ${tag}`, appointment_date: '2026-09-20', appointment_time: '09:30', duration_minutes: 30, status: 'completed', appointment_type: 'in_person', source: 'staff', amount_due: 25, payment_status: 'paid', notes: 'Chest pain since Monday' });
  await knex('invoices').insert([
    { business_id: c.businessId, invoice_number: 1, appointment_id: apptId, doctor_id: doctorId, patient_id: patients[0], doctor_name: `Dr ${tag}`, service_name: 'Check-up', patient_name: `Sara ${tag}`, amount: 32, subtotal: 32, payment_method: 'cash', items: JSON.stringify([{ name: 'Consult', qty: 1, unitPrice: 25, total: 25, serviceId }, { name: 'Dressing', qty: 2, unitPrice: 3.5, total: 7 }]) },
    { business_id: c.businessId, invoice_number: 2, doctor_id: doctorId, patient_id: patients[1], doctor_name: `Dr ${tag}`, service_name: 'Old visit', patient_name: `Omar ${tag}`, amount: 18.5, payment_method: 'card' },
  ]);
  await knex('consultations').insert({ business_id: c.businessId, appointment_id: apptId, doctor_id: doctorId, patient_id: patients[0], patient_name: `Sara ${tag}`, vital_signs: JSON.stringify({ weightKg: 70, temperatureC: 37.2, pulseBpm: 78, bloodPressure: '120/80' }), diagnosis: 'Viral infection' });
  await knex('expenses').insert({ business_id: c.businessId, date: '2026-09-10', category: 'rent', title: 'Rent', amount: 300.125, payment_method: 'bank' });
  await knex('payroll_payments').insert({ business_id: c.businessId, doctor_id: doctorId, period: '2026-08', base_salary: 900, commission: 0, bonuses: 0, deductions: 0, advances: 0, net_pay: 900, payment_method: 'bank', paid_at: new Date() });
  return { doctorId, serviceId, patients };
}

/** Cookie + CSRF aware client. */
function client() {
  const jar = {};
  let csrf = '';
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => { for (const h of res.headers.getSetCookie()) { const [kv] = h.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } };
  const read = async (res) => { store(res); const text = await res.text(); const m = text.match(/name="csrf-token" content="([^"]+)"/); if (m) csrf = m[1]; return { status: res.status, location: res.headers.get('location'), text }; };
  return {
    get: async (path) => read(await fetch(base + path, { headers: { cookie: cookie() }, redirect: 'manual' })),
    post: async (path, data = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: csrf, ...data })) [].concat(v).forEach((x) => body.append(k, x));
      return read(await fetch(base + path, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' }));
    },
  };
}
async function login(email, lang = 'en') {
  const c = client();
  await c.get(`/login?lang=${lang}`);
  const r = await c.post('/login', { email, password: 'Passw0rd!x' });
  assert.equal(r.status, 302, 'signed in');
  await c.get(`/app/settings/database?lang=${lang}`);
  return c;
}

const body = (extra = {}) => ({ driver: 'mysql', host: TARGET.host, port: String(TARGET.port), database_name: TARGET.database_name, username: TARGET.username, password: TARGET.password, table_prefix: 'db_', frequency: 'hourly', enabled: '1', ssl: '', datasets: ['clinic', 'patients', 'appointments', 'billing', 'expenses'], ...extra });

test.before(async () => {
  delete process.env.DATASYNC_ALLOW_PRIVATE;
  await knex.migrate.rollback(undefined, true);
  await knex.migrate.latest();
  cache.forgetPrefix('');
  A = await clinic('owner@sync-a.test', 'Sync Clinic A');
  B = await clinic('owner@sync-b.test', 'Sync Clinic B');
  await seed(A, 'A');
  await seed(B, 'B');
  const staffId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Desk', email: 'desk@sync-a.test', password: 'Passw0rd!x' }));
  const role = await knex('roles').where({ business_id: A.businessId, key: 'clinic_manager' }).first('id');
  await knex('memberships').insert({ business_id: A.businessId, user_id: staffId, role_id: role.id, status: 'active' });
  staffEmail = 'desk@sync-a.test';

  target = knexFactory({ client: 'mysql2', connection: { host: TARGET.host, port: TARGET.port, user: TARGET.username, password: TARGET.password, database: TARGET.database_name, dateStrings: true }, pool: { min: 0, max: 1 } });
  try {
    await target.raw('select 1');
    reachable = true;
    const [tables] = await target.raw('SELECT table_name AS n FROM information_schema.tables WHERE table_schema = ?', [TARGET.database_name]);
    for (const t of tables) await target.schema.dropTableIfExists(t.n || t.TABLE_NAME); // eslint-disable-line no-await-in-loop
  } catch { reachable = false; }

  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { delete process.env.DATASYNC_ALLOW_PRIVATE; server.close(); if (target) await target.destroy(); await knex.destroy(); });

// ---------------------------------------------------------------- units
test('internal addresses are refused unless the explicit test flag is set (never in production)', async () => {
  for (const h of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', '::ffff:127.0.0.1', 'localhost', 'db.localhost', 'metadata.google.internal', 'printer.local']) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(sync.resolveHost(h), (e) => e.code === 'DATASYNC_PRIVATE', h);
  }
  assert.equal(await sync.resolveHost('8.8.8.8'), '8.8.8.8');
  process.env.DATASYNC_ALLOW_PRIVATE = 'true';
  assert.equal(await sync.resolveHost('127.0.0.1'), '127.0.0.1');
  process.env.NODE_ENV = 'production';
  await assert.rejects(sync.resolveHost('127.0.0.1'), { code: 'DATASYNC_PRIVATE' });
  process.env.NODE_ENV = 'test';
  delete process.env.DATASYNC_ALLOW_PRIVATE;
});

test('values are converted for the target columns; failure reasons never carry the password', () => {
  assert.equal(sync.convert('2026-01-15', 'd'), '2026-01-15');
  assert.equal(sync.convert(new Date(Date.UTC(2026, 0, 15, 8, 5, 9)), 'dt'), '2026-01-15 08:05:09');
  assert.equal(sync.convert('12.500', 'n'), 12.5);
  assert.equal(sync.convert(1, 'b'), true);
  assert.equal(sync.convert(0, 'b'), false);
  assert.equal(sync.convert('x'.repeat(300), 's').length, 255);
  assert.equal(sync.convert({ a: 1 }, 't'), '{"a":1}');
  assert.equal(sync.convert(null, 'i'), null);
  assert.equal(sync.reason(Object.assign(new Error('x'), { code: 'ER_ACCESS_DENIED_ERROR' })), 'AUTH');
  assert.equal(sync.reason(Object.assign(new Error('x'), { code: '28P01' })), 'AUTH');
  assert.equal(sync.reason(Object.assign(new Error('x'), { code: '3D000' })), 'NO_DB');
  assert.equal(sync.reason(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), 'REFUSED');
  assert.equal(sync.reason(new Error('self-signed certificate in certificate chain')), 'SSL');
  const other = sync.reason(new Error('weird failure for S3cr3t-Pass!'), 'S3cr3t-Pass!');
  assert.match(other, /^OTHER:/);
  assert.ok(!other.includes('S3cr3t-Pass!'));
});

test('PostgreSQL: generated SQL and connection settings (no server needed)', () => {
  const pg = knexFactory({ client: 'pg' });
  const spec = sync.DATASETS.billing.tables.invoices;
  const create = sync.createBuilder(pg, 'db_invoices', spec.cols).toString();
  assert.match(create, /^create table "db_invoices" \("id" integer, /);
  assert.match(create, /"amount" decimal\(15, 3\)/);
  assert.match(create, /"created_at" timestamp null/);
  assert.ok(!/timestamptz/.test(create), 'times are plain UTC timestamps');
  assert.match(create, /constraint "db_invoices_pkey" primary key \("id"\)/);
  const alter = sync.alterBuilder(pg, 'db_patients', sync.DATASETS.patients.tables.patients.cols, ['insurance_number', 'date_of_birth']).toString();
  assert.match(alter, /alter table "db_patients" add column "insurance_number" varchar\(255\) null/);
  assert.match(alter, /add column "date_of_birth" date null/);
  const vit = sync.createBuilder(pg, 'db_vital_signs', sync.DATASETS.clinical.tables.vital_signs.cols).toString();
  assert.match(vit, /"blood_pressure" varchar\(255\)/);
  const ins = pg('db_services').insert([{ id: 1, is_active: sync.convert(1, 'b'), price: sync.convert('25.000', 'n') }]).toString();
  assert.equal(ins, 'insert into "db_services" ("id", "is_active", "price") values (1, true, 25)');

  const cfg = { driver: 'postgres', host: 'db.example.com', port: 5432, username: 'u', database_name: 'd', ssl: true };
  const pgConn = sync.connectionFor(cfg, '203.0.113.7', 'pw');
  assert.equal(pgConn.host, '203.0.113.7', 'connects to the checked address');
  assert.deepEqual(pgConn.ssl, { rejectUnauthorized: true, servername: 'db.example.com' });
  assert.ok(pgConn.connectionTimeoutMillis && pgConn.statement_timeout);
  assert.equal(sync.connectionFor({ ...cfg, ssl: false }, '203.0.113.7', 'pw').ssl, false);
  const my = sync.connectionFor({ ...cfg, driver: 'mysql', port: 3306 }, '203.0.113.7', 'pw');
  assert.equal(my.host, 'db.example.com', 'name kept for the certificate check');
  assert.equal(typeof my.stream, 'function', 'socket goes to the checked address');
  assert.deepEqual(my.ssl, { rejectUnauthorized: true, verifyIdentity: true });
});

test('permissions decide the medical and payroll choices; sensitive data needs an acknowledgement', async () => {
  const all = sync.available(A);
  assert.ok(all.includes('clinical') && all.includes('payroll'));
  const limited = { ...A, permissions: new Set(['data.manage']) };
  assert.deepEqual(sync.available(limited).sort(), ['appointments', 'billing', 'clinic', 'expenses', 'patients', 'supplies']);

  await assert.rejects(sync.save(A, body({ host: 'bad host!', table_prefix: 'Bad-', datasets: [], password: '' })), (e) => {
    assert.equal(e.code, 'VALIDATION_FAILED');
    for (const k of ['host', 'table_prefix', 'datasets', 'password']) assert.ok(e.details[k], k);
    return true;
  });
  await assert.rejects(sync.save(A, body({ datasets: ['clinical'] })), (e) => Boolean(e.details.accept_responsibility));
  await sync.save(A, body({ datasets: ['clinic', 'clinical', 'payroll'], accept_responsibility: '1' }));
  let cfg = await sync.get(A.businessId);
  assert.deepEqual(cfg.datasets.sort(), ['clinic', 'clinical', 'payroll']);
  const row = await knex('clinic_data_sync').where({ business_id: A.businessId }).first();
  assert.ok(row.password_enc && !row.password_enc.includes(TARGET.password), 'password stored encrypted');
  assert.ok(!('password_enc' in cfg), 'the encrypted password never leaves the service');
  // Someone without clinical/payroll access keeps those choices (and needs no acknowledgement for them).
  await sync.save(limited, body({ password: '', datasets: ['clinic', 'expenses'] }));
  cfg = await sync.get(A.businessId);
  assert.deepEqual(cfg.datasets.sort(), ['clinic', 'clinical', 'expenses', 'payroll']);
  // Owner turns them off; nothing asked.
  await sync.save(A, body({ password: '' }));
  assert.deepEqual((await sync.get(A.businessId)).datasets.sort(), ['appointments', 'billing', 'clinic', 'expenses', 'patients']);
  const logs = await knex('audit_logs').where({ business_id: A.businessId }).where('action', 'like', 'datasync.%').orderBy('id');
  assert.deepEqual(logs.map((l) => l.action), ['datasync.created', 'datasync.updated', 'datasync.updated']);
  assert.ok(logs.every((l) => !JSON.stringify(l.new_values).includes(TARGET.password)), 'the audit trail never holds the password');
  assert.match(JSON.stringify(logs[0].new_values), /sensitive_accepted/);
});

// ---------------------------------------------------------------- HTTP
test('HTTP: settings page for data.manage only; errors shown in the person’s language; private hosts refused', async () => {
  const staff = await login(staffEmail);
  assert.equal((await staff.get('/app/settings/database')).status, 403, 'clinic manager has no data.manage');
  assert.equal((await staff.post('/app/settings/database/run')).status, 403);

  const owner = await login(A.email, 'ar');
  let r = await owner.get('/app/settings/database');
  assert.equal(r.status, 200);
  assert.match(r.text, /قاعدة بياناتك/);
  assert.match(r.text, /href="\/app\/settings\/database" class="active"/, 'settings nav link');
  assert.ok(!r.text.includes(TARGET.password));
  r = await owner.post('/app/settings/database', body({ host: 'bad host!', password: '' }));
  assert.equal(r.status, 422);
  assert.match(r.text, /أدخل اسم خادم قاعدة البيانات/);
  // Saved, but the test refuses an internal address (flag off).
  r = await owner.post('/app/settings/database', body());
  assert.equal(r.status, 302);
  r = await owner.get('/app/settings/database');
  assert.match(r.text, /لا يمكن الوصول إلى هذا العنوان/);
  assert.equal((await knex('clinic_data_sync').where({ business_id: A.businessId }).first()).verified_at, null);
  assert.ok(await knex('audit_logs').where({ business_id: A.businessId, action: 'datasync.tested' }).first());
});

test('end to end: prefixed tables, only this clinic, sensitive data only when chosen, keeps up with changes', async (t) => {
  if (!reachable) { t.skip('docbook_sync_target is not reachable'); return; }
  process.env.DATASYNC_ALLOW_PRIVATE = 'true';
  const owner = await login(A.email);
  // Wrong password: saved, but the page says it was refused.
  await owner.post('/app/settings/database', body({ password: 'wrong-pass' }));
  let page = await owner.get('/app/settings/database');
  assert.match(page.text, /username or password was refused/);
  await owner.post('/app/settings/database', body());
  assert.ok((await knex('clinic_data_sync').where({ business_id: A.businessId }).first()).verified_at, 'verified');

  let r = await owner.post('/app/settings/database/run');
  assert.equal(r.status, 302);
  const pts = await target('db_patients').orderBy('id');
  assert.deepEqual(pts.map((p) => p.full_name), ['Sara A', 'Omar A', 'Lina A'], 'only this clinic');
  assert.equal(String(pts[0].date_of_birth).slice(0, 10), '1990-05-17');
  assert.equal(pts[0].allergies, undefined, 'no medical details in the patients table');
  const appt = await target('db_appointments').first();
  assert.equal(appt.notes, undefined, 'booking notes are not copied');
  assert.equal(appt.appointment_time, '09:30');
  const doc = await target('db_doctors').first();
  assert.equal(doc.base_salary, undefined, 'salaries are a separate choice');
  const items = await target('db_invoice_items').orderBy('id');
  assert.deepEqual(items.map((i) => [i.invoice_number, i.line_no, i.name, Number(i.total)]), [[1, 1, 'Consult', 25], [1, 2, 'Dressing', 7], [2, 1, 'Old visit', 18.5]]);
  assert.equal(Number((await target('db_expenses').first()).amount), 300.125, 'three decimals kept');
  for (const tb of ['db_services', 'db_insurance_providers', 'db_invoices', 'db_cash_closings', 'db_expense_categories', 'db_sync_info']) assert.ok(await target.schema.hasTable(tb), tb); // eslint-disable-line no-await-in-loop
  for (const tb of ['db_consultations', 'db_vital_signs', 'db_payroll_payments', 'db_supply_items']) assert.equal(await target.schema.hasTable(tb), false, `${tb} not chosen`); // eslint-disable-line no-await-in-loop
  const info = await target('db_sync_info').first();
  assert.equal(info.clinic, 'Sync Clinic A');
  assert.equal(JSON.parse(info.tables).rows.patients, 3);

  // Medical records, once chosen with the acknowledgement.
  await owner.post('/app/settings/database', body({ password: '', datasets: ['patients', 'clinical'], accept_responsibility: '1' }));
  let res = await sync.run(A.businessId, { trigger: 'manual', userId: A.userId });
  assert.equal(res.ok, true, res.error);
  const vit = await target('db_vital_signs').first();
  assert.equal(vit.blood_pressure, '120/80');
  assert.equal(Number(vit.temperature_c), 37.2);
  assert.equal((await target('db_patient_health').first()).allergies, 'Penicillin');
  assert.equal((await target('db_consultations').first()).diagnosis, 'Viral infection');

  // Deletions and changes follow; a dropped column comes back; other tables are never touched.
  const [first] = await knex('patients').where({ business_id: A.businessId }).orderBy('id').pluck('id');
  await knex('patients').where({ business_id: A.businessId, full_name: 'Omar A' }).update({ full_name: 'Omar A.' });
  await knex('patients').where({ business_id: A.businessId, full_name: 'Lina A' }).del();
  await target.schema.alterTable('db_patients', (tb) => tb.dropColumn('insurance_number'));
  await target.schema.createTable('their_own_table', (tb) => { tb.integer('id'); });
  res = await sync.run(A.businessId);
  assert.equal(res.ok, true, res.error);
  const after2 = await target('db_patients').orderBy('id');
  assert.deepEqual(after2.map((p) => p.full_name), ['Sara A', 'Omar A.']);
  assert.equal(after2[0].id, first);
  assert.ok(await target.schema.hasColumn('db_patients', 'insurance_number'));
  assert.ok(await target.schema.hasTable('their_own_table'));
  await target.schema.dropTable('their_own_table');
  assert.ok(await target.schema.hasTable('db_appointments'), 'tables no longer chosen stay');

  // Log on the page; audit of every run.
  page = await owner.get('/app/settings/database');
  assert.match(page.text, /db_patients: 2/);
  assert.ok((await knex('data_sync_runs').where({ business_id: A.businessId, status: 'ok' })).length >= 3);
  assert.ok((await knex('audit_logs').where({ business_id: A.businessId, action: 'datasync.completed' })).length >= 3);

  // Scheduled copies: due ones run, then wait an hour.
  await knex('clinic_data_sync').where({ business_id: A.businessId }).update({ next_run_at: new Date(Date.now() - 1000) });
  assert.equal(await sync.runDue(), 1);
  const cfg = await knex('clinic_data_sync').where({ business_id: A.businessId }).first();
  assert.ok(new Date(cfg.next_run_at).getTime() > Date.now() + 50 * 60_000);
  assert.equal(await sync.runDue(), 0);
  assert.equal((await knex('data_sync_runs').where({ business_id: A.businessId }).orderBy('id', 'desc').first()).trigger, 'schedule');

  // One copy at a time.
  await knex('clinic_data_sync').where({ business_id: A.businessId }).update({ running_since: new Date() });
  await assert.rejects(sync.run(A.businessId), { code: 'DATASYNC_BUSY' });
  r = await owner.post('/app/settings/database/run');
  assert.equal(r.status, 302);
  page = await owner.get('/app/settings/database');
  assert.match(page.text, /already running/);
  await knex('clinic_data_sync').where({ business_id: A.businessId }).update({ running_since: null });

  // Disconnect keeps the clinic's tables; audited.
  r = await owner.post('/app/settings/database/remove');
  assert.equal(r.status, 302);
  assert.equal(await sync.get(A.businessId), null);
  assert.ok(await target.schema.hasTable('db_patients'));
  assert.ok(await knex('audit_logs').where({ business_id: A.businessId, action: 'datasync.removed' }).first());
  delete process.env.DATASYNC_ALLOW_PRIVATE;
});
