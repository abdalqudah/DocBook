// Specialty forms for every specialty: the scientific computations against published values, the forms a clinic gets
// from its own and its doctors' specialties, the catalogue, and the screens over HTTP (permissions, validation, live
// results, removal kept in the audit trail, tenant isolation).
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
const catalogue = require('../src/modules/specialty/catalogue');
const forms = require('../src/modules/specialty/forms');
const engine = require('../src/modules/specialty/forms/engine');
const svc = require('../src/modules/specialty/service');
const { egfr2021 } = require('../src/modules/specialty/forms/defs-cardio-medicine');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let eye; let other; let today; let server; let base;

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
async function staff(businessId, roleKey, email) {
  const userId = await knex.transaction((trx) => auth.createUser(trx, { name: roleKey, email, password: 'Passw0rd!x' }));
  const role = await rbac.getRoleByKey(businessId, roleKey);
  await knex('memberships').insert({ business_id: businessId, user_id: userId, role_id: role.id });
  await knex('users').where({ id: userId }).update({ last_business_id: businessId });
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
  const form = (data) => { const body = new URLSearchParams(); for (const [k, v] of Object.entries({ _csrf: csrf, ...data })) [].concat(v).forEach((x) => body.append(k, x)); return body; };
  return {
    get: async (path) => read(await fetch(base + path, { headers: { cookie: cookie(), accept: 'text/html' }, redirect: 'manual' })),
    post: async (path, data = {}, accept = 'text/html') => read(await fetch(base + path, { method: 'POST', headers: { cookie: cookie(), accept, 'content-type': 'application/x-www-form-urlencoded' }, body: form(data), redirect: 'manual' })),
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

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  eye = await makeClinic(`sf-eye${tag}@t.test`, 'Eye clinic', 'ophthalmology');
  other = await makeClinic(`sf-other${tag}@t.test`, 'Other clinic', 'multi');
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await knex.destroy(); });

const run = (key, data, p = {}) => engine.evaluate(forms.get(key), data, p).results;
const find = (rs, k) => rs.find((r) => r.k === k);

// ---------------------------------------------------------------- catalogue and forms
test('catalogue: every specialty is named in both languages; lineage; every form is well formed', () => {
  const ar = require('../src/locales/ar/auth.json').specialties; // eslint-disable-line global-require
  const en = require('../src/locales/en/auth.json').specialties; // eslint-disable-line global-require
  assert.ok(catalogue.KEYS.length >= 40);
  for (const k of catalogue.KEYS) { assert.ok(ar[k], `ar ${k}`); assert.ok(en[k], `en ${k}`); }
  assert.deepEqual(catalogue.lineage('orthodontics'), ['orthodontics', 'dentistry']);
  assert.equal(catalogue.root('geriatrics'), 'general');
  assert.equal(require('../src/modules/platformops/clinic-types').BUILTIN.length, catalogue.KEYS.length); // eslint-disable-line global-require
  assert.ok(forms.KEYS.length >= 40);
  assert.equal(new Set(forms.KEYS).size, forms.KEYS.length);
  const icons = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'icons.svg'), 'utf8'); // eslint-disable-line global-require
  for (const f of forms.FORMS) {
    assert.ok(f.ar && f.en && f.icon && f.specialties.length, f.key);
    assert.ok(icons.includes(`id="i-${f.icon}"`), `icon ${f.icon}`);
    f.specialties.forEach((s) => assert.ok(catalogue.has(s), `${f.key}: ${s}`));
    const keys = engine.inputsOf(f).map((i) => i.key);
    assert.equal(new Set(keys).size, keys.length, `${f.key}: duplicate inputs`);
    for (const s of f.sections) for (const x of s.fields) { assert.ok(x.ar && x.en, `${f.key}.${x.k}`); if (['sel', 'multi'].includes(x.t)) assert.ok(x.opts.every((o) => o.length === 3 && o[1] && o[2]), `${f.key}.${x.k} options`); }
    assert.deepEqual(engine.evaluate(f, {}, {}).results.filter((r) => r.level === 'bad'), [], `${f.key}: nothing alarming from an empty form`);
  }
  // Every non-broad specialty has records of its own (forms or a record screen).
  for (const k of catalogue.KEYS.filter((x) => !catalogue.BROAD.has(x))) {
    assert.ok(forms.forSpecialty(k).length || ['dental', 'growth', 'pregnancy'].some((m) => forms.moduleFor(m, k)), `${k} has no records`);
  }
});

test('defaults: from the clinic specialty and its doctors; a broad clinic without doctors gets general practice', () => {
  assert.ok(forms.defaults('ophthalmology').includes('eye_exam'));
  assert.ok(!forms.defaults('ophthalmology').includes('phq9'));
  const centre = forms.defaults('multi', ['cardiology', 'audiology']);
  assert.ok(centre.includes('cardiac_assessment') && centre.includes('audiogram'));
  assert.ok(!centre.includes('eye_exam'));
  assert.deepEqual(forms.defaults('multi'), forms.forSpecialty('general'));
  assert.ok(forms.forSpecialty('orthodontics').includes('orthodontic'));
  assert.ok(forms.moduleFor('dental', 'orthodontics') && forms.moduleFor('pregnancy', 'fertility') && !forms.moduleFor('dental', 'cardiology'));
  assert.deepEqual(svc.defaultModules('cardiology', ['oral_surgery']), ['dental']);
});

// ---------------------------------------------------------------- computations against published values
test('kidney: CKD-EPI 2021, KDIGO G and A categories, risk', () => {
  assert.equal(Math.round(egfr2021(1.0, 50, true)), 69);
  assert.equal(Math.round(egfr2021(1.2, 60, false)), 69);
  assert.equal(egfr2021(1, 12, false), null, 'adults only');
  const rs = run('kidney', { scr: 106, scr_unit: 'umol', age: 60, sex: 'male', acr: 45 });
  assert.equal(find(rs, 'egfr').v, 69); // 106 µmol/L = 1.2 mg/dL
  assert.equal(find(rs, 'egfr').band.en, 'G2 — mildly decreased');
  assert.equal(find(rs, 'a').v, 'A2');
  assert.equal(find(rs, 'kdigo').level, 'mild');
  assert.equal(find(run('kidney', { scr: 3, scr_unit: 'mgdl', age: 70, sex: 'female', acr: 400 }), 'kdigo').level, 'bad');
});

test('cardiology: QTc (Bazett), LVEF bands, CHA2DS2-VASc and HAS-BLED', () => {
  assert.equal(find(run('cardiac_assessment', { qt: 400, rate: 60 }), 'qtc').v, 400);
  const q = find(run('cardiac_assessment', { qt: 400, rate: 90, sex: 'male' }), 'qtc');
  assert.equal(q.v, 490); assert.equal(q.level, 'warn');
  assert.equal(find(run('cardiac_assessment', { ef: 35 }), 'ef').level, 'bad');
  assert.equal(find(run('cardiac_assessment', { ef: 45 }), 'ef').level, 'warn');
  const c = find(run('cha2ds2vasc', { chf: 0, htn: 1, age: 2, dm: 0, stroke: 0, vasc: 0, sex: 1 }), 'score');
  assert.equal(c.v, 4); assert.equal(c.level, 'bad');
  assert.equal(find(run('cha2ds2vasc', { chf: 0, htn: 0, age: 0, dm: 0, stroke: 0, vasc: 0, sex: 1 }), 'score').level, 'ok', 'female sex alone is low risk');
  assert.equal(find(run('has_bled', { h: 1, e: 1, drugs: 1 }), 'score').level, 'warn');
  const abi = run('abi', { brachial_r: 120, brachial_l: 118, dp_r: 100, pt_r: 108, dp_l: 130, pt_l: 125 });
  assert.equal(find(abi, 'abi_r').v, 0.9); assert.equal(find(abi, 'abi_r').level, 'warn');
  assert.equal(find(abi, 'abi_l').level, 'ok');
});

test('rheumatology, dermatology, liver, lungs: DAS28, PASI, Child-Pugh, MELD, spirometry', () => {
  assert.equal(find(run('das28', { tjc: 4, sjc: 2, esr: 30, gh: 50 }), 'esr').v, 4.6);
  const pasi = find(run('pasi', { p__head__e: 2, p__head__i: 2, p__head__s: 2, p__head__a: 2, p__trunk__e: 3, p__trunk__i: 3, p__trunk__s: 3, p__trunk__a: 4 }), 'pasi');
  assert.equal(pasi.v, 12); assert.equal(pasi.level, 'bad');
  assert.throws(() => engine.read(forms.get('pasi'), { f_p__head__e: '5' }), (e) => e.details.f_p__head__e === 'Too large.', 'severity items are 0–4');
  const liver = run('liver_scores', { bili: 2, alb: 3.0, inr: 1.5, cr: 1.2, ascites: 2, enceph: 1 });
  assert.equal(find(liver, 'cp').v, 'B (8)');
  assert.equal(find(liver, 'meld').v, 15);
  const sp = run('spirometry', { fev1: 1.5, fvc: 2.5, fev1_pred: 55, fev1_post: 1.75 });
  assert.equal(find(sp, 'ratio').v, 0.6);
  assert.equal(find(sp, 'gold').v, 'GOLD 2');
  assert.equal(find(sp, 'bdr').text, undefined);
  assert.equal(find(sp, 'bdr').band.en, 'Significant (≥ 12% and ≥ 200 mL)');
});

test('mental health, hearing, urology, fertility, newborn', () => {
  const nine = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => [`q${i}`, 1]));
  const phq = run('phq9', nine);
  assert.equal(find(phq, 'score').v, 9); assert.equal(find(phq, 'score').band.en, 'Mild');
  assert.equal(find(phq, 'q9').level, 'bad', 'item 9 always flags');
  assert.equal(find(run('phq9', { ...nine, q9: 0 }), 'q9'), undefined);
  assert.equal(run('phq9', { q1: 3 }).length, 0, 'no total until every item is answered');
  const aud = run('audiogram', { ac__500__r: 30, ac__1000__r: 40, ac__2000__r: 45, ac__4000__r: 55, bc__500__r: 10, bc__1000__r: 15, bc__2000__r: 20 });
  assert.equal(find(aud, 'pta_r').v, 43); assert.equal(find(aud, 'pta_r').band.en, 'Moderate loss');
  assert.equal(find(aud, 'abg_r').level, 'warn');
  assert.equal(find(run('ipss', { q1: 2, q2: 3, q3: 1, q4: 2, q5: 4, q6: 1, q7: 2 }), 'score').v, 15);
  const semen = run('semen_analysis', { volume: 2, conc: 10, progressive: 25, morphology: 5 });
  assert.match(find(semen, 'dx').band.en, /Oligozoospermia, Asthenozoospermia/);
  assert.equal(find(run('semen_analysis', { volume: 3, conc: 40, progressive: 45, morphology: 6 }), 'dx').level, 'ok');
  const fol = run('follicle_scan', { fol_r: '18 16 12', fol_l: '١٩ 14', endo: 6.5 });
  assert.equal(find(fol, 'count').v, 5); assert.equal(find(fol, 'mature').v, 2); assert.equal(find(fol, 'endo').level, 'warn');
  const nb = run('newborn', { a1: 1, p1: 2, g1: 1, ac1: 1, r1: 1, bw: 2300 });
  assert.equal(find(nb, 'apgar1').v, 6); assert.equal(find(nb, 'bw').level, 'warn');
});

test('engine: Arabic digits and commas, ranges, options, sides, required fields, nothing entered', () => {
  const f = forms.get('eye_exam');
  const ok = engine.read(f, { f_iop_r: '٢٥', f_iop_l: '18,5', f_ucva_r: '6/9', f_cdr_l: '0.7' });
  assert.equal(ok.data.iop_r, 25); assert.equal(ok.data.iop_l, 18.5);
  assert.equal(ok.level, 'warn');
  assert.equal(ok.headline, '25 mmHg');
  assert.throws(() => engine.read(f, { f_iop_r: '500' }), (e) => e.details.f_iop_r === 'Too large.');
  assert.throws(() => engine.read(f, { f_ucva_r: '6/4' }), (e) => e.details.f_ucva_r === 'Choose a valid value.');
  assert.throws(() => engine.read(f, { f_axis_r: '12.5' }), (e) => e.details.f_axis_r === 'Enter a whole number.');
  assert.throws(() => engine.read(f, {}), (e) => e.details.form === 'Enter at least one value.');
  assert.throws(() => engine.read(forms.get('skin_lesion'), { f_size: '4' }), (e) => e.details.f_site === 'Required.');
  assert.throws(() => engine.read(forms.get('oral_surgery'), { f_procedure: 'simple', f_teeth: '38 49' }), (e) => /FDI/.test(e.details.f_teeth));
  assert.equal(engine.read(forms.get('oral_surgery'), { f_procedure: 'simple', f_teeth: '38، ٤٨' }).data.teeth, '38، ٤٨');
  const desc = engine.describe(f, ok.data);
  assert.ok(desc.some((s) => s.rows.some((r) => r.sides)));
});

// ---------------------------------------------------------------- over HTTP
test('HTTP: forms of the clinic and its doctors, live results, save, view, print, remove (audited), access', async () => {
  await staff(eye.businessId, 'receptionist', `sf-rec${tag}@t.test`);
  await staff(eye.businessId, 'nurse', `sf-nurse${tag}@t.test`);
  const pt = await addPatient(eye.businessId, { full_name: 'Eye Patient', gender: 'female', date_of_birth: '1960-05-01' });
  const owner = await signIn(`sf-eye${tag}@t.test`);
  const rec = await signIn(`sf-rec${tag}@t.test`);
  const nurse = await signIn(`sf-nurse${tag}@t.test`);

  let r = await owner.get(`/app/patients/${pt}/records?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Eye examination/);
  assert.doesNotMatch(r.text, /Cardiac assessment/);
  assert.equal((await owner.get(`/app/patients/${pt}/records/cardiac_assessment/new`)).status, 404, 'not a form of this clinic');

  // A cardiologist joins the clinic: the cardiology forms switch on by themselves, first on their own visits.
  await doctors.saveDoctor(eye, null, { full_name: 'Dr. Heart', specialty_key: 'cardiology', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
  assert.ok((await svc.settings(await businesses.get(eye.businessId))).forms.includes('cardiac_assessment'));
  assert.equal((await owner.get(`/app/patients/${pt}/records/cardiac_assessment/new`)).status, 200);
  await assert.rejects(() => doctors.saveDoctor(eye, null, { full_name: 'Dr. X', specialty_key: 'astrology', slot_duration_minutes: '30', consultation_fee: '0', base_salary: '0', is_active: '1' }), (e) => Boolean(e.details.specialty_key));

  // Live results while typing (nothing saved).
  r = await owner.post(`/app/patients/${pt}/records/eye_exam/preview?lang=en`, { f_iop_r: '28' }, 'application/json');
  assert.equal(r.status, 200);
  const live = JSON.parse(r.text);
  assert.equal(live.level, 'warn');
  assert.equal(live.results[0].band, 'Raised');
  assert.equal(await knex('specialty_records').where({ business_id: eye.businessId }).count({ n: '*' }).then(([x]) => Number(x.n)), 0);

  // Validation keeps what was typed.
  r = await owner.post(`/app/patients/${pt}/records/eye_exam?lang=en`, { f_iop_r: '500', f_fundus_r: 'kept text' });
  assert.equal(r.status, 422);
  assert.match(r.text, /kept text/);
  r = await owner.post(`/app/patients/${pt}/records/eye_exam`, { record_date: '2999-01-01', f_iop_r: '20' });
  assert.equal(r.status, 422, 'no future dates');

  r = await owner.post(`/app/patients/${pt}/records/eye_exam`, { f_iop_r: '28', f_iop_l: '17', f_ucva_r: '6/12', f_cdr_r: '0.4', f_cdr_l: '0.7' });
  assert.equal(r.status, 302);
  const id = Number(r.location.split('?')[0].split('/').pop());
  const row = await knex('specialty_records').where({ id }).first();
  assert.equal(row.business_id, eye.businessId); assert.equal(row.level, 'warn'); assert.equal(row.headline, '28 mmHg');
  assert.equal(JSON.parse(row.data).ucva_r, '6/12');
  r = await owner.get(`/app/patients/${pt}/records/eye_exam/${id}?lang=en`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Raised/); assert.match(r.text, /Large — assess for glaucoma/);
  assert.equal((await owner.get(`/app/patients/${pt}/records/eye_exam/${id}?print=1`)).status, 200);
  await owner.post(`/app/patients/${pt}/records/eye_exam`, { f_iop_r: '22', f_iop_l: '16' });
  r = await owner.get(`/app/patients/${pt}/records/eye_exam?lang=en`);
  assert.match(r.text, /class="sf-spark"/, 'IOP trend after two records');
  assert.match((await owner.get(`/app/specialty/panel/${pt}?lang=en`)).text, /Eye examination/);

  // Who may do what.
  assert.equal((await rec.get(`/app/patients/${pt}/records`)).status, 403);
  assert.equal((await nurse.get(`/app/patients/${pt}/records/eye_exam/${id}`)).status, 200);
  assert.equal((await nurse.post(`/app/patients/${pt}/records/eye_exam`, { f_iop_r: '20' })).status, 403);
  assert.equal((await nurse.post(`/app/patients/${pt}/records/eye_exam/${id}/void`, { reason: 'x' })).status, 403);
  const stranger = await signIn(`sf-other${tag}@t.test`);
  assert.equal((await stranger.get(`/app/patients/${pt}/records/eye_exam/${id}`)).status, 404);
  assert.equal((await stranger.post(`/app/patients/${pt}/records/eye_exam/${id}/void`, { reason: 'x' })).status, 404);

  // Removal keeps the record, with who and why, and the audit trail.
  r = await owner.post(`/app/patients/${pt}/records/eye_exam/${id}/void`, { reason: 'Wrong patient' });
  assert.equal(r.status, 302);
  const gone = await knex('specialty_records').where({ id }).first();
  assert.ok(gone.voided_at); assert.equal(gone.void_reason, 'Wrong patient');
  const actions = await knex('audit_logs').where({ business_id: eye.businessId, entity_type: 'patient', entity_id: String(pt) }).pluck('action');
  assert.ok(actions.includes('specialty.record_added') && actions.includes('specialty.record_removed'));
  assert.match((await owner.get(`/app/patients/${pt}/records/eye_exam/${id}?lang=en`)).text, /was removed/);

  // Turning a form off hides new entries; its records stay readable.
  r = await owner.post('/app/specialty/settings', { forms_present: '1', forms: ['glasses_rx'] });
  assert.equal(r.status, 302);
  assert.equal((await owner.get(`/app/patients/${pt}/records/eye_exam/new`)).status, 404);
  assert.equal((await owner.get(`/app/patients/${pt}/records/eye_exam`)).status, 200);
  const st = await svc.settings(await businesses.get(eye.businessId));
  assert.deepEqual(st.forms, ['glasses_rx']);
  r = await owner.post('/app/specialty/settings', { forms_present: '1', forms: ['eye_exam', 'glasses_rx', 'phq9'] });
  assert.ok((await svc.settings(await businesses.get(eye.businessId))).forms.includes('phq9'), 'a form of another specialty can be added by hand');
});

test('services keep their own procedure code; doctors their specialty', async () => {
  const id = await doctors.saveService(eye, null, { name: 'Eye test', price: '10', is_active: '1', code_field: '1', code: '92004', code_system: 'cpt' });
  let s = await knex('services').where({ id }).first();
  assert.equal(s.code, '92004'); assert.equal(s.code_system, 'cpt');
  await doctors.saveService(eye, id, { name: 'Eye test', price: '12', is_active: '1' }); // another form: the code stays
  s = await knex('services').where({ id }).first();
  assert.equal(s.code, '92004');
  await assert.rejects(() => doctors.saveService(eye, null, { name: 'Bad', price: '1', is_active: '1', code_field: '1', code: '<x>' }), (e) => Boolean(e.details.code));
});
