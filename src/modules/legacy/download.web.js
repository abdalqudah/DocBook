// GET /api/patients/:id/attachments/:attachmentId/download — the only way to a patient's imported file: signed in,
// a member of the clinic that holds the patient, with access to the clinical record (clinical.view and the clinic's
// record-privacy rule), and every opening written to the record-access log. ?inline=1 shows an image / PDF in the
// browser (preview); anything else is always a download. Files live outside the public folder (legacy/files.js).
const express = require('express');
const knex = require('../../db/knex');
const { E } = require('../../core/errors');
const { wrap } = require('../../routes/helpers');
const privacy = require('../clinicalplus/privacy.service');
const lib = require('../clinic/records.lib');
const records = require('./records.service');
const files = require('./files');

const router = express.Router();

router.get('/:id(\\d+)/attachments/:attachmentId(\\d+)/download', wrap(async (req, res) => {
  const ctx = req.ctx;
  if (!ctx.permissions.has('clinical.view')) throw E.forbidden('clinical.view');
  const pq = knex('patients').where({ id: Number(req.params.id), business_id: ctx.businessId });
  lib.scopePatientsToDoctor(pq, ctx.ownDoctorId);
  const patient = await pq.first('id');
  if (!patient) throw E.notFound('Patient');
  const acc = await privacy.access(ctx, { patientId: patient.id });
  if (!acc.clinical) throw E.forbidden('clinical.view');
  const a = await records.attachment(ctx.businessId, patient.id, req.params.attachmentId);
  if (!a || !files.exists(a.storage_path)) throw E.notFound('File');
  await privacy.log(ctx, { patientId: patient.id, what: 'legacy_file', access: privacy.levelOf(acc) });
  const inline = req.query.inline === '1' && files.INLINE.has(a.mime_type);
  const name = files.downloadName(a.original_filename || a.stored_filename || `file-${a.id}`, a.mime_type); // a photo kept as WebP: .webp
  res.set({
    'Content-Type': a.mime_type || 'application/octet-stream',
    'Content-Length': String(require('fs').statSync(files.abs(a.storage_path)).size), // what is stored now (a photo may have been compressed) // eslint-disable-line global-require
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]+/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  // Never run as a page: scripts are off (the browser's own PDF viewer needs no policy of ours).
  if (a.mime_type !== 'application/pdf') res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  files.stream(a.storage_path).on('error', () => res.destroy()).pipe(res);
}));

module.exports = router;
