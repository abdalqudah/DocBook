// The patient portal on the clinic's site: /<slug>/account (sign-in, sign-up with a code, forgot password, the
// clinic's activation link, the patient's page, the patient's own files). Separate from the staff session: the patient
// is kept in req.session.pp[<clinic id>]. Staff sign in from the button under the form (/<slug>/login).
const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const config = require('../../config');
const { E, AppError } = require('../../core/errors');
const { wrap } = require('../../routes/helpers');
const portal = require('../site/portal.web');
const svc = require('./portal.service');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isTest ? 1000 : 20, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(E.rateLimited()) });

/** The clinic of the address, when its patient portal is on (else the page is not found). */
async function clinicOf(req) {
  const clinic = await portal.loadClinic(req);
  if (!clinic) return null;
  const s = await svc.settings(clinic.id);
  return s.enabled ? { clinic, s } : null;
}
const base = (clinic) => `/${clinic.slug}/account`;
const me = (req, clinic) => (req.session.pp && req.session.pp[clinic.id]) || null;
function page(req, res, clinic, view, extra = {}) {
  res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'same-origin' });
  return res.page(`pages/patientportal/${view}`, {
    layout: 'public', title: req.t(`pportal.title_${view}`), clinic, hideBookCta: view !== 'home', noindex: true, B: base(clinic), errors: {}, old: {},
    pageStyles: [...portal.clinicStyles(clinic), '/css/pportal.css'], pageScripts: ['/js/pportal.js'], ...extra,
  });
}
const msgOf = (req, e) => { const k = `pportal.err.${e.code}`; const v = req.t(k); return v !== k ? v : (e.details ? Object.values(e.details).join(' ') : e.message); };

// ---------------------------------------------------------------- the patient's page
router.get('/:slug/account', wrap(async (req, res, next) => {
  const got = await clinicOf(req);
  if (!got) return next();
  const who = me(req, got.clinic);
  if (!who) return res.redirect(`${base(got.clinic)}/login`);
  const data = await svc.home(got.clinic, who.patientId);
  if (!data.patient) { delete req.session.pp[got.clinic.id]; return res.redirect(`${base(got.clinic)}/login`); }
  return page(req, res, got.clinic, 'home', data);
}));

router.get('/:slug/account/files/:kind(f|a)/:id(\\d+)', wrap(async (req, res, next) => {
  const got = await clinicOf(req);
  const who = got && me(req, got.clinic);
  if (!who) return next();
  const f = await svc.fileOf(got.clinic, who.patientId, req.params.kind, req.params.id);
  if (!f) return next();
  const inline = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/.test(f.mime || '') && req.query.download !== '1';
  res.set({ 'Content-Type': f.mime || 'application/octet-stream', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name || 'file')}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
  if (f.data) return res.send(f.data);
  return fs.createReadStream(f.path).pipe(res);
}));

// ---------------------------------------------------------------- sign-in / out
router.get('/:slug/account/login', wrap(async (req, res, next) => {
  const got = await clinicOf(req);
  if (!got) return next();
  if (me(req, got.clinic)) return res.redirect(base(got.clinic));
  return page(req, res, got.clinic, 'login', { s: got.s });
}));
router.post('/:slug/account/login', limiter, wrap(async (req, res, next) => {
  const got = await clinicOf(req);
  if (!got) return next();
  // First time (a patient of the clinic with no password yet): a code to the mobile / e-mail on the file, then the
  // patient chooses a password and goes in — never without the code (anyone may know someone's number).
  const id = String(req.body.identifier || '').trim();
  if (id && got.s.self_signup) {
    const acc0 = await svc.accountWith(got.clinic, id);
    if (!acc0 || !acc0.password_hash) {
      const channels = await svc.channelsFor(got.clinic.id);
      const channel = svc.isEmail(id) ? 'email' : (channels.whatsapp ? 'whatsapp' : 'sms');
      const patientId = await svc.sendCode(got.clinic, 'signup', id, channel, req.locale);
      if (patientId) {
        req.session.ppPending = { businessId: got.clinic.id, patientId, purpose: 'signup', first: true, at: Date.now(), masked: id.replace(/.(?=.{3})/g, '•') };
        return res.redirect(`${base(got.clinic)}/code`);
      }
    }
  }
  try {
    const acc = await svc.login(got.clinic, req.body.identifier, req.body.password, { ip: req.ip });
    req.session.pp = { ...(req.session.pp || {}), [got.clinic.id]: { accountId: acc.id, patientId: acc.patient_id } };
    return res.redirect(base(got.clinic));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    res.status(e.status || 401);
    return page(req, res, got.clinic, 'login', { s: got.s, formError: { message: msgOf(req, e) }, old: { identifier: req.body.identifier } });
  }
}));
router.post('/:slug/account/logout', wrap(async (req, res, next) => {
  const got = await clinicOf(req);
  if (!got) return next();
  if (req.session.pp) delete req.session.pp[got.clinic.id];
  return res.redirect(`${base(got.clinic)}/login`);
}));

// ---------------------------------------------------------------- sign-up and forgot password: a code, then a password
for (const purpose of ['signup', 'reset']) { // eslint-disable-line no-restricted-syntax
  const view = purpose === 'signup' ? 'signup' : 'forgot';
  router.get(`/:slug/account/${view}`, wrap(async (req, res, next) => {
    const got = await clinicOf(req);
    if (!got || (purpose === 'signup' && !got.s.self_signup)) return next();
    return page(req, res, got.clinic, view, { channels: await svc.channelsFor(got.clinic.id) });
  }));
  router.post(`/:slug/account/${view}`, limiter, wrap(async (req, res, next) => {
    const got = await clinicOf(req);
    if (!got || (purpose === 'signup' && !got.s.self_signup)) return next();
    const id = String(req.body.identifier || '').trim();
    if (!id) return page(req, res, got.clinic, view, { channels: await svc.channelsFor(got.clinic.id), errors: { identifier: req.t('pportal.need_identifier') } });
    const patientId = await svc.sendCode(got.clinic, purpose, id, req.body.channel, req.locale);
    // the same answer whether or not the mobile / e-mail is on a file
    req.session.ppPending = { businessId: got.clinic.id, patientId: patientId || null, purpose, at: Date.now(), masked: id.replace(/.(?=.{3})/g, '•') };
    return res.redirect(`${base(got.clinic)}/code`);
  }));
}
router.get('/:slug/account/code', wrap(async (req, res, next) => {
  const got = await clinicOf(req);
  if (!got) return next();
  const pend = req.session.ppPending;
  if (!pend || pend.businessId !== got.clinic.id) return res.redirect(`${base(got.clinic)}/login`);
  return page(req, res, got.clinic, 'code', { pend });
}));
router.post('/:slug/account/code', limiter, wrap(async (req, res, next) => {
  const got = await clinicOf(req);
  if (!got) return next();
  const pend = req.session.ppPending;
  if (!pend || pend.businessId !== got.clinic.id || Date.now() - pend.at > 15 * 60_000) return res.redirect(`${base(got.clinic)}/login`);
  const fail = (e) => { res.status(422); return page(req, res, got.clinic, 'code', { pend, formError: { message: msgOf(req, e) } }); };
  if (String(req.body.password || '') !== String(req.body.password2 || '')) return fail({ code: 'PASSWORDS_DIFFER', message: 'The two passwords differ.' });
  try {
    if (!pend.patientId) throw new AppError('CODE_WRONG', 'The code is not right.', 422);
    await svc.checkCode(got.clinic.id, pend.patientId, pend.purpose, req.body.code);
    const acc = await svc.setPassword(got.clinic, pend.patientId, req.body.password);
    delete req.session.ppPending;
    req.session.pp = { ...(req.session.pp || {}), [got.clinic.id]: { accountId: acc.id, patientId: acc.patient_id } };
    return res.redirect(base(got.clinic));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return fail(e);
  }
}));

// ---------------------------------------------------------------- the clinic's activation link
router.get('/:slug/account/activate/:token', wrap(async (req, res, next) => {
  const got = await clinicOf(req);
  if (!got) return next();
  const ok = await svc.inviteFor(got.clinic.id, req.params.token);
  return page(req, res, got.clinic, 'activate', { token: req.params.token, expired: !ok });
}));
router.post('/:slug/account/activate/:token', limiter, wrap(async (req, res, next) => {
  const got = await clinicOf(req);
  if (!got) return next();
  const fail = (e) => { res.status(422); return page(req, res, got.clinic, 'activate', { token: req.params.token, expired: e.code === 'CODE_EXPIRED', formError: { message: msgOf(req, e) } }); };
  if (String(req.body.password || '') !== String(req.body.password2 || '')) return fail({ code: 'PASSWORDS_DIFFER', message: 'The two passwords differ.' });
  try {
    const acc = await svc.useInvite(got.clinic, req.params.token, req.body.password);
    req.session.pp = { ...(req.session.pp || {}), [got.clinic.id]: { accountId: acc.id, patientId: acc.patient_id } };
    return res.redirect(base(got.clinic));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return fail(e);
  }
}));

module.exports = router;
