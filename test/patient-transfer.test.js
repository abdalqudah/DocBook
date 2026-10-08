// Moving / sharing patients between two clinics of one owner (each may have its own database): the whole file goes
// over (visits, notes, prescriptions, files, groups, photo, legacy records and files), the doctor matched by name,
// nothing doubled when done again, "move" leaves a read-only archive (hidden, can be brought back), "share" links
// both files and an update pulls only what is new — in either direction; and only an owner of both clinics may.
process.env.NODE_ENV = 'test';
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-test-'));
process.env.LEGACY_FILES_DIR = path.join(TMP, 'files');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const knex = require('../src/db/knex');
const tenant = require('../src/db/tenant');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const svc = require('../src/modules/patienttransfer/transfer.service');
const files = require('../src/modules/legacy/files');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `ptr-${k}-${tag}@t.test`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkYGD4z8DAwMDAwMDAAAANBAEB8yJyWQAAAABJRU5ErkJggg==', 'base64');
let app; let owner; let K; let A; let O; let ctxK; let docK; let p1; let p2; let p3;
const inK = (fn) => tenant.runFor(K, fn);
const inA = (fn) => tenant.runFor(A, fn);

async function newClinic(userId, name, trx = knex) {
  await businesses.create(userId, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
  const b = await knex('businesses').where({ created_by: userId, name }).orderBy('id', 'desc').first('id');
  await knex('businesses').where({ id: b.id }).update({ onboarding_completed_at: new Date(), media_quota_mb: 500 });
  businesses.forget(b.id);
  return b.id;
}
const ctxOf = async (b, u) => ({ businessId: b, userId: u, permissions: await rbac.getUserPermissions(b, u), ownDoctorId: null, locale: 'ar', today: scheduling.clinicNow('Asia/Amman').date });

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  owner = await knex.transaction((trx) => auth.createUser(trx, { name: 'Dr Owner', email: mail('o'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: owner }).update({ email_verified_at: new Date() });
  K = await newClinic(owner, `عيادة الخالدي ${tag}`);
  A = await newClinic(owner, `عيادة العبدلي ${tag}`);
  await knex('users').where({ id: owner }).update({ last_business_id: K });
  // Another person's clinic (never a destination for this owner).
  const other = await knex.transaction((trx) => auth.createUser(trx, { name: 'Other', email: mail('x'), password: 'Passw0rd!x' }));
  O = await newClinic(other, `عيادة أخرى ${tag}`);
  ctxK = await ctxOf(K, owner);
  const wh = JSON.stringify(scheduling.defaultWorkingHours());
  [docK] = await inK(() => knex('doctors').insert({ business_id: K, full_name: 'د. خالد', is_active: true, working_hours: wh, slot_duration_minutes: 30 }));
  await inA(() => knex('doctors').insert({ business_id: A, full_name: 'د. خالد', is_active: true, working_hours: wh, slot_duration_minutes: 30 }));
  await inK(async () => {
    [p1] = await knex('patients').insert({ business_id: K, full_name: 'سارة أحمد', phone: '0790000001', national_id: '9911', file_number: '7' });
    [p2] = await knex('patients').insert({ business_id: K, full_name: 'محمد علي', phone: '0790000002' });
    [p3] = await knex('patients').insert({ business_id: K, full_name: 'ليلى', phone: '0790000003' });
    const [g] = await knex('patient_groups').insert({ business_id: K, name: 'العبدلي' });
    await knex('patient_group_members').insert([{ business_id: K, patient_id: p1, group_id: g }, { business_id: K, patient_id: p2, group_id: g }]);
    await knex('patient_photos').insert({ business_id: K, patient_id: p1, mime: 'image/png', size: PNG.length, data: PNG });
    const [v] = await knex('appointments').insert({ business_id: K, doctor_id: docK, patient_id: p1, patient_name: 'سارة أحمد', appointment_date: '2026-01-10', appointment_time: '09:00', status: 'completed', appointment_type: 'in_person', source: 'staff' });
    await knex('appointments').insert({ business_id: K, doctor_id: docK, patient_id: p1, patient_name: 'سارة أحمد', appointment_date: '2099-01-01', appointment_time: '09:00', status: 'confirmed', appointment_type: 'in_person', source: 'staff' });
    await knex('consultations').insert({ business_id: K, appointment_id: v, doctor_id: docK, patient_id: p1, patient_name: 'سارة أحمد', diagnosis: 'تسوس' });
    await knex('prescriptions').insert({ business_id: K, appointment_id: v, doctor_id: docK, patient_id: p1, patient_name: 'سارة أحمد', items: JSON.stringify([{ medicationName: 'Amoxicillin' }]) });
    await knex('patient_files').insert({ business_id: K, patient_id: p1, appointment_id: v, category: 'imaging', title: 'xray', name: 'x.png', mime: 'image/png', data: PNG, size: PNG.length, sha256: crypto.createHash('sha256').update(PNG).digest('hex') });
    // A previous system's record and file of p1 (Legacy Patient Recovery).
    const [lp] = await knex('legacy_patients').insert({ business_id: K, patient_id: p1, legacy_source: 'clinica', legacy_patient_id: '501', legacy_patient_number: '1201', old_name: 'سارة' });
    await knex('legacy_treatments').insert({ business_id: K, legacy_patient_ref: lp, patient_id: p1, legacy_patient_id: '501', row_key: 'id:T1', position: 0, description: 'حشوة', tooth: '16' });
    const sha = files.sha256(PNG);
    await knex('patient_attachments').insert({ business_id: K, patient_id: p1, legacy_patient_ref: lp, legacy_source: 'clinica', legacy_patient_id: '501', original_filename: 'old.png', stored_filename: 'a.png', mime_type: 'image/png', category: 'image', file_size: PNG.length, stored_bytes: PNG.length, storage_path: files.put(K, sha, PNG), checksum: sha });
    await knex('patients').where({ id: p1 }).update({ legacy_source: 'clinica', legacy_patient_id: '501' });
  });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); fs.rmSync(TMP, { recursive: true, force: true }); });

let shareId;
test('destinations: only the owner\'s other clinics', async () => {
  const t = await svc.targets(ctxK);
  assert.deepEqual(t.map((b) => b.id), [A]);
  await assert.rejects(() => svc.start(ctxK, { to: O, patientIds: [p1], mode: 'share' }), (e) => e.code === 'TRANSFER_TARGET');
  await assert.rejects(() => svc.start(ctxK, { to: A, patientIds: [], mode: 'share' }), (e) => e.code === 'TRANSFER_EMPTY');
});

test('share: the whole file copied to the other clinic (other database), linked both ways; again adds nothing', async () => {
  shareId = await svc.start(ctxK, { to: A, patientIds: [p1], mode: 'share' });
  await svc.settle();
  const job = await knex('patient_transfers').where({ id: shareId }).first();
  assert.equal(job.status, 'done', JSON.stringify(await svc.items(shareId)));
  const item = (await svc.items(shareId))[0];
  assert.equal(item.future_bookings, 1);
  const q = await inA(async () => {
    const p = await knex('patients').where({ business_id: A, national_id: '9911' }).first();
    return {
      p,
      visits: await knex('appointments').where({ business_id: A, patient_id: p.id }),
      notes: await knex('consultations').where({ business_id: A, patient_id: p.id }),
      rx: await knex('prescriptions').where({ business_id: A, patient_id: p.id }),
      pf: await knex('patient_files').where({ business_id: A, patient_id: p.id }),
      groups: await knex('patient_group_members as m').join('patient_groups as g', 'g.id', 'm.group_id').where({ 'm.patient_id': p.id }).pluck('g.name'),
      photo: await knex('patient_photos').where({ patient_id: p.id }).first(),
      lt: await knex('legacy_treatments').where({ business_id: A, patient_id: p.id }),
      att: await knex('patient_attachments').where({ business_id: A, patient_id: p.id }),
      doc: await knex('doctors').where({ business_id: A }).first('id'),
    };
  });
  assert.equal(q.p.id, item.dst_patient_id);
  assert.equal(q.p.file_number, '7'); assert.equal(q.p.legacy_patient_id, '501');
  assert.equal(q.visits.length, 1, 'the upcoming booking stays where it was booked');
  assert.equal(q.visits[0].doctor_id, q.doc.id, 'doctor matched by name');
  assert.equal(q.notes[0].diagnosis, 'تسوس'); assert.equal(q.rx.length, 1); assert.equal(q.pf.length, 1);
  assert.deepEqual(q.groups, ['العبدلي']); assert.ok(q.photo);
  assert.equal(q.lt[0].description, 'حشوة');
  assert.equal(q.att.length, 1); assert.ok(files.read(q.att[0].storage_path).equals(PNG));
  const links = await svc.linksOf(K, p1);
  assert.equal(links[0].kind, 'shared'); assert.equal(links[0].other_patient_id, q.p.id);
  assert.equal((await svc.linksOf(A, q.p.id))[0].other_patient_id, p1);
  // In the source nothing changes.
  assert.equal((await inK(() => knex('patients').where({ id: p1 }).first())).transferred_at, null);

  // Again: nothing doubled.
  const again = await svc.start(ctxK, { to: A, patientIds: [p1], mode: 'share' });
  await svc.settle();
  assert.equal((await knex('patient_transfers').where({ id: again }).first()).status, 'done');
  const n = await inA(async () => ({ p: (await knex('patients').where({ business_id: A, national_id: '9911' })).length, v: (await knex('appointments').where({ business_id: A, patient_id: q.p.id })).length, f: (await knex('patient_files').where({ business_id: A, patient_id: q.p.id })).length, a: (await knex('patient_attachments').where({ business_id: A, patient_id: q.p.id })).length }));
  assert.deepEqual(n, { p: 1, v: 1, f: 1, a: 1 });

  // A visit added in Abdali, then Khalidi updates from Abdali: only the new visit comes back (not its own ones again).
  await inA(() => knex('appointments').insert({ business_id: A, doctor_id: q.doc.id, patient_id: q.p.id, patient_name: 'سارة أحمد', appointment_date: '2026-02-01', appointment_time: '10:00', status: 'completed', appointment_type: 'in_person', source: 'staff' }));
  await svc.sync(ctxK, { other: A, patientIds: [p1] });
  await svc.settle();
  const back = await inK(() => knex('appointments').where({ business_id: K, patient_id: p1 }).orderBy('appointment_date'));
  assert.deepEqual(back.map((a) => String(a.appointment_date).slice(0, 10)), ['2026-01-10', '2026-02-01', '2099-01-01']);
  assert.equal((await inK(() => knex('patient_files').where({ business_id: K, patient_id: p1 }))).length, 1);
  // And Abdali updating from Khalidi brings nothing new either.
  const ctxA = await ctxOf(A, owner);
  await svc.sync(ctxA, { other: K });
  await svc.settle();
  assert.equal((await inA(() => knex('appointments').where({ business_id: A, patient_id: q.p.id }))).length, 2);
});

test('move: the patient continues in the other clinic; here a hidden archive that can be brought back', async () => {
  const id = await svc.start(ctxK, { to: A, patientIds: [p2, p3], mode: 'move' });
  await svc.settle();
  assert.equal((await knex('patient_transfers').where({ id }).first()).status, 'done');
  const src = await inK(() => knex('patients').whereIn('id', [p2, p3]).orderBy('id'));
  assert.ok(src.every((p) => p.transferred_at && p.transferred_to_business_id === A));
  const dst = await inA(() => knex('patients').where({ business_id: A }).whereIn('phone', ['0790000002', '0790000003']));
  assert.equal(dst.length, 2);
  assert.ok(dst.every((p) => !p.transferred_at));
  assert.equal((await svc.linksOf(K, p2))[0].kind, 'moved_to');
  // Moving it again is refused (it has already moved); bringing it back makes it active and shared.
  await assert.rejects(() => svc.start(ctxK, { to: A, patientIds: [p2], mode: 'move' }), (e) => e.code === 'TRANSFER_EMPTY');
  await inK(() => svc.restore(ctxK, p3));
  assert.equal((await inK(() => knex('patients').where({ id: p3 }).first())).transferred_at, null);
  assert.equal((await svc.linksOf(K, p3))[0].kind, 'shared');
});

test('HTTP: select patients → choose clinic and mode → progress; moved patients hidden; links on the file', async () => {
  const a = app.agent(); await a.login(mail('o'));
  let r = await a.get('/app/patients?lang=en');
  assert.match(r.text, /data-transfer-select/);
  assert.doesNotMatch(r.text, /محمد علي/, 'a moved patient is not in the list');
  r = await a.get(`/app/patients/transfer?ids=${p1}&lang=en`);
  assert.equal(r.status, 200); assert.match(r.text, /سارة أحمد/); assert.match(r.text, new RegExp(`value="${A}"`)); assert.doesNotMatch(r.text, new RegExp(`value="${O}"`));
  r = await a.post('/app/patients/transfer', { _csrf: a.csrf(r.text), ids: String(p1), to: String(A), mode: 'share' });
  assert.equal(r.status, 302);
  await svc.settle();
  r = await a.get(`${r.location}?lang=en`);
  assert.equal(r.status, 200); assert.match(r.text, /سارة أحمد/);
  r = await a.get(`/app/patients/${p2}?lang=en`);
  assert.match(r.text, /data-transfer-moved/);
  r = await a.get(`/app/patients/${p1}?lang=en`);
  assert.match(r.text, /data-transfer-links/);
  // The whole group at once (filter).
  r = await a.get('/app/patients/transfer?all=1&group=' + (await inK(() => knex('patient_groups').where({ business_id: K }).first('id'))).id + '&lang=en');
  assert.match(r.text, /سارة أحمد/);
  // A receptionist cannot.
  const u = await knex.transaction((trx) => auth.createUser(trx, { name: 'Rec', email: mail('r'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: u }).update({ last_business_id: K, email_verified_at: new Date() });
  await knex('memberships').insert({ business_id: K, user_id: u, role_id: (await rbac.getRoleByKey(K, 'receptionist')).id });
  const rec = app.agent(); await rec.login(mail('r'));
  assert.equal((await rec.get(`/app/patients/transfer?ids=${p1}`)).status, 403);
});
