// The clinic's private file store for imported medical files: content-addressed (one copy per SHA-256, per clinic),
// outside the public folder, readable only through the app's own authenticated download. Also what a file is (its
// real type from its first bytes, not its name) and its category (image | document | other).
//   LEGACY_FILES_DIR (default: <app>/storage/patient-attachments) — on the server's disk, never under /public.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const imageopt = require('../../core/imageopt');

const ROOT = process.env.LEGACY_FILES_DIR || path.join(__dirname, '..', '..', '..', 'storage', 'patient-attachments');
const SHA = /^[a-f0-9]{64}$/;

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'tif', 'webp'];
const DOC_EXT = ['pdf', 'doc', 'docx', 'txt', 'rtf', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'];
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', tiff: 'image/tiff', tif: 'image/tiff', webp: 'image/webp',
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain', rtf: 'application/rtf', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
};
// Types that are shown in the browser (preview); everything else is only downloaded.
const INLINE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'application/pdf']);

const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
const categoryOf = (name) => { const e = extOf(name); return IMAGE_EXT.includes(e) ? 'image' : DOC_EXT.includes(e) ? 'document' : 'other'; };

/** The family of a file from its first bytes: jpeg | png | gif | bmp | tiff | webp | pdf | zip (docx/xlsx/pptx/od*) | ole (doc/xls/ppt) | rtf | text | null. */
function sniff(b) {
  if (!b || b.length < 4) return b && b.length ? 'text' : null;
  const s = (n) => b.subarray(0, n).toString('latin1');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (s(8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (s(4) === 'GIF8') return 'gif';
  if (s(2) === 'BM') return 'bmp';
  if (s(4) === 'II*\x00' || s(4) === 'MM\x00*') return 'tiff';
  if (s(4) === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (s(5) === '%PDF-') return 'pdf';
  if (s(4) === 'PK\x03\x04') return 'zip';
  if (b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole';
  if (s(5) === '{\\rtf') return 'rtf';
  // Text: no NUL byte in the first KB.
  return b.subarray(0, 1024).includes(0) ? null : 'text';
}
// Which families each extension may really be.
const EXPECT = {
  jpg: ['jpeg'], jpeg: ['jpeg'], png: ['png'], gif: ['gif'], bmp: ['bmp'], tiff: ['tiff'], tif: ['tiff'], webp: ['webp'], pdf: ['pdf'],
  docx: ['zip'], xlsx: ['zip'], pptx: ['zip'], odt: ['zip'], ods: ['zip'], odp: ['zip'], doc: ['ole', 'rtf'], xls: ['ole'], ppt: ['ole'],
  rtf: ['rtf', 'text'], txt: ['text'],
};
const SNIFF_MIME = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', tiff: 'image/tiff', webp: 'image/webp', pdf: 'application/pdf', rtf: 'application/rtf', text: 'text/plain' };

/** The type to store for a file: by extension when the content agrees, else by its content; null = they disagree. */
function typeOf(name, buf) {
  const e = extOf(name); const fam = sniff(buf);
  if (EXPECT[e]) return EXPECT[e].includes(fam) ? MIME[e] : null;
  return SNIFF_MIME[fam] || 'application/octet-stream';
}

const rel = (businessId, sha) => path.join(String(Number(businessId)), sha.slice(0, 2), sha);
const abs = (relative) => {
  const p = path.resolve(ROOT, relative);
  if (!p.startsWith(path.resolve(ROOT) + path.sep)) throw new Error('Invalid storage path');
  return p;
};

/** Keeps a file (if its copy is not already kept) → its storage path (relative). */
function put(businessId, sha, buf) {
  if (!SHA.test(sha)) throw new Error('Invalid checksum');
  const r = rel(businessId, sha);
  const p = abs(r);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.${Date.now()}.part`;
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, p); // atomic: a half-written file is never seen as stored
  }
  return r;
}
const exists = (relative) => { try { return fs.statSync(abs(relative)).isFile(); } catch { return false; } };
const stream = (relative) => fs.createReadStream(abs(relative));
const read = (relative) => fs.readFileSync(abs(relative));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/**
 * Keeps a file; a photo (PNG / JPEG / WebP) is kept as a small, sharp WebP (core/imageopt — the same rules as any
 * upload: up to 2048 px on the long side, sharp text and lines). The key stays the original's checksum, so the same
 * file sent again is still recognised (never stored twice). → { path, mime (null = unchanged), bytes }
 */
async function keep(businessId, sha, buf) {
  const o = imageopt.isImage(buf) ? await imageopt.optimize(buf) : null;
  const small = o && o.buffer.length < buf.length ? o.buffer : null;
  return { path: put(businessId, sha, small || buf), mime: small ? 'image/webp' : null, bytes: (small || buf).length };
}
/** A stored photo made small in place (old imports): the new copy replaces the old one atomically. → bytes | null */
async function shrinkStored(relative) {
  const p = abs(relative);
  const buf = fs.readFileSync(p);
  if (!imageopt.isImage(buf)) return null;
  const o = await imageopt.optimize(buf);
  if (!o || o.buffer.length >= buf.length) return null;
  const tmp = `${p}.${process.pid}.${Date.now()}.part`;
  fs.writeFileSync(tmp, o.buffer, { mode: 0o600 });
  fs.renameSync(tmp, p);
  return { before: buf.length, after: o.buffer.length };
}
/** The name to download a file under: a photo kept as WebP gets the .webp ending (the name in the list stays). */
const downloadName = (name, mime) => (mime === 'image/webp' && extOf(name) !== 'webp' ? `${String(name || 'image').replace(/\.[A-Za-z0-9]{1,5}$/, '')}.webp` : name);
/** Removes a stored copy (when no attachment uses it any more). */
function drop(relative) { try { fs.unlinkSync(abs(relative)); } catch { /* gone */ } }

module.exports = { ROOT, IMAGE_EXT, DOC_EXT, MIME, INLINE, extOf, categoryOf, sniff, typeOf, put, keep, shrinkStored, downloadName, exists, stream, read, sha256, drop, abs };
