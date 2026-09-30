// Dental chart (odontogram): FDI numbering, conditions, entry validation, the chart state rebuilt from the dated entries,
// and the server-rendered SVG. Colours come only from CSS classes (public/css/specialty.css → theme tokens); every
// condition also has a letter code and a pattern so it never depends on colour alone.
const { z, validate, optionalString, isoDate, emptyToUndefined } = require('../../core/validate');
const { E } = require('../../core/errors');

const PERMANENT = { q1: [18, 17, 16, 15, 14, 13, 12, 11], q2: [21, 22, 23, 24, 25, 26, 27, 28], q4: [48, 47, 46, 45, 44, 43, 42, 41], q3: [31, 32, 33, 34, 35, 36, 37, 38] };
const PRIMARY = { q1: [55, 54, 53, 52, 51], q2: [61, 62, 63, 64, 65], q4: [85, 84, 83, 82, 81], q3: [71, 72, 73, 74, 75] };
const ALL_TEETH = new Set([...Object.values(PERMANENT).flat(), ...Object.values(PRIMARY).flat()]);
const isTooth = (n) => ALL_TEETH.has(Number(n));
const isPrimaryTooth = (n) => Number(n) >= 51;

const SURFACES = ['M', 'D', 'O', 'B', 'L'];
// Conditions: `surface` = recorded per surface (required), `tooth` = whole tooth, `either` = surfaces optional.
const CONDITIONS = {
  caries: { scope: 'surface', code: 'C' },
  filling: { scope: 'surface', code: 'F', material: true },
  sealant: { scope: 'surface', code: 'S' },
  fracture: { scope: 'either', code: 'Fr' },
  watch: { scope: 'either', code: 'W' },
  crown: { scope: 'tooth', code: 'Cr', material: true },
  root_canal: { scope: 'tooth', code: 'RC' },
  missing: { scope: 'tooth', code: 'X' },
  implant: { scope: 'tooth', code: 'Im' },
  bridge: { scope: 'tooth', code: 'Br' },
  healthy: { scope: 'either', code: '' },
};
const CONDITION_KEYS = Object.keys(CONDITIONS);
const MATERIALS = ['composite', 'amalgam', 'glass_ionomer', 'ceramic', 'zirconia', 'metal', 'gold', 'temporary'];

function parseSurfaces(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
  const set = new Set(list.map((s) => String(s).trim().toUpperCase()).filter(Boolean));
  const bad = [...set].filter((s) => !SURFACES.includes(s));
  return { surfaces: SURFACES.filter((s) => set.has(s)), bad };
}

const entrySchema = z.object({
  tooth: z.coerce.number({ invalid_type_error: 'Choose a tooth.' }).int().refine(isTooth, 'Choose a tooth.'),
  condition: z.enum(CONDITION_KEYS, { errorMap: () => ({ message: 'Choose an option.' }) }),
  material: z.preprocess(emptyToUndefined, z.enum(MATERIALS, { errorMap: () => ({ message: 'Choose an option.' }) }).optional()),
  entry_date: isoDate(),
  notes: optionalString(1000),
});

/** Validates a chart entry. Returns { tooth, condition, material, surfaces: 'M,O'|null, entry_date, notes }. */
function validateEntry(input, today) {
  const d = validate(entrySchema, { ...input, entry_date: input.entry_date || today });
  const { surfaces, bad } = parseSurfaces(input.surfaces);
  const scope = CONDITIONS[d.condition].scope;
  if (bad.length) throw E.validation({ surfaces: 'Choose an option.' });
  if (scope === 'surface' && !surfaces.length) throw E.validation({ surfaces: 'Choose at least one surface.' });
  if (d.entry_date > today) throw E.validation({ entry_date: 'The date cannot be in the future.' });
  return {
    tooth: d.tooth,
    condition: d.condition,
    material: CONDITIONS[d.condition].material ? (d.material || null) : null,
    surfaces: scope === 'tooth' || !surfaces.length ? null : surfaces.join(','),
    entry_date: d.entry_date,
    notes: d.notes || null,
  };
}

const emptyTooth = () => ({ missing: false, implant: false, crown: null, rootCanal: false, bridge: false, fracture: false, watch: false, surfaces: {} });

/** Rebuilds the current state of every charted tooth from its (non-void) entries, oldest first. */
function chartState(entries) {
  const sorted = [...entries].filter((e) => !e.voided_at).sort((a, b) => (a.entry_date === b.entry_date ? a.id - b.id : a.entry_date < b.entry_date ? -1 : 1));
  const state = {};
  sorted.forEach((e) => {
    const t = state[e.tooth] || (state[e.tooth] = emptyTooth());
    const surfs = e.surfaces ? String(e.surfaces).split(',').filter(Boolean) : [];
    switch (e.condition) {
      case 'healthy':
        if (surfs.length) surfs.forEach((s) => { delete t.surfaces[s]; });
        else state[e.tooth] = emptyTooth();
        break;
      case 'caries': case 'filling': case 'sealant':
        surfs.forEach((s) => { t.surfaces[s] = { condition: e.condition, material: e.material || null }; });
        break;
      case 'fracture': case 'watch':
        if (surfs.length) surfs.forEach((s) => { t.surfaces[s] = { condition: e.condition, material: null }; });
        else t[e.condition] = true;
        break;
      case 'crown': t.crown = e.material || 'crown'; t.fracture = false; break;
      case 'root_canal': t.rootCanal = true; break;
      case 'missing': Object.assign(t, emptyTooth(), { missing: true, bridge: t.bridge }); break;
      case 'implant': Object.assign(t, emptyTooth(), { implant: true, crown: t.crown }); break;
      case 'bridge': t.bridge = true; break;
      default: break;
    }
  });
  return state;
}

/** Condition keys present on a tooth (for its label, legend and summary). */
function toothConditions(t) {
  if (!t) return [];
  const out = new Set();
  if (t.missing) out.add('missing');
  if (t.implant) out.add('implant');
  if (t.crown) out.add('crown');
  if (t.rootCanal) out.add('root_canal');
  if (t.bridge) out.add('bridge');
  if (t.fracture) out.add('fracture');
  if (t.watch) out.add('watch');
  Object.values(t.surfaces).forEach((s) => out.add(s.condition));
  return CONDITION_KEYS.filter((k) => out.has(k));
}

// ---------------------------------------------------------------- SVG
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TW = 44; // tooth cell width
const SQ = 34; // tooth square
const IN = 11; // inner (occlusal) square inset

/** Which drawn side is which surface: upper arch has buccal on top; mesial faces the midline. */
function sideMap(quadrant, upper) {
  const midlineRight = quadrant === 1 || quadrant === 4 || quadrant === 5 || quadrant === 8;
  return { top: upper ? 'B' : 'L', bottom: upper ? 'L' : 'B', left: midlineRight ? 'D' : 'M', right: midlineRight ? 'M' : 'D' };
}

function toothSvg(n, x, t, { upper, labels, selected }) {
  const q = Math.floor(n / 10);
  const x0 = x + (TW - SQ) / 2;
  const y0 = 18;
  const x1 = x0 + SQ; const y1 = y0 + SQ;
  const ix0 = x0 + IN; const iy0 = y0 + IN; const ix1 = x1 - IN; const iy1 = y1 - IN;
  const sides = sideMap(q, upper);
  const polys = {
    [sides.top]: `${x0},${y0} ${x1},${y0} ${ix1},${iy0} ${ix0},${iy0}`,
    [sides.bottom]: `${x0},${y1} ${x1},${y1} ${ix1},${iy1} ${ix0},${iy1}`,
    [sides.left]: `${x0},${y0} ${ix0},${iy0} ${ix0},${iy1} ${x0},${y1}`,
    [sides.right]: `${x1},${y0} ${ix1},${iy0} ${ix1},${iy1} ${x1},${y1}`,
  };
  const st = t || emptyTooth();
  const conds = toothConditions(st);
  const desc = conds.length ? conds.map((c) => {
    const surfs = SURFACES.filter((s) => st.surfaces[s] && st.surfaces[s].condition === c);
    return `${labels.condition(c)}${surfs.length ? ` (${surfs.join(', ')})` : ''}`;
  }).join('، ') : labels.sound;
  let g = `<g class="dc-tooth${st.missing && !st.implant ? ' is-missing' : ''}${selected ? ' is-selected' : ''}" data-tooth="${n}" tabindex="0" role="button" aria-label="${esc(`${labels.tooth} ${n}: ${desc}`)}">`;
  g += `<title>${esc(`${labels.tooth} ${n} — ${desc}`)}</title>`;
  g += `<rect class="dc-hit" x="${x}" y="0" width="${TW}" height="${y1 + 28}"/>`;
  g += `<text class="dc-num" x="${x + TW / 2}" y="12" text-anchor="middle">${n}</text>`;
  SURFACES.forEach((s) => {
    const sc = st.surfaces[s];
    const cls = sc ? ` dc-${sc.condition}` : '';
    const shape = s === 'O' ? `<rect x="${ix0}" y="${iy0}" width="${ix1 - ix0}" height="${iy1 - iy0}"` : `<polygon points="${polys[s]}"`;
    g += `${shape} class="dc-surf${cls}" data-surface="${s}"><title>${esc(`${n} ${labels.surface(s)}${sc ? ` — ${labels.condition(sc.condition)}` : ''}`)}</title>${s === 'O' ? '</rect>' : '</polygon>'}`;
  });
  if (st.crown) g += `<rect class="dc-crown-ring" x="${x0 - 2}" y="${y0 - 2}" width="${SQ + 4}" height="${SQ + 4}" rx="4"/>`;
  if (st.watch) g += `<rect class="dc-watch-ring" x="${x0 - 3}" y="${y0 - 3}" width="${SQ + 6}" height="${SQ + 6}" rx="5"/>`;
  if (st.missing && !st.implant) g += `<path class="dc-x" d="M${x0 + 3},${y0 + 3} L${x1 - 3},${y1 - 3} M${x1 - 3},${y0 + 3} L${x0 + 3},${y1 - 3}"/>`;
  if (st.implant) g += `<path class="dc-implant" d="M${x0 + SQ / 2},${y0 + 6} v${SQ - 12} M${x0 + SQ / 2 - 6},${y0 + 11} h12 M${x0 + SQ / 2 - 5},${y0 + 17} h10 M${x0 + SQ / 2 - 4},${y0 + 23} h8"/>`;
  if (st.fracture) g += `<path class="dc-fracture" d="M${x0 + 8},${y0 - 1} l5,9 l-6,7 l7,9 l-4,10"/>`;
  if (st.rootCanal) g += `<path class="dc-rc" d="M${x0 + SQ / 2},${y1 + 2} v10"/>`;
  if (st.bridge) g += `<path class="dc-bridge" d="M${x},${y0 + SQ / 2} h${TW}"/>`;
  const codes = conds.filter((c) => c !== 'healthy').map((c) => CONDITIONS[c].code).join(' ');
  g += `<text class="dc-code" x="${x + TW / 2}" y="${y1 + 24}" text-anchor="middle">${esc(codes)}</text>`;
  return `${g}</g>`;
}

/** One quadrant as its own SVG (so the chart can reflow to one quadrant per row on a phone). */
function quadrantSvg(teeth, state, opts) {
  const w = teeth.length * TW;
  const h = 18 + SQ + 30;
  const body = teeth.map((n, i) => toothSvg(n, i * TW, state[n], { ...opts, selected: opts.selected === n })).join('');
  return `<svg class="dc-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" dir="ltr" role="group" aria-label="${esc(opts.caption)}">${body}</svg>`;
}

/** The four quadrants in chart order (patient's right on the viewer's left). */
function chartQuadrants(state, { primary, labels, selected }) {
  const set = primary ? PRIMARY : PERMANENT;
  return [['q1', true], ['q2', true], ['q4', false], ['q3', false]].map(([k, upper]) => ({
    key: k,
    caption: labels.quadrant(k),
    svg: quadrantSvg(set[k], state, { upper, labels, selected, caption: labels.quadrant(k) }),
  }));
}

/** Legend swatches as tiny SVGs using the same classes. */
function legendSvg(condition) {
  const box = (cls) => `<svg class="dc-legend-svg" viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">${cls}</svg>`;
  const sq = '<rect class="dc-surf" x="3" y="3" width="16" height="16"/>';
  switch (condition) {
    case 'caries': case 'filling': case 'sealant': return box(`<rect class="dc-surf dc-${condition}" x="3" y="3" width="16" height="16"/>`);
    case 'fracture': return box(`${sq}<path class="dc-fracture" d="M7,2 l4,7 l-4,5 l5,6"/>`);
    case 'watch': return box(`<rect class="dc-surf dc-watch" x="3" y="3" width="16" height="16"/>`);
    case 'crown': return box(`${sq}<rect class="dc-crown-ring" x="2" y="2" width="18" height="18" rx="3"/>`);
    case 'root_canal': return box(`${sq}<path class="dc-rc" d="M11,12 v10"/>`);
    case 'missing': return box(`<rect class="dc-surf" x="3" y="3" width="16" height="16"/><path class="dc-x" d="M5,5 L17,17 M17,5 L5,17"/>`);
    case 'implant': return box(`${sq}<path class="dc-implant" d="M11,5 v12 M7,8 h8 M8,12 h6"/>`);
    case 'bridge': return box(`${sq}<path class="dc-bridge" d="M0,11 h22"/>`);
    default: return box(sq);
  }
}

/** SVG <defs> with the hatch/dot patterns (render once per page). */
const PATTERN_DEFS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>'
  + '<pattern id="dc-p-caries" width="6" height="6" patternUnits="userSpaceOnUse"><rect class="dc-pbg-caries" width="6" height="6"/><circle class="dc-pfg-caries" cx="3" cy="3" r="1.2"/></pattern>'
  + '<pattern id="dc-p-filling" width="6" height="6" patternUnits="userSpaceOnUse"><rect class="dc-pbg-filling" width="6" height="6"/></pattern>'
  + '<pattern id="dc-p-sealant" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="dc-pbg-sealant" width="5" height="5"/><line class="dc-pfg-sealant" x1="0" y1="0" x2="0" y2="5"/></pattern>'
  + '<pattern id="dc-p-watch" width="6" height="6" patternUnits="userSpaceOnUse"><rect class="dc-pbg-watch" width="6" height="6"/><line class="dc-pfg-watch" x1="0" y1="6" x2="6" y2="0"/></pattern>'
  + '<pattern id="dc-p-fracture" width="6" height="6" patternUnits="userSpaceOnUse"><rect class="dc-pbg-fracture" width="6" height="6"/><path class="dc-pfg-fracture" d="M0,3 l3,-3 l3,3"/></pattern>'
  + '</defs></svg>';

module.exports = {
  PERMANENT, PRIMARY, SURFACES, CONDITIONS, CONDITION_KEYS, MATERIALS, isTooth, isPrimaryTooth, parseSurfaces, validateEntry, chartState, toothConditions,
  chartQuadrants, legendSvg, PATTERN_DEFS, sideMap,
};
