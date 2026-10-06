// Copies the country flags (flag-icons, MIT) into public/flags/<code>.svg. Run: node scripts/build-flags.js
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'flag-icons', 'flags', '4x3');
const out = path.join(__dirname, '..', 'public', 'flags');
fs.mkdirSync(out, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src)) if (/^[a-z]{2}\.svg$/.test(f)) { fs.copyFileSync(path.join(src, f), path.join(out, f)); n += 1; }
fs.writeFileSync(path.join(out, 'LICENSE.txt'), fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'flag-icons', 'LICENSE')));
console.log(`flags: ${n}`);
