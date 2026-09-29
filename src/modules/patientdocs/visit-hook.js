// Runs before the visit page (GET /app/visits/:id) and prepares the "Documents for the patient" panel and the
// online-payment summary for the partial included in that page. It never answers the request itself.
const express = require('express');
const knex = require('../../db/knex');
const mailer = require('../../core/mailer');
const { publicBase } = require('../../middleware/web');
const appts = require('../clinic/appointments.service');
const docs = require('./docs.service');

const router = express.Router();
const digits = (v) => String(v || '').replace(/[^0-9]/g, '');

router.get('/:id(\\d+)', async (req, res, next) => {
  try {
    const { ctx } = req;
    const perms = ctx.permissions;
    if (!perms.has('clinical.view') && !perms.has('billing.view')) return next();
    let a;
    try { a = await appts.get(ctx, Number(req.params.id)); } catch { return next(); } // the visit page answers 404/403 itself
    if (a.appointment_type === 'blocked') return next();
    const out = { apptId: a.id, online: a.appointment_type === 'online', canShare: perms.has('clinical.edit') || perms.has('prescriptions.create') };
    if (perms.has('clinical.view')) {
      const [ch, shared] = await Promise.all([docs.choices(ctx, a.id), docs.sharedList(ctx.businessId, a.id)]);
      const certs = ch.certs;
      let link = null;
      if (out.online) {
        const tele = require('../telehealth/telehealth.service'); // eslint-disable-line global-require
        const { token } = await tele.forAppointment(ctx, a);
        link = tele.linkFor(publicBase(req), token);
      }
      const clinicName = (req.locale === 'en' && req.business.name_en) || req.business.name;
      Object.assign(out, {
        docs: { ...ch, shared: shared.map((d) => ({ ...d, label: docs.labelOf(d, req.t, certs) })) },
        link, mailOn: mailer.configured(), patientEmail: a.patient_email || null,
        waHref: link && digits(a.patient_phone) ? `https://wa.me/${digits(a.patient_phone)}?text=${encodeURIComponent(req.t('patient_docs.wa_text', { clinic: clinicName, link }))}` : null,
        locale: req.locale === 'en' ? 'en' : 'ar',
      });
    }
    if (perms.has('billing.view')) {
      out.payments = await knex('payments').where({ business_id: ctx.businessId, appointment_id: a.id }).whereNot('status', 'initiated').orderBy('id', 'desc').limit(5)
        .select('id', 'provider', 'status', 'amount', 'currency', 'note', 'paid_at', 'refunded_at', 'created_at', 'brand');
    }
    res.locals.visitExtras = out;
  } catch (e) {
    console.error('[patient-docs] visit panel:', e.message); // eslint-disable-line no-console
  }
  return next();
});

module.exports = router;
