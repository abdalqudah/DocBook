// Platform admin → Website → Country pages. Mounted inside admin/web.js after its guard.
const express = require('express');
const { wrap, flash } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const svc = require('./countrypages.service');

const router = express.Router();
const render = async (req, res, extra = {}) => res.page('pages/admin/country-pages', {
  layout: 'admin', pageStyles: ['/css/site.css', '/css/admin.css'], title: req.t('cpages.admin_title'), pages: await svc.all(), codes: svc.CODES,
  countryName: (cc) => require('../settings/options').regionName(cc, req.locale), errors: {}, old: null, ...extra, // eslint-disable-line global-require
});
router.get('/country-pages', wrap((req, res) => render(req, res)));
router.post('/country-pages', wrap(async (req, res) => {
  try { await svc.save(req.ctx, req.body); } catch (e) {
    if (!(e instanceof AppError) || !e.details) throw e;
    res.status(422);
    return render(req, res, { errors: e.details, old: req.body });
  }
  flash(req, 'success', req.t('cpages.saved'));
  return res.redirect('/admin/country-pages');
}));

module.exports = router;
