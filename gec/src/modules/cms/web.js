// Staff: the Website group — pages, articles, FAQs, testimonials, services, navigation and the home page texts.
const express = require('express');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah } = require('../../core/http');
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

router.use('/pages', admin.pages.router);
router.use('/articles', admin.articles.router);
router.use('/faqs', admin.faqs.router);
router.use('/testimonials', admin.testimonials.router);
router.use('/services', admin.services.router);
router.use('/navigation', admin.navItems.router);

module.exports = router;
