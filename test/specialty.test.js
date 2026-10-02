// Specialty records: pregnancy dating (Naegele / scan, GA weeks+days, schedule status), WHO LMS z-scores against published
// WHO values, dental entry validation and chart rebuild, module defaults, and access rules (tenant, a doctor's own patients,
// permissions over HTTP, audit).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const { clinicNow } = require('../src/modules/clinic/scheduling');
const preg = require('../src/modules/specialty/pregnancy');
const growth = require('../src/modules/specialty/growth');
const dental = require('../src/modules/specialty/dental');
const svc = require('../src/modules/specialty/service');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let ctx; let other; let docA; let docB; let today; let server; let base;

async function makeClinic(email, name, specialty) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman', specialty }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date() });
  businesses.forget(businessId);
  today = clinicNow('Asia/Amman').date;
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, doctorId: null, locale: 'en', today };
}

async function staff(businessId, roleKey, email, doctorId = null) {
  const userId = await knex.transaction((trx) => auth.createUser(trx, { name: roleKey, email, password: 'Passw0rd!x' }));
  const role = await rbac.getRoleByKey(businessId, roleKey);
  await knex('memberships').insert({ business_id: businessId, user_id: userId, role_id: role.id, doctor_id: doctorId });
  await knex('users').where({ id: userId }).update({ last_business_id: businessId });
  return userId;
}

function client() {
  const jar = {};
  let csrf = '';
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const read = async (res) => {
    for (const h of res.headers.getSetCookie()) { const [kv] = h.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = await res.text();
    const m = text.match(/name="csrf-token" content="([^"]+)"/); if (m) csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text };
  };
  return {
    get: async (path) => read(await fetch(base + path, { headers: { cookie: cookie(), accept: 'text/html' }, redirect: 'manual' })),
    post: async (path, data = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: csrf, ...data })) [].concat(v).forEach((x) => body.append(k, x));
      return read(await fetch(base + path, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' }));
    },
  };
}
async function signIn(email) {
  const c = client();
  await c.get('/login');
  const r = await c.post('/login', { email, password: 'Passw0rd!x' });
  assert.equal(r.status, 302);
  return c;
}

const addPatient = async (businessId, data) => (await knex('patients').insert({ business_id: businessId, phone: `079${Math.floor(Math.random() * 1e7)}`, ...data }))[0];
async function visit(businessId, doctorId, patientId) {
  const [id] = await knex('appointments').insert({
    business_id: businessId, doctor_id: doctorId, patient_id: patientId, patient_name: 'P', patient_phone: '0790000000',
    appointment_date: today, appointment_time: '09:00', duration_minutes: 30, status: 'confirmed',
  });
  return id;
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ctx = await makeClinic(`spec${tag}@t.test`, 'Specialty clinic', 'multi');
  other = await makeClinic(`spec-other${tag}@t.test`, 'Other clinic', 'dentistry');
  docA = await doctors.saveDoctor(ctx, null, { full_name: 'Dr. A', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
  docB = await doctors.saveDoctor(ctx, null, { full_name: 'Dr. B', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await knex.destroy(); });

// ---------------------------------------------------------------- pregnancy math
test('EDD by Naegele and from a dating scan; GA as weeks+days', () => {
  assert.equal(preg.eddFromLmp('2026-01-01'), '2026-10-08');
  assert.equal(preg.eddFromLmp('2024-02-20'), '2024-11-26'); // across a leap day
  assert.equal(preg.eddFromScan('2026-03-01', 12 * 7 + 3), '2026-09-10'); // scan at 12+3 → day 0 = 2025-12-04
  assert.equal(preg.gaDaysOn('2026-10-08', '2026-01-01'), 0);
  assert.equal(preg.gaDaysOn('2026-10-08', '2026-06-25'), 175);
  assert.equal(preg.gaLabel(175), '25+0');
  assert.equal(preg.gaLabel(171), '24+3');
  assert.equal(preg.gaLabel(null), '—');
  assert.equal(preg.parseGa('12+3'), 87);
  assert.equal(preg.parseGa('12', '6'), 90);
  assert.equal(preg.parseGa('12w3d'), 87);
  assert.equal(preg.parseGa('12', '7'), null);
  assert.equal(preg.parseGa('abc'), null);
});

test('schedule status: done / overdue / due / upcoming / Rh-only item', () => {
  const edd = preg.eddFromLmp('2026-01-01'); // GA on 2026-06-25 = 25+0
  const s = preg.scheduleStatus(preg.normaliseSchedule(null), { edd, rh: 'pos', today: '2026-06-25', done: { booking_bloods: '2026-02-10' } });
  const by = Object.fromEntries(s.map((i) => [i.key, i.status]));
  assert.equal(by.booking_bloods, 'done');
  assert.equal(by.dating_scan, 'overdue');
  assert.equal(by.anomaly_scan, 'overdue');
  assert.equal(by.gtt, 'due');
  assert.equal(by.anti_d, 'na');
  assert.equal(by.gbs_swab, 'upcoming');
  const neg = preg.scheduleStatus(preg.normaliseSchedule(null), { edd, rh: 'neg', today: '2026-06-25' });
  assert.equal(neg.find((i) => i.key === 'anti_d').status, 'upcoming');
  assert.equal(s.find((i) => i.key === 'gtt').dueFrom, '2026-06-18'); // 24+0
});

// ---------------------------------------------------------------- WHO LMS
test('WHO LMS: z-scores reproduce the published WHO SD values', () => {
  // Day 0 medians (WHO: boys 3.3 kg / 49.9 cm / 34.5 cm; girls 3.2 kg / 49.1 cm / 33.9 cm)
  assert.equal(growth.lms('wfa', 'male', 0).M, 3.3464);
  assert.equal(growth.lms('lhfa', 'female', 0).M, 49.1477);
  assert.equal(growth.lms('hcfa', 'male', 0).M, 34.4618);
  // Boys weight-for-age at 12 months (day 365): WHO z-score table −3…+3 SD = 6.9, 7.7, 8.6, 9.6, 10.8, 12.0, 13.3 kg
  const p = growth.lms('wfa', 'male', 365);
  [[-3, 6.9], [-2, 7.7], [-1, 8.6], [0, 9.6], [1, 10.8], [2, 12.0], [3, 13.3]].forEach(([z, kg]) => {
    assert.ok(Math.abs(growth.valueAt(p, z) - kg) < 0.06, `SD ${z}: ${growth.valueAt(p, z)}`);
    assert.ok(Math.abs(growth.zScore('wfa', growth.valueAt(p, z), p) - z) < 1e-9);
  });
  // Restricted LMS beyond +3 SD for weight: z = 3 + (y − SD3) / (SD3 − SD2)
  const sd3 = growth.valueAt(p, 3); const sd2 = growth.valueAt(p, 2);
  assert.ok(Math.abs(growth.zScore('wfa', sd3 + (sd3 - sd2), p) - 4) < 1e-9);
  // Girls height at 24 months (day 731, standing): WHO median 85.7 cm
  assert.ok(Math.abs(growth.lms('lhfa', 'female', 731).M - 85.7) < 0.05);
  assert.equal(Math.round(growth.percentile(0)), 50);
  assert.ok(Math.abs(growth.percentile(-1.880794) - 3) < 0.01);
  assert.ok(Math.abs(growth.percentile(1.036433) - 85) < 0.01);
});

test('WHO LMS: assessment of a measurement (age, length convention, BMI, range)', () => {
  const a = growth.assess({ dob: '2025-01-01', gender: 'female', date: '2025-10-07', weightKg: 8.9, lengthCm: 70, headCm: 43 });
  assert.equal(a.ageDays, 279);
  assert.ok(Math.abs(a.wfa.z - 0.5993) < 0.001);
  assert.ok(Math.abs(a.wfa.p - 72.55) < 0.05);
  assert.ok(a.bfa.value > 18 && a.bfa.value < 18.2);
  assert.equal(growth.adjustedLength(80, 500, 'standing'), 80.7);
  assert.equal(growth.adjustedLength(90, 800, 'lying'), 89.3);
  assert.equal(growth.adjustedLength(90, 800, 'standing'), 90);
  const old = growth.assess({ dob: '2015-01-01', gender: 'male', date: '2026-01-01', weightKg: 30 });
  assert.equal(old.inRange, false);
  assert.equal(old.wfa.z, null);
  assert.equal(growth.assess({ dob: '2025-01-01', gender: null, date: '2025-06-01', weightKg: 7 }).wfa.z, null);
});

// ---------------------------------------------------------------- dental
test('dental entry validation', () => {
  const T = '2026-09-30';
  const ok = dental.validateEntry({ tooth: '16', condition: 'caries', surfaces: ['O', 'm'], entry_date: '2026-09-01' }, T);
  assert.deepEqual([ok.tooth, ok.surfaces, ok.material], [16, 'M,O', null]);
  const crown = dental.validateEntry({ tooth: '36', condition: 'crown', surfaces: ['O'], material: 'zirconia' }, T);
  assert.equal(crown.surfaces, null); // whole-tooth condition: surfaces dropped
  assert.equal(crown.material, 'zirconia');
  assert.equal(crown.entry_date, T);
  assert.equal(dental.validateEntry({ tooth: '55', condition: 'caries', surfaces: 'D', material: 'gold' }, T).material, null); // no material on caries
  const fails = (input, field) => assert.throws(() => dental.validateEntry(input, T), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details[field]));
  fails({ tooth: '16', condition: 'caries' }, 'surfaces');
  fails({ tooth: '19', condition: 'crown' }, 'tooth');
  fails({ tooth: '60', condition: 'crown' }, 'tooth');
  fails({ tooth: '16', condition: 'decay', surfaces: 'O' }, 'condition');
  fails({ tooth: '16', condition: 'filling', surfaces: 'X' }, 'surfaces');
  fails({ tooth: '16', condition: 'filling', surfaces: 'O', material: 'wood' }, 'material');
  fails({ tooth: '16', condition: 'watch', entry_date: '2026-10-01' }, 'entry_date');
});

test('dental chart is rebuilt from the dated entries (void entries ignored)', () => {
  const e = (id, entry_date, tooth, condition, surfaces = null, extra = {}) => ({ id, entry_date, tooth, condition, surfaces, material: null, voided_at: null, ...extra });
  const state = dental.chartState([
    e(3, '2026-03-01', 16, 'filling', 'O', { material: 'composite' }),
    e(1, '2026-01-01', 16, 'caries', 'O,M'),
    e(2, '2026-02-01', 26, 'caries', 'D'),
    e(4, '2026-04-01', 26, 'healthy', 'D'),
    e(5, '2026-01-05', 36, 'missing'),
    e(6, '2026-05-05', 36, 'implant'),
    e(7, '2026-05-05', 46, 'crown', null, { voided_at: new Date() }),
  ]);
  assert.deepEqual(state[16].surfaces.O, { condition: 'filling', material: 'composite' });
  assert.equal(state[16].surfaces.M.condition, 'caries');
  assert.deepEqual(dental.toothConditions(state[16]), ['caries', 'filling']);
  assert.deepEqual(state[26].surfaces, {});
  assert.equal(state[36].implant, true);
  assert.equal(state[36].missing, false);
  assert.equal(state[46], undefined);
  // Surface layout: upper right quadrant has buccal on top and mesial toward the midline (viewer's right).
  assert.deepEqual(dental.sideMap(1, true), { top: 'B', bottom: 'L', left: 'D', right: 'M' });
  assert.deepEqual(dental.sideMap(3, false), { top: 'L', bottom: 'B', left: 'M', right: 'D' });
});

// ---------------------------------------------------------------- settings, access, audit
test('modules follow the clinic specialty unless the clinic sets them', async () => {
  assert.deepEqual(svc.defaultModules('dentistry'), ['dental']);
  assert.deepEqual(svc.defaultModules('paediatrics'), ['growth']);
  assert.deepEqual(svc.defaultModules('obgyn'), ['pregnancy']);
  assert.deepEqual(svc.defaultModules('general'), ['dental', 'growth', 'pregnancy']);
  assert.deepEqual(svc.defaultModules('cardiology'), []);
  const biz = await businesses.get(other.businessId);
  let s = await svc.settings(biz);
  assert.deepEqual([s.dental, s.growth, s.pregnancy], [true, false, false]);
  await svc.saveSettings(other, biz, { dental: '1', pregnancy: '1' });
  s = await svc.settings(biz);
  assert.deepEqual([s.dental, s.growth, s.pregnancy], [true, false, true]);
  assert.equal(s.customSchedule, false);
  assert.ok(await knex('audit_logs').where({ business_id: other.businessId, action: 'specialty.settings_updated' }).first('id'));
});

test('tenant isolation, a doctor limited to own patients, visit linking, pregnancy rules', async () => {
  const mom = await addPatient(ctx.businessId, { full_name: 'Mom', gender: 'female', date_of_birth: '1995-01-01' });
  const man = await addPatient(ctx.businessId, { full_name: 'Man', gender: 'male', date_of_birth: '1980-01-01' });
  const foreign = await addPatient(other.businessId, { full_name: 'Elsewhere', gender: 'female' });
  const vA = await visit(ctx.businessId, docA, mom);
  const vMan = await visit(ctx.businessId, docA, man);
  await assert.rejects(svc.patientFor(ctx, foreign), (e) => e.status === 404);
  const docBctx = { ...ctx, permissions: new Set(['clinical.view', 'clinical.edit']), ownDoctorId: docB, doctorId: docB };
  await assert.rejects(svc.patientFor(docBctx, mom), (e) => e.status === 404); // docB never saw this patient
  const docActx = { ...ctx, permissions: new Set(['clinical.view', 'clinical.edit']), ownDoctorId: docA, doctorId: docA };
  const p = await svc.patientFor(docActx, mom);
  assert.equal((await svc.visitFor(docActx, p, vA)).id, vA);
  assert.equal(await svc.visitFor(docActx, p, vMan), null); // another patient's visit is not linked
  const id = await svc.startPregnancy(docActx, p, { dating_method: 'lmp', lmp: preg.addDays(today, -100), gravida: '2', para: '1', rh: 'neg' }, await svc.visitFor(docActx, p, vA));
  const row = await knex('pregnancies').where({ id }).first();
  assert.equal(row.edd, preg.addDays(today, 180));
  assert.equal(row.doctor_id, docA);
  await assert.rejects(svc.startPregnancy(docActx, p, { dating_method: 'lmp', lmp: today }), (e) => e.code === 'PREGNANCY_OPEN');
  await assert.rejects(svc.startPregnancy(ctx, await svc.patientFor(ctx, man), { dating_method: 'lmp', lmp: today }), (e) => e.code === 'NOT_FEMALE');
  await assert.rejects(svc.updatePregnancy(ctx, p, id, { dating_method: 'lmp', lmp: today, gravida: '1', para: '1' }), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.para));
  await assert.rejects(svc.closePregnancy(ctx, p, id, { outcome: 'live_birth', outcome_date: preg.addDays(today, 1) }), (e) => e.code === 'VALIDATION_FAILED');
  await svc.closePregnancy(ctx, p, id, { outcome: 'miscarriage', outcome_date: today, delivery_mode: 'caesarean', baby_weight_kg: '3' });
  const closed = await knex('pregnancies').where({ id }).first();
  assert.deepEqual([closed.status, closed.delivery_mode, closed.baby_weight_kg], ['closed', null, null]); // birth-only fields dropped
  // Dental entry from a visit is linked to it and to the visit's doctor; audited.
  const entryId = await svc.addDentalEntry(docActx, p, { tooth: '21', condition: 'watch' }, await svc.visitFor(docActx, p, vA));
  const entry = await knex('dental_entries').where({ id: entryId }).first();
  assert.deepEqual([entry.appointment_id, entry.doctor_id], [vA, docA]);
  await svc.voidDentalEntry(ctx, p, entryId);
  assert.ok((await knex('dental_entries').where({ id: entryId }).first()).voided_at);
  const actions = (await knex('audit_logs').where({ business_id: ctx.businessId, entity_type: 'patient', entity_id: String(mom) }).pluck('action'));
  ['pregnancy.started', 'pregnancy.closed', 'dental.entry_added', 'dental.entry_removed'].forEach((a) => assert.ok(actions.includes(a), a));
  // Another clinic's user cannot touch this patient's records by id.
  await assert.rejects(svc.voidDentalEntry(other, { id: mom }, entryId), (e) => e.status === 404);
});

test('growth measurement validation', async () => {
  const kid = await addPatient(ctx.businessId, { full_name: 'Kid', gender: 'male', date_of_birth: preg.addDays(today, -400) });
  const p = await svc.patientFor(ctx, kid);
  await assert.rejects(svc.addMeasurement(ctx, p, { measured_on: today }), (e) => Boolean(e.details.weight_kg));
  await assert.rejects(svc.addMeasurement(ctx, p, { measured_on: preg.addDays(today, -500), weight_kg: '3' }), (e) => Boolean(e.details.measured_on));
  await assert.rejects(svc.addMeasurement(ctx, p, { weight_kg: '900' }), (e) => Boolean(e.details.weight_kg));
  await svc.addMeasurement(ctx, p, { weight_kg: '10.2', length_cm: '76', position: 'lying' });
  const { measurements } = await svc.growthData(ctx, p);
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0].a.ageDays, 400);
  assert.ok(measurements[0].a.wfa.p > 30 && measurements[0].a.wfa.p < 70);
});

test('HTTP: clinical.view to see, clinical.edit to record; module switched off → 404; panels', async () => {
  const kid = await addPatient(ctx.businessId, { full_name: 'Http Kid', gender: 'female', date_of_birth: preg.addDays(today, -200) });
  await staff(ctx.businessId, 'receptionist', `rec${tag}@t.test`);
  await staff(ctx.businessId, 'nurse', `nurse${tag}@t.test`);
  const owner = await signIn(`spec${tag}@t.test`);
  const rec = await signIn(`rec${tag}@t.test`);
  const nurse = await signIn(`nurse${tag}@t.test`);
  assert.equal((await owner.get(`/app/patients/${kid}/dental`)).status, 200);
  assert.equal((await owner.get(`/app/patients/${kid}/growth`)).status, 200);
  assert.equal((await owner.get(`/app/patients/${kid}/pregnancy`)).status, 200);
  assert.equal((await rec.get(`/app/patients/${kid}/dental`)).status, 403); // no clinical.view
  assert.equal((await rec.get(`/app/specialty/panel/${kid}`)).status, 403);
  const nurseChart = await nurse.get(`/app/patients/${kid}/dental`);
  assert.equal(nurseChart.status, 200);
  assert.ok(!nurseChart.text.includes('id="dental-entry-dialog"')); // view only
  assert.equal((await nurse.post(`/app/patients/${kid}/dental/entries`, { tooth: '51', condition: 'caries', surfaces: 'O' })).status, 403);
  assert.equal((await nurse.post(`/app/patients/${kid}/growth`, { weight_kg: '7.1' })).status, 302); // nurses measure (vitals.edit)
  let r = await owner.post(`/app/patients/${kid}/dental/entries`, { tooth: '51', condition: 'caries' });
  assert.equal(r.status, 422);
  r = await owner.post(`/app/patients/${kid}/dental/entries`, { tooth: '51', condition: 'caries', surfaces: ['O', 'D'] });
  assert.equal(r.status, 302);
  assert.ok((await owner.get(`/app/patients/${kid}/dental`)).text.includes('dc-caries'));
  const panel = await owner.get(`/app/specialty/panel/${kid}`);
  assert.equal(panel.status, 200);
  assert.ok(panel.text.includes(`/app/patients/${kid}/growth`));
  assert.ok(!panel.text.includes(`/app/patients/${kid}/pregnancy`)); // a 6-month-old: not relevant
  assert.equal((await owner.get('/app/specialty/settings')).status, 200);
  assert.equal((await nurse.get('/app/specialty/settings')).status, 403);
  // Turn growth off: its page is gone and the panel no longer lists it.
  r = await owner.post('/app/specialty/settings', { dental: '1', pregnancy: '1' });
  assert.equal(r.status, 302);
  assert.equal((await owner.get(`/app/patients/${kid}/growth`)).status, 404);
  assert.ok(!(await owner.get(`/app/specialty/panel/${kid}`)).text.includes('/growth'));
  // Another clinic cannot open this patient.
  const stranger = await signIn(`spec-other${tag}@t.test`);
  assert.equal((await stranger.get(`/app/patients/${kid}/dental`)).status, 404);
});

test('a dental clinic sees only its own records and its ready diagnosis table; its codes come first in search', async () => {
  const dentist = await signIn(`spec-other${tag}@t.test`);
  const r = await dentist.get('/app/specialty/settings?lang=en');
  assert.equal(r.status, 200);
  assert.match(r.text, /name="dental"/);
  assert.match(r.text, /name="pregnancy"/, 'switched on earlier in this file: still offered');
  assert.doesNotMatch(r.text, /name="growth"/, 'growth charts are not a dental record');
  assert.match(r.text, /Ready diagnosis table/);
  assert.match(r.text, />K02\.1</);
  assert.doesNotMatch(r.text, />O80</, 'no obstetric codes in a dental table');
  const codes = await dentist.get('/app/settings/diagnosis-codes?lang=en');
  assert.match(codes.text, /data-dx-filter/);
  const icd = require('../src/modules/clinicalplus/icd.service');
  assert.ok(icd.specialtyTable('dentistry').every((e) => /^(K0|K1[0-4]|S02\.5|M26|B37\.0|R68\.2)/.test(e.code)));
  assert.ok(icd.specialtyTable('obgyn').some((e) => e.code.startsWith('O')));
  const found = await icd.search(other.businessId, 'abscess');
  assert.match(found[0].code, /^K/, 'a dental abscess first for a dental clinic');
});
