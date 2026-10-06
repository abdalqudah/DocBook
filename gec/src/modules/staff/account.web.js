// My account (any employee): name, phone, language, password and signed-in devices.
const express = require('express');
const knex = require('../../db/knex');
const auth = require('../auth/auth.service');
const audit = require('../../core/audit');
const { flash } = require('../../middleware/web');
const { ah } = require('../../core/http');
const { validate, z, reqStr, phone, password } = require('../../core/validate');
const { AppError } = require('../../core/errors');

const router = express.Router();

async function render(req, res, extra = {}) {
  const sessions = await auth.sessionsOf(req.user.id);
  const sso = require('../auth/sso'); // eslint-disable-line global-require
  const conn = { providers: await sso.available('staff'), identities: await sso.identitiesOf(req.user.id), hasPassword: !!(await knex('users').where({ id: req.user.id }).first('password_hash')).password_hash };
  res.page('pages/staff/account', { layout: 'staff', narrow: true, title: req.t('staff.my_account'), sessions, currentSid: req.sessionID, conn, ...extra });
}

router.get('/', ah((req, res) => render(req, res)));

router.post('/profile', ah(async (req, res) => {
  try {
    const data = validate(z.object({ name: reqStr(160), phone: phone(), locale: z.enum(['en', 'ar']) }), req.body);
    const before = await knex('users').where({ id: req.user.id }).first('name', 'phone', 'locale');
    await knex('users').where({ id: req.user.id }).update({ name: data.name, phone: data.phone || null, locale: data.locale, updated_at: new Date() });
    const d = audit.diff(before, { name: data.name, phone: data.phone || null, locale: data.locale });
    if (d.changed) await audit.record(req.ctx, 'user.profile_updated', { entityType: 'user', entityId: req.user.id, oldValues: d.oldValues, newValues: d.newValues });
    res.cookie('gec_lang', data.locale, { maxAge: 365 * 86_400_000, sameSite: 'lax', httpOnly: true });
    flash(req, 'ok', req.t('common.saved'));
    return res.redirect('/staff/account');
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return render(req, res, { errors: e.details, old: req.body });
  }
}));

router.post('/password', ah(async (req, res) => {
  try {
    if (req.body.password !== req.body.password_confirm) throw new AppError('VALIDATION_FAILED', 'x', 422, { password_confirm: 'Passwords do not match.' });
    const { pw } = validate(z.object({ pw: password() }), { pw: req.body.password });
    await auth.changePassword(req.ctx, req.user.id, req.body.current_password, pw, req.sessionID);
    flash(req, 'ok', req.t('auth.password_changed'));
    return res.redirect('/staff/account');
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return render(req, res, { errors: { ...e.details, password: e.details.pw || e.details.password }, tab: 'security' });
  }
}));

router.post('/sessions/:sid/revoke', ah(async (req, res) => {
  if (req.params.sid === req.sessionID) return res.redirect('/staff/account');
  await auth.revokeSession(req.user.id, req.params.sid);
  await audit.record(req.ctx, 'auth.session_revoked', { entityType: 'user', entityId: req.user.id });
  flash(req, 'ok', req.t('auth.session_revoked'));
  return res.redirect('/staff/account#sessions');
}));

router.post('/sessions/revoke-others', ah(async (req, res) => {
  const n = await auth.endSessionsOf(req.user.id, req.sessionID);
  await audit.record(req.ctx, 'auth.sessions_revoked', { entityType: 'user', entityId: req.user.id, newValues: { count: n } });
  flash(req, 'ok', req.t('auth.sessions_revoked', { n }));
  res.redirect('/staff/account#sessions');
}));

module.exports = router;
