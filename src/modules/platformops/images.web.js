// Platform admin → Compress old images (/admin/images): what can be made smaller, a start / stop button and the
// progress of the background job (polled as JSON). Mounted inside the super-admin router, so only platform admins
// reach it; starting and finishing are audited (imagecompress.service).
const express = require('express');
const { wrap, flash } = require('../../routes/helpers');
const svc = require('./imagecompress.service');

const router = express.Router();

router.get('/images', wrap(async (req, res) => {
  const [rows, done] = await Promise.all([svc.scan(), svc.history()]);
  res.page('pages/admin/images', {
    layout: 'admin', title: req.t('imgopt.title'), rows, done, job: svc.status(),
    pageStyles: ['/css/admin.css'], pageScripts: ['/js/imgopt.js'],
  });
}));
router.get('/images/status', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store').json({ job: svc.status(), done: await svc.history() });
}));
router.post('/images/start', wrap(async (req, res) => {
  const ok = await svc.start(req.ctx);
  flash(req, ok ? 'success' : 'error', req.t(ok ? 'imgopt.started' : 'imgopt.nothing'));
  res.redirect('/admin/images');
}));
router.post('/images/stop', wrap(async (req, res) => {
  svc.stop();
  flash(req, 'success', req.t('imgopt.stopping'));
  res.redirect('/admin/images');
}));

module.exports = router;
