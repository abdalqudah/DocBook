// Website CMS (Website group in the staff menu): pages, articles, FAQs, testimonials, services and navigation.
// Everything is bilingual with its own SEO fields; changes are audited by the resource module.
const knex = require('../../db/knex');
const { resource } = require('../../core/resource');
const nav = require('./nav');

const L = (req, row, f) => (req.locale === 'ar' && row[`${f}_ar`]) || row[`${f}_en`];
const seo = [{ name: 'seo_title', type: 'text', bilingual: true, max: 160 }, { name: 'seo_description', type: 'textarea', bilingual: true, max: 300, rows: 2 }, { name: 'og_image', type: 'image' }];
const perms = { view: 'cms.manage', manage: 'cms.manage' };
const employees = async () => (await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('u.status', 'active').orderBy('u.name').select('e.id', 'u.name')).map((e) => ({ value: String(e.id), label: e.name }));
const CATEGORIES = ['study_abroad', 'visa', 'scholarships', 'universities', 'ielts', 'student_life', 'application_tips'];
const RESERVED = /^(staff|portal|api|hooks|t|c|u|media|css|js|fonts|brand|icons|programs|universities|scholarships|study|events|courses|book|appointments|tickets|invoices|certificates|login|logout|register|verify|reset|forgot|advisor|resources|services|faq|privacy|contact|search|compare|shortlist|calculator|estimate|sitemap\.xml|robots\.txt)$/;

const pages = resource({
  key: 'pages', table: 'pages', entity: 'page', nameField: 'title_en', slugFrom: 'title_en', perms, publicUrl: (r) => `/${r.slug}`, defaults: { is_published: true, show_cta: true },
  list: { search: ['title_en', 'title_ar', 'slug'], defaultSort: ['title_en', 'asc'], columns: [{ key: 'title', label: 'common.name', render: (r, req) => L(req, r, 'title') }, { key: 'slug', label: 'resources.fields.slug', render: (r) => `/${r.slug}` }, { key: 'is_published', label: 'resources.fields.is_published', type: 'bool' }, { key: 'updated_at', label: 'common.updated', type: 'date' }] },
  sections: [
    { key: 'basics', fields: [{ name: 'title', type: 'text', bilingual: true, required: true, max: 190 }, { name: 'slug', type: 'slug', hint: 'cms.page_slug_hint' }, { name: 'lead', type: 'textarea', bilingual: true, rows: 2, max: 400 }, { name: 'hero_image', type: 'image' }] },
    { key: 'content', fields: [{ name: 'body', type: 'markdown', bilingual: true, rows: 14 }, { name: 'show_cta', type: 'bool' }] },
    { key: 'visibility', fields: [{ name: 'is_published', type: 'bool' }] },
    { key: 'seo', fields: seo },
  ],
  validateRow: (row) => (row.slug && RESERVED.test(row.slug) ? { slug: 'This address is used by the site. Choose another.' } : null),
});

const articles = resource({
  key: 'articles', table: 'articles', entity: 'article', nameField: 'title_en', slugFrom: 'title_en', perms, publicUrl: (r) => `/resources/${r.slug}`, defaults: { category: 'study_abroad', is_published: false },
  list: { search: ['title_en', 'title_ar'], defaultSort: ['published_at', 'desc'], columns: [{ key: 'title', label: 'common.name', render: (r, req) => L(req, r, 'title') }, { key: 'category', label: 'resources.fields.category', render: (r, req) => req.t(`cms.category.${r.category}`) }, { key: 'published_at', label: 'resources.fields.published_at', type: 'date' }, { key: 'is_published', label: 'resources.fields.is_published', type: 'bool' }] },
  sections: [
    { key: 'basics', fields: [{ name: 'title', type: 'text', bilingual: true, required: true, max: 190 }, { name: 'slug', type: 'slug', hint: 'catalog.slug_hint' }, { name: 'category', type: 'select', required: true, options: CATEGORIES, optionLabel: 'cms.category' }, { name: 'excerpt', type: 'textarea', bilingual: true, rows: 2, max: 400 }, { name: 'image', type: 'image' }] },
    { key: 'content', fields: [{ name: 'body', type: 'markdown', bilingual: true, rows: 18 }, { name: 'tags', type: 'list', hint: 'catalog.one_per_line' }] },
    { key: 'author', fields: [{ name: 'author_id', type: 'select', options: employees }, { name: 'author_name', type: 'text', hint: 'cms.author_hint' }, { name: 'read_minutes', type: 'int', max: 120 }] },
    { key: 'visibility', fields: [{ name: 'is_published', type: 'bool' }, { name: 'published_at', type: 'datetime', hint: 'cms.published_hint' }] },
    { key: 'seo', fields: seo },
  ],
  beforeSave: (row) => { if (row.is_published && !row.published_at) row.published_at = new Date(); return row; },
});

const faqs = resource({
  key: 'faqs', table: 'faqs', entity: 'faq', nameField: 'question_en', perms, defaults: { is_published: true, position: 0 },
  list: { search: ['question_en', 'question_ar', 'category_en'], defaultSort: ['position', 'asc'], columns: [{ key: 'question', label: 'resources.fields.question', render: (r, req) => L(req, r, 'question') }, { key: 'category', label: 'resources.fields.category', render: (r, req) => L(req, r, 'category') || '—' }, { key: 'is_published', label: 'resources.fields.is_published', type: 'bool' }] },
  sections: [
    { key: 'basics', fields: [{ name: 'question', type: 'text', bilingual: true, required: true, max: 400 }, { name: 'answer', type: 'markdown', bilingual: true, rows: 5 }, { name: 'category', type: 'text', bilingual: true, max: 120 }, { name: 'topic', type: 'text', max: 30, hint: 'cms.topic_hint' }, { name: 'position', type: 'int' }, { name: 'is_published', type: 'bool' }] },
  ],
});

const testimonials = resource({
  key: 'testimonials', table: 'testimonials', entity: 'testimonial', nameField: 'name_en', perms, defaults: { is_published: false, consent_on_file: false },
  list: { search: ['name_en', 'name_ar', 'university_en'], defaultSort: ['position', 'asc'], columns: [{ key: 'name', label: 'common.name', render: (r, req) => L(req, r, 'name') }, { key: 'university', label: 'resources.fields.university_id', render: (r, req) => L(req, r, 'university') || '—' }, { key: 'consent_on_file', label: 'resources.fields.consent_on_file', type: 'bool' }, { key: 'is_published', label: 'resources.fields.is_published', type: 'bool' }] },
  sections: [
    { key: 'basics', fields: [{ name: 'name', type: 'text', bilingual: true, required: true, max: 120 }, { name: 'quote', type: 'textarea', bilingual: true, rows: 4, required: true }, { name: 'country', type: 'text', bilingual: true, max: 80 }, { name: 'university', type: 'text', bilingual: true, max: 160 }, { name: 'program', type: 'text', bilingual: true, max: 160 }, { name: 'year', type: 'int', min: 1990, max: 2100 }, { name: 'destination', type: 'text', max: 60 }, { name: 'avatar', type: 'image' }, { name: 'position', type: 'int' }] },
    { key: 'visibility', fields: [{ name: 'consent_on_file', type: 'bool', hint: 'cms.consent_hint' }, { name: 'is_published', type: 'bool' }] },
  ],
  validateRow: (row) => (row.is_published && !row.consent_on_file ? { consent_on_file: 'Only testimonials with the person’s consent can be published.' } : null),
});

const services = resource({
  key: 'services', table: 'services', entity: 'service', nameField: 'title_en', slugFrom: 'title_en', perms, publicUrl: (r) => `/services/${r.slug}`, defaults: { is_published: true },
  list: { search: ['title_en', 'title_ar'], defaultSort: ['position', 'asc'], columns: [{ key: 'title', label: 'common.name', render: (r, req) => L(req, r, 'title') }, { key: 'position', label: 'resources.fields.position' }, { key: 'is_published', label: 'resources.fields.is_published', type: 'bool' }] },
  sections: [
    { key: 'basics', fields: [{ name: 'title', type: 'text', bilingual: true, required: true, max: 160 }, { name: 'slug', type: 'slug', hint: 'catalog.slug_hint' }, { name: 'description', type: 'markdown', bilingual: true, rows: 5 }, { name: 'icon', type: 'text', max: 40, hint: 'cms.icon_hint' }, { name: 'position', type: 'int' }] },
    { key: 'content', fields: [{ name: 'timeline', type: 'text', bilingual: true, max: 120 }, { name: 'deliverables', type: 'list', bilingual: true, hint: 'catalog.one_per_line' }, { name: 'highlight', type: 'text', bilingual: true }] },
    { key: 'visibility', fields: [{ name: 'is_published', type: 'bool' }] },
    { key: 'seo', fields: seo },
  ],
});

const navItems = resource({
  key: 'navigation', table: 'nav_items', entity: 'nav_item', nameField: 'label_en', perms, defaults: { location: 'header', is_active: true, position: 0 },
  list: { search: ['label_en', 'label_ar', 'href'], defaultSort: ['position', 'asc'], columns: [{ key: 'label', label: 'common.name', render: (r, req) => L(req, r, 'label') }, { key: 'location', label: 'resources.fields.location', render: (r, req) => req.t(`cms.location.${r.location}`) }, { key: 'href', label: 'resources.fields.href' }, { key: 'position', label: 'resources.fields.position' }, { key: 'is_active', label: 'common.status', type: 'bool' }] },
  sections: [
    { key: 'basics', fields: [{ name: 'label', type: 'text', bilingual: true, required: true, max: 80 }, { name: 'href', type: 'text', required: true, max: 300, hint: 'cms.href_hint' }, { name: 'location', type: 'select', required: true, options: ['header', 'footer'], optionLabel: 'cms.location' }, { name: 'group', type: 'select', options: ['study', 'students', 'company'], optionLabel: 'site.footer', hint: 'cms.group_hint' }, { name: 'position', type: 'int' }, { name: 'is_active', type: 'bool' }] },
  ],
  validateRow: (row) => (row.href && !/^(\/(?!\/)|https?:\/\/)/.test(row.href) ? { href: 'Use a site path like /programs or a full https:// address.' } : null),
  afterSave: async () => nav.clear(),
});

const COVERS = ['hero', 'campus', 'scholarship', 'uk', 'usa', 'canada', 'australia', 'germany', 'ireland'];
const linkOk = (v) => !v || /^(\/(?!\/)|https?:\/\/)/.test(v);
const slides = resource({
  key: 'slides', table: 'hero_slides', entity: 'hero_slide', nameField: 'title_en', perms, defaults: { cover: 'hero', is_active: true, position: 0 },
  list: { search: ['title_en', 'title_ar'], defaultSort: ['position', 'asc'], columns: [{ key: 'title', label: 'common.name', render: (r, req) => L(req, r, 'title') }, { key: 'position', label: 'resources.fields.position' }, { key: 'is_active', label: 'common.status', type: 'bool' }] },
  sections: [
    { key: 'basics', fields: [{ name: 'eyebrow', type: 'text', bilingual: true, max: 120 }, { name: 'title', type: 'text', bilingual: true, required: true, max: 190 }, { name: 'text', type: 'textarea', bilingual: true, rows: 2, max: 400 }] },
    { key: 'image', fields: [{ name: 'image', type: 'image', hint: 'cms.slide_image_hint' }, { name: 'cover', type: 'select', required: true, options: COVERS, optionLabel: 'cms.cover' }] },
    { key: 'buttons', fields: [{ name: 'cta_label', type: 'text', bilingual: true, max: 60 }, { name: 'cta_href', type: 'text', max: 300, hint: 'cms.href_hint' }, { name: 'cta2_label', type: 'text', bilingual: true, max: 60 }, { name: 'cta2_href', type: 'text', max: 300 }] },
    { key: 'visibility', fields: [{ name: 'position', type: 'int' }, { name: 'is_active', type: 'bool' }] },
  ],
  validateRow: (row) => (!linkOk(row.cta_href) || !linkOk(row.cta2_href) ? { cta_href: 'Use a site path like /programs or a full https:// address.' } : null),
});

module.exports = { slides, COVERS, pages, articles, faqs, testimonials, services, navItems, CATEGORIES, RESERVED };
