// Landing page content, editable by the platform admin (ported from the earlier platform site editor and
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
// Field kinds: text (one line, AR+EN), textarea (AR+EN), link (a safe URL/path), icon, select, plain (not translated),
// media (the id of an image in the media library, see media.service.js).
// A schema has scalar `fields` and zero or more repeatable `lists` ({ key, fields }).
const VISUALS = ['booking', 'frontdesk', 'records', 'image', 'none'];
const TYPES = {
  hero: {
    fields: [['eyebrow', 'text'], ['title', 'text'], ['title_accent', 'text'], ['lead', 'textarea'],
      ['btn1_label', 'text'], ['btn1_href', 'link'], ['btn2_label', 'text'], ['btn2_href', 'link'], ['note', 'text'], ['visual', 'select', ['booking', 'image', 'none']]],
    lists: [{ key: 'items', fields: [['icon', 'icon'], ['label', 'text']] }],
  },
  features: {
    fields: [['kicker', 'text'], ['title', 'text'], ['lead', 'textarea']],
    lists: [{ key: 'items', fields: [['icon', 'icon'], ['image', 'media'], ['title', 'text'], ['text', 'textarea']] }],
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
    lists: [{ key: 'items', fields: [['icon', 'icon'], ['image', 'media'], ['title', 'text'], ['text', 'textarea']] }],
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
  // What's new: a bento grid of cards (a wide card spans two columns), each with an optional "new" tag.
  showcase: {
    fields: [['kicker', 'text'], ['title', 'text'], ['lead', 'textarea']],
    lists: [{ key: 'items', fields: [['icon', 'icon'], ['title', 'text'], ['text', 'textarea'], ['tag', 'text'], ['size', 'select', ['normal', 'wide']]] }],
  },
  // Key numbers; a value that starts with a number counts up when it comes into view. Only state facts.
  stats: {
    fields: [['title', 'text']],
    lists: [{ key: 'items', fields: [['icon', 'icon'], ['value', 'plain'], ['label', 'text']] }],
  },
  // The packages: the active public plans from Admin → Plans (src/modules/site/pricing.js); hidden while there are none.
  pricing: {
    fields: [['kicker', 'text'], ['title', 'text'], ['lead', 'textarea'], ['btn_label', 'text'], ['btn_href', 'link'], ['note', 'text']],
  },
  cta: { fields: [['title', 'text'], ['text', 'text'], ['btn1_label', 'text'], ['btn1_href', 'link'], ['btn2_label', 'text'], ['btn2_href', 'link']] },
};
// Layout settings every section has: alignment, an optional background (a light surface or an image from the
// media library under a soft scrim) and an optional image shown with the section. For the hero and the split
// sections, "visual: image" shows the same image in place of the illustration.
const DESIGN = [
  ['align', 'select', ['default', 'start', 'center', 'end']],
  ['background', 'select', ['none', 'muted', 'image']],
  ['bg_image', 'media'],
  ['media', 'media'],
  ['media_alt', 'text'],
  ['media_pos', 'select', ['top', 'bottom', 'start', 'end']],
  ['media_size', 'select', ['medium', 'small', 'large', 'full']],
];
const HEADER = {
  fields: [['login_label', 'text'], ['signup_label', 'text'], ['signup_href', 'link'], ['show_login', 'select', ['yes', 'no']]],
  lists: [{ key: 'items', fields: [['label', 'text'], ['href', 'link']] }],
};
// Social links moved to Admin → Social & tracking (growth.service.js); the footer shows them from there.
const FOOTER = {
  fields: [['tagline', 'textarea'], ['col1_title', 'text'], ['col2_title', 'text'], ['col3_title', 'text'],
    ['email', 'plain'], ['phone', 'plain'], ['address', 'text'], ['copyright', 'plain']],
  lists: [
    { key: 'items', fields: [['label', 'text'], ['href', 'link'], ['column', 'select', ['1', '2', '3']]] },
  ],
};
// Page title and description now live in Admin → Search & AI (growth.service.js); these stay as the defaults.
const SEO = { fields: [['title', 'text'], ['description', 'textarea']] };
const BLOCKS = { header: HEADER, footer: FOOTER };
const isI18n = (kind) => kind === 'text' || kind === 'textarea';

// ---------------------------------------------------------------- default content (from the translation files)
// What each content revision added (2: waiting screen, sending papers, team chat, backups… 3: pharmacies & centres,
// the screen that calls patients aloud, the consultation timer, message texts, website carousels & icon libraries;
// 4: each member's own e-mail, one file storage per package, exporting and importing patient files;
// 5: surgeries — the doctor's time booked as an operation, its own calendar, the hospital told).
// A page the platform already edited gets a revision's items once (mergeNew) — items the admin removes afterwards are
// not brought back. Only the latest revision's cards carry the "new" tag on a fresh page.
const REV = 5;
const ADDED = {
  2: { showcase: [['queue', 'monitor', 'wide'], ['call', 'bell'], ['share', 'file-check', 'wide'], ['review', 'star'], ['backup', 'shield-check', 'wide'],
    ['chat', 'message-square'], ['specialty', 'stethoscope'], ['letterhead', 'stamp']],
  features: [['share', 'send'], ['queue', 'monitor'], ['security', 'shield-check']], faq: [9, 10, 11] },
  3: { showcase: [['centres', 'pill-bottle', 'wide'], ['voice', 'volume-2'], ['timer', 'timer'], ['texts', 'pen-line', 'wide'], ['carousel', 'layout-grid'], ['icons', 'dt-tooth']],
    features: [['centres', 'pill-bottle'], ['texts', 'pen-line'], ['site', 'layout-template']], faq: [12, 13, 14] },
  4: { showcase: [['mailbox', 'mail', 'wide'], ['export', 'package'], ['import', 'upload'], ['storage', 'database', 'wide']],
    features: [['mailbox', 'mail'], ['portable', 'package']], faq: [15, 16, 17] },
  5: { showcase: [['surgeries', 'scissors', 'wide'], ['hospital', 'hospital']], features: [['surgeries', 'scissors']], faq: [18] },
};
const NEW_SHOWCASE = [...ADDED[5].showcase, ...ADDED[4].showcase, ...ADDED[3].showcase, ...ADDED[2].showcase];
const NEW_FEATURES = [...ADDED[2].features, ...ADDED[3].features, ...ADDED[4].features, ...ADDED[5].features];
const NEW_FAQ = [...ADDED[2].faq, ...ADDED[3].faq, ...ADDED[4].faq, ...ADDED[5].faq];
const LATEST = new Set(ADDED[REV].showcase.map(([k]) => k));

function defaults() {
  const en = translator('en');
  const ar = translator('ar');
  const T = (k) => ({ en: en(`site.d.${k}`), ar: ar(`site.d.${k}`) });
  const list = (prefix, keys, build) => keys.map((k, i) => build((f) => T(`${prefix}.${k}.${f}`), k, i));
  return {
    version: 1,
    header: {
      items: [['new', '/#new'], ['features', '/#features'], ['pricing', '/pricing'], ['how', '/#how'], ['faq', '/#faq'], ['reps', '/vendors']].map(([k, href]) => ({ label: T(`nav.${k}`), href })),
      login_label: T('nav.login'), signup_label: T('nav.signup'), signup_href: '/signup', show_login: 'yes',
    },
    sections: [
      { id: 'hero', type: 'hero', anchor: 'top', hidden: false, data: {
        eyebrow: T('hero.eyebrow'), title: T('hero.title'), title_accent: T('hero.title_accent'), lead: T('hero.lead'),
        btn1_label: T('nav.signup'), btn1_href: '/signup', btn2_label: T('nav.login'), btn2_href: '/login', note: T('hero.note'), visual: 'booking',
        items: [['calendar-check', 'booking'], ['languages', 'languages'], ['smartphone', 'mobile'], ['shield-check', 'roles']].map(([icon, k]) => ({ icon, label: T(`hero.points.${k}`) })),
      } },
      { id: 'stats', type: 'stats', anchor: 'numbers', hidden: false, data: {
        title: { ar: '', en: '' },
        items: [['calendar-clock', '24/7', 'booking'], ['languages', '2', 'languages'], ['layers', '1', 'workspace'], ['download', '0', 'install']]
          .map(([icon, value, k]) => ({ icon, value, label: T(`stats.${k}`) })),
      } },
      { id: 'showcase', type: 'showcase', anchor: 'new', hidden: false, data: {
        kicker: T('showcase.kicker'), title: T('showcase.title'), lead: T('showcase.lead'),
        items: [...NEW_SHOWCASE.map(([k, icon, size]) => [k, icon, size, LATEST.has(k)]),
          ['website', 'layout-template', 'wide'], ['branches', 'building-2'], ['booking', 'calendar-check'], ['telehealth', 'video'], ['ai', 'bot', 'wide']]
          .map(([k, icon, size, isNew]) => ({ icon, title: T(`showcase.items.${k}.title`), text: T(`showcase.items.${k}.text`), tag: isNew ? T('showcase.tag') : { ar: '', en: '' }, size: size || 'normal' })),
      } },
      { id: 'features', type: 'features', anchor: 'features', hidden: false, data: {
        kicker: T('features.kicker'), title: T('features.title'), lead: T('features.lead'),
        items: list('features.items', ['booking', 'calendar', 'frontdesk', 'records', 'billing', 'payroll', 'supplies', 'staff', 'languages', ...NEW_FEATURES.map((f) => f[0])],
          (F, k) => ({ icon: { booking: 'calendar-plus', calendar: 'calendar-days', frontdesk: 'armchair', records: 'notebook-pen', billing: 'receipt', payroll: 'hand-coins', supplies: 'package', staff: 'user-cog', languages: 'languages', ...Object.fromEntries(NEW_FEATURES) }[k], title: F('title'), text: F('text') })),
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
      { id: 'reps', type: 'split', anchor: 'reps', hidden: false, data: {
        kicker: T('reps.kicker'), title: T('reps.title'), lead: T('reps.lead'), btn_label: T('reps.btn'), btn_href: '/vendors/signup', visual: 'none', side: 'end',
        items: [1, 2, 3, 4].map((i) => ({ text: T(`reps.p${i}`) })),
      } },
      { id: 'pricing', type: 'pricing', anchor: 'pricing', hidden: false, data: {
        kicker: T('pricing.kicker'), title: T('pricing.title'), lead: T('pricing.lead'), btn_label: T('pricing.btn'), btn_href: '/signup', note: T('pricing.note'),
      } },
      { id: 'faq', type: 'faq', anchor: 'faq', hidden: false, data: {
        kicker: T('faq.kicker'), title: T('faq.title'), lead: T('faq.lead'),
        items: [1, 2, 3, 4, 5, 6, 7, 8, ...NEW_FAQ].map((i) => ({ q: T(`faq.q${i}`), a: T(`faq.a${i}`) })),
      } },
      { id: 'cta', type: 'cta', anchor: 'start', hidden: false, data: {
        title: T('cta.title'), text: T('cta.text'), btn1_label: T('nav.signup'), btn1_href: '/signup', btn2_label: T('nav.login'), btn2_href: '/login',
      } },
    ],
    footer: {
      tagline: T('footer.tagline'), col1_title: T('footer.col1'), col2_title: T('footer.col2'), col3_title: { ar: '', en: '' },
      email: brand.supportEmail || '', phone: '', address: { ar: '', en: '' }, copyright: brand.name,
      items: [
        ...[['new', '/#new'], ['features', '/#features'], ['pricing', '/pricing'], ['how', '/#how'], ['roles', '/#roles'], ['faq', '/#faq']].map(([k, href]) => ({ label: T(`nav.${k}`), href, column: '1' })),
        ...[['login', '/login'], ['signup', '/signup'], ['reps_signup', '/vendors/signup'], ['forgot', '/forgot']].map(([k, href]) => ({ label: T(`nav.${k}`), href, column: '2' })),
      ],
      social: [],
    },
    seo: { title: T('seo.title'), description: T('seo.description') },
  };
}

// ---------------------------------------------------------------- reading
/** Adds the cards / features / questions of the revisions after `from` to a page the platform already edited (not saved until the next edit). */
function mergeNew(saved, d, from = 0) {
  const v = structuredClone(saved);
  const en = (x) => String((x && (x.en || x.ar)) || '').trim();
  const revs = Object.keys(ADDED).map(Number).filter((r) => r > from);
  const of = (part) => revs.flatMap((r) => ADDED[r][part]);
  const fresh = {
    showcase: { first: true, id: (it) => en(it.title), keys: new Set(of('showcase').map(([k]) => en(translatorPair(`showcase.items.${k}.title`)))) },
    features: { first: false, id: (it) => en(it.title), keys: new Set(of('features').map(([k]) => en(translatorPair(`features.items.${k}.title`)))) },
    faq: { first: false, id: (it) => en(it.q), keys: new Set(of('faq').map((i) => en(translatorPair(`faq.q${i}`)))) },
  };
  for (const ds of d.sections) {
    const rule = fresh[ds.type];
    if (!rule) continue; // eslint-disable-line no-continue
    const target = v.sections.find((x) => x && x.type === ds.type && !x.hidden);
    if (!target || !target.data || !Array.isArray(target.data.items)) continue; // eslint-disable-line no-continue
    const have = new Set(target.data.items.map(rule.id));
    const add = ds.data.items.filter((it) => rule.keys.has(rule.id(it)) && !have.has(rule.id(it)));
    target.data.items = rule.first ? [...add, ...target.data.items] : [...target.data.items, ...add];
  }
  return v;
}
const translatorPair = (k) => ({ en: translator('en')(`site.d.${k}`), ar: translator('ar')(`site.d.${k}`) });

function normalise(v) {
  const d = defaults();
  if (!v || !Array.isArray(v.sections)) return d;
  if ((Number(v.rev) || 0) < REV) v = mergeNew(v, d, Number(v.rev) || 0);
  return {
    version: 1,
    rev: REV,
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
  if (kind === 'media') return /^\d{1,10}$/.test(String(raw ?? '')) ? String(raw) : '';
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

/** Design fields arrive as d_<key> (d_<key>_ar / d_<key>_en for texts). */
function parseDesign(body) {
  const out = {};
  for (const f of DESIGN) out[f[0]] = parseValue(body[`d_${f[0]}`], f, body[`d_${f[0]}_ar`], body[`d_${f[0]}_en`]);
  return out;
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
  s.design = parseDesign(body);
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
  ICONS, TYPES, DESIGN, HEADER, FOOTER, SEO, BLOCKS, VISUALS, parseDesign, isI18n, defaults, get, isCustomised, reset, safeHref, pick,
  updateSection, updateBlock, addSection, removeSection, moveSection, toggleSection, duplicateSection, parseSchema,
};
