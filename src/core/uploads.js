// Uploads kept in memory (multer), with every picture made small on arrival: PNG / JPEG / WebP photos are scaled to a
// readable size and saved as WebP (core/imageopt). A phone photo of several MB is therefore accepted even where the
// stored file must stay under 1 MB: the size limit is checked again after compression, with multer's own error, so
// each route keeps handling "too big" exactly as before. Other files (PDF, ZIP, fonts…) pass untouched.
//   const upload = uploads.memory({ limits: { fileSize: 1024 * 1024, files: 1 }, maxSide: 1200, skip: ['favicon'] });
//   upload.single('logo')(req, res, cb)  ·  upload.array('files', 10)  ·  upload.fields([...])  ·  upload(req, res, cb)
const multer = require('multer');
const imageopt = require('./imageopt');

const RAW_IMAGE_MAX = 15 * 1024 * 1024; // what a phone may send before compression

function filesOf(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') return Object.values(req.files).flat();
  return [];
}

/** Compresses the pictures of a parsed request in place (name → .webp, type → image/webp). */
async function compress(req, { maxSide, quality, skip = [] } = {}) {
  for (const f of filesOf(req)) { // eslint-disable-line no-restricted-syntax
    if (!f || !Buffer.isBuffer(f.buffer) || skip.includes(f.fieldname) || !imageopt.isImage(f.buffer)) continue; // eslint-disable-line no-continue
    const r = await imageopt.optimize(f.buffer, { maxSide, quality }); // eslint-disable-line no-await-in-loop
    if (!r) continue; // eslint-disable-line no-continue
    f.buffer = r.buffer;
    f.size = r.buffer.length;
    f.mimetype = r.mime;
    f.originalname = `${String(f.originalname || 'image').replace(/\.[A-Za-z0-9]{1,5}$/, '')}.webp`;
    f.optimized = { from: r.from, before: r.before, width: r.width, height: r.height };
  }
}

/** A multer-like uploader whose pictures are compressed before the route sees them. */
function memory({ limits = {}, maxSide, quality, skip = [] } = {}) {
  const fileSize = limits.fileSize || Infinity;
  const raw = multer({ storage: multer.memoryStorage(), limits: { ...limits, fileSize: Number.isFinite(fileSize) ? Math.max(fileSize, RAW_IMAGE_MAX) : undefined } });
  const wrap = (mw) => (req, res, cb) => mw(req, res, (err) => {
    if (err) return cb(err);
    return compress(req, { maxSide, quality, skip }).then(() => {
      // The route's own limit, on what is now stored (a file that is not a picture keeps its original limit too).
      const big = filesOf(req).find((f) => f && f.size > fileSize);
      cb(big ? new multer.MulterError('LIMIT_FILE_SIZE', big.fieldname) : undefined);
    }, cb);
  });
  const out = (fields) => wrap(raw.fields(fields));
  const api = (req, res, cb) => wrap(raw.any())(req, res, cb);
  api.single = (name) => wrap(raw.single(name));
  api.array = (name, max) => wrap(raw.array(name, max));
  api.fields = out;
  api.any = () => wrap(raw.any());
  api.none = () => raw.none();
  return api;
}

module.exports = { memory, compress, RAW_IMAGE_MAX };
