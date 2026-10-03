// Platform admin → Articles (/admin/articles): doctors' articles asking to appear on the main site (/blog). Approve,
// or reject with a reason the clinic sees (audited in the clinic, the clinic is notified). Mounted after the admin guard.
const express = require('express');
const { AppError } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const articles = require('../articles/articles.service');

const router = express.Router();

router.get('/articles', wrap(async (req, res) => {
  const status = ['pending', 'approved', 'rejected', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = await articles.adminList({ status: status === 'all' ? '' : status });
  const items = await Promise.all(rows.map(async (r) => ({ row: r, art: await articles.present({ id: r.business_id, slug: r.clinic_slug }, r, req.locale) })));
  res.page('pages/admin/articles', { layout: 'admin', title: req.t('articles.admin.title'), items, status, pageStyles: ['/css/articles.css'] });
}));

router.post('/articles/:id(\\d+)/:action(approve|reject)', wrap(async (req, res) => {
  try {
    await articles.moderate(req.ctx || { userId: req.user.id }, req.params.id, req.params.action, req.body.note);
    flash(req, 'success', req.t(`articles.admin.done_${req.params.action}`));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    flash(req, 'error', err.code === 'VALIDATION_FAILED' ? req.t('articles.admin.reason_required') : err.message);
  }
  const back = String(req.body.back || '');
  res.redirect(back.startsWith('/admin/articles') && !back.startsWith('//') ? back : '/admin/articles');
}));

module.exports = router;
