// Doctor signatures and the clinic stamp against the test database: who may manage which signature, image
// validation (magic bytes, size, damaged files), audit entries, the stamp placement switches, and the PDFs (the
// signature of the doctor printed on the document only — never another doctor's).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const svc = require('../src/modules/signatures/signatures.service');
const documents = require('../src/modules/patientdocs/documents');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let ctx; let docA; let docB;

/** A small RGBA PNG with a wavy line (what the drawing pad produces). */
function png(w = 200, h = 80) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o + 2] = 90; raw[o + 3] = Math.abs(y - (h / 2 + Math.sin(x / 10) * (h / 4))) < 2 ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const images = (pdf) => (pdf.toString('latin1').match(/\/Subtype \/Image/g) || []).length;
const code = async (p) => { try { await p; return 'OK'; } catch (e) { return e.code; } };
const doctorCtx = (doctorId) => ({ ...ctx, permissions: new Set(['clinical.view', 'clinical.edit', 'prescriptions.create', 'certificates.issue']), ownDoctorId: doctorId, doctorId });

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: `sig${tag}@t.test`, password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'عيادة التواقيع', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  ctx = { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: 'Asia/Amman', ownDoctorId: null, doctorId: null, locale: 'ar' };
  docA = await doctors.saveDoctor(ctx, null, { full_name: 'د. أحمد', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
  docB = await doctors.saveDoctor(ctx, null, { full_name: 'د. باسم', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1' });
});
test.after(async () => { await knex.destroy(); });

test('image validation: PNG/JPEG by magic bytes, size limit, damaged files', async () => {
  assert.deepEqual(await svc.validateImage(png()), { mime: 'image/png', width: 200, height: 80 });
  assert.equal(await code(svc.validateImage(Buffer.alloc(0))), 'IMAGE_MISSING');
  assert.equal(await code(svc.validateImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'))), 'IMAGE_INVALID');
  assert.equal(await code(svc.validateImage(Buffer.from('GIF89a\x10\x00\x10\x00........................'))), 'IMAGE_INVALID');
  assert.equal(await code(svc.validateImage(Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.alloc(40)]))), 'IMAGE_INVALID'); // no WebP in PDFs
  assert.equal(await code(svc.validateImage(Buffer.alloc(svc.MAX_BYTES + 1, 1))), 'IMAGE_TOO_BIG');
  assert.equal(await code(svc.validateImage(png(8, 8))), 'IMAGE_DIMENSIONS');
  const damaged = Buffer.from(png());
  for (let i = 45; i < damaged.length - 20; i += 7) damaged[i] ^= 0x5a; // pixel data changed (bad CRC / inflate)
  assert.equal(await code(svc.validateImage(damaged)), 'IMAGE_INVALID');
  // A PNG header in front of HTML is not an image.
  assert.equal(await code(svc.validateImage(Buffer.concat([png().subarray(0, 33), Buffer.from('<html><script>alert(1)</script></html>')]))), 'IMAGE_INVALID');
  // JPEG: size read from the frame header.
  const jpegHead = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(svc.inspect(jpegHead), { mime: 'image/jpeg', width: 128, height: 64 });
});

test('drawn signatures arrive as PNG data URLs only', () => {
  const b = png();
  assert.ok(svc.fromDataUrl(`data:image/png;base64,${b.toString('base64')}`).equals(b));
  assert.equal(svc.fromDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), null);
  assert.equal(svc.fromDataUrl('javascript:alert(1)'), null);
  assert.equal(svc.fromDataUrl(''), null);
  assert.ok(svc.fromDataUrl(`data:image/png;base64,${'A'.repeat(1500000)}`).length > svc.MAX_BYTES); // reported as too big
});

test('who manages which signature: owner all, a doctor only their own; the stamp is settings.manage only', async () => {
  assert.equal(svc.canManage(ctx, docA), true);
  assert.equal(svc.canManage(ctx, docB), true);
  const a = doctorCtx(docA);
  assert.equal(svc.canManage(a, docA), true);
  assert.equal(svc.canManage(a, docB), false);
  assert.equal(svc.canManage({ ...ctx, permissions: new Set(['prescriptions.create']), doctorId: null }, docA), false); // not linked to a doctor

  assert.equal(await code(svc.saveSignature(a, docA, png(), 'drawn')), 'OK');
  assert.equal(await code(svc.saveSignature(a, docB, png(), 'upload')), 'PERMISSION_DENIED');
  assert.equal(await code(svc.saveStamp(a, png(120, 120))), 'PERMISSION_DENIED');
  assert.equal(await code(svc.saveStampPlaces(a, { invoices: '1' })), 'PERMISSION_DENIED');
  assert.equal(await code(svc.saveSignature(ctx, 999999, png())), 'NOT_FOUND'); // a doctor of another clinic / unknown
  assert.deepEqual((await svc.doctorsFor(a)).map((d) => d.id), [docA]);
  assert.deepEqual((await svc.doctorsFor(ctx)).map((d) => d.id).sort(), [docA, docB].sort());

  // Owner adds B, the doctor cannot remove it; replacing and removing are audited.
  assert.equal(await code(svc.saveSignature(ctx, docB, png(240, 90), 'upload')), 'OK');
  assert.equal(await code(svc.removeSignature(a, docB)), 'PERMISSION_DENIED');
  assert.deepEqual(await svc.saveSignature(a, docA, png(260, 100), 'upload'), { replaced: true });
  await svc.removeSignature(ctx, docB);
  assert.equal(await code(svc.removeSignature(ctx, docB)), 'NOT_FOUND');
  const actions = (await knex('audit_logs').where({ business_id: ctx.businessId }).where('action', 'like', 'signature.%').orderBy('id').select('action', 'entity_id', 'user_id'))
    .map((r) => `${r.action}:${r.entity_id}`);
  assert.deepEqual(actions, [`signature.added:${docA}`, `signature.added:${docB}`, `signature.replaced:${docA}`, `signature.removed:${docB}`]);
  const row = await knex('doctor_signatures').where({ business_id: ctx.businessId, doctor_id: docA }).first('version', 'source');
  assert.deepEqual({ ...row }, { version: 2, source: 'upload' });
});

test('stamp: upload, placement switches, removal (audited)', async () => {
  assert.equal((await svc.stamp(ctx.businessId)).on_invoices, false); // defaults before anything is saved
  await svc.saveStamp(ctx, png(150, 150));
  let m = await svc.forDocument(ctx.businessId, 'invoices', null);
  assert.equal(m.stamp, null); // invoices are off by default
  await svc.saveStampPlaces(ctx, { prescriptions: '1', invoices: '1' });
  m = await svc.forDocument(ctx.businessId, 'invoices', null);
  assert.ok(m.stamp && m.signature === null);
  assert.equal((await svc.forDocument(ctx.businessId, 'certificates', docA)).stamp, null); // switched off
  assert.ok((await svc.forDocument(ctx.businessId, 'prescriptions', docA)).stamp);
  const actions = await knex('audit_logs').where({ business_id: ctx.businessId }).where('action', 'like', 'stamp.%').pluck('action');
  assert.deepEqual(actions, ['stamp.added', 'stamp.placement_updated']);
});

test('PDFs embed the signature of the document\'s doctor only (and still render Arabic)', async () => {
  const clinic = { id: ctx.businessId, name: 'عيادة التواقيع', name_en: 'Signatures Clinic' };
  const base = { clinic, doctor_name: 'د. أحمد', patient_name: 'محمد عبد الله', age: 30, gender: 'male', visit_date: '2026-09-30', appointment_id: 1 };
  const rx = (doctorId) => ({ id: 5, created_at: '2026-09-30', diagnosis: 'التهاب اللوزتين', items: [{ medicationName: 'Amoxicillin 500mg', dosage: 'حبة', frequency: '3 مرات يومياً', duration: '7 أيام' }], doctor_id: doctorId });

  await svc.saveStampPlaces(ctx, {}); // stamp off everywhere: only signatures count below
  const withSig = await documents.prescription({ ...base, a: { doctor_id: docA }, rx: rx(docA) }, 'ar');
  assert.equal(withSig.subarray(0, 5).toString(), '%PDF-');
  assert.ok(images(withSig) >= 1, 'signature image embedded');
  assert.ok(withSig.toString('latin1').includes('NotoNaskhArabic'), 'Arabic font embedded');
  const en = await documents.prescription({ ...base, a: { doctor_id: docA }, rx: rx(docA) }, 'en');
  assert.ok(images(en) >= 1);

  // A prescription written by another doctor than the visit's: no signature at all.
  assert.equal(images(await documents.prescription({ ...base, a: { doctor_id: docA }, rx: rx(docB) }, 'ar')), 0);
  // Doctor B has no signature (removed above): nothing borrowed from doctor A.
  assert.equal(images(await documents.report({ ...base, a: { doctor_id: docB }, consult: { diagnosis: 'x' }, sections: ['diagnosis'] }, 'ar')), 0);
  assert.ok(images(await documents.report({ ...base, a: { doctor_id: docA }, consult: { diagnosis: 'x' }, sections: ['diagnosis'] }, 'ar')) >= 1);

  // Certificates: the issuing doctor's signature and the stamp; none on a revoked certificate. QR still there.
  await svc.saveStampPlaces(ctx, { certificates: '1' });
  const cert = { doc_type: 'sick_leave', language: 'ar', serial: 'SL-2026-000001', issued_at: new Date(), patient_name: 'محمد', doctor_name: 'د. أحمد', doctor_id: docA, visit_date: '2026-09-30', leave_start: '2026-09-30', leave_end: '2026-10-01', leave_days: 2, body: {} };
  const otherDoctor = images(await documents.certificate({ clinic, cert: { ...cert, doctor_id: docB }, verifyUrl: 'https://example.test/verify/ABCD' }, 'ar'));
  const signed = images(await documents.certificate({ clinic, cert, verifyUrl: 'https://example.test/verify/ABCD' }, 'ar'));
  const revoked = images(await documents.certificate({ clinic, cert: { ...cert, revoked_at: new Date() }, verifyUrl: 'https://example.test/verify/ABCD' }, 'ar'));
  const bare = images(await documents.certificate({ clinic, cert, marks: null, verifyUrl: 'https://example.test/verify/ABCD' }, 'ar'));
  assert.ok(bare >= 1, 'QR code kept');
  assert.equal(revoked, bare, 'a revoked certificate keeps only its QR code');
  assert.ok(otherDoctor > revoked, 'stamp without a signature for a doctor who has none');
  assert.ok(signed > otherDoctor, 'the issuing doctor\'s signature is added');
});
