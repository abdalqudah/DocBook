// Platform admin (/admin): only accounts with users.is_platform_admin = 1; everyone else gets a 404.
// Overview, clinics (suspend / reactivate), user accounts (disable / enable), the landing-page editor
// ported from the previous platform release, and (growth.web.js) its media library, Search & AI and Social & tracking. Every change is written to audit_logs with business_id NULL (platform scope).
const express = require('express');
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { requireAuth } = require('../../middleware/context');
const businesses = require('../businesses/business.service');
const site = require('../site/content.service');
const media = require('../site/media.service');

const router = express.Router();

// ---------------------------------------------------------------- access
router.use(requireAuth, (req, res, next) => {
  if (!req.user || !req.user.is_platform_admin) return next(new AppError('NOT_FOUND', 'Page not found.', 404));
  req.ctx = { businessId: null, userId: req.user.id, userName: req.user.name, ip: req.ip, userAgent: req.get('user-agent'), locale: req.locale, permissions: new Set() };
  res.locals.adminPath = req.baseUrl + req.path;
  res.locals.L = site.pick(req.locale);
  return next();
});
router.use('/', require('./identity.web')); // Google sign-in + clinic custom domains (identity area)
router.use('/', require('./vendors.web')); // reps & warehouses: approval and moderation

const page = (res, view, data) => res.page(`pages/admin/${view}`, { layout: 'admin', pageStyles: ['/css/site.css'], ...data });
const like = (q) => `%${String(q).trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
const since = (days) => new Date(Date.now() - days * 86_400_000);
const PER_PAGE = 25;
const pageMeta = (total, p) => { const pages = Math.max(1, Math.ceil(total / PER_PAGE)); const cur = Math.min(Math.max(1, Number(p) || 1), pages); return { total, page: cur, pages, perPage: PER_PAGE }; };

// ---------------------------------------------------------------- overview
router.get('/', wrap(async (req, res) => {
  const count = async (q) => Number((await q.count({ n: '*' }))[0].n);
  const d30 = since(30);
  const [clinics, active, suspended, users, activeUsers, appts, online, recentClinics, activity] = await Promise.all([
    count(knex('businesses')), count(knex('businesses').where({ status: 'active' })), count(knex('businesses').where({ status: 'suspended' })),
    count(knex('users')), count(knex('users').where('last_login_at', '>=', d30)),
    count(knex('appointments').where('created_at', '>=', d30).whereNot('appointment_type', 'blocked')),
    count(knex('appointments').where('created_at', '>=', d30).where({ source: 'website' })),
    knex('businesses').orderBy('created_at', 'desc').limit(6).select('id', 'name', 'name_en', 'slug', 'status', 'created_at', 'onboarding_completed_at'),
    knex('audit_logs as l').leftJoin('users as u', 'u.id', 'l.user_id').whereNull('l.business_id').where('l.action', 'like', 'platform.%')
      .orderBy('l.id', 'desc').limit(8).select('l.action', 'l.entity_type', 'l.entity_id', 'l.new_values', 'l.created_at', 'u.name as user_name'),
  ]);
  // Links in e-mails, invitations, resets and the attendance QR need the real site address (APP_URL).
  const { isLocalUrl, isLocalHost } = require('../../middleware/web'); // eslint-disable-line global-require
  const appUrlWarning = (!process.env.APP_URL || isLocalUrl(process.env.APP_URL)) && !isLocalHost(req.hostname)
    ? { current: process.env.APP_URL || '', suggested: `https://${req.hostname}` } : null;
  page(res, 'overview', { title: req.t('admin.nav_overview'), stats: { clinics, active, suspended, users, activeUsers, appts, online }, recentClinics, activity, appUrlWarning });
}));

// ---------------------------------------------------------------- clinics
router.get('/clinics', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const status = ['active', 'suspended'].includes(req.query.status) ? req.query.status : '';
  const base = knex('businesses as b').modify((qb) => {
    if (q) qb.andWhere((w) => w.where('b.name', 'like', like(q)).orWhere('b.name_en', 'like', like(q)).orWhere('b.slug', 'like', like(q)).orWhere('b.email', 'like', like(q)).orWhere('b.phone', 'like', like(q)));
    if (status) qb.where('b.status', status);
  });
  const [{ n }] = await base.clone().count({ n: '*' });
  const meta = pageMeta(Number(n), req.query.page);
  const d30 = since(30);
  const rows = await base.clone().orderBy('b.created_at', 'desc').limit(PER_PAGE).offset((meta.page - 1) * PER_PAGE).select(
    'b.id', 'b.name', 'b.name_en', 'b.slug', 'b.status', 'b.city', 'b.currency', 'b.booking_enabled', 'b.created_at', 'b.onboarding_completed_at',
    knex('memberships').count('*').where('business_id', knex.ref('b.id')).where('status', 'active').as('staff'),
    knex('doctors').count('*').where('business_id', knex.ref('b.id')).where('is_active', true).as('doctors'),
    knex('appointments').count('*').where('business_id', knex.ref('b.id')).where('created_at', '>=', d30).as('appts'),
  );
  page(res, 'clinics', { title: req.t('admin.nav_clinics'), rows, meta, q, status });
}));

router.get('/clinics/:id(\\d+)', wrap(async (req, res) => {
  const b = await knex('businesses').where({ id: req.params.id }).first('id', 'name', 'name_en', 'slug', 'specialty', 'country', 'city', 'currency', 'timezone', 'phone', 'whatsapp', 'email',
    'address', 'booking_enabled', 'status', 'created_at', 'onboarding_completed_at');
  if (!b) throw E.notFound('Clinic');
  const count = async (q) => Number((await q.count({ n: '*' }))[0].n);
  const [patients, appts, online, doctors, members] = await Promise.all([
    count(knex('patients').where({ business_id: b.id })),
    count(knex('appointments').where({ business_id: b.id }).whereNot('appointment_type', 'blocked')),
    count(knex('appointments').where({ business_id: b.id, source: 'website' })),
    count(knex('doctors').where({ business_id: b.id, is_active: true })),
    businesses.listMembers(b.id),
  ]);
  page(res, 'clinic', { title: b.name, b, counts: { patients, appts, online, doctors }, members });
}));

router.post('/clinics/:id(\\d+)/status', wrap(async (req, res) => {
  const b = await knex('businesses').where({ id: req.params.id }).first('id', 'status', 'name');
  if (!b) throw E.notFound('Clinic');
  const next = req.body.status === 'suspended' ? 'suspended' : 'active';
  if (next !== b.status) {
    await knex('businesses').where({ id: b.id }).update({ status: next, updated_at: new Date() });
    businesses.forget(b.id);
    cache.forgetPrefix('portal:');
    await audit.record(req.ctx, next === 'suspended' ? 'platform.clinic_suspended' : 'platform.clinic_activated',
      { entityType: 'clinic', entityId: b.id, oldValues: { status: b.status }, newValues: { status: next, name: b.name } });
  }
  flash(req, 'success', req.t(next === 'suspended' ? 'admin.suspended_done' : 'admin.activated_done'));
  res.redirect(req.body.back === 'detail' ? `/admin/clinics/${b.id}` : '/admin/clinics');
}));

// ---------------------------------------------------------------- users
router.get('/users', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const base = knex('users as u').modify((qb) => { if (q) qb.andWhere((w) => w.where('u.name', 'like', like(q)).orWhere('u.email', 'like', like(q))); });
  const [{ n }] = await base.clone().count({ n: '*' });
  const meta = pageMeta(Number(n), req.query.page);
  const rows = await base.clone().orderBy('u.created_at', 'desc').limit(PER_PAGE).offset((meta.page - 1) * PER_PAGE).select(
    'u.id', 'u.name', 'u.email', 'u.status', 'u.is_platform_admin', 'u.last_login_at', 'u.created_at', 'u.email_verified_at',
    knex('memberships').count('*').where('user_id', knex.ref('u.id')).where('status', 'active').as('clinics'),
  );
  page(res, 'users', { title: req.t('admin.nav_users'), rows, meta, q });
}));

router.post('/users/:id(\\d+)/status', wrap(async (req, res) => {
  const u = await knex('users').where({ id: req.params.id }).first('id', 'status', 'name', 'email');
  if (!u) throw E.notFound('User');
  if (u.id === req.user.id) { flash(req, 'error', req.t('admin.self_disable')); return res.redirect('/admin/users'); }
  const next = req.body.status === 'disabled' ? 'disabled' : 'active';
  if (next !== u.status) {
    await knex('users').where({ id: u.id }).update({ status: next, updated_at: new Date() });
    if (next === 'disabled') await knex('sessions').where('sess', 'like', `%"userId":${u.id},%`).del().catch(() => {});
    await audit.record(req.ctx, next === 'disabled' ? 'platform.user_disabled' : 'platform.user_enabled',
      { entityType: 'user', entityId: u.id, oldValues: { status: u.status }, newValues: { status: next, email: u.email } });
  }
  flash(req, 'success', req.t(next === 'disabled' ? 'admin.disabled_done' : 'admin.enabled_done'));
  return res.redirect(`/admin/users${req.body.q ? `?q=${encodeURIComponent(req.body.q)}` : ''}`);
}));

// ---------------------------------------------------------------- landing page editor
const TYPE_KEYS = Object.keys(site.TYPES);

router.get('/site', wrap(async (req, res) => {
  page(res, 'site/index', { title: req.t('admin.site.title'), content: await site.get(), types: TYPE_KEYS, customised: await site.isCustomised(), pageScripts: ['/js/site-editor.js'] });
}));

router.post('/site/sections', wrap(async (req, res) => {
  const type = String(req.body.type || '');
  if (!site.TYPES[type]) { flash(req, 'error', req.t('errors.VALIDATION_FAILED')); return res.redirect('/admin/site'); }
  const id = await site.addSection(req.ctx, type, String(req.body.after || ''));
  flash(req, 'success', req.t('admin.site.added'));
  return res.redirect(`/admin/site/sections/${id}`);
}));

const editorData = async () => ({ icons: site.ICONS, media: (await media.list()).map((m) => ({ ...m, url: media.urlOf(m) })), DESIGN: site.DESIGN, pageScripts: ['/js/site-editor.js'] });

router.get('/site/sections/:id', wrap(async (req, res) => {
  const content = await site.get();
  const s = content.sections.find((x) => x.id === req.params.id);
  if (!s) throw E.notFound('Section');
  page(res, 'site/edit', { title: req.t(`admin.site.types.${s.type}`), kind: 'section', s, schema: site.TYPES[s.type], data: s.data, design: s.design || {}, action: `/admin/site/sections/${encodeURIComponent(s.id)}`, ...(await editorData()) });
}));

router.post('/site/sections/:id', wrap(async (req, res) => {
  await site.updateSection(req.ctx, req.params.id, req.body);
  flash(req, 'success', req.t('admin.site.saved'));
  res.redirect(req.body.stay === '1' ? `/admin/site/sections/${encodeURIComponent(req.params.id)}` : `/admin/site#s-${encodeURIComponent(req.params.id)}`);
}));

const ACTIONS = {
  move: (ctx, id, b) => site.moveSection(ctx, id, b.dir === 'down' ? 'down' : 'up'),
  toggle: (ctx, id) => site.toggleSection(ctx, id),
  delete: (ctx, id) => site.removeSection(ctx, id),
  duplicate: (ctx, id) => site.duplicateSection(ctx, id),
};
for (const [name, fn] of Object.entries(ACTIONS)) {
  router.post(`/site/sections/:id/${name}`, wrap(async (req, res) => {
    const out = await fn(req.ctx, req.params.id, req.body);
    if (name !== 'move') flash(req, 'success', req.t(`admin.site.done_${name}`));
    res.redirect(`/admin/site#s-${encodeURIComponent(name === 'duplicate' ? out : req.params.id)}`);
  }));
}

for (const which of Object.keys(site.BLOCKS)) {
  router.get(`/site/${which}`, wrap(async (req, res) => {
    const content = await site.get();
    page(res, 'site/edit', { title: req.t(`admin.site.${which}`), kind: which, s: null, schema: site.BLOCKS[which], data: content[which] || {}, design: {}, action: `/admin/site/${which}`, ...(await editorData()) });
  }));
  router.post(`/site/${which}`, wrap(async (req, res) => {
    await site.updateBlock(req.ctx, which, req.body);
    flash(req, 'success', req.t('admin.site.saved'));
    res.redirect('/admin/site');
  }));
}

// The page title and description moved to Search & AI.
router.get('/site/seo', (req, res) => res.redirect(301, '/admin/seo'));

router.post('/site/reset', wrap(async (req, res) => {
  if (String(req.body.confirm_name || '').trim() !== req.t('admin.site.reset_word')) {
    flash(req, 'error', req.t('admin.site.reset_wrong'));
    return res.redirect('/admin/site');
  }
  await site.reset(req.ctx);
  flash(req, 'success', req.t('admin.site.reset_done'));
  return res.redirect('/admin/site');
}));

// Preview, including hidden sections (marked), so the admin can check a section before showing it.
router.get('/site/preview', wrap(async (req, res) => {
  const content = structuredClone(await site.get());
  const hidden = content.sections.filter((s) => s.hidden).length;
  content.sections.forEach((s) => { s.hidden = false; });
  res.locals.siteChrome = content;
  res.page('pages/site/home', { layout: 'public', noindex: true, content, pageTitle: site.pick(req.locale)(content.seo && content.seo.title), previewNote: hidden ? req.t('site.hidden_preview') : req.t('admin.site.preview') });
}));

// Media library, Search & AI (SEO/AEO/GEO) and Social & tracking.
router.use('/', require('./growth.web'));

module.exports = router;
