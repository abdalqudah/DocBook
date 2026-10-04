// Additions to the patient's consultation page /c/<token> (mounted before the telehealth router):
//   GET  /c/:token                 prepares "Pay online" and "Your documents" for the page, then hands over
//   POST /c/:token/pay             starts an online payment → /pay/<payment id>
//   GET  /c/:token/docs/:id.pdf    a document the doctor shared (the token is the credential; every download audited)
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const audit = require('../../core/audit');
const knex = require('../../db/knex');
const { wrap } = require('../../routes/helpers');
const { AppError } = require('../../core/errors');
const { publicBase } = require('../../middleware/web');
const businesses = require('../businesses/business.service');
const tele = require('../telehealth/telehealth.service');
const pay = require('./payments.service');
const docs = require('../patientdocs/docs.service');

const router = express.Router();
const limiter = rateLimit({ windowMs: 10 * 60_000, limit: config.isTest ? 5000 : 60, standardHeaders: true, legacyHeaders: false });
const RECHECK_MS = 60_000;

async function load(token) {
  const row = await tele.byToken(token);
  if (!row) return null;
  const clinic = await businesses.get(row.business_id);
  if (!clinic || clinic.status !== 'active') return null;
  return { row, clinic };
}

/** Deadline of the slot hold (ms) — the booking's creation time + the clinic's hold minutes. */
async function holdUntil(row, gw) {
  if (!gw || !gw.holdMinutes) return null;
  const a = await knex('appointments').where({ id: row.appointment_id }).first('created_at');
  return a ? new Date(a.created_at).getTime() + gw.holdMinutes * 60_000 : null;
}

// Which clinic's database has this consultation link (src/db/tenant.js).
router.param('token', require('../../db/tenant').byParam('tele', (token) => tele.byToken(token)));

router.get('/:token', wrap(async (req, res, next) => {
  const found = await load(req.params.token);
  if (!found) return next();
  const { row, clinic } = found;
  let state = tele.stateOf(row);
  // A payment started earlier but never reported back (closed tab…): ask the provider again, at most once a minute.
  let last = await pay.lastPayment(clinic.id, row.appointment_id);
  if (last && last.status === 'initiated' && Date.now() - new Date(last.updated_at).getTime() > RECHECK_MS && Date.now() - new Date(last.created_at).getTime() < 6 * 3_600_000) {
    await knex('payments').where({ id: last.id }).update({ updated_at: new Date() });
    try {
      if (await pay.verify(last, { ip: req.ip, baseUrl: publicBase(req) }) === 'paid') {
        return res.redirect(303, `/c/${req.params.token}?pay=paid`);
      }
    } catch { /* provider unreachable: the page still works */ }
    last = await pay.lastPayment(clinic.id, row.appointment_id);
    state = tele.stateOf(await tele.byToken(req.params.token));
  }
  let payOnline = null;
  if (state === 'awaiting_payment') {
    const opt = await pay.onlineOption(clinic, row);
    if (opt && opt.payable) {
      const tz = tele.isZone(row.patient_timezone) ? row.patient_timezone : clinic.timezone;
      const until = await holdUntil(row, opt.gw);
      payOnline = {
        provider: opt.provider, test: opt.mode !== 'live', brands: opt.brands, amount: Number(row.amount_due), currency: clinic.currency,
        holdUntil: until ? { ...tele.partsIn(until, tz), tz, offset: tele.offsetLabel(tz, until) } : null,
        lastFailed: Boolean(last && last.status === 'failed'),
      };
    }
  }
  const shared = await docs.forPatient(clinic.id, row.appointment_id);
  res.locals.payExtras = {
    token: req.params.token, payOnline, result: ['paid', 'pending', 'failed', 'error'].includes(req.query.pay) ? req.query.pay : null,
    docs: shared.rows.map((d) => ({ id: d.id, kind: d.kind, label: docs.labelOf(d, req.t, shared.certs), date: d.created_at })),
  };
  return next();
}));

router.post('/:token/pay', limiter, wrap(async (req, res, next) => {
  const found = await load(req.params.token);
  if (!found) return next();
  const { row, clinic } = found;
  try {
    const out = await pay.start(clinic, row, {
      brand: String(req.body.brand || 'card'), baseUrl: publicBase(req), locale: req.locale, state: tele.stateOf(row), env: { ip: req.ip, userAgent: req.get('user-agent') },
    });
    return res.redirect(303, `/pay/${out.publicId}`);
  } catch (e) {
    if (!(e instanceof AppError) || (e.status >= 500 && e.status !== 502)) throw e;
    console.error('[payments] start failed:', e.code, e.message); // eslint-disable-line no-console
    return res.redirect(303, `/c/${req.params.token}?pay=error`);
  }
}));

router.get('/:token/docs/:id(\\d+).pdf', limiter, wrap(async (req, res, next) => {
  const found = await load(req.params.token);
  if (!found) return next();
  const { row, clinic } = found;
  const doc = await knex('patient_documents').where({ id: Number(req.params.id), business_id: clinic.id, appointment_id: row.appointment_id }).whereNull('revoked_at').first();
  if (!doc) return next();
  const ctx = { ...pay.systemCtx(clinic.id, { ip: req.ip, userAgent: req.get('user-agent'), locale: doc.locale, timezone: clinic.timezone, baseUrl: publicBase(req) }), ownDoctorId: null };
  const out = await docs.render(ctx, row.appointment_id, doc, doc.locale);
  await knex('patient_documents').where({ id: doc.id }).increment('downloads', 1);
  await audit.record(ctx, 'patient_docs.downloaded', { entityType: 'appointment', entityId: row.appointment_id, newValues: { document: doc.id, kind: doc.kind, by: 'patient' } });
  res.set({
    'Content-Type': 'application/pdf', 'Content-Length': String(out.pdf.length), 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${out.filename}"`,
  });
  return res.end(out.pdf);
}));

module.exports = router;
