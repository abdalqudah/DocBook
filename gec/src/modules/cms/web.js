// Staff: the Website group — pages, articles, FAQs, testimonials, services, navigation and the home page texts.
const express = require('express');
const { can } = require('../../middleware/auth');
const { allowMultipart, flash } = require('../../middleware/web');
const { ah, idParam } = require('../../core/http');
const uploads = require('../../core/uploads');
const media = require('./media.service');
const { validate, z, str } = require('../../core/validate');
const settings = require('../settings/settings.service');
const nav = require('../staff/nav');
const admin = require('./admin');

nav.add('website', { key: 'pages', href: '/staff/pages', icon: 'file-text', perms: ['cms.manage'] });
nav.add('website', { key: 'articles', href: '/staff/articles', icon: 'newspaper', perms: ['cms.manage'] });
nav.add('website', { key: 'services_cms', href: '/staff/services', icon: 'briefcase', perms: ['cms.manage'] });
nav.add('website', { key: 'faqs', href: '/staff/faqs', icon: 'circle-help', perms: ['cms.manage'] });
nav.add('website', { key: 'testimonials', href: '/staff/testimonials', icon: 'quote', perms: ['cms.manage'] });
nav.add('website', { key: 'navigation', href: '/staff/navigation', icon: 'menu', perms: ['cms.manage'] });
nav.add('website', { key: 'media', href: '/staff/media', icon: 'image', perms: ['cms.manage'] });
nav.add('website', { key: 'home_page', href: '/staff/website/home', icon: 'house', perms: ['cms.manage'] });

const router = express.Router();

router.get('/website/home', can('cms.manage'), ah(async (req, res) => {
  res.page('pages/staff/cms/home', { layout: 'staff', narrow: true, title: req.t('nav.home_page'), h: (await settings.get('site_home')) || {} });
}));
router.post('/website/home', can('cms.manage'), ah(async (req, res) => {
  const d = validate(z.object({ hero_title_en: str(160), hero_title_ar: str(160), hero_lead_en: str(400), hero_lead_ar: str(400), cta_title_en: str(160), cta_title_ar: str(160), cta_text_en: str(400), cta_text_ar: str(400) }), req.body);
  await settings.set(req.ctx, 'site_home', Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v || ''])));
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/staff/website/home');
}));

// ------------------------------------------------------------------ Media library
router.get('/media', can('cms.manage'), ah(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const [lib, external] = await Promise.all([media.list({ q: req.query.q, page }), media.externalImages()]);
  res.page('pages/staff/cms/media', { layout: 'staff', title: req.t('nav.media'), lib, external, meta: { total: lib.total, page: lib.page, pages: lib.pages } });
}));
router.get('/media/picker.json', can('cms.manage'), ah(async (req, res) => {
  const lib = await media.list({ q: req.query.q, per: 60 });
  res.json({ data: lib.rows.map((m) => ({ id: m.id, url: m.url, name: m.original_name, alt: (req.locale === 'ar' && m.alt_ar) || m.alt_en || '' })) });
}));
allowMultipart(/^\/staff\/media\/?$/);
router.post('/media', can('cms.manage'), uploads.single('file', { maxMb: 8 }), ah(async (req, res) => {
  const id = await media.upload(req.ctx, req.file, validate(z.object({ alt_en: str(255), alt_ar: str(255) }), req.body));
  flash(req, 'ok', req.t('media.uploaded'));
  res.redirect(`/staff/media/${id}`);
}));
router.post('/media/import', can('cms.manage'), ah(async (req, res) => {
  const r = await media.importExternal(req.ctx);
  flash(req, r.failed.length ? 'error' : 'ok', req.t('media.import_result', { imported: r.imported, rows: r.rows, failed: r.failed.length }) + (r.failed.length ? ` ${r.failed.slice(0, 3).map((f) => `${f.url.slice(0, 60)}… (${f.error})`).join('; ')}` : ''));
  res.redirect('/staff/media');
}));
router.get('/media/:id', can('cms.manage'), ah(async (req, res) => {
  const m = await media.get(idParam(req.params.id));
  res.page('pages/staff/cms/media-item', { layout: 'staff', narrow: true, title: m.original_name || `#${m.id}`, m, used: await media.usage(m.id) });
}));
router.post('/media/:id', can('cms.manage'), ah(async (req, res) => {
  await media.updateAlt(req.ctx, idParam(req.params.id), validate(z.object({ alt_en: str(255), alt_ar: str(255) }), req.body));
  flash(req, 'ok', req.t('common.saved'));
  res.redirect(`/staff/media/${req.params.id}`);
}));
router.post('/media/:id/delete', can('cms.manage'), ah(async (req, res) => {
  await media.remove(req.ctx, idParam(req.params.id));
  flash(req, 'ok', req.t('common.deleted'));
  res.redirect('/staff/media');
}));

router.use('/pages', admin.pages.router);
router.use('/articles', admin.articles.router);
router.use('/faqs', admin.faqs.router);
router.use('/testimonials', admin.testimonials.router);
router.use('/services', admin.services.router);
router.use('/navigation', admin.navItems.router);

module.exports = router;
