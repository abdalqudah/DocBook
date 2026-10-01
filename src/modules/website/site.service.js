// Clinic website: draft → preview → publish (DocBook 2.0 redesign 4.4/4.8). Every function is scoped to the clinic of
// the signed-in member (ctx.businessId, from the session) — never to an id sent by the browser.
//   • state: 'classic' (never opened the builder — the classic clinic page is live, unchanged), 'draft' (building, the
//     classic page is still live), 'live' (the published version is live), 'unpublished' (taken down: a minimal page
//     with the clinic's name, contact and booking stays up so printed QR codes and reminder links keep working).
//   • Editing always changes the draft only. Publish copies the draft into a new published version; the previous one
//     is archived (the last KEEP versions stay for restore). Restore copies a version into the draft, never live.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const cache = require('../../core/cache');
const { E, AppError } = require('../../core/errors');
const sections = require('./sections');
const { TEMPLATES, THEMES } = require('./catalog');

const KEEP = 10;
const MEDIA_CONTEXT = 'website';
const parseDoc = (v) => { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
const forget = (businessId) => cache.forgetPrefix(`site:${businessId}`);

async function row(businessId) { return knex('clinic_sites').where({ business_id: businessId }).first(); }
async function version(businessId, id) {
  if (!id) return null;
  const v = await knex('clinic_site_versions').where({ business_id: businessId, id }).first();
  return v ? { ...v, doc: parseDoc(v.doc) } : null;
}

/** The clinic's references a document may point at (its own media and doctors only). */
async function refsOf(businessId) {
  const [media, doctors] = await Promise.all([
    knex('clinic_media').where({ business_id: businessId }).whereIn('mime', ['image/png', 'image/jpeg', 'image/webp']).pluck('id'),
    knex('doctors').where({ business_id: businessId }).pluck('id'),
  ]);
  return { media: new Set(media), doctors: new Set(doctors) };
}

/**
 * { status, row, publishedAt, draftChanged } — status 'classic' when the clinic never opened the builder. The draft
 * "has changes" when its document differs from the live one (exact, whatever the clock resolution).
 */
async function state(businessId) {
  const r = await row(businessId);
  if (!r) return { status: 'classic', row: null, publishedAt: null, draftChanged: false };
  const [d, l] = await Promise.all([version(businessId, r.draft_version_id), version(businessId, r.live_version_id)]);
  const same = (a, b) => JSON.stringify(sections.sanitize(a)) === JSON.stringify(sections.sanitize(b));
  const draftChanged = Boolean(d && r.draft_updated_at && (!l || !same(d.doc, l.doc)));
  return { status: r.status, row: r, publishedAt: r.published_at, draftChanged };
}

/** The draft (created on first use from the template that suits the clinic, keeping its current cover and gallery). */
async function draft(ctx, business) {
  let r = await row(ctx.businessId);
  if (r && r.draft_version_id) { const v = await version(ctx.businessId, r.draft_version_id); if (v) return { row: r, doc: sections.sanitize(v.doc) }; }
  const pm = await knex('media_usages').where({ business_id: ctx.businessId }).whereIn('context', ['portal.cover', 'portal.gallery']).orderBy('sort_order').select('media_id', 'context');
  const template = sections.SPECIALTY_TEMPLATE[business && business.specialty] || 'general';
  const doc = sections.defaultDoc(template, { cover: (pm.find((m) => m.context === 'portal.cover') || {}).media_id || null, gallery: pm.filter((m) => m.context === 'portal.gallery').map((m) => m.media_id) });
  await knex.transaction(async (trx) => {
    const [vid] = await trx('clinic_site_versions').insert({ business_id: ctx.businessId, kind: 'draft', doc: JSON.stringify(doc), created_by: ctx.userId || null });
    if (r) await trx('clinic_sites').where({ business_id: ctx.businessId }).update({ draft_version_id: vid, updated_at: new Date() });
    else await trx('clinic_sites').insert({ business_id: ctx.businessId, status: 'draft', draft_version_id: vid });
    await audit.record(ctx, 'website.started', { entityType: 'clinic_site', entityId: ctx.businessId, newValues: { template } }, trx);
  });
  r = await row(ctx.businessId);
  forget(ctx.businessId);
  return { row: r, doc };
}

/** Replaces the draft with `doc` (sanitised against the clinic's own media/doctors). Live is never touched. */
async function saveDraft(ctx, business, doc, { note = 'website.draft_saved', details = null } = {}) {
  const { row: r } = await draft(ctx, business);
  const clean = sections.sanitize(doc, await refsOf(ctx.businessId));
  await knex('clinic_site_versions').where({ business_id: ctx.businessId, id: r.draft_version_id }).update({ doc: JSON.stringify(clean) });
  await knex('clinic_sites').where({ business_id: ctx.businessId }).update({ draft_updated_at: new Date(), draft_updated_by: ctx.userId || null, updated_at: new Date() });
  if (note) await audit.record(ctx, note, { entityType: 'clinic_site', entityId: ctx.businessId, newValues: details || undefined });
  forget(ctx.businessId);
  return clean;
}

/** Applies `fn(doc)` to the draft and saves it (the edit operations of the builder). */
async function edit(ctx, business, fn, audited) {
  const { doc } = await draft(ctx, business);
  const next = fn(JSON.parse(JSON.stringify(doc))) || doc;
  return saveDraft(ctx, business, next, audited || {});
}

const home = (doc) => doc.pages.find((p) => p.key === 'home');
/** A page of the site by key (home when no key); 404 for an unknown one. */
const pageOf = (doc, key) => { const p = doc.pages.find((x) => x.key === (key || 'home')); if (!p) throw E.notFound('Page'); return p; };
/** The page that holds a section. */
const pageWith = (doc, id) => doc.pages.find((p) => p.sections.some((x) => x.id === id));
const findSection = (doc, id) => { const p = pageWith(doc, id); const s = p && p.sections.find((x) => x.id === id); if (!s) throw E.notFound('Section'); return s; };
/** A page address from its title (Arabic is written in Latin letters), unique among the site's pages. */
function pageSlug(doc, title, own) {
  const { latinize } = require('../businesses/business.service'); // eslint-disable-line global-require
  let base = latinize(title).toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 34);
  if (!base || base.length < 2 || sections.RESERVED_PAGES.has(base)) base = 'page';
  const taken = new Set(doc.pages.filter((p) => p.key !== own).map((p) => p.slug));
  let slug = base; let i = 2;
  while (taken.has(slug)) { slug = `${base}-${i}`; i += 1; }
  return slug;
}

const ops = {
  add: (type, afterId, pageKey) => (doc) => {
    if (!sections.TYPES[type]) throw E.validation({ type: 'Choose a valid value.' });
    const list = pageOf(doc, pageKey).sections;
    if (sections.TYPES[type].single && list.some((s) => s.type === type)) throw new AppError('SECTION_ONCE', 'This section is already on the page.', 409);
    if (list.length >= sections.MAX_SECTIONS) throw new AppError('SECTION_LIMIT', 'The page has the most sections it can hold.', 409);
    const at = afterId ? list.findIndex((s) => s.id === afterId) + 1 : list.length;
    list.splice(at <= 0 ? list.length : at, 0, sections.blankSection(type));
    return doc;
  },
  remove: (id) => (doc) => { findSection(doc, id); const p = pageWith(doc, id); p.sections = p.sections.filter((s) => s.id !== id); return doc; },
  move: (id, dir) => (doc) => {
    const p = pageWith(doc, id); if (!p) throw E.notFound('Section');
    const list = p.sections; const i = list.findIndex((s) => s.id === id);
    if (i === -1) throw E.notFound('Section');
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
    return doc;
  },
  order: (idsInOrder, pageKey) => (doc) => {
    const page = pageOf(doc, pageKey);
    const list = page.sections; const byId = new Map(list.map((s) => [s.id, s]));
    const wanted = [].concat(idsInOrder || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter((id) => byId.has(id));
    page.sections = [...new Set(wanted)].map((id) => byId.get(id)).concat(list.filter((s) => !wanted.includes(s.id)));
    return doc;
  },
  // ---- pages
  addPage: (title) => (doc) => {
    if (doc.pages.length >= sections.MAX_PAGES) throw new AppError('PAGE_LIMIT', 'The site has the most pages it can hold.', 409);
    const t = { ar: String((title && title.ar) || '').slice(0, 60), en: String((title && title.en) || '').slice(0, 60) };
    if (!t.ar.trim() && !t.en.trim()) throw E.validation({ title: 'Enter the page title.' });
    const key = sections.newId();
    doc.pages.push({ key, slug: pageSlug(doc, t.en || t.ar, key), title: t, menu: true, sections: [sections.blankSection('text')] });
    doc.newPageKey = key;
    return doc;
  },
  updatePage: (key, input) => (doc) => {
    if (key === 'home') throw E.validation({ page: 'The home page cannot be renamed.' });
    const p = pageOf(doc, key);
    if (input.title) p.title = { ar: String(input.title.ar || '').slice(0, 60), en: String(input.title.en || '').slice(0, 60) };
    if (input.slug !== undefined) {
      const want = String(input.slug || '').trim().toLowerCase();
      if (!sections.PAGE_SLUG.test(want) || sections.RESERVED_PAGES.has(want)) throw E.validation({ slug: 'Use English letters, numbers or dashes.' });
      if (doc.pages.some((x) => x.key !== key && x.slug === want)) throw E.validation({ slug: 'Another page already uses this address.' });
      p.slug = want;
    }
    if (input.menu !== undefined) p.menu = input.menu === true || input.menu === '1';
    if (input.seo) p.seo = input.seo;
    return doc;
  },
  removePage: (key) => (doc) => {
    if (key === 'home') throw E.validation({ page: 'The home page cannot be removed.' });
    pageOf(doc, key);
    doc.pages = doc.pages.filter((p) => p.key !== key);
    if (doc.header && Array.isArray(doc.header.items)) doc.header.items = doc.header.items.filter((it) => !(it.kind === 'page' && it.target === key));
    return doc;
  },
  movePage: (key, dir) => (doc) => {
    const i = doc.pages.findIndex((p) => p.key === key);
    if (i <= 0) throw E.notFound('Page');
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j >= 1 && j < doc.pages.length) [doc.pages[i], doc.pages[j]] = [doc.pages[j], doc.pages[i]];
    return doc;
  },
  header: (input) => (doc) => { doc.header = input; return doc; },
  footer: (input) => (doc) => { doc.footer = input; return doc; },
  toggle: (id) => (doc) => { const s = findSection(doc, id); s.visible = !s.visible; return doc; },
  update: (id, input) => (doc) => {
    const s = findSection(doc, id);
    const def = sections.TYPES[s.type];
    if (def.variants.includes(input.variant)) s.variant = input.variant;
    s.content = input.content || s.content;
    s.settings = { ...s.settings, ...(input.settings || {}) };
    return doc;
  },
  theme: (theme) => (doc) => { if (!THEMES.includes(theme)) throw E.validation({ theme: 'Choose a valid value.' }); doc.theme = theme; return doc; },
  brand: (brand) => (doc) => { doc.brand = { ...doc.brand, ...brand }; return doc; },
  seo: (seo) => (doc) => { doc.seo = seo; return doc; },
  /** A template changes the look; with addMissing, the template's sections the page lacks are added. Content is kept. */
  template: (template, addMissing, allowed) => (doc) => {
    if (!TEMPLATES.includes(template)) throw E.validation({ template: 'Choose a valid value.' });
    if (allowed && allowed !== '*' && !allowed.includes(template)) throw new AppError('TEMPLATE_NOT_IN_PLAN', 'This template is not included in the clinic\'s package.', 402);
    doc.template = template;
    doc.theme = sections.TEMPLATE_LAYOUT[template].theme;
    if (addMissing) {
      const have = new Set(home(doc).sections.map((s) => s.type));
      for (const type of sections.TEMPLATE_LAYOUT[template].sections) if (!have.has(type) && home(doc).sections.length < sections.MAX_SECTIONS) home(doc).sections.push(sections.blankSection(type));
    }
    return doc;
  },
};

/** Publishes the draft: a new published version goes live, the previous one is archived, used images become public. */
async function publish(ctx, business) {
  const { doc } = await draft(ctx, business);
  const clean = sections.sanitize(doc, await refsOf(ctx.businessId));
  if (!home(clean).sections.some((s) => s.visible)) throw new AppError('SITE_EMPTY', 'Show at least one section before publishing.', 422);
  const media = sections.mediaIn(clean);
  let vid;
  await knex.transaction(async (trx) => {
    const before = await trx('clinic_sites').where({ business_id: ctx.businessId }).forUpdate().first();
    await trx('clinic_site_versions').where({ business_id: ctx.businessId, kind: 'published' }).update({ kind: 'archived' });
    [vid] = await trx('clinic_site_versions').insert({ business_id: ctx.businessId, kind: 'published', doc: JSON.stringify(clean), created_by: ctx.userId || null });
    const now = new Date();
    await trx('clinic_sites').where({ business_id: ctx.businessId }).update({ status: 'live', live_version_id: vid, published_at: now, published_by: ctx.userId || null, updated_at: now });
    // Keep the last KEEP published/archived versions.
    const old = await trx('clinic_site_versions').where({ business_id: ctx.businessId }).whereIn('kind', ['archived']).orderBy('id', 'desc').offset(KEEP - 1).pluck('id');
    if (old.length) await trx('clinic_site_versions').where({ business_id: ctx.businessId }).whereIn('id', old).del();
    // Images on the live site are public and tracked (the media library warns before deleting them).
    await trx('media_usages').where({ business_id: ctx.businessId, context: MEDIA_CONTEXT }).del();
    if (media.length) {
      await trx('media_usages').insert(media.map((id, i) => ({ business_id: ctx.businessId, media_id: id, context: MEDIA_CONTEXT, sort_order: i })));
      await trx('clinic_media').where({ business_id: ctx.businessId }).whereIn('id', media).where({ is_public: false }).update({ is_public: true, updated_at: now });
    }
    await audit.record(ctx, 'website.published', { entityType: 'clinic_site', entityId: ctx.businessId, oldValues: { status: before.status, version: before.live_version_id }, newValues: { status: 'live', version: vid } }, trx);
  });
  cache.forgetPrefix(`media:page:${ctx.businessId}`);
  forget(ctx.businessId);
  return vid;
}

/** Takes the website down (the minimal page stays so links and QR codes keep working). */
async function unpublish(ctx) {
  const r = await row(ctx.businessId);
  if (!r) { await knex('clinic_sites').insert({ business_id: ctx.businessId, status: 'unpublished' }); }
  else if (r.status !== 'unpublished') await knex('clinic_sites').where({ business_id: ctx.businessId }).update({ status: 'unpublished', updated_at: new Date() });
  await audit.record(ctx, 'website.unpublished', { entityType: 'clinic_site', entityId: ctx.businessId, oldValues: { status: r ? r.status : 'classic' }, newValues: { status: 'unpublished' } });
  forget(ctx.businessId);
}

/** Puts the website back up: the last published version, or the classic page when nothing was published yet. */
async function republish(ctx) {
  const r = await row(ctx.businessId);
  if (!r || r.status !== 'unpublished') return;
  const status = r.live_version_id ? 'live' : 'draft';
  await knex('clinic_sites').where({ business_id: ctx.businessId }).update({ status, updated_at: new Date() });
  await audit.record(ctx, 'website.republished', { entityType: 'clinic_site', entityId: ctx.businessId, newValues: { status } });
  forget(ctx.businessId);
}

/** Published and archived versions, newest first. */
async function versions(businessId) {
  return knex('clinic_site_versions as v').leftJoin('users as u', 'u.id', 'v.created_by').where('v.business_id', businessId).whereIn('v.kind', ['published', 'archived'])
    .orderBy('v.id', 'desc').limit(KEEP).select('v.id', 'v.kind', 'v.created_at', 'u.name as by');
}

/** Copies a published/archived version into the draft (it goes live only when published again). */
async function restore(ctx, business, versionId) {
  const v = await version(ctx.businessId, Number(versionId));
  if (!v || !['published', 'archived'].includes(v.kind)) throw E.notFound('Version');
  return saveDraft(ctx, business, v.doc, { note: 'website.version_restored', details: { version: v.id } });
}

/** Throws the draft away: back to the live version (or a fresh template when nothing was published). */
async function discard(ctx, business) {
  const r = await row(ctx.businessId);
  if (!r) return null;
  const live = r.live_version_id ? await version(ctx.businessId, r.live_version_id) : null;
  const template = sections.SPECIALTY_TEMPLATE[business && business.specialty] || 'general';
  const doc = live ? live.doc : sections.defaultDoc(template);
  await saveDraft(ctx, business, doc, { note: 'website.draft_discarded' });
  await knex('clinic_sites').where({ business_id: ctx.businessId }).update({ draft_updated_at: r.published_at || null });
  forget(ctx.businessId);
  return doc;
}

/** What the public page shows: { status, doc } (doc only when the builder version is live). Cached briefly. */
function publicState(businessId) {
  return cache.remember(`site:${businessId}:public`, async () => {
    const r = await row(businessId);
    if (!r) return { status: 'classic', doc: null };
    if (r.status === 'live' && r.live_version_id) { const v = await version(businessId, r.live_version_id); return { status: 'live', doc: v ? sections.sanitize(v.doc) : null }; }
    return { status: r.status === 'unpublished' ? 'unpublished' : 'classic', doc: null };
  }, 30_000);
}

/** Addresses of the clinics whose live website asks AI crawlers not to read it (for the platform robots.txt). */
function aiBlockedSlugs() {
  return cache.remember('site:aiblocked', async () => {
    const rows = await knex('clinic_sites as s').join('businesses as b', 'b.id', 's.business_id').join('clinic_site_versions as v', 'v.id', 's.live_version_id')
      .where({ 's.status': 'live', 'b.status': 'active' }).whereNotNull('b.slug').select('b.slug', 'v.doc');
    return rows.filter((r) => { const d = parseDoc(r.doc); return d && d.seo && d.seo.ai && d.seo.ai.bots === 'block'; }).map((r) => r.slug);
  }, 600_000);
}

/** The other pages of live websites (for the platform sitemap): [{ slug, page, hide }]. */
function livePages() {
  return cache.remember('site:livepages', async () => {
    const rows = await knex('clinic_sites as s').join('businesses as b', 'b.id', 's.business_id').join('clinic_site_versions as v', 'v.id', 's.live_version_id')
      .where({ 's.status': 'live', 'b.status': 'active' }).whereNotNull('b.slug').select('b.slug', 'v.doc', 's.published_at');
    return rows.flatMap((r) => { const d = parseDoc(r.doc); if (!d || (d.seo && d.seo.hide)) return []; return (d.pages || []).filter((p) => p.key !== 'home' && p.slug).map((p) => ({ slug: r.slug, page: p.slug, at: r.published_at })); });
  }, 600_000);
}

module.exports = { aiBlockedSlugs, livePages, state, draft, saveDraft, edit, ops, pageOf, pageWith, pageSlug, publish, unpublish, republish, versions, restore, discard, publicState, refsOf, forget, KEEP, MEDIA_CONTEXT };
