// Landing page content, editable by the platform admin (ported from the RemoteWay 1.1 site editor and
// adapted to clinics): the header, an ordered list of typed sections, the footer and the SEO texts.
// Every text has an Arabic and an English version. Until the platform saves its own version the page is
// built from the translation files (site.d.*), so it always shows DocBook's truthful default copy.
// Stored as JSON in platform_settings (key "site_content").
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const brand = require('../../config/brand');
const { translator } = require('../../core/i18n');
const { E } = require('../../core/errors');

const KEY = 'site_content';

// Icons available in the sprite (public/icons.svg).
const ICONS = (() => {
  try {
    const svg = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'icons.svg'), 'utf8');
    return [...svg.matchAll(/id="i-([a-z0-9-]+)"/g)].map((m) => m[1]).sort();
  } catch { return []; }
})();

// ---------------------------------------------------------------- schema
// Field kinds: text (one line, AR+EN), textarea (AR+EN), link (a safe URL/path), icon, select, plain (not translated).
// A schema has scalar `fields` and zero or more repeatable `lists` ({ key, fields }).
const VISUALS = ['booking', 'frontdesk', 'records', 'none'];
const TYPES = {
  hero: {
    fields: [['eyebrow', 'text'], ['title', 'text'], ['title_accent', 'text'], ['lead', 'textarea'],
      ['btn1_label', 'text'], ['btn1_href', 'link'], ['btn2_label', 'text'], ['btn2_href', 'link'], ['note', 'text'], ['visual', 'select', ['booking', 'none']]],
    lists: [{ key: 'items', fields: [['icon', 'icon'], ['label', 'text']] }],
  },
  features: {
    fields: [['kicker', 'text'], ['title', 'text'], ['lead', 'textarea']],
    lists: [{ key: 'items', fields: [['icon', 'icon'], ['title', 'text'], ['text', 'textarea']] }],
  },
  split: {
    fields: [['kicker', 'text'], ['title', 'text'], ['lead', 'textarea'], ['btn_label', 'text'], ['btn_href', 'link'],
      ['visual', 'select', VISUALS], ['side', 'select', ['end', 'start']]],
    lists: [{ key: 'items', fields: [['text', 'text']] }],
  },
  steps: {
    fields: [['kicker', 'text'], ['title', 'text'], ['lead', 'textarea']],
    lists: [{ key: 'items', fields: [['title', 'text'], ['text', 'textarea']] }],
  },
  roles: {
    fields: [['kicker', 'text'], ['title', 'text'], ['lead', 'textarea']],
    lists: [{ key: 'items', fields: [['icon', 'icon'], ['title', 'text'], ['text', 'textarea']] }],
  },
  faq: {
    fields: [['kicker', 'text'], ['title', 'text'], ['lead', 'textarea']],
    lists: [{ key: 'items', fields: [['q', 'text'], ['a', 'textarea']] }],
  },
  testimonials: {
    fields: [['kicker', 'text'], ['title', 'text']],
    lists: [{ key: 'items', fields: [['quote', 'textarea'], ['name', 'text'], ['role', 'text']] }],
  },
  text: { fields: [['kicker', 'text'], ['title', 'text'], ['body', 'textarea']] },
  contact: {
    fields: [['kicker', 'text'], ['title', 'text'], ['lead', 'textarea']],
    lists: [{ key: 'items', fields: [['icon', 'icon'], ['label', 'text'], ['value', 'plain'], ['href', 'link']] }],
  },
  cta: { fields: [['title', 'text'], ['text', 'text'], ['btn1_label', 'text'], ['btn1_href', 'link'], ['btn2_label', 'text'], ['btn2_href', 'link']] },
};
const HEADER = {
  fields: [['login_label', 'text'], ['signup_label', 'text'], ['signup_href', 'link'], ['show_login', 'select', ['yes', 'no']]],
  lists: [{ key: 'items', fields: [['label', 'text'], ['href', 'link']] }],
};
const FOOTER = {
  fields: [['tagline', 'textarea'], ['col1_title', 'text'], ['col2_title', 'text'], ['col3_title', 'text'],
    ['email', 'plain'], ['phone', 'plain'], ['address', 'text'], ['copyright', 'plain']],
  lists: [
    { key: 'items', fields: [['label', 'text'], ['href', 'link'], ['column', 'select', ['1', '2', '3']]] },
    { key: 'social', fields: [['icon', 'icon'], ['label', 'text'], ['href', 'link']] },
  ],
};
const SEO = { fields: [['title', 'text'], ['description', 'textarea']] };
const BLOCKS = { header: HEADER, footer: FOOTER, seo: SEO };
const isI18n = (kind) => kind === 'text' || kind === 'textarea';

// ---------------------------------------------------------------- default content (from the translation files)
function defaults() {
  const en = translator('en');
  const ar = translator('ar');
  const T = (k) => ({ en: en(`site.d.${k}`), ar: ar(`site.d.${k}`) });
  const list = (prefix, keys, build) => keys.map((k, i) => build((f) => T(`${prefix}.${k}.${f}`), k, i));
  return {
    version: 1,
    header: {
      items: [['features', '/#features'], ['how', '/#how'], ['roles', '/#roles'], ['faq', '/#faq']].map(([k, href]) => ({ label: T(`nav.${k}`), href })),
      login_label: T('nav.login'), signup_label: T('nav.signup'), signup_href: '/signup', show_login: 'yes',
    },
    sections: [
      { id: 'hero', type: 'hero', anchor: 'top', hidden: false, data: {
        eyebrow: T('hero.eyebrow'), title: T('hero.title'), title_accent: T('hero.title_accent'), lead: T('hero.lead'),
        btn1_label: T('nav.signup'), btn1_href: '/signup', btn2_label: T('nav.login'), btn2_href: '/login', note: T('hero.note'), visual: 'booking',
        items: [['calendar-check', 'booking'], ['languages', 'languages'], ['smartphone', 'mobile'], ['shield-check', 'roles']].map(([icon, k]) => ({ icon, label: T(`hero.points.${k}`) })),
      } },
      { id: 'features', type: 'features', anchor: 'features', hidden: false, data: {
        kicker: T('features.kicker'), title: T('features.title'), lead: T('features.lead'),
        items: list('features.items', ['booking', 'calendar', 'frontdesk', 'records', 'billing', 'payroll', 'supplies', 'staff', 'languages'],
          (F, k) => ({ icon: { booking: 'calendar-plus', calendar: 'calendar-days', frontdesk: 'armchair', records: 'notebook-pen', billing: 'receipt', payroll: 'hand-coins', supplies: 'package', staff: 'user-cog', languages: 'languages' }[k], title: F('title'), text: F('text') })),
      } },
      { id: 'booking', type: 'split', anchor: 'online-booking', hidden: false, data: {
        kicker: T('booking.kicker'), title: T('booking.title'), lead: T('booking.lead'), btn_label: T('booking.btn'), btn_href: '/signup', visual: 'booking', side: 'end',
        items: [1, 2, 3, 4].map((i) => ({ text: T(`booking.p${i}`) })),
      } },
      { id: 'frontdesk', type: 'split', anchor: 'front-desk', hidden: false, data: {
        kicker: T('frontdesk.kicker'), title: T('frontdesk.title'), lead: T('frontdesk.lead'), btn_label: { ar: '', en: '' }, btn_href: '', visual: 'frontdesk', side: 'start',
        items: [1, 2, 3, 4].map((i) => ({ text: T(`frontdesk.p${i}`) })),
      } },
      { id: 'records', type: 'split', anchor: 'records', hidden: false, data: {
        kicker: T('records.kicker'), title: T('records.title'), lead: T('records.lead'), btn_label: { ar: '', en: '' }, btn_href: '', visual: 'records', side: 'end',
        items: [1, 2, 3, 4].map((i) => ({ text: T(`records.p${i}`) })),
      } },
      { id: 'steps', type: 'steps', anchor: 'how', hidden: false, data: {
        kicker: T('steps.kicker'), title: T('steps.title'), lead: T('steps.lead'),
        items: [1, 2, 3, 4].map((i) => ({ title: T(`steps.s${i}.title`), text: T(`steps.s${i}.text`) })),
      } },
      { id: 'roles', type: 'roles', anchor: 'roles', hidden: false, data: {
        kicker: T('roles.kicker'), title: T('roles.title'), lead: T('roles.lead'),
        items: [['stethoscope', 'doctor'], ['heart-pulse', 'nurse'], ['clipboard-list', 'reception'], ['wallet', 'accountant'], ['building-2', 'manager']]
          .map(([icon, k]) => ({ icon, title: T(`roles.items.${k}.title`), text: T(`roles.items.${k}.text`) })),
      } },
      { id: 'faq', type: 'faq', anchor: 'faq', hidden: false, data: {
        kicker: T('faq.kicker'), title: T('faq.title'), lead: T('faq.lead'),
        items: [1, 2, 3, 4, 5, 6].map((i) => ({ q: T(`faq.q${i}`), a: T(`faq.a${i}`) })),
      } },
      { id: 'cta', type: 'cta', anchor: 'start', hidden: false, data: {
        title: T('cta.title'), text: T('cta.text'), btn1_label: T('nav.signup'), btn1_href: '/signup', btn2_label: T('nav.login'), btn2_href: '/login',
      } },
    ],
    footer: {
      tagline: T('footer.tagline'), col1_title: T('footer.col1'), col2_title: T('footer.col2'), col3_title: { ar: '', en: '' },
      email: brand.supportEmail || '', phone: '', address: { ar: '', en: '' }, copyright: brand.name,
      items: [
        ...[['features', '/#features'], ['how', '/#how'], ['roles', '/#roles'], ['faq', '/#faq']].map(([k, href]) => ({ label: T(`nav.${k}`), href, column: '1' })),
        ...[['login', '/login'], ['signup', '/signup'], ['forgot', '/forgot']].map(([k, href]) => ({ label: T(`nav.${k}`), href, column: '2' })),
      ],
      social: [],
    },
    seo: { title: T('seo.title'), description: T('seo.description') },
  };
}

// ---------------------------------------------------------------- reading
function normalise(v) {
  const d = defaults();
  if (!v || !Array.isArray(v.sections)) return d;
  return {
    version: 1,
    header: v.header || d.header,
    sections: v.sections.filter((s) => s && TYPES[s.type]),
    footer: { ...d.footer, ...(v.footer || {}), social: (v.footer && v.footer.social) || [] },
    seo: v.seo || d.seo,
  };
}

async function get() {
  return cache.remember('site:content', async () => {
    const row = await knex('platform_settings').where({ key: KEY }).first('value');
    if (!row) return defaults();
    try { return normalise(typeof row.value === 'string' ? JSON.parse(row.value) : row.value); } catch { return defaults(); }
  }, 60_000);
}
const isCustomised = async () => Boolean(await knex('platform_settings').where({ key: KEY }).first('key'));

async function save(ctx, content, action, extra = {}) {
  const value = JSON.stringify(content);
  if (value.length > 400_000) throw E.validation({ content: 'The page is too large.' });
  const exists = await knex('platform_settings').where({ key: KEY }).first('key');
  if (exists) await knex('platform_settings').where({ key: KEY }).update({ value, updated_at: new Date() });
  else await knex('platform_settings').insert({ key: KEY, value });
  cache.forgetPrefix('site:');
  await audit.record({ ...ctx, businessId: null }, 'platform.site_updated', { entityType: 'site', entityId: action.split(':')[0], newValues: { action, ...extra } });
}

async function reset(ctx) {
  await knex('platform_settings').where({ key: KEY }).del();
  cache.forgetPrefix('site:');
  await audit.record({ ...ctx, businessId: null }, 'platform.site_reset', { entityType: 'site' });
}

// ---------------------------------------------------------------- form parsing
const clip = (v, n) => String(v ?? '').replace(/\r/g, '').trim().slice(0, n);

/** Only site paths, in-page anchors, https links, mail and phone links (never javascript:, data: or protocol-relative). */
function safeHref(v) {
  const s = clip(v, 500);
  if (!s) return '';
  if (/[\s<>"'`]/.test(s)) return '';
  if (/^\/(?![/\\])/.test(s) || /^#[a-z0-9-]*$/i.test(s)) return s;
  if (/^https:\/\/[^/\\]/i.test(s)) return s;
  if (/^mailto:[^@\s]+@[^@\s]+$/i.test(s)) return s;
  if (/^tel:\+?[0-9 ()-]{3,30}$/i.test(s)) return s;
  return '';
}
const arr = (body, name) => [].concat(body[name] ?? []);
const max = (kind) => (kind === 'textarea' ? 4000 : 400);

function parseValue(raw, [, kind, options], rawAr, rawEn) {
  if (isI18n(kind)) return { ar: clip(rawAr, max(kind)), en: clip(rawEn, max(kind)) };
  if (kind === 'link') return safeHref(raw);
  if (kind === 'icon') return ICONS.includes(raw) ? raw : '';
  if (kind === 'select') return options.includes(raw) ? raw : options[0];
  return clip(raw, 200);
}

const parseField = (body, f) => parseValue(body[`f_${f[0]}`], f, body[`f_${f[0]}_ar`], body[`f_${f[0]}_en`]);

/** Rows arrive as parallel arrays named <list>__<field>[_ar|_en]; the longest array decides the row count. */
function parseList(body, { key, fields }) {
  const col = (f, suffix = '') => arr(body, `${key}__${f[0]}${suffix}`);
  const count = Math.max(0, ...fields.map((f) => (isI18n(f[1]) ? Math.max(col(f, '_ar').length, col(f, '_en').length) : col(f).length)));
  const rows = [];
  for (let i = 0; i < Math.min(count, 40); i += 1) {
    const row = {};
    for (const f of fields) row[f[0]] = parseValue(col(f)[i], f, col(f, '_ar')[i], col(f, '_en')[i]);
    // A row is kept when it has any text, link or free value (icons and selects alone don't count).
    const filled = fields.some(([k, kind]) => (isI18n(kind) ? row[k].ar || row[k].en : ['link', 'plain'].includes(kind) && row[k]));
    if (filled) rows.push(row);
  }
  return rows;
}

function parseSchema(schema, body) {
  const data = {};
  for (const f of schema.fields) data[f[0]] = parseField(body, f);
  for (const l of schema.lists || []) data[l.key] = parseList(body, l);
  return data;
}

const cleanAnchor = (v) => clip(v, 40).toLowerCase().replace(/[^a-z0-9-]/g, '');
const newId = (type) => `${type}-${crypto.randomBytes(3).toString('hex')}`;

// ---------------------------------------------------------------- editing
async function updateSection(ctx, id, body) {
  const content = structuredClone(await get());
  const s = content.sections.find((x) => x.id === id);
  if (!s) throw E.notFound('Section');
  s.data = parseSchema(TYPES[s.type], body);
  const anchor = cleanAnchor(body.anchor);
  if (anchor && !content.sections.some((x) => x.id !== id && x.anchor === anchor)) s.anchor = anchor;
  s.hidden = body.hidden === '1';
  await save(ctx, content, `section:${id}`, { type: s.type });
}

async function updateBlock(ctx, which, body) {
  if (!BLOCKS[which]) throw E.notFound('Block');
  const content = structuredClone(await get());
  content[which] = parseSchema(BLOCKS[which], body);
  await save(ctx, content, which);
}

function blankSection(type) {
  const schema = TYPES[type];
  const data = {};
  for (const [key, kind, options] of schema.fields) data[key] = isI18n(kind) ? { ar: '', en: '' } : kind === 'select' ? options[0] : '';
  if (data.title) {
    const en = translator('en'); const ar = translator('ar');
    data.title = { ar: ar('site.d.new_section'), en: en('site.d.new_section') };
  }
  for (const l of schema.lists || []) data[l.key] = [];
  return data;
}

async function addSection(ctx, type, afterId) {
  if (!TYPES[type]) throw E.validation({ type: 'Choose a valid value.' });
  const content = structuredClone(await get());
  const id = newId(type);
  const section = { id, type, anchor: id, hidden: false, data: blankSection(type) };
  const at = content.sections.findIndex((x) => x.id === afterId);
  if (at >= 0) content.sections.splice(at + 1, 0, section); else content.sections.push(section);
  await save(ctx, content, `add:${id}`, { type });
  return id;
}

async function removeSection(ctx, id) {
  const content = structuredClone(await get());
  const before = content.sections.length;
  content.sections = content.sections.filter((x) => x.id !== id);
  if (content.sections.length === before) throw E.notFound('Section');
  await save(ctx, content, `remove:${id}`);
}

async function moveSection(ctx, id, dir) {
  const content = structuredClone(await get());
  const i = content.sections.findIndex((x) => x.id === id);
  if (i < 0) throw E.notFound('Section');
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= content.sections.length) return;
  [content.sections[i], content.sections[j]] = [content.sections[j], content.sections[i]];
  await save(ctx, content, `move:${id}`, { dir });
}

async function toggleSection(ctx, id) {
  const content = structuredClone(await get());
  const s = content.sections.find((x) => x.id === id);
  if (!s) throw E.notFound('Section');
  s.hidden = !s.hidden;
  await save(ctx, content, `toggle:${id}`, { hidden: s.hidden });
}

async function duplicateSection(ctx, id) {
  const content = structuredClone(await get());
  const i = content.sections.findIndex((x) => x.id === id);
  if (i < 0) throw E.notFound('Section');
  const copy = structuredClone(content.sections[i]);
  copy.id = newId(copy.type);
  copy.anchor = copy.id;
  content.sections.splice(i + 1, 0, copy);
  await save(ctx, content, `duplicate:${id}`, { copy: copy.id });
  return copy.id;
}

/** Picks the visitor's language from a bilingual value (falls back to the other language). */
const pick = (locale) => (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  return v[locale] || v[locale === 'ar' ? 'en' : 'ar'] || '';
};

module.exports = {
  ICONS, TYPES, HEADER, FOOTER, SEO, BLOCKS, VISUALS, isI18n, defaults, get, isCustomised, reset, safeHref, pick,
  updateSection, updateBlock, addSection, removeSection, moveSection, toggleSection, duplicateSection, parseSchema,
};
