// Platform admin → Website → Help articles. Mounted inside admin/web.js after its guard.
const express = require('express');
const { wrap, flash } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const help = require('./help.service');

const router = express.Router();
const page = (res, view, data) => res.page(`pages/admin/${view}`, { layout: 'admin', pageStyles: ['/css/site.css', '/css/admin.css'], ...data });
router.get('/help', wrap(async (req, res) => page(res, 'help-articles', { title: req.t('helpc.admin_title'), rows: await help.list({ all: true }), categories: help.CATEGORIES })));
async function form(req, res, extra = {}) {
  const a = req.params.id ? await help.get(req.params.id) : null;
  page(res, 'help-article-form', { title: a ? a.title_ar : req.t('helpc.new'), a, categories: help.CATEGORIES, errors: {}, old: null, ...extra });
}
router.get('/help/new', wrap((req, res) => form(req, res)));
router.get('/help/:id(\\d+)', wrap((req, res) => form(req, res)));
router.post(['/help/new', '/help/:id(\\d+)'], wrap(async (req, res) => {
  try { await help.save(req.ctx, req.params.id, req.body); } catch (e) {
    if (!(e instanceof AppError) || !e.details) throw e;
    res.status(422);
    return form(req, res, { errors: e.details, old: req.body });
  }
  flash(req, 'success', req.t('helpc.saved'));
  return res.redirect('/admin/help');
}));
router.post('/help/:id(\\d+)/delete', wrap(async (req, res) => {
  await help.remove(req.ctx, req.params.id);
  flash(req, 'success', req.t('helpc.deleted'));
  res.redirect('/admin/help');
}));

module.exports = router;
