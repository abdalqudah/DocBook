// Reads a ZIP from disk without loading it: the central directory is read once, then each entry on demand (stored
// or deflated, ZIP64 included) — so a whole-clinic export of several GB can be imported entry by entry.
// Guards: at most MAX_ENTRIES entries, no entry over MAX_ENTRY bytes once unpacked, names normalised (no "..").
const fs = require('fs');
const zlib = require('zlib');

const MAX_ENTRIES = 500_000;
const MAX_ENTRY = 64 * 1024 * 1024;
const fail = (m) => Object.assign(new Error(m), { code: 'ZIP_INVALID' });

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return n === len ? buf : buf.subarray(0, n);
}

class ZipReader {
  constructor(file) {
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.entries = new Map();
    try { this.load(); } catch (e) { this.close(); throw e.code === 'ZIP_INVALID' ? e : fail('Not a ZIP file.'); }
  }

  load() {
    const tailLen = Math.min(this.size, 65_557);
    const tail = readAt(this.fd, this.size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw fail('Not a ZIP file.');
    let count = tail.readUInt16LE(e + 10);
    let cdSize = tail.readUInt32LE(e + 12);
    let cdAt = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdAt === 0xffffffff) { // ZIP64
      const locAt = this.size - tailLen + e - 20;
      const loc = readAt(this.fd, locAt, 20);
      if (loc.readUInt32LE(0) !== 0x07064b50) throw fail('Broken ZIP64 archive.');
      const rec = readAt(this.fd, Number(loc.readBigUInt64LE(8)), 56);
      if (rec.readUInt32LE(0) !== 0x06064b50) throw fail('Broken ZIP64 archive.');
      count = Number(rec.readBigUInt64LE(32)); cdSize = Number(rec.readBigUInt64LE(40)); cdAt = Number(rec.readBigUInt64LE(48));
    }
    if (count > MAX_ENTRIES || cdAt + cdSize > this.size) throw fail('Broken ZIP archive.');
    const cd = readAt(this.fd, cdAt, cdSize);
    let p = 0;
    for (let i = 0; i < count; i += 1) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw fail('Broken ZIP archive.');
      const method = cd.readUInt16LE(p + 10);
      let comp = cd.readUInt32LE(p + 20); let size = cd.readUInt32LE(p + 24);
      const nLen = cd.readUInt16LE(p + 28); const xLen = cd.readUInt16LE(p + 30); const cLen = cd.readUInt16LE(p + 32);
      let at = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nLen).toString('utf8').replace(/\\/g, '/');
      let x = p + 46 + nLen; const xEnd = x + xLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x); const len = cd.readUInt16LE(x + 2); let q = x + 4;
        if (id === 0x0001) {
          if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (comp === 0xffffffff) { comp = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (at === 0xffffffff) { at = Number(cd.readBigUInt64LE(q)); }
        }
        x += 4 + len;
      }
      p = xEnd + cLen;
      const clean = name.split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
      if (!name.endsWith('/') && clean) this.entries.set(clean, { method, comp, size, at });
    }
  }

  names() { return [...this.entries.keys()]; }
  has(name) { return this.entries.has(name); }

  /** An entry's size once unpacked (from the directory, nothing read), or null. */
  sizeOf(name) { const e = this.entries.get(name); return e ? Math.max(e.size, e.comp) : null; }

  /** One entry's bytes (null when it is not in the archive). */
  read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    if (e.size > MAX_ENTRY || e.comp > MAX_ENTRY) throw fail(`Entry too large: ${name}`);
    const h = readAt(this.fd, e.at, 30);
    if (h.readUInt32LE(0) !== 0x04034b50) throw fail('Broken ZIP archive.');
    const start = e.at + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
    const raw = readAt(this.fd, start, e.comp);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY });
    throw fail('Unsupported ZIP compression.');
  }

  close() { try { fs.closeSync(this.fd); } catch { /* closed */ } }
}

module.exports = { ZipReader, MAX_ENTRY };
