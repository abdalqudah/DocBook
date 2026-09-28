// Builds public/icons.svg (a <symbol> sprite) from lucide-static (ISC licence).
// Usage: node scripts/build-icons.js <path to lucide-static/icons>
const fs = require('fs');
const path = require('path');

const ICONS = `layout-dashboard handshake receipt wallet piggy-bank chart-pie file-text shopping-cart users package truck megaphone sparkles
sheet life-buoy settings search bell log-out chevron-down chevron-right chevron-left chevrons-up-down plus pencil trash-2 x check circle-alert
triangle-alert info lock moon sun languages menu filter arrow-up-down arrow-right arrow-left download upload mail key-round history eye ellipsis
clock circle-check circle-x building-2 user user-plus user-cog shield-check copy external-link printer refresh-cw link unplug plug calendar
calendar-days trending-up trending-down banknote coins hand-coins percent target badge-dollar-sign scale landmark database archive-restore
send message-square bot lightbulb circle-help book-open palette monitor smartphone globe store boxes clipboard-list list-checks gauge
arrow-up-right arrow-down-right minus circle-dot zap award rocket cloud cloud-upload cloud-download file-spreadsheet table phone map-pin
activity layers id-card briefcase-business circle-plus`.split(/\s+/).filter(Boolean);

const dir = process.argv[2];
if (!dir) { console.error('Pass the lucide-static icons directory.'); process.exit(1); }
let out = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n<!-- Icons: Lucide (https://lucide.dev), ISC licence -->\n';
for (const name of ICONS) {
  const file = path.join(dir, `${name}.svg`);
  if (!fs.existsSync(file)) { console.error(`missing icon: ${name}`); process.exitCode = 1; continue; }
  const svg = fs.readFileSync(file, 'utf8');
  const inner = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '').replace(/\s*\n\s*/g, '');
  out += `<symbol id="i-${name}" viewBox="0 0 24 24">${inner}</symbol>\n`;
}
out += '</svg>\n';
fs.writeFileSync(path.join(__dirname, '..', 'public', 'icons.svg'), out);
console.log(`icons.svg: ${ICONS.length} icons`);
