// Public SEO files and site-wide meta: /robots.txt, /llms.txt (+ /llms-full.txt alias), and res.locals.seoSite
// (default description, sharing image, search-engine verification tags) for the public layout.
const express = require('express');
const settings = require('../settings/settings.service');
const { ah } = require('../../core/http');
const svc = require('./service');

const router = express.Router();
const config = require('../../config');
const SECTIONS = { programs: 'site.nav.programs', universities: 'site.nav.universities', scholarships: 'site.nav.scholarships', study: 'site.nav.destinations', resources: 'site.nav.resources', services: 'site.nav.services', events: 'site.nav.events', courses: 'site.nav.courses' };

/** BreadcrumbList for detail pages: Home › Section › Page (search engines show it instead of the raw URL). */
function crumbs(req, canonical, title) {
  const path = String(canonical || '').replace(config.appUrl, '').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts.length > 2) return null;
  const items = [{ name: req.t('site.nav.home'), url: `${config.appUrl}/` }];
  if (parts.length === 2) { if (!SECTIONS[parts[0]]) return null; items.push({ name: req.t(SECTIONS[parts[0]]), url: `${config.appUrl}/${parts[0]}` }); }
  items.push({ name: title, url: `${config.appUrl}${path}` });
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((x, i) => ({ '@type': 'ListItem', position: i + 1, name: x.name, item: x.url })) };
}

router.use(ah(async (req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/media/')) {
    res.locals.seoSite = await settings.get('seo');
    res.locals.crumbsLd = (canonical, title) => crumbs(req, canonical, title);
  }
  next();
}));
router.get('/robots.txt', ah(async (req, res) => { res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(await svc.robots()); }));
router.get(['/llms.txt', '/llms-full.txt'], ah(async (req, res, next) => {
  const body = await svc.llms(req.query.lang === 'ar' ? 'ar' : 'en');
  if (!body) return next();
  return res.type('text/markdown; charset=utf-8').set('Cache-Control', 'public, max-age=3600').send(body);
}));

module.exports = router;
