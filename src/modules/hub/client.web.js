// Settings → DocBook platform (on an installation on the clinic's own server): link with the platform's address and
// the key the platform gave, sync now, unlink. The platform's offers and ads: a page for one offer, ad clicks, images.
const express = require('express');
const { can } = require('../../middleware/context');
const { wrap, flash } = require('../../routes/helpers');
const common = require('../settings/common');
const hub = require('./hub.service');

const router = express.Router();
router.get('/settings/hub', can('data.manage'), wrap(async (req, res) => {
  const c = await hub.client();
  return common.render(req, res, 'hub', 'hub', { c, linked: Boolean(c.enabled && c.key_enc) });
}));
router.post('/settings/hub', can('data.manage'), wrap(async (req, res) => {
  try {
    const r = await hub.saveClient(req.ctx, { hubUrl: req.body.hub_url, key: req.body.key });
    flash(req, 'success', req.t('hub.linked', { offers: r ? r.offers : 0, ads: r ? r.ads : 0 }));
  } catch (e) { flash(req, 'error', e.details ? Object.values(e.details).join(' ') : e.message); }
  res.redirect('/app/settings/hub');
}));
router.post('/settings/hub/sync', can('data.manage'), wrap(async (req, res) => {
  try { const r = await hub.sync(); flash(req, 'success', req.t('hub.synced', { offers: r ? r.offers : 0, ads: r ? r.ads : 0 })); } catch (e) { flash(req, 'error', e.message); }
  res.redirect('/app/settings/hub');
}));
router.post('/settings/hub/unlink', can('data.manage'), wrap(async (req, res) => {
  await hub.unlink(req.ctx);
  flash(req, 'success', req.t('hub.unlinked'));
  res.redirect('/app/settings/hub');
}));

// the platform's offers and ads, as cached here
router.get('/hub/offers/:id(\\d+)', wrap(async (req, res, next) => {
  const o = await hub.cachedOne('offer', req.params.id);
  if (!o) return next();
  return res.page('pages/marketplace/hub-offer', { title: (req.locale === 'en' && o.title_en) || o.title, o, pageStyles: ['/css/market.css'] });
}));
router.get('/hub/ad/:id(\\d+)', wrap(async (req, res, next) => {
  const a = await hub.cachedOne('ad', req.params.id);
  if (!a) return next();
  hub.adClick(a.remote_id);
  return res.redirect(a.offer_id && await hub.cachedOne('offer', a.offer_id) ? `/app/hub/offers/${a.offer_id}` : '/app/marketplace');
}));
router.get('/hub/image/:kind(offer|ad)/:id(\\d+)', wrap(async (req, res) => {
  const img = await hub.cachedImage(req.params.kind, req.params.id);
  if (!img || !img.data) return res.status(404).end();
  res.set({ 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff' });
  return res.send(img.data);
}));
module.exports = router;
