// Reads a large JSON file without loading it: the file is scanned in chunks and every element of its arrays is handed
// over one at a time with its byte offset and length (so one element can be read again later without the rest).
// Shapes understood: a top-level array ([ {…}, {…} ]) — elements under the path '' — or a top-level object whose
// properties hold arrays ({ "patients": [ … ], "treatments": [ … ] }) — elements under the property's name; the
// object's other (small) properties are handed over whole.
//   for await (const ev of scan(file)) { ev.type === 'element' → { path, index, offset, length, text }
//                                         ev.type === 'prop'    → { path, text } }
//   readSlice(file, offset, length) → that element's text again.
// Guards: an element over MAX_ELEMENT bytes stops the scan (JSON_ELEMENT_TOO_LARGE); broken JSON stops it
// (JSON_INVALID) with the byte position.
const fs = require('fs');

const MAX_ELEMENT = 64 * 1024 * 1024;
const MAX_PROP = 1024 * 1024;
const CHUNK = 1024 * 1024;
const fail = (code, message, at) => Object.assign(new Error(message), { code, at });
const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

class Scanner {
  constructor() {
    this.pos = 0; // absolute byte position of the next byte
    this.stack = []; // container chars: '{' or '['
    this.inStr = false; this.esc = false;
    this.top = null; // '[' | '{'
    this.keyBuf = null; this.key = null; this.expectKey = false; // top-level object keys
    this.cap = null; // capture: { kind, path, index, start, pieces, depth, scalar }
    this.counts = new Map(); // path → elements seen
    this.out = [];
    this.bom = 0;
  }

  startCapture(kind, path, at, chunk, i) {
    this.cap = { kind, path, start: at, pieces: [], from: i, chunk, depth: this.stack.length, size: 0 };
  }

  flushPiece(chunk, end) { // the part of the current chunk inside the capture
    const c = this.cap;
    if (!c) return;
    const from = c.chunk === chunk ? c.from : 0;
    if (end > from) { c.pieces.push(chunk.subarray(from, end)); c.size += end - from; }
    if (c.size > (c.kind === 'element' ? MAX_ELEMENT : MAX_PROP)) {
      if (c.kind === 'prop') { c.skip = true; c.pieces = []; } else throw fail('JSON_ELEMENT_TOO_LARGE', 'One record of the file is too large.', c.start);
    }
    c.chunk = null;
  }

  endCapture(chunk, end) {
    this.flushPiece(chunk, end);
    const c = this.cap; this.cap = null;
    if (c.skip) return;
    const text = Buffer.concat(c.pieces).toString('utf8');
    if (c.kind === 'element') {
      const index = this.counts.get(c.path) || 0; this.counts.set(c.path, index + 1);
      this.out.push({ type: 'element', path: c.path, index, offset: c.start, length: c.size, text });
    } else this.out.push({ type: 'prop', path: c.path, text });
  }

  // Where a value may start: inside the top array (depth 1) or a top-level property's array (depth 2), or a
  // top-level property's value (depth 1 of an object).
  valueSlot() {
    const d = this.stack.length;
    if (this.top === '[' && d === 1) return { kind: 'element', path: '' };
    if (this.top === '{' && d === 2 && this.stack[1] === '[') return { kind: 'element', path: this.key };
    if (this.top === '{' && d === 1 && this.key !== null && !this.expectKey) return { kind: 'propValue', path: this.key };
    return null;
  }

  feed(chunk) {
    let i = 0;
    if (this.pos === 0 && chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) i = 3; // BOM
    if (this.cap) { this.cap.chunk = chunk; this.cap.from = 0; }
    for (; i < chunk.length; i += 1) {
      const b = chunk[i];
      const at = this.pos + i;
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (b === 0x5c) this.esc = true;
        else if (b === 0x22) {
          this.inStr = false;
          if (this.keyBuf) { this.keyBuf.push(chunk.subarray(this.keyBuf.from, i)); this.key = Buffer.concat(this.keyBuf.parts || []).toString('utf8'); this.keyBuf = null; }
          if (this.cap && this.cap.scalar && this.stack.length === this.cap.depth) this.endCapture(chunk, i + 1);
        }
        continue; // eslint-disable-line no-continue
      }
      if (WS.has(b)) continue; // eslint-disable-line no-continue
      // A value starting where we collect values.
      if (!this.cap && b !== 0x5d && b !== 0x7d && b !== 0x2c && b !== 0x3a) {
        const slot = this.valueSlot();
        if (slot && !(slot.kind === 'propValue' && b === 0x5b)) {
          this.startCapture(slot.kind === 'element' ? 'element' : 'prop', slot.path, at, chunk, i);
          if (b !== 0x7b && b !== 0x5b) this.cap.scalar = true;
        }
      }
      switch (b) {
        case 0x22: // "
          this.inStr = true;
          if (this.top === '{' && this.stack.length === 1 && this.expectKey) {
            this.keyBuf = { from: i + 1, parts: [] };
            const kb = this.keyBuf; kb.push = (p) => kb.parts.push(p);
            this.expectKey = false;
          }
          break;
        case 0x7b: case 0x5b: { // { [
          const c = b === 0x7b ? '{' : '[';
          if (!this.stack.length) {
            if (this.top) throw fail('JSON_INVALID', 'The file is not valid JSON.', at);
            this.top = c;
            if (c === '{') this.expectKey = true;
          }
          this.stack.push(c);
          if (this.cap && this.cap.scalar) throw fail('JSON_INVALID', 'The file is not valid JSON.', at);
          break;
        }
        case 0x7d: case 0x5d: { // } ]
          const c = this.stack.pop();
          if (!c || (b === 0x7d) !== (c === '{')) throw fail('JSON_INVALID', 'The file is not valid JSON.', at);
          if (this.cap && this.cap.scalar && this.stack.length + 1 === this.cap.depth) this.endCapture(chunk, i);
          else if (this.cap && !this.cap.scalar && this.stack.length === this.cap.depth) this.endCapture(chunk, i + 1);
          if (this.top === '{' && this.stack.length === 1 && c === '[') { /* end of a property's array */ }
          break;
        }
        case 0x2c: // ,
          if (this.cap && this.cap.scalar && this.stack.length === this.cap.depth) this.endCapture(chunk, i);
          if (this.top === '{' && this.stack.length === 1) { this.expectKey = true; this.key = null; }
          break;
        case 0x3a: // :
          break;
        default:
          break;
      }
    }
    if (this.keyBuf) { this.keyBuf.push(chunk.subarray(this.keyBuf.from)); this.keyBuf.from = 0; }
    this.flushPiece(chunk, chunk.length);
    if (this.cap) { this.cap.chunk = null; this.cap.from = 0; }
    this.pos += chunk.length;
    const out = this.out; this.out = [];
    return out;
  }

  end() {
    if (this.cap && this.cap.scalar && !this.stack.length) this.endCapture(Buffer.alloc(0), 0);
    if (this.stack.length || this.inStr || !this.top) throw fail('JSON_INVALID', 'The file ends before the JSON does.', this.pos);
    const out = this.out; this.out = [];
    return out;
  }
}

/** Async iterator over the elements (and top-level properties) of a JSON file. */
async function* scan(file, { chunk = CHUNK, onProgress = null } = {}) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const sc = new Scanner();
    const buf = Buffer.alloc(chunk);
    let read = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, chunk, read); // eslint-disable-line no-await-in-loop
      if (!bytesRead) break;
      const part = Buffer.from(buf.subarray(0, bytesRead)); // a copy: captured pieces must outlive the buffer
      read += bytesRead;
      for (const ev of sc.feed(part)) yield ev;
      if (onProgress) onProgress(read, size);
    }
    for (const ev of sc.end()) yield ev;
  } finally { await fh.close(); }
}

/** One element's text again, from its offset and length. */
async function readSlice(file, offset, length) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}

module.exports = { scan, readSlice, Scanner, MAX_ELEMENT };
