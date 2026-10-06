// Staff: lead scoring settings and per-lead explanation / manual temperature, analytics (traffic, funnel,
// attribution, team performance), campaigns and automation rules.
const express = require('express');
const knex = require('../../db/knex');
const fmt = require('../../core/format');
const audit = require('../../core/audit');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah, idParam } = require('../../core/http');
const { E } = require('../../core/errors');
const { validate, z, str, reqStr } = require('../../core/validate');
const { toCsv } = require('../../core/csv');
const settings = require('../settings/settings.service');
const settingsWeb = require('../settings/web');
const nav = require('../staff/nav');
const leads = require('../crm/leads.service');
const stages = require('../crm/stages');
const ref = require('../catalog/reference');
const templates = require('../comms/templates');
const scoring = require('./scoring');
const analytics = require('./analytics.service');
const campaigns = require('./campaigns.service');
const automations = require('./automations.service');

nav.add('analytics', { key: 'analytics', href: '/staff/analytics', icon: 'chart-line', perms: ['analytics.view'], exact: true });
nav.add('team', { key: 'performance', href: '/staff/analytics/team', icon: 'trophy', perms: ['reports.team'] });
nav.add('communication', { key: 'campaigns', href: '/staff/campaigns', icon: 'megaphone', perms: ['campaigns.manage'] }, { before: 'templates' });
nav.add('system', { key: 'automations', href: '/staff/automations', icon: 'workflow', perms: ['automations.manage'] }, { before: 'settings' });
settingsWeb.addSection({ key: 'scoring', icon: 'flame', href: '/staff/settings/scoring', perms: ['settings.manage'] });

const router = express.Router();
const dateQ = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
function period(q) {
  const to = dateQ(q.to) || fmt.today();
  const days = Number(q.days) || 30;
  const from = dateQ(q.from) || new Date(new Date(`${to}T00:00:00Z`).getTime() - (days - 1) * 86400_000).toISOString().slice(0, 10);
  return { from: from <= to ? from : to, to, days: dateQ(q.from) ? null : days };
}

// ------------------------------------------------------------------ Lead scoring
router.get(/^\/leads\/\d+$/, ah(async (req, res, next) => {
  const id = Number(req.path.split('/')[2]);
  const lead = await knex('leads').where({ id }).first('score_reasons', 'visitor_id', 'temperature_manual');
  if (lead) {
    const reasons = Array.isArray(lead.score_reasons) ? lead.score_reasons : (() => { try { return JSON.parse(lead.score_reasons || '[]'); } catch { return []; } })();
    const vids = [...new Set([lead.visitor_id, ...(await knex('visitors').where({ lead_id: id }).pluck('id'))].filter(Boolean))];
    const web = vids.length ? await knex('tracking_events as e').leftJoin('programs as p', function on() { this.on('p.id', 'e.ref_id').andOn(knex.raw("e.ref_type = 'program'")); })
      .leftJoin('universities as u', function on() { this.on('u.id', 'e.ref_id').andOn(knex.raw("e.ref_type = 'university'")); })
      .whereIn('e.visitor_id', vids).orderBy('e.created_at', 'desc').limit(40).select('e.name', 'e.path', 'e.created_at', 'p.name_en as program', 'u.name_en as university') : [];
    const visits = vids.length ? await knex('visitors').whereIn('id', vids).first(knex.raw('MIN(first_seen_at) AS first_seen'), knex.raw('MAX(last_seen_at) AS last_seen'), knex.raw('SUM(pageviews) AS pageviews')) : null;
    res.locals.scoreInfo = { reasons, manual: !!lead.temperature_manual, web, visits };
  }
  next();
}));

router.post('/leads/:id/temperature', can('leads.manage'), ah(async (req, res) => {
  const lead = await leads.get(req.staff, idParam(req.params.id));
  const v = String(req.body.temperature || 'auto');
  if (v === 'auto') await knex('leads').where({ id: lead.id }).update({ temperature_manual: false });
  else if (['cold', 'warm', 'hot'].includes(v)) await knex('leads').where({ id: lead.id }).update({ temperature_manual: true, temperature: v });
  else throw E.validation({ temperature: 'Choose a valid option.' });
  await audit.record(req.ctx, 'lead.temperature_set', { entityType: 'lead', entityId: lead.id, oldValues: { temperature: lead.temperature }, newValues: { temperature: v } });
  await scoring.compute(lead.id);
  flash(req, 'ok', req.t('common.saved'));
  res.redirect(`/staff/leads/${lead.id}`);
}));

router.get('/settings/scoring', can('settings.manage'), ah(async (req, res) => {
  res.page('pages/staff/growth/scoring', { layout: 'staff', narrow: true, title: req.t('settings.scoring'), cfg: await scoring.config(), rules: scoring.RULES });
}));
router.post('/settings/scoring', can('settings.manage'), ah(async (req, res) => {
  const warm = Math.max(1, Math.min(99, Number(req.body.warm) || 30));
  const hot = Math.max(warm + 1, Math.min(100, Number(req.body.hot) || 60));
  const rules = {};
  for (const k of Object.keys(scoring.RULES)) rules[k] = { points: Math.max(-50, Math.min(50, Math.round(Number(req.body[`points_${k}`]) || 0))), enabled: [].concat(req.body[`enabled_${k}`] || []).includes('1') };
  await settings.set(req.ctx, 'scoring', { warm, hot, rules });
  const n = await scoring.recomputeAll();
  flash(req, 'ok', req.t('scoring.saved', { n }));
  res.redirect('/staff/settings/scoring');
}));

// ------------------------------------------------------------------ Analytics
router.get('/analytics', can('analytics.view'), ah(async (req, res) => {
  const p = period(req.query);
  const [overview, first, latest, camp, landing, programs, daily] = await Promise.all([analytics.overview(req.staff, p), analytics.sources(req.staff, p, 'first'), analytics.sources(req.staff, p, 'latest'),
    analytics.campaigns(req.staff, p), analytics.landingPages(req.staff, p), analytics.programsViewed(p), analytics.daily(req.staff, p)]);
  if (req.query.format === 'csv') {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="sources-${p.from}-${p.to}.csv"` });
    return res.send(toCsv([{ key: 'source' }, { key: 'leads' }, { key: 'students' }, { key: 'hot' }], first));
  }
  return res.page('pages/staff/growth/analytics', { layout: 'staff', title: req.t('nav.analytics'), p, overview, first, latest, camp, landing, programs, daily });
}));

router.get('/analytics/team', can('reports.team'), ah(async (req, res) => {
  const p = period(req.query);
  res.page('pages/staff/growth/team', { layout: 'staff', title: req.t('nav.performance'), p, team: await analytics.team(req.staff, p) });
}));

// ------------------------------------------------------------------ Campaigns
const statsOf = async (rows) => Promise.all(rows.map(async (c) => ({ ...c, stats: c.status === 'draft' ? null : await campaigns.stats(c.id) })));
router.get('/campaigns', can('campaigns.manage'), ah(async (req, res) => {
  res.page('pages/staff/growth/campaigns', { layout: 'staff', title: req.t('nav.campaigns'), rows: await statsOf(await knex('campaigns').orderBy('id', 'desc').limit(100)) });
}));

async function campaignForm(req, res, c, extra = {}) {
  const seg = c.segment ? (typeof c.segment === 'string' ? JSON.parse(c.segment) : c.segment) : { audience: 'leads' };
  res.page('pages/staff/growth/campaign', {
    layout: 'staff', narrow: true, title: c.id ? c.name : req.t('campaigns.new'), c, seg, stageList: await stages.all(), sourceList: await stages.sources(), destinations: await ref.destinationOptions(req.locale),
    counsellors: await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('e.is_counsellor', true).where('u.status', 'active').select('e.id', 'u.name').orderBy('u.name'),
    preview: c.id ? await campaigns.preview(seg, c.channel) : null, stats: c.id && c.status !== 'draft' ? await campaigns.stats(c.id) : null, old: {}, errors: {}, ...extra,
  });
}
router.get('/campaigns/new', can('campaigns.manage'), ah(async (req, res) => campaignForm(req, res, { channel: 'email', status: 'draft', segment: { audience: 'leads' } })));
router.get('/campaigns/:id', can('campaigns.manage'), ah(async (req, res) => {
  const c = await knex('campaigns').where({ id: idParam(req.params.id) }).first();
  if (!c) throw E.notFound();
  return campaignForm(req, res, c);
}));

const campaignSchema = z.object({
  name: reqStr(160), channel: z.enum(['email', 'sms', 'whatsapp']), subject_en: str(255), subject_ar: str(255), body_en: str(10000), body_ar: str(10000), cta_en: str(80), cta_ar: str(80),
  cta_url: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(500).refine((v) => /^(https?:\/\/|\/)/.test(v), 'Enter a full address starting with https:// or /').optional()),
});
async function saveCampaign(req, id) {
  const d = validate(campaignSchema, req.body);
  const row = { ...d, cta_url: d.cta_url || null, segment: JSON.stringify(campaigns.segmentFrom(req.body)), updated_at: new Date() };
  if (id) {
    const c = await knex('campaigns').where({ id }).first();
    if (!c) throw E.notFound();
    if (c.status !== 'draft') throw E.conflict('NOT_DRAFT', 'Launched campaigns cannot be edited.');
    await knex('campaigns').where({ id }).update(row);
    return id;
  }
  const slug = `${d.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'campaign'}-${Date.now().toString(36)}`;
  const [nid] = await knex('campaigns').insert({ ...row, slug, status: 'draft', created_by: req.user.id });
  await audit.record(req.ctx, 'campaign.created', { entityType: 'campaign', entityId: nid, newValues: { name: d.name, channel: d.channel } });
  return nid;
}
router.post('/campaigns', can('campaigns.manage'), ah(async (req, res) => {
  try { const id = await saveCampaign(req, null); flash(req, 'ok', req.t('common.saved')); return res.redirect(`/staff/campaigns/${id}`); } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422); return campaignForm(req, res, { ...req.body, status: 'draft', segment: campaigns.segmentFrom(req.body) }, { old: req.body, errors: e.details });
  }
}));
router.post('/campaigns/:id', can('campaigns.manage'), ah(async (req, res) => {
  const id = idParam(req.params.id);
  try { await saveCampaign(req, id); flash(req, 'ok', req.t('common.saved')); return res.redirect(`/staff/campaigns/${id}`); } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422); return campaignForm(req, res, { ...(await knex('campaigns').where({ id }).first()), ...req.body, segment: campaigns.segmentFrom(req.body) }, { old: req.body, errors: e.details });
  }
}));
router.post('/campaigns/:id/launch', can('campaigns.manage'), ah(async (req, res) => {
  const id = idParam(req.params.id);
  const when = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(req.body.scheduled_at || '') ? fmt.zonedToUtc(req.body.scheduled_at, res.locals.fmt.tz) : null;
  try {
    const n = await campaigns.launch(req.ctx, id, { scheduledAt: when && when > new Date() ? when : null });
    flash(req, 'ok', req.t('campaigns.launched', { n }));
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    flash(req, 'error', Object.values(e.details || {}).join(' '));
  }
  res.redirect(`/staff/campaigns/${id}`);
}));
router.post('/campaigns/:id/cancel', can('campaigns.manage'), ah(async (req, res) => {
  await campaigns.cancel(req.ctx, idParam(req.params.id));
  res.redirect(`/staff/campaigns/${req.params.id}`);
}));

// ------------------------------------------------------------------ Automations
router.get('/automations', can('automations.manage'), ah(async (req, res) => {
  res.page('pages/staff/growth/automations', { layout: 'staff', title: req.t('nav.automations'), rows: await knex('automations').orderBy('id') });
}));
async function automationForm(req, res, a, extra = {}) {
  res.page('pages/staff/growth/automation', {
    layout: 'staff', narrow: true, title: a.id ? a.name : req.t('automations.new'), a, conditions: typeof a.conditions === 'string' ? JSON.parse(a.conditions || '[]') : (a.conditions || []), actions: typeof a.actions === 'string' ? JSON.parse(a.actions || '[]') : (a.actions || []),
    triggers: automations.ALL_TRIGGERS, timed: automations.TIMED, fields: automations.FIELDS, actionTypes: automations.ACTIONS, templateKeys: [...Object.keys(templates.DEFAULTS), ...(await knex('message_templates').where('key', 'like', 'custom_%').distinct('key').pluck('key'))],
    stageList: await stages.all(), employees: await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('u.status', 'active').select('e.id', 'u.name').orderBy('u.name'),
    runs: a.id ? await knex('automation_runs').where({ automation_id: a.id }).orderBy('id', 'desc').limit(20) : [], old: {}, errors: {}, ...extra,
  });
}
router.get('/automations/new', can('automations.manage'), ah(async (req, res) => automationForm(req, res, { trigger: 'lead.created', conditions: [], actions: [{ type: 'create_task', title: '', due_hours: 24, assign: 'counsellor' }] })));
router.get('/automations/:id', can('automations.manage'), ah(async (req, res) => {
  const a = await knex('automations').where({ id: idParam(req.params.id) }).first();
  if (!a) throw E.notFound();
  return automationForm(req, res, a);
}));

function rowsFrom(body, prefix, keys) {
  const cols = Object.fromEntries(keys.map((k) => [k, [].concat(body[`${prefix}_${k}`] || [])]));
  const n = Math.max(0, ...Object.values(cols).map((c) => c.length));
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(Object.fromEntries(keys.map((k) => [k, String(cols[k][i] ?? '').slice(0, 500)])));
  return out;
}
async function saveAutomation(req, id) {
  const d = validate(z.object({ name: reqStr(160), trigger: z.enum(automations.ALL_TRIGGERS), delay_hours: z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(v)), z.number().int().min(0).max(24 * 90)) }), req.body);
  const conditions = rowsFrom(req.body, 'c', ['field', 'op', 'value']).filter((c) => automations.FIELDS.includes(c.field) && c.value);
  const actions = rowsFrom(req.body, 'a', ['type', 'template', 'channel', 'title', 'due_hours', 'assign', 'stage_key', 'text', 'employee_id', 'priority']).filter((a) => automations.ACTIONS.includes(a.type));
  if (!actions.length) throw E.validation({ actions: 'Add at least one action.' });
  for (const a of actions) {
    if (a.type === 'send_template' && !a.template) throw E.validation({ actions: 'Choose the template to send.' });
    if (a.type === 'create_task' && !a.title) throw E.validation({ actions: 'Give the task a title.' });
  }
  const row = { name: d.name, trigger: d.trigger, delay_hours: d.delay_hours, conditions: JSON.stringify(conditions), actions: JSON.stringify(actions), updated_at: new Date() };
  if (id) { await knex('automations').where({ id }).update(row); } else { [id] = await knex('automations').insert({ ...row, is_active: false, created_by: req.user.id }); } // eslint-disable-line no-param-reassign
  await audit.record(req.ctx, 'automation.saved', { entityType: 'automation', entityId: id, newValues: { name: d.name, trigger: d.trigger, conditions: conditions.length, actions: actions.map((a) => a.type) } });
  return id;
}
router.post('/automations', can('automations.manage'), ah(async (req, res) => {
  try { const id = await saveAutomation(req, null); flash(req, 'ok', req.t('automations.saved_off')); return res.redirect(`/staff/automations/${id}`); } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422); return automationForm(req, res, { ...req.body, conditions: rowsFrom(req.body, 'c', ['field', 'op', 'value']), actions: rowsFrom(req.body, 'a', ['type', 'template', 'channel', 'title', 'due_hours', 'assign', 'stage_key', 'text', 'employee_id', 'priority']) }, { old: req.body, errors: e.details });
  }
}));
router.post('/automations/:id', can('automations.manage'), ah(async (req, res) => {
  const id = idParam(req.params.id);
  if (!(await knex('automations').where({ id }).first('id'))) throw E.notFound();
  try { await saveAutomation(req, id); flash(req, 'ok', req.t('common.saved')); return res.redirect(`/staff/automations/${id}`); } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422); return automationForm(req, res, { id, ...req.body, conditions: rowsFrom(req.body, 'c', ['field', 'op', 'value']), actions: rowsFrom(req.body, 'a', ['type', 'template', 'channel', 'title', 'due_hours', 'assign', 'stage_key', 'text', 'employee_id', 'priority']) }, { old: req.body, errors: e.details });
  }
}));
router.post('/automations/:id/toggle', can('automations.manage'), ah(async (req, res) => {
  const a = await knex('automations').where({ id: idParam(req.params.id) }).first();
  if (!a) throw E.notFound();
  await knex('automations').where({ id: a.id }).update({ is_active: !a.is_active, updated_at: new Date() });
  await audit.record(req.ctx, a.is_active ? 'automation.disabled' : 'automation.enabled', { entityType: 'automation', entityId: a.id });
  flash(req, 'ok', req.t(a.is_active ? 'automations.disabled' : 'automations.enabled'));
  res.redirect(req.body.back === 'list' ? '/staff/automations' : `/staff/automations/${a.id}`);
}));
router.post('/automations/:id/delete', can('automations.manage'), ah(async (req, res) => {
  await knex('automations').where({ id: idParam(req.params.id) }).del();
  await audit.record(req.ctx, 'automation.deleted', { entityType: 'automation', entityId: Number(req.params.id) });
  res.redirect('/staff/automations');
}));

module.exports = router;
