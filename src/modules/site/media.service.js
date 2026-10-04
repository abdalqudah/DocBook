// Landing-page media library: images the platform admin uploads for the website sections, the share
// (Open Graph) image and card pictures. Files are checked by their content, not their name or the
// browser's type: only PNG, JPEG and WebP are accepted (never SVG, which can carry scripts).
// Stored in the database (site_media.data, MEDIUMBLOB) and served from /assets/media/<id>/<sha>
// with nosniff and long caching (the content hash is part of the address).
const crypto = require('crypto');
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');

const MAX_BYTES = 5 * 1024 * 1024;
const MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Real type from the first bytes of the file (null for anything else). */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Pixel size read from the file header (null when it cannot be read). */
function dimensions(buf, mime) {
  try {
    if (mime === 'image/png' && buf.toString('ascii', 12, 16) === 'IHDR') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/webp') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; } // eslint-disable-line no-continue
        const marker = buf[i + 1];
        if (marker === 0xff) { i += 1; continue; } // eslint-disable-line no-continue
        const len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch { /* unreadable header: size stays unknown */ }
  return null;
}

const cleanName = (n, fallback) => String(n || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\u0000-\u001f<>"`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || fallback;

async function upload(ctx, raw, name) {
  if (!Buffer.isBuffer(raw) || !raw.length) throw E.validation({ file: 'growth_err.file_required' });
  const small = await require('../../core/imageopt').optimize(raw); // eslint-disable-line global-require
  const buf = small ? small.buffer : raw; // photos → small WebP
  if (buf.length > MAX_BYTES) throw E.validation({ file: 'growth_err.file_too_big' });
  const mime = sniff(buf);
  if (!mime) throw E.validation({ file: 'growth_err.file_type' });
  const dim = dimensions(buf, mime) || {};
  const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const [id] = await knex('site_media').insert({
    name: cleanName(name, `image-${sha.slice(0, 6)}`), mime, size: buf.length, width: dim.width || null, height: dim.height || null,
    sha, data: buf, created_by: ctx.userId || null,
  });
  cache.forgetPrefix('site:');
  await audit.record({ ...ctx, businessId: null }, 'platform.site_media_uploaded', { entityType: 'site_media', entityId: id, newValues: { mime, size: buf.length } });
  return id;
}

/** Everything except the bytes, newest first. */
const list = () => knex('site_media').orderBy('id', 'desc').select('id', 'name', 'mime', 'size', 'width', 'height', 'sha', 'created_at');

const urlOf = (m) => `/assets/media/${m.id}/${m.sha}.${EXT[m.mime] || 'img'}`;

/** id → { id, name, url, width, height } for the pages (cached for a minute). */
async function map() {
  return cache.remember('site:media', async () => {
    const rows = await knex('site_media').select('id', 'name', 'mime', 'sha', 'width', 'height');
    return Object.fromEntries(rows.map((m) => [String(m.id), { id: m.id, name: m.name, url: urlOf(m), mime: m.mime, width: m.width, height: m.height }]));
  }, 60_000);
}

async function rename(ctx, id, name) {
  const m = await knex('site_media').where({ id: Number(id) || 0 }).first('id', 'name');
  if (!m) throw E.notFound('File');
  const next = cleanName(name, m.name);
  if (next === m.name) return;
  await knex('site_media').where({ id: m.id }).update({ name: next });
  cache.forgetPrefix('site:');
  await audit.record({ ...ctx, businessId: null }, 'platform.site_media_renamed', { entityType: 'site_media', entityId: m.id, oldValues: { name: m.name }, newValues: { name: next } });
}

async function remove(ctx, id) {
  const m = await knex('site_media').where({ id: Number(id) || 0 }).first('id', 'name', 'size');
  if (!m) throw E.notFound('File');
  await knex('site_media').where({ id: m.id }).del();
  cache.forgetPrefix('site:');
  await audit.record({ ...ctx, businessId: null }, 'platform.site_media_deleted', { entityType: 'site_media', entityId: m.id, oldValues: { name: m.name, size: m.size } });
}

/** The stored file when the address matches (id + content hash). */
async function file(id, sha) {
  if (!/^\d{1,10}$/.test(String(id)) || !/^[a-f0-9]{16}$/.test(String(sha))) return null;
  return (await knex('site_media').where({ id: Number(id), sha }).first('mime', 'data', 'size', 'sha', 'name')) || null;
}

module.exports = { MAX_BYTES, MIMES, sniff, dimensions, upload, list, map, rename, remove, file, urlOf };
