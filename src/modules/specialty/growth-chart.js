// Server-rendered growth chart (SVG): WHO percentile curves (P3, P15, P50, P85, P97) in greys, the child's values in
// --primary. Continuous x-axis (age in months). Reuses the app's chart classes/tooltips (.chart[data-chart], .ch-hit).
const growth = require('./growth');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DAYS_PER_MONTH = 30.4375;

function ticks(min, max, count = 5) {
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return { lo, hi, step, list: out };
}

/**
 * @param {object} o { indicator, sex, points: [{ ageDays, value, label, tip }], title, unit, fmt, withCurves }
 */
function render(o) {
  const W = 640; const H = 300;
  const pad = { l: 44, r: 40, t: 14, b: 34 };
  const maxAge = Math.max(0, ...o.points.map((p) => p.ageDays));
  const monthsMax = maxAge <= 700 ? 24 : maxAge <= 1060 ? 36 : maxAge <= growth.MAX_DAY ? 60 : Math.ceil(maxAge / DAYS_PER_MONTH / 12) * 12;
  const toDay = monthsMax === 24 ? 731 : monthsMax === 60 ? growth.MAX_DAY : Math.round(monthsMax * DAYS_PER_MONTH);
  const curves = o.withCurves && o.sex ? growth.curves(o.indicator, o.sex, toDay, monthsMax <= 36 ? 7 : 14) : [];
  const vals = [...curves.flatMap((c) => c.pts.map((p) => p[1])), ...o.points.map((p) => p.value)].filter((v) => Number.isFinite(v));
  if (!vals.length) return '';
  const ys = ticks(Math.min(...vals), Math.max(...vals));
  const plotW = W - pad.l - pad.r; const plotH = H - pad.t - pad.b;
  const x = (d) => pad.l + (Math.min(d, toDay) / toDay) * plotW;
  const y = (v) => pad.t + ((ys.hi - v) / (ys.hi - ys.lo || 1)) * plotH;
  let svg = '';
  ys.list.forEach((v) => {
    svg += `<line class="ch-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
    svg += `<text class="ch-tick" x="${pad.l - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(o.fmt(v))}</text>`;
  });
  const monthStep = monthsMax === 24 ? 3 : monthsMax <= 60 ? 6 : 12;
  for (let m = 0; m <= monthsMax; m += monthStep) {
    const px = x(m * DAYS_PER_MONTH);
    svg += `<line class="gc-vgrid" x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${pad.t}" y2="${H - pad.b}"/>`;
    svg += `<text class="ch-tick" x="${px.toFixed(1)}" y="${H - pad.b + 16}" text-anchor="middle">${m}</text>`;
  }
  svg += `<text class="ch-tick gc-axis" x="${W - pad.r}" y="${H - 4}" text-anchor="end">${esc(o.xLabel)}</text>`;
  let lastLabelY = Infinity;
  curves.forEach((c) => {
    const d = c.pts.map(([dd, v], i) => `${i ? 'L' : 'M'}${x(dd).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    svg += `<path class="gc-curve${c.p === 50 ? ' is-median' : ''}${c.p === 3 || c.p === 97 ? ' is-outer' : ''}" d="${d}"/>`;
  });
  // Labels at the right end, from P3 upwards; a label too close to the one below it is skipped (P50 always shown).
  curves.forEach((c) => {
    const last = c.pts[c.pts.length - 1];
    const ly = y(last[1]) + 4;
    if (c.p !== 50 && lastLabelY - ly < 10) return;
    lastLabelY = ly;
    svg += `<text class="gc-plabel" x="${(x(last[0]) + 4).toFixed(1)}" y="${ly.toFixed(1)}">P${c.p}</text>`;
  });
  const pts = o.points.filter((p) => Number.isFinite(p.value) && p.ageDays >= 0).sort((a, b) => a.ageDays - b.ageDays);
  if (pts.length > 1) svg += `<path class="ch-line" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ageDays).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')}"/>`;
  svg += `<line class="ch-cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>`;
  pts.forEach((p) => {
    const cx = x(p.ageDays); const cy = y(p.value);
    svg += `<circle class="ch-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4"/>`;
    svg += `<rect class="ch-hit gc-hit" x="${(cx - 9).toFixed(1)}" y="${(cy - 9).toFixed(1)}" width="18" height="18" rx="9" tabindex="0" data-x="${cx.toFixed(1)}" data-y="${cy.toFixed(1)}" data-tip-label="${esc(p.label)}" data-tip-value="${esc(p.tip)}" aria-label="${esc(`${p.label}: ${p.tip}`)}"/>`;
  });
  return `<div class="chart gc" data-chart><svg class="ch" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title)}" dir="ltr" preserveAspectRatio="xMidYMid meet">${svg}</svg><div class="chart-tip" hidden><strong data-tip-value></strong><span data-tip-label></span></div></div>`;
}

module.exports = { render, DAYS_PER_MONTH };
