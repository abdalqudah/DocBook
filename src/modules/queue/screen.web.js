// The waiting-room screen opened with its secret link (/queue/<token>) — no staff account on the TV.
// Mounted at '/queue' in src/routes/web.js (public, before the clinic pages).
//  GET /queue/<token>        full-screen page: going in now, next, waiting (with room numbers), rooms busy now
//  GET /queue/<token>/data   JSON polled every 2 s by public/js/queue.js (also tells the clinic the screen is on)
//  GET /queue/<token>/logo   the clinic logo (the /app logo route needs a signed-in member)
const express = require('express');
const { wrap } = require('../../routes/helpers');
const businesses = require('../businesses/business.service');
const svc = require('./queue.service');
const screenBrand = require('../../core/screen-brand');

const router = express.Router();

async function screenOf(token) {
  const k = await svc.byToken(token);
  if (!k) return null;
  const b = await businesses.get(k.business_id);
  if (!b || (b.status || 'active') !== 'active') return null;
  try {
    const ops = require('../platformops/ops.service'); // eslint-disable-line global-require
    if ((await ops.state(b)).off.has('queue_screens')) return null; // the clinic turned the waiting screen off
  } catch { /* modules service unavailable: keep the screen on */ }
  return { k, b };
}

// Which clinic's database has this waiting screen (src/db/tenant.js).
router.param('token', require('../../db/tenant').byParam('queue', (token) => screenOf(token)));

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' };

router.get('/:token', wrap(async (req, res, next) => {
  const s = await screenOf(req.params.token);
  if (!s) return next();
  const { k, b } = s;
  res.set(NO_STORE);
  await svc.touch(k);
  const board = await svc.board(k, b);
  const base = `/queue/${req.params.token}`;
  return res.page('pages/queue/screen', {
    layout: 'kiosk', kioskClass: 'qs-body', title: `${b.name} · ${k.name}`, board, showName: k.show_name !== false && k.show_name !== 0, message: k.message || '', src: `${base}/data`, exitHref: null,
    clinic: { name: req.locale === 'en' && b.name_en ? b.name_en : b.name, timezone: b.timezone, logoUrl: b.logo_mime ? `${base}/logo?v=${b.logo_version}` : null },
    pageStyles: ['/css/queue.css'], pageScripts: ['/js/queue.js'], ...screenBrand.locals(base, b),
  });
}));

router.get('/:token/data', wrap(async (req, res) => {
  const s = await screenOf(req.params.token);
  res.set(NO_STORE);
  if (!s) return res.status(404).json({ error: { code: 'SCREEN_GONE' } });
  await svc.touch(s.k);
  return res.json({ data: await svc.board(s.k, s.b) });
}));

screenBrand.addRoutes(router, screenOf); // the clinic's colours and browser icon

router.get('/:token/logo', wrap(async (req, res) => {
  const s = await screenOf(req.params.token);
  const row = s && await businesses.logo(s.b.id);
  if (!row || !row.logo) return res.status(404).end();
  res.set({ 'Content-Type': row.logo_mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  return res.send(row.logo);
}));

module.exports = router;
