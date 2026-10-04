// Public, token-protected iCal feed of one doctor's schedule: GET /calendar/<token>.ics (no login — calendar apps
// cannot sign in). "calendar" is a reserved clinic address, so this never shadows a clinic page.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { wrap } = require('../../routes/helpers');
const feeds = require('./feeds');

const router = express.Router();
const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

// Which clinic's database has this calendar (src/db/tenant.js).
router.param('token', require('../../db/tenant').byParam('ical', (token) => require('../../db/knex')('calendar_feeds').where({ token_hash: require('../../core/tokens').sha256(String(token)) }).first('id'))); // eslint-disable-line global-require

router.get('/:token([A-Za-z0-9_-]{20,64}).ics', limiter, wrap(async (req, res) => {
  const body = await feeds.render(req.params.token);
  if (!body) return res.status(404).type('text/plain').send('Not found');
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300', 'X-Robots-Tag': 'noindex', 'Content-Disposition': 'inline; filename="docbook.ics"' });
  return res.send(body);
}));

module.exports = router;
