// Uploaded photos are compressed to WebP: scaled to a readable size, turned upright, transparency kept, never bigger
// than what was sent; files that are not pictures pass untouched. Through HTTP: a phone-size clinic logo (over the
// 1 MB limit) is accepted and stored as WebP, a patient's scan becomes WebP, the favicon stays as sent, and PDFs get
// the WebP logo back as PNG.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { PNG } = require('pngjs');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const opt = require('../src/core/imageopt');
const { serve } = require('./_http');

// Compressing a big photo takes the server a few seconds: the test client must not reuse a connection the server
// already closed as idle (Node keeps them alive by default).
require('http').globalAgent = new (require('http').Agent)({ keepAlive: false });

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `img-${k}-${tag}@t.test`;
let app; let bid; let patientId;

function png(w, h, px) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) p.data.set(px(x, y), (y * w + x) * 4);
  return PNG.sync.write(p);
}
// A noisy photo-like picture (compresses like a real photo, not like a flat colour).
const photo = (w, h) => png(w, h, (x, y) => [(x * 7 + y * 3) % 256, (x * y) % 256, (x ^ y) % 256, 255]);
async function jpeg(w, h, orientation = 1) {
  const enc = await import('@jsquash/jpeg/encode.js');
  await enc.init(await WebAssembly.compile(fs.readFileSync(require.resolve('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'))));
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) { d[i * 4] = (i * 13) % 256; d[i * 4 + 1] = (i >> 5) % 256; d[i * 4 + 2] = 90; d[i * 4 + 3] = 255; }
  const out = Buffer.from(await enc.default({ data: d, width: w, height: h }, { quality: 92 }));
  if (orientation === 1) return out;
  // An EXIF block (big-endian TIFF, one entry: Orientation) right after the start marker, as a phone writes it.
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  return Buffer.concat([out.subarray(0, 2), app1, out.subarray(2)]);
}
const dims = async (webp) => { const pngBuf = await opt.toPng(webp); const p = PNG.sync.read(pngBuf); return { w: p.width, h: p.height, data: p.data }; };

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const uid = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: mail('a'), password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Image clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: uid }).update({ email_verified_at: new Date() });
  bid = (await knex('users').where({ id: uid }).first('last_business_id')).last_business_id;
  await knex('businesses').where({ id: bid }).update({ onboarding_completed_at: new Date(), slug: `img-${tag}`.slice(0, 40) });
  [patientId] = await knex('patients').insert({ business_id: bid, full_name: 'Scan Patient', phone: '0791111111' });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('a large photo becomes a much smaller WebP, 2048 px on its long side', async () => {
  const src = photo(3000, 1500);
  const r = await opt.optimize(src);
  assert.ok(r);
  assert.equal(opt.kindOf(r.buffer), 'webp');
  assert.equal(r.mime, 'image/webp');
  assert.deepEqual([r.width, r.height], [2048, 1024]);
  assert.ok(r.buffer.length < src.length / 3, `${src.length} → ${r.buffer.length}`);
  const d = await dims(r.buffer);
  assert.deepEqual([d.w, d.h], [2048, 1024]);
  const small = await opt.optimize(src, { maxSide: 800 });
  assert.deepEqual([small.width, small.height], [800, 400]);
});

test('a phone photo is turned upright by its EXIF orientation', async () => {
  const r = await opt.optimize(await jpeg(400, 200, 6)); // taken sideways: stored 400×200, shown 200×400
  assert.ok(r);
  assert.deepEqual([r.width, r.height], [200, 400]);
  const plain = await opt.optimize(await jpeg(2400, 1200));
  assert.deepEqual([plain.width, plain.height], [2048, 1024]);
});

test('transparency is kept (a logo), and edges do not turn dark when scaled', async () => {
  // Left half transparent, right half solid teal.
  const src = png(2400, 600, (x) => (x < 1200 ? [0, 0, 0, 0] : [10, 130, 120, 255]));
  const r = await opt.optimize(src, { maxSide: 1200 });
  const d = await dims(r.buffer);
  assert.equal(d.w, 1200);
  const at = (x, y) => Array.from(d.data.subarray((y * d.w + x) * 4, (y * d.w + x) * 4 + 4));
  assert.equal(at(100, 100)[3], 0);
  const solid = at(1000, 100);
  assert.equal(solid[3], 255);
  assert.ok(Math.abs(solid[1] - 130) <= 6 && Math.abs(solid[2] - 120) <= 6, `colour kept: ${solid}`);
});

test('not a picture, or already small: kept as sent', async () => {
  assert.equal(await opt.optimize(Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')), null);
  assert.equal(await opt.optimize(Buffer.from('just text, not an image at all')), null);
  const once = await opt.optimize(photo(1200, 800));
  assert.equal(await opt.optimize(once.buffer), null); // a small WebP is not made bigger
  assert.equal(await opt.optimize(Buffer.concat([photo(10, 10).subarray(0, 40), Buffer.alloc(40)])), null); // damaged
});

test('PDFs: a WebP logo is handed over as PNG; PNG and JPEG pass as they are', async () => {
  const r = await opt.optimize(photo(900, 300));
  const back = await opt.toPng(r.buffer);
  assert.equal(opt.kindOf(back), 'png');
  const j = await jpeg(20, 20);
  assert.equal(await opt.toPng(j), j);
  const row = await opt.pdfLogo({ logo: r.buffer, logo_mime: 'image/webp', name: 'x' });
  assert.equal(row.logo_mime, 'image/png');
  assert.equal(opt.kindOf(row.logo), 'png');
  const { Writer } = require('../src/modules/patientdocs/pdf'); // eslint-disable-line global-require
  const w = new Writer({ locale: 'en', title: 'logo' });
  assert.ok(w.image(row.logo, { height: 40 }), 'pdfkit draws it');
  const self = await opt.selfCheck();
  assert.ok(self.ok, self.detail);
});

test('HTTP: a 3 MB logo is accepted and stored as WebP; PDFs and e-mails still get a PNG', async () => {
  const big = photo(2600, 1300);
  const a = app.agent(); await a.login(mail('a'));
  assert.ok(big.length > 1024 * 1024, 'over the 1 MB logo limit');
  const r = await a.upload('/app/settings/appearance', '/app/settings/appearance/logo', {}, { logo: { buffer: big, name: 'logo.png' } });
  assert.equal(r.status, 302);
  const b = await knex('businesses').where({ id: bid }).first('logo', 'logo_mime');
  assert.equal(b.logo_mime, 'image/webp');
  assert.equal(opt.kindOf(b.logo), 'webp');
  assert.ok(b.logo.length < 1024 * 1024);
  assert.ok((await dims(b.logo)).w <= 1200);
  const info = await require('../src/modules/patientdocs/docs.service').clinicInfo(bid); // eslint-disable-line global-require
  assert.equal(opt.kindOf(info.logo), 'png');
  const pub = await a.get(`/img-${tag}`.slice(0, 41) + '/logo?f=png');
  assert.equal(pub.status, 200);
  assert.match(pub.type, /image\/png/);
});

test('HTTP: a patient\'s photo scan becomes WebP; a PDF stays a PDF', async () => {
  const scan = await jpeg(3000, 2000);
  const a = app.agent(); await a.login(mail('a'));
  let r = await a.upload(`/app/patients/${patientId}?tab=orders`, `/app/patients/${patientId}/files`, { category: 'scan', title: 'X-ray' }, { files: { buffer: scan, name: 'xray.jpg' } });
  assert.equal(r.status, 302);
  const f = await knex('patient_files').where({ business_id: bid, patient_id: patientId }).orderBy('id', 'desc').first();
  assert.equal(f.mime, 'image/webp');
  assert.match(f.name, /\.webp$/);
  assert.ok(f.data.length < scan.length);
  assert.equal(f.size, f.data.length);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  r = await a.upload(`/app/patients/${patientId}?tab=orders`, `/app/patients/${patientId}/files`, { category: 'lab_result' }, { files: { buffer: pdf, name: 'cbc.pdf' } });
  const g = await knex('patient_files').where({ business_id: bid, patient_id: patientId }).orderBy('id', 'desc').first();
  assert.equal(g.mime, 'application/pdf');
  assert.ok(g.data.equals(pdf));
  const open = await a.get(`/app/patients/${patientId}/files/${f.id}`);
  assert.equal(open.status, 200);
  assert.match(open.type, /image\/webp/);
});
