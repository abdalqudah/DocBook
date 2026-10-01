// Website fonts of a clinic (Theme & brand → Fonts). A font file is accepted by its content (woff2, woff, TrueType,
// OpenType signatures), never by its name; the family name is plain text the clinic chooses. Everything is scoped to
// the signed-in member's clinic (ctx.businessId).
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const cache = require('../../core/cache');
const { E, AppError } = require('../../core/errors');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FONTS = 12;
const WEIGHTS = [300, 400, 500, 600, 700, 800];
const MIME = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };
const forget = (businessId) => cache.forgetPrefix(`fonts:${businessId}`);

/** The format of a font file from its first bytes (null when it is not a font). */
function formatOf(buf) {
  if (!buf || buf.length < 12) return null;
  const sig = buf.subarray(0, 4).toString('latin1');
  if (sig === 'wOF2') return 'woff2';
  if (sig === 'wOFF') return 'woff';
  if (sig === 'OTTO') return 'otf';
  if (buf.readUInt32BE(0) === 0x00010000 || sig === 'true') return 'ttf';
  return null;
}
const cleanFamily = (v) => String(v || '').replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);

function list(businessId) {
  return cache.remember(`fonts:${businessId}`, () => knex('clinic_fonts').where({ business_id: businessId }).orderBy([{ column: 'family' }, { column: 'weight' }])
    .select('id', 'family', 'weight', 'style', 'format', 'sha', 'size', 'created_at'), 60_000);
}

async function upload(ctx, file, input = {}) {
  if (!file || !file.buffer || !file.buffer.length) throw new AppError('FONT_EMPTY', 'Choose a font file.', 422);
  if (file.buffer.length > MAX_BYTES) throw new AppError('FONT_TOO_BIG', 'The font file is larger than 2 MB.', 422);
  const format = formatOf(file.buffer);
  if (!format) throw new AppError('FONT_TYPE', 'This file is not a font (woff2, woff, ttf or otf).', 422);
  const family = cleanFamily(input.family) || cleanFamily(String(file.originalname || '').replace(/\.[a-z0-9]+$/i, '')) || 'Clinic font';
  const weight = WEIGHTS.includes(Number(input.weight)) ? Number(input.weight) : 400;
  const style = input.style === 'italic' ? 'italic' : 'normal';
  const [{ n }] = await knex('clinic_fonts').where({ business_id: ctx.businessId }).count({ n: '*' });
  if (Number(n) >= MAX_FONTS) throw new AppError('FONT_LIMIT', 'The clinic has the most fonts it can keep. Remove one first.', 409);
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const [id] = await knex('clinic_fonts').insert({ business_id: ctx.businessId, family, weight, style, format, sha, size: file.buffer.length, data: file.buffer, created_by: ctx.userId || null });
  await audit.record(ctx, 'website.font_added', { entityType: 'clinic_font', entityId: id, newValues: { family, weight, style, format } });
  forget(ctx.businessId);
  return { id, family, weight, style, format };
}

async function remove(ctx, id) {
  const f = await knex('clinic_fonts').where({ business_id: ctx.businessId, id }).first('id', 'family', 'weight');
  if (!f) throw E.notFound('Font');
  await knex('clinic_fonts').where({ business_id: ctx.businessId, id }).del();
  await audit.record(ctx, 'website.font_removed', { entityType: 'clinic_font', entityId: id, oldValues: { family: f.family, weight: f.weight } });
  forget(ctx.businessId);
}

/** The file of one of the clinic's fonts (for serving). */
function file(businessId, id) {
  return knex('clinic_fonts').where({ business_id: businessId, id }).first('id', 'format', 'sha', 'data');
}

module.exports = { MAX_BYTES, MAX_FONTS, WEIGHTS, MIME, formatOf, list, upload, remove, file, forget };
