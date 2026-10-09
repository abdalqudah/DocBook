// Platform admin → Linked installations: a key for each DocBook installed on a clinic's own server (shown once).
const express = require('express');
const { wrap, flash } = require('../../routes/helpers');
const hub = require('./hub.service');

const router = express.Router();
router.get('/hub-links', wrap(async (req, res) => {
  const fresh = req.session.hubNewKey || null;
  delete req.session.hubNewKey;
  res.page('pages/admin/hub-links', { layout: 'admin', title: req.t('hub.admin_title'), links: await hub.links(), fresh, pageStyles: ['/css/admin.css'] });
}));
router.post('/hub-links', wrap(async (req, res) => {
  const r = await hub.createLink({ userId: req.user.id }, req.body.label);
  req.session.hubNewKey = { id: r.id, key: r.key };
  res.redirect('/admin/hub-links');
}));
router.post('/hub-links/:id(\\d+)/revoke', wrap(async (req, res) => {
  await hub.revokeLink({ userId: req.user.id }, req.params.id);
  flash(req, 'success', req.t('hub.revoked'));
  res.redirect('/admin/hub-links');
}));
module.exports = router;
