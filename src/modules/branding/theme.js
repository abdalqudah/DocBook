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
  // The text colour with the better contrast on this background (white vs. near-black).
  return (L + 0.05) / (0.0062 + 0.05) > 1.05 / (L + 0.05) ? '#0B1210' : '#FFFFFF';
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
const lum = (hex) => { const [r, g, b] = hexToRgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** The brand colour for dark mode: lightened until it reads clearly on the dark surface (contrast ≥ 4.5). */
function forDark(color) {
  const bg = lum(brand.colors.dark.surface);
  let c = shade(color, 0.28);
  for (let i = 0; i < 12 && (lum(c) + 0.05) / (bg + 0.05) < 4.5; i += 1) c = shade(c, 0.15);
  return c;
}

function businessCss(color) {
  if (!color || !HEX.test(color)) return '';
  const lightHover = shade(color, -0.18);
  const darkP = forDark(color);
  const l = `--primary: ${color}; --primary-hover: ${lightHover}; --primary-ink: ${inkFor(color)}; --primary-soft: ${rgba(color, 0.12)}; --primary-soft-2: ${rgba(color, 0.22)}; --focus-ring: 0 0 0 3px ${rgba(color, 0.4)};`;
  const d = `--primary: ${darkP}; --primary-hover: ${shade(darkP, 0.2)}; --primary-ink: ${inkFor(darkP)}; --primary-soft: ${rgba(darkP, 0.14)}; --primary-soft-2: ${rgba(darkP, 0.26)}; --focus-ring: 0 0 0 3px ${rgba(darkP, 0.4)};`;
  // In dark mode the brand colour is lightened for text and links; a block filled with the brand colour (website
  // sections on the "brand" background) keeps the clinic's real colour with its own readable text.
  const fill = `.ws-bg-brand { --primary: ${color}; --primary-hover: ${lightHover}; --primary-ink: ${inkFor(color)}; }`;
  return `:root { ${l} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${d} } :root:not([data-theme="light"]) ${fill} }
:root[data-theme="dark"] { ${d} }
:root[data-theme="dark"] ${fill}
`;
}

function markSvg(color = brand.colors.light.primary, ink = brand.colors.light.primaryInk) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${color}"/>${brand.markInner(ink)}</svg>`;
}

const css = baseCss();
const etag = crypto.createHash('sha1').update(css).digest('hex').slice(0, 12);

module.exports = { css, etag, businessCss, markSvg, HEX, inkFor, forDark };
