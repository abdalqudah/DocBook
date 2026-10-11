// Platform admin → Platform settings (the platform's e-mail and WhatsApp, the public WhatsApp link, IP places) and
// → Activity (who is active on the platform now and from where). Mounted inside admin/web.js after its guard.
const express = require('express');
const { wrap, flash } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const comms = require('./comms.service');
const activity = require('./activity.service');

const router = express.Router();
const page = (res, view, data) => res.page(`pages/admin/${view}`, { layout: 'admin', pageStyles: ['/css/site.css', '/css/admin.css'], ...data });
const regionName = (locale) => (cc) => (cc ? require('../settings/options').regionName(cc, locale) : '—'); // eslint-disable-line global-require

async function renderSettings(req, res, extra = {}) {
  const s = await comms.get();
  page(res, 'platform-settings', {
    title: req.t('pcomms.title'), s, publicLink: await comms.publicLink(req.locale), envSmtp: Boolean(process.env.SMTP_HOST),
    errors: {}, old: null, ...extra,
  });
}
router.get('/settings', wrap((req, res) => renderSettings(req, res)));
router.post('/settings', wrap(async (req, res) => {
  try {
    await comms.save(req.ctx, req.body);
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    res.status(e.status === 409 ? 409 : 422);
    return renderSettings(req, res, { errors: e.details || {}, old: req.body, formError: e.code === 'VALIDATION_FAILED' ? null : e.message });
  }
  flash(req, 'success', req.t('pcomms.saved'));
  return res.redirect('/admin/settings');
}));
router.post('/settings/test-email', wrap(async (req, res) => {
  const to = String(req.body.to || req.user.email).trim();
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  await mailer.refreshPlatformSmtp();
  let ok = false; let err = '';
  try { ok = await mailer.send({ to, subject: req.t('pcomms.test_subject'), html: mailer.layout({ locale: req.locale, title: req.t('pcomms.test_subject'), body: req.t('pcomms.test_body') }) }); } catch (e) { err = e.message; }
  flash(req, ok ? 'success' : 'error', ok ? req.t('pcomms.test_email_ok', { to }) : `${req.t('pcomms.test_email_failed')} ${err}`.trim());
  res.redirect('/admin/settings#mail');
}));
router.post('/settings/test-whatsapp', wrap(async (req, res) => {
  const r = await comms.sendWhatsAppText(req.body.to, req.t('pcomms.test_whatsapp_text'));
  flash(req, r.ok ? 'success' : 'error', r.ok ? req.t('pcomms.test_whatsapp_ok') : `${req.t('pcomms.test_whatsapp_failed')} ${r.error || ''}`.trim());
  res.redirect('/admin/settings#whatsapp');
}));

// ---------------------------------------------------------------- activity
router.get('/activity', wrap(async (req, res) => {
  const f = { period: String(req.query.period || 'day'), country: String(req.query.country || '').toUpperCase(), kind: String(req.query.kind || '') };
  const data = await activity.overview(f);
  page(res, 'activity', { title: req.t('pcomms.activity_title'), ...data, f, countryName: regionName(req.locale), geo: (await comms.get()).geo });
}));
router.post('/activity/locate', wrap(async (req, res) => {
  if (!(await comms.get()).geo.lookup) { flash(req, 'error', req.t('pcomms.geo_off')); return res.redirect('/admin/activity'); }
  const n = await activity.locate(40);
  flash(req, 'success', req.t('pcomms.geo_done', { n }));
  return res.redirect(`/admin/activity${req.body.period ? `?period=${encodeURIComponent(req.body.period)}` : ''}`);
}));

module.exports = router;
