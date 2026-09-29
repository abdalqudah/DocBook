// Platform admin → Google sign-in (OAuth client) and clinic custom domains.
// Mounted inside admin/web.js after its platform-admin guard (req.ctx is the platform scope).
const express = require('express');
const { AppError } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { form } = require('../settings/form');
const google = require('../auth/google.service');
const { errorText } = require('../auth/google.web');
const domains = require('../branding/domain.service');

const router = express.Router();
const page = (res, view, data) => res.page(`pages/admin/${view}`, { layout: 'admin', pageStyles: ['/css/site.css', '/css/admin.css'], ...data });

// ---------------------------------------------------------------- Google sign-in
const renderGoogle = async (req, res, extra = {}) => {
  const g = await google.settings();
  let origin = google.appBase();
  try { origin = new URL(origin).origin; } catch { /* keep */ }
  page(res, 'google', { title: req.t('identity.admin_google_title'), g, secretHint: google.secretHint(g), redirectUri: google.redirectUri(), origin, ...extra });
};
router.get('/google', wrap((req, res) => renderGoogle(req, res)));
router.post('/google', form(async (req, res) => {
  await google.save(req.ctx, req.body);
  flash(req, 'success', req.t('identity.admin_google_saved'));
  res.redirect('/admin/google');
}, (req, res, extra) => renderGoogle(req, res, { ...extra, formError: extra.formError && extra.formError.code !== 'VALIDATION_FAILED' ? { ...extra.formError, message: errorText(req, extra.formError) } : extra.formError })));

// ---------------------------------------------------------------- custom domains
const STATUSES = ['pending', 'verified', 'suspended'];
const renderDomains = async (req, res, extra = {}) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const all = await domains.list();
  const counts = Object.fromEntries(STATUSES.map((s) => [s, all.filter((r) => r.status === s).length]));
  page(res, 'domains', {
    title: req.t('identity.admin_domains_title'), rows: status ? all.filter((r) => r.status === status) : all, total: all.length, counts, status,
    platformHost: domains.platformHost(), serverIps: domains.records({ host: 'x', token: '' }).serverIps, ...extra,
  });
};
router.get('/domains', wrap((req, res) => renderDomains(req, res)));

const act = (fn) => wrap(async (req, res) => {
  const id = Number(req.params.id);
  try {
    const msg = await fn(req, id);
    if (msg) flash(req, msg[0], msg[1]);
  } catch (err) {
    if (!(err instanceof AppError) || err.status >= 500) throw err;
    flash(req, 'error', errorText(req, err));
  }
  res.redirect('/admin/domains');
});
router.post('/domains/:id(\\d+)/check', act(async (req, id) => {
  const row = await domains.byId(id);
  const r = await domains.check(req.ctx, row.business_id);
  if (r.justVerified) return ['success', req.t('identity.domain_now_live')];
  if (r.live) return ['info', req.t(r.owned ? 'identity.domain_still_live' : 'identity.domain_keep_txt')];
  if (r.conflict) return ['error', req.t('errors_identity.DOMAIN_TAKEN')];
  return ['warning', req.t(!r.owned ? 'identity.domain_missing_txt' : 'identity.domain_missing_cname')];
}));
router.post('/domains/:id(\\d+)/approve', act(async (req, id) => { await domains.approve(req.ctx, id); return ['success', req.t('identity.admin_domain_approved')]; }));
router.post('/domains/:id(\\d+)/suspend', act(async (req, id) => { await domains.suspend(req.ctx, id); return ['success', req.t('identity.admin_domain_suspended')]; }));
router.post('/domains/:id(\\d+)/resume', act(async (req, id) => {
  const r = await domains.resume(req.ctx, id);
  return ['success', req.t(r && r.live ? 'identity.domain_now_live' : 'identity.admin_domain_resumed')];
}));

module.exports = router;
