// Static checks run in CI and before release:
//  1. Arabic and English dictionaries have the same keys.
//  2. Views and stylesheets use design tokens, not hard-coded brand colours.
//  3. No inline <script> with code in views (the CSP would block it).
const fs = require('fs');
const path = require('path');

let failed = 0;
const fail = (m) => { failed += 1; console.error(`✗ ${m}`); }; // eslint-disable-line no-console
const root = path.join(__dirname, '..');
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]));

for (const f of fs.readdirSync(path.join(root, 'src/locales/en'))) {
  const en = new Set(flat(JSON.parse(fs.readFileSync(path.join(root, 'src/locales/en', f)))));
  const arFile = path.join(root, 'src/locales/ar', f);
  if (!fs.existsSync(arFile)) { fail(`locales/ar/${f} missing`); continue; } // eslint-disable-line no-continue
  const ar = new Set(flat(JSON.parse(fs.readFileSync(arFile))));
  [...en].filter((k) => !ar.has(k)).forEach((k) => fail(`ar/${f}: missing ${k}`));
  [...ar].filter((k) => !en.has(k) && !k.startsWith('vmsg.')).forEach((k) => fail(`en/${f}: missing ${k}`));
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const BRAND_HEX = /#(0B4D2C|0F5A38|061A10|84CC16)\b/i;
for (const file of walk(path.join(root, 'src/views'))) {
  const text = fs.readFileSync(file, 'utf8');
  if (BRAND_HEX.test(text)) fail(`${path.relative(root, file)}: hard-coded brand colour (use var(--brand) etc.)`);
  if (/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/i.test(text)) fail(`${path.relative(root, file)}: inline <script>`);
}
for (const file of walk(path.join(root, 'public/css'))) {
  if (BRAND_HEX.test(fs.readFileSync(file, 'utf8'))) fail(`${path.relative(root, file)}: hard-coded brand colour`);
}
if (failed) { console.error(`${failed} problem(s)`); process.exit(1); } // eslint-disable-line no-console
console.log('checks passed'); // eslint-disable-line no-console
