// Public, private-link invoice / receipt page (printable; "Save as PDF" from the browser's print dialog).
const express = require('express');
const { ah } = require('../../core/http');
const { E } = require('../../core/errors');
const settings = require('../settings/settings.service');
const inv = require('./invoices.service');
const { docHelpers } = require('./doc');

const router = express.Router();
router.get('/invoices/:token', ah(async (req, res) => {
  const i = await inv.byToken(req.params.token);
  if (!i) throw E.notFound('Invoice');
  res.set('X-Robots-Tag', 'noindex');
  res.page('pages/finance-document', { layout: 'public', title: i.number, i, company: await settings.get('company'), ...docHelpers(i), seo: { noindex: true } });
}));
module.exports = router;
