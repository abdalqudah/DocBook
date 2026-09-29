// Platform admin → Reviews (/admin/reviews): moderation of verified patient reviews across clinics.
// Reported reviews first; hide an abusive review with a reason (audited, platform scope), show it again, or
// dismiss a clinic's report. Mounted inside admin/web.js after its platform-admin guard.
const express = require('express');
const { AppError } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const reviews = require('../reviews/reviews.service');
const { errText } = require('../messaging/pages');

const router = express.Router();

router.get('/reviews', wrap(async (req, res) => {
  const status = ['reported', 'hidden', 'all'].includes(req.query.status) ? req.query.status : 'reported';
  const q = String(req.query.q || '').trim().slice(0, 100);
  const data = await reviews.adminList({ status: status === 'all' ? '' : status, q, page: req.query.page });
  res.page('pages/admin/reviews', { layout: 'admin', pageStyles: ['/css/site.css', '/css/engage.css'], title: req.t('reviews.admin.title'), ...data, status, q });
}));

router.post('/reviews/:id(\\d+)/:action(hide|show|dismiss)', wrap(async (req, res) => {
  try {
    await reviews.moderate(req.ctx, req.params.id, req.params.action, req.body);
    flash(req, 'success', req.t(`reviews.admin.done_${req.params.action}`));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    flash(req, 'error', err.code === 'VALIDATION_FAILED' ? req.t('reviews.admin.reason_required') : errText(req, err));
  }
  const back = String(req.body.back || '');
  res.redirect(back.startsWith('/admin/reviews') && !back.startsWith('//') ? back : '/admin/reviews');
}));

module.exports = router;
