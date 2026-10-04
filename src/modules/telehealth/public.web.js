// The patient's consultation page /c/<token> (public, noindex): their own booking summary only — date and
// time in their time zone with a countdown, payment instructions while unpaid, "Join" from 10 minutes before
// the start until the end + grace, a camera/microphone check, the privacy note — and the video call itself.
// Signaling (built-in WebRTC call): POST /c/<token>/signal, GET /c/<token>/signal?after=<id> (short long-poll).
// The token is the only credential; nothing else about the clinic's patients is reachable from here.
const express = require('express');
const knex = require('../../db/knex');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const { wrap } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const businesses = require('../businesses/business.service');
const { clinicStyles } = require('../site/portal.web');
const tele = require('./telehealth.service');
const countries = require('./countries');

const router = express.Router();
const pageLimiter = rateLimit({ windowMs: 10 * 60_000, limit: config.isTest ? 5000 : 200, standardHeaders: true, legacyHeaders: false });
const signalLimiter = rateLimit({ windowMs: 60_000, limit: config.isTest ? 5000 : 400, standardHeaders: true, legacyHeaders: false, handler: (req, res) => res.status(429).json({ ok: false, error: 'rate_limited' }) });

/** CSP for consultation pages: only what the call needs (camera/mic preview and, for Jitsi, that one host in a frame). */
function relaxCsp(res, { frameHost } = {}) {
  const cur = String(res.getHeader('Content-Security-Policy') || '');
  if (!cur) return;
  let csp = cur.split(';').map((s) => s.trim()).filter((s) => s && !/^(media-src|frame-src)\b/.test(s));
  csp = [...csp, "media-src 'self' blob:", frameHost ? `frame-src ${frameHost}` : "frame-src 'none'"];
  res.setHeader('Content-Security-Policy', csp.join('; '));
  res.setHeader('Permissions-Policy', `camera=(self${frameHost ? ` "${frameHost}"` : ''}), microphone=(self${frameHost ? ` "${frameHost}"` : ''}), display-capture=(self${frameHost ? ` "${frameHost}"` : ''})`);
}

const clinicView = (req, b) => {
  const en = req.locale === 'en';
  const digits = (v) => String(v || '').replace(/[^0-9]/g, '');
  return {
    ...b, displayName: (en && b.name_en) || b.name,
    telHref: b.phone ? `tel:${String(b.phone).replace(/[^0-9+]/g, '')}` : null, waHref: digits(b.whatsapp) ? `https://wa.me/${digits(b.whatsapp)}` : null,
  };
};

/** Loads the consultation for :token or ends with a plain 404 (same answer for malformed and unknown tokens). */
// Which clinic's database has this consultation link (src/db/tenant.js).
router.param('token', require('../../db/tenant').byParam('tele', (token) => tele.byToken(token)));

async function load(req, res) {
  const row = await tele.byToken(req.params.token);
  if (!row) { res.status(404); return null; }
  const b = await businesses.get(row.business_id);
  if (!b || b.status !== 'active') { res.status(404); return null; }
  return { row, clinic: clinicView(req, b) };
}

const notFound = (req, res) => res.status(404).page('pages/error', {
  layout: 'public', title: req.t('telehealth.link_invalid_title'), status: 404, message: req.t('telehealth.link_invalid_text'), noindex: true, stack: null,
});

router.get('/:token', pageLimiter, wrap(async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  const found = await load(req, res);
  if (!found) return notFound(req, res);
  const { row, clinic } = found;
  const en = req.locale === 'en';
  const tz = tele.isZone(row.patient_timezone) ? row.patient_timezone : clinic.timezone;
  const win = tele.windowOf(row, clinic.timezone, 'patient');
  const method = tele.effectiveMethod(row);
  const jitsi = tele.jitsiBase();
  relaxCsp(res, { frameHost: method === 'jitsi' && jitsi ? new URL(jitsi).origin : null });
  res.locals.currency = clinic.currency;
  const settings = tele.clinicSettings(clinic, req.locale);
  const state = tele.stateOf(row);
  const local = tele.partsIn(win.startMs, tz);
  const clinicLocal = { date: row.appointment_date, time: row.appointment_time };
  return res.page('pages/telehealth/consult', {
    layout: 'public', title: req.t('telehealth.page_title'), pageTitle: `${req.t('telehealth.page_title')} · ${clinic.displayName}`, noindex: true, hideBookCta: true,
    clinic, row, state, tz, local, clinicLocal, win, method, settings, justBooked: req.query.new === '1',
    doctorPayLink: row.doctor_id ? tele.doctorOnline(await knex('doctors').where({ id: row.doctor_id, business_id: row.business_id }).first('online_pay_link') || {}).payLink : null, // the doctor's own payment page
    doctor: (en && row.doctor_name_en) || row.doctor_name, doctorSpec: (en ? row.doctor_spec_en || row.doctor_spec : row.doctor_spec || row.doctor_spec_en) || '',
    countryName: row.patient_country ? countries.regionName(row.patient_country, req.locale) : null, length: tele.lengthOf(row),
    tzOffset: tele.offsetLabel(tz, win.startMs), clinicOffset: tele.offsetLabel(clinic.timezone, win.startMs),
    call: {
      // Relay (TURN) passwords are given only when the call may start (POST /join), never in the page.
      role: 'patient', method, base: `/c/${req.params.token}`, ice: tele.iceServers().map((x) => ({ urls: x.urls })).filter((x) => [].concat(x.urls || []).every((u) => /^stuns?:/i.test(String(u)))), openMs: win.openMs, closeMs: win.closeMs, startMs: win.startMs, endMs: win.endMs, serverNow: Date.now(),
      state, jitsiUrl: method === 'jitsi' && jitsi && state === 'confirmed' ? `${jitsi}/${tele.jitsiRoom(row)}#config.prejoinPageEnabled=true&userInfo.displayName=${encodeURIComponent(JSON.stringify(row.patient_name))}` : null,
      link: method === 'link' && state === 'confirmed' ? row.online_link : null, locale: req.locale, tz,
    },
    pageStyles: [...clinicStyles(clinic), '/css/telehealth.css'], pageScripts: ['/js/telehealth.js'],
  });
}));

// Calendar file for the patient (UTC times — shown in the patient's own time zone by their calendar).
router.get('/:token/calendar.ics', pageLimiter, wrap(async (req, res) => {
  const found = await load(req, res);
  if (!found) return res.end();
  const { row, clinic } = found;
  const link = tele.linkFor(require('../../middleware/web').publicBase(req), req.params.token); // eslint-disable-line global-require
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="consultation-${row.appointment_date}.ics"`, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  return res.send(tele.icsFor({ ...row, locale: req.locale }, clinic, link, req.t));
}));

// Join: allowed only for a confirmed consultation inside its window; marks the patient as arrived.
router.post('/:token/join', signalLimiter, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const found = await load(req, res);
  if (!found) return res.json({ ok: false, error: 'not_found' });
  const { row, clinic } = found;
  if (!tele.canJoin(row, clinic.timezone, 'patient')) return res.status(403).json({ ok: false, error: req.t('errors_telehealth.JOIN_CLOSED') });
  await tele.markJoined(row, 'patient');
  return res.json({ ok: true, ice: tele.iceServers() });
}));

router.post('/:token/signal', signalLimiter, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const found = await load(req, res);
  if (!found) return res.json({ ok: false, error: 'not_found' });
  const { row, clinic } = found;
  if (!tele.canJoin(row, clinic.timezone, 'patient')) return res.status(403).json({ ok: false, error: req.t('errors_telehealth.JOIN_CLOSED') });
  try {
    if (req.body.kind === 'hello') await tele.markJoined(row, 'patient');
    const id = await tele.postSignal(row, 'patient', String(req.body.kind || ''), req.body.payload);
    return res.json({ ok: true, id });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return res.status(err.status).json({ ok: false, error: err.code });
  }
}));

router.get('/:token/signal', signalLimiter, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const found = await load(req, res);
  if (!found) return res.json({ ok: false, error: 'not_found' });
  const { row, clinic } = found;
  if (!tele.canJoin(row, clinic.timezone, 'patient')) return res.status(403).json({ ok: false, error: req.t('errors_telehealth.JOIN_CLOSED') });
  const wait = config.isTest ? 0 : Math.min(20_000, Math.max(0, Number(req.query.wait) || 0) * 1000);
  const out = await tele.pollSignals(row, 'patient', req.query.after === undefined ? null : req.query.after, wait);
  return res.json({ ok: true, ...out });
}));

module.exports = router;
module.exports.relaxCsp = relaxCsp;
