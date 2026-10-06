// Public campaign endpoints: open pixel, tracked button (redirects only to the campaign's own link) and unsubscribe.
const express = require('express');
const { ah } = require('../../core/http');
const campaigns = require('./campaigns.service');

const router = express.Router();
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

router.get('/c/o/:token.gif', ah(async (req, res) => {
  await campaigns.markOpen(req.params.token).catch(() => {});
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, private' }).send(GIF);
}));
router.get('/c/c/:token', ah(async (req, res) => {
  const url = await campaigns.click(req.params.token);
  res.redirect(url || '/');
}));
router.get('/u/:token', ah(async (req, res) => {
  const r = await campaigns.byToken(req.params.token);
  res.status(r ? 200 : 404).page('pages/site/unsubscribe', { layout: 'public', title: req.t('unsub.title'), r, done: !!(r && r.unsubscribed_at), token: req.params.token, seo: { noindex: true } });
}));
router.post('/u/:token', ah(async (req, res) => {
  const ok = await campaigns.unsubscribe(req.params.token);
  if (req.body && req.body['List-Unsubscribe'] === 'One-Click') return res.status(ok ? 200 : 404).end(); // RFC 8058 one-click
  return res.status(ok ? 200 : 404).page('pages/site/unsubscribe', { layout: 'public', title: req.t('unsub.title'), r: ok ? {} : null, done: ok, token: req.params.token, seo: { noindex: true } });
}));
module.exports = router;
