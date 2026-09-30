// Doctor signatures and the clinic stamp.
//  • Images are PNG or JPEG only (checked by their first bytes, their size and by embedding them in a throwaway
//    PDF), because the PDFs embed them as they are — a drawn signature arrives as a PNG from the canvas.
//  • Who manages which signature: owner / manager (settings.manage) every doctor of the clinic; a doctor login
//    only the doctor it is linked to (memberships.doctor_id). The stamp: settings.manage only.
//  • A document shows the signature of the doctor printed on it and nobody else's (see forDocument).
const zlib = require('zlib');
const PDFDocument = require('pdfkit');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');

const MAX_BYTES = 1024 * 1024;
const MIN_SIDE = 16;
const MAX_SIDE = 4000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Document kinds and the stamp column that switches the stamp on for them. */
const PLACES = { prescriptions: 'on_prescriptions', reports: 'on_reports', certificates: 'on_certificates', invoices: 'on_invoices' };

const err = (code, message) => new AppError(code, message, 422);

/** Type and pixel size of a PNG or JPEG from its bytes; null for anything else. */
function inspect(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf.subarray(0, 8).equals(PNG_MAGIC)) {
    if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; } // eslint-disable-line no-continue
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; } // eslint-disable-line no-continue
      const len = buf.readUInt16BE(i + 2);
      // Start-of-frame markers (baseline, progressive …) carry the size; C4/C8/CC are other tables.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: 'image/jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/**
 * Walks a PNG's chunks (checking each CRC) and inflates its pixel data, so that a damaged file is refused here and
 * never reaches pdfkit (whose PNG decoder fails asynchronously). Non-interlaced, 8-bit (or palette) images only.
 */
function pngIntact(buf) {
  try {
    const w = buf.readUInt32BE(16); const h = buf.readUInt32BE(20);
    const depth = buf[24]; const type = buf[25]; const interlace = buf[28];
    if (!CHANNELS[type] || interlace !== 0 || (type === 3 ? ![1, 2, 4, 8].includes(depth) : depth !== 8)) return false;
    const idat = [];
    let i = 8; let ended = false;
    while (i + 12 <= buf.length) {
      const len = buf.readUInt32BE(i);
      const kind = buf.subarray(i + 4, i + 8).toString('latin1');
      if (i + 12 + len > buf.length) return false;
      if ((zlib.crc32(buf.subarray(i + 4, i + 8 + len)) >>> 0) !== buf.readUInt32BE(i + 8 + len)) return false;
      if (kind === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
      i += 12 + len;
      if (kind === 'IEND') { ended = true; break; }
    }
    if (!ended || !idat.length) return false;
    const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: 64 * 1024 * 1024 });
    return raw.length === h * (1 + Math.ceil((w * CHANNELS[type] * depth) / 8));
  } catch { return false; }
}

/** Embeds the image in a throwaway PDF: resolves when pdfkit can use it, rejects otherwise. */
function tryEmbed(buf) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(new Error('timeout')), 5000);
    const finish = (e) => { if (done) return; done = true; clearTimeout(timer); if (e) reject(e); else resolve(); };
    try {
      const doc = new PDFDocument({ size: [60, 60], margin: 0 });
      doc.on('data', () => {});
      doc.on('end', () => finish());
      doc.on('error', finish);
      doc.image(buf, 0, 0, { width: 40 });
      doc.end();
    } catch (e) { finish(e); }
  });
}

/**
 * Checks an uploaded or drawn image. Throws IMAGE_TOO_BIG / IMAGE_INVALID / IMAGE_MISSING.
 * @returns {{ mime, width, height }}
 */
async function validateImage(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw err('IMAGE_MISSING', 'Choose an image.');
  if (buf.length > MAX_BYTES) throw err('IMAGE_TOO_BIG', 'The image is larger than 1 MB.');
  const info = inspect(buf);
  if (!info) throw err('IMAGE_INVALID', 'Use a PNG or JPEG image.');
  if (info.width < MIN_SIDE || info.height < MIN_SIDE || info.width > MAX_SIDE || info.height > MAX_SIDE) throw err('IMAGE_DIMENSIONS', 'The image size is not suitable.');
  if (info.mime === 'image/png' && !pngIntact(buf)) throw err('IMAGE_INVALID', 'Use a PNG or JPEG image.');
  try { await tryEmbed(buf); } catch { throw err('IMAGE_INVALID', 'Use a PNG or JPEG image.'); }
  return info;
}

/** The PNG inside a canvas data URL ("data:image/png;base64,…"); null when it is not one. */
function fromDataUrl(value) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(value || '').trim());
  if (!m) return null;
  if (m[1].length > Math.ceil(MAX_BYTES / 3) * 4 + 16) return Buffer.alloc(MAX_BYTES + 1); // reported as too big
  return Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
}

// ---------------------------------------------------------------- permissions
const managesAll = (ctx) => Boolean(ctx.permissions && ctx.permissions.has('settings.manage'));
/** Whether this login may add / replace / remove the signature of that doctor. */
function canManage(ctx, doctorId) {
  if (managesAll(ctx)) return true;
  return Boolean(ctx.doctorId) && Number(ctx.doctorId) === Number(doctorId);
}

// ---------------------------------------------------------------- signatures
const META = ['s.doctor_id', 's.mime', 's.source', 's.width', 's.height', 's.version', 's.updated_at', 's.updated_by'];

/** Doctors this login may manage, each with its signature (without the image bytes) or null. */
async function doctorsFor(ctx) {
  const q = knex('doctors as d').leftJoin('doctor_signatures as s', function on() { this.on('s.doctor_id', 'd.id').andOn('s.business_id', 'd.business_id'); })
    .leftJoin('users as u', 'u.id', 's.updated_by')
    .where('d.business_id', ctx.businessId)
    .orderBy([{ column: 'd.is_active', order: 'desc' }, { column: 'd.sort_order' }, { column: 'd.full_name' }])
    .select('d.id', 'd.full_name', 'd.full_name_en', 'd.specialization', 'd.specialization_en', 'd.color', 'd.is_active', ...META, 'u.name as updated_by_name');
  if (!managesAll(ctx)) {
    if (!ctx.doctorId) return [];
    q.where('d.id', ctx.doctorId);
  }
  const rows = await q;
  return rows.map((r) => ({
    id: r.id, full_name: r.full_name, full_name_en: r.full_name_en, specialization: r.specialization, specialization_en: r.specialization_en, color: r.color, is_active: Boolean(r.is_active),
    signature: r.mime ? { mime: r.mime, source: r.source, width: r.width, height: r.height, version: r.version, updated_at: r.updated_at, updated_by_name: r.updated_by_name } : null,
  }));
}

async function doctorOf(ctx, doctorId) {
  const d = await knex('doctors').where({ id: Number(doctorId) || 0, business_id: ctx.businessId }).first('id', 'full_name');
  if (!d) throw E.notFound('Doctor');
  return d;
}

const signatureMeta = (businessId, doctorId) => knex('doctor_signatures').where({ business_id: businessId, doctor_id: doctorId }).first('id', 'mime', 'source', 'version', 'updated_at');

/** Adds or replaces a doctor's signature. source: 'upload' | 'drawn'. */
async function saveSignature(ctx, doctorId, buf, source = 'upload') {
  const d = await doctorOf(ctx, doctorId);
  if (!canManage(ctx, d.id)) throw E.forbidden('settings.manage');
  const info = await validateImage(buf);
  const kind = source === 'drawn' ? 'drawn' : 'upload';
  const before = await signatureMeta(ctx.businessId, d.id);
  await knex.transaction(async (trx) => {
    if (before) {
      await trx('doctor_signatures').where({ id: before.id }).update({ image: buf, mime: info.mime, source: kind, width: info.width, height: info.height, version: before.version + 1, updated_by: ctx.userId || null, updated_at: new Date() });
    } else {
      await trx('doctor_signatures').insert({ business_id: ctx.businessId, doctor_id: d.id, image: buf, mime: info.mime, source: kind, width: info.width, height: info.height, version: 1, updated_by: ctx.userId || null });
    }
    await audit.record(ctx, before ? 'signature.replaced' : 'signature.added', {
      entityType: 'doctor', entityId: d.id,
      oldValues: before ? { source: before.source, version: before.version } : null,
      newValues: { doctor: d.full_name, source: kind, mime: info.mime, size: `${info.width}x${info.height}`, bytes: buf.length },
    }, trx);
  });
  return { replaced: Boolean(before) };
}

async function removeSignature(ctx, doctorId) {
  const d = await doctorOf(ctx, doctorId);
  if (!canManage(ctx, d.id)) throw E.forbidden('settings.manage');
  const before = await signatureMeta(ctx.businessId, d.id);
  if (!before) throw E.notFound('Signature');
  await knex.transaction(async (trx) => {
    await trx('doctor_signatures').where({ id: before.id }).del();
    await audit.record(ctx, 'signature.removed', { entityType: 'doctor', entityId: d.id, oldValues: { doctor: d.full_name, source: before.source, version: before.version } }, trx);
  });
}

/** The image of a doctor's signature ({ image, mime, version }) or null. */
const signatureImage = (businessId, doctorId) => (doctorId
  ? knex('doctor_signatures').where({ business_id: businessId, doctor_id: doctorId }).first('image', 'mime', 'version')
  : Promise.resolve(null));

// ---------------------------------------------------------------- stamp
const STAMP_META = ['mime', 'width', 'height', 'version', 'updated_at', ...Object.values(PLACES)];
const DEFAULT_STAMP = { mime: null, width: null, height: null, version: 0, updated_at: null, on_prescriptions: true, on_reports: true, on_certificates: true, on_invoices: false };

/** The stamp settings (without the image bytes); defaults when the clinic never set anything. */
async function stamp(businessId) {
  const row = await knex('clinic_stamps').where({ business_id: businessId }).first(STAMP_META);
  if (!row) return { ...DEFAULT_STAMP };
  const out = { ...row };
  Object.values(PLACES).forEach((k) => { out[k] = Boolean(row[k]); });
  return out;
}

const stampImage = (businessId) => knex('clinic_stamps').where({ business_id: businessId }).whereNotNull('image').first('image', 'mime', 'version', ...Object.values(PLACES));

async function saveStamp(ctx, buf) {
  if (!managesAll(ctx)) throw E.forbidden('settings.manage');
  const info = await validateImage(buf);
  const before = await knex('clinic_stamps').where({ business_id: ctx.businessId }).first('business_id', 'mime', 'version');
  const patch = { image: buf, mime: info.mime, width: info.width, height: info.height, version: ((before && before.version) || 0) + 1, updated_by: ctx.userId || null, updated_at: new Date() };
  await knex.transaction(async (trx) => {
    if (before) await trx('clinic_stamps').where({ business_id: ctx.businessId }).update(patch);
    else await trx('clinic_stamps').insert({ business_id: ctx.businessId, ...patch });
    await audit.record(ctx, before && before.mime ? 'stamp.replaced' : 'stamp.added', {
      entityType: 'business', entityId: ctx.businessId,
      newValues: { mime: info.mime, size: `${info.width}x${info.height}`, bytes: buf.length },
    }, trx);
  });
  return { replaced: Boolean(before && before.mime) };
}

async function removeStamp(ctx) {
  if (!managesAll(ctx)) throw E.forbidden('settings.manage');
  const before = await knex('clinic_stamps').where({ business_id: ctx.businessId }).whereNotNull('image').first('version');
  if (!before) throw E.notFound('Stamp');
  await knex.transaction(async (trx) => {
    await trx('clinic_stamps').where({ business_id: ctx.businessId }).update({ image: null, mime: null, width: null, height: null, updated_by: ctx.userId || null, updated_at: new Date() });
    await audit.record(ctx, 'stamp.removed', { entityType: 'business', entityId: ctx.businessId, oldValues: { version: before.version } }, trx);
  });
}

/** Where the stamp appears. input: { prescriptions, reports, certificates, invoices } checkbox values ('1'). */
async function saveStampPlaces(ctx, input = {}) {
  if (!managesAll(ctx)) throw E.forbidden('settings.manage');
  const next = {};
  Object.entries(PLACES).forEach(([k, col]) => { next[col] = [].concat(input[k] || []).includes('1'); });
  const current = await stamp(ctx.businessId);
  const { oldValues, newValues, changed } = audit.diff(Object.fromEntries(Object.values(PLACES).map((c) => [c, current[c] ? 1 : 0])), Object.fromEntries(Object.entries(next).map(([c, v]) => [c, v ? 1 : 0])));
  if (!changed) return false;
  await knex.transaction(async (trx) => {
    const exists = await trx('clinic_stamps').where({ business_id: ctx.businessId }).first('business_id');
    if (exists) await trx('clinic_stamps').where({ business_id: ctx.businessId }).update({ ...next, updated_by: ctx.userId || null, updated_at: new Date() });
    else await trx('clinic_stamps').insert({ business_id: ctx.businessId, ...next, updated_by: ctx.userId || null });
    await audit.record(ctx, 'stamp.placement_updated', { entityType: 'business', entityId: ctx.businessId, oldValues, newValues }, trx);
  });
  return true;
}

// ---------------------------------------------------------------- documents
/**
 * Images for one document: the signature of the doctor printed on it (never another doctor's) and the clinic stamp
 * when it is switched on for that kind of document.
 * @param kind prescriptions | reports | certificates | invoices
 * @returns {{ signature: Buffer|null, stamp: Buffer|null }}
 */
async function forDocument(businessId, kind, doctorId) {
  const [sig, st] = await Promise.all([
    kind !== 'invoices' && doctorId ? signatureImage(businessId, doctorId) : null,
    stampImage(businessId),
  ]);
  const col = PLACES[kind];
  return {
    signature: sig && inspect(sig.image) ? sig.image : null,
    stamp: st && col && st[col] && inspect(st.image) ? st.image : null,
  };
}

module.exports = {
  MAX_BYTES, PLACES, inspect, validateImage, fromDataUrl, canManage, managesAll, doctorsFor, saveSignature, removeSignature, signatureImage,
  stamp, stampImage, saveStamp, removeStamp, saveStampPlaces, forDocument,
};
