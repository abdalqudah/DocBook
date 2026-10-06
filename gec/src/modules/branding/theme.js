// Builds /theme.css from Settings → Branding: the design tokens every stylesheet uses. Colours are never
// hard-coded in components; changing the brand colour re-themes the public site, portals and e-mails.
const crypto = require('crypto');
const settings = require('../settings/settings.service');

const hexToRgb = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbToHex = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (hex, withHex, amount) => { const a = hexToRgb(hex); const b = hexToRgb(withHex); return rgbToHex(...a.map((v, i) => v + (b[i] - v) * amount)); };
const luminance = (hex) => { const c = hexToRgb(hex).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** Text colour on a filled background: white or near-black, whichever reads better. */
const inkFor = (hex) => (contrast(hex, '#ffffff') >= 4.5 ? '#ffffff' : '#0a0f0c');

/** A primary colour that reaches 4.5:1 on white (darkened step by step when needed) — keeps links readable. */
function readable(hex) {
  let c = hex;
  for (let i = 0; i < 12 && contrast(c, '#ffffff') < 4.5; i += 1) c = mix(c, '#000000', 0.12);
  return c;
}

let cached = { key: null, css: '', etag: '' };

async function css() {
  const b = await settings.get('branding');
  const primary = hexToRgb(b.primary) ? b.primary : '#0B4D2C';
  const secondary = hexToRgb(b.secondary) ? b.secondary : '#0A0F0C';
  const accent = hexToRgb(b.accent) ? b.accent : '#84CC16';
  const key = [primary, secondary, accent].join('|');
  if (cached.key === key) return cached;
  const p = readable(primary);
  const lightP = mix(primary, '#ffffff', 0.55);
  const vars = {
    light: {
      '--brand': p, '--brand-ink': inkFor(p), '--brand-strong': mix(p, '#000000', 0.25), '--brand-soft': mix(primary, '#ffffff', 0.9), '--brand-softer': mix(primary, '#ffffff', 0.95),
      '--brand-line': mix(primary, '#ffffff', 0.78), '--accent': accent, '--accent-ink': inkFor(accent), '--secondary': secondary,
      '--bg': '#f7f9f8', '--surface': '#ffffff', '--surface-2': '#f1f4f2', '--surface-3': '#e8ede9',
      '--text': '#111a15', '--text-2': '#45524a', '--text-3': '#5b675f', '--line': '#e1e7e3', '--line-strong': '#c9d3cc',
      '--focus': mix(p, '#2563eb', 0.35),
      '--gold': '#F2C14E', '--gold-ink': '#3a2a05', '--deep': mix(primary, '#000000', 0.45), '--deep-2': mix(primary, '#000000', 0.25), '--mint': mix(primary, '#ffffff', 0.86),
    },
    dark: {
      '--brand': lightP, '--brand-ink': '#04140b', '--brand-strong': mix(primary, '#ffffff', 0.7), '--brand-soft': mix(primary, '#0d1210', 0.6), '--brand-softer': mix(primary, '#0d1210', 0.8),
      '--brand-line': mix(primary, '#0d1210', 0.35), '--accent': accent, '--accent-ink': inkFor(accent), '--secondary': mix(primary, '#0d1210', 0.45),
      '--bg': '#0d1210', '--surface': '#141b17', '--surface-2': '#1a231e', '--surface-3': '#222d27',
      '--text': '#e8ede9', '--text-2': '#b4c0b8', '--text-3': '#8b978f', '--line': '#26312b', '--line-strong': '#34413a',
      '--focus': '#8ab4f8',
      '--gold': '#F2C14E', '--gold-ink': '#3a2a05', '--deep': mix(primary, '#000000', 0.62), '--deep-2': mix(primary, '#000000', 0.45), '--mint': mix(primary, '#0d1210', 0.7),
    },
  };
  const block = (o) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(';');
  const text = `:root{${block(vars.light)};color-scheme:light}
:root[data-theme="dark"]{${block(vars.dark)};color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${block(vars.dark)};color-scheme:dark}}`;
  cached = { key, css: text, etag: `"${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}"` };
  return cached;
}

module.exports = { css, inkFor, contrast, readable, mix, hexToRgb };
