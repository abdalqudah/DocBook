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

// Icons a section may use: the common set and every specialty library (icon-library.js; the dental set is DocBook's own).
const ICONS = require('./icon-library').ALL;

// What a button inside a section does (never a free address: links stay on the clinic's own actions).
// page = open one of the site's own pages (chosen in the "page" field next to it).
const ACTIONS = ['none', 'book', 'call', 'whatsapp', 'directions', 'page'];
const PAGE_LINK = { key: 'page', kind: 'page', i18n: false };
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
  { key: 'anim', kind: 'select', options: ['auto', 'none', 'fade', 'up', 'zoom', 'side', 'blur', 'flip', 'stagger'], def: 'auto' },
];
const MOTION = ['none', 'subtle', 'lively'];
// Image options of a section that shows one picture.
const IMAGE_OPTS = [
  { key: 'image_shape', kind: 'select', options: ['rounded', 'square', 'circle', 'arch', 'blob'], def: 'rounded', group: 'image' },
  { key: 'image_fit', kind: 'select', options: ['cover', 'contain'], def: 'cover', group: 'image' },
  { key: 'image_ratio', kind: 'select', options: ['auto', 'landscape', 'square', 'portrait'], def: 'auto', group: 'image' },
];

// Carousel (Design tab): the section's items slide in one row instead of a grid — how many show at once, which way
// they travel (auto = the page language: Arabic moves right, English moves left), the pause between slides.
const CAROUSEL = [
  { key: 'carousel', kind: 'bool', def: false, group: 'carousel' },
  { key: 'per_view', kind: 'select', options: ['3', '1', '2', '4', '5', '6'], def: '3', group: 'carousel' },
  { key: 'car_dir', kind: 'select', options: ['auto', 'left', 'right'], def: 'auto', group: 'carousel' },
  { key: 'autoplay', kind: 'select', options: ['s4', 's3', 's6', 'off'], def: 's4', group: 'carousel' },
  { key: 'arrows', kind: 'bool', def: true, group: 'carousel' },
];
// The section types whose items can be a carousel.
const CAROUSEL_TYPES = ['cards', 'doctors', 'reviews', 'services', 'features', 'gallery', 'images', 'columns', 'stats', 'steps', 'partners', 'team', 'before_after', 'testimonials'];

// kinds — text (one line), textarea, bool, select, number, media (one image), media_list, doctors (ids), date, icon
const TYPES = {
  hero: { icon: 'panel-top', variants: ['split', 'full', 'centered', 'image_back', 'slider'], single: true,
    text: [{ key: 'headline', max: 120 }, { key: 'subtext', kind: 'textarea', max: 400 }, { key: 'button', max: 40 }],
    settings: [{ key: 'image', kind: 'media' }, ...IMAGE_OPTS, { key: 'height', kind: 'select', options: ['auto', 'tall', 'screen'], def: 'auto' },
      { key: 'content_x', kind: 'select', options: ['start', 'center', 'end'], def: 'start', group: 'buttons' },
      { key: 'content_y', kind: 'select', options: ['middle', 'top', 'bottom'], def: 'middle', group: 'buttons' },
      { key: 'btn_size', kind: 'select', options: ['l', 'm', 's'], def: 'l', group: 'buttons' },
      { key: 'btn_layout', kind: 'select', options: ['row', 'stack'], def: 'row', group: 'buttons' },
      { key: 'interval', kind: 'select', options: ['s5', 's4', 's7', 's10'], def: 's5', only: 'slider' },
      { key: 'transition', kind: 'select', options: ['fade', 'slide', 'zoom', 'kenburns', 'wipe', 'blur', 'rise', 'flip', 'curtain'], def: 'fade', only: 'slider' },
      { key: 'text_anim', kind: 'select', options: ['up', 'fade', 'zoom', 'none'], def: 'up', only: 'slider' },
      { key: 'indicators', kind: 'select', options: ['dots', 'lines', 'numbers', 'none'], def: 'dots', only: 'slider' },
      { key: 'arrows_style', kind: 'select', options: ['circle', 'square', 'minimal', 'none'], def: 'circle', only: 'slider' },
      { key: 'progress', kind: 'bool', def: false, only: 'slider' }, { key: 'pause_hover', kind: 'bool', def: true, only: 'slider' },
      // Words over the pictures: all of them, the headline only, or none (the pictures alone); each slide may differ.
      { key: 'slide_text', kind: 'select', options: ['txt_all', 'txt_title', 'txt_none'], def: 'txt_all', only: 'slider' },
      { key: 'slide_buttons', kind: 'bool', def: true, only: 'slider' },
      { key: 'show_call', kind: 'bool', def: true }, { key: 'show_whatsapp', kind: 'bool', def: true }, { key: 'show_directions', kind: 'bool', def: true }],
    // Slides of the "slider" layout: a picture each, with its own headline and line (else the hero's own words).
    list: { key: 'slides', max: 6, only: 'slider', fields: [{ key: 'image', kind: 'media', i18n: false }, { key: 'text_mode', kind: 'select', options: ['txt_follow', 'txt_all', 'txt_title', 'txt_none'], i18n: false }, { key: 'headline', max: 120 }, { key: 'subtext', kind: 'textarea', max: 300 }] } },
  about: { icon: 'align-left', variants: ['text', 'image_side'], single: true,
    text: [{ key: 'title', max: 80 }, { key: 'text', kind: 'textarea', max: 3000 }],
    settings: [{ key: 'image', kind: 'media' }, ...IMAGE_OPTS] },
  // cards = a profile card each (large photo, name, specialty, social profiles, booking); grid / list = compact rows.
  doctors: { icon: 'stethoscope', variants: ['cards', 'grid', 'list'], single: true,
    text: [{ key: 'title', max: 80 }, { key: 'intro', kind: 'textarea', max: 300 }],
    settings: [{ key: 'mode', kind: 'select', options: ['all', 'selected'], def: 'all' }, { key: 'doctor_ids', kind: 'doctors' }, { key: 'show_fee', kind: 'bool', def: true },
      { key: 'show_social', kind: 'bool', def: true }, { key: 'show_bio', kind: 'bool', def: true },
      { key: 'columns', kind: 'select', options: ['3', '2', '4'], def: '3', only: 'cards' },
      { key: 'photo_ratio', kind: 'select', options: ['portrait', 'square', 'landscape'], def: 'portrait', group: 'image', only: 'cards' }] },
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
    list: { key: 'items', max: 12, fields: [{ key: 'icon', kind: 'icon', i18n: false, none: true }, { key: 'image', kind: 'media', i18n: false }, { key: 'action', kind: 'select', options: ACTIONS, i18n: false }, PAGE_LINK,
      { key: 'title', max: 80 }, { key: 'text', kind: 'textarea', max: 400 }, { key: 'button', max: 40 }] } },
  image_text: { icon: 'image', variants: ['image_start', 'image_end', 'image_top', 'image_back'], group: 'blocks',
    text: [{ key: 'title', max: 120 }, { key: 'text', kind: 'textarea', max: 2000 }, { key: 'button', max: 40 }],
    settings: [{ key: 'image', kind: 'media' }, ...IMAGE_OPTS, { key: 'action', kind: 'select', options: ACTIONS, def: 'book' }, { key: 'page', kind: 'page' }] },
  text: { icon: 'type', variants: ['plain', 'boxed', 'quote', 'columns'], group: 'blocks',
    text: [{ key: 'title', max: 120 }, { key: 'text', kind: 'textarea', max: 5000 }], settings: [] },
  stats: { icon: 'chart-no-axes-column', variants: ['row', 'cards'], group: 'blocks',
    text: [{ key: 'title', max: 80 }], settings: [],
    list: { key: 'items', max: 6, fields: [{ key: 'value', max: 16, i18n: false }, { key: 'label', max: 80 }] } },
  steps: { icon: 'list-ordered', variants: ['numbered', 'timeline'], group: 'blocks',
    text: [{ key: 'title', max: 80 }, { key: 'intro', kind: 'textarea', max: 300 }], settings: [],
    list: { key: 'items', max: 8, fields: [{ key: 'title', max: 80 }, { key: 'text', kind: 'textarea', max: 400 }] } },
  // A picture block: 2, 3 or 4 pictures per row, each with an optional caption.
  images: { icon: 'images', variants: ['grid', 'framed', 'tight'], group: 'blocks',
    text: [{ key: 'title', max: 80 }, { key: 'intro', kind: 'textarea', max: 300 }],
    settings: [{ key: 'columns', kind: 'select', options: ['3', '2', '4'], def: '3' },
      { key: 'image_ratio', kind: 'select', options: ['landscape', 'square', 'portrait', 'auto'], def: 'landscape', group: 'image' },
      { key: 'image_fit', kind: 'select', options: ['cover', 'contain'], def: 'cover', group: 'image' }],
    list: { key: 'items', max: 12, fields: [{ key: 'image', kind: 'media', i18n: false }, { key: 'caption', max: 120 }] } },
  // Columns of content side by side (2, 3 or 4): an optional picture or icon, a title, text and a button each.
  columns: { icon: 'columns-2', variants: ['plain', 'boxed', 'divided'], group: 'blocks',
    text: [{ key: 'title', max: 80 }, { key: 'intro', kind: 'textarea', max: 300 }],
    settings: [{ key: 'columns', kind: 'select', options: ['2', '3', '4'], def: '2' },
      { key: 'image_ratio', kind: 'select', options: ['landscape', 'square', 'portrait'], def: 'landscape', group: 'image' }],
    list: { key: 'items', max: 4, fields: [{ key: 'image', kind: 'media', i18n: false }, { key: 'icon', kind: 'icon', i18n: false, none: true }, { key: 'action', kind: 'select', options: ACTIONS, i18n: false }, PAGE_LINK,
      { key: 'title', max: 80 }, { key: 'text', kind: 'textarea', max: 1500 }, { key: 'button', max: 40 }] } },
  // Partners / insurers / labs the clinic works with: their logos in a row that slides (or a grid).
  partners: { icon: 'handshake', variants: ['logos', 'cards'], group: 'blocks',
    text: [{ key: 'title', max: 80 }, { key: 'intro', kind: 'textarea', max: 300 }],
    settings: [{ key: 'logo_size', kind: 'select', options: ['m', 's', 'l'], def: 'm' }, { key: 'grayscale', kind: 'bool', def: true }],
    list: { key: 'items', max: 24, fields: [{ key: 'image', kind: 'media', i18n: false }, { key: 'name', max: 80, i18n: false }] } },
  // Team / doctors photo cards that move: the clinic's doctors (live, with their photos) or people added by hand.
  team: { icon: 'users', variants: ['lift', 'flip', 'reveal', 'circle'], group: 'blocks',
    text: [{ key: 'title', max: 80 }, { key: 'intro', kind: 'textarea', max: 300 }],
    settings: [{ key: 'source', kind: 'select', options: ['doctors', 'custom'], def: 'doctors' }, { key: 'columns', kind: 'select', options: ['3', '2', '4'], def: '3' },
      { key: 'photo_ratio', kind: 'select', options: ['portrait', 'square', 'landscape'], def: 'portrait', group: 'image' },
      { key: 'show_bio', kind: 'bool', def: true }, { key: 'show_book', kind: 'bool', def: true }, { key: 'show_social', kind: 'bool', def: true }],
    list: { key: 'items', max: 16, fields: [{ key: 'image', kind: 'media', i18n: false }, { key: 'action', kind: 'select', options: ACTIONS, i18n: false }, PAGE_LINK,
      { key: 'name', max: 80 }, { key: 'role', max: 80 }, { key: 'text', kind: 'textarea', max: 400 }, { key: 'button', max: 40 }] } },
  // Before / after: two pictures on top of each other and a line the visitor drags to compare (or side by side).
  before_after: { icon: 'scan-line', variants: ['slider', 'side'], group: 'blocks',
    text: [{ key: 'title', max: 80 }, { key: 'intro', kind: 'textarea', max: 300 }, { key: 'label_before', max: 24 }, { key: 'label_after', max: 24 }],
    settings: [{ key: 'columns', kind: 'select', options: ['2', '1', '3'], def: '2' }, { key: 'direction', kind: 'select', options: ['horizontal', 'vertical'], def: 'horizontal', only: 'slider' },
      { key: 'start', kind: 'select', options: ['50', '30', '70'], def: '50', only: 'slider' },
      { key: 'image_ratio', kind: 'select', options: ['landscape', 'square', 'portrait'], def: 'landscape', group: 'image' }],
    list: { key: 'items', max: 8, fields: [{ key: 'before', kind: 'media', i18n: false }, { key: 'after', kind: 'media', i18n: false }, { key: 'caption', max: 120 }] } },
  // Patients' words written by the clinic (with a photo and stars), as cards, one big quote at a time, or bubbles.
  testimonials: { icon: 'quote', variants: ['cards', 'quote', 'bubbles'], group: 'blocks',
    text: [{ key: 'title', max: 80 }, { key: 'intro', kind: 'textarea', max: 300 }], settings: [],
    list: { key: 'items', max: 12, fields: [{ key: 'image', kind: 'media', i18n: false }, { key: 'rating', kind: 'select', options: ['r5', 'r4', 'r3', 'r0'], i18n: false },
      { key: 'name', max: 80 }, { key: 'role', max: 80 }, { key: 'quote', kind: 'textarea', max: 600 }] } },
  // Tabs: a title per tab; its picture, text and button show when the tab is chosen.
  tabs: { icon: 'layers', variants: ['tabs', 'pills', 'side'], group: 'blocks',
    text: [{ key: 'title', max: 80 }, { key: 'intro', kind: 'textarea', max: 300 }], settings: [{ key: 'image_side', kind: 'select', options: ['end', 'start', 'top'], def: 'end' }],
    list: { key: 'items', max: 8, fields: [{ key: 'icon', kind: 'icon', i18n: false, none: true }, { key: 'image', kind: 'media', i18n: false }, { key: 'action', kind: 'select', options: ACTIONS, i18n: false }, PAGE_LINK,
      { key: 'title', max: 60 }, { key: 'text', kind: 'textarea', max: 1500 }, { key: 'button', max: 40 }] } },
  // A YouTube or Vimeo video (privacy mode), wide or in a card next to text.
  video: { icon: 'video', variants: ['wide', 'card'], group: 'blocks',
    text: [{ key: 'title', max: 120 }, { key: 'text', kind: 'textarea', max: 1000 }],
    settings: [{ key: 'url', kind: 'url', max: 300 }, { key: 'ratio', kind: 'select', options: ['16x9', '4x3', '1x1', '9x16'], def: '16x9' }] },
  // A moving band of short phrases (services, slogans) that scrolls across the page.
  marquee: { icon: 'sliders-horizontal', variants: ['band', 'outline'], group: 'blocks', text: [],
    settings: [{ key: 'speed', kind: 'select', options: ['m', 's', 'l'], def: 'm' }, { key: 'color', kind: 'select', options: ['brand', 'dark', 'soft', 'accent'], def: 'brand' }, { key: 'm_dir', kind: 'select', options: ['auto', 'left', 'right'], def: 'auto' }],
    list: { key: 'items', max: 12, fields: [{ key: 'icon', kind: 'icon', i18n: false, none: true }, { key: 'text', max: 60 }] } },
  divider: { icon: 'waves', variants: ['shape'], group: 'blocks', text: [],
    settings: [{ key: 'shape', kind: 'select', options: ['wave', 'curve', 'slant', 'zigzag', 'peaks', 'drops', 'line', 'dots', 'space'], def: 'wave' },
      { key: 'color', kind: 'select', options: ['soft', 'accent', 'brand', 'dark'], def: 'soft' }, { key: 'height', kind: 'select', options: ['s', 'm', 'l'], def: 'm' }, { key: 'flip', kind: 'bool', def: false }] },
};
// Carousel options on every section that lists items (partners slide by default).
CAROUSEL_TYPES.forEach((k) => { TYPES[k].settings.push(...CAROUSEL.map((f) => (k === 'partners' && f.key === 'carousel' ? { ...f, def: true } : k === 'partners' && f.key === 'per_view' ? { ...f, def: '5' } : f))); });
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

// ---------------------------------------------------------------- pages, menu (header), footer
const MAX_PAGES = 16; // home + 15
const PAGE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED_PAGES = new Set(['home', 'book', 'doctors', 'p', 'm', 'logo', 'login', 'enter', 'fonts', 'theme-css']);
const NAV_KINDS = ['home', 'page', 'section', 'book', 'call', 'whatsapp'];
const HEADER = [
  { key: 'style', kind: 'select', options: ['solid', 'transparent', 'centered', 'minimal'], def: 'solid' },
  { key: 'sticky', kind: 'bool', def: true }, { key: 'show_book', kind: 'bool', def: true }, { key: 'show_lang', kind: 'bool', def: true },
  { key: 'show_theme', kind: 'bool', def: true }, { key: 'show_phone', kind: 'bool', def: false }, { key: 'show_name', kind: 'bool', def: true },
  { key: 'logo_size', kind: 'select', options: ['m', 's', 'l', 'xl'], def: 'm' },
  { key: 'logo_shape', kind: 'select', options: ['badge', 'free'], def: 'badge' }, // badge = on a rounded tile; free = the logo as it is
  // Exact logo height in px (0 = follow logo_size). An image logo always keeps its own proportions.
  { key: 'logo_height', kind: 'number', min: 0, max: 140, def: 0 },
  // Dark mode for the whole site: on = visitors can switch (and the site follows their device); off = always light.
  { key: 'dark_mode', kind: 'bool', def: true },
];
// Social profiles: https addresses on the network's own site only.
const SOCIAL = { facebook: /^(www\.|m\.)?facebook\.com$/, instagram: /^(www\.)?instagram\.com$/, twitter: /^(www\.)?(x|twitter)\.com$/, youtube: /^(www\.|m\.)?youtube\.com$|^youtu\.be$/, linkedin: /^([a-z]{2,3}\.)?linkedin\.com$/ };
const FOOTER = [
  { key: 'style', kind: 'select', options: ['columns', 'simple', 'centered'], def: 'columns' },
  { key: 'show_contact', kind: 'bool', def: true }, { key: 'show_hours', kind: 'bool', def: true }, { key: 'show_menu', kind: 'bool', def: true },
  { key: 'show_social', kind: 'bool', def: true }, { key: 'show_powered', kind: 'bool', def: true },
  // Brand block: the logo (as in the header: on a tile or free, exact height; 0 = 48 px) and the clinic name — shown
  // or hidden, beside the logo or under it.
  { key: 'show_logo', kind: 'bool', def: true }, { key: 'logo_shape', kind: 'select', options: ['free', 'badge'], def: 'free' },
  { key: 'logo_height', kind: 'number', min: 0, max: 140, def: 0 },
  { key: 'show_name', kind: 'bool', def: true }, { key: 'name_pos', kind: 'select', options: ['below', 'beside'], def: 'below' },
];
const cleanSocial = (raw) => Object.fromEntries(Object.keys(SOCIAL).map((k) => {
  const v = cleanLine(raw && raw[k], 300);
  try { const u = new URL(v); return [k, u.protocol === 'https:' && SOCIAL[k].test(u.hostname.toLowerCase()) && !u.username ? u.toString() : '']; } catch { return [k, '']; }
}));
const pair = (raw, max, multi) => ({ ar: (multi ? clean : cleanLine)(raw && raw.ar, max), en: (multi ? clean : cleanLine)(raw && raw.en, max) });

function cleanHeader(raw, pageKeys, sectionIds) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = Object.fromEntries(HEADER.map((f) => [f.key, cleanValue(f, src[f.key])]));
  const items = Array.isArray(src.items) ? src.items : (src.items && typeof src.items === 'object' ? Object.values(src.items) : []);
  out.items = items.slice(0, 10).map((it) => {
    const kind = NAV_KINDS.includes(it && it.kind) ? it.kind : null;
    if (!kind) return null;
    const target = kind === 'page' ? (pageKeys.has(it.target) ? it.target : null) : kind === 'section' ? (sectionIds.has(it.target) ? it.target : null) : null;
    if ((kind === 'page' || kind === 'section') && !target) return null;
    return { kind, target, label: pair(it.label, 40) };
  }).filter(Boolean);
  return out;
}
function cleanFooter(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = Object.fromEntries(FOOTER.map((f) => [f.key, cleanValue(f, src[f.key])]));
  out.about = pair(src.about, 400, true);
  out.copyright = pair(src.copyright, 120);
  // Column headings (own words in each language; empty = the default) and extra contact lines (a second branch, …).
  out.contact_title = pair(src.contact_title, 40); out.links_title = pair(src.links_title, 40); out.hours_title = pair(src.hours_title, 40);
  out.contact_extra = pair(src.contact_extra, 400, true);
  out.social = cleanSocial(src.social);
  return out;
}

/** Map position: latitude and longitude with 6 decimals, or null. */
function cleanGeo(raw) {
  const lat = Number(raw && raw.lat); const lng = Number(raw && raw.lng);
  if (!raw || raw.lat === '' || raw.lng === '' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

const FONTS = ['system', 'humanist', 'serif', 'rounded'];
/** A font choice: a built-in stack, or "f<id>" — one of the clinic's uploaded fonts (refs.fonts). */
const fontOk = (v, refs = {}) => {
  if (FONTS.includes(v)) return v;
  const m = /^f(\d{1,10})$/.exec(String(v || ''));
  return m && (!refs.fonts || refs.fonts.has(Number(m[1]))) ? `f${m[1]}` : null;
};
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

/**
 * The embed address of a YouTube or Vimeo link (privacy-friendly players), or null for anything else.
 * youtube.com/watch?v=ID · youtu.be/ID · youtube.com/shorts/ID · youtube.com/embed/ID · vimeo.com/ID
 */
function videoEmbed(v) {
  let u;
  try { u = new URL(String(v || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let m;
  if (host === 'youtu.be' && (m = /^\/([\w-]{6,20})$/.exec(u.pathname))) return { provider: 'youtube', src: `https://www.youtube-nocookie.com/embed/${m[1]}?rel=0` };
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const id = u.searchParams.get('v') || ((m = /^\/(?:shorts|embed|live)\/([\w-]{6,20})/.exec(u.pathname)) && m[1]);
    if (id && /^[\w-]{6,20}$/.test(id)) return { provider: 'youtube', src: `https://www.youtube-nocookie.com/embed/${id}?rel=0` };
  }
  if ((host === 'vimeo.com' || host === 'player.vimeo.com') && (m = /\/(\d{5,12})(?:$|\/|\?)/.exec(u.pathname))) return { provider: 'vimeo', src: `https://player.vimeo.com/video/${m[1]}?dnt=1` };
  return null;
}

/** One setting value of kind bool/select/number/media/media_list/doctors/date/icon/text/url. */
function cleanValue(f, v, refs = {}) {
  const okMedia = (id) => !refs.media || refs.media.has(id);
  const okDoctor = (id) => !refs.doctors || refs.doctors.has(id);
  // A checkbox posts with a hidden "0" before it: the last value wins.
  if (Array.isArray(v) && ['bool', 'select', 'number', 'date', 'media', 'icon', 'text', 'url', 'page'].includes(f.kind || 'text')) v = v[v.length - 1];
  switch (f.kind) {
    case 'bool': return v === undefined ? f.def : v === true || v === '1' || v === 'on' || v === 'true';
    case 'select': return f.options.includes(v) ? v : (f.def !== undefined ? f.def : f.options[0]);
    case 'number': { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.def; }
    case 'media': { const id = ids(v)[0] || null; return id && okMedia(id) ? id : null; }
    case 'media_list': return ids(v).filter(okMedia).slice(0, f.max || 12);
    case 'doctors': return ids(v).filter(okDoctor).slice(0, 50);
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
    case 'page': return /^(home|[a-f0-9]{10})$/.test(String(v || '')) ? String(v) : null; // a page key of this site (checked when shown)
    case 'icon': return (f.none && v === 'none') ? 'none' : (ICONS.includes(v) ? v : ICONS[0]);
    case 'url': return videoEmbed(v) ? String(v).trim().slice(0, f.max || 300) : null; // only a YouTube / Vimeo address
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
  const allPages = Array.isArray(d.pages) ? d.pages.filter((p) => p && typeof p === 'object') : [];
  const page = allPages.find((p) => p.key === 'home') || { sections: [] };
  const seen = new Set();
  const cleanList = (list) => (Array.isArray(list) ? list : []).filter((s) => s && TYPES[s.type]).slice(0, MAX_SECTIONS).map((s) => {
    const def = TYPES[s.type];
    let id = /^[a-f0-9]{10}$/.test(String(s.id || '')) ? s.id : newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    return { id, type: s.type, variant: def.variants.includes(s.variant) ? s.variant : def.variants[0], visible: s.visible !== false, content: cleanText(def, s.content), settings: cleanSettings(def, s.settings || {}, refs) };
  });
  const sections = cleanList(page.sections);
  // Other pages: their own address (unique, never a reserved word), title, place in the menu and sections.
  const slugs = new Set();
  const extra = allPages.filter((p) => p.key !== 'home').slice(0, MAX_PAGES - 1).map((p, i) => {
    const key = /^[a-f0-9]{10}$/.test(String(p.key || '')) ? p.key : newId();
    let slug = String(p.slug || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (!PAGE_SLUG.test(slug) || RESERVED_PAGES.has(slug) || slugs.has(slug)) slug = `page-${i + 2}`;
    while (slugs.has(slug)) slug = `${slug}-x`;
    slugs.add(slug);
    const ps = p.seo || {};
    return { key, slug, title: pair(p.title, 60), menu: p.menu !== false && p.menu !== '0', sections: cleanList(p.sections),
      seo: { title: pair(ps.title, 70), description: pair(ps.description, 160) } };
  });
  const pageKeys = new Set(extra.map((p) => p.key));
  const sectionIds = new Set(sections.map((s) => s.id));
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
      // Typography: a font for the text and one for the headings (built-in stacks or the clinic's uploaded fonts
      // "f<id>"), text size, heading weight, and colours for text, headings and links (light mode).
      bodyFont: fontOk(b.bodyFont, refs) || (FONTS.includes(b.font) ? b.font : 'system'),
      headingFont: fontOk(b.headingFont, refs) || fontOk(b.bodyFont, refs) || (FONTS.includes(b.font) ? b.font : 'system'),
      size: ['m', 's', 'l'].includes(b.size) ? b.size : 'm',
      headingWeight: ['700', '600', '800', '500'].includes(String(b.headingWeight)) ? String(b.headingWeight) : '700',
      text: HEX.test(b.text || '') ? b.text.toLowerCase() : null,
      heading: HEX.test(b.heading || '') ? b.heading.toLowerCase() : null,
      link: HEX.test(b.link || '') ? b.link.toLowerCase() : null,
      motion: MOTION.includes(b.motion) ? b.motion : 'none', // sites published before motion existed stay still
      logoMediaId: mediaOk(b.logoMediaId), faviconMediaId: mediaOk(b.faviconMediaId),
      logoDarkMediaId: mediaOk(b.logoDarkMediaId), // a light (e.g. white) logo shown in dark mode
    },
    pages: [{ key: 'home', sections }, ...extra],
    header: cleanHeader(d.header, pageKeys, sectionIds),
    footer: cleanFooter(d.footer),
    seo: {
      title: { ar: cleanLine(seo.title && seo.title.ar, 70), en: cleanLine(seo.title && seo.title.en, 70) },
      description: { ar: cleanLine(seo.description && seo.description.ar, 160), en: cleanLine(seo.description && seo.description.en, 160) },
      image: mediaOk(seo.image), // share image (advanced search settings)
      hide: seo.hide === true || seo.hide === '1', // ask search engines not to list the site (advanced)
      keywords: pair(seo.keywords, 200),
      // Local search (GEO): where the clinic is, which areas it serves, its price level.
      geo: cleanGeo(seo.geo),
      area: pair(seo.area, 120),
      price: ['', '$', '$$', '$$$'].includes(seo.price) ? seo.price : '',
      // AI assistants (AIO): a factual summary in the clinic's words, and whether AI crawlers may read the site.
      ai: { summary: pair(seo.ai && seo.ai.summary, 1500, true), bots: seo.ai && seo.ai.bots === 'block' ? 'block' : 'allow' },
    },
  };
}

/** Every media id a document uses (hero/about images, gallery, brand logo/favicon). */
function mediaIn(doc) {
  const out = new Set();
  const b = (doc && doc.brand) || {};
  if (b.logoMediaId) out.add(b.logoMediaId);
  if (b.faviconMediaId) out.add(b.faviconMediaId);
  if (b.logoDarkMediaId) out.add(b.logoDarkMediaId);
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

module.exports = { videoEmbed, CAROUSEL, CAROUSEL_TYPES, TYPES, TYPE_KEYS, TEMPLATE_LAYOUT, SPECIALTY_TEMPLATE, FONTS, RADII, ICONS, ACTIONS, STYLE, SHAPES, MOTION, HEADER, FOOTER, SOCIAL, NAV_KINDS, MAX_PAGES, PAGE_SLUG, RESERVED_PAGES, MAX_SECTIONS, blankSection, defaultDoc, sanitize, mediaIn, newId, cleanStyle };
