// /hub/v1 — the platform's API for linked installations (hub.service). Each call carries the link's key
// (Authorization: Bearer dbh_…); no session, no CSRF (no cookies are read here). JSON in and out.
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const hub = require('./hub.service');

const router = express.Router();
router.use(rateLimit({ windowMs: 60_000, limit: config.isTest ? 10_000 : 120, standardHeaders: true, legacyHeaders: false }));
router.use(express.json({ limit: '64kb' }));
router.use(async (req, res, next) => {
  try {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    const link = m ? await hub.linkOf(m[1]) : null;
    if (!link) return res.status(401).json({ error: 'KEY_REFUSED' });
    req.hubLink = link;
    res.set('Cache-Control', 'no-store');
    return next();
  } catch (e) { return next(e); }
});
const j = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

router.post('/hello', j(async (req, res) => res.json(await hub.hello(req.hubLink, req.body || {}))));
router.get('/offers', j(async (req, res) => res.json({ offers: await hub.offersFor(req.hubLink, req.query) })));
router.get('/ads', j(async (req, res) => res.json({ ads: await hub.adsFor(req.hubLink, req.query) })));
router.get('/:kind(offers|ads)/:id(\\d+)/image', j(async (req, res) => {
  const img = await hub.imageOf(req.params.kind === 'offers' ? 'offer' : 'ad', req.params.id);
  if (!img || !img.data) return res.status(404).end();
  res.set('Content-Type', /^image\/(png|jpe?g|webp|gif)$/.test(img.mime || '') ? img.mime : 'application/octet-stream');
  return res.send(img.data);
}));
router.post('/visits/status', j(async (req, res) => res.json(await hub.visitStatus(req.hubLink, req.body || {}))));
router.post('/ads/:id(\\d+)/click', j(async (req, res) => {
  await require('../vendorbilling/billing.service').adClick(req.params.id); // eslint-disable-line global-require
  res.json({ ok: true });
}));
router.use((err, req, res, next) => { console.error('[hub-api]', err.message); res.status(500).json({ error: 'SERVER_ERROR' }); }); // eslint-disable-line no-console, no-unused-vars

module.exports = router;
