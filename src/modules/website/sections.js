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

const ICONS = ['stethoscope', 'heart-pulse', 'shield-check', 'clock', 'star', 'smile', 'baby', 'award', 'hospital', 'syringe', 'pill', 'thermometer', 'activity', 'badge-check', 'calendar-check', 'map-pin', 'phone', 'users', 'sparkles', 'hand-coins'];

// kinds — text (one line), textarea, bool, select, number, media (one image), media_list, doctors (ids), date, icon
const TYPES = {
  hero: { icon: 'panel-top', variants: ['split', 'full', 'centered'], single: true,
    text: [{ key: 'headline', max: 120 }, { key: 'subtext', kind: 'textarea', max: 400 }, { key: 'button', max: 40 }],
    settings: [{ key: 'image', kind: 'media' }, { key: 'show_call', kind: 'bool', def: true }, { key: 'show_whatsapp', kind: 'bool', def: true }, { key: 'show_directions', kind: 'bool', def: true }] },
  about: { icon: 'align-left', variants: ['text', 'image_side'], single: true,
    text: [{ key: 'title', max: 80 }, { key: 'text', kind: 'textarea', max: 3000 }],
    settings: [{ key: 'image', kind: 'media' }] },
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
    brand: { primary: null, secondary: null, font: 'system', radius: 'rounded', logoMediaId, faviconMediaId: null },
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
      const items = Array.isArray(src[def.list.key]) ? src[def.list.key] : [];
      out[lang][def.list.key] = items.slice(0, def.list.max).map((it) => Object.fromEntries(def.list.fields.filter((f) => f.i18n !== false)
        .map((f) => [f.key, f.kind === 'textarea' ? clean(it && it[f.key], f.max) : cleanLine(it && it[f.key], f.max)])));
    }
  }
  return out;
}

function cleanSettings(def, raw = {}, refs = {}) {
  const out = {};
  const okMedia = (id) => !refs.media || refs.media.has(id);
  const okDoctor = (id) => !refs.doctors || refs.doctors.has(id);
  for (const f of def.settings) {
    let v = raw[f.key];
    // A checkbox posts with a hidden "0" before it: the last value wins.
    if (Array.isArray(v) && ['bool', 'select', 'number', 'date', 'media'].includes(f.kind)) v = v[v.length - 1];
    if (f.kind === 'bool') out[f.key] = v === undefined ? f.def : v === true || v === '1' || v === 'on' || v === 'true';
    else if (f.kind === 'select') out[f.key] = f.options.includes(v) ? v : f.def;
    else if (f.kind === 'number') { const n = Math.round(Number(v)); out[f.key] = Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.def; }
    else if (f.kind === 'media') { const id = ids(v)[0] || null; out[f.key] = id && okMedia(id) ? id : null; }
    else if (f.kind === 'media_list') out[f.key] = ids(v).filter(okMedia).slice(0, f.max || 12);
    else if (f.kind === 'doctors') out[f.key] = ids(v).filter(okDoctor).slice(0, 50);
    else if (f.kind === 'date') out[f.key] = /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
  }
  // List fields that are not translated (e.g. a feature's icon) live in settings[listKey][i].
  if (def.list && def.list.fields.some((f) => f.i18n === false)) {
    const items = Array.isArray(raw[def.list.key]) ? raw[def.list.key] : [];
    out[def.list.key] = items.slice(0, def.list.max).map((it) => Object.fromEntries(def.list.fields.filter((f) => f.i18n === false)
      .map((f) => [f.key, f.kind === 'icon' ? (ICONS.includes(it && it[f.key]) ? it[f.key] : ICONS[0]) : cleanLine(it && it[f.key], f.max || 80)])));
  }
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
      logoMediaId: mediaOk(b.logoMediaId), faviconMediaId: mediaOk(b.faviconMediaId),
    },
    pages: [{ key: 'home', sections }],
    seo: {
      title: { ar: cleanLine(seo.title && seo.title.ar, 70), en: cleanLine(seo.title && seo.title.en, 70) },
      description: { ar: cleanLine(seo.description && seo.description.ar, 160), en: cleanLine(seo.description && seo.description.en, 160) },
    },
  };
}

/** Every media id a document uses (hero/about images, gallery, brand logo/favicon). */
function mediaIn(doc) {
  const out = new Set();
  const b = (doc && doc.brand) || {};
  if (b.logoMediaId) out.add(b.logoMediaId);
  if (b.faviconMediaId) out.add(b.faviconMediaId);
  for (const p of (doc && doc.pages) || []) for (const s of p.sections || []) {
    const def = TYPES[s.type]; if (!def) continue;
    for (const f of def.settings) {
      if (f.kind === 'media' && s.settings[f.key]) out.add(s.settings[f.key]);
      if (f.kind === 'media_list') (s.settings[f.key] || []).forEach((id) => out.add(id));
    }
  }
  return [...out];
}

module.exports = { TYPES, TYPE_KEYS, TEMPLATE_LAYOUT, SPECIALTY_TEMPLATE, FONTS, RADII, ICONS, MAX_SECTIONS, blankSection, defaultDoc, sanitize, mediaIn, newId };
