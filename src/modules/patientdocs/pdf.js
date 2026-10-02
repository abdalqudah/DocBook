// A small PDF writer for patient documents (prescriptions, consultation reports) with correct Arabic.
//
// pdfkit embeds TrueType fonts through fontkit, which applies the OpenType shaping of the font (Arabic joining
// forms, lam-alef ligatures, marks) and puts a right-to-left run in visual order. What fontkit does NOT do is the
// Unicode bidirectional algorithm for a line that mixes Arabic with Latin words and numbers — so every line is
// broken into runs here with bidi-js (embedding levels, visual re-ordering, mirrored brackets), and each run is
// drawn separately with the matching font:
//   • Arabic letters → Noto Naskh Arabic;  Latin letters and left-to-right numbers → Noto Sans
//   (both SIL Open Font License 1.1, bundled from the @expo-google-fonts packages as .ttf files).
// Line wrapping is done here too (on the logical text, word by word), so a run is never split by pdfkit.
const path = require('path');
const PDFDocument = require('pdfkit');
const bidi = require('bidi-js')();
const brand = require('../../config/brand');

const FONT_DIR = path.dirname(require.resolve('@expo-google-fonts/noto-naskh-arabic/package.json'));
const LATIN_DIR = path.dirname(require.resolve('@expo-google-fonts/noto-sans/package.json'));
const FONTS = {
  ar: path.join(FONT_DIR, '400Regular', 'NotoNaskhArabic_400Regular.ttf'),
  arBold: path.join(FONT_DIR, '700Bold', 'NotoNaskhArabic_700Bold.ttf'),
  lat: path.join(LATIN_DIR, '400Regular', 'NotoSans_400Regular.ttf'),
  latBold: path.join(LATIN_DIR, '700Bold', 'NotoSans_700Bold.ttf'),
};

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN = /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/;
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
/** Keeps a phone number, code or e-mail in one left-to-right piece inside Arabic text. */
const ltr = (s) => (s ? `\u2066${s}\u2069` : s);
const C = brand.colors.light;
// Passing features makes pdfkit shape the whole run at once (its default path shapes word by word, which puts
// the words of a right-to-left run in the wrong order). The shaper still applies the script's own features.
const FEATURES = ['liga', 'kern'];

/**
 * Direction of a paragraph from its first strong letter (Unicode rule P2, like dir="auto"), skipping isolated
 * pieces; null when it has no letters (numbers only). An Arabic line in an English document still reads right to left.
 */
function paragraphDir(text) {
  let depth = 0;
  for (const ch of String(text)) {
    if (ch === '\u2066' || ch === '\u2067' || ch === '\u2068') depth += 1;
    else if (ch === '\u2069') depth = Math.max(0, depth - 1);
    else if (!depth && ARABIC.test(ch)) return 'rtl';
    else if (!depth && LATIN.test(ch)) return 'ltr';
  }
  return null;
}

/** Font key for one character at a bidi level (neutrals and numbers follow the direction of their level). */
function fontKey(ch, level, bold) {
  let base;
  if (ARABIC.test(ch)) base = 'ar';
  else if (LATIN.test(ch)) base = 'lat';
  else base = level % 2 ? 'ar' : 'lat';
  return bold ? `${base}Bold` : base;
}

/**
 * Visual runs of one line: [{ text, font }] left to right. The text of a right-to-left run that contains Arabic
 * is kept in LOGICAL order (fontkit shapes it and reverses it); other runs are already in visual order.
 */
function visualRuns(line, baseDir, bold = false) {
  if (!line) return [];
  const emb = bidi.getEmbeddingLevels(line, baseDir);
  const order = Array.from({ length: line.length }, (_, i) => i);
  bidi.getReorderSegments(line, emb).forEach(([s, e]) => {
    const part = order.slice(s, e + 1).reverse();
    for (let i = s; i <= e; i += 1) order[i] = part[i - s];
  });
  const mirrored = bidi.getMirroredCharactersMap(line, emb.levels); // brackets in right-to-left runs
  const runs = [];
  order.forEach((i) => {
    if (BIDI_CONTROLS.test(line[i])) return; // isolates/marks steer the algorithm but are never drawn
    const level = emb.levels[i];
    const font = fontKey(line[i], level, bold);
    const rtl = level % 2 === 1;
    const last = runs[runs.length - 1];
    if (last && last.font === font && last.rtl === rtl) last.idx.push(i);
    else runs.push({ font, rtl, idx: [i] });
  });
  return runs.map((r) => {
    const shaped = r.rtl && r.idx.some((i) => ARABIC.test(line[i]));
    // fontkit reverses a right-to-left Arabic run itself (without mirroring): give it the logical characters.
    if (shaped) return { font: r.font, text: r.idx.slice().reverse().map((i) => mirrored.get(i) || line[i]).join('') };
    return { font: r.font, text: r.idx.map((i) => (r.rtl && mirrored.get(i)) || line[i]).join('') };
  });
}

class Writer {
  /**
   * @param {object} o { locale: 'ar'|'en', title, author, subject, accent } — accent: the clinic's colour (#hex) for
   *   the letterhead rule and headings; dark text when the clinic has none (never the platform's colour).
   */
  constructor({ locale = 'ar', title = '', author = '', subject = '', accent = null } = {}) {
    this.rtl = locale === 'ar';
    this.accent = accent && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(accent) ? accent : C.text;
    this.dir = this.rtl ? 'rtl' : 'ltr';
    this.doc = new PDFDocument({
      size: 'A4', margins: { top: 48, bottom: 56, left: 50, right: 50 }, bufferPages: true, autoFirstPage: true,
      info: { Title: title, Author: author, Subject: subject, Creator: brand.name, Producer: brand.name }, lang: locale === 'ar' ? 'ar' : 'en',
    });
    Object.entries(FONTS).forEach(([k, file]) => this.doc.registerFont(k, file));
    this.left = this.doc.page.margins.left;
    this.right = this.doc.page.width - this.doc.page.margins.right;
    this.width = this.right - this.left;
    this.y = this.doc.page.margins.top;
    this.chunks = [];
    this.doc.on('data', (c) => this.chunks.push(c));
  }

  get bottom() { return this.doc.page.height - this.doc.page.margins.bottom; }

  /** Width of a logical string at a size (measured run by run with the right fonts). */
  measure(str, size, bold = false) {
    return visualRuns(String(str), this.dir, bold).reduce((w, r) => w + this.doc.font(r.font).fontSize(size).widthOfString(r.text, { features: FEATURES }), 0);
  }

  ensure(h) {
    if (this.y + h > this.bottom) { this.doc.addPage(); this.y = this.doc.page.margins.top; }
  }

  /** Breaks a paragraph into lines that fit `width` (word by word; very long words are cut). */
  wrap(text, width, size, bold) {
    const out = [];
    const dirs = [];
    String(text ?? '').replace(/\r\n?/g, '\n').split('\n').forEach((para) => {
      const words = para.split(/\s+/).filter(Boolean);
      const pdir = paragraphDir(para) || this.dir;
      const start = out.length;
      if (!words.length) { out.push(''); dirs.push(pdir); return; }
      let line = '';
      words.forEach((w0) => {
        let w = w0;
        const tryLine = line ? `${line} ${w}` : w;
        if (this.measure(tryLine, size, bold) <= width) { line = tryLine; return; }
        if (line) out.push(line);
        // A single word wider than the box: cut it.
        while (this.measure(w, size, bold) > width && w.length > 1) {
          let n = w.length - 1;
          while (n > 1 && this.measure(w.slice(0, n), size, bold) > width) n -= 1;
          out.push(w.slice(0, n));
          w = w.slice(n);
        }
        line = w;
      });
      if (line) out.push(line);
      for (let i = start; i < out.length; i += 1) dirs[i] = pdir;
    });
    out.dirs = dirs;
    return out;
  }

  /** Draws one line at a baseline; `align`: start | end | center within [x, x+width]. Returns its width. */
  drawLine(line, { x, width, baseline, size, bold, color, align, dir }) {
    const runs = visualRuns(line, dir || paragraphDir(line) || this.dir, bold);
    const widths = runs.map((r) => this.doc.font(r.font).fontSize(size).widthOfString(r.text, { features: FEATURES }));
    const total = widths.reduce((a, b) => a + b, 0);
    const side = align === 'center' ? 'center' : (align === 'end') === this.rtl ? 'left' : 'right';
    let cx = side === 'left' ? x : side === 'right' ? x + width - total : x + (width - total) / 2;
    this.doc.fillColor(color || C.text);
    runs.forEach((r, i) => {
      this.doc.font(r.font).fontSize(size).text(r.text, cx, baseline, { lineBreak: false, baseline: 'alphabetic', features: FEATURES });
      cx += widths[i];
    });
    return total;
  }

  /**
   * A wrapped paragraph at the current position (or at `o.y` without moving the cursor when `o.fixed`).
   * @returns the height used
   */
  text(str, o = {}) {
    const size = o.size || 10;
    const lh = o.lineHeight || size * 1.75;
    const x = o.x ?? this.left;
    const width = o.width ?? this.width;
    const lines = this.wrap(str, width, size, o.bold);
    let y = o.y ?? this.y;
    lines.forEach((line, i) => {
      if (!o.fixed && y + lh > this.bottom) { this.doc.addPage(); y = this.doc.page.margins.top; }
      if (line) this.drawLine(line, { x, width, baseline: y + size * 1.25, size, bold: o.bold, color: o.color, align: o.align || 'start', dir: lines.dirs[i] });
      y += lh;
    });
    const used = lines.length * lh;
    if (!o.fixed) this.y = y + (o.gap ?? 0);
    return used;
  }

  /** Label over value, in columns (right-to-left for Arabic). items: [{ label, value }] */
  fields(items, { cols = items.length, size = 10.5, gap = 10 } = {}) {
    const colW = (this.width - (cols - 1) * 16) / cols;
    for (let i = 0; i < items.length; i += cols) {
      const row = items.slice(i, i + cols);
      const heights = row.map((it) => this.wrap(it.value || '—', colW, size, true).length);
      const h = size * 1.6 + Math.max(...heights) * size * 1.75;
      this.ensure(h);
      row.forEach((it, j) => {
        const x = this.rtl ? this.right - (j + 1) * colW - j * 16 : this.left + j * (colW + 16);
        this.text(it.label, { x, width: colW, y: this.y, size: size - 2, color: C.textSubtle, fixed: true, lineHeight: size * 1.6 });
        this.text(it.value || '—', { x, width: colW, y: this.y + size * 1.6, size, bold: true, fixed: true });
      });
      this.y += h + gap;
    }
  }

  rule({ color = C.border, gap = 12, width = 0.8 } = {}) {
    this.ensure(gap * 2);
    this.y += gap;
    this.doc.moveTo(this.left, this.y).lineTo(this.right, this.y).lineWidth(width).strokeColor(color).stroke();
    this.y += gap;
  }

  space(h) { this.y += h; }

  /** Image (PNG/JPEG buffer) at the start or end side of the current line; returns its box. */
  image(buf, { side = 'start', height = 56, maxWidth = 140, y = this.y } = {}) {
    try {
      const img = this.doc.openImage(buf);
      const w = Math.min(maxWidth, (img.width / img.height) * height);
      const h = w === maxWidth ? (img.height / img.width) * w : height;
      const atRight = (side === 'start') === this.rtl;
      const x = atRight ? this.right - w : this.left;
      this.doc.image(img, x, y, { width: w, height: h });
      return { x, y, w, h };
    } catch { return null; }
  }

  /** Image (PNG/JPEG buffer) fitted inside a box, aligned in it; false when it cannot be drawn. */
  fitImage(buf, x, y, w, h, { align = 'center', valign = 'bottom' } = {}) {
    try { this.doc.image(buf, x, y, { fit: [w, h], align, valign }); return true; } catch { return false; }
  }

  /** Footer on every page: a note at the start side and "page / total" at the end side. */
  footer(note, pageLabel) {
    const range = this.doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      this.doc.switchToPage(i);
      const saveBottom = this.doc.page.margins.bottom;
      this.doc.page.margins.bottom = 0; // drawing in the margin must not add a page
      const base = this.doc.page.height - 30;
      this.doc.moveTo(this.left, base - 16).lineTo(this.right, base - 16).lineWidth(0.5).strokeColor(C.border).stroke();
      if (note) this.drawLine(String(note).slice(0, 140), { x: this.left, width: this.width * 0.75, baseline: base, size: 7.5, color: C.textSubtle, align: 'start', dir: this.dir });
      this.drawLine(pageLabel(i - range.start + 1, range.count), { x: this.left, width: this.width, baseline: base, size: 7.5, color: C.textSubtle, align: 'end', dir: this.dir });
      this.doc.page.margins.bottom = saveBottom;
    }
  }

  /** Finishes the document and resolves with the PDF bytes. */
  end() {
    return new Promise((resolve, reject) => {
      this.doc.on('end', () => resolve(Buffer.concat(this.chunks)));
      this.doc.on('error', reject);
      this.doc.end();
    });
  }
}

/** PNG or JPEG only (by their first bytes) — other logo formats are left out of the PDF. */
function isPdfImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

module.exports = { Writer, visualRuns, paragraphDir, isPdfImage, ltr, FONTS, colors: C };
