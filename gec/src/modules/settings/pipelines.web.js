// Settings → Lead stages / Application stages: rename, reorder, colour, "stuck after" days, enable, add.
// Keys stay fixed (automations and reports rely on them); custom stages get a generated key.
const express = require('express');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah } = require('../../core/http');
const settingsWeb = require('./web');

settingsWeb.addSection({ key: 'lead_stages', icon: 'kanban', href: '/staff/settings/pipeline/leads', perms: ['settings.manage'] });
settingsWeb.addSection({ key: 'application_stages', icon: 'workflow', href: '/staff/settings/pipeline/applications', perms: ['settings.manage'] });

const KINDS = {
  leads: { table: 'lead_stages', cache: () => require('../crm/stages').clear(), sla: false }, // eslint-disable-line global-require
  applications: { table: 'application_stages', cache: () => require('../admissions/stages').clear(), sla: true }, // eslint-disable-line global-require
};
const TONES = ['info', 'brand', 'warn', 'ok', 'bad'];
const router = express.Router();

router.get('/:kind', can('settings.manage'), ah(async (req, res, next) => {
  const k = KINDS[req.params.kind];
  if (!k) return next();
  return res.page('pages/staff/settings/pipeline', { layout: 'staff', title: req.t(`settings.${req.params.kind === 'leads' ? 'lead_stages' : 'application_stages'}`), kind: req.params.kind, rows: await knex(k.table).orderBy('position'), sla: k.sla, tones: TONES });
}));

router.post('/:kind', can('settings.manage'), ah(async (req, res, next) => {
  const k = KINDS[req.params.kind];
  if (!k) return next();
  const rows = await knex(k.table).orderBy('position');
  const before = rows.map((r) => ({ key: r.key, name_en: r.name_en, position: r.position, is_active: r.is_active }));
  for (const r of rows) {
    const p = (f) => req.body[`${f}_${r.id}`];
    const upd = {
      name_en: String(p('name_en') || r.name_en).trim().slice(0, 80) || r.name_en, name_ar: String(p('name_ar') || '').trim().slice(0, 80) || null,
      tone: TONES.includes(p('tone')) ? p('tone') : r.tone, position: Number.isFinite(Number(p('position'))) ? Number(p('position')) : r.position,
      // the first stage and won/lost/terminal stages always stay active (the pipeline needs them)
      is_active: (r.is_won || r.is_lost || r.is_terminal) ? true : [].concat(p('is_active') || []).pop() === '1',
    };
    if (k.sla) upd.sla_days = Number(p('sla_days')) > 0 ? Math.min(365, Number(p('sla_days'))) : null;
    await knex(k.table).where({ id: r.id }).update(upd); // eslint-disable-line no-await-in-loop
  }
  const newName = String(req.body.new_name_en || '').trim();
  if (newName) {
    const pos = Number(req.body.new_position) || rows.length;
    const row = { key: `custom_${Date.now().toString(36)}`, name_en: newName.slice(0, 80), name_ar: String(req.body.new_name_ar || '').trim().slice(0, 80) || null, tone: 'info', position: pos };
    if (k.sla) row.sla_days = null;
    await knex(k.table).insert(row);
  }
  k.cache();
  await audit.record(req.ctx, 'settings.pipeline_updated', { entityType: 'settings', entityId: k.table, oldValues: { stages: before }, newValues: { added: newName || null } });
  flash(req, 'ok', req.t('common.saved'));
  return res.redirect(`/staff/settings/pipeline/${req.params.kind}`);
}));

module.exports = router;
