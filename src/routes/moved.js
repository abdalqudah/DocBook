// Moved pages (DocBook 2.0 redesign): an old GET address answers 301 with the new one, keeping the rest of the path
// and the query string, so bookmarks and links in e-mails keep working. Form posts to the old addresses still reach
// their handlers (the routers stay mounted there), so an old page left open in a tab can still be saved.
const express = require('express');

// [from, to, exact]: exact moves only the page itself (not the addresses under it, e.g. QR images).
const MOVES = [
  ['/settings/team', '/clinic/team'],
  ['/settings/roles', '/clinic/roles'],
  ['/settings/portal', '/website/settings', true],
  ['/settings/booking-links', '/website/booking/links', true],
  ['/settings/media', '/website/media', true],
  ['/reviews', '/website/reviews'],
];

const router = express.Router();
router.get('*', (req, res, next) => {
  const path = req.path.replace(/(.)\/+$/, '$1');
  for (const [from, to, exact] of MOVES) {
    if (path === from || (!exact && path.startsWith(`${from}/`))) {
      const q = req.originalUrl.indexOf('?');
      return res.redirect(301, `${req.baseUrl}${to}${path.slice(from.length)}${q === -1 ? '' : req.originalUrl.slice(q)}`);
    }
  }
  return next();
});

module.exports = router;
module.exports.MOVES = MOVES;
