// Public images of a clinic's media library: /m/<clinic slug>/<id> (mounted at /m in routes/web.js).
// Only images the clinic marked public are served (the clinic page cover and gallery); PDFs and private files
// answer 404. The type comes from the file's own bytes; nosniff and "default-src 'none'" keep it inert.
const express = require('express');
const { wrap } = require('../../routes/helpers');
const media = require('./media.service');

const router = express.Router();
const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'cross-origin' };

router.param('slug', require('../../db/tenant').slugParam); // the clinic's own database (src/db/tenant.js)
router.get('/:slug([a-z0-9-]{3,40})/:id(\\d{1,10})', wrap(async (req, res) => {
  const row = await media.publicFile(req.params.slug, req.params.id);
  // The address carries the image's fingerprint (?v=<sha>, as the site writes it): numbers alone cannot be walked
  // through to find images the clinic did not put on its pages.
  const v = String(req.query.v || '');
  const shaOk = row && row.sha && v.length >= 8 && String(row.sha).startsWith(v);
  const mime = row && shaOk ? media.sniff(row.data) : null;
  if (!row || !shaOk || !mime || !media.IMAGE_MIMES.includes(mime)) return res.status(404).set({ ...HEADERS, 'Cache-Control': 'no-store' }).end();
  if (req.get('if-none-match') === `"${row.sha}"`) return res.status(304).set({ ...HEADERS, ETag: `"${row.sha}"` }).end();
  res.set({ ...HEADERS, 'Content-Type': mime, ETag: `"${row.sha}"`, 'Cache-Control': 'public, max-age=86400' });
  return res.send(row.data);
}));

module.exports = router;
