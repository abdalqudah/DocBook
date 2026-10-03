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
const ops = require('../platformops/ops.service');

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
router.use('/', require('./reviews.web'));
router.use('/', require('../ai/admin.web')); // AI assistant: provider key and model
router.use('/', require('../subscriptions/admin.web'));
router.use('/', require('../platformops/admin.web')); // in-app update from a dist zip // plans and clinic subscriptions // patient reviews: moderation (hide with a reason)

const page = (res, view, data) => res.page(`pages/admin/${view}`, { layout: 'admin', pageStyles: ['/css/site.css'], ...data });
const like = (q) => `%${String(q).trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
const since = (days) => new Date(Date.now() - days * 86_400_000);
const PER_PAGE = 25;
const pageMeta = (total, p) => { const pages = Math.max(1, Math.ceil(total / PER_PAGE)); const cur = Math.min(Math.max(1, Number(p) || 1), pages); return { total, page: cur, pages, perPage: PER_PAGE }; };

// ---------------------------------------------------------------- overview
router.get('/', wrap(async (req, res) => {
  const count = async (q) => Number((await q.count({ n: '*' }))[0].n);
  const d30 = since(30);
  const [clinics, active, suspended, users, activeUsers, appts, online, recentClinics, activity, sent, screens, chats, centreSends, centreClinics, mailboxes, moves, used] = await Promise.all([
    count(knex('businesses')), count(knex('businesses').where({ status: 'active' })), count(knex('businesses').where({ status: 'suspended' })),
    count(knex('users')), count(knex('users').where('last_login_at', '>=', d30)),
    count(knex('appointments').where('created_at', '>=', d30).whereNot('appointment_type', 'blocked')),
    count(knex('appointments').where('created_at', '>=', d30).where({ source: 'website' })),
    knex('businesses').orderBy('created_at', 'desc').limit(6).select('id', 'name', 'name_en', 'slug', 'status', 'created_at', 'onboarding_completed_at'),
    knex('audit_logs as l').leftJoin('users as u', 'u.id', 'l.user_id').whereNull('l.business_id').where((w) => w.where('l.action', 'like', 'platform.%').orWhere('l.action', 'like', 'clinic.backup%'))
      .orderBy('l.id', 'desc').limit(8).select('l.action', 'l.entity_type', 'l.entity_id', 'l.new_values', 'l.created_at', 'u.name as user_name'),
    count(knex('share_links').where('created_at', '>=', d30)),
    count(knex('queue_screens').where({ is_active: true }).where('last_seen_at', '>=', new Date(Date.now() - 60_000))),
    count(knex('staff_chat_messages').where('created_at', '>=', d30)),
    count(knex('partner_sends').where('created_at', '>=', d30)),
    knex('clinic_partners').countDistinct({ n: 'business_id' }).then((r) => Number(r[0].n)),
    count(knex('staff_mailboxes')),
    count(knex('audit_logs').whereIn('action', ['patient.exported', 'patients.exported_all', 'patients.imported']).where('created_at', '>=', d30)),
    require('../storage/storage.service').usageAll(), // eslint-disable-line global-require
  ]);
  // File storage: everything the clinics keep, and how many are at 80 % of their size or more.
  const storageSvc = require('../storage/storage.service'); // eslint-disable-line global-require
  let storageBytes = 0; let nearFull = 0;
  for (const [bid, bytes] of used) { // eslint-disable-line no-restricted-syntax
    storageBytes += bytes;
    const q = await storageSvc.quotaOf(bid); // eslint-disable-line no-await-in-loop
    if (q.mb !== null && bytes >= q.mb * storageSvc.MB * 0.8) nearFull += 1;
  }
  // Clinics whose own backup is younger than a day (the nightly job keeps one per clinic).
  const live = await knex('businesses').whereNot('status', 'deleted').pluck('id');
  const backedUp = live.filter((id) => { const last = backup.list(id)[0]; return last && Date.now() - new Date(last.at).getTime() < 36 * 3600_000; }).length;
  // Links in e-mails, invitations, resets and the attendance QR need the real site address (APP_URL).
  const { isLocalUrl, isLocalHost } = require('../../middleware/web'); // eslint-disable-line global-require
  const appUrlWarning = (!process.env.APP_URL || isLocalUrl(process.env.APP_URL)) && !isLocalHost(req.hostname)
    ? { current: process.env.APP_URL || '', suggested: `https://${req.hostname}` } : null;
  page(res, 'overview', { title: req.t('admin.nav_overview'), stats: { clinics, active, suspended, users, activeUsers, appts, online, sent, screens, chats, centreSends, centreClinics, backedUp, backupTotal: live.length, mailboxes, moves, storageBytes, nearFull }, dbPending: await require('../../db/auto').pending().catch(() => []), recentClinics, activity, appUrlWarning });
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
  rows.forEach((r) => { const last = backup.list(r.id)[0]; r.lastBackup = last ? last.at : null; });
  // File storage of the clinics on this page: used of their size.
  const storageSvc = require('../storage/storage.service'); // eslint-disable-line global-require
  const used = rows.length ? await storageSvc.usageAll(rows.map((r) => r.id)) : new Map();
  await Promise.all(rows.map(async (r) => { const q = await storageSvc.quotaOf(r.id); r.storage = { bytes: used.get(r.id) || 0, quota: q.mb === null ? null : q.mb * storageSvc.MB }; }));
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
  const d30 = since(30);
  const [full, sent, screens, chats, centres, centreSends, msgRow, mailboxes, moves] = await Promise.all([
    businesses.get(b.id),
    count(knex('share_links').where({ business_id: b.id }).where('created_at', '>=', d30)),
    knex('queue_screens').where({ business_id: b.id }).select('name', 'is_active', 'last_seen_at'),
    count(knex('staff_chat_messages').where({ business_id: b.id }).where('created_at', '>=', d30)),
    count(knex('clinic_partners').where({ business_id: b.id, is_active: true })),
    count(knex('partner_sends').where({ business_id: b.id }).where('created_at', '>=', d30)),
    knex('clinic_messages').where({ business_id: b.id }).first('texts'),
    count(knex('staff_mailboxes').where({ business_id: b.id })),
    knex('audit_logs').where({ business_id: b.id }).whereIn('action', ['patient.exported', 'patients.exported_all', 'patients.imported']).where('created_at', '>=', d30)
      .groupBy('action').select('action').count({ n: '*' }).then((rows) => Object.fromEntries(rows.map((r) => [r.action, Number(r.n)]))),
  ]);
  let ownTexts = 0;
  try { ownTexts = Object.keys(JSON.parse((msgRow && msgRow.texts) || '{}')).length; } catch { ownTexts = 0; }
  const modules = await ops.state(full);
  page(res, 'clinic', { title: b.name, b, counts: { patients, appts, online, doctors }, members, backups: backup.list(b.id), modules, usage: { sent, screens, chats, centres, centreSends, ownTexts, mailboxes, moves }, storage: await storageOf(full) });
}));

// ---------------------------------------------------------------- one clinic's file storage (media, patient files, chat …)
const clinicStorage = require('../storage/storage.service');
const entitlements = require('../subscriptions/entitlements');
/** Used space, the package's size (planMb: null = no limit) and this clinic's own size set here (null = follow the package). */
async function storageOf(business) {
  const [s, features, row] = await Promise.all([clinicStorage.stats(business.id), ops.planFeatures(business), knex('businesses').where({ id: business.id }).first('media_quota_mb')]);
  const planMb = features ? entitlements.valueIn(features, 'media.storage_mb') : clinicStorage.DEFAULT_MB;
  return { ...s, planMb, hasPlan: Boolean(features), ownMb: row.media_quota_mb === null || row.media_quota_mb === undefined ? null : Number(row.media_quota_mb) };
}

// Empty = follow the package. Recorded in the platform audit log.
router.post('/clinics/:id(\\d+)/storage', wrap(async (req, res) => {
  const full = await businesses.get(Number(req.params.id));
  if (!full) throw E.notFound('Clinic');
  const raw = String(req.body.media_quota_mb ?? '').trim();
  const mb = raw === '' || req.body.follow_plan === '1' ? null : Math.floor(Number(raw));
  if (mb !== null && (!Number.isFinite(mb) || mb < 1 || mb > 1_000_000)) {
    flash(req, 'error', req.t('admin.storage_invalid'));
    return res.redirect(`/admin/clinics/${full.id}#storage`);
  }
  const before = await knex('businesses').where({ id: full.id }).first('media_quota_mb');
  await knex('businesses').where({ id: full.id }).update({ media_quota_mb: mb, updated_at: new Date() });
  await audit.record(req.ctx, 'platform.clinic_storage', { entityType: 'clinic', entityId: full.id,
    oldValues: { media_quota_mb: before ? before.media_quota_mb : null }, newValues: { media_quota_mb: mb } });
  flash(req, 'success', req.t('admin.storage_saved'));
  return res.redirect(`/admin/clinics/${full.id}#storage`);
}));

// The clinic's optional areas (the same switches as the clinic's Settings → Modules), recorded in the clinic's audit log.
router.post('/clinics/:id(\\d+)/modules', wrap(async (req, res) => {
  const full = await businesses.get(Number(req.params.id));
  if (!full) throw E.notFound('Clinic');
  await ops.saveModules({ ...req.ctx, businessId: full.id, userId: req.user.id }, full, req.body);
  flash(req, 'success', req.t('admin.modules_saved'));
  res.redirect(`/admin/clinics/${full.id}#modules`);
}));

// ---------------------------------------------------------------- one clinic's own backup (separate from the others)
const backup = require('../platformops/clinic-backup');
const multer = require('multer');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
async function confirmPassword(req) {
  const user = await knex('users').where({ id: req.user.id }).first('id', 'password_hash');
  const ok = await require('../auth/auth.service').verifyPassword(user, String(req.body.password || '')).catch(() => false); // eslint-disable-line global-require
  if (!ok) throw E.validation({ password: 'Current password is incorrect.' });
}
const backupFail = (req, res, back) => (e) => {
  if (!(e instanceof AppError) || e.status >= 500) throw e;
  flash(req, 'error', e.code === 'VALIDATION_FAILED' ? req.t('admin.backup.err_password') : req.t(`admin.backup.err.${e.code}`) !== `admin.backup.err.${e.code}` ? req.t(`admin.backup.err.${e.code}`) : e.message);
  return res.redirect(back);
};

router.post('/clinics/:id(\\d+)/backups', wrap(async (req, res) => {
  const b = await knex('businesses').where({ id: req.params.id }).first('id');
  if (!b) throw E.notFound('Clinic');
  const r = await backup.createBackup(b.id, { reason: 'manual', ctx: req.ctx });
  flash(req, 'success', req.t('admin.backup.created', { rows: r.rows }));
  res.redirect(`/admin/clinics/${b.id}#backups`);
}));

router.get('/clinics/:id(\\d+)/backups/:name', wrap(async (req, res) => {
  const buf = backup.read(Number(req.params.id), req.params.name);
  await audit.record(req.ctx, 'clinic.backup_downloaded', { entityType: 'clinic', entityId: Number(req.params.id), newValues: { file: req.params.name } });
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="clinic-${Number(req.params.id)}-${req.params.name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
}));

router.post('/clinics/:id(\\d+)/backups/:name/restore', wrap(async (req, res) => {
  const id = Number(req.params.id);
  try {
    await confirmPassword(req);
    await backup.createBackup(id, { reason: 'manual', ctx: req.ctx }).catch(() => null); // the state just before, in case
    const r = await backup.restore(backup.read(id, req.params.name), { businessId: id, ctx: req.ctx });
    businesses.forget(id); cache.forgetPrefix('portal:');
    flash(req, 'success', req.t('admin.backup.restored', { rows: r.rows }));
    return res.redirect(`/admin/clinics/${id}#backups`);
  } catch (e) { return backupFail(req, res, `/admin/clinics/${id}#backups`)(e); }
}));

// A backup file from the admin's computer: puts that clinic back (also a clinic that was deleted).
const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024, files: 1, fields: 4 } });
router.post('/clinics/restore', (req, res, next) => backupUpload.single('file')(req, res, (err) => { if (err) req.uploadError = err; next(); }), verifyCsrfAfterUpload, wrap(async (req, res) => {
  try {
    if (req.uploadError || !req.file) throw new AppError('BACKUP_INVALID', 'Choose a backup file.', 422);
    await confirmPassword(req);
    const r = await backup.restore(req.file.buffer, { ctx: req.ctx });
    businesses.forget(r.businessId); cache.forgetPrefix('portal:');
    flash(req, 'success', req.t('admin.backup.restored', { rows: r.rows }));
    return res.redirect(`/admin/clinics/${r.businessId}#backups`);
  } catch (e) { return backupFail(req, res, '/admin/clinics')(e); }
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
  const pricingData = await require('../site/web').landingPricing(content); // eslint-disable-line global-require
  res.page('pages/site/home', { layout: 'public', bodyClass: 'lp-modern', noindex: true, content, pricing: pricingData, pageTitle: site.pick(req.locale)(content.seo && content.seo.title), previewNote: hidden ? req.t('site.hidden_preview') : req.t('admin.site.preview') });
}));

// Media library, Search & AI (SEO/AEO/GEO) and Social & tracking.
router.use('/', require('./growth.web'));

module.exports = router;
