// Platform admin → Maintenance (/admin/maintenance): close the public site (or everything) with a message, reopen.
// Inside the super-admin router; every change is audited (maintenance.js).
const express = require('express');
const { wrap, flash } = require('../../routes/helpers');
const svc = require('./maintenance');

const router = express.Router();

router.get('/maintenance', wrap(async (req, res) => {
  res.page('pages/admin/maintenance', { layout: 'admin', title: req.t('maintenance.admin_title'), st: await svc.state(), pageStyles: ['/css/admin.css'] });
}));
router.post('/maintenance', wrap(async (req, res) => {
  const v = await svc.save(req.ctx, req.body);
  flash(req, 'success', req.t(v.on ? 'maintenance.saved_on' : 'maintenance.saved_off'));
  res.redirect('/admin/maintenance');
}));

module.exports = router;
