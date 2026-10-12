// Server-rendered line chart of one measure over time (SVG, no client library): one or two series on a date axis,
// the target band shaded behind them, out-of-range values drawn as a ringed dot in the danger colour. Colours come
// from CSS tokens (.ch-* in app.css, .ck-* next to them); the tooltip is the app's chart script (.chart[data-chart]).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function ticks(min, max, count = 4) {
  const raw = (max - min) / count || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const list = [];
  for (let v = lo; v <= hi + 1e-9; v += step) list.push(Math.round(v * 1000) / 1000);
  return { lo, hi: hi === lo ? lo + step : hi, list };
}

const timeOf = (p) => Date.parse(`${p.on}T${p.time || '12:00'}:00Z`);

/**
 * @param {object} o {
 *   title, series: [{ key, cls, label, target: { lo, hi } | null, points: [{ on, time, v, out }] }],
 *   fmt(v) → text, dateFmt(on) → short date text, tip(point, series) → tooltip value, outLabel }
 */
function render(o) {
  const W = 640; const H = 240;
  const pad = { l: 44, r: 16, t: 14, b: 30 };
  const all = o.series.flatMap((s) => s.points);
  if (!all.length) return '';
  const bandVals = o.series.flatMap((s) => (s.target ? [s.target.lo, s.target.hi] : [])).filter((v) => v !== null && v !== undefined);
  const vals = all.map((p) => p.v);
  const vMin = Math.min(...vals); const vMax = Math.max(...vals);
  // the band is in view when the values are near it; a far-away bound does not squash the line
  const span = Math.max(vMax - vMin, Math.abs(vMax) * 0.1, 1);
  const near = bandVals.filter((b) => b >= vMin - span && b <= vMax + span);
  const ys = ticks(Math.min(vMin, ...near), Math.max(vMax, ...near));
  const times = all.map(timeOf);
  let t0 = Math.min(...times); let t1 = Math.max(...times);
  if (t1 - t0 < 86_400_000) { t0 -= 3 * 86_400_000; t1 += 3 * 86_400_000; } // one day: centred
  const plotW = W - pad.l - pad.r; const plotH = H - pad.t - pad.b;
  const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * plotW;
  const y = (v) => pad.t + ((ys.hi - v) / (ys.hi - ys.lo || 1)) * plotH;
  const clampY = (v) => Math.max(pad.t, Math.min(H - pad.b, y(v)));
  let svg = '';
  // target bands (behind everything)
  o.series.forEach((s) => {
    if (!s.target || (s.target.lo === null && s.target.hi === null)) return;
    const top = clampY(s.target.hi === null ? ys.hi : s.target.hi);
    const bottom = clampY(s.target.lo === null ? ys.lo : s.target.lo);
    if (bottom - top < 0.5) return;
    svg += `<rect class="ck-band ${s.cls || ''}" x="${pad.l}" y="${top.toFixed(1)}" width="${plotW}" height="${(bottom - top).toFixed(1)}"><title>${esc(s.label || '')}</title></rect>`;
  });
  ys.list.forEach((v) => {
    svg += `<line class="ch-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
    svg += `<text class="ch-tick" x="${pad.l - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(o.fmt(v))}</text>`;
  });
  // date ticks: the first and last day, and up to three between
  const days = [...new Set(all.map((p) => p.on))].sort();
  const n = Math.min(days.length, 5);
  const shown = n <= 1 ? days : Array.from({ length: n }, (_, i) => days[Math.round((i * (days.length - 1)) / (n - 1))]);
  [...new Set(shown)].forEach((on) => {
    svg += `<text class="ch-tick" x="${x(Date.parse(`${on}T12:00:00Z`)).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(o.dateFmt(on))}</text>`;
  });
  svg += `<line class="ch-cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>`;
  o.series.forEach((s) => {
    const pts = s.points.map((p) => ({ p, px: x(timeOf(p)), py: y(p.v) }));
    if (pts.length > 1) svg += `<path class="ch-line ${s.cls || ''}" d="${pts.map((q, i) => `${i ? 'L' : 'M'}${q.px.toFixed(1)},${q.py.toFixed(1)}`).join(' ')}"/>`;
    pts.forEach((q) => {
      if (q.p.out) svg += `<circle class="ck-out-ring" cx="${q.px.toFixed(1)}" cy="${q.py.toFixed(1)}" r="7"/>`;
      svg += `<circle class="ch-dot ${s.cls || ''}${q.p.out ? ' ck-out' : ''}" cx="${q.px.toFixed(1)}" cy="${q.py.toFixed(1)}" r="4"${q.p.out ? ' data-out="1"' : ''}/>`;
    });
  });
  // hit targets last, so they sit on top
  o.series.forEach((s) => {
    s.points.forEach((p) => {
      const px = x(timeOf(p)); const py = y(p.v);
      const tip = `${o.tip(p, s)}${p.out ? ` · ${o.outLabel}` : ''}`;
      const label = `${s.label ? `${s.label} · ` : ''}${o.dateFmt(p.on)}${p.time ? ` ${p.time}` : ''}`;
      svg += `<rect class="ch-hit" x="${(px - 9).toFixed(1)}" y="${(py - 9).toFixed(1)}" width="18" height="18" rx="9" tabindex="0" data-x="${px.toFixed(1)}" data-y="${py.toFixed(1)}" data-tip-label="${esc(label)}" data-tip-value="${esc(tip)}" aria-label="${esc(`${label}: ${tip}`)}"/>`;
    });
  });
  return `<div class="chart ck-chart" data-chart><svg class="ch" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title)}" dir="ltr" preserveAspectRatio="xMidYMid meet">${svg}</svg><div class="chart-tip" hidden><strong data-tip-value></strong><span data-tip-label></span></div></div>`;
}

module.exports = { render };
