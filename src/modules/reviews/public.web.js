// /review/<token>: the verified review form sent after a visit (public, noindex). One review per appointment,
// only for visits that happened (completed or paid), link valid 30 days. Honeypot field + rate limit.
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const { wrap } = require('../../routes/helpers');
const { AppError, E } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const { publicBase } = require('../../middleware/web');
const businesses = require('../businesses/business.service');
const { clinicStyles } = require('../site/portal.web');
const msg = require('../messaging/messaging.service');
const { clinicView, noStore, notFound, errText } = require('../messaging/pages');
const reviews = require('./reviews.service');

const router = express.Router();
const pageLimiter = rateLimit({ windowMs: 10 * 60_000, limit: config.isTest ? 5000 : 120, standardHeaders: true, legacyHeaders: false });
const postLimiter = rateLimit({ windowMs: 60 * 60_000, limit: config.isTest ? 5000 : 10, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(E.rateLimited()) });

async function load(req) {
  const link = await msg.byToken(req.params.token, 'review');
  if (!link) return null;
  const b = await businesses.get(link.business_id);
  if (!b || b.status !== 'active') return null;
  return { link, clinic: clinicView(req, b), state: await reviews.linkState(link) };
}

function page(req, res, found, extra = {}) {
  const { link, clinic, state } = found;
  const en = req.locale === 'en';
  return res.page('pages/engage/review', {
    layout: 'public', title: req.t('reviews.page_title'), pageTitle: `${req.t('reviews.page_title')} · ${clinic.displayName}`, noindex: true, hideBookCta: true,
    clinic, state, token: req.params.token, doctor: (en && link.doctor_name_en) || link.doctor_name, visitDate: link.appointment_date,
    patientName: link.patient_name, maxComment: reviews.MAX_COMMENT, thanks: req.query.done === '1',
    pageStyles: [...clinicStyles(clinic), '/css/engage.css'], pageScripts: ['/js/engage.js'], ...extra,
  });
}

// Which clinic's database has this review link (src/db/tenant.js).
router.param('token', require('../../db/tenant').byParam('review', (token) => msg.byToken(token, 'review')));

router.get('/:token', pageLimiter, wrap(async (req, res) => {
  noStore(res);
  const found = await load(req);
  if (!found) return notFound(req, res);
  if (found.state === 'expired') return notFound(req, res);
  return page(req, res, found);
}));

router.post('/:token', postLimiter, wrap(async (req, res) => {
  noStore(res);
  const found = await load(req);
  if (!found || found.state === 'expired') return notFound(req, res);
  // Honeypot: people never see this field; bots fill it. Answer as if it worked, save nothing.
  if (String(req.body.website || '').trim()) return res.redirect(303, `/review/${req.params.token}?done=1`);
  try {
    await reviews.submit(found.link, req.body, { ip: req.ip, userAgent: req.get('user-agent'), locale: req.locale, base: publicBase(req) });
    return res.redirect(303, `/review/${req.params.token}?done=1`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    res.status(err.status);
    const errors = err.code === 'VALIDATION_FAILED' && err.details ? Object.fromEntries(Object.entries(err.details).map(([k, v]) => [k, translateMessage(req.locale, v)])) : {};
    return page(req, res, { ...found, state: await reviews.linkState(found.link) }, { errors, old: req.body, formError: err.code === 'VALIDATION_FAILED' ? null : { code: err.code, message: errText(req, err) } });
  }
}));

// Opt-out from the review message too.
router.post('/:token/stop', postLimiter, wrap(async (req, res) => {
  noStore(res);
  const found = await load(req);
  if (!found) return notFound(req, res);
  const cfg = await msg.getConfig(found.clinic.id);
  await msg.setOptOut(found.link.business_id, { patientId: found.link.patient_id, phone: found.link.patient_phone, dial: msg.dialFor(cfg, found.clinic) }, true, { ip: req.ip, userAgent: req.get('user-agent'), via: 'review_link' });
  return page(req, res, found, { stopped: true });
}));

module.exports = router;
