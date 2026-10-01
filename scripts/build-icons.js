// Builds public/icons.svg (a <symbol> sprite) from lucide-static (ISC licence).
// Usage: node scripts/build-icons.js <path to lucide-static/icons>
const fs = require('fs');
const path = require('path');

const ICONS = `layout-dashboard receipt wallet chart-pie file-text users package sparkles life-buoy settings search bell log-out chevron-down
chevron-right chevron-left chevrons-up-down plus pencil trash-2 x check circle-alert triangle-alert info lock moon sun languages
menu filter arrow-up-down arrow-right arrow-left download upload mail key-round history eye ellipsis clock circle-check circle-x
building-2 user user-plus user-cog shield-check copy external-link printer refresh-cw link unplug plug calendar calendar-days
trending-up trending-down banknote coins hand-coins percent target scale landmark database archive-restore send message-square
lightbulb circle-help book-open palette monitor smartphone globe clipboard-list list-checks gauge arrow-up-right arrow-down-right
minus circle-dot zap award rocket cloud cloud-upload cloud-download file-spreadsheet table phone map-pin activity layers id-card
briefcase-business circle-plus stethoscope heart-pulse armchair calendar-plus calendar-check calendar-x calendar-clock pill
syringe eye-off chevron-up thermometer weight droplet hospital user-round user-check user-x door-open timer notebook-pen
clipboard-plus scan-line qr-code grip-vertical arrow-up arrow-down eye-closed image square-pen layout-template panel-top
panel-bottom toggle-left toggle-right house star quote list mouse-pointer-click badge-check shield-plus stamp receipt-text
calculator hand-coins vault grip calendar-range move megaphone cookie bot facebook instagram linkedin youtube twitter music ghost
message-circle images align-left align-center align-right package-search handshake clipboard-check truck tag
video video-off mic mic-off phone-off switch-camera paperclip
pen-line baby smile ruler file-up radio brain shield-alert wand-sparkles credit-card hourglass maximize minimize volume-2 volume-x file-check
layout-grid list-ordered type waves chart-no-axes-column square circle panel-left panel-right panel-left-close panel-right-close tablet sliders-horizontal shapes
columns-2 rows-2 move-vertical paint-bucket stretch-horizontal align-vertical-space-around heart leaf flower-2 sun-medium hand-heart`.split(/\s+/).filter((n, i, a) => n && a.indexOf(n) === i);

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
