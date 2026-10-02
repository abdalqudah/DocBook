const express = require('express');
const { wrap } = require('../../routes/helpers');
const svc = require('./notification.service');
const { formatDate } = require('../../core/format');

/**
 * Notifications stored with a machine word in the text (online bookings: body 'online' / 'telehealth', title
 * "name · date time") read as a sentence in the member's language.
 */
function readable(req, rows) {
  return rows.map((n) => {
    if (n.type === 'patient.called_in') return { ...n, title: req.t('notifications.called_in.title', { name: n.title }), body: n.body ? req.t('notifications.called_in.body', { doctor: n.body }) : req.t('notifications.called_in.body_none') };
    if (n.type !== 'appointment.booked_online' || !['online', 'telehealth'].includes(n.body)) return n;
    const m = String(n.title || '').match(/^(.*) · (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
    if (!m) return { ...n, body: req.t(`notifications.booked.${n.body}`) };
    let day = m[2];
    try { day = formatDate(m[2], req.locale, { weekday: 'long', day: 'numeric', month: 'long' }); } catch { /* the stored date */ }
    return { ...n, title: req.t(`notifications.booked.${n.body}_title`, { name: m[1] }), body: req.t('notifications.booked.when', { day, time: m[3] }) };
  });
}

const router = express.Router();
router.get('/', wrap(async (req, res) => {
  res.page('pages/notifications/index', { title: req.t('notifications.title'), items: readable(req, await svc.list(req.ctx, { limit: 100 })) });
}));
// The bell's drop-down: the latest notifications (HTML fragment, loaded when it opens).
router.get('/panel', wrap(async (req, res) => {
  const back = /^\/app(\/[\w\-/?=&.%]*)?$/.test(String(req.query.back || '')) ? String(req.query.back) : '/app';
  res.set('Cache-Control', 'no-store');
  res.render('partials/notif-panel', { items: readable(req, await svc.list(req.ctx, { limit: 12 })), back });
}));
const safeBack = (v) => (typeof v === 'string' && /^\/app(\/[\w\-/?=&.%#]*)?$/.test(v) && !v.startsWith('//') ? v : null);
router.post('/read', wrap(async (req, res) => {
  await svc.markRead(req.ctx, req.body.id ? Number(req.body.id) : null);
  if ((req.get('accept') || '').includes('application/json')) return res.json({ ok: true, unread: await svc.unreadCount(req.ctx) });
  if (req.body.go && safeBack(req.body.go)) return res.redirect(req.body.go);
  return res.redirect(safeBack(req.body.back) || '/app/notifications');
}));
module.exports = router;
module.exports.readable = readable;
