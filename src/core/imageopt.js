// Uploaded photos made small and still sharp: PNG / JPEG / WebP are decoded, turned upright (a phone photo's EXIF
// orientation), scaled down to a readable size (2048 px on the long side by default — an A4 scan stays legible) and
// saved as WebP. Everything runs in pure JavaScript and WebAssembly (no native library), so it works on any host.
//   optimize(buffer, { maxSide, quality })  → { buffer, mime: 'image/webp', width, height } | null (kept as is)
//   toPng(buffer)                           → a PNG of a WebP (PDFs cannot embed WebP) | the buffer when already PNG/JPEG
// When anything fails (a damaged file, a picture far too large) the caller simply keeps the original file.
const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_SIDE = 2048;
const MAX_PIXELS = 40e6; // larger pictures are kept as they are (decoding them would need too much memory)

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function kindOf(b) {
  if (!Buffer.isBuffer(b) || b.length < 16) return null;
  if (b.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}
const isImage = (b) => Boolean(kindOf(b));

// ---------------------------------------------------------------- the codecs (WebAssembly: WebP, and mozjpeg to read JPEG; loaded once)
let codec = null;
function webp() {
  if (!codec) {
    codec = (async () => {
      const { simd } = await import('wasm-feature-detect');
      const fast = await simd();
      const [enc, dec, jdec] = await Promise.all([import('@jsquash/webp/encode.js'), import('@jsquash/webp/decode.js'), import('@jsquash/jpeg/decode.js')]);
      const encWasm = fast ? require.resolve('@jsquash/webp/codec/enc/webp_enc_simd.wasm') : require.resolve('@jsquash/webp/codec/enc/webp_enc.wasm');
      const decWasm = require.resolve('@jsquash/webp/codec/dec/webp_dec.wasm');
      await enc.init(await WebAssembly.compile(fs.readFileSync(encWasm)));
      await dec.init(await WebAssembly.compile(fs.readFileSync(decWasm)));
      await jdec.init(await WebAssembly.compile(fs.readFileSync(require.resolve('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'))));
      return { encode: enc.default, decode: dec.default, decodeJpeg: jdec.default };
    })();
    codec.catch(() => { codec = null; });
  }
  return codec;
}

// One picture at a time: decoding a large photo takes memory, and a shared host has little of it.
let chain = Promise.resolve();
const queued = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

// ---------------------------------------------------------------- decoding
/** The EXIF orientation (1–8) of a JPEG, 1 when absent. */
function orientation(b) {
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker === 0xe1 && b.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
      const t = i + 10;
      const le = b.toString('latin1', t, t + 2) === 'II';
      const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
      const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
      const ifd = t + u32(t + 4);
      const n = u16(ifd);
      for (let k = 0; k < n; k += 1) {
        const e = ifd + 2 + k * 12;
        if (e + 12 > b.length) break;
        if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
      }
      return 1;
    }
    if (marker === 0xda) break; // image data starts: no EXIF before it
    i += 2 + len;
  }
  return 1;
}

/** Pixel size from the header (to refuse giant pictures before decoding them). */
function headerSize(b, kind) {
  try {
    if (kind === 'png') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (kind === 'webp') {
      const c = b.toString('latin1', 12, 16);
      if (c === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (c === 'VP8L') { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
      if (c === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i += 1; continue; } // eslint-disable-line no-continue
        const m = b[i + 1];
        if (m === 0xff) { i += 1; continue; } // eslint-disable-line no-continue
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* unreadable */ }
  return null;
}

async function decode(b, kind) {
  if (kind === 'png') {
    const { PNG } = require('pngjs'); // eslint-disable-line global-require
    const p = PNG.sync.read(b);
    return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data.buffer, p.data.byteOffset, p.data.length) };
  }
  const c = await webp();
  if (kind === 'jpeg') return c.decodeJpeg(b, { preserveOrientation: true }); // turned upright by its EXIF tag
  const img = await c.decode(b);
  return { width: img.width, height: img.height, data: img.data };
}

// ---------------------------------------------------------------- scaling down (area average: sharp, no moiré)
// Row by row: each source row is averaged across, then added (by how much of it falls there) to the output row it
// covers — memory stays a couple of rows, not a second copy of the photo.
function shrink(img, maxSide) {
  const { width: w, height: h, data } = img;
  const k = maxSide / Math.max(w, h);
  if (k >= 1) return img;
  const W = Math.max(1, Math.round(w * k)); const H = Math.max(1, Math.round(h * k));
  const sx = w / W; const sy = h / H;
  const alpha = hasAlpha(data); // premultiplied, so transparent edges (a logo) do not turn dark
  const spans = [];
  for (let x = 0; x < W; x += 1) {
    const a = x * sx; const b = Math.min(w, a + sx); const cells = [];
    for (let i = Math.floor(a); i < b; i += 1) cells.push(i, Math.min(i + 1, b) - Math.max(i, a));
    spans.push(cells);
  }
  const row = new Float32Array(W * 4);
  const acc = new Float32Array(W * 4);
  const out = new Uint8ClampedArray(W * H * 4);
  let oy = 0;
  for (let y = 0; y < h && oy < H; y += 1) {
    const base = y * w * 4;
    for (let x = 0; x < W; x += 1) {
      const cells = spans[x]; let r = 0; let g = 0; let bl = 0; let al = 0;
      for (let j = 0; j < cells.length; j += 2) {
        const o = base + cells[j] * 4; const wt = cells[j + 1];
        const m = alpha ? (data[o + 3] / 255) * wt : wt;
        r += data[o] * m; g += data[o + 1] * m; bl += data[o + 2] * m; al += data[o + 3] * wt;
      }
      row[x * 4] = r / sx; row[x * 4 + 1] = g / sx; row[x * 4 + 2] = bl / sx; row[x * 4 + 3] = al / sx;
    }
    let top = y;
    while (top < y + 1 && oy < H) {
      const edge = (oy + 1) * sy;
      const end = Math.min(y + 1, edge);
      const wt = end - top;
      for (let i = 0; i < W * 4; i += 1) acc[i] += row[i] * wt;
      top = end;
      if (end >= edge - 1e-6) {
        const o = oy * W * 4;
        for (let x = 0; x < W; x += 1) {
          const a = acc[x * 4 + 3] / sy;
          const m = alpha ? (a > 0 ? 255 / a : 0) : 1;
          out[o + x * 4] = (acc[x * 4] / sy) * m; out[o + x * 4 + 1] = (acc[x * 4 + 1] / sy) * m; out[o + x * 4 + 2] = (acc[x * 4 + 2] / sy) * m; out[o + x * 4 + 3] = a;
        }
        acc.fill(0); oy += 1;
      }
    }
  }
  if (oy < H) out.copyWithin(oy * W * 4, (oy - 1) * W * 4, oy * W * 4); // a rounding sliver: repeat the last row
  return { width: W, height: H, data: out };
}

const hasAlpha = (d) => { for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true; return false; };

// ---------------------------------------------------------------- the public calls
/**
 * A smaller WebP of an uploaded picture, or null to keep the original (not a picture, already small enough,
 * or it could not be read).
 */
function optimize(buffer, { maxSide = DEFAULT_SIDE, quality = 80 } = {}) {
  const kind = kindOf(buffer);
  if (!kind) return Promise.resolve(null);
  const dim = headerSize(buffer, kind);
  if (!dim || !dim.w || !dim.h || dim.w * dim.h > MAX_PIXELS) return Promise.resolve(null);
  return queued(async () => {
    try {
      const { encode } = await webp();
      const img = shrink(await decode(buffer, kind), maxSide);
      const resized = img.width !== dim.w || img.height !== dim.h;
      // sharp_yuv keeps thin lines and small text crisp; alpha stays exact (logos, stamps).
      let out = Buffer.from(await encode(img, { quality, method: 4, use_sharp_yuv: 1, alpha_quality: 100 }));
      // Graphics (a logo, a screenshot, a scanned page with few colours) are often smaller — and perfect — lossless.
      if (kind === 'png' && img.width * img.height <= 1.5e6) {
        const exact = Buffer.from(await encode(img, { lossless: 1, quality: 75, method: 4, exact: hasAlpha(img.data) ? 0 : 1 }));
        if (exact.length <= out.length * 1.1) out = exact;
      }
      // Never bigger than what was sent (unless it had to be scaled down or turned upright).
      if (!resized && out.length >= buffer.length && (kind === 'webp' || orientation(buffer) === 1)) return null;
      return { buffer: out, mime: 'image/webp', width: img.width, height: img.height, from: kind, before: buffer.length };
    } catch (e) {
      if (process.env.IMAGEOPT_DEBUG) console.error('imageopt:', e); // eslint-disable-line no-console
      return null;
    }
  });
}

// PDFs (pdfkit) take PNG and JPEG only: a WebP picture is turned into a PNG (remembered by its content).
const pngCache = new Map();
async function toPng(buffer) {
  const kind = kindOf(buffer);
  if (kind !== 'webp') return kind ? buffer : null;
  const key = crypto.createHash('sha1').update(buffer).digest('hex');
  if (pngCache.has(key)) return pngCache.get(key);
  try {
    const img = await queued(async () => decode(buffer, 'webp'));
    const { PNG } = require('pngjs'); // eslint-disable-line global-require
    const p = new PNG({ width: img.width, height: img.height });
    Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length).copy(p.data);
    const png = PNG.sync.write(p, { colorType: hasAlpha(img.data) ? 6 : 2 });
    if (pngCache.size > 50) pngCache.delete(pngCache.keys().next().value);
    pngCache.set(key, png);
    return png;
  } catch { return null; }
}

/** A row with { logo, logo_mime }: the logo as PNG/JPEG for a PDF (a WebP logo converted). */
async function pdfLogo(row) {
  if (!row || !row.logo || !/webp/.test(String(row.logo_mime || ''))) return row;
  const png = await toPng(row.logo);
  return { ...row, logo: png, logo_mime: png ? 'image/png' : null };
}

/** Encodes a generated picture end to end (used by `node app.js check-images` on a new host). */
async function selfCheck() {
  try {
    const { PNG } = require('pngjs'); // eslint-disable-line global-require
    const p = new PNG({ width: 3000, height: 2000 });
    for (let i = 0; i < 3000 * 2000; i += 1) { p.data[i * 4] = i % 251; p.data[i * 4 + 1] = (i >> 7) % 253; p.data[i * 4 + 2] = 120; p.data[i * 4 + 3] = 255; }
    const png = PNG.sync.write(p);
    const t = Date.now();
    const r = await optimize(png);
    if (!r || kindOf(r.buffer) !== 'webp') return { ok: false, detail: 'the picture was not converted' };
    const jpg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wEEEAANAA0ADQANAA4ADQAOABAAEAAOABQAFgATABYAFAAeABsAGQAZABsAHgAtACAAIgAgACIAIAAtAEQAKgAyACoAKgAyACoARAA8AEkAOwA3ADsASQA8AGwAVQBLAEsAVQBsAH0AaQBjAGkAfQCXAIcAhwCXAL4AtQC+APkA+QFOEQANAA0ADQANAA4ADQAOABAAEAAOABQAFgATABYAFAAeABsAGQAZABsAHgAtACAAIgAgACIAIAAtAEQAKgAyACoAKgAyACoARAA8AEkAOwA3ADsASQA8AGwAVQBLAEsAVQBsAH0AaQBjAGkAfQCXAIcAhwCXAL4AtQC+APkA+QFO/8IAEQgACAAQAwEiAAIRAQMRAf/EACgAAQEBAAAAAAAAAAAAAAAAAAACAwEBAAAAAAAAAAAAAAAAAAAABf/aAAwDAQACEAMQAAAAwsXS/8QAFxAAAwEAAAAAAAAAAAAAAAAAAAEEYf/aAAgBAQABPwBRYKLD/8QAFxEAAwEAAAAAAAAAAAAAAAAAAAEDUf/aAAgBAgEBPwB2pp//xAAYEQACAwAAAAAAAAAAAAAAAAAAAgQFU//aAAgBAwEBPwBK2Jmf/9k=', 'base64');
    const j = await queued(() => decode(jpg, 'jpeg'));
    if (!j || j.width !== 16 || j.height !== 8) return { ok: false, detail: 'JPEG pictures cannot be read' };
    return { ok: true, detail: `${Math.round(png.length / 1024)} KB PNG → ${Math.round(r.buffer.length / 1024)} KB WebP ${r.width}×${r.height} in ${Date.now() - t} ms` };
  } catch (e) { return { ok: false, detail: e.message }; }
}

module.exports = { optimize, toPng, pdfLogo, isImage, kindOf, selfCheck, DEFAULT_SIDE };
