// Public, private-link invoice / receipt page (printable; "Save as PDF" from the browser's print dialog).
const express = require('express');
const { ah } = require('../../core/http');
const limits = require('../../middleware/limits');
const { E } = require('../../core/errors');
const settings = require('../settings/settings.service');
const inv = require('./invoices.service');
const { docHelpers } = require('./doc');

const router = express.Router();
router.get('/invoices/:token', ah(async (req, res) => {
  const i = await inv.byToken(req.params.token);
  if (!i) throw E.notFound('Invoice');
  res.set('X-Robots-Tag', 'noindex');
  const online = require('./online'); // eslint-disable-line global-require
  const canPayOnline = online.payable(i) && !!(await online.currentConfig());
  res.page('pages/finance-document', { layout: 'public', title: i.number, i, company: await settings.get('company'), ...docHelpers(i), canPayOnline, balance: online.balanceOf(i), seo: { noindex: true } });
}));

// Pay the open balance by card on Stripe's hosted checkout page.
router.post('/invoices/:token/pay', limits.publicForm, ah(async (req, res) => {
  const i = await inv.byToken(req.params.token);
  if (!i) throw E.notFound('Invoice');
  const online = require('./online'); // eslint-disable-line global-require
  if (!(await online.currentConfig())) throw new (require('../../core/errors').AppError)('PAYMENTS_NOT_CONNECTED', 'Online payment is not available. Please contact us to pay.', 409); // eslint-disable-line global-require
  const url = await online.startCheckout(i, { locale: req.locale });
  res.redirect(303, url);
}));
module.exports = router;
