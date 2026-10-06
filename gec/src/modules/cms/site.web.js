// Public CMS pages: resource centre (articles), services, FAQ, editable pages (about, visa guidance, …), the home
// page's editable sections, sitemap.xml and robots.txt. Content is bilingual; unpublished items are never served.
const express = require('express');
const knex = require('../../db/knex');
const config = require('../../config');
const settings = require('../settings/settings.service');
const { ah } = require('../../core/http');
const { E } = require('../../core/errors');
const { markdown, excerpt } = require('../../core/markdown');
const nav = require('../site/nav');
const footer = require('../site/footer');
const { CATEGORIES } = require('./admin');

nav.add({ key: 'services', href: '/services', order: 35 });
nav.add({ key: 'resources', href: '/resources', order: 55 });
footer.add('company', { href: '/about', label: 'site.nav.about' });
footer.add('company', { href: '/services', label: 'site.nav.services' });
footer.add('students', { href: '/visa', label: 'site.nav.visa' });
footer.add('students', { href: '/resources', label: 'site.nav.resources' });
footer.add('students', { href: '/faq', label: 'site.nav.faq' });

const L = (req, row, f) => (req.locale === 'ar' ? row[`${f}_ar`] || row[`${f}_en`] : row[`${f}_en`] || row[`${f}_ar`]) || '';
const abs = (p) => `${config.appUrl}${p}`;
const alt = (path) => [{ lang: 'en', href: `${abs(path)}${path.includes('?') ? '&' : '?'}lang=en` }, { lang: 'ar', href: `${abs(path)}${path.includes('?') ? '&' : '?'}lang=ar` }, { lang: 'x-default', href: abs(path) }];
const seoFor = (req, row, path, extra = {}) => ({
  title: L(req, row, 'seo_title') || L(req, row, 'title'), description: L(req, row, 'seo_description') || L(req, row, 'lead') || L(req, row, 'excerpt') || excerpt(L(req, row, 'body') || L(req, row, 'description')),
  canonical: abs(path), alternates: alt(path), image: row.og_image || row.image || row.hero_image || undefined, ...extra,
});
const published = (q) => q.where('is_published', true);

const router = express.Router();

/** Editable home sections (hero text, services, testimonials, latest articles) — used by the home page. */
async function homeLocals(req, res, next) {
  try {
    if (req.path === '/' && req.method === 'GET') {
      const [home, services, testimonials, articles] = await Promise.all([
        settings.get('site_home'),
        published(knex('services')).orderBy('position').limit(6),
        published(knex('testimonials')).where('consent_on_file', true).orderBy('position').limit(3),
        published(knex('articles')).where('published_at', '<=', new Date()).orderBy('published_at', 'desc').limit(3),
      ]);
      res.locals.homeCms = { hero: home || {}, services, testimonials, articles };
    }
  } catch (e) { /* the home page still renders with its defaults */ }
  next();
}

// ------------------------------------------------------------------ Resource centre
router.get('/resources', ah(async (req, res) => {
  const cat = CATEGORIES.includes(req.query.category) ? req.query.category : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const q = published(knex('articles')).where('published_at', '<=', new Date());
  if (cat) q.where('category', cat);
  const [{ n }] = await q.clone().count({ n: '*' });
  const rows = await q.orderBy('published_at', 'desc').limit(12).offset((page - 1) * 12);
  res.page('pages/site/resources', { layout: 'public', title: req.t('cms.resources_title'), rows, cat, categories: CATEGORIES, meta: { total: Number(n), page, pages: Math.max(1, Math.ceil(Number(n) / 12)) },
    seo: { title: req.t('cms.resources_title'), description: req.t('cms.resources_lead'), canonical: abs(`/resources${cat ? `?category=${cat}` : ''}`), noindex: page > 1 } });
}));

router.get('/resources/:slug', ah(async (req, res) => {
  const a = await published(knex('articles')).where({ slug: req.params.slug }).where('published_at', '<=', new Date()).first();
  if (!a) throw E.notFound('Article');
  const author = a.author_id ? await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('e.id', a.author_id).first('u.name', 'e.job_title') : null;
  const related = await published(knex('articles')).where({ category: a.category }).whereNot({ id: a.id }).where('published_at', '<=', new Date()).orderBy('published_at', 'desc').limit(3);
  const tags = Array.isArray(a.tags) ? a.tags : (() => { try { return JSON.parse(a.tags || '[]'); } catch { return []; } })();
  const branding = res.locals.branding;
  res.page('pages/site/article', { layout: 'public', title: L(req, a, 'title'), a, author, related, tags, md: markdown,
    seo: seoFor(req, a, `/resources/${a.slug}`, { ogType: 'article', jsonld: { '@context': 'https://schema.org', '@type': 'Article', headline: L(req, a, 'title'), description: L(req, a, 'excerpt') || undefined, image: a.image || undefined, datePublished: a.published_at ? new Date(a.published_at).toISOString() : undefined, dateModified: new Date(a.updated_at).toISOString(), author: { '@type': author ? 'Person' : 'Organization', name: (author && author.name) || a.author_name || branding.legal_name }, publisher: { '@type': 'Organization', name: branding.legal_name, logo: { '@type': 'ImageObject', url: abs('/brand/logo-horizontal.png') } }, mainEntityOfPage: abs(`/resources/${a.slug}`), inLanguage: req.locale } }) });
}));

// ------------------------------------------------------------------ Services
router.get('/services', ah(async (req, res) => {
  const rows = await published(knex('services')).orderBy('position');
  res.page('pages/site/services', { layout: 'public', title: req.t('cms.services_title'), rows, seo: { title: req.t('cms.services_title'), description: req.t('cms.services_lead'), canonical: abs('/services'), alternates: alt('/services') } });
}));
router.get('/services/:slug', ah(async (req, res) => {
  const s = await published(knex('services')).where({ slug: req.params.slug }).first();
  if (!s) throw E.notFound('Service');
  const list = (v) => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v || '[]'); } catch { return []; } })());
  const others = await published(knex('services')).whereNot({ id: s.id }).orderBy('position').limit(6);
  res.page('pages/site/service', { layout: 'public', title: L(req, s, 'title'), s: { ...s, deliverables_en: list(s.deliverables_en), deliverables_ar: list(s.deliverables_ar) }, others, md: markdown,
    seo: seoFor(req, s, `/services/${s.slug}`, { jsonld: { '@context': 'https://schema.org', '@type': 'Service', name: L(req, s, 'title'), description: excerpt(L(req, s, 'description')), provider: { '@type': 'EducationalOrganization', name: res.locals.branding.legal_name, url: config.appUrl }, areaServed: 'Worldwide' } }) });
}));

// ------------------------------------------------------------------ FAQ
router.get('/faq', ah(async (req, res) => {
  const rows = await published(knex('faqs')).orderBy('position').orderBy('id');
  const groups = [];
  rows.forEach((f) => { const k = L(req, f, 'category') || req.t('cms.general'); let g = groups.find((x) => x.name === k); if (!g) { g = { name: k, items: [] }; groups.push(g); } g.items.push(f); });
  res.page('pages/site/faq', { layout: 'public', title: req.t('cms.faq_title'), groups, md: markdown,
    seo: { title: req.t('cms.faq_title'), canonical: abs('/faq'), alternates: alt('/faq'), jsonld: rows.length ? { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: rows.map((f) => ({ '@type': 'Question', name: L(req, f, 'question'), acceptedAnswer: { '@type': 'Answer', text: excerpt(L(req, f, 'answer'), 1000) } })) } : undefined } });
}));

// ------------------------------------------------------------------ SEO files
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *', 'Disallow: /staff', 'Disallow: /portal', 'Disallow: /api/', 'Disallow: /hooks/', 'Disallow: /appointments/', 'Disallow: /tickets/', 'Disallow: /invoices/',
    'Disallow: /courses/registration/', 'Disallow: /estimate/', 'Disallow: /compare/s/', 'Disallow: /u/', 'Disallow: /c/', 'Disallow: /t/', 'Disallow: /verify/', 'Disallow: /reset/', 'Disallow: /search',
    `Sitemap: ${abs('/sitemap.xml')}`, '',
  ].join('\n'));
});

router.get('/sitemap.xml', ah(async (req, res) => {
  const now = new Date();
  const urls = [{ loc: '/', pri: '1.0' }, { loc: '/programs', pri: '0.9' }, { loc: '/universities' }, { loc: '/scholarships' }, { loc: '/study' }, { loc: '/calculator' }, { loc: '/book' }, { loc: '/contact' },
    { loc: '/services' }, { loc: '/resources' }, { loc: '/faq' }, { loc: '/events' }, { loc: '/courses' }, { loc: '/advisor' }, { loc: '/privacy', pri: '0.2' }];
  const add = (rows, f, prefix) => rows.forEach((r) => urls.push({ loc: `${prefix}${r.slug}`, mod: r.updated_at, pri: f }));
  const [dests, unis, progs, schols, events, courses, articles, services, pages] = await Promise.all([
    knex('destinations').where({ is_active: true }).select('slug', 'updated_at'), knex('universities').where({ is_active: true }).select('slug', 'updated_at'),
    knex('programs').where({ is_active: true }).select('slug', 'updated_at'), knex('scholarships').where({ is_active: true }).select('slug', 'updated_at'),
    knex('events').where({ is_active: true }).select('slug', 'updated_at'), knex('courses').where({ is_active: true }).select('slug', 'updated_at'),
    published(knex('articles')).where('published_at', '<=', now).select('slug', 'updated_at'), published(knex('services')).select('slug', 'updated_at'), published(knex('pages')).select('slug', 'updated_at'),
  ]);
  add(dests, '0.8', '/study/'); add(unis, '0.7', '/universities/'); add(progs, '0.6', '/programs/'); add(schols, '0.6', '/scholarships/');
  add(events, '0.5', '/events/'); add(courses, '0.5', '/courses/'); add(articles, '0.6', '/resources/'); add(services, '0.6', '/services/'); add(pages, '0.5', '/');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls.map((u) => `<url><loc>${esc(abs(u.loc))}</loc>${u.mod ? `<lastmod>${new Date(u.mod).toISOString().slice(0, 10)}</lastmod>` : ''}<xhtml:link rel="alternate" hreflang="ar" href="${esc(abs(u.loc))}?lang=ar"/><xhtml:link rel="alternate" hreflang="en" href="${esc(abs(u.loc))}?lang=en"/>${u.pri ? `<priority>${u.pri}</priority>` : ''}</url>`), '</urlset>'];
  res.set({ 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }).send(xml.join('\n'));
}));

// ------------------------------------------------------------------ Editable pages (/about, /visa, …) — last, so real routes win
router.get('/:slug', ah(async (req, res, next) => {
  if (!/^[a-z0-9-]{2,140}$/.test(req.params.slug)) return next();
  const p = await published(knex('pages')).where({ slug: req.params.slug }).first();
  if (!p) return next();
  const faqs = await published(knex('faqs')).where({ topic: p.slug }).orderBy('position');
  return res.page('pages/site/page', { layout: 'public', title: L(req, p, 'title'), p, faqs, md: markdown, seo: seoFor(req, p, `/${p.slug}`) });
}));

module.exports = { router, homeLocals };
