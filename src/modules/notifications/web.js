const express = require('express');
const { wrap } = require('../../routes/helpers');
const svc = require('./notification.service');

const router = express.Router();
router.get('/', wrap(async (req, res) => {
  res.page('pages/notifications/index', { title: req.t('notifications.title'), items: await svc.list(req.ctx, { limit: 100 }) });
}));
router.post('/read', wrap(async (req, res) => {
  await svc.markRead(req.ctx, req.body.id ? Number(req.body.id) : null);
  if (req.body.go && String(req.body.go).startsWith('/app')) return res.redirect(req.body.go);
  return res.redirect('/app/notifications');
}));
module.exports = router;
