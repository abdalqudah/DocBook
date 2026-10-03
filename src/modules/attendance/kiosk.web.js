// The door screen opened with its secret link (/kiosk/<token>) — no staff account on the device.
// Mounted at '/kiosk' in src/routes/web.js (public, before the clinic pages).
//  GET /kiosk/<token>        full-screen page: clinic logo + name, live clock, rotating QR, instruction, last check-ins
//  GET /kiosk/<token>/qr     JSON refresh every 10 s (new code + feed); also tells the screen it is still on
//  GET /kiosk/<token>/logo   the clinic logo (the /app logo route needs a signed-in member)
const express = require('express');
const { wrap } = require('../../routes/helpers');
const { phoneBase } = require('../../middleware/web');
const businesses = require('../businesses/business.service');
const svc = require('./attendance.service');
const kiosks = require('./kiosk.service');
const screenBrand = require('../../core/screen-brand');

const router = express.Router();

/** The screen and its clinic, or null (unknown / disabled link, suspended clinic, attendance module off). */
async function screenOf(token) {
  const k = await kiosks.byDisplayToken(token);
  if (!k) return null;
  const b = await businesses.get(k.business_id);
  if (!b || (b.status || 'active') !== 'active') return null;
  try {
    const ops = require('../platformops/ops.service'); // eslint-disable-line global-require
    if ((await ops.state(b)).off.has('attendance')) return null;
  } catch { /* modules service unavailable: keep the screen on */ }
  return { k, b };
}

router.get('/:token', wrap(async (req, res, next) => {
  const s = await screenOf(req.params.token);
  if (!s) return next();
  const { k, b } = s;
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  await kiosks.touch(k, req.ip);
  const reach = phoneBase(req);
  const [qr, feed] = await Promise.all([svc.currentQr(b.id, reach.base), svc.feed(b.id, b.timezone)]);
  return res.page('pages/attendance/kiosk', {
    layout: 'kiosk', title: `${b.name} · ${k.name}`, qr, reach, feed, src: `/kiosk/${req.params.token}/qr`, exitHref: null, screenName: k.name, showName: k.show_name !== false && k.show_name !== 0, message: k.message || '',
    clinic: { name: b.name, timezone: b.timezone, logoUrl: b.logo_mime ? `/kiosk/${req.params.token}/logo?v=${b.logo_version}` : null },
    pageStyles: ['/css/attendance.css'], pageScripts: ['/js/attendance.js'], ...screenBrand.locals(`/kiosk/${req.params.token}`, b),
  });
}));

router.get('/:token/qr', wrap(async (req, res) => {
  const s = await screenOf(req.params.token);
  res.set('Cache-Control', 'no-store');
  if (!s) return res.status(404).json({ error: { code: 'SCREEN_GONE' } });
  await kiosks.touch(s.k, req.ip);
  const [q, feed] = await Promise.all([svc.currentQr(s.b.id, phoneBase(req).base), svc.feed(s.b.id, s.b.timezone)]);
  return res.json({ data: { svg: q.svg, expiresIn: q.expiresIn, step: q.stepSeconds, feed, header: { showName: s.k.show_name !== false && s.k.show_name !== 0, message: s.k.message || '' } } });
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
