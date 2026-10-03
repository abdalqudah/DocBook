// One clinic paper as a file {filename, content, contentType, label}: the PDF of a prescription, report, invoice,
// test request, referral or certificate (built like the copy sent to the patient), or a stored patient file. The same
// checks as sending it to the patient: the member's permission for that kind, the clinic (and a doctor login's own
// patients), and the record's privacy. Used by the staff mailbox (attachments) and the patient file export.
const knex = require('../../db/knex');
const { AppError, E } = require('../../core/errors');

const DOC_KINDS = ['prescription', 'report', 'invoice', 'order', 'referral', 'certificate', 'file'];
/** One clinic paper as an attachment {filename, content, contentType}, after the same checks as sending it to a patient. */
async function paper(ctx, kind, id, locale) {
  if (!DOC_KINDS.includes(kind)) throw E.notFound('Document');
  const share = require('../share/share.service'); // eslint-disable-line global-require
  if (!(share.PERMS[kind] || []).some((p) => ctx.permissions.has(p))) throw E.forbidden(share.PERMS[kind][0]);
  const doc = await share.target(ctx, kind, id);
  if (doc.patient_id && kind !== 'invoice') {
    const acc = await require('../clinicalplus/privacy.service').access(ctx, { patientId: doc.patient_id }); // eslint-disable-line global-require
    if (!acc.clinical) throw new AppError('RECORD_RESTRICTED', 'Restricted.', 403);
  }
  if (kind === 'file') {
    const f = await knex('patient_files').where({ business_id: ctx.businessId, id: Number(id) }).first('name', 'title', 'mime', 'data');
    if (!f) throw E.notFound('File');
    return { filename: f.name || `${f.title || 'file'}`, content: f.data, contentType: f.mime, label: f.title || f.name };
  }
  const clinic = await require('../businesses/business.service').get(ctx.businessId); // eslint-disable-line global-require
  const { pdfOf } = require('../share/web'); // eslint-disable-line global-require
  const out = await pdfOf({ clinic, ctx }, { kind, ref_id: Number(id), appointment_id: doc.appointment_id, options: {}, locale, business_id: ctx.businessId });
  if (!out) throw E.notFound('Document');
  return { filename: out.filename, content: out.pdf, contentType: 'application/pdf', label: out.filename };
}

module.exports = { DOC_KINDS, paper };
