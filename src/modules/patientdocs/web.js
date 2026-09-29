// Patient documents for staff (/app/patient-docs/<appointment id>/…):
//   GET  …/prescription/:rx.pdf    the prescription as PDF (clinical.view; also linked from the Rx print page)
//   GET  …/report.pdf?s=…          the consultation report with the chosen sections (clinical.view)
//   GET  …/certificate/:id.pdf     a certificate from the certificates module as PDF (certificates.view/issue)
//   GET  …/docs/:id.pdf            a document as it was shared with the patient
//   POST …/send                    "Send to patient" (clinical.edit or prescriptions.create)
//   POST …/docs/:id/revoke         withdraw a shared document (clinical.edit or prescriptions.create)
// Every PDF download is audited. appointments.get keeps a doctor login to their own visits.
const express = require('express');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { wrap, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { AppError, E } = require('../../core/errors');
const { publicBase } = require('../../middleware/web');
const docs = require('./docs.service');

const router = express.Router();
const langOf = (req) => (req.query.lang === 'en' || req.query.lang === 'ar' ? req.query.lang : req.locale === 'en' ? 'en' : 'ar');
const errText = (req, e) => { for (const k of [`errors_payments.${e.code}`, `errors.${e.code}`]) { const s = req.t(k); if (s !== k) return s; } return e.message; };

async function sendPdf(req, res, apptId, doc, locale) {
  req.ctx.baseUrl = publicBase(req);
  const out = await docs.render(req.ctx, apptId, doc, locale);
  await audit.record(req.ctx, 'patient_docs.downloaded', { entityType: 'appointment', entityId: apptId, newValues: { kind: doc.kind, ref: doc.ref_id || doc.id || null, by: 'staff' } });
  res.set({
    'Content-Type': 'application/pdf', 'Content-Length': String(out.pdf.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${out.filename}"`,
  });
  return res.end(out.pdf);
}

router.get('/:id(\\d+)/prescription/:rx(\\d+).pdf', can('clinical.view'), wrap((req, res) => sendPdf(req, res, Number(req.params.id), { kind: 'prescription', ref_id: Number(req.params.rx) }, langOf(req))));

router.get('/:id(\\d+)/report.pdf', can('clinical.view'), wrap((req, res) => {
  const s = [].concat(req.query.s || []).filter((x) => docs.SECTIONS.includes(x));
  return sendPdf(req, res, Number(req.params.id), { kind: 'report', options: { sections: s.length ? s : docs.SECTIONS } }, langOf(req));
}));

router.get('/:id(\\d+)/certificate/:cid(\\d+).pdf', canAny('certificates.view', 'certificates.issue'), wrap((req, res) => sendPdf(req, res, Number(req.params.id), { kind: 'certificate', ref_id: Number(req.params.cid) }, langOf(req))));

router.get('/:id(\\d+)/docs/:doc(\\d+).pdf', can('clinical.view'), wrap(async (req, res) => {
  const doc = await knex('patient_documents').where({ id: Number(req.params.doc), business_id: req.ctx.businessId, appointment_id: Number(req.params.id) }).first();
  if (!doc) throw E.notFound('Document');
  return sendPdf(req, res, doc.appointment_id, doc, doc.locale);
}));

const shareGate = canAny('clinical.edit', 'prescriptions.create');
const backTo = (id) => `/app/visits/${id}#patient-docs`;

router.post('/:id(\\d+)/send', shareGate, wrap(async (req, res) => {
  const apptId = Number(req.params.id);
  req.ctx.baseUrl = publicBase(req);
  let link = null;
  try {
    const a = await require('../clinic/appointments.service').get(req.ctx, apptId); // eslint-disable-line global-require
    if (a.appointment_type === 'online') {
      const tele = require('../telehealth/telehealth.service'); // eslint-disable-line global-require
      const { token } = await tele.forAppointment(req.ctx, a);
      link = tele.linkFor(publicBase(req), token);
    }
    const r = await docs.share(req.ctx, apptId, { ...req.body, link });
    const msg = req.t('patient_docs.sent', { n: r.shared }) + (r.emailed ? ` ${req.t('patient_docs.sent_mail')}` : '');
    flash(req, 'success', msg);
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', e.code === 'VALIDATION_FAILED' ? req.t('patient_docs.nothing_chosen') : errText(req, e));
  }
  res.redirect(backTo(apptId));
}));

router.post('/:id(\\d+)/docs/:doc(\\d+)/revoke', shareGate, wrap(async (req, res) => {
  await docs.revoke(req.ctx, Number(req.params.id), Number(req.params.doc));
  flash(req, 'success', req.t('patient_docs.revoked'));
  res.redirect(backTo(Number(req.params.id)));
}));

module.exports = router;
