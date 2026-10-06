// SEO, GEO (generative-engine optimisation) and AEO (answer-engine optimisation): robots.txt with AI-crawler policy,
// /llms.txt (a plain summary of the site for AI assistants), site-wide meta defaults, and a content audit.
const knex = require('../../db/knex');
const config = require('../../config');
const settings = require('../settings/settings.service');

// Crawlers that fetch pages to answer a user's question right now (they cite and link back) …
const ANSWER_BOTS = ['OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Perplexity-User', 'Claude-SearchBot', 'Claude-User', 'DuckAssistBot', 'MistralAI-User'];
// … and crawlers that collect text to train models.
const TRAINING_BOTS = ['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Meta-ExternalAgent', 'Bytespider', 'Amazonbot', 'cohere-training-data-crawler'];
const PRIVATE = ['/staff', '/portal', '/partner', '/api/', '/hooks/', '/appointments/', '/tickets/', '/invoices/', '/courses/registration/', '/estimate/', '/compare/s/', '/u/', '/c/', '/t/', '/verify/', '/reset/', '/search'];

const abs = (p) => `${config.appUrl}${p}`;

async function robots() {
  const s = await settings.get('seo');
  const lines = ['User-agent: *', ...PRIVATE.map((p) => `Disallow: ${p}`), ''];
  const block = [...(s.ai_answers ? [] : ANSWER_BOTS), ...(s.ai_training ? [] : TRAINING_BOTS)];
  if (block.length) lines.push('# AI crawlers not allowed by Settings → SEO & AI search', ...block.map((b) => `User-agent: ${b}`), 'Disallow: /', '');
  if (s.ai_answers) lines.push('# AI answer engines may read public pages', ...ANSWER_BOTS.map((b) => `User-agent: ${b}`), ...PRIVATE.map((p) => `Disallow: ${p}`), 'Allow: /', '');
  const extra = String(s.robots_extra || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(#|user-agent:|disallow:|allow:|crawl-delay:)/i.test(l));
  if (extra.length) lines.push(...extra, '');
  lines.push(`Sitemap: ${abs('/sitemap.xml')}`, '');
  return lines.join('\n');
}

const clean = (s, n = 220) => String(s || '').replace(/[#*_>`[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

/** llms.txt (https://llmstxt.org): what GEC is and where the key facts live, in Markdown. */
async function llms(locale = 'en') {
  const s = await settings.get('seo');
  if (!s.llms_enabled) return null;
  const b = await settings.get('branding'); const c = await settings.get('company');
  const ar = locale === 'ar';
  const L = (r, f) => (ar ? r[`${f}_ar`] || r[`${f}_en`] : r[`${f}_en`] || r[`${f}_ar`]) || '';
  const q = (lang) => (ar ? `?lang=ar` : lang || '');
  const [dests, unis, progs, schols, services, articles, faqs] = await Promise.all([
    knex('destinations').where({ is_active: true }).orderBy('position').select('slug', 'name_en', 'name_ar', 'tagline_en', 'tagline_ar'),
    knex('universities as u').where('u.is_active', true).orderBy('u.ranking_world').orderBy('u.name_en').limit(80).select('u.slug', 'u.name_en', 'u.name_ar', 'u.city_en', 'u.city_ar', 'u.country_code'),
    knex('programs as p').join('universities as u', 'u.id', 'p.university_id').where({ 'p.is_active': true, 'u.is_active': true }).orderBy('p.updated_at', 'desc').limit(60)
      .select('p.slug', 'p.name_en', 'p.name_ar', 'p.degree_level', 'p.tuition_fee', 'p.currency', 'u.name_en as uni_en', 'u.name_ar as uni_ar'),
    knex('scholarships').where({ is_active: true }).orderByRaw('deadline IS NULL, deadline').limit(30).select('slug', 'name_en', 'name_ar', 'deadline'),
    knex('services').where({ is_published: true }).orderBy('position').select('slug', 'title_en', 'title_ar', 'description_en as lead_en', 'description_ar as lead_ar').catch(() => []),
    knex('articles').where({ is_published: true }).where('published_at', '<=', new Date()).orderBy('published_at', 'desc').limit(20).select('slug', 'title_en', 'title_ar', 'excerpt_en', 'excerpt_ar').catch(() => []),
    knex('faqs').where({ is_published: true }).orderBy('position').limit(40).select('question_en', 'question_ar', 'answer_en', 'answer_ar').catch(() => []),
  ]);
  const intro = (ar ? s.llms_intro_ar : s.llms_intro_en) || (ar ? s.description_ar : s.description_en) || (ar ? b.tagline_ar : b.tagline_en);
  const out = [`# ${b.legal_name} (${b.name})`, '', `> ${clean(intro, 500)}`, ''];
  out.push(ar ? 'تساعد GEC الطلاب على اختيار الجامعة والبرنامج والتقديم والحصول على التأشيرة. الاستشارة الأولى مجانية.' : `${b.name} helps students choose a university and program, apply, and get their study visa. The first consultation is free.`, '');
  const contact = [c.email && `${ar ? 'البريد' : 'Email'}: ${c.email}`, c.phone && `${ar ? 'الهاتف' : 'Phone'}: ${c.phone}`, c.whatsapp && `WhatsApp: https://wa.me/${String(c.whatsapp).replace(/\D/g, '')}`, L(c, 'address') && `${ar ? 'العنوان' : 'Address'}: ${L(c, 'address')}`].filter(Boolean);
  if (contact.length) out.push(contact.map((x) => `- ${x}`).join('\n'), '');
  const sec = (title, rows) => { if (rows.length) out.push(`## ${title}`, '', ...rows, ''); };
  sec(ar ? 'صفحات رئيسية' : 'Key pages', [
    `- [${ar ? 'ابحث عن برنامج' : 'Program finder'}](${abs('/programs' + q())}): ${ar ? 'كل البرامج مع الرسوم وشروط القبول والمواعيد' : 'every program with fees, entry requirements and deadlines'}`,
    `- [${ar ? 'المنح' : 'Scholarships'}](${abs('/scholarships' + q())})`, `- [${ar ? 'حاسبة التكاليف' : 'Cost calculator'}](${abs('/calculator' + q())})`,
    `- [${ar ? 'احجز استشارة مجانية' : 'Book a free consultation'}](${abs('/book' + q())})`, `- [${ar ? 'الأسئلة الشائعة' : 'FAQ'}](${abs('/faq' + q())})`, `- [${ar ? 'للجامعات' : 'For universities'}](${abs('/for-universities' + q())})`,
  ]);
  sec(ar ? 'وجهات الدراسة' : 'Study destinations', dests.map((d) => `- [${L(d, 'name')}](${abs(`/study/${d.slug}${q()}`)})${L(d, 'tagline') ? `: ${clean(L(d, 'tagline'))}` : ''}`));
  sec(ar ? 'الخدمات' : 'Services', services.map((x) => `- [${L(x, 'title')}](${abs(`/services/${x.slug}${q()}`)})${L(x, 'lead') ? `: ${clean(L(x, 'lead'))}` : ''}`));
  sec(ar ? 'الجامعات' : 'Universities', unis.map((u) => `- [${L(u, 'name')}](${abs(`/universities/${u.slug}${q()}`)})${L(u, 'city') ? ` — ${L(u, 'city')}` : ''}`));
  sec(ar ? 'برامج مختارة' : 'Selected programs', progs.map((p) => `- [${L(p, 'name')} — ${ar ? p.uni_ar || p.uni_en : p.uni_en}](${abs(`/programs/${p.slug}${q()}`)})${p.tuition_fee ? ` · ${Number(p.tuition_fee).toLocaleString('en')} ${p.currency}/${ar ? 'سنة' : 'year'}` : ''}`));
  sec(ar ? 'المنح' : 'Scholarships', schols.map((x) => `- [${L(x, 'name')}](${abs(`/scholarships/${x.slug}${q()}`)})${x.deadline ? ` · ${ar ? 'آخر موعد' : 'deadline'} ${new Date(x.deadline).toISOString().slice(0, 10)}` : ''}`));
  sec(ar ? 'أدلة ومقالات' : 'Guides', articles.map((a) => `- [${L(a, 'title')}](${abs(`/resources/${a.slug}${q()}`)})${L(a, 'excerpt') ? `: ${clean(L(a, 'excerpt'))}` : ''}`));
  sec(ar ? 'أسئلة شائعة' : 'Frequently asked questions', faqs.map((f) => `- **${clean(L(f, 'question'), 200)}** ${clean(L(f, 'answer'), 400)}`));
  out.push(`## ${ar ? 'اختياري' : 'Optional'}`, '', `- [Sitemap](${abs('/sitemap.xml')})`, `- [${ar ? 'English version' : 'النسخة العربية'}](${abs(ar ? '/llms.txt' : '/llms.txt?lang=ar')})`, '');
  return out.join('\n');
}

// ------------------------------------------------------------------ audit
const CHECKS = [
  { table: 'programs', path: '/staff/programs', title: 'name', desc: 'description' }, { table: 'universities', path: '/staff/universities', title: 'name', desc: 'description' },
  { table: 'scholarships', path: '/staff/scholarships', title: 'name', desc: 'description' }, { table: 'destinations', path: '/staff/destinations', title: 'name', desc: 'intro' },
  { table: 'articles', path: '/staff/articles', title: 'title', desc: 'excerpt', cms: true }, { table: 'services', path: '/staff/services', title: 'title', desc: 'description', cms: true },
  { table: 'pages', path: '/staff/pages', title: 'title', desc: 'lead', cms: true },
];

/** Content issues that hurt search and AI visibility, grouped: [{ key, level, count, items: [{ title, href }] }]. */
async function audit() {
  const s = await settings.get('seo');
  const issues = [];
  const push = (key, level, items, extra = {}) => { if (items.length) issues.push({ key, level, count: items.length, items: items.slice(0, 8), ...extra }); };
  for (const c of CHECKS) {
    const rows = await knex(c.table).where(c.cms ? 'is_published' : 'is_active', true) // eslint-disable-line no-await-in-loop
      .select('id', `${c.title}_en as t_en`, `${c.title}_ar as t_ar`, 'seo_title_en', 'seo_description_en', `${c.desc}_en as d_en`);
    const item = (r) => ({ title: r.t_en || r.t_ar || `#${r.id}`, href: `${c.path}/${r.id}` });
    push('no_ar', 'warn', rows.filter((r) => !r.t_ar).map(item), { table: c.table });
    push('no_desc', 'warn', rows.filter((r) => !r.d_en && !r.seo_description_en).map(item), { table: c.table });
    if (c.table !== 'programs') push('long_title', 'info', rows.filter((r) => (r.seo_title_en || r.t_en || '').length > 65).map(item), { table: c.table });
    const seen = new Map(); rows.forEach((r) => { const k = String(r.seo_title_en || r.t_en || '').toLowerCase(); if (k) seen.set(k, [...(seen.get(k) || []), r]); });
    if (c.table !== 'programs') push('dup_title', 'warn', [...seen.values()].filter((g) => g.length > 1).flat().map(item), { table: c.table });
  }
  const noPhoto = await knex('universities').where({ is_active: true }).where((w) => w.whereNull('cover_image').orWhere('cover_image', '')).select('id', 'name_en');
  push('uni_no_photo', 'info', noPhoto.map((u) => ({ title: u.name_en, href: `/staff/universities/${u.id}` })), { table: 'universities' });
  const noAlt = await knex('media').where({ purpose: 'cms' }).where((w) => w.whereNull('alt_en').orWhere('alt_en', '')).select('id', 'original_name').catch(() => []);
  push('media_no_alt', 'warn', noAlt.map((m) => ({ title: m.original_name || `#${m.id}`, href: `/staff/media/${m.id}` })), { table: 'media' });
  const faqCount = Number((await knex('faqs').where({ is_published: true }).count({ n: '*' }))[0].n);
  const site = [];
  if (!s.description_en || !s.description_ar) site.push({ key: 'site_description', level: 'bad' });
  if (!s.og_image) site.push({ key: 'site_og_image', level: 'warn' });
  if (!s.google_verification) site.push({ key: 'site_google', level: 'warn' });
  if (!s.bing_verification) site.push({ key: 'site_bing', level: 'info' });
  if (!s.ai_answers) site.push({ key: 'site_ai_blocked', level: 'bad' });
  if (!s.llms_enabled) site.push({ key: 'site_llms_off', level: 'warn' });
  if (faqCount < 8) site.push({ key: 'site_few_faqs', level: 'warn', vars: { n: faqCount } });
  if (!/^https:\/\//.test(config.appUrl)) site.push({ key: 'site_no_https', level: 'bad' });
  const weight = { bad: 12, warn: 4, info: 1 };
  const penalty = site.reduce((a, i) => a + weight[i.level], 0) + issues.reduce((a, i) => a + Math.min(12, weight[i.level] * Math.ceil(i.count / 5)), 0);
  return { score: Math.max(0, 100 - penalty), site, issues, faqCount };
}

module.exports = { robots, llms, audit, ANSWER_BOTS, TRAINING_BOTS };
