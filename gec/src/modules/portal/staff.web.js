// Staff side of Phase 8: invite a student to the portal, the staff notification inbox, AI advisor settings.
const express = require('express');
const knex = require('../../db/knex');
const secrets = require('../../core/secrets');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah, idParam } = require('../../core/http');
const { validate, z, str, bool } = require('../../core/validate');
const settings = require('../settings/settings.service');
const settingsWeb = require('../settings/web');
const notifications = require('../notifications/service');
const provider = require('../ai/provider');
const advisor = require('../ai/advisor.service');
const account = require('./account');

settingsWeb.addSection({ key: 'ai', icon: 'sparkles', href: '/staff/settings/ai', perms: ['integrations.manage'] });
const router = express.Router();

router.use(ah(async (req, res, next) => {
  if (req.method === 'GET') res.locals.unreadNotifications = await notifications.unread(req.user.id);
  next();
}));

// Invitation state on the student page.
router.get(/^\/students\/\d+$/, ah(async (req, res, next) => {
  const s = await knex('students as s').leftJoin('users as u', 'u.id', 's.user_id').where('s.id', Number(req.path.split('/')[2])).first('s.user_id', 'u.email_verified_at', 'u.last_login_at');
  if (s) res.locals.portalState = !s.user_id ? 'none' : (s.email_verified_at ? 'active' : 'invited');
  if (req.session.inviteLink) { res.locals.inviteLink = req.session.inviteLink; delete req.session.inviteLink; } // shown once when e-mail is not connected
  next();
}));
router.post('/students/:id/invite', can('students.manage'), ah(async (req, res) => {
  const r = await account.invite(req.ctx, req.staff, idParam(req.params.id), req.user.name);
  if (r.sent) flash(req, 'ok', req.t('portal.invite_sent'));
  else { req.session.inviteLink = r.link; flash(req, 'error', req.t('portal.invite_not_sent')); }
  res.redirect(`/staff/students/${req.params.id}`);
}));

router.get('/notifications', ah(async (req, res) => {
  const list = await notifications.list(req.user.id, { page: Math.max(1, Number(req.query.page) || 1) });
  res.page('pages/staff/notifications', { layout: 'staff', narrow: true, title: req.t('nav.notifications'), list });
}));
router.post('/notifications/read', ah(async (req, res) => {
  const id = /^\d+$/.test(req.body.id || '') ? Number(req.body.id) : null;
  await notifications.markRead(req.user.id, id);
  const n = id ? await knex('notifications').where({ id, user_id: req.user.id }).first('href') : null;
  res.redirect(n && n.href && n.href.startsWith('/') && !n.href.startsWith('//') ? n.href : '/staff/notifications');
}));

router.get('/settings/ai', can('integrations.manage'), ah(async (req, res) => {
  const s = (await settings.get('integration.ai')) || {};
  const recent = await knex('advisor_logs').orderBy('id', 'desc').limit(15);
  const [{ n, ai }] = await knex('advisor_logs').where('created_at', '>=', new Date(Date.now() - 30 * 86400_000)).select(knex.raw('COUNT(*) AS n'), knex.raw("SUM(mode = 'ai') AS ai"));
  res.page('pages/staff/settings/ai', { layout: 'staff', narrow: true, title: req.t('settings.ai'), s, connected: !!(await provider.currentConfig()), hasKey: !!s.api_key_enc, models: provider.MODELS, recent, usage: { n: Number(n), ai: Number(ai || 0) } });
}));
router.post('/settings/ai', can('integrations.manage'), ah(async (req, res) => {
  const d = validate(z.object({ enabled: bool(), api_key: str(300), model: z.enum(provider.MODELS), effort: z.enum(['low', 'medium', 'high']) }), req.body);
  const cur = (await settings.get('integration.ai')) || {};
  await settings.set(req.ctx, 'integration.ai', { enabled: d.enabled && !!(d.api_key || cur.api_key_enc), provider: 'anthropic', api_key_enc: d.api_key ? secrets.encrypt(d.api_key) : cur.api_key_enc || null, model: d.model, effort: d.effort });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/staff/settings/ai');
}));
router.post('/settings/ai/test', can('integrations.manage'), ah(async (req, res) => {
  try {
    const r = await advisor.ask({ question: 'Which destinations does GEC cover? Answer in one sentence.', locale: req.locale, userId: req.user.id });
    flash(req, r.mode === 'ai' ? 'ok' : 'error', r.mode === 'ai' ? req.t('ai.test_ok', { text: r.text.slice(0, 200) }) : req.t('ai.test_search'));
  } catch (e) { flash(req, 'error', req.t('ai.test_failed', { reason: e.message })); }
  res.redirect('/staff/settings/ai');
}));

module.exports = router;
