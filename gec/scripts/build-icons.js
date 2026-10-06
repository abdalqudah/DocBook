// Builds public/icons.svg (an SVG sprite) from lucide-static (ISC licence). Run after adding a name to ICONS.
const fs = require('fs');
const path = require('path');

const ICONS = [
  'check-check', 'images', 'pause', 'play', 'route', 'circle-check', 'arrow-down', 'quote', 'plane', 'wallet', 'stamp', 'house-plus', 'file', 'house', 'link-2-off', 'party-popper', 'circle-dashed', 'mail-check',
  'chart-line', 'trophy', 'megaphone', 'workflow', 'flame', 'mouse-pointer-click', 'eye', 'zap', 'power', 'mail-x',
  'plug-zap', 'handshake', 'arrow-down-left', 'calendar-plus', 'calendar-x', 'shield-x',
  'search', 'x', 'menu', 'chevron-down', 'chevron-up', 'chevron-left', 'chevron-right', 'arrow-left', 'arrow-right', 'arrow-up-right',
  'plus', 'minus', 'check', 'check-circle-2', 'circle', 'circle-dot', 'alert-triangle', 'alert-circle', 'info', 'help-circle',
  'home', 'layout-dashboard', 'users', 'user', 'user-plus', 'user-check', 'user-round', 'contact', 'graduation-cap', 'school',
  'building-2', 'landmark', 'book-open', 'book-marked', 'library', 'award', 'globe', 'globe-2', 'map-pin', 'plane', 'plane-takeoff',
  'file-text', 'file-check', 'file-x', 'file-up', 'files', 'folder', 'upload', 'download', 'paperclip', 'image',
  'calendar', 'calendar-check', 'calendar-clock', 'calendar-days', 'clock', 'timer', 'bell', 'bell-ring', 'inbox', 'mail', 'send',
  'message-circle', 'message-square', 'messages-square', 'phone', 'smartphone', 'megaphone', 'list-checks', 'check-square', 'square',
  'kanban', 'list', 'table', 'filter', 'sliders-horizontal', 'settings', 'settings-2', 'shield', 'shield-check', 'lock', 'key-round',
  'log-in', 'log-out', 'eye', 'eye-off', 'pencil', 'trash-2', 'copy', 'link', 'external-link', 'share-2', 'printer', 'star', 'heart',
  'bookmark', 'bookmark-check', 'scale', 'calculator', 'wallet', 'credit-card', 'receipt', 'banknote', 'percent', 'trending-up',
  'trending-down', 'bar-chart-3', 'line-chart', 'pie-chart', 'activity', 'target', 'zap', 'workflow', 'bot', 'sparkles', 'flame',
  'thermometer', 'briefcase', 'building', 'network', 'plug', 'history', 'refresh-cw', 'rotate-ccw', 'more-horizontal', 'more-vertical',
  'grip-vertical', 'languages', 'sun', 'moon', 'monitor', 'newspaper', 'layout-template', 'panel-left', 'navigation', 'compass',
  'ticket', 'qr-code', 'video', 'map', 'flag', 'stamp', 'id-card', 'merge', 'git-merge', 'at-sign', 'hash', 'tag',
  'circle-help', 'command', 'corner-down-left', 'move', 'circle-x', 'ban', 'badge-check', 'badge-dollar-sign', 'coins', 'hourglass',
  'list-todo', 'sticky-note', 'notebook-pen', 'user-cog', 'users-round', 'database', 'cookie', 'mouse-pointer-click', 'gauge',
];

const dir = path.join(__dirname, '..', 'node_modules', 'lucide-static', 'icons');
const out = ['<svg xmlns="http://www.w3.org/2000/svg" style="display:none">'];
const missing = [];
for (const name of ICONS) {
  const file = path.join(dir, `${name}.svg`);
  if (!fs.existsSync(file)) { missing.push(name); continue; } // eslint-disable-line no-continue
  const svg = fs.readFileSync(file, 'utf8');
  const inner = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s+/g, ' ').trim();
  out.push(`<symbol id="i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>`);
}
out.push('</svg>');
fs.writeFileSync(path.join(__dirname, '..', 'public', 'icons.svg'), out.join('\n'));
console.log(`icons.svg: ${ICONS.length - missing.length} icons${missing.length ? `; missing: ${missing.join(', ')}` : ''}`); // eslint-disable-line no-console
