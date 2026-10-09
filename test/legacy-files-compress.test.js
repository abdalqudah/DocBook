// Photos brought from the old system (Clinica) are kept as small WebP: on arrival (files.keep — the checksum stays
// the original's so the same file is never brought twice), and old ones through Platform → Compress old images
// (rewritten in place; every attachment sharing the copy follows; names and checksums stay). PDFs stay as they are.
process.env.NODE_ENV = 'test';
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lfc-'));
process.env.LEGACY_FILES_DIR = path.join(TMP, 'files');
const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const knex = require('../src/db/knex');
const files = require('../src/modules/legacy/files');
const svc = require('../src/modules/platformops/imagecompress.service');

function photo(w, h) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) p.data.set([(x * 7 + y * 3) % 256, (x * y) % 256, (x ^ y) % 256, 255], (y * w + x) * 4);
  return PNG.sync.write(p);
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let bid;

test.before(async () => {
  await knex.migrate.latest();
  bid = (await knex('businesses').orderBy('id').first('id')).id;
});
test.after(async () => { await knex('patient_attachments').where('legacy_patient_id', 'like', 'lfc-%').del(); await knex.destroy(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('on arrival: a photo is kept as WebP under the original checksum; a PDF as it is', async () => {
  const raw = photo(1400, 1000);
  const sha = files.sha256(raw);
  const k = await files.keep(bid, sha, raw);
  assert.equal(k.mime, 'image/webp');
  assert.ok(k.bytes < raw.length);
  assert.ok(k.path.endsWith(sha), 'still found by the original checksum');
  const stored = files.read(k.path);
  assert.equal(stored.toString('latin1', 8, 12), 'WEBP');
  const p = await files.keep(bid, files.sha256(PDF), PDF);
  assert.equal(p.mime, null); assert.ok(files.read(p.path).equals(PDF));
  assert.equal(files.downloadName('xray.PNG', 'image/webp'), 'xray.webp');
  assert.equal(files.downloadName('report.pdf', 'application/pdf'), 'report.pdf');
});

test('old imports: compressed in place, the shared copy and its duplicate follow, names and checksums stay', async () => {
  const raw = photo(1300, 900);
  const sha = files.sha256(raw);
  const rel = files.put(bid, sha, raw);
  const base = { business_id: bid, legacy_source: 'clinica', original_filename: 'pano.png', stored_filename: 'pano.png', mime_type: 'image/png', category: 'image', file_size: raw.length, storage_path: rel, checksum: sha };
  const [a] = await knex('patient_attachments').insert({ ...base, legacy_patient_id: 'lfc-1', stored_bytes: raw.length });
  const [b] = await knex('patient_attachments').insert({ ...base, legacy_patient_id: 'lfc-2', stored_bytes: 0, duplicate_of: a });
  const [pdf] = await knex('patient_attachments').insert({ ...base, legacy_patient_id: 'lfc-3', original_filename: 'r.pdf', stored_filename: 'r.pdf', mime_type: 'application/pdf', category: 'document', file_size: PDF.length, stored_bytes: PDF.length, storage_path: files.put(bid, files.sha256(PDF), PDF), checksum: files.sha256(PDF) });
  assert.ok((await svc.scan()).find((r) => r.key === 'legacy_files').count >= 1);
  await svc.wait();
  assert.equal(await svc.start({ userId: null }), true);
  await svc.wait();
  const [ra, rb, rp] = await Promise.all([a, b, pdf].map((id) => knex('patient_attachments').where({ id }).first()));
  const now = fs.statSync(files.abs(rel)).size;
  assert.ok(now < raw.length);
  assert.equal(files.read(rel).toString('latin1', 8, 12), 'WEBP');
  for (const r of [ra, rb]) { assert.equal(r.mime_type, 'image/webp'); assert.equal(Number(r.file_size), now); assert.equal(r.original_filename, 'pano.png'); assert.equal(r.checksum, sha); }
  assert.equal(Number(ra.stored_bytes), now); assert.equal(Number(rb.stored_bytes), 0);
  assert.equal(rp.mime_type, 'application/pdf'); assert.ok(files.read(rp.storage_path).equals(PDF), 'PDF untouched');
  // never tried twice
  assert.ok(!(await svc.scan()).find((r) => r.key === 'legacy_files').count);
});
