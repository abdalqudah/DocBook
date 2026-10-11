// The unsubscribe link in every bulk e-mail (/unsubscribe/<token>): the address is shown and one button stops every
// campaign e-mail to it. No account needed: the link itself is the key.
const express = require('express');
const { wrap } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const campaigns = require('./campaigns.service');

const router = express.Router();
const show = async (req, res, done) => {
  res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('Referrer-Policy', 'no-referrer');
  const r = await campaigns.byToken(req.params.token);
  if (!r) throw new AppError('NOT_FOUND', 'Page not found.', 404);
  const p = await require('../sales/sales.service').profile(); // eslint-disable-line global-require
  res.page('pages/sales/unsubscribe', { layout: 'document', title: req.t('camp.unsub_title'), r, done: done || r.done, token: req.params.token, p });
};
router.get('/unsubscribe/:token([a-f0-9]{40})', wrap((req, res) => show(req, res)));
router.post('/unsubscribe/:token([a-f0-9]{40})', wrap(async (req, res) => { await campaigns.unsubscribe(req.params.token); await show(req, res, true); }));

module.exports = router;
