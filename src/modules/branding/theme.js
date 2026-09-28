// Turns src/config/brand.js into CSS custom properties. public/css/app.css only ever uses var(--…),
// so everything visual (components, charts, print, auth, landing) follows this one file.
const crypto = require('crypto');
const brand = require('../../config/brand');

const kebab = (s) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex, a) => `rgba(${hexToRgb(hex).join(', ')}, ${a})`;

/** Relative luminance → pick readable ink for a custom primary colour. */
function inkFor(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.4 ? '#0B1210' : '#FFFFFF';
}
function shade(hex, pct) {
  const [r, g, b] = hexToRgb(hex).map((v) => Math.max(0, Math.min(255, Math.round(v + (pct < 0 ? v * pct : (255 - v) * pct)))));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function vars(c) {
  const out = Object.entries(c).map(([k, v]) => `--${kebab(k)}: ${v};`);
  // Derived tints used for soft backgrounds, focus rings and chart washes.
  out.push(`--primary-soft: ${rgba(c.primary, 0.12)};`, `--primary-soft-2: ${rgba(c.primary, 0.22)};`, `--focus-ring: 0 0 0 3px ${rgba(c.primary, 0.4)};`);
  out.push(`--accent-soft: ${rgba(c.accent, 0.16)};`);
  for (const s of ['success', 'warning', 'danger', 'info']) out.push(`--${s}-soft: ${rgba(c[s], 0.12)};`);
  return out.join(' ');
}

function baseCss() {
  const { light, dark } = brand.colors;
  const common = `--font-sans: ${brand.fonts.sans}; --font-mono: ${brand.fonts.mono}; --radius-sm: ${brand.radius.sm}; --radius: ${brand.radius.md}; --radius-lg: ${brand.radius.lg};`;
  return `:root { ${common} ${vars(light)} color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${vars(dark)} color-scheme: dark; } }
:root[data-theme="dark"] { ${vars(dark)} color-scheme: dark; }
`;
}

/** Workspace override (Settings → Appearance): only the primary colour family changes. */
function businessCss(color) {
  if (!color || !HEX.test(color)) return '';
  const lightHover = shade(color, -0.18);
  const darkP = shade(color, 0.28);
  const l = `--primary: ${color}; --primary-hover: ${lightHover}; --primary-ink: ${inkFor(color)}; --primary-soft: ${rgba(color, 0.12)}; --primary-soft-2: ${rgba(color, 0.22)}; --focus-ring: 0 0 0 3px ${rgba(color, 0.4)};`;
  const d = `--primary: ${darkP}; --primary-hover: ${shade(darkP, 0.2)}; --primary-ink: ${inkFor(darkP)}; --primary-soft: ${rgba(darkP, 0.14)}; --primary-soft-2: ${rgba(darkP, 0.26)}; --focus-ring: 0 0 0 3px ${rgba(darkP, 0.4)};`;
  return `:root { ${l} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${d} } }
:root[data-theme="dark"] { ${d} }
`;
}

function markSvg(color = brand.colors.light.primary, ink = brand.colors.light.primaryInk) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${color}"/>`
    + `<path d="M20 16h14c9.4 0 16 6.8 16 16s-6.6 16-16 16H20z" fill="none" stroke="${ink}" stroke-width="5" stroke-linejoin="round"/>`
    + `<path d="M28 26h8M28 32h10M28 38h6" stroke="${ink}" stroke-width="4" stroke-linecap="round"/></svg>`;
}

const css = baseCss();
const etag = crypto.createHash('sha1').update(css).digest('hex').slice(0, 12);

module.exports = { css, etag, businessCss, markSvg, HEX, inkFor };
