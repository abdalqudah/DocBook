// Builds the illustrated cover art in public/img/covers/*.svg: a layered skyline per destination (sky, sun, hills,
// city, landmark, foreground) plus campus / hero scenes. Used underneath photos, so a page still looks finished
// when a photo is missing or blocked. Run: node scripts/build-covers.js
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'img', 'covers');
fs.mkdirSync(OUT, { recursive: true });
const W = 1600; const H = 900;

function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
const r1 = (n) => Math.round(n * 10) / 10;

/** A row of buildings between x0 and x1 standing on y, heights in [hMin, hMax]. */
function city(rand, { x0 = 0, x1 = W, y, hMin, hMax, wMin = 40, wMax = 110, fill, windows = null }) {
  let x = x0; let out = '';
  while (x < x1) {
    const w = wMin + rand() * (wMax - wMin); const h = hMin + rand() * (hMax - hMin);
    out += `<rect x="${r1(x)}" y="${r1(y - h)}" width="${r1(w + 1)}" height="${r1(h + 2)}" fill="${fill}"/>`;
    if (rand() < 0.25) out += `<rect x="${r1(x + w / 2 - 2)}" y="${r1(y - h - 26)}" width="4" height="28" fill="${fill}"/>`;
    if (windows) {
      for (let wy = y - h + 14; wy < y - 14; wy += 22) for (let wx = x + 9; wx < x + w - 12; wx += 18) if (rand() < 0.28) out += `<rect x="${r1(wx)}" y="${r1(wy)}" width="7" height="9" rx="1" fill="${windows}"/>`;
    }
    x += w + rand() * 6;
  }
  return out;
}
const hills = (y, amp, fill, phase = 0) => {
  let d = `M0 ${H} L0 ${y}`;
  for (let x = 0; x <= W; x += 40) d += ` L${x} ${r1(y - amp * (0.5 + 0.5 * Math.sin((x / W) * Math.PI * 2.2 + phase)) - amp * 0.3 * Math.sin((x / W) * Math.PI * 5 + phase * 2))}`;
  return `<path d="${d} L${W} ${H} Z" fill="${fill}"/>`;
};
const stars = (rand, n, maxY, fill) => Array.from({ length: n }, () => `<circle cx="${r1(rand() * W)}" cy="${r1(rand() * maxY)}" r="${r1(0.8 + rand() * 1.6)}" fill="${fill}" opacity="${r1(0.3 + rand() * 0.6)}"/>`).join('');
const birds = (x, y, s, stroke) => [0, 1, 2].map((i) => `<path d="M${x + i * 34 * s} ${y + (i % 2) * 14 * s} q${9 * s} ${-9 * s} ${18 * s} 0 q${9 * s} ${-9 * s} ${18 * s} 0" fill="none" stroke="${stroke}" stroke-width="${2.4 * s}" stroke-linecap="round"/>`).join('');

// ---------------------------------------------------------------- landmarks (drawn standing on y)
const L = {
  bigBen: (x, y, f, a) => `<g fill="${f}"><rect x="${x}" y="${y - 430}" width="70" height="430"/><rect x="${x - 8}" y="${y - 470}" width="86" height="60"/><path d="M${x - 8} ${y - 470} L${x + 35} ${y - 600} L${x + 78} ${y - 470}Z"/><rect x="${x + 32}" y="${y - 640}" width="6" height="50"/></g><circle cx="${x + 35}" cy="${y - 440}" r="24" fill="${a}"/><path d="M${x + 35} ${y - 440} l0 -16 M${x + 35} ${y - 440} l11 6" stroke="${f}" stroke-width="4" stroke-linecap="round"/>`,
  eye: (cx, cy, r, f) => `<g fill="none" stroke="${f}"><circle cx="${cx}" cy="${cy}" r="${r}" stroke-width="7"/><circle cx="${cx}" cy="${cy}" r="${r - 26}" stroke-width="2.5"/>${Array.from({ length: 16 }, (_, i) => { const t = (i / 16) * Math.PI * 2; return `<line x1="${cx}" y1="${cy}" x2="${r1(cx + Math.cos(t) * r)}" y2="${r1(cy + Math.sin(t) * r)}" stroke-width="2"/>`; }).join('')}</g>${Array.from({ length: 16 }, (_, i) => { const t = (i / 16) * Math.PI * 2; return `<rect x="${r1(cx + Math.cos(t) * r - 7)}" y="${r1(cy + Math.sin(t) * r - 5)}" width="14" height="11" rx="3" fill="${f}"/>`; }).join('')}<path d="M${cx - 60} ${cy + r + 160} L${cx} ${cy} L${cx + 60} ${cy + r + 160}" fill="none" stroke="${f}" stroke-width="10"/>`,
  empire: (x, y, f) => `<path fill="${f}" d="M${x} ${y} V${y - 300} H${x + 20} V${y - 360} H${x + 34} V${y - 420} H${x + 48} V${y - 470} H${x + 58} V${y - 560} H${x + 62} V${y - 470} H${x + 72} V${y - 420} H${x + 86} V${y - 360} H${x + 100} V${y - 300} H${x + 120} V${y}Z"/>`,
  willis: (x, y, f) => `<path fill="${f}" d="M${x} ${y} V${y - 380} H${x + 30} V${y - 470} H${x + 60} V${y - 520} H${x + 90} V${y - 430} H${x + 110} V${y}Z"/><rect x="${x + 64}" y="${y - 590}" width="5" height="72" fill="${f}"/><rect x="${x + 78}" y="${y - 570}" width="5" height="52" fill="${f}"/>`,
  cnTower: (x, y, f) => `<g fill="${f}"><path d="M${x - 22} ${y} L${x - 8} ${y - 420} H${x + 8} L${x + 22} ${y}Z"/><ellipse cx="${x}" cy="${y - 430}" rx="44" ry="22"/><rect x="${x - 34}" y="${y - 452}" width="68" height="14" rx="7"/><rect x="${x - 8}" y="${y - 530}" width="16" height="90"/><ellipse cx="${x}" cy="${y - 520}" rx="16" ry="9"/><rect x="${x - 3}" y="${y - 660}" width="6" height="140"/></g>`,
  opera: (x, y, f, a) => `<g fill="${f}"><rect x="${x - 20}" y="${y - 24}" width="440" height="26"/></g>${[[0, 140, 160], [90, 150, 190], [190, 120, 150], [270, 110, 120]].map(([dx, w, h]) => `<path d="M${x + dx} ${y - 24} Q${x + dx + w * 0.15} ${y - 24 - h} ${x + dx + w} ${y - 24 - h * 0.9} Q${x + dx + w * 0.6} ${y - 60} ${x + dx + w * 0.75} ${y - 24}Z" fill="${a}" stroke="${f}" stroke-width="4"/>`).join('')}`,
  bridge: (x0, x1, y, h, f) => { const m = (x0 + x1) / 2; let s = `<path d="M${x0} ${y} Q${m} ${y - h * 2} ${x1} ${y}" fill="none" stroke="${f}" stroke-width="14"/><rect x="${x0 - 30}" y="${y - 10}" width="${x1 - x0 + 60}" height="14" fill="${f}"/>`; for (let x = x0 + 30; x < x1; x += 30) { const t = (x - x0) / (x1 - x0); const ay = y - 4 * h * t * (1 - t); s += `<line x1="${x}" y1="${r1(ay)}" x2="${x}" y2="${y - 4}" stroke="${f}" stroke-width="3"/>`; } return `${s}<rect x="${x0 - 46}" y="${y - 90}" width="34" height="96" fill="${f}"/><rect x="${x1 + 12}" y="${y - 90}" width="34" height="96" fill="${f}"/>`; },
  gate: (x, y, f) => `<g fill="${f}"><rect x="${x - 10}" y="${y - 200}" width="300" height="34"/><rect x="${x + 10}" y="${y - 220}" width="260" height="22"/><path d="M${x + 110} ${y - 220} h60 l-10 -36 h-40z"/>${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${x + i * 54}" y="${y - 166}" width="22" height="166"/>`).join('')}</g>`,
  tvTower: (x, y, f) => `<g fill="${f}"><path d="M${x - 14} ${y} L${x - 6} ${y - 360} H${x + 6} L${x + 14} ${y}Z"/><circle cx="${x}" cy="${y - 390}" r="38"/><rect x="${x - 5}" y="${y - 540}" width="10" height="130"/><rect x="${x - 2}" y="${y - 600}" width="4" height="70"/></g>`,
  roundTower: (x, y, f) => `<g fill="${f}"><path d="M${x} ${y} L${x + 6} ${y - 300} H${x + 54} L${x + 60} ${y}Z"/><path d="M${x + 2} ${y - 298} L${x + 30} ${y - 380} L${x + 58} ${y - 298}Z"/></g>`,
  castle: (x, y, f) => `<g fill="${f}"><rect x="${x}" y="${y - 120}" width="180" height="120"/>${[0, 1, 2, 3, 4, 5, 6].map((i) => `<rect x="${x + i * 27}" y="${y - 138}" width="14" height="20"/>`).join('')}<rect x="${x - 30}" y="${y - 190}" width="60" height="190"/><rect x="${x + 150}" y="${y - 170}" width="56" height="170"/>${[0, 1, 2].map((i) => `<rect x="${x - 30 + i * 23}" y="${y - 206}" width="14" height="18"/>`).join('')}</g>`,
  campus: (x, y, f, a) => `<g fill="${f}"><rect x="${x}" y="${y - 170}" width="520" height="170"/><path d="M${x - 20} ${y - 170} L${x + 260} ${y - 260} L${x + 540} ${y - 170}Z"/><rect x="${x + 200}" y="${y - 300}" width="120" height="60"/><path d="M${x + 200} ${y - 300} Q${x + 260} ${y - 390} ${x + 320} ${y - 300}Z"/><rect x="${x + 257}" y="${y - 420}" width="6" height="40"/></g>${Array.from({ length: 8 }, (_, i) => `<rect x="${x + 30 + i * 62}" y="${y - 150}" width="18" height="150" fill="${a}" opacity=".35"/>`).join('')}`,
  cap: (x, y, s, f, tassel) => `<g transform="translate(${x} ${y}) rotate(-14) scale(${s})"><path d="M0 0 L60 -24 L120 0 L60 24Z" fill="${f}"/><path d="M28 12 V36 Q60 52 92 36 V12 L60 24Z" fill="${f}"/><path d="M60 0 Q96 6 100 34" fill="none" stroke="${tassel}" stroke-width="3"/><circle cx="100" cy="38" r="5" fill="${tassel}"/></g>`,
};

function scene({ key, seed, sky, sun, far, mid, near, glow, windows, landmark, extra = '', starsOn = false }) {
  const rand = rng(seed);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" role="img" aria-hidden="true">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">${sky.map((c, i) => `<stop offset="${r1((i / (sky.length - 1)) * 100)}%" stop-color="${c}"/>`).join('')}</linearGradient>
<radialGradient id="glow" cx="${sun[0] / W}" cy="${sun[1] / H}" r=".55"><stop offset="0" stop-color="${glow}" stop-opacity=".75"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>
<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
${starsOn ? stars(rand, 90, 420, '#ffffff') : ''}
<circle cx="${sun[0]}" cy="${sun[1]}" r="${sun[2]}" fill="${sun[3]}"/>
${hills(640, 90, far, seed % 7)}
${city(rand, { y: 720, hMin: 60, hMax: 230, fill: mid, windows, wMin: 50, wMax: 120 })}
${landmark}
${hills(800, 40, near, (seed % 5) + 1)}
${extra}
${birds(rng(seed + 3)() * 600 + 180, 210, 1.1, near)}
<rect width="${W}" height="${H}" fill="url(#fade)"/>
</svg>`;
  fs.writeFileSync(path.join(OUT, `${key}.svg`), svg.replace(/\n/g, ''));
}

const G = { forest: '#0B4D2C', deep: '#062A18' };
scene({ key: 'uk', seed: 11, sky: ['#2b3a67', '#5a5f9a', '#c98fa6', '#f3c9a8'], sun: [1180, 420, 70, '#ffe2b8'], glow: '#ffd2a1', far: '#4b4f7f', mid: '#2e3260', near: '#1a1d3d', windows: '#ffd98a',
  landmark: L.eye(980, 470, 170, '#23264d') + L.bigBen(470, 720, '#1f2246', '#f7d9a6') });
scene({ key: 'usa', seed: 23, sky: ['#ffb36b', '#ff8f6b', '#d9667d', '#5b4b8a'].reverse(), sun: [360, 360, 90, '#ffe4a3'], glow: '#ffc56b', far: '#7a4a7d', mid: '#4a2f5e', near: '#2a1c3c', windows: '#ffe08a',
  landmark: L.willis(1020, 720, '#3a2550') + L.empire(780, 720, '#3a2550') });
scene({ key: 'canada', seed: 37, sky: ['#0d2b3e', '#11515e', '#1f8a7a', '#9fe0c0'], sun: [1260, 230, 46, '#e8fff3'], glow: '#7fffd0', far: '#1c5d63', mid: '#123f4b', near: '#0a2830', windows: '#b8ffe0', starsOn: true,
  landmark: L.cnTower(1000, 720, '#0d3440'), extra: `<path d="M0 640 L180 470 L300 560 L420 430 L600 640Z" fill="#1d6a6c" opacity=".7"/>` });
scene({ key: 'australia', seed: 41, sky: ['#2f7fbf', '#5fb0dc', '#ffd59a', '#ff9f68'], sun: [1320, 520, 80, '#fff1c7'], glow: '#ffd28a', far: '#4f8fb0', mid: '#2f6f8f', near: '#1d4f66', windows: '#fff3c4',
  landmark: L.bridge(150, 650, 690, 150, '#244e63') + L.opera(820, 720, '#244e63', '#f8f4ea') });
scene({ key: 'germany', seed: 53, sky: ['#3a3a5c', '#7a6a8a', '#e0b07a', '#f6dca0'], sun: [420, 470, 75, '#ffeec4'], glow: '#ffd38a', far: '#6b5f73', mid: '#45405a', near: '#2a2738', windows: '#ffe2a0',
  landmark: L.tvTower(1150, 720, '#33304a') + L.gate(650, 720, '#33304a') });
scene({ key: 'ireland', seed: 67, sky: ['#5b8fb5', '#8fbfd2', '#d8ecd8', '#f7f2d2'], sun: [1200, 330, 64, '#fffbe3'], glow: '#fff3c0', far: '#5fa877', mid: '#3c8a5a', near: '#226b41', windows: '#fff1b0',
  landmark: L.castle(560, 700, '#2d6a46') + L.roundTower(1060, 715, '#2d6a46') });
scene({ key: 'campus', seed: 79, sky: ['#0B4D2C', '#1d7a4f', '#7fcf9f', '#e9f7ee'], sun: [1240, 300, 70, '#fff6d6'], glow: '#fff1b8', far: '#2f8a5d', mid: '#1c6b45', near: G.deep, windows: '#fff3c4',
  landmark: L.campus(540, 720, '#0e3f27', '#e9f7ee'), extra: L.cap(220, 210, 1.3, '#0e3f27', '#f2c14e') + L.cap(1330, 150, 0.9, '#0e3f27', '#f2c14e') });
scene({ key: 'hero', seed: 97, sky: ['#062A18', '#0B4D2C', '#1f8a5b', '#f2c14e'], sun: [1180, 600, 120, '#ffe7a3'], glow: '#ffd56b', far: '#14603c', mid: '#0d4a2d', near: '#05210f', windows: '#ffe9a6', starsOn: true,
  landmark: L.campus(260, 720, '#083620', '#ffe7a3') + L.bigBen(1000, 720, '#083620', '#ffe7a3'), extra: L.cap(700, 160, 1.6, '#083620', '#f2c14e') + L.cap(1380, 220, 1, '#083620', '#f2c14e') });
scene({ key: 'scholarship', seed: 101, sky: ['#3b2a10', '#8a5a14', '#f2c14e', '#fff3c9'], sun: [800, 380, 110, '#fff8e0'], glow: '#ffe08a', far: '#a87a2a', mid: '#6b4a14', near: '#3a2808', windows: '#fff3c4',
  landmark: L.campus(540, 720, '#4a330c', '#fff3c9'), extra: L.cap(260, 250, 1.4, '#4a330c', '#0B4D2C') + L.cap(1250, 200, 1.1, '#4a330c', '#0B4D2C') });
console.log('covers →', fs.readdirSync(OUT).join(', '));
