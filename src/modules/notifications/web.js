const express = require('express');
const { wrap } = require('../../routes/helpers');
const svc = require('./notification.service');

const router = express.Router();
router.get('/', wrap(async (req, res) => {
  res.page('pages/notifications/index', { title: req.t('notifications.title'), items: await svc.list(req.ctx, { limit: 100 }) });
}));
// The bell's drop-down: the latest notifications (HTML fragment, loaded when it opens).
router.get('/panel', wrap(async (req, res) => {
  const back = /^\/app(\/[\w\-/?=&.%]*)?$/.test(String(req.query.back || '')) ? String(req.query.back) : '/app';
  res.set('Cache-Control', 'no-store');
  res.render('partials/notif-panel', { items: await svc.list(req.ctx, { limit: 12 }), back });
}));
const safeBack = (v) => (typeof v === 'string' && /^\/app(\/[\w\-/?=&.%#]*)?$/.test(v) && !v.startsWith('//') ? v : null);
router.post('/read', wrap(async (req, res) => {
  await svc.markRead(req.ctx, req.body.id ? Number(req.body.id) : null);
  if ((req.get('accept') || '').includes('application/json')) return res.json({ ok: true, unread: await svc.unreadCount(req.ctx) });
  if (req.body.go && safeBack(req.body.go)) return res.redirect(req.body.go);
  return res.redirect(safeBack(req.body.back) || '/app/notifications');
}));
module.exports = router;
