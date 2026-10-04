// Staff side of online consultations (/app/telehealth): clinic settings, the consultation link (copy, e-mail
// again, WhatsApp), payment received in advance, confirmation, the patient's files (clinical.view only) and
// the doctor's side of the video call (clinical.edit; appointments.get keeps a doctor to their own schedule).
const express = require('express');
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const { AppError, E } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { publicBase } = require('../../middleware/web');
const appts = require('../clinic/appointments.service');
const tele = require('./telehealth.service');
const countries = require('./countries');
const { relaxCsp } = require('./public.web');

const router = express.Router();
const errText = (req, e) => { for (const k of [`errors_telehealth.${e.code}`, `errors.${e.code}`]) { const s = req.t(k); if (s !== k) return s; } return e.message; };
const digits = (v) => String(v || '').replace(/[^0-9]/g, '');

/** Everything the online-consultation panels (appointment page, visit page) need. Null for other appointments. */
async function panelData(req, a, { res } = {}) {
  if (!a || a.appointment_type !== 'online') return null;
  const { ctx } = req;
  const b = req.business;
  const { row, token } = await tele.forAppointment(ctx, a);
  const link = tele.linkFor(publicBase(req), token);
  const tz = tele.isZone(row.patient_timezone) ? row.patient_timezone : b.timezone;
  const win = tele.windowOf(row, b.timezone, 'doctor');
  const pWin = tele.windowOf(row, b.timezone, 'patient');
  const method = tele.effectiveMethod(row);
  const clinicalView = ctx.permissions.has('clinical.view');
  const files = clinicalView ? await tele.filesOf(ctx.businessId, row.id) : [];
  const jitsi = tele.jitsiBase();
  if (res) relaxCsp(res, { frameHost: method === 'jitsi' && jitsi ? new URL(jitsi).origin : null });
  const clinicName = (req.locale === 'en' && b.name_en) || b.name;
  const state = tele.stateOf(row);
  return {
    row, link, state, tz, tzOffset: tele.offsetLabel(tz, win.startMs), local: tele.partsIn(win.startMs, tz), win, pWin, method, files,
    reason: clinicalView ? row.reason : null, countryName: row.patient_country ? countries.regionName(row.patient_country, req.locale) : null,
    mailOn: mailer.configured(), paymentRequired: Boolean(row.payment_required), paid: row.payment_status === 'paid',
    waHref: digits(row.patient_phone) ? `https://wa.me/${digits(row.patient_phone)}?text=${encodeURIComponent(req.t('telehealth.staff.wa_text', { clinic: clinicName, link }))}` : null,
    canVideo: ctx.permissions.has('clinical.edit') && ['confirmed', 'pending'].includes(state),
    call: {
      role: 'doctor', method, base: `/app/telehealth/${a.id}`, ice: tele.iceServers(), openMs: win.openMs, closeMs: win.closeMs, startMs: win.startMs, endMs: win.endMs,
      serverNow: Date.now(), state, locale: req.locale, tz: b.timezone,
      jitsiUrl: method === 'jitsi' && jitsi ? `${jitsi}/${tele.jitsiRoom(row)}#config.prejoinPageEnabled=true&userInfo.displayName=${encodeURIComponent(JSON.stringify(req.ctx.userName || ''))}` : null,
      link: method === 'link' ? row.online_link : null,
    },
  };
}

/** Consultation links for the online appointments of a list (front desk "copy link"). */
async function linksFor(req, rows) {
  const out = {};
  for (const a of rows.filter((r) => r.appointment_type === 'online' && r.status !== 'cancelled')) {
    const { token } = await tele.forAppointment(req.ctx, a); // eslint-disable-line no-await-in-loop
    out[a.id] = tele.linkFor(publicBase(req), token);
  }
  return out;
}

// ---------------------------------------------------------------- clinic settings (Settings → Clinic page)
router.post('/settings', canAny('website.edit', 'settings.manage'), wrap(async (req, res) => {
  try {
    await tele.saveSettings(req.ctx, req.body);
    flash(req, 'success', req.t('telehealth.settings.saved'));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', e.code === 'VALIDATION_FAILED' && e.details && e.details.online_payment_instructions ? req.t('telehealth.settings.instructions_required') : errText(req, e));
  }
  res.redirect('/app/website/booking#telehealth');
}));

// ---------------------------------------------------------------- the doctor's own online consultations
// A doctor turns their online consultations on or off, sets the price and length, the video method and their own
// payment link — without needing access to the clinic's doctor settings.
const scheduling = require('../clinic/scheduling');
const businesses = require('../businesses/business.service');
const ownDoctor = (req) => req.ctx.ownDoctorId || req.ctx.doctorId || null;
async function renderMine(req, res, extra = {}) {
  const id = ownDoctor(req);
  if (!id) throw E.notFound('Doctor');
  const doctor = await knex('doctors').where({ id, business_id: req.ctx.businessId }).first();
  if (!doctor) throw E.notFound('Doctor');
  res.page('pages/telehealth/mine', {
    title: req.t('nav.my_online'), doctor, days: scheduling.DAY_KEYS, onlineWindows: tele.windowsByDay(await tele.windowsOf(req.ctx.businessId, id)),
    jitsiReady: Boolean(tele.jitsiBase()), clinicOnline: true, currency: req.ctx.currency, old: {}, errors: {}, ...extra,
  });
}
router.get('/mine', wrap((req, res) => renderMine(req, res)));
router.post('/mine', wrap(async (req, res) => {
  const id = ownDoctor(req);
  if (!id) throw E.notFound('Doctor');
  try {
    const parsed = tele.parseDoctorOnline(req.body);
    await tele.applyDoctorOnline(req.ctx, id, parsed);
    // A doctor who turns it on wants patients to see it: open online consultations for the clinic too.
    if (parsed.row.online_enabled && !req.business.online_enabled) {
      await knex('businesses').where({ id: req.ctx.businessId }).update({ online_enabled: true, updated_at: new Date() });
      await audit.record(req.ctx, 'clinic.telehealth_updated', { entityType: 'clinic', entityId: req.ctx.businessId, oldValues: { online_enabled: false }, newValues: { online_enabled: true, by_doctor: id } });
      businesses.forget(req.ctx.businessId);
    }
  } catch (e) {
    if (!(e instanceof AppError) || e.code !== 'VALIDATION_FAILED') throw e;
    const { translateMessage } = require('../../core/i18n'); // eslint-disable-line global-require
    res.status(422);
    return renderMine(req, res, { old: req.body, errors: Object.fromEntries(Object.entries(e.details || {}).map(([k, v]) => [k, translateMessage(req.locale, v)])), formError: { code: e.code, message: req.t('errors.VALIDATION_FAILED') } });
  }
  flash(req, 'success', req.t('telehealth.mine.saved'));
  return res.redirect('/app/telehealth/mine');
}));

// ---------------------------------------------------------------- one consultation
const load = async (req) => {
  const a = await appts.get(req.ctx, Number(req.params.id)); // clinic + a doctor's own schedule
  if (a.appointment_type !== 'online') throw E.notFound('Online consultation');
  const { row } = await tele.forAppointment(req.ctx, a);
  return { a, row };
};
const backTo = (req, id) => (String(req.body.return_to || '').startsWith('/app/visits/') ? `/app/visits/${id}` : `/app/appointments/${id}`);

router.post('/:id(\\d+)/send', can('appointments.manage'), wrap(async (req, res) => {
  const { a } = await load(req);
  req.ctx.baseUrl = publicBase(req);
  const sent = await tele.sendLink(req.ctx, a, req.ctx.baseUrl);
  flash(req, sent ? 'success' : 'info', req.t(sent ? 'telehealth.staff.link_sent' : 'telehealth.staff.link_not_sent'));
  res.redirect(backTo(req, a.id));
}));

router.post('/:id(\\d+)/confirm', can('appointments.manage'), wrap(async (req, res) => {
  const { a } = await load(req);
  req.ctx.baseUrl = publicBase(req);
  if (a.status === 'pending') await appts.setStatus(req.ctx, a.id, 'confirmed');
  const { row } = await tele.forAppointment(req.ctx, a.id);
  flash(req, 'success', req.t(row.link_sent_at ? 'telehealth.staff.confirmed_sent' : 'telehealth.staff.confirmed_nomail'));
  res.redirect(backTo(req, a.id));
}));

// Payment received before the consultation (bank transfer, CliQ…): a normal invoice, but the visit stays open.
router.post('/:id(\\d+)/paid', can('billing.manage'), wrap(async (req, res) => {
  const { a } = await load(req);
  const method = appts.PAYMENT_METHODS.includes(req.body.payment_method) ? req.body.payment_method : 'bank_transfer';
  try {
    await appts.checkout(req.ctx, a.id, { amount_paid: req.body.amount_paid === undefined || req.body.amount_paid === '' ? a.amount_due : req.body.amount_paid, payment_method: method, discount_percent: 0 });
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 403) throw e;
    flash(req, 'error', e.code === 'VALIDATION_FAILED' ? req.t('errors.VALIDATION_FAILED') : errText(req, e));
    return res.redirect(backTo(req, a.id));
  }
  if (a.status !== 'completed') {
    // checkout() completes the visit; an online consultation paid in advance stays open until the call.
    await knex('appointments').where({ id: a.id, business_id: req.ctx.businessId }).update({ status: a.status, with_doctor: a.with_doctor, updated_at: new Date() });
  }
  await audit.record(req.ctx, 'telehealth.paid_in_advance', { entityType: 'appointment', entityId: a.id, newValues: { method } });
  if (req.body.confirm === '1' && a.status === 'pending' && req.ctx.permissions.has('appointments.manage')) {
    req.ctx.baseUrl = publicBase(req);
    await appts.setStatus(req.ctx, a.id, 'confirmed');
  }
  flash(req, 'success', req.t('telehealth.staff.paid_done'));
  return res.redirect(backTo(req, a.id));
}));

// The patient's files: clinic staff with clinical.view only; never cached, never rendered as a page.
router.get('/:id(\\d+)/files/:fid(\\d+)', can('clinical.view'), wrap(async (req, res) => {
  const { row } = await load(req);
  const f = await tele.fileOf(req.ctx.businessId, row.id, Number(req.params.fid));
  if (!f) throw E.notFound('File');
  const inline = f.mime !== 'application/pdf' && req.query.download !== '1';
  res.set({
    'Content-Type': f.mime, 'Content-Length': String(f.data.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="file-${f.id}.${f.name.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
  });
  await audit.record(req.ctx, 'telehealth.file_opened', { entityType: 'appointment', entityId: row.appointment_id, newValues: { file: f.id } });
  return res.end(f.data);
}));

// ---------------------------------------------------------------- the doctor's side of the call
const callGate = canAny('clinical.edit');

router.post('/:id(\\d+)/join', callGate, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { row } = await load(req);
  if (!tele.canJoin(row, req.business.timezone, 'doctor')) return res.status(403).json({ ok: false, error: req.t('errors_telehealth.JOIN_CLOSED') });
  await tele.markJoined(row, 'doctor');
  return res.json({ ok: true });
}));

router.post('/:id(\\d+)/signal', callGate, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { row } = await load(req);
  if (!tele.canJoin(row, req.business.timezone, 'doctor')) return res.status(403).json({ ok: false, error: req.t('errors_telehealth.JOIN_CLOSED') });
  try {
    if (req.body.kind === 'hello') await tele.markJoined(row, 'doctor');
    const id = await tele.postSignal(row, 'doctor', String(req.body.kind || ''), req.body.payload);
    return res.json({ ok: true, id });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return res.status(e.status).json({ ok: false, error: e.code });
  }
}));

router.get('/:id(\\d+)/signal', callGate, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { row } = await load(req);
  if (!tele.canJoin(row, req.business.timezone, 'doctor')) return res.status(403).json({ ok: false, error: req.t('errors_telehealth.JOIN_CLOSED') });
  const wait = config.isTest ? 0 : Math.min(20_000, Math.max(0, Number(req.query.wait) || 0) * 1000);
  const out = await tele.pollSignals(row, 'doctor', req.query.after === undefined ? null : req.query.after, wait);
  return res.json({ ok: true, ...out });
}));

module.exports = router;
module.exports.panelData = panelData;
module.exports.linksFor = linksFor;
