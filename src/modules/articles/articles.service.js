// Doctors' articles (health advice, procedures explained, clinic news), in Arabic and / or English, with a cover and
// images from the clinic's media library. Where each appears is the author's choice:
//   • on_site      → the clinic's website: /<slug>/articles and /<slug>/articles/<slug>
//   • on_platform  → the platform's main site: /blog and /blog/<id>-<slug>, once the platform admin approves it
// A doctor login writes and publishes its own articles; website editors (website.edit) write for any doctor of the
// clinic or for the clinic itself. Every change is audited; ids are always checked against the signed-in clinic.
//
// Body format (plain text, safe): blank line = new paragraph · "## " heading · "### " small heading · "- " list ·
// "1. " numbered list · "> " quote · **bold** · *italic* · [text](https://…) · [[img:ID]] or [[img:ID|caption]] an image.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { z, validate, optionalString } = require('../../core/validate');

const STATUSES = ['draft', 'published'];
const CATEGORIES = ['advice', 'procedures', 'prevention', 'children', 'women', 'nutrition', 'clinic_news', 'other'];
const MAX_BODY = 60_000;
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const latin = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);

// ---------------------------------------------------------------- who may write what
/** Can this member write articles at all, and for whom: { any: website editors, doctorId: a doctor login's own }. */
function rights(ctx) {
  const any = ctx.permissions.has('website.edit');
  return { any, doctorId: ctx.doctorId || null, can: any || Boolean(ctx.doctorId) };
}
const guard = (ctx) => { const r = rights(ctx); if (!r.can) throw E.forbidden('articles'); return r; };
const scoped = (ctx) => {
  const r = guard(ctx);
  const q = knex('articles').where({ business_id: ctx.businessId });
  if (!r.any) q.where({ doctor_id: r.doctorId });
  return q;
};

// ---------------------------------------------------------------- body: markup → safe HTML
const IMG_RE = /^\[\[img:(\d{1,10})(?:\|([^\]]{0,200}))?\]\]$/;
/** Image ids used in a body. */
const imageIds = (body) => [...String(body || '').matchAll(/\[\[img:(\d{1,10})(?:\|[^\]]*)?\]\]/g)].map((m) => Number(m[1]));

function inline(s) {
  let h = esc(s);
  h = h.replace(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)/g, (m, text, url) => `<a href="${url}" rel="nofollow ugc noopener" target="_blank">${text}</a>`);
  h = h.replace(/\*\*([^*]{1,400})\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]{1,400})\*/g, '$1<em>$2</em>');
  return h;
}

/**
 * Safe HTML of a body. `images` maps media id → { url, alt }; an image of another clinic or a missing one is
 * left out. Everything typed is escaped first; only the markup above becomes HTML.
 */
function render(body, images = {}) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  const out = []; let para = []; let list = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const raw of lines) { // eslint-disable-line no-restricted-syntax
    const line = raw.trim();
    const img = line.match(IMG_RE);
    let m;
    if (!line) { flushPara(); flushList(); continue; } // eslint-disable-line no-continue
    if (img) {
      flushPara(); flushList();
      const im = images[Number(img[1])];
      if (im) out.push(`<figure class="art-fig"><img src="${esc(im.url)}" alt="${esc(img[2] || im.alt || '')}" loading="lazy"${im.width && im.height ? ` width="${im.width}" height="${im.height}"` : ''}>${img[2] ? `<figcaption>${esc(img[2])}</figcaption>` : ''}</figure>`);
    } else if ((m = line.match(/^(#{2,3})\s+(.+)$/))) {
      flushPara(); flushList();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); flushList();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else if ((m = line.match(/^[-*•]\s+(.+)$/)) || (m = line.match(/^\d{1,3}[.)]\s+(.+)$/))) {
      flushPara();
      const tag = /^\d/.test(line) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return out.join('\n');
}
const plain = (body) => String(body || '').replace(/^\s*(?:[-*•]|\d{1,3}[.)])\s+/gm, '').replace(/\[\[img:[^\]]*\]\]/g, ' ').replace(/[#>*_`[\]()]/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
/** Reading minutes (about 200 words a minute). */
const readMinutes = (body) => Math.max(1, Math.round(plain(body).split(' ').filter(Boolean).length / 200));

// ---------------------------------------------------------------- reading / listing (staff)
const COLS = ['a.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.specialization as doctor_specialty', 'd.specialization_en as doctor_specialty_en'];
const withDoctor = (q) => q.leftJoin('doctors as d', function j() { this.on('d.id', 'a.doctor_id').andOn('d.business_id', 'a.business_id'); });

async function list(ctx, { status = '' } = {}) {
  const r = guard(ctx);
  const q = withDoctor(knex('articles as a')).where('a.business_id', ctx.businessId);
  if (!r.any) q.where('a.doctor_id', r.doctorId);
  if (STATUSES.includes(status)) q.where('a.status', status);
  return q.orderBy([{ column: 'a.updated_at', order: 'desc' }]).select(COLS);
}

async function get(ctx, id) {
  const r = guard(ctx);
  const q = withDoctor(knex('articles as a')).where({ 'a.business_id': ctx.businessId, 'a.id': Number(id) || 0 });
  if (!r.any) q.where('a.doctor_id', r.doctorId);
  const a = await q.first(COLS);
  if (!a) throw E.notFound('Article');
  return a;
}

/** Doctors an author may sign as: a doctor login only itself; editors any active doctor (or the clinic: ''). */
async function authorChoices(ctx) {
  const r = guard(ctx);
  const q = knex('doctors').where({ business_id: ctx.businessId }).orderBy([{ column: 'sort_order' }, { column: 'full_name' }]).select('id', 'full_name', 'full_name_en', 'is_active');
  if (!r.any) q.where('id', r.doctorId);
  return q;
}

// ---------------------------------------------------------------- saving
const schema = z.object({
  title: optionalString(200), title_en: optionalString(200),
  excerpt: optionalString(400), excerpt_en: optionalString(400),
  body: z.preprocess((v) => (v === undefined ? '' : String(v)), z.string().max(MAX_BODY, 'Too long.')),
  body_en: z.preprocess((v) => (v === undefined ? '' : String(v)), z.string().max(MAX_BODY, 'Too long.')),
  category: z.preprocess((v) => (v === '' ? undefined : v), z.enum(CATEGORIES).optional()),
  slug: optionalString(90),
});

async function uniqueSlug(businessId, want, id) {
  let base = latin(want) || 'article';
  if (/^\d+$/.test(base)) base = `article-${base}`;
  let slug = base; let n = 2;
  // eslint-disable-next-line no-await-in-loop
  while (await knex('articles').where({ business_id: businessId, slug }).whereNot('id', id || 0).first('id')) { slug = `${base}-${n}`.slice(0, 90); n += 1; }
  return slug;
}

/** Media ids of this clinic that are images (others are dropped). */
async function ownImages(businessId, ids) {
  const want = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))];
  if (!want.length) return [];
  return knex('clinic_media').where({ business_id: businessId }).whereIn('id', want).whereIn('mime', IMAGE_MIMES).pluck('id');
}

/**
 * Saves an article. input: the fields above, plus doctor_id ('' = the clinic, editors only), cover_media_id,
 * on_site / on_platform ('1'), action: 'draft' | 'publish' | 'unpublish'.
 */
async function save(ctx, id, input) {
  const r = guard(ctx);
  const d = validate(schema, input);
  if (!(d.title || d.title_en)) throw E.validation({ title: 'Required.' });
  if (!(d.body.trim() || d.body_en.trim())) throw E.validation({ body: 'Required.' });
  if (d.title && !d.body.trim() && !d.body_en.trim()) throw E.validation({ body: 'Required.' });
  const before = id ? await get(ctx, id) : null;
  // Author: a doctor login is always itself; an editor picks a doctor of this clinic or the clinic.
  let doctorId = r.any ? (input.doctor_id === '' || input.doctor_id === undefined ? (before ? before.doctor_id : r.doctorId) : Number(input.doctor_id) || null) : r.doctorId;
  if (input.doctor_id === '' && r.any) doctorId = null;
  if (doctorId && !(await knex('doctors').where({ business_id: ctx.businessId, id: doctorId }).first('id'))) throw E.validation({ doctor_id: 'Choose a valid value.' });
  const cover = Number(input.cover_media_id) || null;
  const [coverOk] = cover ? await ownImages(ctx.businessId, [cover]) : [];
  const onSite = ['1', 'on', true].includes(input.on_site);
  const onPlatform = ['1', 'on', true].includes(input.on_platform);
  const action = ['publish', 'unpublish', 'draft'].includes(input.action) ? input.action : 'draft';
  const status = action === 'publish' ? 'published' : action === 'unpublish' ? 'draft' : (before ? before.status : 'draft');
  if (status === 'published' && !onSite && !onPlatform) throw new AppError('ARTICLE_NO_PLACE', 'Choose where the article appears.', 422);
  const slug = await uniqueSlug(ctx.businessId, d.slug || d.title_en || d.title || '', before && before.id);
  // The main site: a newly published (or changed) article waits for the platform admin again.
  const changedText = !before || ['title', 'title_en', 'body', 'body_en', 'excerpt', 'excerpt_en'].some((k) => (before[k] || '') !== (d[k] || '')) || (before.cover_media_id || null) !== (coverOk || null);
  let platformStatus = before ? before.platform_status : 'none';
  if (!onPlatform) platformStatus = 'none';
  else if (status === 'published' && (platformStatus === 'none' || platformStatus === 'rejected' || (changedText && platformStatus !== 'pending'))) platformStatus = 'pending';
  const row = {
    doctor_id: doctorId, title: d.title || null, title_en: d.title_en || null, excerpt: d.excerpt || null, excerpt_en: d.excerpt_en || null,
    body: d.body.trim() || null, body_en: d.body_en.trim() || null, category: d.category || null, slug, cover_media_id: coverOk || null,
    status, on_site: onSite, on_platform: onPlatform, platform_status: platformStatus,
    published_at: status === 'published' ? (before && before.published_at) || new Date() : null, updated_at: new Date(),
  };
  if (platformStatus === 'pending' && (!before || before.platform_status !== 'pending')) { row.platform_note = null; row.platform_reviewed_at = null; }
  // Images on a published article are public (the website and the main site show them).
  if (status === 'published') {
    const used = await ownImages(ctx.businessId, [...imageIds(row.body), ...imageIds(row.body_en), coverOk].filter(Boolean));
    if (used.length) await knex('clinic_media').where({ business_id: ctx.businessId }).whereIn('id', used).update({ is_public: true });
  }
  let aid = id;
  if (before) {
    await knex('articles').where({ id: before.id, business_id: ctx.businessId }).update(row);
  } else {
    [aid] = await knex('articles').insert({ ...row, business_id: ctx.businessId, author_user_id: ctx.userId || null, created_at: new Date() });
  }
  const what = status === 'published' && (!before || before.status !== 'published') ? 'article.published' : !before ? 'article.created' : action === 'unpublish' ? 'article.unpublished' : 'article.updated';
  await audit.record(ctx, what, { entityType: 'article', entityId: aid, oldValues: before ? { status: before.status, on_site: Boolean(before.on_site), on_platform: Boolean(before.on_platform) } : undefined, newValues: { title: row.title || row.title_en, status, on_site: onSite, on_platform: onPlatform, platform_status: platformStatus } });
  return aid;
}

async function remove(ctx, id) {
  const a = await get(ctx, id);
  await knex('articles').where({ id: a.id, business_id: ctx.businessId }).del();
  await audit.record(ctx, 'article.deleted', { entityType: 'article', entityId: a.id, oldValues: { title: a.title || a.title_en, status: a.status } });
}

// ---------------------------------------------------------------- public
/** Public image map { id: { url, alt, width, height } } for a clinic's article. */
async function imageMap(clinic, a, locale) {
  const ids = [...imageIds(a.body), ...imageIds(a.body_en), a.cover_media_id].filter(Boolean);
  if (!ids.length) return {};
  const rows = await knex('clinic_media').where({ business_id: clinic.id, is_public: true }).whereIn('id', [...new Set(ids)]).whereIn('mime', IMAGE_MIMES)
    .select('id', 'sha', 'alt_ar', 'alt_en', 'width', 'height');
  return Object.fromEntries(rows.map((m) => [m.id, { url: `/m/${clinic.slug}/${m.id}?v=${m.sha}`, alt: (locale === 'en' ? m.alt_en || m.alt_ar : m.alt_ar || m.alt_en) || '', width: m.width, height: m.height }]));
}

/** The article in the visitor's language (falling back to the other one), ready for a page. */
async function present(clinic, a, locale) {
  const en = locale === 'en';
  const pick = (ar, eng) => (en ? eng || ar : ar || eng) || '';
  const bodyLang = en ? (a.body_en ? 'en' : 'ar') : (a.body ? 'ar' : 'en');
  const body = bodyLang === 'en' ? a.body_en : a.body;
  const images = await imageMap(clinic, a, locale);
  const title = bodyLang === 'en' ? a.title_en || a.title : a.title || a.title_en;
  return {
    id: a.id, slug: a.slug, title, lang: bodyLang, dir: bodyLang === 'ar' ? 'rtl' : 'ltr',
    excerpt: pick(a.excerpt, a.excerpt_en) || plain(body).slice(0, 200), html: render(body, images), minutes: readMinutes(body),
    cover: a.cover_media_id && images[a.cover_media_id] ? images[a.cover_media_id] : null, category: a.category,
    doctor: a.doctor_id ? { id: a.doctor_id, name: pick(a.doctor_name, a.doctor_name_en), specialty: pick(a.doctor_specialty, a.doctor_specialty_en) } : null,
    published: a.published_at, updated: a.updated_at, hasOther: Boolean(en ? a.body : a.body_en), clinicSlug: clinic.slug,
  };
}

const publicBase = (q) => withDoctor(q).where('a.status', 'published');

/** Published articles of a clinic's website. */
async function siteList(clinic, { limit = 60 } = {}) {
  return publicBase(knex('articles as a')).where({ 'a.business_id': clinic.id, 'a.on_site': true }).orderBy('a.published_at', 'desc').limit(limit).select(COLS);
}
async function siteArticle(clinic, slug) {
  return publicBase(knex('articles as a')).where({ 'a.business_id': clinic.id, 'a.on_site': true, 'a.slug': String(slug) }).first(COLS);
}

/** Approved articles of the main site (active clinics only), newest first, optionally of one category. */
async function platformList({ category = '', page = 1, per = 12 } = {}) {
  const q = publicBase(knex('articles as a')).join('businesses as b', 'b.id', 'a.business_id')
    .where({ 'a.on_platform': true, 'a.platform_status': 'approved', 'b.status': 'active' });
  if (CATEGORIES.includes(category)) q.where('a.category', category);
  const [{ n }] = await q.clone().clearSelect().count({ n: '*' });
  const p = Math.max(1, Number(page) || 1);
  const rows = await q.orderBy('a.published_at', 'desc').limit(per).offset((p - 1) * per)
    .select(COLS.concat(['b.slug as clinic_slug', 'b.name as clinic_name', 'b.name_en as clinic_name_en', 'b.id as clinic_id']));
  return { rows, total: Number(n), page: p, pages: Math.max(1, Math.ceil(Number(n) / per)) };
}
async function platformArticle(id) {
  return publicBase(knex('articles as a')).join('businesses as b', 'b.id', 'a.business_id')
    .where({ 'a.id': Number(id) || 0, 'a.on_platform': true, 'a.platform_status': 'approved', 'b.status': 'active' })
    .first(COLS.concat(['b.slug as clinic_slug', 'b.name as clinic_name', 'b.name_en as clinic_name_en', 'b.id as clinic_id', 'b.booking_enabled']));
}

const countView = (id) => knex('articles').where({ id }).increment('views', 1).catch(() => {});

// ---------------------------------------------------------------- platform admin
async function adminList({ status = 'pending' } = {}) {
  const q = withDoctor(knex('articles as a')).join('businesses as b', 'b.id', 'a.business_id').where('a.on_platform', true).where('a.status', 'published');
  if (['pending', 'approved', 'rejected'].includes(status)) q.where('a.platform_status', status);
  return q.orderBy('a.updated_at', 'desc').limit(200).select(COLS.concat(['b.slug as clinic_slug', 'b.name as clinic_name']));
}
async function moderate(ctx, id, action, note) {
  const a = await knex('articles').where({ id: Number(id) || 0, on_platform: true }).first();
  if (!a) throw E.notFound('Article');
  const to = action === 'approve' ? 'approved' : 'rejected';
  const reason = String(note || '').trim().slice(0, 300) || null;
  if (to === 'rejected' && !reason) throw E.validation({ note: 'Required.' });
  await knex('articles').where({ id: a.id }).update({ platform_status: to, platform_note: to === 'rejected' ? reason : null, platform_reviewed_at: new Date() });
  await audit.record({ ...ctx, businessId: a.business_id }, `article.platform_${to}`, { entityType: 'article', entityId: a.id, newValues: { reason: reason || undefined } });
  try {
    const { translator } = require('../../core/i18n'); // eslint-disable-line global-require
    const key = to === 'approved' ? 'articles.notify.approved' : 'articles.notify.rejected';
    const body = `${translator('ar')(key, { reason: reason || '' })} · ${translator('en')(key, { reason: reason || '' })}`;
    // The author (a doctor login) hears it; without one, the website editors.
    await require('../notifications/notification.service').notify(a.business_id, { userId: a.author_user_id || null, permission: a.author_user_id ? null : 'website.edit', type: 'article.review', severity: to === 'approved' ? 'success' : 'warning', title: a.title || a.title_en, body, link: `/app/articles/${a.id}` }); // eslint-disable-line global-require
  } catch { /* a notice never blocks the review */ }
}
const pendingCount = async () => Number((await knex('articles').where({ on_platform: true, status: 'published', platform_status: 'pending' }).count({ n: '*' }))[0].n);

/** URLs for the sitemaps. */
async function sitemapPlatform() {
  return knex('articles as a').join('businesses as b', 'b.id', 'a.business_id').where({ 'a.status': 'published', 'a.on_platform': true, 'a.platform_status': 'approved', 'b.status': 'active' })
    .select('a.id', 'a.slug', 'a.updated_at');
}
const sitemapSite = (businessId) => knex('articles').where({ business_id: businessId, status: 'published', on_site: true }).select('slug', 'updated_at');

module.exports = {
  STATUSES, CATEGORIES, MAX_BODY, rights, list, get, authorChoices, save, remove, render, plain, readMinutes, imageIds, present,
  siteList, siteArticle, platformList, platformArticle, countView, adminList, moderate, pendingCount, sitemapPlatform, sitemapSite, scoped,
};
