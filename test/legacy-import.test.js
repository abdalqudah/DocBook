// Legacy Patient Recovery & Import (Clinica): the patients file read as a stream, the attachment ZIPs checked against
// their manifests, patients matched by the old id (never the name), treatments and clinical tables kept as rows,
// files kept privately once per SHA-256, a stopped import carried on, a second run adding nothing, reconciliation,
// and who may run it / open the files.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-test-'));
process.env.LEGACY_IMPORT_DIR = path.join(TMP, 'jobs');
process.env.LEGACY_FILES_DIR = path.join(TMP, 'files');

const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const { clinicNow } = require('../src/modules/clinic/scheduling');
const { ZipFile } = require('../src/core/zipstream');
const jsonstream = require('../src/core/jsonstream');
const svc = require('../src/modules/legacy/import.service');
const files = require('../src/modules/legacy/files');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let ctx; let other; let server; let base;

async function makeClinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date(), media_quota_mb: 500 });
  businesses.forget(businessId);
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, locale: 'en', today: clinicNow('Asia/Amman').date };
}
async function staff(businessId, roleKey, email) {
  const userId = await knex.transaction((trx) => auth.createUser(trx, { name: roleKey, email, password: 'Passw0rd!x' }));
  const role = await rbac.getRoleByKey(businessId, roleKey);
  await knex('memberships').insert({ business_id: businessId, user_id: userId, role_id: role.id });
  await knex('users').where({ id: userId }).update({ last_business_id: businessId });
  return userId;
}
function client() {
  const jar = {};
  let csrf = '';
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const read = async (res) => {
    for (const h of res.headers.getSetCookie()) { const [kv] = h.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const type = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    const text = /text|json|csv/.test(type) ? buf.toString('utf8') : '';
    const m = text.match(/name="csrf-token" content="([^"]+)"/); if (m) csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text, type, buf, headers: res.headers };
  };
  return {
    get: async (p) => read(await fetch(base + p, { headers: { cookie: cookie(), accept: 'text/html' }, redirect: 'manual' })),
    post: async (p, data = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: csrf, ...data })) [].concat(v).forEach((x) => body.append(k, x));
      return read(await fetch(base + p, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' }));
    },
    upload: async (p, field, buf, name) => {
      const fd = new FormData();
      fd.append('_csrf', csrf);
      fd.append(field, new Blob([buf]), name);
      return read(await fetch(base + p, { method: 'POST', headers: { cookie: cookie() }, body: fd, redirect: 'manual' }));
    },
  };
}
async function signIn(email) {
  const c = client();
  await c.get('/login');
  assert.equal((await c.post('/login', { email, password: 'Passw0rd!x' })).status, 302);
  return c;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Test fixtures in the backup's shape (written for this test only).
const backup = (ids, phone = '07900000') => ({
  exported_at: '2026-01-01',
  patients: ids.map((id, i) => ({
    patient_id: id, patient_number: `N-${id}`, patient_name: `مريض ${i + 1}`, mobile: `${phone}${String(i).padStart(2, '0')}`, telephone: '065000000', group: 'Ortho',
    nationality: 'Jordan', url: `https://old.example/patients/${id}`, blood: 'A+',
    treatments: [
      { id: `${id}01`, date: '2023-05-02', tooth: '16', description: 'حشوة', doctor: 'Dr A', price: '25 JD', type: 'Filling', status: 'Done', complete_date: '2023-05-02', note: 'n', referred_by: 'self' },
      { date: '01/06/2023', tooth: '11', description: 'Cleaning', price: 15 },
    ],
    clinical_tables: {
      periodontal: [{ tooth: 16, depth: 3 }, { tooth: 17, depth: 4 }],
      anesthesia: { headers: ['date', 'type'], rows: [['2023-05-02', 'Lidocaine']] },
    },
    attachments: [{ url: `https://old.example/files/${id}/x.png`, filename: 'x.png' }],
  })),
});

async function zip(file, entries) {
  const z = await ZipFile.create(file);
  for (const [name, buf] of entries) await z.add(name, buf); // eslint-disable-line no-await-in-loop
  await z.close();
}
const upload = (file, name) => { const p = path.join(TMP, `up-${crypto.randomBytes(4).toString('hex')}`); fs.copyFileSync(file, p); return { path: p, originalname: name, size: fs.statSync(p).size }; };

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  ctx = await makeClinic(`li${tag}@t.test`, 'Legacy clinic');
  other = await makeClinic(`li-other${tag}@t.test`, 'Other clinic');
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await knex.destroy(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('jsonstream: elements with offsets, across chunk sizes, re-read by slice', async () => {
  const f = path.join(TMP, 's.json');
  fs.writeFileSync(f, JSON.stringify({ meta: { a: 1 }, patients: [{ id: 1, n: 'عربي "x"' }, { id: 2 }], treatments: [{ patient_id: 1 }] }));
  for (const chunk of [1, 5, 4096]) { // eslint-disable-line no-restricted-syntax
    const out = [];
    for await (const ev of jsonstream.scan(f, { chunk })) out.push(ev); // eslint-disable-line no-restricted-syntax
    const els = out.filter((e) => e.type === 'element');
    assert.deepEqual(els.map((e) => e.path), ['patients', 'patients', 'treatments']);
    assert.deepEqual(JSON.parse(await jsonstream.readSlice(f, els[0].offset, els[0].length)), { id: 1, n: 'عربي "x"' });
  }
  fs.writeFileSync(f, '{"patients":[{"id":1},');
  await assert.rejects(async () => { for await (const e of jsonstream.scan(f)) void e; }, (e) => e.code === 'JSON_INVALID'); // eslint-disable-line no-restricted-syntax
});

test('files: real type from content, categories', () => {
  assert.equal(files.typeOf('a.png', PNG), 'image/png');
  assert.equal(files.typeOf('a.pdf', PNG), null, 'a PNG named .pdf is refused');
  assert.equal(files.typeOf('a.pdf', PDF), 'application/pdf');
  assert.equal(files.categoryOf('scan.TIF'), 'image');
  assert.equal(files.categoryOf('report.docx'), 'document');
  assert.throws(() => files.abs('../../etc/passwd'));
});

let job;
test('analysis → preview: matching by old id / number, ZIP checks, nothing imported yet', async () => {
  // A patient already here with the old id 1001 (linked before), and one with only the old number of 1002.
  const [p1] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'Somebody else entirely', legacy_source: 'clinica', legacy_patient_id: '1001' });
  const [p2] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'Number match', legacy_patient_number: 'N-1002' });
  // A patient of another clinic with the same old id is never matched.
  await knex('patients').insert({ business_id: other.businessId, full_name: 'Elsewhere', legacy_source: 'clinica', legacy_patient_id: '1003' });
  const json = path.join(TMP, 'clinica-patients-2026.json');
  const data = backup(['1001', '1002', '1003']);
  data.patients.push({ patient_name: 'No id' }); // reported, never imported
  data.patients.push({ ...data.patients[0], patient_name: 'Dup' }); // same id twice → first kept
  data.periodontal = [{ patient_id: '1003', tooth: 21, depth: 5 }]; // a separate top-level clinical list
  fs.writeFileSync(json, JSON.stringify(data, null, 1));

  job = await svc.openJob(ctx);
  assert.equal((await svc.openJob(ctx)).id, job.id, 'one open import per clinic');
  await svc.addUpload(ctx, job.id, upload(json, 'clinica-patients-2026.json'), 'patients_json');
  await svc.settle(ctx.businessId);

  const z1 = path.join(TMP, 'z1.zip');
  const bad = Buffer.from('not really a pdf');
  await zip(z1, [
    ['manifest.json', Buffer.from(JSON.stringify([
      { patient_id: '1001', patient_number: 'N-1001', patient_name: 'x', original_filename: 'xray.png', saved_filename: 'a.png', zip_path: '1001/a.png', source_url: 'https://old.example/f/a', content_type: 'image/png', size: PNG.length, status: 'downloaded', sha256: sha(PNG) },
      { patient_id: '1002', original_filename: 'report.pdf', saved_filename: 'r.pdf', zip_path: '1002/r.pdf', size: PDF.length, status: 'downloaded' },
      { patient_id: '1002', original_filename: 'same-xray.png', saved_filename: 'b.png', zip_path: '1002/b.png', size: PNG.length, status: 'downloaded' },
      { patient_id: '1003', original_filename: 'fake.pdf', saved_filename: 'f.pdf', zip_path: '1003/f.pdf', status: 'downloaded' },
      { patient_id: '1003', original_filename: 'size.png', saved_filename: 's.png', zip_path: '1003/s.png', size: 3, status: 'downloaded' },
      { patient_id: '1003', original_filename: 'gone.png', saved_filename: 'g.png', zip_path: '1003/g.png', status: 'downloaded' },
      { patient_id: '1003', original_filename: 'failed.png', saved_filename: 'n.png', zip_path: '1003/n.png', status: 'failed' },
      { patient_id: '9999', original_filename: 'nobody.png', saved_filename: 'z.png', zip_path: '1001/z.png', status: 'downloaded' },
    ]))],
    ['1001/a.png', PNG], ['1002/r.pdf', PDF], ['1002/b.png', PNG], ['1003/f.pdf', bad], ['1003/s.png', PNG], ['1001/z.png', PNG],
    ['1003/extra.png', PNG],
  ]);
  await svc.addUpload(ctx, job.id, upload(z1, 'clinica-attachments-01-of-03.zip'), 'attachments_zip');
  await svc.addUpload(ctx, job.id, upload(z1, 'copy.zip'), 'attachments_zip'); // the same ZIP again
  const z3 = path.join(TMP, 'z3.zip'); fs.writeFileSync(z3, 'garbage');
  await svc.addUpload(ctx, job.id, upload(z3, 'clinica-attachments-03-of-03.zip'), 'attachments_zip');
  await svc.settle(ctx.businessId);

  const s = await svc.summary(ctx.businessId, job.id);
  assert.equal(s.job.status, 'ready');
  assert.equal(s.patients.detected, 3);
  // The clinic has hand-entered patients → the duplicate check is on: 1001 was imported before (its id is on a patient
  // here), 1002 is a hand-entered patient carrying the old number, 1003 is new.
  assert.equal(s.matchManual, true);
  assert.equal(s.patients.existing, 1); assert.equal(s.patients.matched, 1); assert.equal(s.patients.create, 1);
  assert.equal(s.patients.duplicates, 1); assert.equal(s.patients.missingId, 1); assert.equal(s.patients.review, 1);
  assert.equal(s.patients.withFiles, 3); assert.equal(s.orphanFiles, 0);
  assert.equal((await knex('import_items').where({ job_id: job.id, kind: 'patient', ref: '1001' }).first()).target_id, p1);
  assert.equal((await knex('import_items').where({ job_id: job.id, kind: 'patient', ref: '1002' }).first()).target_id, p2);
  assert.equal(s.treatments, 6); assert.equal(s.clinical, 3 * 3 + 1);
  assert.equal(s.zips.expected, 3); assert.deepEqual(s.zips.missing, [2]); assert.equal(s.zips.duplicates, 1); assert.equal(s.zips.invalid, 1);
  const codes = (await knex('import_errors').where({ job_id: job.id }).pluck('error_code')).sort();
  for (const c of ['MISSING_PATIENT_ID', 'DUPLICATE_PATIENT_ID', 'MIME_MISMATCH', 'SIZE_MISMATCH', 'FILE_MISSING', 'SOURCE_NOT_DOWNLOADED', 'PATIENT_FOLDER_MISMATCH', 'NOT_IN_MANIFEST', 'CORRUPTED_ZIP']) assert.ok(codes.includes(c), c);
  assert.equal(s.files.valid, 4, 'a.png, r.pdf, b.png, extra.png');
  // Nothing written to the clinic's records before START.
  assert.equal(Number((await knex('legacy_patients').where({ business_id: ctx.businessId }).count({ n: '*' }))[0].n), 0);
});

test('import: rows, private files once per SHA-256, unmatched kept apart, reconciliation, idempotent re-run', async () => {
  await svc.start(ctx, job.id);
  await svc.settle(ctx.businessId);
  const j = await svc.getJob(ctx.businessId, job.id);
  assert.equal(j.status, 'completed_with_issues', 'validation errors → not a clean "complete"');
  assert.equal(j.sys_patients, 3); assert.equal(j.sys_treatments, 6); assert.equal(j.sys_clinical, 10);
  const lp = await knex('legacy_patients').where({ business_id: ctx.businessId }).orderBy('legacy_patient_id');
  assert.deepEqual(lp.map((r) => r.legacy_patient_id), ['1001', '1002', '1003']);
  assert.equal(lp[0].old_name, 'مريض 1'); assert.equal(lp[0].old_group, 'Ortho');
  const p3 = await knex('patients').where({ id: lp[2].patient_id }).first();
  assert.equal(p3.full_name, 'مريض 3', '1003 is created as a new patient'); assert.equal(p3.legacy_source, 'clinica'); assert.equal(p3.legacy_patient_id, '1003');
  assert.equal(p3.legacy_patient_number, 'N-1003'); assert.equal(p3.file_number, 'N-1003'); assert.equal(p3.phone, '0790000002'); assert.equal(p3.phone2, '065000000');
  assert.equal((await knex('import_items').where({ job_id: job.id, ref: '1003' }).first()).match, 'new');
  assert.equal((await knex('import_items').where({ job_id: job.id, ref: '1001' }).first()).match, 'existing');
  const p2 = await knex('patients').where({ id: lp[1].patient_id }).first();
  assert.equal(p2.legacy_patient_id, '1002'); assert.equal(p2.full_name, 'Number match', 'the existing patient is not renamed');
  const t = await knex('legacy_treatments').where({ legacy_patient_ref: lp[0].id }).orderBy('position');
  assert.equal(t[0].tooth, '16'); assert.equal(Number(t[0].price), 25); assert.equal(t[1].treatment_on, '2023-06-01'); assert.equal(t[0].referred_by, 'self');
  const per = await knex('legacy_clinical_records').where({ legacy_patient_ref: lp[2].id, table_key: 'periodontal' });
  assert.equal(per.length, 3, 'two in the record + one from the top-level list');
  const vals = await knex('legacy_clinical_values').whereIn('record_id', per.map((r) => r.id));
  assert.ok(vals.some((v) => v.field === 'depth' && v.value === '5'));
  assert.ok(await knex('legacy_field_values').where({ owner_type: 'patient', owner_id: lp[0].id, field: 'blood', value: 'A+' }).first(), 'unknown fields are kept as rows');
  assert.ok(await knex('legacy_patient_links').where({ legacy_patient_ref: lp[0].id, url: 'https://old.example/patients/1001' }).first());

  const atts = await knex('patient_attachments').where({ business_id: ctx.businessId }).orderBy('id');
  assert.equal(atts.length, 4);
  const xray = atts.find((a) => a.original_filename === 'xray.png');
  assert.equal(xray.patient_id, lp[0].patient_id); assert.equal(xray.checksum, sha(PNG)); assert.equal(xray.source_url, 'https://old.example/f/a');
  assert.equal(xray.category, 'image'); assert.equal(xray.mime_type, 'image/png');
  const same = atts.find((a) => a.original_filename === 'same-xray.png');
  assert.equal(same.duplicate_of, xray.id); assert.equal(Number(same.stored_bytes), 0, 'same content stored once');
  assert.ok(!xray.storage_path.includes('public'));
  assert.ok(files.read(xray.storage_path).equals(PNG));
  const extra = atts.find((a) => a.original_filename === 'extra.png');
  assert.equal(extra.patient_id, p3.id, 'tied by the folder (old patient id), not the name'); assert.equal(extra.legacy_patient_id, '1003');

  // Running it all again adds nothing.
  const before = await Promise.all(['legacy_patients', 'legacy_treatments', 'legacy_clinical_records', 'patient_attachments', 'patients'].map((tb) => knex(tb).count({ n: '*' }).then(([r]) => Number(r.n))));
  await knex('import_items').where({ job_id: job.id }).whereIn('status', ['imported', 'duplicate', 'unmatched']).update({ status: 'pending' });
  await knex('import_jobs').where({ id: job.id }).update({ status: 'processing', stage: 'patients_import', heartbeat_at: null });
  await svc.kick(ctx.businessId); await svc.settle(ctx.businessId);
  const after = await Promise.all(['legacy_patients', 'legacy_treatments', 'legacy_clinical_records', 'patient_attachments', 'patients'].map((tb) => knex(tb).count({ n: '*' }).then(([r]) => Number(r.n))));
  assert.deepEqual(after, before);

  // Into the patient's own file: each treatment a treatment-plan item with its doctor (Dr A created, inactive).
  const plan = await knex('dental_plan_items as i').leftJoin('doctors as d', 'd.id', 'i.doctor_id').where({ 'i.business_id': ctx.businessId, 'i.patient_id': p3.id }).orderBy('i.id').select('i.*', 'd.full_name as doctor_name', 'd.is_active', 'd.legacy_source');
  assert.equal(plan.length, 2);
  assert.equal(plan[0].procedure_name, 'حشوة'); assert.equal(plan[0].tooth, 16); assert.equal(Number(plan[0].price), 25); assert.equal(plan[0].status, 'done');
  assert.equal(String(plan[0].done_on instanceof Date ? plan[0].done_on.toISOString() : plan[0].done_on).slice(0, 10), '2023-05-02');
  assert.equal(plan[0].doctor_name, 'Dr A'); assert.equal(plan[0].is_active, 0); assert.equal(plan[0].legacy_source, 'clinica');
  assert.equal(plan[1].status, 'planned'); assert.equal(plan[1].tooth, 11); assert.equal(plan[1].doctor_id, null);
  assert.equal(Number((await knex('doctors').where({ business_id: ctx.businessId, full_name: 'Dr A' }).count({ n: '*' }))[0].n), 1, 'one doctor for all its treatments');
  // Run again (e.g. after the clinic added "Dr. A" itself): nothing doubled.
  const promote = require('../src/modules/legacy/promote.service'); // eslint-disable-line global-require
  await promote.promoteAll(ctx.businessId);
  assert.equal(Number((await knex('dental_plan_items').where({ business_id: ctx.businessId, patient_id: p3.id }).count({ n: '*' }))[0].n), 2);
  const pr = await promote.progress(ctx.businessId);
  assert.equal(pr.done, pr.total - pr.unlinked);

  // A second import of the same file creates nothing: the key (clinica + old id) is already here.
  assert.equal(await svc.createFromLegacy(ctx, lp[2].id), p3.id);

  const r = await svc.report(ctx.businessId, job.id);
  assert.equal(r.reconciliation.find((x) => x.key === 'patients').difference, 0);
  assert.ok(r.errors.length > 0);
});

test('resume: a job stopped half-way (server restart) carries on from the next item', async () => {
  const json = path.join(TMP, 'p2.json');
  const data2 = backup(['2001', '2002', '2003', '2004'], '07811111');
  data2.patients.forEach((x) => { delete x.attachments; }); // no attachment links (no ZIPs either)
  fs.writeFileSync(json, JSON.stringify(data2));
  const j2 = await svc.openJob(ctx);
  assert.notEqual(j2.id, job.id);
  await svc.addUpload(ctx, j2.id, upload(json, 'p2.json'), 'patients_json');
  await svc.settle(ctx.businessId);
  // Started by a process that then stopped (server restart) with one item half-done: its runner still looks alive,
  // so nobody else touches it…
  await knex('import_jobs').where({ id: j2.id }).update({ status: 'processing', stage: 'patients_import', started_at: new Date(), runner: 'gone:1', heartbeat_at: new Date() });
  await knex('import_items').where({ job_id: j2.id, kind: 'patient', ref: '2001' }).update({ status: 'processing' });
  await svc.resumeAll(); await svc.settle(ctx.businessId);
  assert.equal((await svc.getJob(ctx.businessId, j2.id)).status, 'processing', 'a live runner is not taken over');
  assert.equal(Number((await knex('legacy_patients').where({ business_id: ctx.businessId }).whereIn('legacy_patient_id', ['2001', '2002', '2003', '2004']).count({ n: '*' }))[0].n), 0);
  // …until its heartbeat is old: then the next start carries on from the next item.
  await knex('import_jobs').where({ id: j2.id }).update({ heartbeat_at: new Date(Date.now() - 10 * 60_000) });
  await svc.resumeAll(); await svc.settle(ctx.businessId);
  const done = await svc.getJob(ctx.businessId, j2.id);
  assert.equal(done.status, 'completed');
  assert.equal(Number((await knex('legacy_patients').where({ business_id: ctx.businessId }).whereIn('legacy_patient_id', ['2001', '2002', '2003', '2004']).count({ n: '*' }))[0].n), 4);
  const created = await knex('patients').where({ business_id: ctx.businessId }).whereIn('legacy_patient_id', ['2001', '2002', '2003', '2004']);
  assert.equal(created.length, 4, 'one new patient each, never twice');
  assert.ok(!fs.existsSync(svc.jobDir(ctx.businessId, j2.id)), 'uploads removed after a clean import');
});

test('matching: file number here, mobile + first name; two old patients on one patient → both ambiguous', async () => {
  const [byFile] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'مريض كتبه الموظف', file_number: 'N-4001' });
  // The same number given automatically to someone else (another name, another mobile): not a match.
  await knex('patients').insert({ business_id: ctx.businessId, full_name: 'Other person', file_number: 'N-4006', phone: '0799999999' });
  const [byPhone] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'مريض الثاني', phone: '+962 7 8222 2201' });
  const [both] = await knex('patients').insert({ business_id: ctx.businessId, full_name: 'مريض مشترك', file_number: 'N-4003', phone: '0782222203' });
  // Same mobile but another first name: not a match.
  await knex('patients').insert({ business_id: ctx.businessId, full_name: 'Someone', phone: '0782222204' });
  const json = path.join(TMP, 'm.json');
  fs.writeFileSync(json, JSON.stringify(backup(['4001', '4002', '4003', '4004', '4005', '4006'], '07822222')));
  const j = await svc.openJob(ctx);
  await svc.addUpload(ctx, j.id, upload(json, 'm.json'), 'patients_json');
  await svc.settle(ctx.businessId);
  const it = Object.fromEntries((await knex('import_items').where({ job_id: j.id, kind: 'patient' })).map((r) => [r.ref, r]));
  assert.equal(it['4001'].target_id, byFile); assert.equal(it['4001'].match_by, 'file_number');
  assert.equal(it['4002'].target_id, byPhone); assert.equal(it['4002'].match_by, 'phone');
  assert.equal(it['4003'].match_by, 'ambiguous'); assert.equal(it['4004'].match_by, 'ambiguous'); assert.equal(it['4003'].target_id, null);
  assert.equal(it['4005'].match, 'new');
  assert.equal(it['4006'].match, 'new', 'same file number, other person → a new patient, not linked');
  assert.equal(it['4003'].match, 'review');
  const s = await svc.summary(ctx.businessId, j.id);
  assert.equal(s.patients.matched, 2); assert.equal(s.patients.by.ambiguous, 2);
  // A patient numbered by hand afterwards: "match again" picks it up.
  await knex('patients').insert({ business_id: ctx.businessId, full_name: 'مريض متأخر', file_number: 'N-4005' });
  await svc.rematchJob(ctx, j.id);
  assert.equal((await knex('import_items').where({ job_id: j.id, ref: '4005' }).first()).match_by, 'file_number');
  await svc.start(ctx, j.id);
  await svc.settle(ctx.businessId);
  const p1 = await knex('patients').where({ id: byFile }).first();
  assert.equal(p1.legacy_patient_id, '4001'); assert.equal(p1.full_name, 'مريض كتبه الموظف', 'never renamed');
  assert.equal((await knex('patients').where({ id: byPhone }).first()).legacy_patient_id, '4002');
  assert.equal((await knex('patients').where({ id: both }).first()).legacy_patient_id, null, 'ambiguous: left for a person');
  assert.equal((await knex('legacy_patients').where({ business_id: ctx.businessId, legacy_patient_id: '4003' }).first()).patient_id, null);
});

test('initial migration into an empty clinic: every Clinica patient created once; files by patient id; re-run creates nothing', async () => {
  const empty = await makeClinic(`li-empty${tag}@t.test`, 'Empty clinic');
  const ids = ['2432131', '2432132', '2432133'];
  const data = backup(ids, '07955555');
  data.patients[0].patient_number = '1720';
  data.patients[1].mobile = data.patients[2].mobile; // family members share a mobile: both still created
  data.patients[2].patient_name = data.patients[1].patient_name; // even the same name: the key is the Clinica id
  const json = path.join(TMP, 'empty.json'); fs.writeFileSync(json, JSON.stringify(data));
  const z = path.join(TMP, 'empty.zip');
  await zip(z, [['manifest.json', Buffer.from(JSON.stringify(ids.map((id) => ({ patient_id: id, original_filename: `${id}.png`, saved_filename: 'a.png', zip_path: `${id}/a.png`, size: PNG.length, status: 'downloaded' }))))],
    ...ids.map((id) => [`${id}/a.png`, PNG])]);
  const j = await svc.openJob(empty);
  assert.equal(Boolean(j.match_manual), false, 'no hand-entered patients → no matching at all');
  await svc.addUpload(empty, j.id, upload(json, 'clinica-patients.json'), 'patients_json');
  await svc.addUpload(empty, j.id, upload(z, 'clinica-attachments-01-of-01.zip'), 'attachments_zip');
  await svc.settle(empty.businessId);
  const s = await svc.summary(empty.businessId, j.id);
  assert.equal(s.initial, true);
  assert.deepEqual([s.patients.detected, s.patients.create, s.patients.existing, s.patients.duplicates, s.patients.review], [3, 3, 0, 0, 0]);
  assert.equal(s.links, 3); assert.equal(s.patients.withFiles, 3); assert.equal(s.files.valid, 3);
  assert.equal(Number((await knex('patients').where({ business_id: empty.businessId }).count({ n: '*' }))[0].n), 0, 'the preview creates nothing');
  await svc.start(empty, j.id);
  await svc.settle(empty.businessId);
  const done = await svc.getJob(empty.businessId, j.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual([done.sys_patients, done.sys_treatments, done.sys_attachments, done.sys_links], [3, 6, 3, 3]);
  const pats = await knex('patients').where({ business_id: empty.businessId }).orderBy('legacy_patient_id');
  assert.deepEqual(pats.map((p) => p.legacy_patient_id), ids);
  assert.ok(pats.every((p) => p.legacy_source === 'clinica' && p.legacy_import_job_id === j.id));
  assert.equal(pats[0].legacy_patient_number, '1720'); assert.equal(pats[0].file_number, '1720');
  for (const p of pats) { // eslint-disable-line no-restricted-syntax
    const a = await knex('patient_attachments').where({ business_id: empty.businessId, legacy_patient_id: p.legacy_patient_id }).first(); // eslint-disable-line no-await-in-loop
    assert.equal(a.patient_id, p.id, 'each file on the patient of its Clinica id');
  }
  // The unique key: the same Clinica patient cannot be inserted twice.
  await assert.rejects(() => knex('patients').insert({ business_id: empty.businessId, full_name: 'x', legacy_source: 'clinica', legacy_patient_id: ids[0] }), (e) => e.code === 'ER_DUP_ENTRY');
  // Running the import again: a new job sees them as already imported and creates nothing.
  const j2 = await svc.openJob(empty);
  await svc.addUpload(empty, j2.id, upload(json, 'clinica-patients.json'), 'patients_json');
  await svc.settle(empty.businessId);
  const s2 = await svc.summary(empty.businessId, j2.id);
  assert.deepEqual([s2.patients.create, s2.patients.existing], [0, 3]); assert.equal(s2.initial, false);
  await svc.start(empty, j2.id); await svc.settle(empty.businessId);
  assert.equal(Number((await knex('patients').where({ business_id: empty.businessId }).count({ n: '*' }))[0].n), 3);
  assert.equal(Number((await knex('legacy_treatments').where({ business_id: empty.businessId }).count({ n: '*' }))[0].n), 6);
});

test('HTTP: owner runs the Import Center; staff cannot; files only through the authorised download', async () => {
  await staff(ctx.businessId, 'receptionist', `li-rec${tag}@t.test`);
  await staff(ctx.businessId, 'doctor', `li-doc${tag}@t.test`);
  const owner = await signIn(`li${tag}@t.test`);
  let r = await owner.get('/app/import/legacy-clinica?lang=en');
  assert.equal(r.status, 200); assert.match(r.text, /Legacy Patient Recovery/);
  r = await owner.get(`/app/import/legacy-clinica/jobs/${job.id}?lang=en`);
  assert.equal(r.status, 200); assert.match(r.text, /Import Completed With Issues/);
  r = await owner.get(`/app/import/legacy-clinica/jobs/${job.id}/report.csv`);
  assert.equal(r.status, 200); assert.match(r.text, /reconciliation|patients/);
  r = await owner.get(`/app/import/legacy-clinica/jobs/${job.id}/report.json`);
  assert.equal(JSON.parse(r.text).reconciliation.length, 5);
  assert.equal((await owner.get('/admin/import/legacy-clinica')).status, 302);
  // The wizard over HTTP: a new import, the patients file uploaded (multipart, CSRF checked), then cancelled.
  r = await owner.post('/app/import/legacy-clinica/jobs');
  assert.equal(r.status, 302);
  const jobUrl = r.location;
  await owner.get(jobUrl);
  r = await owner.upload(`${jobUrl}/upload`, 'file', Buffer.from(JSON.stringify(backup(['3001']))), 'clinica-patients-x.json');
  assert.equal(r.status, 302);
  const j3 = Number(jobUrl.split('/').pop());
  assert.equal((await knex('import_batches').where({ job_id: j3 }).first()).kind, 'patients_json');
  await svc.settle(ctx.businessId);
  r = await owner.get(`${jobUrl}?lang=en`);
  assert.match(r.text, /START IMPORT/);
  r = await owner.get(`${jobUrl}/status`);
  assert.equal(JSON.parse(r.text).patients.detected, 1);
  r = await owner.post(`${jobUrl}/cancel`);
  assert.equal((await knex('import_jobs').where({ id: j3 }).first()).status, 'cancelled');
  assert.equal((await knex('legacy_patients').where({ business_id: ctx.businessId, legacy_patient_id: '3001' }).first()), undefined, 'nothing imported');

  const lp = await knex('legacy_patients').where({ business_id: ctx.businessId, legacy_patient_id: '1001' }).first();
  const att = await knex('patient_attachments').where({ business_id: ctx.businessId, original_filename: 'xray.png' }).first();
  r = await owner.get(`/app/patients/${lp.patient_id}?lang=en`);
  assert.match(r.text, /data-treatment-plan/); assert.match(r.text, /حشوة/); assert.match(r.text, /Dr A/);
  r = await owner.get(`/app/patients/${lp.patient_id}?tab=orders&lang=en`);
  assert.match(r.text, /data-legacy-files/); assert.match(r.text, /xray\.png/);
  r = await owner.get(`/app/patients/${lp.patient_id}?tab=legacy&lang=en`);
  assert.equal(r.status, 200); assert.match(r.text, /Legacy Records/); assert.match(r.text, /xray\.png/); assert.match(r.text, /حشوة/);
  r = await owner.get(`/api/patients/${lp.patient_id}/attachments/${att.id}/download`);
  assert.equal(r.status, 200); assert.ok(r.buf.equals(PNG)); assert.match(r.headers.get('content-disposition') || '', /attachment/);
  // Search by old id / number.
  r = await owner.get('/app/patients?q=N-1001&lang=en');
  assert.match(r.text, new RegExp(`/app/patients/${lp.patient_id}`));

  const rec = await signIn(`li-rec${tag}@t.test`);
  assert.equal((await rec.get('/app/import/legacy-clinica')).status, 403);
  assert.equal((await rec.get(`/api/patients/${lp.patient_id}/attachments/${att.id}/download`)).status, 403, 'no clinical access');
  const doc = await signIn(`li-doc${tag}@t.test`);
  assert.equal((await doc.get('/app/import/legacy-clinica')).status, 403, 'medical staff view, never import');
  assert.equal((await doc.get(`/api/patients/${lp.patient_id}/attachments/${att.id}/download`)).status, 200);
  // Another clinic's member: not found.
  const oth = await signIn(`li-other${tag}@t.test`);
  assert.equal((await oth.get(`/api/patients/${lp.patient_id}/attachments/${att.id}/download`)).status, 404);
  // Not served from the public folder.
  assert.equal((await client().get(`/uploads/${att.storage_path}`)).status, 404);
});
