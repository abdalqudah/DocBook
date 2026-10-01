// Website sections (DocBook 2.0 redesign 4.5): the healthcare section types a clinic page is built from, their
// fields, the starting layout of each template, and the sanitiser every draft goes through.
//
// A section in a draft/published document:
//   { id, type, variant, visible, content: { ar: {…}, en: {…} }, settings: {…} }
// • content = the clinic's own words (plain text only — never HTML; the page escapes everything);
// • settings = presentation choices and references (media ids from the clinic's library, doctor ids);
// • clinic facts — doctors, services, prices, hours, insurers, reviews, address — are NOT stored here: the page reads
//   them live, so a new doctor or price shows without republishing.
const crypto = require('crypto');
const { THEMES, TEMPLATES } = require('./catalog');

const ICONS = ['stethoscope', 'heart-pulse', 'shield-check', 'clock', 'star', 'smile', 'baby', 'award', 'hospital', 'syringe', 'pill', 'thermometer', 'activity', 'badge-check', 'calendar-check', 'map-pin', 'phone', 'users', 'sparkles', 'hand-coins',
  'heart', 'hand-heart', 'leaf', 'flower-2', 'sun-medium', 'brain', 'baby', 'ruler', 'droplet', 'zap', 'wand-sparkles'].filter((x, i, a) => a.indexOf(x) === i);

// What a button inside a section does (never a free address: links stay on the clinic's own actions).
const ACTIONS = ['none', 'book', 'call', 'whatsapp', 'directions'];
// Look of every section (settings.style): alignment, background, spacing, width and a decorative shape at its edges.
const SHAPES = ['none', 'wave', 'curve', 'slant', 'zigzag', 'peaks', 'drops'];
const STYLE = [
  { key: 'align', kind: 'select', options: ['auto', 'start', 'center', 'end'], def: 'auto' },
  { key: 'bg', kind: 'select', options: ['auto', 'none', 'soft', 'accent', 'brand', 'dark', 'image'], def: 'auto' },
  { key: 'bg_image', kind: 'media' },
  { key: 'overlay', kind: 'select', options: ['dark', 'light', 'brand', 'none'], def: 'dark' },
  { key: 'spacing', kind: 'select', options: ['normal', 'compact', 'roomy', 'none'], def: 'normal' },
  { key: 'width', kind: 'select', options: ['normal', 'narrow', 'wide'], def: 'normal' },
  { key: 'shape_top', kind: 'select', options: SHAPES, def: 'none' },
  { key: 'shape_bottom', kind: 'select', options: SHAPES, def: 'none' },
  { key: 'anim', kind: 'select', options: ['auto', 'none', 'fade', 'up', 'zoom', 'side'], def: 'auto' },
];
const MOTION = ['none', 'subtle', 'lively'];
// Image options of a section that shows one picture.
const IMAGE_OPTS = [
  { key: 'image_shape', kind: 'select', options: ['rounded', 'square', 'circle', 'arch', 'blob'], def: 'rounded', group: 'image' },
  { key: 'image_fit', kind: 'select', options: ['cover', 'contain'], def: 'cover', group: 'image' },
  { key: 'image_ratio', kind: 'select', options: ['auto', 'landscape', 'square', 'portrait'], def: 'auto', group: 'image' },
];

// kinds — text (one line), textarea, bool, select, number, media (one image), media_list, doctors (ids), date, icon
const TYPES = {
  hero: { icon: 'panel-top', variants: ['split', 'full', 'centered', 'image_back', 'slider'], single: true,
    text: [{ key: 'headline', max: 120 }, { key: 'subtext', kind: 'textarea', max: 400 }, { key: 'button', max: 40 }],
    settings: [{ key: 'image', kind: 'media' }, ...IMAGE_OPTS, { key: 'height', kind: 'select', options: ['auto', 'tall', 'screen'], def: 'auto' },
      { key: 'interval', kind: 'select', options: ['s5', 's4', 's7', 's10'], def: 's5', only: 'slider' }, { key: 'transition', kind: 'select', options: ['fade', 'slide', 'zoom'], def: 'fade', only: 'slider' },
      { key: 'show_call', kind: 'bool', def: true }, { key: 'show_whatsapp', kind: 'bool', def: true }, { key: 'show_directions', kind: 'bool', def: true }],
    // Slides of the "slider" layout: a picture each, with its own headline and line (else the hero's own words).
    list: { key: 'slides', max: 6, only: 'slider', fields: [{ key: 'image', kind: 'media', i18n: false }, { key: 'headline', max: 120 }, { key: 'subtext', kind: 'textarea', max: 300 }] } },
  about: { icon: 'align-left', variants: ['text', 'image_side'], single: true,
    text: [{ key: 'title', max: 80 }, { key: 'text', kind: 'textarea', max: 3000 }],
    settings: [{ key: 'image', kind: 'media' }, ...IMAGE_OPTS] },
  doctors: { icon: 'stethoscope', variants: ['grid', 'list'], single: true,
    text: [{ key: 'title', max: 80 }, { key: 'intro', kind: 'textarea', max: 300 }],
    settings: [{ key: 'mode', kind: 'select', options: ['all', 'selected'], def: 'all' }, { key: 'doctor_ids', kind: 'doctors' }, { key: 'show_fee', kind: 'bool', def: true }] },
  services: { icon: 'clipboard-list', variants: ['cards', 'list'], single: true,
    text: [{ key: 'title', max: 80 }, { key: 'intro', kind: 'textarea', max: 300 }],
    settings: [{ key: 'show_prices', kind: 'bool', def: true }, { key: 'group', kind: 'bool', def: true }] },
  booking_cta: { icon: 'calendar-plus', variants: ['band', 'card'],
    text: [{ key: 'title', max: 120 }, { key: 'text', kind: 'textarea', max: 300 }, { key: 'button', max: 40 }], settings: [] },
  gallery: { icon: 'images', variants: ['grid', 'strip'], single: true,
    text: [{ key: 'title', max: 80 }], settings: [{ key: 'images', kind: 'media_list', max: 12 }] },
  reviews: { icon: 'star', variants: ['cards'], single: true,
    text: [{ key: 'title', max: 80 }], settings: [{ key: 'max', kind: 'number', min: 3, max: 12, def: 6 }] },
  faq: { icon: 'circle-help', variants: ['accordion'], single: true,
    text: [{ key: 'title', max: 80 }], settings: [],
    list: { key: 'items', max: 20, fields: [{ key: 'q', max: 200 }, { key: 'a', kind: 'textarea', max: 1500 }] } },
  insurance: { icon: 'shield-plus', variants: ['chips'], single: true,
    text: [{ key: 'title', max: 80 }, { key: 'note', kind: 'textarea', max: 300 }], settings: [] },
  contact: { icon: 'map-pin', variants: ['card', 'split'], single: true,
    text: [{ key: 'title', max: 80 }], settings: [{ key: 'show_map', kind: 'bool', def: true }, { key: 'show_hours', kind: 'bool', def: true }] },
  hours: { icon: 'clock', variants: ['table'], single: true, text: [{ key: 'title', max: 80 }], settings: [] },
  features: { icon: 'award', variants: ['grid'],
    text: [{ key: 'title', max: 80 }], settings: [],
    list: { key: 'items', max: 6, fields: [{ key: 'icon', kind: 'icon', i18n: false }, { key: 'title', max: 80 }, { key: 'text', kind: 'textarea', max: 300 }] } },
  announcement: { icon: 'megaphone', variants: ['info', 'highlight'],
    text: [{ key: 'text', kind: 'textarea', max: 300 }], settings: [{ key: 'from', kind: 'date' }, { key: 'to', kind: 'date' }] },
  // Free building blocks: the clinic's own words and pictures, laid out in different ways.
  cards: { icon: 'layout-grid', variants: ['grid', 'list', 'overlay', 'minimal'], group: 'blocks',
    text: [{ key: 'title', max: 80 }, { key: 'intro', kind: 'textarea', max: 300 }],
    settings: [{ key: 'media', kind: 'select', options: ['mixed', 'images', 'icons', 'none'], def: 'mixed' }, { key: 'columns', kind: 'select', options: ['3', '2', '4'], def: '3' }, { key: 'card_style', kind: 'select', options: ['shadow', 'outline', 'filled', 'plain'], def: 'shadow' },
      { key: 'image_ratio', kind: 'select', options: ['landscape', 'square', 'portrait'], def: 'landscape', group: 'image' }],
    list: { key: 'items', max: 12, fields: [{ key: 'icon', kind: 'icon', i18n: false, none: true }, { key: 'image', kind: 'media', i18n: false }, { key: 'action', kind: 'select', options: ACTIONS, i18n: false },
      { key: 'title', max: 80 }, { key: 'text', kind: 'textarea', max: 400 }, { key: 'button', max: 40 }] } },
  image_text: { icon: 'image', variants: ['image_start', 'image_end', 'image_top', 'image_back'], group: 'blocks',
    text: [{ key: 'title', max: 120 }, { key: 'text', kind: 'textarea', max: 2000 }, { key: 'button', max: 40 }],
    settings: [{ key: 'image', kind: 'media' }, ...IMAGE_OPTS, { key: 'action', kind: 'select', options: ACTIONS, def: 'book' }] },
  text: { icon: 'type', variants: ['plain', 'boxed', 'quote', 'columns'], group: 'blocks',
    text: [{ key: 'title', max: 120 }, { key: 'text', kind: 'textarea', max: 5000 }], settings: [] },
  stats: { icon: 'chart-no-axes-column', variants: ['row', 'cards'], group: 'blocks',
    text: [{ key: 'title', max: 80 }], settings: [],
    list: { key: 'items', max: 6, fields: [{ key: 'value', max: 16, i18n: false }, { key: 'label', max: 80 }] } },
  steps: { icon: 'list-ordered', variants: ['numbered', 'timeline'], group: 'blocks',
    text: [{ key: 'title', max: 80 }, { key: 'intro', kind: 'textarea', max: 300 }], settings: [],
    list: { key: 'items', max: 8, fields: [{ key: 'title', max: 80 }, { key: 'text', kind: 'textarea', max: 400 }] } },
  divider: { icon: 'waves', variants: ['shape'], group: 'blocks', text: [],
    settings: [{ key: 'shape', kind: 'select', options: ['wave', 'curve', 'slant', 'zigzag', 'peaks', 'drops', 'line', 'dots', 'space'], def: 'wave' },
      { key: 'color', kind: 'select', options: ['soft', 'accent', 'brand', 'dark'], def: 'soft' }, { key: 'height', kind: 'select', options: ['s', 'm', 'l'], def: 'm' }, { key: 'flip', kind: 'bool', def: false }] },
};
const TYPE_KEYS = Object.keys(TYPES);
const MAX_SECTIONS = 24;

// The starting layout and look of each template (the clinic can change everything afterwards).
const TEMPLATE_LAYOUT = {
  general: { theme: 'calm', sections: ['hero', 'doctors', 'services', 'about', 'reviews', 'gallery', 'contact'] },
  dental: { theme: 'clinical', sections: ['hero', 'services', 'doctors', 'features', 'reviews', 'gallery', 'faq', 'contact'] },
  dermatology: { theme: 'minimal', sections: ['hero', 'services', 'gallery', 'doctors', 'reviews', 'faq', 'contact'] },
  aesthetic: { theme: 'warm', sections: ['hero', 'services', 'gallery', 'doctors', 'reviews', 'faq', 'contact'] },
  pediatrics: { theme: 'warm', sections: ['hero', 'doctors', 'services', 'features', 'reviews', 'hours', 'contact'] },
  gynecology: { theme: 'calm', sections: ['hero', 'doctors', 'services', 'about', 'faq', 'reviews', 'contact'] },
  physio: { theme: 'bold', sections: ['hero', 'services', 'features', 'doctors', 'reviews', 'contact'] },
  medical_center: { theme: 'clinical', sections: ['hero', 'services', 'doctors', 'insurance', 'reviews', 'hours', 'contact'] },
  multi_specialty: { theme: 'clinical', sections: ['hero', 'doctors', 'services', 'insurance', 'reviews', 'gallery', 'contact'] },
  individual_doctor: { theme: 'minimal', sections: ['hero', 'about', 'services', 'reviews', 'faq', 'contact'] },
};
// The clinic's specialty (settings) → the template offered first.
const SPECIALTY_TEMPLATE = { general: 'general', dentistry: 'dental', dermatology: 'dermatology', paediatrics: 'pediatrics', obgyn: 'gynecology', physiotherapy: 'physio', cosmetic: 'aesthetic', multi: 'multi_specialty' };

const FONTS = ['system', 'humanist', 'serif', 'rounded'];
const RADII = ['soft', 'rounded', 'square'];
const HEX = /^#[0-9a-fA-F]{6}$/;

const newId = () => crypto.randomBytes(5).toString('hex');
// Plain text: no control characters, no markup brackets turned into anything — the page escapes on output anyway.
const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const cleanLine = (v, max) => clean(v, max).replace(/\s*\n\s*/g, ' ');
const ids = (v) => [...new Set([].concat(v === undefined || v === null ? [] : v).flatMap((x) => String(x).split(',')).map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0))];

function blankSection(type) {
  const def = TYPES[type];
  const settings = {};
  for (const f of def.settings) {
    if (f.def !== undefined) settings[f.key] = f.def;
    else settings[f.key] = f.kind === 'media_list' || f.kind === 'doctors' ? [] : null;
  }
  const content = { ar: {}, en: {} };
  if (def.list) { content.ar[def.list.key] = []; content.en[def.list.key] = []; if (!def.list.fields.every((f) => f.i18n !== false)) settings[def.list.key] = []; }
  settings.style = cleanStyle({});
  return { id: newId(), type, variant: def.variants[0], visible: true, content, settings };
}

/** A starting document for a template (and optional brand defaults from the clinic). */
function defaultDoc(template = 'general', { logoMediaId = null, cover = null, gallery = [] } = {}) {
  const t = TEMPLATE_LAYOUT[template] ? template : 'general';
  const sections = TEMPLATE_LAYOUT[t].sections.map(blankSection);
  // Keep what the clinic already chose for its page: the cover becomes the hero image, the gallery the gallery.
  const hero = sections.find((s) => s.type === 'hero'); if (hero && cover) hero.settings.image = cover;
  const gal = sections.find((s) => s.type === 'gallery'); if (gal && gallery.length) gal.settings.images = gallery.slice(0, 12);
  return {
    template: t, theme: TEMPLATE_LAYOUT[t].theme,
    brand: { primary: null, secondary: null, font: 'system', radius: 'rounded', motion: 'subtle', logoMediaId, faviconMediaId: null },
    pages: [{ key: 'home', sections }],
    seo: { title: { ar: '', en: '' }, description: { ar: '', en: '' } },
  };
}

function cleanText(def, raw) {
  const out = {};
  for (const lang of ['ar', 'en']) {
    const src = (raw && raw[lang]) || {};
    out[lang] = {};
    for (const f of def.text) out[lang][f.key] = f.kind === 'textarea' ? clean(src[f.key], f.max) : cleanLine(src[f.key], f.max);
    if (def.list) {
      const rawItems = src[def.list.key];
      const items = Array.isArray(rawItems) ? rawItems : (rawItems && typeof rawItems === 'object' ? Object.values(rawItems) : []);
      out[lang][def.list.key] = items.slice(0, def.list.max).map((it) => Object.fromEntries(def.list.fields.filter((f) => f.i18n !== false)
        .map((f) => [f.key, f.kind === 'textarea' ? clean(it && it[f.key], f.max) : cleanLine(it && it[f.key], f.max)])));
    }
  }
  return out;
}

/** One setting value of kind bool/select/number/media/media_list/doctors/date/icon/text. */
function cleanValue(f, v, refs = {}) {
  const okMedia = (id) => !refs.media || refs.media.has(id);
  const okDoctor = (id) => !refs.doctors || refs.doctors.has(id);
  // A checkbox posts with a hidden "0" before it: the last value wins.
  if (Array.isArray(v) && ['bool', 'select', 'number', 'date', 'media', 'icon', 'text'].includes(f.kind || 'text')) v = v[v.length - 1];
  switch (f.kind) {
    case 'bool': return v === undefined ? f.def : v === true || v === '1' || v === 'on' || v === 'true';
    case 'select': return f.options.includes(v) ? v : (f.def !== undefined ? f.def : f.options[0]);
    case 'number': { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.def; }
    case 'media': { const id = ids(v)[0] || null; return id && okMedia(id) ? id : null; }
    case 'media_list': return ids(v).filter(okMedia).slice(0, f.max || 12);
    case 'doctors': return ids(v).filter(okDoctor).slice(0, 50);
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
    case 'icon': return (f.none && v === 'none') ? 'none' : (ICONS.includes(v) ? v : ICONS[0]);
    default: return cleanLine(v, f.max || 80);
  }
}

/** The look of a section (alignment, background, spacing, width, shapes). */
function cleanStyle(raw, refs = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(STYLE.map((f) => [f.key, cleanValue(f, src[f.key], refs)]));
}

function cleanSettings(def, raw = {}, refs = {}) {
  const out = {};
  for (const f of def.settings) out[f.key] = cleanValue(f, raw[f.key], refs);
  // List fields that are not translated (an icon, a picture, a button action, a number) live in settings[listKey][i].
  if (def.list && def.list.fields.some((f) => f.i18n === false)) {
    const items = Array.isArray(raw[def.list.key]) ? raw[def.list.key] : (raw[def.list.key] && typeof raw[def.list.key] === 'object' ? Object.values(raw[def.list.key]) : []);
    out[def.list.key] = items.slice(0, def.list.max).map((it) => Object.fromEntries(def.list.fields.filter((f) => f.i18n === false)
      .map((f) => [f.key, cleanValue(f, it && it[f.key], refs)])));
  }
  out.style = cleanStyle(raw.style, refs);
  return out;
}

/**
 * Normalises a whole document: unknown types, fields, media or doctors that are not the clinic's are dropped;
 * text is plain and length-limited. refs = { media: Set<id>, doctors: Set<id> } of the clinic (optional).
 */
function sanitize(doc, refs = {}) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const b = d.brand || {};
  const page = (Array.isArray(d.pages) && d.pages.find((p) => p && p.key === 'home')) || { sections: [] };
  const seen = new Set();
  const sections = (Array.isArray(page.sections) ? page.sections : []).filter((s) => s && TYPES[s.type]).slice(0, MAX_SECTIONS).map((s) => {
    const def = TYPES[s.type];
    let id = /^[a-f0-9]{10}$/.test(String(s.id || '')) ? s.id : newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    return { id, type: s.type, variant: def.variants.includes(s.variant) ? s.variant : def.variants[0], visible: s.visible !== false, content: cleanText(def, s.content), settings: cleanSettings(def, s.settings || {}, refs) };
  });
  const mediaOk = (v) => { const id = ids(v)[0] || null; return id && (!refs.media || refs.media.has(id)) ? id : null; };
  const seo = d.seo || {};
  return {
    template: TEMPLATES.includes(d.template) ? d.template : 'general',
    theme: THEMES.includes(d.theme) ? d.theme : 'calm',
    brand: {
      primary: HEX.test(b.primary || '') ? b.primary.toLowerCase() : null,
      secondary: HEX.test(b.secondary || '') ? b.secondary.toLowerCase() : null,
      font: FONTS.includes(b.font) ? b.font : 'system',
      radius: RADII.includes(b.radius) ? b.radius : 'rounded',
      motion: MOTION.includes(b.motion) ? b.motion : 'none', // sites published before motion existed stay still
      logoMediaId: mediaOk(b.logoMediaId), faviconMediaId: mediaOk(b.faviconMediaId),
    },
    pages: [{ key: 'home', sections }],
    seo: {
      title: { ar: cleanLine(seo.title && seo.title.ar, 70), en: cleanLine(seo.title && seo.title.en, 70) },
      description: { ar: cleanLine(seo.description && seo.description.ar, 160), en: cleanLine(seo.description && seo.description.en, 160) },
      image: mediaOk(seo.image), // share image (advanced search settings)
      hide: seo.hide === true || seo.hide === '1', // ask search engines not to list the site (advanced)
    },
  };
}

/** Every media id a document uses (hero/about images, gallery, brand logo/favicon). */
function mediaIn(doc) {
  const out = new Set();
  const b = (doc && doc.brand) || {};
  if (b.logoMediaId) out.add(b.logoMediaId);
  if (b.faviconMediaId) out.add(b.faviconMediaId);
  if (doc && doc.seo && doc.seo.image) out.add(doc.seo.image);
  for (const p of (doc && doc.pages) || []) for (const s of p.sections || []) {
    const def = TYPES[s.type]; if (!def) continue;
    for (const f of def.settings) {
      if (f.kind === 'media' && s.settings[f.key]) out.add(s.settings[f.key]);
      if (f.kind === 'media_list') (s.settings[f.key] || []).forEach((id) => out.add(id));
    }
    if (s.settings.style && s.settings.style.bg_image) out.add(s.settings.style.bg_image);
    if (def.list) for (const f of def.list.fields.filter((x) => x.i18n === false && x.kind === 'media')) (s.settings[def.list.key] || []).forEach((it) => { if (it && it[f.key]) out.add(it[f.key]); });
  }
  return [...out];
}

module.exports = { TYPES, TYPE_KEYS, TEMPLATE_LAYOUT, SPECIALTY_TEMPLATE, FONTS, RADII, ICONS, ACTIONS, STYLE, SHAPES, MOTION, MAX_SECTIONS, blankSection, defaultDoc, sanitize, mediaIn, newId, cleanStyle };
