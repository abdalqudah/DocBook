// Patients → Surgeries (/app/surgeries): every operation booked as a doctor's time block — date and time, doctor,
// patient, procedure, hospital — with the hospital told by e-mail (from the clinic's address) or WhatsApp.
//   GET  /                     list (upcoming / past / all; doctor; hospital)
//   GET  /patient-lookup?q=    patients for the surgery form (JSON)
//   GET  /:id                  one surgery: details, edit, send to the hospital
//   POST /:id                  save          POST /:id/status   done / cancelled / scheduled
//   POST /:id/send             e-mail or WhatsApp to the hospital
// Seeing: clinical.view or appointments.manage (a doctor login: own surgeries). Changing: appointments.manage, or the doctor's own.
const express = require('express');
const knex = require('../../db/knex');
const { AppError, E } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { canAny } = require('../../middleware/context');
const { publicBase } = require('../../middleware/web');
const lib = require('../clinic/records.lib');
const svc = require('./surgeries.service');

const router = express.Router();
router.use(canAny('clinical.view', 'appointments.manage'));
const ASSETS = { pageScripts: ['/js/surgeries.js'], pageStyles: ['/css/appointments.css'] };
const mayChange = (req, s) => req.ctx.permissions.has('appointments.manage') || (req.ctx.ownDoctorId && req.ctx.permissions.has('clinical.edit') && (!s || s.doctor_id === req.ctx.ownDoctorId));
const hospitalsOf = async (ctx) => (await require('../partners/partners.service').list(ctx.businessId, { activeOnly: true })).filter((p) => p.kind === 'hospital'); // eslint-disable-line global-require
const errText = (req, e) => { for (const k of [`surgeries.err.${e.code}`, `errors.${e.code}`]) { const s = req.t(k); if (s !== k) return s; } return e.message; };

// Dates: weeks start on Saturday (as the appointments calendar).
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekStart = (d) => addDays(d, -((new Date(`${d}T12:00:00Z`).getUTCDay() + 1) % 7));
const VIEWS = ['day', 'week', 'month', 'list'];

router.get('/', wrap(async (req, res) => {
  const { ctx } = req;
  const view = VIEWS.includes(req.query.view) ? req.query.view : 'week';
  const date = isDate(req.query.date) ? req.query.date : ctx.today;
  const f = { view, date, when: ['upcoming', 'past', 'all'].includes(req.query.when) ? req.query.when : 'upcoming', doctor: Number(req.query.doctor) || null, hospital: Number(req.query.hospital) || null };
  const [hospitals, doctors] = await Promise.all([
    hospitalsOf(ctx),
    ctx.ownDoctorId ? [] : knex('doctors').where({ business_id: ctx.businessId, is_active: true }).orderBy('full_name').select('id', 'full_name', 'full_name_en', 'color'),
  ]);
  const data = { title: req.t('surgeries.title'), f, view, date, hospitals, doctors, canAdd: mayChange(req, null), today: ctx.today, ...ASSETS };
  if (view === 'list') {
    const rows = await svc.list(ctx, f);
    const days = [];
    rows.forEach((r) => { const k = String(r.surgery_date); let d = days.find((x) => x.date === k); if (!d) { d = { date: k, rows: [] }; days.push(d); } d.rows.push(r); });
    return res.page('pages/surgeries/index', { ...data, days, total: rows.length });
  }
  let from; let to; let prev; let next;
  if (view === 'day') { from = date; to = date; prev = addDays(date, -1); next = addDays(date, 1); }
  else if (view === 'week') { from = weekStart(date); to = addDays(from, 6); prev = addDays(from, -7); next = addDays(from, 7); }
  else {
    const first = `${date.slice(0, 7)}-01`;
    const last = addDays(`${addDays(first, 32).slice(0, 7)}-01`, -1);
    from = weekStart(first); to = addDays(weekStart(last), 6);
    prev = addDays(first, -1).slice(0, 7) + '-01'; next = addDays(last, 1);
    data.month = first.slice(0, 7);
  }
  const rows = await svc.range(ctx, from, to, f);
  const byDate = {};
  rows.forEach((r) => { const k = String(r.surgery_date); (byDate[k] = byDate[k] || []).push(r); });
  const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return res.page('pages/surgeries/index', { ...data, from, to, prev, next, days, byDate, total: rows.length });
}));

router.get('/patient-lookup', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) return res.json({ data: [] });
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const digits = q.replace(/[^0-9]/g, '');
  const qb = knex('patients').where('patients.business_id', req.ctx.businessId)
    .andWhere((w) => { lib.nameMatch(w, 'patients.full_name', q); w.orWhere('patients.phone', 'like', like); if (digits.length >= 3) w.orWhere('patients.phone', 'like', `%${digits}%`); })
    .orderBy('patients.full_name').limit(8).select('patients.id', 'patients.full_name', 'patients.phone');
  lib.scopePatientsToDoctor(qb, req.ctx.ownDoctorId);
  res.set('Cache-Control', 'no-store');
  return res.json({ data: (await qb).map((p) => ({ id: p.id, name: p.full_name, phone: p.phone || '' })) });
}));

async function renderShow(req, res, extra = {}) {
  const s = await svc.get(req.ctx, req.params.id);
  const clinic = req.business;
  const locale = ['ar', 'en'].includes(req.query.lang) ? req.query.lang : req.locale;
  const [hospitals, msg] = await Promise.all([hospitalsOf(req.ctx), svc.message(req.ctx, s, clinic, locale)]);
  res.page('pages/surgeries/show', { title: s.procedure_name, s, hospitals, msg, msgLocale: locale, canChange: mayChange(req, s), ...ASSETS, ...extra });
}
router.get('/:id(\\d+)', wrap((req, res) => renderShow(req, res)));

const guard = async (req) => { const s = await svc.get(req.ctx, req.params.id); if (!mayChange(req, s)) throw E.forbidden('appointments.manage'); return s; };

router.post('/:id(\\d+)', wrap(async (req, res) => {
  await guard(req);
  try {
    await svc.update(req.ctx, req.params.id, req.body);
    flash(req, 'success', req.t('surgeries.updated'));
    return res.redirect(`/app/surgeries/${req.params.id}`);
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    return renderShow(req, res, { old: req.body, errors: e.details || {}, formError: { message: errText(req, e) } });
  }
}));

router.post('/:id(\\d+)/status', wrap(async (req, res) => {
  await guard(req);
  try {
    await svc.setStatus(req.ctx, req.params.id, String(req.body.status || ''));
    flash(req, 'success', req.t(`surgeries.status_saved.${req.body.status}`));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', errText(req, e));
  }
  return res.redirect(`/app/surgeries/${req.params.id}`);
}));

router.post('/:id(\\d+)/send', wrap(async (req, res) => {
  const s = await guard(req);
  const back = `/app/surgeries/${s.id}`;
  const fail = (code) => { flash(req, 'error', req.t(`surgeries.err.${code}`)); return res.redirect(back); };
  const locale = ['ar', 'en'].includes(req.body.lang_msg) ? req.body.lang_msg : req.locale;
  const clinic = req.business;
  const msg = await svc.message(req.ctx, s, clinic, locale);
  if (req.body.channel === 'whatsapp') {
    const phone = String(req.body.to_phone || s.hospital_phone || '').trim();
    const to = phone ? await require('../messaging/messaging.service').waNumberFor(req.ctx.businessId, phone) : null; // eslint-disable-line global-require
    if (!to) return fail('NO_PHONE');
    await svc.markSent(req.ctx, s, 'whatsapp', phone);
    const wa = `https://wa.me/${to}?text=${encodeURIComponent(msg.wa)}`;
    return res.page('pages/share/go', { layout: 'auth', title: req.t('surgeries.title'), wa, noindex: true });
  }
  const to = String(req.body.to_email || s.hospital_email || '').trim().toLowerCase();
  if (!/^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(to) || to.length > 190) return fail('NO_EMAIL');
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  if (!(await mailer.configuredFor(req.ctx.businessId))) return fail('NO_MAIL');
  const html = mailer.layout({ locale, title: msg.subject, body: msg.body, clinic, base: publicBase(req) });
  let ok = false;
  try { ok = await mailer.send({ to, subject: msg.subject, html, replyTo: clinic.email || undefined, businessId: clinic.id, kind: 'patient_letters', fromName: msg.vars.clinic }); } catch { ok = false; }
  if (!ok) return fail('MAIL_FAILED');
  await svc.markSent(req.ctx, s, 'email', to);
  flash(req, 'success', req.t('surgeries.emailed', { to }));
  return res.redirect(back);
}));

module.exports = router;
