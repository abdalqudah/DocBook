// DocBook's own specialty icons (drawn for DocBook in the Lucide style: 24×24, 2px round strokes, no fill), added to
// public/icons.svg by scripts/build-icons.js after the Lucide icons. Names start with the specialty: dt- = dentistry.
const TOOTH = 'M12 5.5c-1.5-1.3-3.6-2-5.2-1.2C4.6 5.3 4.3 8 5 10.5c.6 2 .9 3.8 1 6 .1 2 .6 4.5 2 4.5 1.3 0 1.6-2.1 2-3.8.3-1.3.9-2.2 2-2.2s1.7.9 2 2.2c.4 1.7.7 3.8 2 3.8 1.4 0 1.9-2.5 2-4.5.1-2.2.4-4 1-6 .7-2.5.4-5.2-1.8-6.2-1.6-.8-3.7-.1-5.2 1.2Z';
// A smaller tooth placed somewhere in the box (the stroke is widened to stay 2px after scaling).
const small = (x, y, s = 0.72) => `<g transform="translate(${x} ${y}) scale(${s})" stroke-width="${(2 / s).toFixed(2)}"><path d="${TOOTH}" /></g>`;

module.exports = {
  'dt-tooth': `<path d="${TOOTH}" />`,
  'dt-whitening': `${small(0, 6)}<path d="M18 2v5" /><path d="M15.5 4.5h5" /><path d="M21 9.5v2" /><path d="M20 10.5h2" />`,
  'dt-caries': `<path d="${TOOTH}" /><circle cx="14" cy="9" r="1.6" /><path d="M10 7.5h.01" />`,
  'dt-filling': `<path d="${TOOTH}" /><path d="M9.5 7.5h5v3h-5z" />`,
  'dt-crown': `${small(3.4, 7, 0.72)}<path d="m6 7.5-1-4.5 3.5 2L12 2l3.5 3L19 3l-1 4.5Z" />`,
  'dt-implant': '<path d="M7 3h10c0 3-2 5-5 5S7 6 7 3Z" /><path d="M10 8v2h4V8" /><path d="M10 10h4l-.6 8.5L12 21l-1.4-2.5Z" /><path d="M9 12.5h6" /><path d="M9.3 15h5.4" /><path d="M9.8 17.5h4.4" />',
  'dt-braces': '<rect x="2.5" y="5" width="6" height="14" rx="2.5" /><rect x="9" y="5" width="6" height="14" rx="2.5" /><rect x="15.5" y="5" width="6" height="14" rx="2.5" /><path d="M2 12h20" /><rect x="4.5" y="10.5" width="2" height="3" rx=".5" /><rect x="11" y="10.5" width="2" height="3" rx=".5" /><rect x="17.5" y="10.5" width="2" height="3" rx=".5" />',
  'dt-root-canal': `<path d="${TOOTH}" /><path d="M9.5 9c1.5-1.5 3.5-1.5 5 0" /><path d="M9.8 9.5 9 17" /><path d="M14.2 9.5 15 17" />`,
  'dt-extraction': `<g transform="rotate(-12 9 13)">${small(1, 6, 0.68)}</g><path d="M19 11V3" /><path d="m16 6 3-3 3 3" />`,
  'dt-xray': `<rect x="2.5" y="2.5" width="19" height="19" rx="3" />${small(5.6, 5.4, 0.54)}<path d="M18 6.5v1" /><path d="M18 16.5v1" />`,
  'dt-dentures': '<path d="M3 10.5C3 7 7 4 12 4s9 3 9 6.5V11H3Z" /><path d="M7.5 6.5V11" /><path d="M10.5 5.2V11" /><path d="M13.5 5.2V11" /><path d="M16.5 6.5V11" /><path d="M3 13h18v.5c0 3.5-4 6.5-9 6.5s-9-3-9-6.5Z" /><path d="M7.5 13v4.5" /><path d="M10.5 13v5.8" /><path d="M13.5 13v5.8" /><path d="M16.5 13v4.5" />',
  'dt-veneer': `${small(0.6, 3.5, 0.78)}<path d="M18.5 4.5c2.6 2.6 2.6 8.4 0 11" /><path d="M21 6.5c1 2 1 5 0 7" />`,
  'dt-bridge': '<path d="M2.5 6.5h19" /><path d="M3 6.5v4.5a2.5 2.5 0 0 0 5 0V6.5" /><path d="M9.5 6.5v5a2.5 2.5 0 0 0 5 0v-5" /><path d="M16 6.5v4.5a2.5 2.5 0 0 0 5 0V6.5" /><path d="m4.2 13 .6 7" /><path d="m6.8 13-.3 7" /><path d="m17.2 13 .3 7" /><path d="m19.8 13-.6 7" />',
  'dt-gum': '<path d="M7 11V7.5C7 5 8.5 3.5 10 3.5c.8 0 1.4.4 2 1 .6-.6 1.2-1 2-1 1.5 0 3 1.5 3 4V11" /><path d="M2.5 12c3.2-2 6.3 0 9.5 0s6.3-2 9.5 0" /><path d="M2.5 12c0 2 1.5 3 3 3" /><path d="M21.5 12c0 2-1.5 3-3 3" /><path d="M9.5 14.5 9 20" /><path d="m14.5 14.5.5 5.5" />',
  'dt-kids': `<path d="${TOOTH}" /><path d="M9.5 8h.01" /><path d="M14.5 8h.01" /><path d="M9.8 11c1.2 1.2 3.2 1.2 4.4 0" />`,
  'dt-protect': `<path d="${TOOTH}" /><path d="m9.3 9 1.8 1.8 3.6-3.6" />`,
  'dt-pain': `${small(0, 5, 0.72)}<path d="m19.5 2-2.5 4h4l-2.5 4" />`,
  'dt-mirror': '<circle cx="16.5" cy="7.5" r="4.5" /><path d="M13.3 10.7 3.5 20.5" /><path d="M15 6c.5-.6 1.2-.9 2-.8" />',
  'dt-scaler': '<path d="M3.5 20.5 14 10" /><path d="M14 10c1.4-1.4 2.6-3 2.6-4.7 0-1.3-1-2-2.2-1.6" /><path d="m6 15.5 2.5 2.5" />',
  'dt-chair': '<path d="M5 3v9a2 2 0 0 0 2 2h7.5l3.5 4.5" /><path d="M5 12h9" /><path d="M9 14v6.5" /><path d="M5.5 20.5h7" /><path d="M14 4h6" /><path d="M17 4v4" /><path d="M15 8h4" />',
  'dt-aligner': '<path d="M4.5 5c0 7.5 3.3 14 7.5 14s7.5-6.5 7.5-14" /><path d="M8 5c0 5.5 1.8 10 4 10s4-4.5 4-10" /><path d="M4.5 5H8" /><path d="M16 5h3.5" />',
  'dt-floss': '<rect x="3.5" y="11" width="10" height="9.5" rx="2" /><path d="M8.5 11V8" /><path d="M8.5 8c3-3.5 8-3.5 12 0" /><path d="M6.5 15h4" />',
  'dt-smile': '<path d="M2.5 9.5c3 6 16 6 19 0" /><path d="M2.5 9.5c4-1.3 15-1.3 19 0" /><path d="M7.5 10.8v2.6" /><path d="M12 11v3.2" /><path d="M16.5 10.8v2.6" />',
  'dt-scan': `<path d="M3 7.5V5a2 2 0 0 1 2-2h2.5" /><path d="M16.5 3H19a2 2 0 0 1 2 2v2.5" /><path d="M21 16.5V19a2 2 0 0 1-2 2h-2.5" /><path d="M7.5 21H5a2 2 0 0 1-2-2v-2.5" />${small(5.9, 5.5, 0.51)}`,
};
