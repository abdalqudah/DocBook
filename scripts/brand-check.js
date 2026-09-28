#!/usr/bin/env node
// Guards the brand rules: no other product names or store vocabulary in the product, and no hard-coded
// colours outside the brand config (views and CSS use theme tokens only). Exit code 1 on any finding.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN = ['src', 'public/css', 'public/js'];
const FORBIDDEN = /remote\s?way|value\s?marka|e-?commerce|shopify|woocommerce|shopping cart|\bCOGS\b/i;
const HEX = /#[0-9a-f]{3}(?:[0-9a-f]{3})?\b/gi;
// Files allowed to define colours: the brand config, the theme generator and the colour-picker defaults.
const COLOUR_ALLOWED = [/src\/config\/brand\.js$/, /src\/modules\/branding\/theme\.js$/, /\.test\.js$/];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(js|ejs|css|json)$/.test(e.name)) yield p;
  }
}

const findings = [];
for (const base of SCAN) {
  for (const file of walk(path.join(ROOT, base))) {
    const rel = path.relative(ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (FORBIDDEN.test(line)) findings.push(`${rel}:${i + 1}: forbidden name/term: ${line.trim().slice(0, 120)}`);
      if (!COLOUR_ALLOWED.some((r) => r.test(rel)) && /\.(ejs|css)$/.test(rel)) {
        // Colour inputs need a literal default value; everything else must use tokens.
        const hits = (line.match(HEX) || []).filter(() => !/type="color"|type=\\?"color/.test(line) && !/&#|href="#|id="#/.test(line));
        if (hits.length) findings.push(`${rel}:${i + 1}: hard-coded colour ${hits.join(', ')}`);
      }
    });
  }
}

if (findings.length) {
  console.error(findings.join('\n'));
  console.error(`\n${findings.length} brand issue(s).`);
  process.exit(1);
}
console.log('brand check: OK');
