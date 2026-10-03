// Notification pages for the platform admin (/admin/notifications) and reps (/vendor/notifications).
// Opening the page shows the list, then marks everything read.
const express = require('express');
const { wrap } = require('../../routes/helpers');
const notify = require('./notify.service');

function router(audience, base, layout) {
  const r = express.Router();
  const vid = (req) => (audience === 'vendor' ? req.vendor.id : null);
  r.get('/', wrap(async (req, res) => {
    const [items, unreadCount] = await Promise.all([notify.list(audience, vid(req), { limit: 100 }), notify.unread(audience, vid(req))]);
    res.page('pages/pnotify/index', { layout, title: req.t('pnotify.title'), items, unreadCount, base, pnText: (n) => notify.text(req.t, n) });
    await notify.markAllRead(audience, vid(req));
  }));
  r.post('/read', wrap(async (req, res) => {
    await notify.markAllRead(audience, vid(req));
    res.redirect(`${base}/notifications`);
  }));
  return r;
}

module.exports = { admin: () => router('admin', '/admin', 'admin'), vendor: () => router('vendor', '/vendor', 'vendor') };
