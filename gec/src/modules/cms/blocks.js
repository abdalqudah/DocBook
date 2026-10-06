// Page builder: a page is a list of content blocks (hero, text, image + text, features, numbers, call to action,
// questions, program list, gallery, video). Editing is plain HTML forms — every change (add, move, remove) is a
// server round trip, so it works without JavaScript and every value is validated here.
const ref = require('../catalog/reference');

// Invalid values stay in the block (so the form shows what was typed) with an error; the caller refuses to save.
// Field kinds: t = short text, ta = text area, md = Markdown, lines = one item per line (parts split by |),
// img = image (https:// or /media/…), href = link (/path or https://), sel = choice, int = number.
const TYPES = {
  hero: { icon: 'panel-top', fields: [['eyebrow', 't', true], ['title', 't', true], ['text', 'ta', true], ['image', 'img'], ['cta_label', 't', true], ['cta_href', 'href'], ['cta2_label', 't', true], ['cta2_href', 'href']] },
  text: { icon: 'type', fields: [['title', 't', true], ['body', 'md', true]] },
  image_text: { icon: 'columns-2', fields: [['title', 't', true], ['body', 'md', true], ['image', 'img'], ['side', 'sel', false, ['end', 'start']], ['cta_label', 't', true], ['cta_href', 'href']] },
  features: { icon: 'layout-grid', fields: [['title', 't', true], ['lead', 'ta', true], ['items', 'lines', true]] },
  stats: { icon: 'bar-chart-3', fields: [['title', 't', true], ['items', 'lines', true]] },
  cta: { icon: 'megaphone', fields: [['title', 't', true], ['text', 'ta', true], ['cta_label', 't', true], ['cta_href', 'href']] },
  faq: { icon: 'circle-help', fields: [['title', 't', true], ['items', 'lines', true]] },
  programs: { icon: 'graduation-cap', fields: [['title', 't', true], ['country', 'sel', false, () => ['', ...ref.ISO]], ['degree', 'sel', false, () => ['', ...ref.DEGREES]], ['field', 'sel', false, () => ['', ...ref.FIELDS]], ['limit', 'int']] },
  gallery: { icon: 'images', fields: [['title', 't', true], ['images', 'lines']] },
  video: { icon: 'video', fields: [['title', 't', true], ['url', 't']] },
};
const MAX_BLOCKS = 40;
const LIMITS = { t: 200, ta: 1200, md: 12000, lines: 6000, img: 500, href: 500, int: 3 };

const isHref = (v) => /^(\/(?!\/)[^\s]*|https:\/\/[^\s]+|mailto:[^\s]+|tel:[+\d\s-]+)$/.test(v);
const isImg = (v) => /^(https:\/\/[^\s"'()]+|\/media\/\d+|\/(img|art)\/[a-z0-9/._-]+)$/.test(v);

/** Embeddable video address (YouTube or Vimeo) or null. */
function videoEmbed(url) {
  const s = String(url || '').trim();
  let m = /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(s);
  if (m) return `https://www.youtube-nocookie.com/embed/${m[1]}`;
  m = /^https:\/\/(?:www\.)?vimeo\.com\/(\d{5,12})/.exec(s);
  return m ? `https://player.vimeo.com/video/${m[1]}?dnt=1` : null;
}

const optionsOf = (f) => (typeof f[3] === 'function' ? f[3]() : f[3] || []);

/** Cleans one block from form input; returns { block, errors }. */
function clean(raw) {
  const type = TYPES[raw && raw.type] ? raw.type : null;
  if (!type) return { block: null, errors: {} };
  const block = { type, hidden: raw.hidden === '1' || raw.hidden === true };
  const errors = {};
  for (const f of TYPES[type].fields) {
    const [name, kind, bi] = f;
    const names = bi ? [`${name}_en`, `${name}_ar`] : [name];
    for (const n of names) {
      let v = raw[n] === undefined || raw[n] === null ? '' : String(raw[n]).replace(/\r\n/g, '\n').trim();
      v = v.slice(0, LIMITS[kind] || 200);
      if (!v) continue; // eslint-disable-line no-continue
      if (kind === 'img' && !isImg(v)) { errors[n] = 'Use an https:// image address or choose from the library.'; } // eslint-disable-line no-continue
      if (kind === 'href' && !isHref(v)) { errors[n] = 'Use a page address (/contact) or a full https:// link.'; } // eslint-disable-line no-continue
      if (kind === 'sel' && !optionsOf(f).includes(v)) continue; // eslint-disable-line no-continue
      if (kind === 'int') { const num = Math.max(1, Math.min(12, Number.parseInt(v, 10) || 0)); if (num) block[n] = num; continue; } // eslint-disable-line no-continue
      if (n === 'url' && type === 'video' && !videoEmbed(v)) { errors[n] = 'Paste a YouTube or Vimeo link.'; } // eslint-disable-line no-continue
      if (kind === 'lines' && name === 'images') { const bad = v.split('\n').map((x) => x.split('|')[0].trim()).filter((x) => x && !isImg(x)); if (bad.length) errors[n] = 'Each line must be an https:// image address or /media/… from the library.'; } // eslint-disable-line no-continue
      block[n] = v;
    }
  }
  return { block, errors };
}

/** Parses the builder form: blocks[i][…] plus one operation (add / up / down / remove / duplicate). */
function fromForm(body) {
  const raw = body && body.b ? (Array.isArray(body.b) ? body.b : Object.keys(body.b).sort((a, b) => a - b).map((k) => body.b[k])) : [];
  const blocks = []; const errors = {};
  raw.slice(0, MAX_BLOCKS).forEach((r) => {
    const { block, errors: e } = clean(r);
    if (!block) return;
    Object.entries(e).forEach(([k, v]) => { errors[`${blocks.length}.${k}`] = v; });
    blocks.push(block);
  });
  const op = String(body.op || '');
  let focus = null;
  if (Object.keys(errors).length) return { blocks, errors, op: '', focus }; // fix the errors first, then move things
  const m = /^(up|down|remove|duplicate):(\d+)$/.exec(op);
  if (m) {
    const i = Number(m[2]);
    if (i < blocks.length) {
      if (m[1] === 'up' && i > 0) { [blocks[i - 1], blocks[i]] = [blocks[i], blocks[i - 1]]; focus = i - 1; }
      if (m[1] === 'down' && i < blocks.length - 1) { [blocks[i + 1], blocks[i]] = [blocks[i], blocks[i + 1]]; focus = i + 1; }
      if (m[1] === 'remove') { blocks.splice(i, 1); focus = Math.max(0, i - 1); }
      if (m[1] === 'duplicate' && blocks.length < MAX_BLOCKS) { blocks.splice(i + 1, 0, { ...blocks[i] }); focus = i + 1; }
    }
  } else if (/^add:/.test(op) && TYPES[op.slice(4)] && blocks.length < MAX_BLOCKS) {
    blocks.push({ type: op.slice(4), hidden: false });
    focus = blocks.length - 1;
  }
  return { blocks, errors, op, focus };
}

const parse = (v) => { if (Array.isArray(v)) return v; try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch { return []; } };

/** "a | b | c" lines → [[a, b, c], …] */
const rows = (text) => String(text || '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[0]);

module.exports = { TYPES, MAX_BLOCKS, clean, fromForm, parse, rows, videoEmbed, optionsOf };
