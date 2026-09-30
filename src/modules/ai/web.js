// AI clinical assistant (clinic side). Mounted at '/' inside /app, before '/visits'.
//  • GET  /visits/:id           loader only: prepares the visit-page panel (res.locals.aiPanel), then next()
//  • POST /visits/:id/ai/:kind  runs summary | second_opinion | rx_check → JSON
//  • GET/POST /settings/ai      clinic opt-in, acknowledgement, allowed roles, usage (settings.manage)
const express = require('express');
const knex = require('../../db/knex');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const settingsCommon = require('../settings/common');
const rbac = require('../rbac/rbac.service');
const ai = require('./ai.service');
const aifin = require('./finance.service'); // finance assistant opt-in lives on the same settings page

const router = express.Router();
const tr = (req, code) => { const k = `errors_ai.${code}`; const s = req.t(k); return s === k ? req.t('errors_ai.AI_API_ERROR') : s; };

// ---------------------------------------------------------------- visit page panel (loader)
router.get('/visits/:id(\\d+)', async (req, res, next) => {
  try {
    const { code, platform } = await ai.access(req.ctx);
    if (code) return next();
    const d = await ai.visitData(req.ctx, Number(req.params.id));
    const previews = {}; const ready = {};
    ai.KINDS.forEach((k) => { previews[k] = ai.composeInput({ ...d, kind: k }); ready[k] = ai.hasContent(k, d); });
    const [last, cnt] = await Promise.all([ai.lastResults(req.ctx, d.a.id), ai.counts(req.ctx)]);
    res.locals.aiPanel = {
      apptId: d.a.id, previews, ready, last, model: platform.model,
      cap: platform.monthly_cap, used: cnt.monthCount, canNote: req.ctx.permissions.has('clinical.edit'),
    };
  } catch (err) {
    // The visit page itself reports "not found" / scope errors; the panel just stays hidden.
    res.locals.aiPanel = null;
  }
  return next();
});

router.post('/visits/:id(\\d+)/ai/:kind(summary|second_opinion|rx_check)', wrap(async (req, res) => {
  try {
    const out = await ai.run(req.ctx, Number(req.params.id), req.params.kind, { locale: req.locale });
    res.json({ ok: true, data: { id: out.id, kind: out.kind, result: out.result, model: out.model, created_at: out.created_at } });
  } catch (err) {
    const code = err && err.code ? err.code : 'AI_API_ERROR';
    const status = code === 'NOT_FOUND' ? 404 : (err && err.status) || 500;
    const message = code === 'NOT_FOUND' ? req.t('errors_ai.NOT_FOUND') : tr(req, code);
    res.status(status >= 400 && status < 600 ? status : 500).json({ ok: false, error: { code, message } });
  }
}));

// ---------------------------------------------------------------- clinic settings
async function renderSettings(req, res, extra = {}) {
  const { ctx } = req;
  const [platform, clinic, roles, usage, recent, finSettings] = await Promise.all([
    ai.platformSettings(), ai.clinicSettings(ctx.businessId), rbac.listRoles(ctx.businessId), ai.usage(ctx.businessId, ctx.timezone),
    knex('ai_requests as r').leftJoin('users as u', 'u.id', 'r.user_id').where({ 'r.business_id': ctx.businessId })
      .orderBy('r.id', 'desc').limit(15).select('r.id', 'r.kind', 'r.status', 'r.error_code', 'r.created_at', 'r.appointment_id', 'u.name as user_name'),
    aifin.settings(ctx.businessId),
  ]);
  const ackUser = clinic.acknowledged_by ? await knex('users').where({ id: clinic.acknowledged_by }).first('name') : null;
  const finAckUser = finSettings.acknowledged_by ? await knex('users').where({ id: finSettings.acknowledged_by }).first('name') : null;
  settingsCommon.render(req, res, 'ai', 'ai', {
    platform, clinic, usage, recent, ackName: ackUser ? ackUser.name : null,
    fin: { ...finSettings, ackName: finAckUser ? finAckUser.name : null, usage: (usage.byKind[aifin.KIND_ANALYSIS] || 0) + (usage.byKind[aifin.KIND_CHAT] || 0), roles: roles.map((r) => ({ key: r.key, name: r.is_system ? req.t(`roles.${r.key}`) : r.name, finance: (r.permissions || []).includes('finance.view') })) },
    roles: roles.map((r) => ({ key: r.key, name: r.is_system ? req.t(`roles.${r.key}`) : r.name, clinical: (r.permissions || []).includes('clinical.view') })),
    notice: (req.locale === 'en' ? platform.notice_en || platform.notice_ar : platform.notice_ar || platform.notice_en) || '',
    pageStyles: ['/css/admin.css', '/css/ai.css'],
    errors: {}, old: null, ...extra,
  });
}

router.get('/settings/ai', can('settings.manage'), wrap((req, res) => renderSettings(req, res)));
router.post('/settings/ai', can('settings.manage'), ai.formRunner(async (req, res) => {
  const roles = await rbac.listRoles(req.ctx.businessId);
  await ai.saveClinic(req.ctx, req.body, roles.filter((r) => (r.permissions || []).includes('clinical.view')));
  flash(req, 'success', req.t('ai.settings_saved'));
  res.redirect('/app/settings/ai');
}, (req, res, extra) => renderSettings(req, res, extra)));

// Finance assistant opt-in (separate switch, same platform settings; roles limited to those with finance.view).
router.post('/settings/ai/finance', can('settings.manage'), ai.formRunner(async (req, res) => {
  const roles = await rbac.listRoles(req.ctx.businessId);
  await aifin.saveSettings(req.ctx, req.body, roles.filter((r) => (r.permissions || []).includes('finance.view')));
  flash(req, 'success', req.t('aifin.settings_saved'));
  res.redirect('/app/settings/ai#finance');
}, (req, res, extra) => renderSettings(req, res, { ...extra, old: null, errors: {}, finOld: req.body, finErrors: extra.errors })));

module.exports = router;
