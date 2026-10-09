// Staff side of the patient portal: Settings → Patient portal (on/off, self sign-up, what patients see, the WhatsApp
// template for codes) and, on a patient's file, "Send the account activation" (WhatsApp from the member's own
// WhatsApp, SMS or e-mail).
const express = require('express');
const knex = require('../../db/knex');
const { can } = require('../../middleware/context');
const { wrap, flash } = require('../../routes/helpers');
const common = require('../settings/common');
const businesses = require('../businesses/business.service');
const svc = require('./portal.service');

const router = express.Router();

router.get('/settings/patient-portal', can('settings.manage'), wrap(async (req, res) => {
  const [s, channels] = await Promise.all([svc.settings(req.ctx.businessId), svc.channelsFor(req.ctx.businessId)]);
  const accounts = Number((await knex('patient_accounts').where({ business_id: req.ctx.businessId }).whereNotNull('password_hash').count({ n: '*' }))[0].n);
  return common.render(req, res, 'patient-portal', 'patient_portal', { s, channels, accounts, portalUrl: req.business.slug ? `${common.baseUrl(req)}/${req.business.slug}/account` : null });
}));
router.post('/settings/patient-portal', can('settings.manage'), wrap(async (req, res) => {
  await svc.saveSettings(req.ctx, req.body);
  flash(req, 'success', req.t('pportal.saved'));
  res.redirect('/app/settings/patient-portal');
}));

router.post('/patients/:id(\\d+)/portal-invite', can('patients.edit'), wrap(async (req, res) => {
  const pid = Number(req.params.id);
  const back = `/app/patients/${pid}`;
  try {
    const clinic = { ...(await businesses.get(req.ctx.businessId)) };
    clinic.displayName = (req.locale === 'en' && clinic.name_en) || clinic.name;
    const r = await svc.invite({ ...req.ctx, locale: req.locale }, clinic, pid, ['whatsapp', 'sms', 'email'].includes(req.body.channel) ? req.body.channel : 'whatsapp', common.baseUrl(req));
    if (r.waHref) return res.redirect(r.waHref);
    flash(req, 'success', req.t('pportal.invite_sent'));
  } catch (e) {
    flash(req, 'error', e.details ? Object.values(e.details).join(' ') : e.message);
  }
  return res.redirect(back);
}));

module.exports = router;
