// Sign-in page editor: Platform admin → Sign-in page (/admin/login-page) and, for the installation's own account, the
// clinic's Settings → Sign-in page (/app/settings/login-page). Saved texts show at once; audited (loginpage.js).
const { wrap, flash } = require('../../routes/helpers');
const svc = require('./loginpage');

function mount(router, { path = '/login-page', base = '/admin/login-page', layout = 'admin' } = {}) {
  router.get(path, wrap(async (req, res) => {
    res.page('pages/admin/login-page', { layout, title: req.t('loginpage.title'), lp: await svc.get(), base, styles: svc.STYLES, limits: svc.LIMITS, clinic: await svc.clinicOf(), pageStyles: ['/css/admin.css'] });
  }));
  router.post(path, wrap(async (req, res) => {
    await svc.save(req.ctx, req.body);
    flash(req, 'success', req.t('loginpage.saved'));
    res.redirect(base);
  }));
}

module.exports = { mount };
