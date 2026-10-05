// File uploads: kept in memory by multer, checked by content (magic bytes, not the file name), then written to
// STORAGE_DIR outside the public folder with a random name. Served only through routes that check permissions
// (private) or /media/:id for files marked public (logos, CMS images).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const knex = require('../db/knex');
const { AppError } = require('./errors');
const { verifyCsrfAfterUpload } = require('../middleware/web');

const KINDS = {
  pdf: { mime: 'application/pdf', ext: 'pdf', test: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
  png: { mime: 'image/png', ext: 'png', test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { mime: 'image/webp', ext: 'webp', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  gif: { mime: 'image/gif', ext: 'gif', test: (b) => /^GIF8[79]a/.test(b.slice(0, 6).toString('latin1')) },
  // Office files are ZIP containers; the extension decides which (docx/xlsx) and the content must be a ZIP.
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', test: (b, name) => /\.docx$/i.test(name) && b.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', test: (b, name) => /\.xlsx$/i.test(name) && b.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
  csv: { mime: 'text/csv', ext: 'csv', test: (b, name) => /\.csv$/i.test(name) && !b.slice(0, 2048).includes(0) },
};
const IMAGES = ['png', 'jpg', 'webp', 'gif'];
const DOCUMENTS = ['pdf', 'png', 'jpg', 'webp', 'docx'];

/** Which allowed kind this buffer really is, or null. SVG is never accepted (it can carry scripts). */
function detect(buffer, name, allowed) {
  for (const k of allowed) if (KINDS[k] && KINDS[k].test(buffer, String(name || ''))) return { key: k, ...KINDS[k] };
  return null;
}

/** Express middleware: parse one file field (multer, memory), then check the CSRF token. */
function single(field, { maxMb = 10 } = {}) {
  const mw = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMb * 1024 * 1024, files: 1, fields: 60 } }).single(field);
  return (req, res, next) => mw(req, res, (err) => {
    if (err) return next(new AppError('UPLOAD_FAILED', err.code === 'LIMIT_FILE_SIZE' ? `The file is larger than ${maxMb} MB.` : 'The upload could not be read.', 422, { [field]: err.code === 'LIMIT_FILE_SIZE' ? `Max ${maxMb} MB.` : 'Upload failed.' }));
    return verifyCsrfAfterUpload(req, res, next);
  });
}

/** Validates and stores an uploaded file; returns the media row id. */
async function store(file, { purpose, allowed = DOCUMENTS, isPublic = false, userId = null, field = 'file' } = {}) {
  if (!file || !file.buffer || !file.size) throw new AppError('UPLOAD_MISSING', 'Choose a file.', 422, { [field]: 'Choose a file.' });
  const kind = detect(file.buffer, file.originalname, allowed);
  if (!kind) throw new AppError('UPLOAD_TYPE', 'This file type is not allowed.', 422, { [field]: `Allowed: ${allowed.join(', ').toUpperCase()}.` });
  const key = `${new Date().toISOString().slice(0, 7)}/${crypto.randomBytes(16).toString('hex')}.${kind.ext}`;
  const target = path.join(config.storageDir, key);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, file.buffer, { mode: 0o640 });
  const [id] = await knex('media').insert({
    purpose, original_name: String(file.originalname || '').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 200), mime: kind.mime, size: file.size,
    storage_key: key, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), is_public: isPublic, uploaded_by: userId,
  });
  return id;
}

/** Sends a stored file. `download` forces a download (documents); images display inline. */
async function send(res, mediaId, { download = false } = {}) {
  const m = await knex('media').where({ id: mediaId }).first();
  if (!m) throw new AppError('NOT_FOUND', 'File not found.', 404);
  const file = path.join(config.storageDir, m.storage_key);
  if (!file.startsWith(config.storageDir) || !fs.existsSync(file)) throw new AppError('NOT_FOUND', 'File not found.', 404);
  res.set({
    'Content-Type': m.mime,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': m.is_public ? 'public, max-age=86400' : 'private, no-store',
    'Content-Disposition': `${download || !m.mime.startsWith('image/') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(m.original_name || `file.${m.storage_key.split('.').pop()}`)}`,
  });
  return res.sendFile(file);
}

async function remove(mediaId) {
  const m = await knex('media').where({ id: mediaId }).first();
  if (!m) return;
  await knex('media').where({ id: mediaId }).del();
  await fs.promises.unlink(path.join(config.storageDir, m.storage_key)).catch(() => {});
}

module.exports = { single, store, send, remove, detect, IMAGES, DOCUMENTS, KINDS };
