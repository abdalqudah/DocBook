// Media library: public images for the website (pages, articles, universities, events …). Images are uploaded once,
// checked by content, given alt texts, and referenced by their /media/:id address. The importer copies images that
// content still loads from other sites (e.g. the original site's stock photos) into the library, so visitors' browsers
// no longer contact third-party image hosts.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const uploads = require('../../core/uploads');
const { E } = require('../../core/errors');

/** Every content column that holds an image address. */
const IMAGE_COLUMNS = [
  ['destinations', 'hero_image'], ['universities', 'logo'], ['universities', 'cover_image'], ['events', 'image'], ['courses', 'image'],
  ['articles', 'image'], ['articles', 'og_image'], ['pages', 'hero_image'], ['pages', 'og_image'], ['services', 'og_image'], ['testimonials', 'avatar'],
];
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

const urlOf = (id) => `/media/${id}`;

/** Width and height from the image header (PNG, JPEG, GIF, WebP); null when unknown. */
function dimensions(buf) {
  try {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; } // eslint-disable-line no-continue
        const marker = buf[i + 1];
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* unreadable header */ }
  return { width: null, height: null };
}

async function list({ q, page = 1, per = 48 } = {}) {
  const base = knex('media').where({ purpose: 'cms', is_public: true });
  if (q) { const like = `%${String(q).replace(/[%_\\]/g, (m) => `\\${m}`)}%`; base.where((w) => w.where('original_name', 'like', like).orWhere('alt_en', 'like', like).orWhere('alt_ar', 'like', like)); }
  const [{ n }] = await base.clone().count({ n: '*' });
  const rows = await base.orderBy('id', 'desc').limit(per).offset((Math.max(1, page) - 1) * per);
  return { rows: rows.map((m) => ({ ...m, url: urlOf(m.id) })), total: Number(n), page: Math.max(1, page), pages: Math.max(1, Math.ceil(Number(n) / per)) };
}

async function get(id) {
  const m = await knex('media').where({ id, purpose: 'cms' }).first();
  if (!m) throw E.notFound('Image');
  return { ...m, url: urlOf(m.id) };
}

async function upload(ctx, file, { alt_en: altEn = null, alt_ar: altAr = null, sourceUrl = null } = {}) {
  const id = await uploads.store(file, { purpose: 'cms', allowed: uploads.IMAGES, isPublic: true, userId: ctx.userId || null });
  const dim = dimensions(file.buffer);
  await knex('media').where({ id }).update({ alt_en: altEn || null, alt_ar: altAr || null, source_url: sourceUrl, ...dim });
  await audit.record(ctx, 'media.uploaded', { entityType: 'media', entityId: id, newValues: { name: file.originalname, source: sourceUrl } });
  return id;
}

async function updateAlt(ctx, id, { alt_en: altEn, alt_ar: altAr }) {
  await get(id);
  await knex('media').where({ id }).update({ alt_en: altEn ? String(altEn).slice(0, 255) : null, alt_ar: altAr ? String(altAr).slice(0, 255) : null });
  await audit.record(ctx, 'media.updated', { entityType: 'media', entityId: id });
}

/** Where an image is used: [{ table, column, id }]. Also counts the branding logos. */
async function usage(id) {
  const url = urlOf(id);
  const out = [];
  for (const [table, column] of IMAGE_COLUMNS) {
    if (!(await knex.schema.hasColumn(table, column))) continue; // eslint-disable-line no-await-in-loop, no-continue
    const rows = await knex(table).where(column, url).orWhere(column, 'like', `%${url}`).select('id'); // eslint-disable-line no-await-in-loop
    rows.forEach((r) => out.push({ table, column, id: r.id }));
  }
  const branding = await knex('settings').where({ key: 'branding' }).first('value');
  if (branding && new RegExp(`"[a-z_]*media_id"\\s*:\\s*"?${id}"?[,}]`).test(typeof branding.value === 'string' ? branding.value : JSON.stringify(branding.value))) out.push({ table: 'settings', column: 'branding', id: 0 });
  return out;
}

async function remove(ctx, id) {
  const m = await get(id);
  const used = await usage(id);
  if (used.length) throw E.conflict('MEDIA_IN_USE', `This image is used in ${used.length} place(s). Replace it there first.`);
  await uploads.remove(m.id);
  await audit.record(ctx, 'media.deleted', { entityType: 'media', entityId: id, oldValues: { name: m.original_name } });
}

/** Content rows still loading images from other sites: [{ table, column, id, url }]. */
async function externalImages() {
  const out = [];
  for (const [table, column] of IMAGE_COLUMNS) {
    if (!(await knex.schema.hasColumn(table, column))) continue; // eslint-disable-line no-await-in-loop, no-continue
    const rows = await knex(table).where(column, 'like', 'http%').select('id', `${column} as url`); // eslint-disable-line no-await-in-loop
    rows.forEach((r) => out.push({ table, column, id: r.id, url: r.url }));
  }
  return out;
}

/** Downloads an image over https with a size cap; returns { buffer, name } or throws. */
async function download(url, { fetchImpl = fetch } = {}) {
  if (!/^https:\/\//i.test(url)) throw new Error('Only https:// images are imported.');
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { Accept: 'image/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_IMPORT_BYTES) throw new Error('Image is larger than 8 MB.');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_IMPORT_BYTES) throw new Error('Image is larger than 8 MB.');
  const type = (res.headers.get('content-type') || '').split(';')[0];
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[type] || 'jpg';
  const name = `${(new URL(url).pathname.split('/').pop() || 'image').replace(/\.[a-z0-9]+$/i, '').slice(0, 80)}.${ext}`;
  return { buffer, name };
}

/**
 * Copies every external image into the library and points the content at the copy. The same address is downloaded
 * once. Returns { imported, rows, failed: [{ url, error }] } — failures leave the content unchanged.
 */
async function importExternal(ctx, { fetchImpl = fetch, limit = 200 } = {}) {
  const items = (await externalImages()).slice(0, limit * 4);
  const byUrl = new Map();
  items.forEach((it) => { if (!byUrl.has(it.url)) byUrl.set(it.url, []); byUrl.get(it.url).push(it); });
  const result = { imported: 0, rows: 0, failed: [] };
  for (const [url, uses] of [...byUrl.entries()].slice(0, limit)) {
    try {
      const existing = await knex('media').where({ purpose: 'cms', source_url: url.slice(0, 500) }).first('id'); // eslint-disable-line no-await-in-loop
      let id = existing && existing.id;
      if (!id) {
        const { buffer, name } = await download(url, { fetchImpl }); // eslint-disable-line no-await-in-loop
        id = await upload(ctx, { buffer, size: buffer.length, originalname: name }, { sourceUrl: url.slice(0, 500) }); // eslint-disable-line no-await-in-loop
        result.imported += 1;
      }
      for (const u of uses) { await knex(u.table).where({ id: u.id, [u.column]: url }).update({ [u.column]: urlOf(id) }); result.rows += 1; } // eslint-disable-line no-await-in-loop
    } catch (e) {
      result.failed.push({ url, error: e.message });
    }
  }
  await audit.record(ctx, 'media.imported', { entityType: 'media', entityId: null, newValues: { imported: result.imported, rows: result.rows, failed: result.failed.length } });
  return result;
}

module.exports = { list, get, upload, updateAlt, usage, remove, externalImages, importExternal, download, dimensions, IMAGE_COLUMNS, urlOf };
