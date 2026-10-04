// Public verification of medical documents: /verify/<code> (the address in the printed QR code) and /verify with a
// manual lookup form (serial + code). Shows VALID / REVOKED / NOT FOUND with only non-clinical facts (see
// certificates.service publicView). noindex, no caching, and rate-limited per IP: failed lookups are capped
// tightly (enumeration), all lookups more loosely.
const express = require('express');
const { wrap } = require('../../routes/helpers');
const businesses = require('../businesses/business.service');
const svc = require('./certificates.service');
const { localParts } = require('./web');

const router = express.Router();

const WINDOW_MS = 15 * 60_000;
const FAIL_LIMIT = 10; // wrong serial/code attempts per IP per window
const TOTAL_LIMIT = 120; // any lookups per IP per window
const hits = new Map();

function bucket(ip) {
  const now = Date.now();
  let b = hits.get(ip);
  if (!b || now - b.start > WINDOW_MS) { b = { start: now, fails: 0, total: 0 }; hits.set(ip, b); }
  if (hits.size > 50_000) { for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k); }
  return b;
}
const limited = (b) => b.fails >= FAIL_LIMIT || b.total >= TOTAL_LIMIT;

router.use((req, res, next) => {
  res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  next();
});

async function render(req, res, { state, row, form = {} }) {
  let clinic = null;
  let info = null;
  if (row) {
    const b = await businesses.get(row.business_id);
    info = svc.publicView(row, { locale: req.locale });
    const tz = (b && b.timezone) || 'UTC';
    info.issuedDate = localParts(tz, row.issued_at).date;
    info.revokedDate = row.revoked_at ? localParts(tz, row.revoked_at).date : null;
    clinic = b ? { name: info.clinicName, logo: b.logo_mime && b.slug ? `/${b.slug}/logo?v=${b.logo_version}` : null } : { name: info.clinicName, logo: null };
  }
  const status = { valid: 200, revoked: 200, not_found: 404, limited: 429, form: 200 }[state];
  res.status(status).page('pages/certificates/verify', {
    layout: 'public', title: req.t('verify_doc.title'), noindex: true, hideBookCta: true, state, info, issuer: clinic, form, pageStyles: ['/css/certs.css'],
  });
}

async function lookup(req, res, find, form) {
  const b = bucket(req.ip || 'unknown');
  if (limited(b)) return render(req, res, { state: 'limited', form });
  b.total += 1;
  const row = await find();
  if (!row) { b.fails += 1; return render(req, res, { state: 'not_found', form }); }
  return render(req, res, { state: row.revoked_at ? 'revoked' : 'valid', row, form });
}

// Which clinic's database has the document (src/db/tenant.js).
router.param('code', require('../../db/tenant').byParam('cert', (code) => svc.byCode(String(code || '').slice(0, 40))));
router.get('/', require('../../db/tenant').resolveBy((req) => (req.query.serial || req.query.code ? svc.bySerialAndCode(String(req.query.serial || '').slice(0, 40), String(req.query.code || '').slice(0, 40)) : null)), wrap(async (req, res) => {
  const serial = String(req.query.serial || '').slice(0, 40);
  const code = String(req.query.code || '').slice(0, 40);
  if (!serial && !code) return render(req, res, { state: 'form' });
  return lookup(req, res, () => svc.bySerialAndCode(serial, code), { serial, code });
}));

router.get('/:code', wrap(async (req, res) => {
  const code = String(req.params.code || '').slice(0, 40);
  return lookup(req, res, () => svc.byCode(code), { code: svc.normalizeCode(code) ? svc.formatCode(svc.normalizeCode(code)) : '' });
}));

module.exports = router;
module.exports.resetLimits = () => hits.clear();
module.exports.LIMITS = { WINDOW_MS, FAIL_LIMIT, TOTAL_LIMIT };
