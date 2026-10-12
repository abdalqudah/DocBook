// Chronic disease tracking against the test database: conditions (added, checked, removed, audited), readings entered
// between visits (blood pressure as 120/80, glucose fasting/random, checks), the vital signs of a visit appearing in the
// series, targets and out-of-range marks, the chart (SVG with the ringed out-of-range dot), the Tracking tab and the
// header badges, the clinic-wide list with the "follow-up overdue" flag and its setting, and permissions over HTTP
// (a member without the medical-record permissions cannot add).
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
const chronic = require('../src/modules/chronic/service');
const view = require('../src/modules/chronic/view');
const { translator } = require('../src/core/i18n');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let ctx; let doc; let patientId; let staleId; let today; let srv;

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function makeClinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date() });
  businesses.forget(businessId);
  today = clinicNow('Asia/Amman').date;
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, locale: 'en', today };
}
async function staff(businessId, roleKey, email) {
  const userId = await knex.transaction((trx) => auth.createUser(trx, { name: roleKey, email, password: 'Passw0rd!x' }));
  const role = await rbac.getRoleByKey(businessId, roleKey);
  await knex('memberships').insert({ business_id: businessId, user_id: userId, role_id: role.id });
  await knex('users').where({ id: userId }).update({ last_business_id: businessId });
  return userId;
}
async function visitWithVitals(pid, date, vitals) {
  const [aid] = await knex('appointments').insert({
    business_id: ctx.businessId, doctor_id: doc, patient_id: pid, patient_name: 'P', patient_phone: '0790000000',
    appointment_date: date, appointment_time: '10:00', duration_minutes: 15, status: 'completed',
  });
  await knex('consultations').insert({ business_id: ctx.businessId, appointment_id: aid, doctor_id: doc, patient_id: pid, patient_name: 'P', vital_signs: JSON.stringify(vitals) });
  return aid;
}

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ctx = await makeClinic(`chronic${tag}@t.test`, 'Chronic clinic');
  doc = await doctors.saveDoctor(ctx, null, { full_name: 'Dr Lina', slot_duration_minutes: '15', consultation_fee: '20', base_salary: '0', is_active: '1' });
  [patientId] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'Huda Salem', phone: '0790000000' });
  [staleId] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'Omar Stale', phone: '0790000002' });
  srv = await serve();
});
test.after(async () => { await srv.close(); await knex.destroy(); });

test('conditions: added with a start date, checked, no duplicates, removed — and audited', async () => {
  const p = { id: patientId };
  const id = await chronic.addCondition(ctx, p, { condition_key: 'diabetes', started_on: '2020-03-01', note: 'Type 2' });
  await chronic.addCondition(ctx, p, { condition_key: 'other', label: 'Gout' });
  await assert.rejects(() => chronic.addCondition(ctx, p, { condition_key: 'diabetes' }), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.condition_key));
  await assert.rejects(() => chronic.addCondition(ctx, p, { condition_key: 'other' }), (e) => Boolean(e.details.label));
  await assert.rejects(() => chronic.addCondition(ctx, p, { condition_key: 'cancer' }), (e) => Boolean(e.details.condition_key));
  await assert.rejects(() => chronic.addCondition(ctx, p, { condition_key: 'thyroid', started_on: addDays(today, 3) }), (e) => Boolean(e.details.started_on));
  const tmp = await chronic.addCondition(ctx, p, { condition_key: 'thyroid' });
  await chronic.removeCondition(ctx, p, tmp);
  const list = await chronic.conditionsOf(ctx, patientId);
  assert.deepEqual(list.map((c) => c.condition_key).sort(), ['diabetes', 'other']);
  assert.equal(list.find((c) => c.id === id).started_on, '2020-03-01');
  const acts = await knex('audit_logs').where({ business_id: ctx.businessId, entity_type: 'patient', entity_id: String(patientId) }).pluck('action');
  assert.ok(acts.includes('chronic.condition_added') && acts.includes('chronic.condition_removed'));
});

test('readings: blood pressure as 120/80, glucose with its context, checks and audit', async () => {
  const p = { id: patientId };
  await chronic.addReading(ctx, p, { kind: 'bp', value: '150/95', measured_on: addDays(today, -20), measured_time: '08:30' });
  await chronic.addReading(ctx, p, { kind: 'bp', value: '128 / 78', measured_on: addDays(today, -2) });
  await chronic.addReading(ctx, p, { kind: 'glucose', value: '110', context: 'fasting', measured_on: addDays(today, -10) });
  await chronic.addReading(ctx, p, { kind: 'glucose', value: '165', context: 'fasting', measured_on: addDays(today, -1) });
  await chronic.addReading(ctx, p, { kind: 'hba1c', value: '7,4', measured_on: addDays(today, -1) });
  const r = await knex('patient_readings').where({ business_id: ctx.businessId, patient_id: patientId, kind: 'bp' }).orderBy('measured_on').first();
  assert.equal(Number(r.value), 150); assert.equal(Number(r.value2), 95); assert.equal(r.unit, 'mmHg'); assert.equal(r.measured_time, '08:30'); assert.equal(r.entered_by, ctx.userId);
  assert.equal(Number((await knex('patient_readings').where({ patient_id: patientId, kind: 'hba1c' }).first()).value), 7.4, 'a decimal comma is read');
  for (const bad of [{ kind: 'bp', value: '120' }, { kind: 'bp', value: '80/120' }, { kind: 'glucose', value: 'abc' }, { kind: 'spo2', value: '140' }, { kind: 'xray', value: '1' }, { kind: 'weight', value: '80', measured_on: addDays(today, 2) }, { kind: 'pulse', value: '70', measured_time: '25:00' }]) {
    await assert.rejects(() => chronic.addReading(ctx, p, bad), (e) => e.code === 'VALIDATION_FAILED', JSON.stringify(bad)); // eslint-disable-line no-await-in-loop
  }
  const tmp = await chronic.addReading(ctx, p, { kind: 'pulse', value: '70' });
  await chronic.removeReading(ctx, p, tmp);
  assert.equal(await knex('patient_readings').where({ id: tmp }).first(), undefined);
  const acts = await knex('audit_logs').where({ business_id: ctx.businessId, entity_id: String(patientId) }).pluck('action');
  assert.ok(acts.includes('chronic.reading_added') && acts.includes('chronic.reading_removed'));
});

test('a visit\'s vital signs appear in the series, with targets, latest value, change and out-of-range marks', async () => {
  await visitWithVitals(patientId, addDays(today, -5), { bloodPressure: '135/85', pulseBpm: 72, weightKg: 88, heightCm: 170, bloodSugar: 190 });
  const tr = await chronic.trackingOf(ctx, { id: patientId });
  const visitRows = tr.readings.filter((r) => r.source === 'visit');
  assert.deepEqual(visitRows.map((r) => r.kind).sort(), ['bp', 'glucose', 'height', 'pulse', 'weight']);
  const bp = tr.list.find((m) => m.key === 'bp');
  const sys = bp.series.find((s) => s.key === 'sys');
  assert.deepEqual(sys.points.map((x) => x.v), [150, 135, 128], 'entered readings and the visit, in date order');
  assert.deepEqual(sys.points.map((x) => x.out), [true, true, false], 'diabetes: target < 130/80');
  assert.equal(sys.change, -7);
  const glucose = tr.list.find((m) => m.key === 'glucose');
  assert.deepEqual(glucose.series.find((s) => s.key === 'fasting').points.map((x) => [x.v, x.out]), [[110, false], [165, true]]);
  assert.deepEqual(glucose.series.find((s) => s.key === 'random').points.map((x) => [x.v, x.out]), [[190, true]], 'the visit\'s blood sugar counts as random');
  assert.ok(tr.list.find((m) => m.key === 'hba1c').series[0].last.out, 'HbA1c 7.4 ≥ 7');
  const bmi = tr.list.find((m) => m.key === 'bmi');
  assert.equal(bmi.series[0].last.v, 30.4); assert.equal(tr.heightCm, 170);
  // without a strict-target condition, blood pressure is checked against < 140/90
  assert.equal(chronic.targetsFor([], null).sys.hi, 140);
  assert.equal(chronic.isOut(chronic.targetsFor(['hypertension'], null).dia, 80), true);
});

test('the chart: inline SVG, no hex colours, the out-of-range values ringed', async () => {
  const tr = await chronic.trackingOf(ctx, { id: patientId });
  const charts = view.charts(tr, translator('en'), 'en');
  const bp = charts.find((c) => c.key === 'bp');
  assert.match(bp.svg, /^<div class="chart ck-chart" data-chart><svg class="ch"/);
  assert.equal((bp.svg.match(/class="ck-out-ring"/g) || []).length, bp.outCount);
  assert.ok(bp.outCount >= 3, 'two systolic and the diastolic values out of range');
  assert.match(bp.svg, /class="ck-band /, 'the target band');
  assert.doesNotMatch(bp.svg, /#[0-9a-f]{3,6}\b/i);
  assert.equal(bp.latest, '128/78'); assert.equal(bp.target, '< 130/80'); assert.equal(bp.lastOut, false);
  assert.deepEqual(bp.change, { text: '-7/-7', dir: -1 });
  assert.equal(charts.find((c) => c.key === 'hba1c').lastOut, true);
});

test('the clinic-wide list: last reading, last visit, overdue follow-up and its setting', async () => {
  await chronic.addCondition(ctx, { id: staleId }, { condition_key: 'hypertension' });
  await visitWithVitals(staleId, addDays(today, -120), { bloodPressure: '140/90' });
  let { rows, overdueDays } = await chronic.chronicList(ctx);
  assert.equal(overdueDays, 90);
  const huda = rows.find((r) => r.patient.id === patientId);
  const omar = rows.find((r) => r.patient.id === staleId);
  assert.equal(huda.overdue, false); assert.equal(huda.reading.measured_on, addDays(today, -1)); assert.equal(huda.reading.source, 'manual'); assert.equal(huda.lastVisit, addDays(today, -5));
  assert.equal(omar.overdue, true); assert.equal(omar.daysSince, 120); assert.equal(omar.reading.kind, 'bp'); assert.equal(omar.reading.source, 'visit');
  assert.equal(rows[0].patient.id, staleId, 'overdue first');
  assert.deepEqual((await chronic.chronicList(ctx, { condition: 'diabetes' })).rows.map((r) => r.patient.id), [patientId]);
  assert.deepEqual((await chronic.chronicList(ctx, { overdueOnly: true })).rows.map((r) => r.patient.id), [staleId]);
  await chronic.saveSettings(ctx, { overdue_days: '180' });
  ({ rows } = await chronic.chronicList(ctx));
  assert.equal(rows.find((r) => r.patient.id === staleId).overdue, false);
  await assert.rejects(() => chronic.saveSettings(ctx, { overdue_days: '2' }), (e) => e.code === 'VALIDATION_FAILED');
  await chronic.saveSettings(ctx, { overdue_days: '90' });
});

test('HTTP: Tracking tab with badges and charts, the list, adding — and refused without the medical permissions', async () => {
  const owner = srv.agent();
  await owner.login(`chronic${tag}@t.test`);
  let r = await owner.get(`/app/patients/${patientId}?tab=tracking`);
  assert.equal(r.status, 200);
  assert.match(r.text, /class="badge badge-warning ck-cond"/, 'condition badges in the header');
  assert.match(r.text, /data-measure="bp"/); assert.match(r.text, /ck-out-ring/);
  assert.match(r.text, /action="\/app\/patients\/\d+\/chronic\/readings"/);
  r = await owner.get(`/app/patients/${patientId}`);
  assert.match(r.text, /ck-cond/, 'badges on the overview too');
  assert.match(r.text, /\?tab=tracking/);
  r = await owner.submit(`/app/patients/${patientId}?tab=tracking`, `/app/patients/${patientId}/chronic/readings`, { kind: 'weight', value: '86.5', measured_on: today });
  assert.equal(r.status, 302); assert.equal(r.location, `/app/patients/${patientId}?tab=tracking`);
  assert.ok(await knex('patient_readings').where({ patient_id: patientId, kind: 'weight' }).first());
  r = await owner.submit(`/app/patients/${patientId}?tab=tracking`, `/app/patients/${patientId}/chronic/readings`, { kind: 'bp', value: 'high', measured_on: today });
  assert.equal(r.status, 302, 'a refused value comes back to the tab with a message');
  r = await owner.submit(`/app/patients/${patientId}?tab=tracking`, `/app/patients/${patientId}/chronic/conditions`, { condition_key: 'asthma_copd' });
  assert.equal(r.status, 302);
  assert.ok(await knex('patient_conditions').where({ patient_id: patientId, condition_key: 'asthma_copd' }).first());
  r = await owner.get('/app/chronic?lang=ar');
  assert.equal(r.status, 200);
  assert.match(r.text, /مرضى الأمراض المزمنة/); assert.match(r.text, /data-overdue/); assert.match(r.text, /Omar Stale/);
  assert.match(r.text, /href="\/app\/chronic"/, 'in the navigation');
  r = await owner.get('/app/chronic?condition=diabetes');
  assert.doesNotMatch(r.text, /Omar Stale/);

  // a receptionist (patients, no medical record) cannot see the tab nor add anything
  await staff(ctx.businessId, 'receptionist', `chronic-rec${tag}@t.test`);
  const rec = srv.agent();
  await rec.login(`chronic-rec${tag}@t.test`);
  r = await rec.get(`/app/patients/${patientId}?tab=tracking`);
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /chronic\/readings/); assert.doesNotMatch(r.text, /ck-cond/);
  const before = await knex('patient_readings').where({ patient_id: patientId }).count({ n: '*' });
  r = await rec.submit(`/app/patients/${patientId}`, `/app/patients/${patientId}/chronic/readings`, { kind: 'pulse', value: '70', measured_on: today });
  assert.equal(r.status, 403);
  r = await rec.submit(`/app/patients/${patientId}`, `/app/patients/${patientId}/chronic/conditions`, { condition_key: 'kidney' });
  assert.equal(r.status, 403);
  assert.deepEqual(await knex('patient_readings').where({ patient_id: patientId }).count({ n: '*' }), before);
  assert.equal(await knex('patient_conditions').where({ patient_id: patientId, condition_key: 'kidney' }).first(), undefined);
  r = await rec.get('/app/chronic');
  assert.equal(r.status, 403);

  // a nurse (vital signs, no clinical notes) may add a reading but not a condition
  await staff(ctx.businessId, 'nurse', `chronic-nurse${tag}@t.test`);
  const nurse = srv.agent();
  await nurse.login(`chronic-nurse${tag}@t.test`);
  r = await nurse.submit(`/app/patients/${patientId}?tab=tracking`, `/app/patients/${patientId}/chronic/readings`, { kind: 'spo2', value: '97', measured_on: today });
  assert.equal(r.status, 302);
  r = await nurse.submit(`/app/patients/${patientId}?tab=tracking`, `/app/patients/${patientId}/chronic/conditions`, { condition_key: 'kidney' });
  assert.equal(r.status, 403);
});
