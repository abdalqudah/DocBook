// Generated artwork for universities that have no photo / logo yet: a campus scene and a crest with the
// initials, deterministic per university (the same slug always gives the same picture) and tinted by country.
// Served at /art/uni/<slug>.svg and /art/crest/<slug>.svg; real photos and logos uploaded by staff sit on top.
const PALETTES = {
  GB: { sky: ['#2b3a67', '#6a6aa6', '#e7b2a3'], ink: '#1f2246', accent: '#f7d9a6' },
  US: { sky: ['#5b4b8a', '#d9667d', '#ffb36b'], ink: '#3a2550', accent: '#ffe4a3' },
  CA: { sky: ['#0d2b3e', '#1f8a7a', '#9fe0c0'], ink: '#0d3440', accent: '#e8fff3' },
  AU: { sky: ['#2f7fbf', '#7fc2e6', '#ffd59a'], ink: '#244e63', accent: '#fff1c7' },
  DE: { sky: ['#3a3a5c', '#8a7a9a', '#f0c88a'], ink: '#33304a', accent: '#ffeec4' },
  IE: { sky: ['#5b8fb5', '#a6d0dc', '#f7f2d2'], ink: '#2d6a46', accent: '#fffbe3' },
  default: { sky: ['#0B4D2C', '#2f9a66', '#d9f2e2'], ink: '#0e3f27', accent: '#f2c14e' },
};
const W = 1200; const H = 675;

function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let s = seed % 2147483647 || 1; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
const r1 = (n) => Math.round(n * 10) / 10;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Initials for a crest: "University of Leeds" → "UL", "Illinois Institute of Technology" → "IIT". */
function initials(name) {
  const words = String(name || '?').replace(/\(.*?\)/g, '').split(/[\s-]+/).filter((w) => w && !/^(of|the|and|for|at|in|de|du|la)$/i.test(w));
  return (words.slice(0, 3).map((w) => w[0]).join('') || '?').toUpperCase();
}

/** Campus hall: columns + pediment, or tower, or modern blocks — picked by the seed. */
function building(rand, x, base, ink, accent) {
  const kind = Math.floor(rand() * 3);
  const w = 300 + rand() * 120;
  let s = '';
  if (kind === 0) { // classical hall with dome
    s += `<rect x="${r1(x)}" y="${base - 150}" width="${r1(w)}" height="150" fill="${ink}"/><path d="M${r1(x - 16)} ${base - 150} L${r1(x + w / 2)} ${base - 225} L${r1(x + w + 16)} ${base - 150}Z" fill="${ink}"/>`;
    s += `<rect x="${r1(x + w / 2 - 50)}" y="${base - 270}" width="100" height="50" fill="${ink}"/><path d="M${r1(x + w / 2 - 50)} ${base - 270} Q${r1(x + w / 2)} ${base - 350} ${r1(x + w / 2 + 50)} ${base - 270}Z" fill="${ink}"/>`;
    for (let i = 0; i < 7; i += 1) s += `<rect x="${r1(x + 24 + i * ((w - 60) / 6))}" y="${base - 132}" width="14" height="132" fill="${accent}" opacity=".32"/>`;
  } else if (kind === 1) { // gothic tower and wings
    s += `<rect x="${r1(x)}" y="${base - 120}" width="${r1(w)}" height="120" fill="${ink}"/><rect x="${r1(x + w / 2 - 34)}" y="${base - 300}" width="68" height="300" fill="${ink}"/><path d="M${r1(x + w / 2 - 40)} ${base - 300} L${r1(x + w / 2)} ${base - 380} L${r1(x + w / 2 + 40)} ${base - 300}Z" fill="${ink}"/>`;
    s += `<circle cx="${r1(x + w / 2)}" cy="${base - 250}" r="16" fill="${accent}" opacity=".85"/>`;
    for (let i = 0; i < 8; i += 1) s += `<path d="M${r1(x + 16 + i * ((w - 40) / 7))} ${base - 40} v-46 a9 9 0 0 1 18 0 v46z" fill="${accent}" opacity=".35"/>`;
  } else { // modern glass blocks
    const n = 3 + Math.floor(rand() * 2);
    for (let i = 0; i < n; i += 1) {
      const bw = w / n - 8; const bh = 140 + rand() * 150; const bx = x + i * (w / n);
      s += `<rect x="${r1(bx)}" y="${r1(base - bh)}" width="${r1(bw)}" height="${r1(bh)}" rx="6" fill="${ink}"/>`;
      for (let yy = base - bh + 16; yy < base - 18; yy += 22) s += `<rect x="${r1(bx + 10)}" y="${r1(yy)}" width="${r1(bw - 20)}" height="8" rx="2" fill="${accent}" opacity=".3"/>`;
    }
  }
  return { svg: s, width: w };
}
const tree = (x, base, s, fill) => `<rect x="${r1(x - 4 * s)}" y="${r1(base - 40 * s)}" width="${r1(8 * s)}" height="${r1(40 * s)}" fill="${fill}"/><circle cx="${r1(x)}" cy="${r1(base - 60 * s)}" r="${r1(34 * s)}" fill="${fill}"/><circle cx="${r1(x - 22 * s)}" cy="${r1(base - 44 * s)}" r="${r1(24 * s)}" fill="${fill}"/><circle cx="${r1(x + 24 * s)}" cy="${r1(base - 46 * s)}" r="${r1(26 * s)}" fill="${fill}"/>`;

function campusCover(slug, countryCode) {
  const pal = PALETTES[String(countryCode || '').toUpperCase()] || PALETTES.default;
  const rand = rng(hash(slug));
  const base = 560;
  const sunX = 140 + rand() * (W - 280);
  const b = building(rand, 300 + rand() * 260, base, pal.ink, pal.accent);
  let trees = '';
  for (let i = 0; i < 7; i += 1) { const tx = rand() * W; trees += tree(tx, base + 20 + rand() * 30, 0.7 + rand() * 0.6, pal.ink); }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal.sky[0]}"/><stop offset=".6" stop-color="${pal.sky[1]}"/><stop offset="1" stop-color="${pal.sky[2]}"/></linearGradient><linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".3"/></linearGradient></defs>`
    + `<rect width="${W}" height="${H}" fill="url(#s)"/><circle cx="${r1(sunX)}" cy="${r1(150 + rand() * 120)}" r="${r1(50 + rand() * 30)}" fill="${pal.accent}" opacity=".9"/>`
    + `<path d="M0 ${base - 40} Q${W * 0.25} ${base - 110} ${W * 0.5} ${base - 60} T${W} ${base - 70} V${H} H0Z" fill="${pal.ink}" opacity=".35"/>`
    + b.svg + `<path d="M0 ${base} Q${W / 2} ${base - 18} ${W} ${base} V${H} H0Z" fill="${pal.ink}"/>` + trees
    + `<path d="M${W / 2 - 40} ${H} L${W / 2 - 6} ${base} H${W / 2 + 6} L${W / 2 + 40} ${H}Z" fill="${pal.accent}" opacity=".25"/>`
    + `<rect width="${W}" height="${H}" fill="url(#f)"/></svg>`;
}

function crest(slug, name, countryCode) {
  const pal = PALETTES[String(countryCode || '').toUpperCase()] || PALETTES.default;
  const ini = initials(name);
  const fs = ini.length > 2 ? 30 : 38;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="24" fill="${pal.sky[0]}"/>`
    + `<path d="M60 16 L96 28 V58 C96 82 80 98 60 106 C40 98 24 82 24 58 V28Z" fill="${pal.ink}" stroke="${pal.accent}" stroke-width="3"/>`
    + `<path d="M40 40 L60 32 L80 40 L60 48Z" fill="${pal.accent}"/>`
    + `<text x="60" y="${ini.length > 2 ? 80 : 82}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="${fs}" fill="${pal.accent}">${esc(ini)}</text></svg>`;
}

module.exports = { campusCover, crest, initials, PALETTES };
