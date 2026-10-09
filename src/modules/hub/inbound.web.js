// /hub-in/v1 — on an installation linked to the platform: the platform's calls for reps' visits (live). Each call
// carries the secret this installation gave in its hello (Authorization: Bearer …); no session, no CSRF.
//   GET  /rep/clinic            the clinic's rep-visit mode and doctors (only what a rep may see)
//   GET  /rep/slots?doctor_id&date   free times
//   POST /rep/book              a rep's booking → the clinic's own rep visits (a local stand-in for the rep)
//   POST /rep/cancel            the rep cancelled
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const knex = require('../../db/knex');
const tenant = require('../../db/tenant');
const secrets = require('../../core/secrets');
const { AppError } = require('../../core/errors');
const hub = require('./hub.service');

const router = express.Router();
router.use(rateLimit({ windowMs: 60_000, limit: config.isTest ? 10_000 : 120, standardHeaders: true, legacyHeaders: false }));
router.use(express.json({ limit: '32kb' }));
const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
router.use(async (req, res, next) => {
  try {
    const c = await hub.client();
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    let secret = null; try { secret = c.callback_enc ? secrets.decrypt(c.callback_enc) : null; } catch { secret = null; }
    if (!c.enabled || !secret || !m || !same(m[1], secret)) return res.status(401).json({ code: 'REFUSED' });
    const clinic = await hub.ownClinic();
    if (!clinic) return res.status(404).json({ code: 'NO_CLINIC' });
    req.hubClinic = clinic;
    res.set('Cache-Control', 'no-store');
    return tenant.runFor(clinic.id, () => next()).catch(next);
  } catch (e) { return next(e); }
});
const j = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const rv = () => require('../marketplace/rep-visits.service'); // eslint-disable-line global-require

router.get('/rep/clinic', j(async (req, res) => {
  const c = await rv().clinicForRep(req.hubClinic.id);
  if (!c) return res.status(404).json({ code: 'REP_VISITS_OFF', message: 'This clinic does not take rep visits now.' });
  return res.json({ name: c.name, name_en: c.name_en, city: c.city, specialty: c.specialty, timezone: c.timezone, mode: c.mode, hasClinicWide: c.hasClinicWide, doctors: c.doctors.map((d) => ({ id: d.id, full_name: d.full_name, full_name_en: d.full_name_en, hours: d.hours || null })) });
}));
router.get('/rep/slots', j(async (req, res) => {
  const slots = await rv().freeSlots({ businessId: req.hubClinic.id, doctorId: Number(req.query.doctor_id) || null, date: String(req.query.date || ''), timezone: req.hubClinic.timezone || 'Asia/Amman' });
  res.json({ slots });
}));

/** The rep of the platform → a local stand-in (vendors.hub_vendor_id), kept up to date. */
async function standIn(v) {
  const hubId = Number(v && v.hub_id) || 0;
  if (!hubId) throw new AppError('BAD_REQUEST', 'No rep.', 422);
  const clip = (x, n) => (x ? String(x).slice(0, n) : null);
  const row = { type: ['rep', 'warehouse', 'company'].includes(v.type) ? v.type : 'rep', name: clip(v.name, 190) || 'Rep', name_en: clip(v.name_en, 190), phone: clip(v.phone, 40), whatsapp: clip(v.whatsapp, 40), email: clip(v.email, 190) || `rep-${hubId}@platform.invalid`, city: clip(v.city, 100), status: 'active', updated_at: new Date() };
  const have = await knex('vendors').where({ hub_vendor_id: hubId }).first('id');
  if (have) { await knex('vendors').where({ id: have.id }).update(row); return knex('vendors').where({ id: have.id }).first(); }
  const [id] = await knex('vendors').insert({ ...row, hub_vendor_id: hubId, approved_at: new Date() });
  return knex('vendors').where({ id }).first();
}
router.post('/rep/book', j(async (req, res) => {
  const vendor = await standIn(req.body.vendor);
  const r = await rv().book({ userId: null, ip: req.ip, userAgent: 'platform' }, vendor, { ...req.body, business_id: req.hubClinic.id });
  const v = await knex('rep_visits as r').leftJoin('doctors as d', 'd.id', 'r.doctor_id').where('r.id', r.id).first('r.id', 'r.visit_date', 'r.visit_time', 'r.status', 'd.full_name as doctor_name');
  res.json({ id: v.id, status: v.status, visit_date: String(v.visit_date).slice(0, 10), visit_time: v.visit_time, doctor_name: v.doctor_name });
}));
router.post('/rep/cancel', j(async (req, res) => {
  const vendor = await knex('vendors').where({ hub_vendor_id: Number(req.body.hub_vendor_id) || 0 }).first('id');
  if (!vendor) return res.status(404).json({ code: 'NOT_FOUND' });
  await rv().cancelByVendor({ vendorId: vendor.id, userId: null }, req.body.id);
  return res.json({ ok: true });
}));
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof AppError) return res.status(err.status === 404 ? 404 : 422).json({ code: err.code, message: err.message, details: err.details });
  console.error('[hub-in]', err.message); // eslint-disable-line no-console
  return res.status(500).json({ code: 'SERVER_ERROR' });
});
module.exports = router;
