// Maintenance mode page: Platform admin → Maintenance (/admin/maintenance) and, for the installation's own account, the
// clinic's Settings → Maintenance mode (/app/settings/maintenance). Every change is audited (maintenance.js).
const express = require('express');
const { wrap, flash } = require('../../routes/helpers');
const svc = require('./maintenance');

function mount(router, { path = '/maintenance', base = '/admin/maintenance', layout = 'admin' } = {}) {
  router.get(path, wrap(async (req, res) => {
    res.page('pages/admin/maintenance', { layout, title: req.t('maintenance.admin_title'), st: await svc.state(), base, pageStyles: ['/css/admin.css'] });
  }));
  router.post(path, wrap(async (req, res) => {
    const v = await svc.save(req.ctx, req.body);
    flash(req, 'success', req.t(v.on ? 'maintenance.saved_on' : 'maintenance.saved_off'));
    res.redirect(base);
  }));
}

const router = express.Router();
mount(router);

module.exports = router;
module.exports.mount = mount;
