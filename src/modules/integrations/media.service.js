// Clinic media library: images (PNG, JPEG, WebP, GIF) and PDFs uploaded by the clinic, reused across its pages.
// • Files are checked by their content (magic bytes), never by their name or the browser's type. SVG is refused:
//   it is a document that can carry scripts.
// • Stored in the database (clinic_media.data, MEDIUMBLOB) like the other images of the app, so backups and
//   multi-server set-ups need no shared disk.
// • Served to members from /app/media/:id and — only for images the clinic marked public — from
//   /m/<clinic slug>/:id (the clinic page), always with nosniff and a "default-src 'none'" policy.
// • media_usages records where a file is used (clinic page cover + gallery). Deleting a used file needs an
//   explicit confirmation; making a used image private is refused.
const crypto = require('crypto');
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');

const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MB = 200; // per clinic while no package applies (subscriptions off, trial without a plan…)
const QUOTA_BYTES = DEFAULT_MB * 1024 * 1024;
const MB = 1024 * 1024;
const MAX_FILES = 2000;
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MIMES = [...IMAGE_MIMES, 'application/pdf'];
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
const GALLERY_MAX = 12;
const CONTEXTS = { 'portal.cover': 1, 'portal.gallery': GALLERY_MAX };

const fail = (code, message, status = 422, details) => new AppError(code, message, status, details);

/** Real type from the first bytes of the file (null for anything that is not allowed). */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  const head6 = buf.toString('ascii', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** True for SVG / XML / HTML documents (refused with their own message). */
function looksLikeMarkup(buf) {
  if (!Buffer.isBuffer(buf)) return false;
  const head = buf.slice(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype') || head.startsWith('<html') || /<svg[\s>]/.test(head);
}

/** Pixel size read from the file header (null when it cannot be read, and for PDFs). */
function dimensions(buf, mime) {
  try {
    if (mime === 'image/png' && buf.toString('ascii', 12, 16) === 'IHDR') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
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
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch { /* unreadable header: size stays unknown */ }
  return null;
}

/**
 * Checks an uploaded file. Returns { mime, width, height, size }; throws AppError
 * MEDIA_EMPTY | MEDIA_TOO_BIG | MEDIA_SVG | MEDIA_TYPE (422).
 */
function inspect(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw fail('MEDIA_EMPTY', 'Choose a file to upload.');
  if (buf.length > MAX_BYTES) throw fail('MEDIA_TOO_BIG', 'The file is larger than 5 MB.');
  const mime = sniff(buf);
  if (!mime) {
    if (looksLikeMarkup(buf)) throw fail('MEDIA_SVG', 'SVG and other document files are not accepted. Upload PNG, JPEG, WebP, GIF or PDF.');
    throw fail('MEDIA_TYPE', 'Upload PNG, JPEG, WebP, GIF or PDF files only.');
  }
  const dim = mime === 'application/pdf' ? null : dimensions(buf, mime);
  return { mime, size: buf.length, width: dim ? dim.width : null, height: dim ? dim.height : null };
}

const cleanText = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f<>"`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanName = (n, fallback) => cleanText(String(n || '').replace(/\.[a-z0-9]{2,5}$/i, ''), 150) || fallback;
const cleanFolder = (f) => cleanText(f, 60).replace(/[/\\]/g, '-');
const bool = (v) => v === true || v === 1 || v === '1' || v === 'on' || v === 'true';
const isImage = (m) => IMAGE_MIMES.includes(m && m.mime ? m.mime : m);

const COLS = ['id', 'business_id', 'name', 'folder', 'alt_ar', 'alt_en', 'mime', 'size', 'width', 'height', 'sha', 'is_public', 'uploaded_by', 'created_at', 'updated_at'];
const urlOf = (m) => `/app/media/${m.id}?v=${m.sha}`;
const publicUrlOf = (slug, m) => `/m/${slug}/${m.id}?v=${m.sha}`;

/** Library rows (no bytes) with the uploader's name and how many places use each file. */
async function list(businessId, { q = '', folder = null, kind = '' } = {}) {
  const query = knex('clinic_media as m').leftJoin('users as u', 'u.id', 'm.uploaded_by').where('m.business_id', businessId)
    .select(COLS.map((c) => `m.${c}`), 'u.name as uploader')
    .select(knex('media_usages as mu').whereRaw('mu.media_id = m.id').count('*').as('uses'))
    .orderBy('m.id', 'desc').limit(500);
  const term = cleanText(q, 80);
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    query.where((w) => w.where('m.name', 'like', like).orWhere('m.alt_ar', 'like', like).orWhere('m.alt_en', 'like', like));
  }
  if (folder !== null && folder !== undefined && folder !== '*') query.where('m.folder', cleanFolder(folder));
  if (kind === 'image') query.whereIn('m.mime', IMAGE_MIMES);
  if (kind === 'pdf') query.where('m.mime', 'application/pdf');
  const rows = await query;
  return rows.map((r) => ({ ...r, is_public: Boolean(r.is_public), uses: Number(r.uses) || 0, url: urlOf(r), isImage: isImage(r) }));
}

async function folders(businessId) {
  const rows = await knex('clinic_media').where({ business_id: businessId }).groupBy('folder').orderBy('folder').select('folder').count({ n: '*' });
  return rows.map((r) => ({ folder: r.folder, n: Number(r.n) }));
}

/**
 * The clinic's storage → { mb, source }: what the platform admin set for this clinic, else the package's
 * media.storage_mb (null = no limit), else the platform default while no package applies. mb null = no limit.
 */
async function quotaOf(businessId) {
  const b = await knex('businesses').where({ id: businessId }).first();
  if (!b) return { mb: DEFAULT_MB, source: 'default' };
  if (b.media_quota_mb !== null && b.media_quota_mb !== undefined) return { mb: Number(b.media_quota_mb), source: 'clinic' };
  const ops = require('../platformops/ops.service'); // eslint-disable-line global-require
  const features = await ops.planFeatures(b);
  if (!features) return { mb: DEFAULT_MB, source: 'default' };
  const entitlements = require('../subscriptions/entitlements'); // eslint-disable-line global-require
  return { mb: entitlements.valueIn(features, 'media.storage_mb'), source: 'plan' };
}

async function stats(businessId) {
  const [[r], q] = await Promise.all([knex('clinic_media').where({ business_id: businessId }).count({ n: '*' }).sum({ bytes: 'size' }), quotaOf(businessId)]);
  return { files: Number(r.n) || 0, bytes: Number(r.bytes) || 0, quota: q.mb === null ? null : q.mb * MB, quotaMb: q.mb, source: q.source };
}

async function get(businessId, id) {
  const m = await knex('clinic_media').where({ business_id: businessId, id: Number(id) || 0 }).first(COLS);
  if (!m) throw E.notFound('File');
  return { ...m, is_public: Boolean(m.is_public), url: urlOf(m), isImage: isImage(m) };
}

async function upload(ctx, file, body = {}) {
  const info = inspect(file && file.buffer);
  const s = await stats(ctx.businessId);
  if (s.files >= MAX_FILES || (s.quota !== null && s.bytes + info.size > s.quota)) throw fail('MEDIA_QUOTA', 'The media library is full. Delete files you no longer use.', 409, { mb: s.quotaMb });
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex').slice(0, 16);
  const row = {
    business_id: ctx.businessId, name: cleanName(body.name || (file && file.originalname), `file-${sha.slice(0, 6)}`),
    folder: cleanFolder(body.folder), alt_ar: cleanText(body.alt_ar, 255), alt_en: cleanText(body.alt_en, 255),
    mime: info.mime, size: info.size, width: info.width, height: info.height, sha, data: file.buffer,
    is_public: info.mime !== 'application/pdf' && bool(body.is_public), uploaded_by: ctx.userId || null,
  };
  const [id] = await knex('clinic_media').insert(row);
  await audit.record(ctx, 'media.uploaded', { entityType: 'media', entityId: id, newValues: { name: row.name, mime: row.mime, size: row.size, folder: row.folder, is_public: row.is_public } });
  return get(ctx.businessId, id);
}

async function usages(businessId, id) {
  return knex('media_usages').where({ business_id: businessId, media_id: Number(id) || 0 }).orderBy('context').select('context', 'ref_id');
}

async function update(ctx, id, body = {}) {
  const m = await get(ctx.businessId, id);
  const next = {
    name: body.name !== undefined ? cleanName(body.name, m.name) : m.name,
    folder: body.folder !== undefined ? cleanFolder(body.folder) : m.folder,
    alt_ar: body.alt_ar !== undefined ? cleanText(body.alt_ar, 255) : m.alt_ar,
    alt_en: body.alt_en !== undefined ? cleanText(body.alt_en, 255) : m.alt_en,
    is_public: m.isImage ? (body.is_public !== undefined ? bool(body.is_public) : m.is_public) : false,
  };
  if (m.is_public && !next.is_public) {
    const used = (await usages(ctx.businessId, m.id)).filter((u) => u.context.startsWith('portal.') || u.context === 'doctor.photo');
    if (used.length) throw fail('MEDIA_PUBLIC_IN_USE', 'This image is shown on the clinic page. Remove it there before making it private.', 409);
  }
  const d = audit.diff(m, next);
  if (!d.changed) return m;
  await knex('clinic_media').where({ id: m.id, business_id: ctx.businessId }).update({ ...next, updated_at: new Date() });
  cache.forgetPrefix(`media:page:${ctx.businessId}`);
  await audit.record(ctx, 'media.updated', { entityType: 'media', entityId: m.id, oldValues: d.oldValues, newValues: d.newValues });
  return get(ctx.businessId, m.id);
}

/** Deletes a file. A file in use needs `force` (the caller asked the user to confirm); its usages go with it. */
async function remove(ctx, id, { force = false } = {}) {
  const m = await get(ctx.businessId, id);
  const used = await usages(ctx.businessId, m.id);
  if (used.length && !force) throw fail('MEDIA_IN_USE', 'This file is in use.', 409, { usages: used.map((u) => u.context) });
  await knex.transaction(async (trx) => {
    await trx('media_usages').where({ business_id: ctx.businessId, media_id: m.id }).del();
    await trx('clinic_media').where({ business_id: ctx.businessId, id: m.id }).del();
    await audit.record(ctx, 'media.deleted', { entityType: 'media', entityId: m.id, oldValues: { name: m.name, mime: m.mime, size: m.size, usages: used.map((u) => u.context) } }, trx);
  });
  cache.forgetPrefix(`media:page:${ctx.businessId}`);
  cache.forgetPrefix(`media:docs:${ctx.businessId}`);
}

/** The stored bytes for a member of the clinic. */
async function file(businessId, id) {
  if (!/^\d{1,10}$/.test(String(id))) return null;
  return (await knex('clinic_media').where({ business_id: businessId, id: Number(id) }).first('id', 'name', 'mime', 'size', 'sha', 'data', 'is_public')) || null;
}

/** A public image of an active clinic (null for private files, PDFs, other clinics). */
async function publicFile(slug, id) {
  if (!/^[a-z0-9-]{3,40}$/.test(String(slug || '')) || !/^\d{1,10}$/.test(String(id))) return null;
  const row = await knex('clinic_media as m').join('businesses as b', 'b.id', 'm.business_id')
    .where({ 'b.slug': slug, 'b.status': 'active', 'm.id': Number(id), 'm.is_public': true }).whereIn('m.mime', IMAGE_MIMES)
    .first('m.id', 'm.name', 'm.mime', 'm.size', 'm.sha', 'm.data');
  return row || null;
}

// ---------------------------------------------------------------- clinic page (cover + gallery)
const toIds = (v) => [].concat(v === undefined || v === null ? [] : v).flatMap((x) => String(x).split(',')).map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0);

/** { cover: row|null, gallery: [rows] } for the settings page. */
async function pageMedia(businessId) {
  const rows = await knex('media_usages as u').join('clinic_media as m', 'm.id', 'u.media_id').where('u.business_id', businessId).whereIn('u.context', Object.keys(CONTEXTS))
    .orderBy([{ column: 'u.context' }, { column: 'u.sort_order' }]).select('u.context', ...COLS.filter((c) => c !== 'business_id').map((c) => `m.${c}`));
  const view = (r) => ({ ...r, url: urlOf(r) });
  return { cover: rows.filter((r) => r.context === 'portal.cover').map(view)[0] || null, gallery: rows.filter((r) => r.context === 'portal.gallery').map(view) };
}

/** Saves the clinic page cover and gallery (library images only). Chosen images become public. */
async function setPageMedia(ctx, body = {}) {
  const cover = toIds(body.cover_media_id)[0] || null;
  const gallery = [...new Set(toIds(body.gallery_media_ids))].filter((id) => id !== cover).slice(0, GALLERY_MAX);
  const ids = [...new Set([cover, ...gallery].filter(Boolean))];
  const found = ids.length ? await knex('clinic_media').where({ business_id: ctx.businessId }).whereIn('id', ids).select('id', 'mime', 'is_public') : [];
  if (found.length !== ids.length || found.some((m) => !isImage(m))) throw fail('MEDIA_NOT_IMAGE', 'Choose images from the media library.', 422);
  const before = await pageMedia(ctx.businessId);
  await knex.transaction(async (trx) => {
    await trx('media_usages').where({ business_id: ctx.businessId }).whereIn('context', Object.keys(CONTEXTS)).del();
    const rows = [];
    if (cover) rows.push({ business_id: ctx.businessId, media_id: cover, context: 'portal.cover', sort_order: 0 });
    gallery.forEach((id, i) => rows.push({ business_id: ctx.businessId, media_id: id, context: 'portal.gallery', sort_order: i }));
    if (rows.length) await trx('media_usages').insert(rows);
    const makePublic = found.filter((m) => !m.is_public).map((m) => m.id);
    if (makePublic.length) await trx('clinic_media').where({ business_id: ctx.businessId }).whereIn('id', makePublic).update({ is_public: true, updated_at: new Date() });
    await audit.record(ctx, 'media.clinic_page_updated', {
      entityType: 'clinic', entityId: ctx.businessId,
      oldValues: { cover: before.cover ? before.cover.id : null, gallery: before.gallery.map((g) => g.id) },
      newValues: { cover, gallery, made_public: makePublic },
    }, trx);
  });
  cache.forgetPrefix(`media:page:${ctx.businessId}`);
  return { cover, gallery };
}

/** What the public clinic page shows: { cover, gallery } with public URLs and alt text in the visitor's language. */
async function publicPage(clinic, locale) {
  if (!clinic || !clinic.id || !clinic.slug) return { cover: null, gallery: [] };
  const rows = await cache.remember(`media:page:${clinic.id}`, async () => (await pageMedia(clinic.id)), 60_000).catch(() => ({ cover: null, gallery: [] }));
  const view = (m) => (m && m.is_public ? {
    id: m.id, url: publicUrlOf(clinic.slug, m), width: m.width, height: m.height,
    alt: (locale === 'en' ? m.alt_en || m.alt_ar : m.alt_ar || m.alt_en) || '',
  } : null);
  return { cover: view(rows.cover), gallery: rows.gallery.map(view).filter(Boolean) };
}

// ---------------------------------------------------------------- doctor photos
/**
 * Sets (or clears, with a falsy mediaId) a doctor's photo from the library. The image becomes public because the
 * clinic page and booking page show it; the use is tracked so the library warns before deleting it.
 */
async function setDoctorPhoto(ctx, doctorId, mediaId, trx = knex) {
  const id = toIds(mediaId)[0] || null;
  const doc = await trx('doctors').where({ id: Number(doctorId), business_id: ctx.businessId }).first('id', 'photo_media_id');
  if (!doc) return null;
  if ((doc.photo_media_id || null) === id) return id;
  if (id) {
    const m = await trx('clinic_media').where({ business_id: ctx.businessId, id }).first('id', 'mime', 'is_public');
    if (!m || !isImage(m)) throw fail('MEDIA_NOT_IMAGE', 'Choose images from the media library.', 422);
    if (!m.is_public) await trx('clinic_media').where({ business_id: ctx.businessId, id }).update({ is_public: true, updated_at: new Date() });
  }
  await trx('doctors').where({ id: doc.id, business_id: ctx.businessId }).update({ photo_media_id: id, updated_at: new Date() });
  await trx('media_usages').where({ business_id: ctx.businessId, context: 'doctor.photo', ref_id: doc.id }).del();
  if (id) await trx('media_usages').insert({ business_id: ctx.businessId, media_id: id, context: 'doctor.photo', ref_id: doc.id, sort_order: 0 });
  cache.forgetPrefix(`media:docs:${ctx.businessId}`);
  await audit.record(ctx, 'doctor.photo_updated', { entityType: 'doctor', entityId: doc.id, oldValues: { photo_media_id: doc.photo_media_id || null }, newValues: { photo_media_id: id } }, trx);
  return id;
}

/** { [doctorId]: { id, url } } for staff screens (member-only URLs). */
async function doctorPhotos(businessId, doctorIds) {
  const ids = [...new Set((doctorIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return {};
  const rows = await knex('doctors as d').join('clinic_media as m', function j() { this.on('m.id', 'd.photo_media_id').andOn('m.business_id', 'd.business_id'); })
    .where('d.business_id', businessId).whereIn('d.id', ids).whereIn('m.mime', IMAGE_MIMES).select('d.id as doctor_id', 'm.id', 'm.sha');
  return Object.fromEntries(rows.map((r) => [r.doctor_id, { id: r.id, url: urlOf(r) }]));
}

/** { [doctorId]: public URL } for the public clinic / booking pages (public images of an active clinic only). */
async function publicDoctorPhotos(clinic) {
  if (!clinic || !clinic.id || !clinic.slug) return {};
  return cache.remember(`media:docs:${clinic.id}`, async () => {
    const rows = await knex('doctors as d').join('clinic_media as m', function j() { this.on('m.id', 'd.photo_media_id').andOn('m.business_id', 'd.business_id'); })
      .where({ 'd.business_id': clinic.id, 'd.is_active': true, 'm.is_public': true }).whereIn('m.mime', IMAGE_MIMES).select('d.id as doctor_id', 'm.id', 'm.sha');
    return Object.fromEntries(rows.map((r) => [r.doctor_id, publicUrlOf(clinic.slug, r)]));
  }, 60_000).catch(() => ({}));
}

module.exports = {
  setDoctorPhoto, doctorPhotos, publicDoctorPhotos,
  MAX_BYTES, QUOTA_BYTES, DEFAULT_MB, quotaOf, MIMES, IMAGE_MIMES, EXT, GALLERY_MAX,
  sniff, looksLikeMarkup, dimensions, inspect, isImage, cleanFolder,
  list, folders, stats, get, upload, update, usages, remove, file, publicFile, urlOf, publicUrlOf,
  pageMedia, setPageMedia, publicPage,
};
