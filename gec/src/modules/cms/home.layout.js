// Home page layout: which sections show, in what order, with optional titles (AR/EN), plus sections made of a
// page's blocks. Stored in settings 'home_layout'; new built-in sections appear automatically at the end.
const knex = require('../../db/knex');
const settings = require('../settings/settings.service');
const blocks = require('./blocks');
const { withData } = require('./blocks.data');

const BUILTIN = ['search', 'destinations', 'journey', 'portal', 'featured', 'scholarships', 'services', 'events', 'testimonials', 'articles', 'cta'];
const TEXT = ['title_en', 'title_ar', 'lead_en', 'lead_ar'];
const NO_TITLE = ['search'];

/** Stored layout merged with defaults: [{ key, visible, title_en, … } | { key: 'page:ID', page: ID, visible }]. */
async function load() {
  const saved = ((await settings.get('home_layout')) || {}).sections || [];
  const out = [];
  for (const s of saved) {
    if (BUILTIN.includes(s.key) && !out.some((x) => x.key === s.key)) out.push({ ...s, visible: s.visible !== false });
    else if (/^page:\d+$/.test(s.key || '')) out.push({ key: s.key, page: Number(s.key.slice(5)), visible: s.visible !== false });
  }
  BUILTIN.filter((k) => !out.some((x) => x.key === k)).forEach((k) => out.push({ key: k, visible: true }));
  return out;
}

async function save(ctx, sections) {
  const clean = sections.map((s) => (s.page ? { key: `page:${s.page}`, visible: !!s.visible }
    : { key: s.key, visible: !!s.visible, ...Object.fromEntries(TEXT.map((f) => [f, String(s[f] || '').trim().slice(0, f.startsWith('title') ? 160 : 400)]).filter(([, v]) => v)) }));
  await settings.set(ctx, 'home_layout', { sections: clean });
}

/** For rendering: page sections get their (published) page's visible blocks with data. */
async function resolve() {
  const list = await load();
  const ids = list.filter((s) => s.page && s.visible).map((s) => s.page);
  const pages = ids.length ? await knex('pages').whereIn('id', ids).where('is_published', true).select('id', 'blocks') : [];
  return Promise.all(list.map(async (s) => {
    if (!s.page) return s;
    const p = pages.find((x) => x.id === s.page);
    return { ...s, visible: s.visible && !!p, blocks: p ? await withData(blocks.parse(p.blocks)) : [] };
  }));
}

module.exports = { BUILTIN, TEXT, NO_TITLE, load, save, resolve };
