// Settings → Your database: a one-way copy of the clinic's data in its own MySQL/PostgreSQL database.
const express = require('express');
const { AppError } = require('../../core/errors');
const { dictionaries, translateMessage } = require('../../core/i18n');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { render } = require('../settings/common');
const sync = require('./datasync.service');

const router = express.Router();
router.use(can('data.manage'));

/** Validation messages are authored in English; this area's own table first, then the shared one. */
function vmsg(locale, text) {
  const own = ((dictionaries[locale] || {}).errors_datasync || {}).vmsg || {};
  if (own[text]) return own[text];
  return locale === 'en' ? text : translateMessage(locale, text);
}

/** Readable text for a stored failure reason ("AUTH", "OTHER:driver message"…). */
function reasonText(req, stored) {
  if (!stored) return '';
  const i = String(stored).indexOf(':');
  const code = i >= 0 ? stored.slice(0, i) : stored;
  const detail = i >= 0 ? stored.slice(i + 1) : '';
  const key = `errors_datasync.${code}`;
  const text = req.t(key);
  return code === 'OTHER' || text === key ? `${req.t('errors_datasync.OTHER')}${detail ? ` (${detail})` : ''}` : text;
}

function codeText(req, err) {
  const key = `errors_datasync.${String(err.code || '').replace(/^DATASYNC_/, '')}`;
  const own = req.t(key);
  if (own !== key) return own;
  const shared = req.t(`errors.${err.code}`);
  return shared !== `errors.${err.code}` ? shared : err.message;
}

async function page(req, res, extra = {}) {
  const businessId = req.ctx.businessId;
  const [cfg, runs] = await Promise.all([sync.get(businessId), sync.runs(businessId)]);
  const allowed = sync.available(req.ctx);
  render(req, res, 'database', 'database', {
    title: req.t('datasync.title'), cfg, runs, allowed, DATASETS: sync.DATASETS, DEFAULT_DATASETS: sync.DEFAULT_DATASETS,
    FREQUENCIES: Object.keys(sync.FREQUENCIES), reasonText: (s) => reasonText(req, s), serverIp: process.env.SERVER_IP || '', ...extra,
  });
}

router.get('/', wrap((req, res) => page(req, res)));

// Save, then test the connection straight away so mistakes show now, not at the first scheduled copy.
router.post('/', wrap(async (req, res) => {
  try {
    await sync.save(req.ctx, req.body);
  } catch (err) {
    if (!(err instanceof AppError) || ![404, 409, 422].includes(err.status)) throw err;
    res.status(err.status);
    const errors = err.details && err.code === 'VALIDATION_FAILED' ? Object.fromEntries(Object.entries(err.details).map(([k, v]) => [k, vmsg(req.locale, v)])) : {};
    const body = { ...req.body };
    delete body.password;
    return page(req, res, { errors, formError: { code: err.code, message: codeText(req, err) }, old: body });
  }
  const t = await sync.test(req.ctx);
  flash(req, t.ok ? 'success' : 'error', t.ok ? req.t('datasync.saved_ok') : `${req.t('datasync.saved_fail')} ${reasonText(req, t.error)}`);
  return res.redirect('/app/settings/database');
}));

router.post('/test', wrap(async (req, res) => {
  if (!(await sync.get(req.ctx.businessId))) return res.redirect('/app/settings/database');
  const t = await sync.test(req.ctx);
  flash(req, t.ok ? 'success' : 'error', t.ok ? req.t('datasync.test_ok') : `${req.t('datasync.test_fail')} ${reasonText(req, t.error)}`);
  return res.redirect('/app/settings/database');
}));

router.post('/run', wrap(async (req, res) => {
  try {
    const r = await sync.run(req.ctx.businessId, { trigger: 'manual', userId: req.ctx.userId, ip: req.ctx.ip });
    const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
    flash(req, r.ok ? 'success' : 'error', r.ok ? req.t('datasync.run_ok', { n: total }) : `${req.t('datasync.run_fail')} ${reasonText(req, r.error)}`);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', codeText(req, e));
  }
  res.redirect('/app/settings/database');
}));

router.post('/remove', wrap(async (req, res) => {
  await sync.remove(req.ctx);
  flash(req, 'success', req.t('datasync.removed'));
  res.redirect('/app/settings/database');
}));

module.exports = router;
module.exports.reasonText = reasonText;
