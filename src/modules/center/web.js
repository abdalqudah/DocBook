// Medical centre pages (/app/center):
//   GET  /                 the centre: its practices, invitations, this practice's sharing choice (settings.manage)
//   POST /create · /rename · /invite · /invites/:id/delete · /share-cash · /leave · /members/:bid/remove
//   GET  /desk             the shared reception: today's visits of every practice (frontdesk.use)
//   GET  /desk/data        the same as JSON (live refresh)
//   POST /desk/:bid/:id/:action   check-in | uncheck | call-in | uncall a visit of any practice of the centre
const express = require('express');
const { AppError } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const svc = require('./center.service');
const cashier = require('../clinic/cashier.service');
const appts = require('../clinic/appointments.service');

const router = express.Router();
const errText = (req, err) => { for (const k of [`center.err.${err.code}`, `errors.${err.code}`]) { const s = req.t(k); if (s !== k) return s; } return err.message; };
const act = (fn, back = () => '/app/center') => wrap(async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (!(err instanceof AppError) || err.status >= 500) throw err;
    flash(req, 'error', err.code === 'VALIDATION_FAILED' ? `${req.t('errors.VALIDATION_FAILED')}` : errText(req, err));
  }
  if (!res.headersSent) res.redirect(back(req));
});

// ---------------------------------------------------------------- the centre
router.get('/', can('settings.manage'), wrap(async (req, res) => {
  const center = await svc.ofBusiness(req.ctx.businessId);
  const [members, invites] = center ? await Promise.all([svc.members(center.id), svc.pendingInvites(center.id)]) : [[], []];
  res.page('pages/center/index', {
    title: req.t('center.title'), center, members, invites, founder: svc.isFounder(center, req.ctx.businessId), lastLink: req.session.centerLink || null,
    pageStyles: ['/css/center.css'],
  });
  delete req.session.centerLink;
}));
router.post('/create', can('settings.manage'), act(async (req) => { await svc.create(req.ctx, { name: req.body.center_name, name_en: req.body.center_name_en }); flash(req, 'success', req.t('center.created')); }));
router.post('/rename', can('settings.manage'), act(async (req) => { await svc.rename(req.ctx, { name: req.body.center_name, name_en: req.body.center_name_en }); flash(req, 'success', req.t('common.updated')); }));
router.post('/invite', can('settings.manage'), act(async (req) => {
  const r = await svc.invite(req.ctx, req.body.email, { base: req.ctx.baseUrl, locale: req.locale, t: req.t });
  req.session.centerLink = r.link;
  flash(req, 'success', req.t('center.invited', { email: r.email }));
}));
router.post('/invites/:id(\\d+)/delete', can('settings.manage'), act(async (req) => { await svc.revokeInvite(req.ctx, req.params.id); flash(req, 'success', req.t('common.deleted')); }));
router.post('/share-cash', can('settings.manage'), act(async (req) => { await svc.setShareCash(req.ctx, req.body.on === '1'); flash(req, 'success', req.t('common.updated')); }));
router.post('/leave', can('settings.manage'), act(async (req) => { await svc.leave(req.ctx); flash(req, 'success', req.t('center.left')); }));
router.post('/members/:bid(\\d+)/remove', can('settings.manage'), act(async (req) => { await svc.leave(req.ctx, Number(req.params.bid)); flash(req, 'success', req.t('center.removed')); }));

// ---------------------------------------------------------------- the shared reception
const DESK_GRANT = ['frontdesk.use', 'appointments.view'];
async function deskData(req) {
  const center = await svc.ofBusiness(req.ctx.businessId);
  if (!center) return null;
  const members = await svc.members(center.id);
  const L = (ar, en) => (req.locale === 'en' && en ? en : ar);
  const visits = [];
  for (const m of members) { // eslint-disable-line no-restricted-syntax
    const ctx = await svc.actCtx(req.ctx, m.id, { need: 'frontdesk.use', grant: DESK_GRANT }); // eslint-disable-line no-await-in-loop
    const rows = await cashier.today({ ...ctx, permissions: new Set(DESK_GRANT) }); // eslint-disable-line no-await-in-loop
    rows.filter((a) => a.state !== 'missed').forEach((a) => visits.push({
      id: a.id, bid: m.id, practice: L(m.name, m.name_en), patient: a.patient_name, time: String(a.appointment_time || '').slice(0, 5),
      doctor: L(a.doctor_name, a.doctor_name_en) || '', color: a.doctor_color || null, state: a.state || cashier.flowState(a), paid: a.payment_status === 'paid',
    }));
  }
  visits.sort((x, y) => x.time.localeCompare(y.time) || x.id - y.id);
  const cols = ['expected', 'arrived', 'with_doctor', 'ready'];
  return { center, members, cols, by: Object.fromEntries(cols.map((k) => [k, visits.filter((v) => v.state === k && !v.paid)])), done: visits.filter((v) => v.state === 'paid' || v.paid).length };
}
router.get('/desk', can('frontdesk.use'), wrap(async (req, res) => {
  const data = await deskData(req);
  if (!data) return res.redirect('/app/front-desk');
  return res.page('pages/center/desk', { title: req.t('center.desk_title'), ...data, pageStyles: ['/css/center.css'], pageScripts: ['/js/center.js'] });
}));
router.get('/desk/data', can('frontdesk.use'), wrap(async (req, res) => {
  const data = await deskData(req);
  res.set('Cache-Control', 'no-store').json(data ? { cols: data.cols, by: data.by, done: data.done } : null);
}));
router.post('/desk/:bid(\\d+)/:id(\\d+)/:action(check-in|uncheck|call-in|uncall)', can('frontdesk.use'), act(async (req) => {
  const ctx = await svc.actCtx(req.ctx, req.params.bid, { need: 'frontdesk.use', grant: DESK_GRANT });
  const id = Number(req.params.id);
  const { action } = req.params;
  if (action === 'check-in' || action === 'uncheck') await appts.checkIn(ctx, id, action === 'check-in');
  else await appts.callIn(ctx, id, action === 'call-in');
  flash(req, 'success', req.t(`center.done.${action}`));
}, () => '/app/center/desk'));

module.exports = router;
