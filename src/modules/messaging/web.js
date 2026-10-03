// Settings → Messaging (/app/settings/messaging, clinic owners and managers with settings.manage):
// switches and timing for confirmations, reminders and review requests, channels (WhatsApp Cloud API, SMS
// provider, e-mail), message previews in Arabic and English, webhook addresses for STOP replies, a test send
// and the message log (last 200 messages — status only, never message texts).
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { translator } = require('../../core/i18n');
const { publicBase } = require('../../middleware/web');
const secrets = require('../../core/secrets');
const knex = require('../../db/knex');
const { render } = require('../settings/common');
const msg = require('./messaging.service');
const { errText } = require('./pages');

const router = express.Router();
router.use(can('settings.manage'));

async function previews(req, cfg) {
  const b = req.business;
  const sample = { doctor_name: req.t('messaging.sample_doctor'), appointment_date: req.ctx.today, appointment_time: '10:30' };
  const out = {};
  const texts = require('./texts.service'); // eslint-disable-line global-require
  for (const locale of ['ar', 'en']) {
    const own = await texts.translatorFor(req.ctx.businessId, locale); // eslint-disable-line no-await-in-loop
    const t = translator(locale);
    const vars = msg.messageVars({ ...sample, doctor_name: t('messaging.sample_doctor') }, b, locale);
    out[locale] = ['confirmation', 'reminder', 'review'].map((kind) => ({
      kind, text: msg.composeText(kind, vars, `${publicBase(req)}/${kind === 'review' ? 'review' : 'r'}/…`, locale, { t: own }),
    }));
  }
  out.cutoff = cfg.cancel_cutoff_hours;
  return out;
}

async function page(req, res, extra = {}) {
  const cfg = await msg.getConfig(req.ctx.businessId);
  const [logRows, summary, optedOut] = await Promise.all([
    msg.recentLog(req.ctx.businessId), msg.logSummary(req.ctx.businessId),
    knex('patients').where({ business_id: req.ctx.businessId, messaging_opt_out: true }).count({ n: '*' }).then((r) => Number(r[0].n)),
  ]);
  const base = publicBase(req);
  render(req, res, 'messaging', 'messaging', {
    title: req.t('settings.nav_messaging'), cfg, ready: msg.readiness(cfg), logRows, summary, optedOut, preview: await previews(req, cfg),
    hooks: {
      whatsapp: cfg.wa_hook_key ? `${base}/hooks/whatsapp/${cfg.wa_hook_key}` : null, verifyToken: cfg.wa_verify_token,
      sms: cfg.sms_inbound_key ? `${base}/hooks/sms/${cfg.sms_inbound_key}` : null,
      actionBase: `${base}/r/`, reviewBase: `${base}/review/`,
    },
    masks: { waToken: cfg.wa_token_enc ? secrets.mask(secrets.decrypt(cfg.wa_token_enc)) : null, appSecret: Boolean(cfg.wa_app_secret_enc), smsAuth: Boolean(cfg.sms_auth_enc) },
    dial: msg.dialFor(cfg, req.business),
    pageStyles: ['/css/admin.css', '/css/engage.css'],
    ...extra,
  });
}

router.get('/', wrap((req, res) => page(req, res)));

// Message texts: the clinic's own wording (Arabic / English) and where the review link goes.
async function textsPage(req, res, extra = {}) {
  const texts = require('./texts.service'); // eslint-disable-line global-require
  const m = await require('../website/marketing.service').get(req.ctx.businessId); // eslint-disable-line global-require
  render(req, res, 'message-texts', 'message_texts', { title: req.t('settings.nav_message_texts'), data: await texts.forPage(req.ctx.businessId), googleSet: Boolean(m && m.google && m.google.review), ...extra });
}
router.get('/texts', wrap((req, res) => textsPage(req, res)));
router.post('/texts', wrap(async (req, res) => {
  await require('./texts.service').save(req.ctx, req.body); // eslint-disable-line global-require
  flash(req, 'success', req.t('msgtexts.saved'));
  res.redirect('/app/settings/messaging/texts');
}));

router.post('/', form(async (req, res) => {
  await msg.saveSettings(req.ctx, req.body);
  flash(req, 'success', req.t('messaging.saved'));
  res.redirect('/app/settings/messaging');
}, (req, res, extra) => page(req, res, { ...extra, formError: extra.formError && { ...extra.formError, message: errText(req, extra.formError) } })));

router.post('/test', wrap(async (req, res) => {
  try {
    const r = await msg.sendTest(req.ctx, req.body.test_phone);
    flash(req, r.ok ? 'success' : 'error', r.ok ? req.t('messaging.test_ok', { channel: req.t(`messaging.channels.${r.channel}`) }) : `${req.t('messaging.test_fail')} ${r.error || ''}`.trim());
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    flash(req, 'error', err.code === 'VALIDATION_FAILED' ? req.t('messaging.test_phone_invalid') : errText(req, err));
  }
  res.redirect('/app/settings/messaging#test');
}));

module.exports = router;
