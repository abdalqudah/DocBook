// Server-rendered SVG charts (no client library; works under the strict CSP).
// Colours come from CSS tokens (.ch-* classes), so light/dark themes and brand changes apply automatically.
// Every chart has an invisible per-slot hit layer used by the tooltip script in public/js/app.js.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function niceScale(max, ticks = 4) {
  if (!max || max <= 0) return { top: 1, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return { top: step * Math.ceil(max / step), step };
}

/** Axis frame supporting negative values (e.g. monthly net profit). */
function frame({ points, height, fmt, W, series = ['value'] }) {
  const vals = points.flatMap((p) => series.map((k) => p[k])).filter((v) => v !== null && v !== undefined);
  const maxV = Math.max(0, ...vals);
  const minV = Math.min(0, ...vals);
  const pos = niceScale(maxV || (minV < 0 ? 0 : 1));
  const step = minV < 0 ? niceScale(Math.max(maxV, -minV)).step : pos.step;
  const top = maxV > 0 ? step * Math.ceil(maxV / step) : 0;
  const bottom = minV < 0 ? -step * Math.ceil(-minV / step) : 0;
  const range = (top - bottom) || 1;
  const pad = { l: 64, r: 16, t: 20, b: 30 };
  const plotW = W - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const slot = plotW / Math.max(points.length, 1);
  const x = (i) => pad.l + slot * i + slot / 2;
  const y = (v) => pad.t + ((top - v) / range) * plotH;
  let grid = '';
  for (let v = bottom; v <= top + 1e-9; v += step) {
    grid += `<line class="${Math.abs(v) < 1e-9 ? 'ch-zero' : 'ch-grid'}" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
    grid += `<text class="ch-tick" x="${pad.l - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`;
  }
  const every = Math.ceil(points.length / 8);
  let xl = '';
  points.forEach((p, i) => {
    if ((points.length - 1 - i) % every !== 0) return;
    const alt = (points.length - 1 - i) / every;
    xl += `<text class="ch-tick${alt % 2 ? ' ch-xl-alt' : ''}" x="${x(i).toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(p.short || p.label)}</text>`;
  });
  return { pad, plotW, plotH, slot, x, y, top, bottom, grid, xl, W };
}

function hitLayer(points, f, height, tipFor) {
  return points.map((p, i) => {
    const tip = tipFor(p);
    return `<rect class="ch-hit" x="${(f.pad.l + f.slot * i).toFixed(1)}" y="0" width="${f.slot.toFixed(1)}" height="${height - f.pad.b}" tabindex="0" `
      + `data-x="${f.x(i).toFixed(1)}" data-y="${f.pad.t}" data-tip-label="${esc(p.label)}" data-tip-value="${esc(tip)}" aria-label="${esc(p.label)}: ${esc(tip)}"/>`;
  }).join('');
}

const wrap = (svg, { title, height, W }) => `<div class="chart" data-chart><svg class="ch" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(title)}" dir="ltr" preserveAspectRatio="xMidYMid meet">${svg}</svg><div class="chart-tip" hidden><strong data-tip-value></strong><span data-tip-label></span></div></div>`;

/** Line chart; `series` = [{ key, cls }] (first series gets an area wash). */
function line({ points, title, fmt = String, height = 220, width = 640, series = [{ key: 'value', cls: '' }], tipFmt }) {
  const keys = series.map((s) => s.key);
  const f = frame({ points, height, fmt, W: width, series: keys });
  let marks = '';
  series.forEach((s, si) => {
    const pts = points.map((p, i) => (p[s.key] === null || p[s.key] === undefined ? null : [f.x(i), f.y(p[s.key])])).filter(Boolean);
    if (!pts.length) return;
    const d = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
    const base = f.y(Math.max(f.bottom, 0));
    if (si === 0 && pts.length > 1) marks += `<path class="ch-area" d="${d} L${pts[pts.length - 1][0].toFixed(1)},${base.toFixed(1)} L${pts[0][0].toFixed(1)},${base.toFixed(1)} Z"/>`;
    marks += `<path class="ch-line ${s.cls || ''}" d="${d}"/>`;
    const [lx, ly] = pts[pts.length - 1];
    marks += `<circle class="ch-dot ${s.cls || ''}" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4"/>`;
  });
  const cross = `<line class="ch-cross" x1="0" x2="0" y1="${f.pad.t}" y2="${height - f.pad.b}" visibility="hidden"/>`;
  const tipFor = tipFmt || ((p) => series.map((s) => fmt(p[s.key])).join(' · '));
  return wrap(`${f.grid}${f.xl}${cross}${marks}${hitLayer(points, f, height, tipFor)}`, { title, height, W: f.W });
}

/** Column chart; negative values drop below the zero line in the danger colour. Optional second series (grouped). */
function columns({ points, title, fmt = String, height = 220, width = 640, series = [{ key: 'value', cls: '' }], tipFmt, labelMax = true }) {
  const keys = series.map((s) => s.key);
  const f = frame({ points, height, fmt, W: width, series: keys });
  const groupW = Math.min(36, f.slot - 6);
  const bw = Math.max(3, (groupW - (keys.length - 1) * 3) / keys.length);
  const zero = f.y(0);
  let marks = '';
  let maxI = -1; let maxV = -Infinity;
  points.forEach((p, i) => { if ((p[keys[0]] || 0) > maxV) { maxV = p[keys[0]] || 0; maxI = i; } });
  points.forEach((p, i) => {
    keys.forEach((k, ki) => {
      const v = p[k];
      if (!v) return;
      const x0 = f.x(i) - groupW / 2 + ki * (bw + 3);
      const yv = f.y(v);
      const topY = Math.min(yv, zero); const h = Math.abs(zero - yv); const r = Math.min(4, h, bw / 2);
      const cls = `ch-bar ${series[ki].cls || ''} ${v < 0 ? 'neg' : ''}`;
      if (v >= 0) marks += `<path class="${cls}" d="M${x0.toFixed(1)},${zero.toFixed(1)} V${(topY + r).toFixed(1)} Q${x0.toFixed(1)},${topY.toFixed(1)} ${(x0 + r).toFixed(1)},${topY.toFixed(1)} H${(x0 + bw - r).toFixed(1)} Q${(x0 + bw).toFixed(1)},${topY.toFixed(1)} ${(x0 + bw).toFixed(1)},${(topY + r).toFixed(1)} V${zero.toFixed(1)} Z"/>`;
      else marks += `<path class="${cls}" d="M${x0.toFixed(1)},${zero.toFixed(1)} V${(zero + h - r).toFixed(1)} Q${x0.toFixed(1)},${(zero + h).toFixed(1)} ${(x0 + r).toFixed(1)},${(zero + h).toFixed(1)} H${(x0 + bw - r).toFixed(1)} Q${(x0 + bw).toFixed(1)},${(zero + h).toFixed(1)} ${(x0 + bw).toFixed(1)},${(zero + h - r).toFixed(1)} V${zero.toFixed(1)} Z"/>`;
    });
  });
  if (labelMax && maxI >= 0 && maxV > 0) marks += `<text class="ch-label" x="${f.x(maxI).toFixed(1)}" y="${(f.y(maxV) - 6).toFixed(1)}" text-anchor="middle">${esc(fmt(maxV))}</text>`;
  const tipFor = tipFmt || ((p) => series.map((s) => fmt(p[s.key])).join(' · '));
  return wrap(`${f.grid}${f.xl}${marks}${hitLayer(points, f, height, tipFor)}`, { title, height, W: f.W });
}

/** Horizontal bars (HTML, so long labels wrap and RTL works). */
function bars({ items, fmt = String, max, emptyLabel = '—' }) {
  const top = max || Math.max(...items.map((i) => Math.abs(i.value || 0)), 1);
  return `<div class="hbars">${items.map((i) => `<div class="hbar"><span class="hbar-label" dir="auto" title="${esc(i.label || emptyLabel)}">${esc(i.label || emptyLabel)}</span>`
    + `<span class="hbar-track"><span class="hbar-fill ${i.cls || ''}${(i.value || 0) < 0 ? ' neg' : ''}" style="width:${Math.max(0, Math.min(100, (Math.abs(i.value || 0) / top) * 100)).toFixed(1)}%"></span></span>`
    + `<span class="hbar-value">${esc(i.value === null || i.value === undefined ? '—' : fmt(i.value))}${i.note ? `<span class="muted tiny"> ${esc(i.note)}</span>` : ''}</span></div>`).join('')}</div>`;
}

/** Donut with legend (up to 8 slices; the rest grouped). */
function donut({ items, fmt = String, title = '', otherLabel = 'Other' }) {
  const sorted = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 7);
  const rest = sorted.slice(7).reduce((s, i) => s + i.value, 0);
  if (rest > 0) top.push({ label: otherLabel, value: rest });
  const total = top.reduce((s, i) => s + i.value, 0);
  const R = 52; const C = 2 * Math.PI * R;
  let off = 0;
  const arcs = top.map((i, idx) => {
    const len = total ? (i.value / total) * C : 0;
    const seg = `<circle class="d${idx + 1}" r="${R}" cx="70" cy="70" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"><title>${esc(i.label)}: ${esc(fmt(i.value))}</title></circle>`;
    off += len;
    return seg;
  }).join('');
  const legend = top.map((i, idx) => `<span><i class="d${idx + 1}"></i>${esc(i.label)} <strong class="num">${total ? Math.round((i.value / total) * 100) : 0}%</strong></span>`).join('');
  return `<div class="donut-wrap"><svg class="donut" viewBox="0 0 140 140" role="img" aria-label="${esc(title)}"><g transform="rotate(-90 70 70)"><circle class="track" r="${R}" cx="70" cy="70"/>${arcs}</g></svg><div class="legend" style="flex-direction:column;gap:6px">${legend}</div></div>`;
}

module.exports = { line, columns, bars, donut, niceScale };
