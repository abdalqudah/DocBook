// Platform admin → AI assistant: switch, Anthropic API key (encrypted, never rendered back), model id,
// caps, the data-processing notice shown to clinics, a "Test connection" button and this month's usage per clinic.
// Mounted inside admin/web.js after its platform-admin guard (req.ctx is the platform scope).
const express = require('express');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { wrap, flash } = require('../../routes/helpers');
const ai = require('./ai.service');

const router = express.Router();
const page = (res, view, data) => res.page(`pages/admin/${view}`, { layout: 'admin', pageStyles: ['/css/site.css', '/css/admin.css', '/css/ai.css'], ...data });

async function render(req, res, extra = {}) {
  const s = await ai.platformSettings();
  const since = ai.monthStart('UTC');
  const [clinics, [totals]] = await Promise.all([
    knex('ai_requests as r').join('businesses as b', 'b.id', 'r.business_id').where('r.created_at', '>=', since).whereIn('r.status', ['ok', 'refused', 'truncated'])
      .groupBy('b.id', 'b.name', 'b.name_en').orderBy('n', 'desc').limit(20)
      .select('b.id', 'b.name', 'b.name_en').count({ n: '*' }).sum({ tin: 'r.input_tokens', tout: 'r.output_tokens' }),
    knex('ai_requests').where('created_at', '>=', since).select(
      knex.raw("SUM(CASE WHEN status IN ('ok','refused','truncated') THEN 1 ELSE 0 END) as billed"),
      knex.raw("SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed"),
      knex.raw('COUNT(DISTINCT business_id) as clinics'),
    ),
  ]);
  const optedIn = Number((await knex('ai_clinic_settings').where({ enabled: true }).count({ n: '*' }))[0].n);
  const test = req.session.aiTest || null;
  delete req.session.aiTest;
  page(res, 'ai', {
    title: req.t('ai_admin.title'), s, clinics, totals: { billed: Number(totals.billed || 0), failed: Number(totals.failed || 0), clinics: Number(totals.clinics || 0), optedIn },
    test, defaultModel: ai.DEFAULT_MODEL, errors: {}, old: null, ...extra,
  });
}

router.get('/ai', wrap((req, res) => render(req, res)));

router.post('/ai', ai.formRunner(async (req, res) => {
  await ai.savePlatform(req.ctx, req.body);
  flash(req, 'success', req.t('ai_admin.saved'));
  res.redirect('/admin/ai');
}, (req, res, extra) => render(req, res, extra)));

router.post('/ai/test', wrap(async (req, res) => {
  const s = await ai.platformSettings();
  const r = s.hasKey ? await ai.testConnection(s) : { ok: false, code: 'AI_NOT_CONFIGURED' };
  await audit.record(req.ctx, 'platform.ai_tested', { entityType: 'platform', entityId: 'ai', newValues: { ok: r.ok, model: s.model, error_code: r.code || null } });
  req.session.aiTest = { ok: r.ok, code: r.code || null, model: r.model || s.model, message: r.message || '', at: new Date().toISOString() };
  res.redirect('/admin/ai#test');
}));

module.exports = router;
