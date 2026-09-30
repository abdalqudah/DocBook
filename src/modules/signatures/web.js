// Doctor signatures and the clinic stamp (worker: signatures). Mounted at '/' inside /app.
//   GET  /settings/signatures                          Settings → Signatures & stamp
//   POST /settings/signatures/doctors/:id/upload        upload a signature image (multipart, PNG/JPEG ≤ 1 MB)
//   POST /settings/signatures/doctors/:id/draw          save a signature drawn on the screen (PNG data URL)
//   POST /settings/signatures/doctors/:id/delete        remove a signature
//   POST /settings/signatures/stamp                     upload the clinic stamp (multipart)       settings.manage
//   POST /settings/signatures/stamp/delete              remove the stamp                           settings.manage
//   POST /settings/signatures/stamp/places              where the stamp appears                    settings.manage
//   GET  /signatures/doctors/:id.png                    a signature, for whoever may manage it (previews)
//   GET  /signatures/stamp.png                          the stamp (settings.manage preview)
//   GET  /signatures/rx/:rx/(signature|stamp).png        images of one prescription (clinical.view; own visits for doctors)
//   GET  /signatures/certificates/:id/(signature|stamp).png   images of one certificate (certificates.view)
//   GET  /signatures/invoices/:id/stamp.png             the stamp on an invoice (billing.view)
// A document route only ever serves the signature of the doctor printed on that document; when there is nothing to
// show (no image, stamp switched off, revoked certificate) it answers with a transparent pixel so the print layout
// keeps its signature box without a broken image.
const express = require('express');
const multer = require('multer');
const knex = require('../../db/knex');
const { wrap, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const { AppError, E } = require('../../core/errors');
const { render } = require('../settings/common');
const clinical = require('../clinic/clinical.service');
const svc = require('./signatures.service');

const router = express.Router();
const ASSETS = { pageScripts: ['/js/admin.js', '/js/signatures.js'], pageStyles: ['/css/admin.css', '/css/signatures.css'] };
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const SAFE = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-origin' };

const pageGate = canAny('settings.manage', 'prescriptions.create');

function errText(req, e) {
  for (const k of [`errors_signatures.${e.code}`, `errors.${e.code}`]) { const s = req.t(k); if (s !== k) return s; }
  return e.message;
}

/** Back to the settings page, or to the doctor's profile when the form came from there. */
function backTo(req, doctorId) {
  const r = String(req.body && req.body.return ? req.body.return : '');
  if (/^\/app\/doctors\/\d+$/.test(r)) return `${r}#signature`;
  return `/app/settings/signatures${doctorId ? `#doctor-${doctorId}` : '#stamp'}`;
}

/** Runs a write and turns expected failures (bad image, not allowed) into a flash message. */
const act = (fn) => wrap(async (req, res) => {
  let target;
  try {
    target = await fn(req, res);
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    if (e.code === 'NOT_FOUND' && !req.params.id) throw e;
    flash(req, 'error', errText(req, e));
  }
  if (!res.headersSent) res.redirect(target || backTo(req, req.params.id ? Number(req.params.id) : null));
});

// ---------------------------------------------------------------- settings page
router.get('/settings/signatures', pageGate, wrap(async (req, res) => {
  const all = svc.managesAll(req.ctx);
  const [doctors, stamp] = await Promise.all([svc.doctorsFor(req.ctx), all ? svc.stamp(req.ctx.businessId) : null]);
  return render(req, res, 'signatures', 'signatures', {
    title: req.t('signatures.title'), doctors, stamp, managesAll: all, linked: Boolean(req.ctx.doctorId), places: Object.keys(svc.PLACES), maxBytes: svc.MAX_BYTES, ...ASSETS,
  });
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: svc.MAX_BYTES, files: 1, fields: 5, parts: 8 } });
const single = (field) => (req, res, next) => upload.single(field)(req, res, (e) => {
  if (e) req.uploadError = e.code === 'LIMIT_FILE_SIZE' ? 'IMAGE_TOO_BIG' : 'IMAGE_INVALID';
  next();
});
const uploadProblem = (req) => {
  if (req.uploadError) throw new AppError(req.uploadError, 'Upload failed.', 422);
  if (!req.file) throw new AppError('IMAGE_MISSING', 'Choose an image.', 422);
  return req.file.buffer;
};
const savedText = (req, r, kind) => req.t(`signatures.${kind}_${r.replaced ? 'replaced' : 'saved'}`);

router.post('/settings/signatures/doctors/:id(\\d+)/upload', pageGate, single('signature'), verifyCsrfAfterUpload, act(async (req) => {
  const r = await svc.saveSignature(req.ctx, Number(req.params.id), uploadProblem(req), 'upload');
  flash(req, 'success', savedText(req, r, 'signature'));
}));

router.post('/settings/signatures/doctors/:id(\\d+)/draw', pageGate, act(async (req) => {
  const buf = svc.fromDataUrl(req.body.drawing);
  if (!buf) throw new AppError('DRAWING_EMPTY', 'Draw the signature first.', 422);
  const r = await svc.saveSignature(req.ctx, Number(req.params.id), buf, 'drawn');
  flash(req, 'success', savedText(req, r, 'signature'));
}));

router.post('/settings/signatures/doctors/:id(\\d+)/delete', pageGate, act(async (req) => {
  await svc.removeSignature(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('signatures.signature_removed'));
}));

router.post('/settings/signatures/stamp', can('settings.manage'), single('stamp'), verifyCsrfAfterUpload, act(async (req) => {
  const r = await svc.saveStamp(req.ctx, uploadProblem(req));
  flash(req, 'success', savedText(req, r, 'stamp'));
}));

router.post('/settings/signatures/stamp/delete', can('settings.manage'), act(async (req) => {
  await svc.removeStamp(req.ctx);
  flash(req, 'success', req.t('signatures.stamp_removed'));
}));

router.post('/settings/signatures/stamp/places', can('settings.manage'), act(async (req) => {
  await svc.saveStampPlaces(req.ctx, req.body);
  flash(req, 'success', req.t('signatures.places_saved'));
  return '/app/settings/signatures#stamp';
}));

// ---------------------------------------------------------------- images
function sendImage(res, row, { cache = 'private, no-cache' } = {}) {
  const info = row && row.image ? svc.inspect(row.image) : null;
  if (!info) { res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, no-cache', ...SAFE }); return res.send(PIXEL); }
  res.set({ 'Content-Type': info.mime, 'Cache-Control': cache, ...SAFE });
  return res.send(row.image);
}

router.get('/signatures/doctors/:id(\\d+).png', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!svc.canManage(req.ctx, id)) throw E.forbidden('settings.manage');
  const row = await svc.signatureImage(req.ctx.businessId, id);
  if (!row) return res.status(404).set(SAFE).end();
  return sendImage(res, row, { cache: 'private, max-age=86400' });
}));

router.get('/signatures/stamp.png', can('settings.manage'), wrap(async (req, res) => {
  const row = await svc.stampImage(req.ctx.businessId);
  if (!row) return res.status(404).set(SAFE).end();
  return sendImage(res, row, { cache: 'private, max-age=86400' });
}));

// One prescription: clinical.prescription keeps a doctor login to their own prescriptions.
router.get('/signatures/rx/:rx(\\d+)/:what(signature|stamp).png', can('clinical.view'), wrap(async (req, res) => {
  const rx = await clinical.prescription(req.ctx, Number(req.params.rx));
  const m = await svc.forDocument(req.ctx.businessId, 'prescriptions', rx.doctor_id);
  return sendImage(res, { image: m[req.params.what] });
}));

router.get('/signatures/certificates/:id(\\d+)/:what(signature|stamp).png', can('certificates.view'), wrap(async (req, res) => {
  const certs = require('../certificates/certificates.service'); // eslint-disable-line global-require
  const doc = await certs.get(req.ctx, Number(req.params.id));
  if (doc.revoked_at) return sendImage(res, null);
  const m = await svc.forDocument(req.ctx.businessId, 'certificates', doc.doctor_id);
  return sendImage(res, { image: m[req.params.what] });
}));

router.get('/signatures/invoices/:id(\\d+)/stamp.png', can('billing.view'), wrap(async (req, res) => {
  const inv = await knex('invoices').where({ id: Number(req.params.id), business_id: req.ctx.businessId }).first('id');
  if (!inv) throw E.notFound('Invoice');
  const m = await svc.forDocument(req.ctx.businessId, 'invoices', null);
  return sendImage(res, { image: m.stamp });
}));

module.exports = router;
