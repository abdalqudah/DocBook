// Website workspace (/app/website, DocBook 2.0 redesign phase 4): the home of the clinic's online presence.
//   Overview · Builder · Theme & brand · Booking · Media · Domain · Reviews · Settings (address, publish state, versions)
// Permissions: website.view to look, website.edit to change the draft, website.publish to put it live or take it down,
// website.domain for the domain. The builder and the domain follow the clinic's package (entitlements) — the classic
// clinic page and online booking never do.
const express = require('express');
const knex = require('../../db/knex');
const { E, AppError } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const { wrap, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const businesses = require('../businesses/business.service');
const domains = require('../branding/domain.service');
const ops = require('../platformops/ops.service');
const site = require('./site.service');
const sections = require('./sections');
const render = require('./render');
const { THEMES, TEMPLATES } = require('./catalog');

const router = express.Router();
const ASSETS = { pageStyles: ['/css/admin.css', '/css/website-admin.css', '/css/integrations.css'], pageScripts: ['/js/admin.js', '/js/integrations.js', '/js/website.js'] };
const baseUrl = (req) => (process.env.APP_URL ? require('../../config').appUrl.replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`); // eslint-disable-line global-require
const page = (req, res, view, data = {}) => res.page(`pages/website/${view}`, { ...ASSETS, ...data, pageStyles: [...ASSETS.pageStyles, ...(data.pageStyles || [])], pageScripts: [...ASSETS.pageScripts, ...(data.pageScripts || [])] });
const errText = (req, e) => { for (const k of [`errors_website.${e.code}`, `errors.${e.code}`]) { const s = req.t(k); if (s !== k) return s; } return e.message; };
/** Runs a change and comes back with a flash message (expected refusals become a message, not an error page). */
const act = (fn, okKey, back) => wrap(async (req, res) => {
  try {
    const r = await fn(req);
    if (okKey) flash(req, 'success', req.t(okKey));
    return res.redirect(typeof back === 'function' ? back(req, r) : back);
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 403) throw e;
    const first = e.details && typeof e.details === 'object' ? Object.values(e.details).find((v) => typeof v === 'string') : null;
    flash(req, 'error', e.code === 'VALIDATION_FAILED' ? (first ? translateMessage(req.locale, first) : req.t('website.invalid')) : errText(req, e));
    return res.redirect(typeof back === 'function' ? back(req) : back);
  }
});
const entitled = (req, key) => ops.entitled(req.business, key);
const wantsJson = (req) => req.xhr || /application\/json/.test(req.get('accept') || '');

// ---------------------------------------------------------------- overview
router.get('/', can('website.view'), wrap(async (req, res) => {
  const b = req.business;
  const [st, domain, builderOk, domainOk, emailOk, doctors, services] = await Promise.all([
    site.state(b.id), domains.forClinic(b.id), entitled(req, 'website.builder'), entitled(req, 'website.custom_domain'), entitled(req, 'website.clinic_email'),
    knex('doctors').where({ business_id: b.id, is_active: true }).count({ n: '*' }).then((r) => Number(r[0].n)),
    knex('services').where({ business_id: b.id, is_active: true }).count({ n: '*' }).then((r) => Number(r[0].n)),
  ]);
  let mail = null;
  try { mail = await require('../clinicmail/clinicmail.service').status(b.id); } catch { mail = null; } // eslint-disable-line global-require
  page(req, res, 'overview', {
    title: req.t('navx.sec_website'), st, domain, b, publicUrl: b.slug ? `${baseUrl(req)}/${b.slug}` : null, mail,
    ent: { builder: builderOk, domain: domainOk, email: emailOk }, counts: { doctors, services },
  });
}));

// ---------------------------------------------------------------- builder
async function builderLocals(req) {
  const { row, doc } = await site.draft(req.ctx, req.business);
  const st = await site.state(req.ctx.businessId);
  // The page being edited: the one holding the chosen section, else ?page=, else home.
  const holder = req.query.s ? site.pageWith(doc, String(req.query.s)) : null;
  const page = holder || doc.pages.find((p) => p.key === req.query.page) || doc.pages[0];
  const list = page.sections;
  const selected = list.find((s) => s.id === req.query.s) || null;
  const panel = !selected && ['header', 'footer', 'pages', 'page'].includes(req.query.panel) ? req.query.panel : null;
  const [doctors, allowedTemplates] = await Promise.all([
    knex('doctors').where({ business_id: req.ctx.businessId, is_active: true }).orderBy([{ column: 'sort_order' }, { column: 'full_name' }]).select('id', 'full_name', 'full_name_en'),
    entitled(req, 'website.templates'),
  ]);
  const media = await render.mediaUrls({ ...req.business, id: req.ctx.businessId }, doc, { preview: true });
  return { row, doc, st, page, pages: doc.pages, panel, list, selected, doctors, media, HEADER: sections.HEADER, FOOTER: sections.FOOTER, SOCIAL: Object.keys(sections.SOCIAL), NAV_KINDS: sections.NAV_KINDS, MAX_PAGES: sections.MAX_PAGES, TYPES: sections.TYPES, TYPE_KEYS: sections.TYPE_KEYS, ICONS: sections.ICONS, SHAPES: sections.SHAPES, allowedTemplates, TEMPLATES };
}
const lockedPage = (req, res, feature) => page(req, res, 'locked', { title: req.t('navx.sec_website'), feature, manager: req.ctx.permissions.has('settings.manage') });

router.get('/builder', can('website.edit'), wrap(async (req, res) => {
  if (!(await entitled(req, 'website.builder'))) return lockedPage(req, res, 'builder');
  // Full-screen editor (own layout, no app menu) so the preview gets the room.
  return page(req, res, 'builder', { layout: 'builder', title: req.t('website.builder_title'), ...(await builderLocals(req)), pageStyles: ['/css/website-builder.css'] });
}));
const toBuilder = (req, r) => `/app/website/builder${req.params && req.params.id ? `?s=${req.params.id}` : (r && typeof r === 'string' ? `?s=${r}` : '')}`;
const builderGate = wrap(async (req, res, next) => (await entitled(req, 'website.builder') ? next() : lockedPage(req, res, 'builder')));

router.post('/builder/sections', can('website.edit'), builderGate, act(async (req) => {
  const pageKey = String(req.body.page || 'home');
  const doc = await site.edit(req.ctx, req.business, site.ops.add(String(req.body.type || ''), String(req.body.after || '') || null, pageKey), { note: 'website.section_added', details: { type: req.body.type } });
  const list = site.pageOf(doc, pageKey).sections;
  const added = req.body.after ? list[list.findIndex((s) => s.id === req.body.after) + 1] : list[list.length - 1];
  return added ? added.id : null;
}, 'website.section_added_ok', toBuilder));
const updateSection = (req) => site.edit(req.ctx, req.business, site.ops.update(req.params.id, {
  variant: req.body.variant, content: req.body.content || {}, settings: req.body.settings || {},
}), { note: null });
// The builder saves as you type (JSON); without JavaScript the form posts and comes back.
router.post('/builder/sections/:id([a-f0-9]{10})', can('website.edit'), builderGate, wrap(async (req, res, next) => {
  if (!wantsJson(req)) return next();
  try {
    await updateSection(req);
    return res.json({ ok: true });
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 403) throw e;
    return res.status(e.status).json({ ok: false, error: errText(req, e) });
  }
}), act(updateSection, 'website.saved', toBuilder));
router.post('/builder/sections/:id([a-f0-9]{10})/move', can('website.edit'), builderGate, act((req) => site.edit(req.ctx, req.business, site.ops.move(req.params.id, req.body.dir === 'up' ? 'up' : 'down'), { note: null }), null, toBuilder));
router.post('/builder/sections/:id([a-f0-9]{10})/toggle', can('website.edit'), builderGate, act((req) => site.edit(req.ctx, req.business, site.ops.toggle(req.params.id), { note: null }), 'website.saved', toBuilder));
router.post('/builder/sections/:id([a-f0-9]{10})/delete', can('website.edit'), builderGate, act((req) => site.edit(req.ctx, req.business, site.ops.remove(req.params.id), { note: 'website.section_removed' }), 'website.section_removed_ok', '/app/website/builder'));
router.post('/builder/order', can('website.edit'), builderGate, wrap(async (req, res) => {
  await site.edit(req.ctx, req.business, site.ops.order(req.body.ids, String(req.body.page || 'home')), { note: null });
  return res.json({ ok: true });
}));

// ---- pages, menu, footer (the builder's "Site" tab)
const toPage = (key) => `/app/website/builder?page=${encodeURIComponent(key)}&panel=page`;
const pageKeyOk = (req) => /^[a-f0-9]{10}$/.test(req.params.key) || req.params.key === 'home';
const pair = (v) => ({ ar: String((v && v.ar) || ''), en: String((v && v.en) || '') });
router.post('/builder/pages', can('website.edit'), builderGate, act(async (req) => {
  // Extra pages follow the package (website.max_pages; no limit while subscriptions are off).
  const max = await entitled(req, 'website.max_pages');
  const { doc: cur } = await site.draft(req.ctx, req.business);
  if (max !== null && max !== undefined && cur.pages.length - 1 >= Number(max)) throw new AppError('PAGE_PLAN_LIMIT', 'The clinic\'s package does not include more pages.', 402);
  const doc = await site.edit(req.ctx, req.business, site.ops.addPage(pair(req.body.title)), { note: 'website.page_added' });
  return doc.pages[doc.pages.length - 1].key;
}, 'website.page_added_ok', (req, key) => (key ? toPage(key) : '/app/website/builder?panel=pages')));
const pageUpdate = (req) => site.edit(req.ctx, req.business, site.ops.updatePage(req.params.key, {
  title: req.body.title ? pair(req.body.title) : undefined, slug: req.body.slug !== undefined ? req.body.slug : undefined,
  menu: req.body.menu !== undefined ? [].concat(req.body.menu).pop() : undefined,
  seo: req.body.seo ? { title: pair(req.body.seo.title), description: pair(req.body.seo.description) } : undefined,
}), { note: null });
router.post('/builder/pages/:key', can('website.edit'), builderGate, wrap(async (req, res, next) => {
  if (!pageKeyOk(req)) return next();
  if (!wantsJson(req)) return next();
  try { await pageUpdate(req); return res.json({ ok: true }); } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 403) throw e;
    const first = e.details && typeof e.details === 'object' ? Object.values(e.details).find((v) => typeof v === 'string') : null;
    return res.status(e.status).json({ ok: false, error: first ? translateMessage(req.locale, first) : errText(req, e) });
  }
}), act(pageUpdate, 'website.saved', (req) => toPage(req.params.key)));
router.post('/builder/pages/:key/delete', can('website.edit'), builderGate, act((req) => site.edit(req.ctx, req.business, site.ops.removePage(req.params.key), { note: 'website.page_removed' }), 'website.page_removed_ok', '/app/website/builder?panel=pages'));
router.post('/builder/pages/:key/move', can('website.edit'), builderGate, act((req) => site.edit(req.ctx, req.business, site.ops.movePage(req.params.key, req.body.dir === 'up' ? 'up' : 'down'), { note: null }), null, '/app/website/builder?panel=pages'));
// A menu link is chosen from one list ("page:<key>", "section:<id>", "book"…): split it into kind + target.
const navInput = (h) => {
  const out = { ...(h || {}) };
  const items = Array.isArray(out.items) ? out.items : (out.items && typeof out.items === 'object' ? Object.values(out.items) : []);
  out.items = items.map((it) => {
    const pick = String([].concat((it && it.pick) || '').pop() || '');
    if (!pick) return it;
    const [kind, target] = pick.split(':');
    return { ...it, kind, target: target || null };
  });
  return out;
};
const siteFormSave = (opName, field) => {
  const run = (req) => site.edit(req.ctx, req.business, site.ops[opName](opName === 'header' ? navInput(req.body[field]) : (req.body[field] || {})), { note: null });
  return [wrap(async (req, res, next) => {
    if (!wantsJson(req)) return next();
    await run(req);
    return res.json({ ok: true });
  }), act(run, 'website.saved', `/app/website/builder?panel=${opName}`)];
};
router.post('/builder/header', can('website.edit'), builderGate, ...siteFormSave('header', 'header'));
router.post('/builder/footer', can('website.edit'), builderGate, ...siteFormSave('footer', 'footer'));
router.post('/builder/template', can('website.edit'), builderGate, act(async (req) => site.edit(req.ctx, req.business, site.ops.template(String(req.body.template || ''), req.body.add_missing === '1', await entitled(req, 'website.templates')), { note: 'website.template_applied', details: { template: req.body.template } }), 'website.saved', '/app/website/theme'));
router.post('/builder/discard', can('website.edit'), builderGate, act((req) => site.discard(req.ctx, req.business), 'website.discarded', '/app/website/builder'));
router.post('/publish', can('website.publish'), builderGate, act((req) => site.publish(req.ctx, req.business), 'website.published_ok', '/app/website'));

// Member-only preview of the draft (framed by the builder; never indexed).
const sameOriginFrame = (res) => {
  const csp = res.getHeader('Content-Security-Policy');
  if (csp) res.setHeader('Content-Security-Policy', /frame-ancestors[^;]*/.test(csp) ? String(csp).replace(/frame-ancestors[^;]*/, "frame-ancestors 'self'") : `${csp};frame-ancestors 'self'`);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
};
router.get('/preview', can('website.view'), wrap(async (req, res) => {
  const { doc } = await site.draft(req.ctx, req.business);
  const portal = require('../site/portal.web'); // eslint-disable-line global-require
  const clinic = await portal.loadClinic({ ...req, params: { slug: req.business.slug || '' } }) || null;
  if (!clinic) { flash(req, 'warning', req.t('website.need_address')); return res.redirect('/app/website/settings'); }
  sameOriginFrame(res);
  res.set('Cache-Control', 'no-store');
  const page = doc.pages.find((p) => p.key === req.query.page) || doc.pages[0];
  return portal.renderSite(req, res, clinic, doc, { preview: true, page });
}));
router.get('/preview/theme.css', can('website.view'), wrap(async (req, res) => {
  const { doc } = await site.draft(req.ctx, req.business);
  res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.send(render.css(doc, req.business));
}));

// ---------------------------------------------------------------- theme & brand
router.get('/theme', can('website.edit'), wrap(async (req, res) => {
  if (!(await entitled(req, 'website.builder'))) return lockedPage(req, res, 'builder');
  const l = await builderLocals(req);
  const brandCfg = require('../../config/brand'); // eslint-disable-line global-require
  const colorDefaults = { primary: /^#[0-9a-fA-F]{6}$/.test(req.business.color || '') ? req.business.color : brandCfg.colors.light.primary, secondary: brandCfg.colors.light.accent };
  return page(req, res, 'theme', { title: req.t('website.theme_title'), ...l, THEMES, FONTS: sections.FONTS, RADII: sections.RADII, MOTION: sections.MOTION, colorDefaults });
}));
router.post('/theme', can('website.edit'), builderGate, act((req) => site.edit(req.ctx, req.business, site.ops.theme(String(req.body.theme || '')), { note: 'website.theme_changed', details: { theme: req.body.theme } }), 'website.saved', '/app/website/theme'));
router.post('/brand', can('website.edit'), builderGate, act((req) => site.edit(req.ctx, req.business, site.ops.brand({
  primary: req.body.use_primary === '1' ? String(req.body.primary || '') : null,
  secondary: req.body.use_secondary === '1' ? String(req.body.secondary || '') : null,
  font: req.body.font, radius: req.body.radius, motion: req.body.motion, logoMediaId: req.body.logo_media_id, faviconMediaId: req.body.favicon_media_id,
}), { note: 'website.brand_changed' }), 'website.saved', '/app/website/theme'));

// ---------------------------------------------------------------- settings: address, publish state, versions
router.get('/settings', can('website.edit'), wrap(async (req, res) => {
  const b = req.business;
  const [st, versions] = await Promise.all([site.state(b.id), site.versions(b.id)]);
  page(req, res, 'settings', {
    title: req.t('website.settings_title'), b, st, versions, base: baseUrl(req), publicUrl: b.slug ? `${baseUrl(req)}/${b.slug}` : null,
    suggestion: b.slug ? null : await businesses.suggestSlug(b.name_en || b.name), errors: {}, old: null,
  });
}));
router.post('/settings/slug', can('website.edit'), act(async (req) => businesses.setSlug(req.ctx, req.body.slug), 'settings.portal_saved', '/app/website/settings'));
router.post('/unpublish', can('website.publish'), act((req) => site.unpublish(req.ctx), 'website.unpublished_ok', '/app/website/settings'));
router.post('/republish', can('website.publish'), act((req) => site.republish(req.ctx), 'website.republished_ok', '/app/website/settings'));
router.post('/versions/:id(\\d+)/restore', can('website.edit'), builderGate, act((req) => site.restore(req.ctx, req.business, req.params.id), 'website.restored_ok', '/app/website/builder'));

// ---------------------------------------------------------------- booking (online booking on/off, online consultations)
router.get('/booking', can('website.edit'), wrap(async (req, res) => {
  const b = req.business;
  const [doctors, services, onlineDoctors] = await Promise.all([
    knex('doctors').where({ business_id: b.id, is_active: true }).count({ n: '*' }).then((r) => Number(r[0].n)),
    knex('services').where({ business_id: b.id, is_active: true }).count({ n: '*' }).then((r) => Number(r[0].n)),
    knex('doctors').where({ business_id: b.id, is_active: true, online_enabled: true }).count({ n: '*' }).then((r) => Number(r[0].n)),
  ]);
  page(req, res, 'booking', { title: req.t('website.booking_title'), b, readiness: { doctors, services }, onlineDoctors });
}));
router.post('/booking', can('website.edit'), act(async (req) => {
  const on = req.body.booking_enabled === '1';
  await businesses.updateProfile(req.ctx, { booking_enabled: on });
  flash(req, 'success', req.t(on ? 'settings.booking_on_done' : 'settings.booking_off_done'));
}, null, '/app/website/booking'));

// ---------------------------------------------------------------- domain (wizard around the verified-domain engine)
router.get('/domain', can('website.domain'), wrap(async (req, res) => {
  if (!(await entitled(req, 'website.custom_domain'))) {
    const d = await domains.forClinic(req.ctx.businessId);
    if (!d) return lockedPage(req, res, 'domain'); // a domain connected before stays visible (it keeps working)
  }
  const [d, alias] = await Promise.all([domains.forClinic(req.ctx.businessId), domains.aliasFor(req.ctx.businessId)]);
  page(req, res, 'domain', {
    title: req.t('website.domain_title'), d, alias, rec: domains.records(d), aliasRec: domains.records(alias), counterpart: d ? domains.counterpart(d.host) : null,
    platformHost: domains.platformHost(), b: req.business, errors: {}, old: null,
  });
}));
const domainGate = wrap(async (req, res, next) => {
  if (await entitled(req, 'website.custom_domain')) return next();
  if (req.path.endsWith('/delete') && await domains.forClinic(req.ctx.businessId)) return next(); // removing is always allowed
  return lockedPage(req, res, 'domain');
});
router.post('/domain', can('website.domain'), domainGate, act((req) => domains.save(req.ctx, req.body.host), 'identity.domain_saved', '/app/website/domain'));
router.post('/domain/verify', can('website.domain'), domainGate, wrap(async (req, res) => {
  try {
    const r = await domains.check(req.ctx, req.ctx.businessId);
    if (r.justVerified) flash(req, 'success', req.t('identity.domain_now_live'));
    else if (r.live) flash(req, r.owned ? 'success' : 'warning', req.t(r.owned ? 'identity.domain_still_live' : 'identity.domain_keep_txt'));
    else if (r.conflict) flash(req, 'error', req.t('errors_identity.DOMAIN_TAKEN'));
    else flash(req, 'warning', req.t(!r.owned ? 'identity.domain_missing_txt' : 'identity.domain_missing_cname'));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, 'error', errText(req, e));
  }
  res.redirect('/app/website/domain');
}));
router.post('/domain/delete', can('website.domain'), domainGate, act((req) => domains.remove(req.ctx), 'identity.domain_removed', '/app/website/domain'));
router.post('/domain/ssl', can('website.domain'), domainGate, act(async (req) => {
  const r = await domains.checkSsl(req.ctx, req.ctx.businessId, { role: req.body.role === 'alias' ? 'alias' : 'primary' });
  flash(req, r.ssl_status === 'active' ? 'success' : r.ssl_status === 'failed' ? 'error' : 'warning', req.t(`website.ssl_msg.${r.ssl_status}`));
}, null, '/app/website/domain'));
router.post('/domain/alias', can('website.domain'), domainGate, act((req) => domains.saveAlias(req.ctx), 'website.alias_saved', '/app/website/domain#alias'));
router.post('/domain/alias/verify', can('website.domain'), domainGate, act(async (req) => {
  const r = await domains.check(req.ctx, req.ctx.businessId, { role: 'alias' });
  flash(req, r.live ? 'success' : 'warning', req.t(r.live ? 'website.alias_live' : (!r.owned ? 'identity.domain_missing_txt' : 'identity.domain_missing_cname')));
}, null, '/app/website/domain#alias'));
router.post('/domain/alias/delete', can('website.domain'), act((req) => domains.removeAlias(req.ctx), 'website.alias_removed', '/app/website/domain'));

// ---------------------------------------------------------------- search engines (the draft's SEO; live on publish)
router.get('/seo', can('website.seo'), wrap(async (req, res) => {
  if (!(await entitled(req, 'website.builder'))) return lockedPage(req, res, 'builder');
  const l = await builderLocals(req);
  const media = await render.mediaUrls({ ...req.business, id: req.ctx.businessId }, l.doc, { preview: true });
  return page(req, res, 'seo', { title: req.t('website.seo_title'), ...l, media, advanced: await entitled(req, 'website.advanced_seo'), base: baseUrl(req) });
}));
router.post('/seo', can('website.seo'), builderGate, act(async (req) => {
  const advanced = await entitled(req, 'website.advanced_seo');
  const b = req.body || {};
  return site.edit(req.ctx, req.business, (doc) => {
    const seo = { title: { ar: b.title_ar, en: b.title_en }, description: { ar: b.description_ar, en: b.description_en }, image: doc.seo.image || null, hide: doc.seo.hide || false };
    if (advanced) { seo.image = b.image_media_id || null; seo.hide = b.hide === '1'; }
    return site.ops.seo(seo)(doc);
  }, { note: 'website.seo_changed' });
}, 'website.saved', '/app/website/seo'));

// ---------------------------------------------------------------- statistics (first-party counters + bookings)
router.get('/analytics', can('website.analytics'), wrap(async (req, res) => {
  if (!(await entitled(req, 'website.analytics'))) return lockedPage(req, res, 'analytics');
  const data = await require('./stats').summary(req.ctx.businessId, req.ctx.today); // eslint-disable-line global-require
  return page(req, res, 'analytics', { title: req.t('website.analytics_title'), s: data });
}));

// ---------------------------------------------------------------- clinic e-mail (send from the clinic's own address)
const mailSvc = () => require('../clinicmail/clinicmail.service'); // eslint-disable-line global-require
router.get('/email', can('website.email'), wrap(async (req, res) => {
  const m = mailSvc();
  const [acc, entOk, providers, log] = await Promise.all([m.status(req.ctx.businessId), entitled(req, 'website.clinic_email'), m.providers(), m.recentLog(req.ctx.businessId)]);
  if (!entOk && !acc) return lockedPage(req, res, 'email');
  const dns = req.query.dns === '1' && acc ? await m.deliverability(acc.from_address, String(req.query.selector || '')) : null;
  return page(req, res, 'email', {
    title: req.t('website.email_title'), acc, entOk, providers, log, dns, kinds: m.KINDS, me: req.user,
    redirectUri: require('../clinicmail/oauth').redirectUri(), // eslint-disable-line global-require
  });
}));
const mailGate = wrap(async (req, res, next) => (await entitled(req, 'website.clinic_email') ? next() : lockedPage(req, res, 'email')));
router.post('/email/smtp', can('website.email'), mailGate, act((req) => mailSvc().saveSmtp(req.ctx, req.body), 'website.email_saved', '/app/website/email'));
router.post('/email/sender', can('website.email'), mailGate, act((req) => mailSvc().saveSender(req.ctx, req.body), 'website.saved', '/app/website/email'));
router.post('/email/test', can('website.email'), mailGate, act(async (req) => {
  const r = await mailSvc().testConnection(req.ctx);
  flash(req, r.ok ? 'success' : 'error', r.ok ? req.t('website.email_test_ok') : req.t('website.email_test_failed', { error: r.error || '' }));
}, null, '/app/website/email'));
router.post('/email/test-send', can('website.email'), mailGate, act(async (req) => {
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  const subject = req.t('website.email_test_subject');
  const r = await mailSvc().testSend(req.ctx, req.user.email, { subject, html: mailer.layout({ locale: req.locale, title: subject, body: req.t('website.email_test_body', { clinic: req.business.name }) }) });
  flash(req, r.ok ? 'success' : 'error', r.ok ? req.t('website.email_sent_to', { to: req.user.email }) : req.t('website.email_test_failed', { error: r.error || '' }));
}, null, '/app/website/email'));
router.post('/email/disconnect', can('website.email'), act((req) => mailSvc().disconnect(req.ctx), 'website.email_disconnected', '/app/website/email'));
router.get('/email/oauth/:provider(google|microsoft)/start', can('website.email'), mailGate, wrap(async (req, res) => {
  try {
    const { url, pending } = await require('../clinicmail/oauth').start(req.params.provider, req.ctx.businessId); // eslint-disable-line global-require
    req.session.mailOAuth = pending;
    return res.redirect(url);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', errText(req, e));
    return res.redirect('/app/website/email');
  }
}));
router.get('/email/oauth/callback', can('website.email'), mailGate, wrap(async (req, res) => {
  const pending = req.session.mailOAuth;
  delete req.session.mailOAuth;
  try {
    const r = await require('../clinicmail/oauth').finish(pending, req.query, req.ctx.businessId); // eslint-disable-line global-require
    await mailSvc()._saveOAuth(req.ctx, r.provider, r);
    const test = await mailSvc().testConnection(req.ctx);
    flash(req, test.ok ? 'success' : 'warning', test.ok ? req.t('website.email_oauth_ok', { account: r.account }) : req.t('website.email_test_failed', { error: test.error || '' }));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', errText(req, e));
  }
  return res.redirect('/app/website/email');
}));

module.exports = router;
