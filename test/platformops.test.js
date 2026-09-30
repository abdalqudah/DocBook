// Platform operations against the test database: module gating (menu + pages), invoice number only upward,
// sample data add/remove touching only sample rows, and the in-app update's zip checks + stage/activate/rollback.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const nav = require('../src/routes/nav');
const { clinicNow } = require('../src/modules/clinic/scheduling');
const ops = require('../src/modules/platformops/ops.service');
const demo = require('../src/modules/platformops/demo.service');
const gate = require('../src/modules/platformops/gate');
const updater = require('../src/modules/platformops/updater');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let ctx;

async function makeClinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date() });
  businesses.forget(businessId);
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, locale: 'ar', today: clinicNow('Asia/Amman').date };
}
const biz = async () => { businesses.forget(ctx.businessId); return businesses.get(ctx.businessId); };

// Runs the gate middleware on a fake request → { status, view, locals, passed }.
async function runGate(pathname, business) {
  const req = { business, ctx: { ...ctx }, path: pathname, originalUrl: `/app${pathname}`, method: 'GET', xhr: false, get: () => '', t: (k) => k };
  const out = { locals: {}, passed: false };
  const res = { locals: out.locals, status(c) { out.status = c; return this; }, page(v) { out.view = v; }, json() { out.json = true; } };
  await new Promise((resolve, reject) => { gate(req, res, (err) => { if (err) reject(err); else { out.passed = true; resolve(); } }); if (out.view || out.json) resolve(); setTimeout(resolve, 500); });
  return out;
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ctx = await makeClinic(`pops${tag}@t.test`, 'عيادة المنصة');
});
test.after(async () => { await knex.destroy(); });

test('module gating: menu items disappear and pages are blocked; core pages stay', async () => {
  const all = ops.KEYS.filter((k) => k !== 'finance' && k !== 'supplies');
  await ops.saveModules(ctx, await biz(), Object.fromEntries(all.map((k) => [k, '1'])));
  const b = await biz();
  const st = await ops.state(b);
  assert.ok(st.off.has('finance') && st.off.has('supplies') && !st.off.has('billing'));

  const hidden = ops.hiddenNav(st.off);
  const keys = nav.forUser(ctx.permissions, { ...ctx, modulesOff: hidden }).flatMap((g) => g.items.map((i) => i.key));
  assert.ok(!keys.includes('expenses') && !keys.includes('budgets') && !keys.includes('supplies'));
  assert.ok(keys.includes('appointments') && keys.includes('patients') && keys.includes('cashier'));
  assert.ok(!nav.actionsFor(ctx.permissions, { modulesOff: hidden }).some((a) => a.key === 'new_expense'));

  let r = await runGate('/expenses', b);
  assert.equal(r.status, 404); assert.equal(r.view, 'pages/platformops/off');
  r = await runGate('/supplies/orders/3', b); assert.equal(r.status, 404);
  r = await runGate('/finance/assistant', b); assert.equal(r.passed, true, 'the AI finance assistant belongs to the AI module (on)');
  r = await runGate('/appointments', b); assert.equal(r.passed, true);
  r = await runGate('/expenses-report-not-a-module', b); assert.equal(r.passed, true, 'prefix matches whole segments only');
  r = await runGate('/cashier', b); assert.equal(r.passed, true);
  assert.equal(r.locals.moduleOn('finance'), false);

  // Turning it back on restores access; nothing was deleted; the change is audited.
  await ops.saveModules(ctx, await biz(), Object.fromEntries(ops.KEYS.map((k) => [k, '1'])));
  r = await runGate('/expenses', await biz()); assert.equal(r.passed, true);
  const logs = await knex('audit_logs').where({ business_id: ctx.businessId, action: 'clinic.modules_updated' }).count({ n: '*' });
  assert.equal(Number(logs[0].n), 2);

  // Online booking follows the clinic's booking switch.
  await ops.saveModules(ctx, await biz(), Object.fromEntries(ops.KEYS.filter((k) => k !== 'online_booking').map((k) => [k, '1'])));
  assert.equal(Boolean((await biz()).booking_enabled), false);
  r = await runGate('/settings/booking-links', await biz()); assert.equal(r.status, 404);
  await ops.saveModules(ctx, await biz(), Object.fromEntries(ops.KEYS.map((k) => [k, '1'])));
  assert.equal(Boolean((await biz()).booking_enabled), true);
});

test('module paths: the most specific prefix wins', () => {
  assert.equal(ops.moduleForPath('/reports/bookings'), 'online_booking');
  assert.equal(ops.moduleForPath('/reports'), 'reports');
  assert.equal(ops.moduleForPath('/visits/12/ai/summary'), 'ai_assistant');
  assert.equal(ops.moduleForPath('/visits/12'), null);
  assert.equal(ops.moduleForPath('/patients/5/dental'), 'specialty_records');
  assert.equal(ops.moduleForPath('/patients/5'), null);
});

test('invoice number: can only go up, audited; template fields saved', async () => {
  await ops.raiseInvoiceNumber(ctx, 10);
  const cur = 10;
  await assert.rejects(ops.raiseInvoiceNumber(ctx, 9), (e) => e.code === 'INVOICE_NUMBER_DOWN');
  await assert.rejects(ops.saveInvoiceTemplate(ctx, { paper: 'a5', prefix: 'X-', next_number: '5' }), (e) => e.code === 'INVOICE_NUMBER_DOWN');
  assert.equal((await ops.invoiceTemplate(ctx.businessId)).paper, 'a4', 'a refused number saves nothing');
  await ops.saveInvoiceTemplate(ctx, { paper: 'receipt80', prefix: 'INV-', footer: 'شكرًا', show_logo: '1', next_number: String(cur + 50) });
  const tpl = await ops.invoiceTemplate(ctx.businessId);
  assert.equal(tpl.paper, 'receipt80'); assert.equal(tpl.prefix, 'INV-'); assert.equal(tpl.show_logo, true); assert.equal(tpl.show_discount, false);
  assert.equal(Number((await knex('businesses').where({ id: ctx.businessId }).first('invoice_next_number')).invoice_next_number), cur + 50);
  assert.ok(await knex('audit_logs').where({ business_id: ctx.businessId, action: 'clinic.invoice_number_raised' }).first());
  await assert.rejects(ops.saveInvoiceTemplate(ctx, { paper: 'letter' }), (e) => e.code === 'VALIDATION_FAILED');
  await assert.rejects(ops.saveInvoiceTemplate(ctx, { paper: 'a4', prefix: '<b>' }), (e) => e.code === 'VALIDATION_FAILED');
});

test('sample data: add then remove touches only sample rows', async () => {
  const b = ctx.businessId;
  // Real data first.
  const realDoc = await doctors.saveDoctor(ctx, null, { full_name: 'د. حقيقي', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
  const [realPatient] = await knex('patients').insert({ business_id: b, full_name: 'مريض حقيقي', phone: '0790000001' });
  const [realAppt] = await knex('appointments').insert({ business_id: b, doctor_id: realDoc, patient_id: realPatient, patient_name: 'مريض حقيقي', appointment_date: ctx.today, appointment_time: '08:00', status: 'confirmed' });
  const before = {};
  for (const t of ['doctors', 'patients', 'appointments', 'services', 'invoices']) before[t] = Number((await knex(t).where({ business_id: b }).count({ n: '*' }))[0].n);

  const added = await demo.add(ctx, { locale: 'ar' });
  assert.equal(added.doctors, 2); assert.equal(added.patients, 3); assert.equal(added.invoices, 1); assert.ok(added.appointments >= 3);
  await assert.rejects(demo.add(ctx), (e) => e.code === 'DEMO_EXISTS');
  const demoPatients = await knex('patients').where({ business_id: b }).where('full_name', 'like', '%(تجريبي)%').select('phone');
  assert.equal(demoPatients.length, 3);
  assert.ok(!demoPatients.some((p) => p.phone === '0790000001'), 'a phone a real patient uses is skipped');

  // Something added to a sample visit (a consultation) and a real appointment booked with a sample doctor.
  const demoAppt = await knex('demo_records').where({ business_id: b, table_name: 'appointments' }).first('record_id');
  await knex('consultations').insert({ business_id: b, appointment_id: demoAppt.record_id, patient_name: 'x', diagnosis: 'test' });
  const demoDoc = await knex('demo_records').where({ business_id: b, table_name: 'doctors' }).first('record_id');
  const [mixed] = await knex('appointments').insert({ business_id: b, doctor_id: demoDoc.record_id, patient_id: realPatient, patient_name: 'مريض حقيقي', appointment_date: ctx.today, appointment_time: '08:30', status: 'pending' });

  const r = await demo.remove(ctx);
  assert.equal(r.kept, 1, 'the sample doctor used by a real appointment is kept');
  assert.equal(Number((await knex('consultations').where({ appointment_id: demoAppt.record_id }).count({ n: '*' }))[0].n), 0);
  // Real rows intact.
  assert.ok(await knex('doctors').where({ id: realDoc }).first());
  assert.ok(await knex('patients').where({ id: realPatient }).first());
  assert.ok(await knex('appointments').where({ id: realAppt }).first());
  const m = await knex('appointments').where({ id: mixed }).first('doctor_id');
  assert.equal(m.doctor_id, demoDoc.record_id, 'the real appointment was not changed');
  for (const t of ['patients', 'appointments', 'services', 'invoices']) {
    const n = Number((await knex(t).where({ business_id: b }).count({ n: '*' }))[0].n);
    assert.equal(n, before[t] + (t === 'appointments' ? 1 : 0), `${t} back to the real rows`);
  }
  assert.equal(Number((await knex('doctors').where({ business_id: b }).count({ n: '*' }))[0].n), before.doctors + 1);
  assert.equal((await demo.status(b)).total, 1);
  assert.ok(await knex('audit_logs').where({ business_id: b, action: 'clinic.demo_removed' }).first());

  // Once the real appointment no longer uses it, the kept sample doctor can go too.
  await knex('appointments').where({ id: mixed }).del();
  await demo.remove(ctx);
  assert.equal((await demo.status(b)).total, 0);
  assert.ok(!(await knex('doctors').where({ id: demoDoc.record_id }).first()));
  assert.ok(await knex('doctors').where({ id: realDoc }).first());
});

// ---------------------------------------------------------------- in-app update
const BANNER = '#!/usr/bin/env node\nconst __DOCBOOK_ROOT = __dirname;\nconsole.log("x");\n';
function distZip({ version = '9.9.9', name = 'docbook', extra = {}, skip = [] } = {}) {
  const z = new AdmZip();
  const files = { 'app.js': BANNER, 'package.json': JSON.stringify({ name, version }), 'src/views/a.ejs': `v${version}`, 'public/css/x.css': 'a{}', ...extra };
  for (const [k, v] of Object.entries(files)) if (!skip.includes(k)) z.addFile(k, Buffer.from(v));
  return z.toBuffer();
}
const code = (fn) => { try { fn(); return 'OK'; } catch (e) { return e.code; } };

test('update zip validation', () => {
  assert.equal(code(() => updater.inspectZip(distZip())), 'OK');
  assert.equal(code(() => updater.inspectZip(distZip({ skip: ['app.js'] }))), 'UPDATE_MISSING_APP');
  assert.equal(code(() => updater.inspectZip(distZip({ extra: { 'app.js': 'console.log(1)' } }))), 'UPDATE_NOT_DIST');
  assert.equal(code(() => updater.inspectZip(distZip({ skip: ['package.json'] }))), 'UPDATE_MISSING_PACKAGE');
  assert.equal(code(() => updater.inspectZip(distZip({ name: 'other-app' }))), 'UPDATE_WRONG_NAME');
  assert.equal(code(() => updater.inspectZip(distZip({ extra: { 'vendor/node_modules/x/index.js': '1' } }))), 'UPDATE_NODE_MODULES');
  assert.equal(code(() => updater.inspectZip(distZip({ extra: { '.env': 'DB_PASSWORD=x' } }))), 'UPDATE_ENV_FILE');
  assert.equal(code(() => updater.inspectZip(distZip({ extra: { 'server.sh': 'rm -rf /' } }))), 'UPDATE_UNEXPECTED_FILE');
  assert.equal(code(() => updater.inspectZip(Buffer.from('not a zip at all'))), 'UPDATE_NOT_ZIP');
  assert.equal(code(() => updater.inspectZip(Buffer.alloc(0))), 'UPDATE_EMPTY');
  // Zip-slip: adm-zip may normalise names on add, so check the name guard directly and on a hand-edited entry.
  for (const bad of ['../evil.js', 'src/../../evil.js', '/etc/passwd', 'C:/x.js', 'src\\..\\x.js', './../x']) assert.equal(code(() => updater.safeName(bad)), 'UPDATE_UNSAFE_PATH', bad);
  const z = new AdmZip(distZip());
  z.getEntries().find((e) => e.entryName === 'public/css/x.css').entryName = '../../outside.css';
  assert.equal(code(() => updater.inspectZip(z.toBuffer())), 'UPDATE_UNSAFE_PATH');
  assert.ok(updater.hasDistBanner(BANNER));
  assert.ok(!updater.isDistBuild(path.join(__dirname, '..')), 'the source tree is not a dist build');
  assert.ok(updater.compareVersions('2.10.0', '2.9.1') > 0 && updater.compareVersions('2.0.0', '2.0.0') === 0);
});

test('update: stage, activate (backup, keep .env), rollback, keep 3 backups', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docbook-upd-'));
  try {
    fs.writeFileSync(path.join(root, 'app.js'), BANNER);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'docbook', version: '1.0.0' }));
    fs.mkdirSync(path.join(root, 'src/views'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/views/a.ejs'), 'v1.0.0');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=keep');
    assert.ok(updater.isDistBuild(root));

    const s = updater.stage(distZip({ version: '1.1.0' }), { root });
    assert.equal(s.version, '1.1.0'); assert.equal(s.from, '1.0.0');
    assert.equal(updater.status(root).staged.version, '1.1.0');
    const a = updater.activate({ root });
    assert.deepEqual([a.from, a.to], ['1.0.0', '1.1.0']);
    assert.equal(fs.readFileSync(path.join(root, 'src/views/a.ejs'), 'utf8'), 'v1.1.0');
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'SECRET=keep');
    assert.ok(fs.existsSync(path.join(root, 'tmp/restart.txt')));
    assert.equal(updater.status(root).staged, null);
    assert.equal(updater.status(root).backups[0].version, '1.0.0');

    const rb = updater.rollback({ root });
    assert.equal(rb.to, '1.0.0');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '1.0.0');
    assert.equal(fs.readFileSync(path.join(root, 'src/views/a.ejs'), 'utf8'), 'v1.0.0');
    assert.equal(updater.status(root).backups.length, 0);
    assert.equal(code(() => updater.rollback({ root })), 'UPDATE_NO_BACKUP');

    for (const v of ['1.2.0', '1.3.0', '1.4.0', '1.5.0']) { updater.stage(distZip({ version: v }), { root }); updater.activate({ root }); }
    assert.equal(updater.status(root).backups.length, updater.KEEP_BACKUPS);
    assert.equal(code(() => updater.activate({ root })), 'UPDATE_NOTHING_STAGED');
    // A bad zip writes nothing.
    assert.equal(code(() => updater.stage(distZip({ extra: { '.env': 'x' } }), { root })), 'UPDATE_ENV_FILE');
    assert.equal(updater.status(root).staged, null);
    // Running from source: activation refused.
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'docbook-src-'));
    fs.writeFileSync(path.join(src, 'app.js'), "require('./src/server').run();\n");
    assert.equal(code(() => updater.activate({ root: src })), 'UPDATE_SOURCE_BUILD');
    fs.rmSync(src, { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('update (RemoteWay flow): lenient package check, one-step install, restore a chosen backup, history', () => {
  // Wrapper folder + __MACOSX + .DS_Store + stray files are accepted/ignored; .env and node_modules are skipped.
  const z = new AdmZip();
  z.addFile('docbook/app.js', Buffer.from(BANNER));
  z.addFile('docbook/package.json', Buffer.from(JSON.stringify({ name: 'docbook', version: '2.0.1' })));
  z.addFile('docbook/src/views/a.ejs', Buffer.from('v2.0.1'));
  z.addFile('docbook/.DS_Store', Buffer.from('x'));
  z.addFile('docbook/notes.txt', Buffer.from('x'));
  z.addFile('docbook/.env', Buffer.from('DB_PASSWORD=evil'));
  z.addFile('docbook/node_modules/x/index.js', Buffer.from('x'));
  z.addFile('__MACOSX/docbook/._app.js', Buffer.from('x'));
  const pkg = updater.inspectPackage(z.toBuffer());
  assert.equal(pkg.version, '2.0.1');
  assert.deepEqual([...pkg.files.keys()].sort(), ['app.js', 'package.json', 'src/views/a.ejs']);
  assert.equal(code(() => updater.inspectPackage(distZip({ name: 'other' }))), 'UPDATE_WRONG_NAME');
  assert.equal(code(() => updater.inspectPackage(distZip({ skip: ['app.js'] }))), 'UPDATE_MISSING_APP');
  assert.equal(code(() => updater.inspectPackage(Buffer.from('nope'))), 'UPDATE_NOT_ZIP');
  const slip = new AdmZip(); slip.addFile('app.js', Buffer.from(BANNER)); slip.addFile('package.json', Buffer.from('{"name":"docbook"}'));
  slip.getEntries()[0].entryName = '../evil.js';
  assert.equal(code(() => updater.inspectPackage(slip.toBuffer())), 'UPDATE_UNSAFE_PATH');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docbook-upd2-'));
  try {
    fs.writeFileSync(path.join(root, 'app.js'), BANNER);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'docbook', version: '2.0.0' }));
    fs.mkdirSync(path.join(root, 'src/views'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/views/a.ejs'), 'v2.0.0');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=keep');
    // A dist unpacked over an older source upload keeps leftover src/*.js files: still the installed build.
    fs.writeFileSync(path.join(root, 'src/server.js'), 'module.exports = {};');
    assert.ok(updater.isDistBuild(root), 'app.js decides, not leftover source files');
    const r = updater.install(z.toBuffer(), { root, by: 'admin@x', fileName: 'u.zip' });
    assert.deepEqual([r.from, r.to, r.ok], ['2.0.0', '2.0.1', true]);
    assert.equal(fs.readFileSync(path.join(root, 'src/views/a.ejs'), 'utf8'), 'v2.0.1');
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'SECRET=keep');
    assert.ok(!fs.existsSync(path.join(root, 'notes.txt')) && !fs.existsSync(path.join(root, 'node_modules')));
    assert.ok(fs.existsSync(path.join(root, 'tmp/restart.txt')));
    const backups = updater.listBackups(root);
    assert.equal(backups.length, 1); assert.equal(backups[0].version, '2.0.0');
    // A failing package changes nothing.
    assert.equal(code(() => updater.install(distZip({ name: 'other' }), { root })), 'UPDATE_WRONG_NAME');
    assert.equal(fs.readFileSync(path.join(root, 'src/views/a.ejs'), 'utf8'), 'v2.0.1');
    const back = updater.restore(backups[0].id, { root, by: 'admin@x' });
    assert.deepEqual([back.from, back.to], ['2.0.1', '2.0.0']);
    assert.equal(fs.readFileSync(path.join(root, 'src/views/a.ejs'), 'utf8'), 'v2.0.0');
    assert.equal(updater.listBackups(root).length, 2, 'the version before the restore is kept as a backup');
    assert.equal(code(() => updater.restore('backup-nope', { root })), 'UPDATE_NO_BACKUP');
    assert.deepEqual(updater.readLog(root).map((l) => l.action), ['restore', 'update']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
