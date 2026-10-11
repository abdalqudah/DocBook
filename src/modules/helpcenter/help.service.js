// The platform's help articles (Admin → Website → Help articles): short how-to guides in Arabic and English, public at
// /help and /help/<slug>, listed in the clinic's own Help page and linked from the onboarding e-mails. Text uses the
// same safe formatting as document templates ("# " heading, "- " list, **bold**, links, pictures).
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');

const CATEGORIES = ['start', 'booking', 'patients', 'billing', 'website', 'team', 'other'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;
const str = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

const list = ({ all = false, q = '' } = {}) => {
  const query = knex('help_articles').orderBy([{ column: 'category' }, { column: 'sort' }, { column: 'id' }]).select('id', 'slug', 'category', 'title_ar', 'title_en', 'sort', 'published', 'views', 'updated_at');
  if (!all) query.where({ published: true });
  const s = String(q || '').trim().slice(0, 80);
  if (s) query.where((w) => w.where('title_ar', 'like', `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`).orWhere('title_en', 'like', `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`).orWhere('body_ar', 'like', `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  return query;
};
async function get(id) {
  const a = await knex('help_articles').where({ id: Number(id) || 0 }).first();
  if (!a) throw E.notFound('Article');
  return a;
}
async function bySlug(slug, { count = true } = {}) {
  if (!SLUG_RE.test(String(slug || ''))) return null;
  const a = await knex('help_articles').where({ slug, published: true }).first();
  if (a && count) await knex('help_articles').where({ id: a.id }).update({ views: knex.raw('views + 1') });
  return a || null;
}
async function save(ctx, id, body) {
  const v = {
    title_ar: str(body.title_ar, 200), title_en: str(body.title_en, 200) || null, body_ar: String(body.body_ar || '').replace(/\r\n/g, '\n').trim().slice(0, 30000),
    body_en: String(body.body_en || '').replace(/\r\n/g, '\n').trim().slice(0, 30000) || null, category: CATEGORIES.includes(body.category) ? body.category : 'other',
    sort: Number.parseInt(body.sort, 10) || 0, published: [].concat(body.published ?? '1').map(String).includes('1'),
  };
  v.slug = str(body.slug, 80).toLowerCase() || slugify(v.title_en || '') || `article-${Date.now().toString(36)}`;
  const errors = {};
  if (!v.title_ar) errors.title_ar = 'Enter the title.';
  if (!v.body_ar) errors.body_ar = 'Write the article.';
  if (!SLUG_RE.test(v.slug)) errors.slug = 'Use small English letters, numbers and dashes.';
  else if (await knex('help_articles').where({ slug: v.slug }).whereNot('id', Number(id) || 0).first('id')) errors.slug = 'Another article uses this address.';
  if (Object.keys(errors).length) throw E.validation(errors);
  let aid = Number(id) || null;
  if (aid) { await get(aid); await knex('help_articles').where({ id: aid }).update({ ...v, updated_at: new Date() }); } else [aid] = await knex('help_articles').insert(v);
  await audit.record(ctx, 'platform.help_saved', { entityType: 'help_article', entityId: aid, newValues: { slug: v.slug, published: v.published } });
  return aid;
}
async function remove(ctx, id) {
  const a = await get(id);
  await knex('help_articles').where({ id: a.id }).del();
  await audit.record(ctx, 'platform.help_deleted', { entityType: 'help_article', entityId: a.id, oldValues: { slug: a.slug } });
}
const pick = (a, locale) => ({ title: (locale === 'en' && a.title_en) || a.title_ar, body: (locale === 'en' && a.body_en) || a.body_ar });

module.exports = { CATEGORIES, list, get, bySlug, save, remove, pick, slugify };
