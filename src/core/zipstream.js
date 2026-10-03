// A ZIP written straight to a file, entry by entry, so a large archive (a whole clinic's patient files) never sits
// in memory: only the current entry and the small central directory do. Entries are stored (no compression — PDFs
// and images are already compressed), names are UTF-8 (flag bit 11), and ZIP64 records are written once the archive
// passes 4 GB or 65 535 entries, so any size opens in Windows, macOS and Linux.
//   const z = await ZipFile.create(path); await z.add('a/b.pdf', buffer); …; const { size, entries } = await z.close();
const fs = require('fs');
const zlib = require('zlib');

const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = typeof zlib.crc32 === 'function' ? (buf) => zlib.crc32(buf) >>> 0 : (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
const U32 = 0xffffffff;

class ZipFile {
  constructor(stream, { force64 = false } = {}) { this.out = stream; this.offset = 0; this.entries = []; this.force64 = force64; }

  static async create(path, opts) {
    const stream = fs.createWriteStream(path, { flags: 'wx', mode: 0o600 });
    await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
    return new ZipFile(stream, opts);
  }

  async write(buf) {
    this.offset += buf.length;
    if (!this.out.write(buf)) await new Promise((resolve, reject) => { this.out.once('drain', resolve); this.out.once('error', reject); });
  }

  /** Adds one file (a Buffer below 4 GB). */
  async add(name, data, when = new Date()) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    if (buf.length >= U32) throw new Error('ZIP entry too large');
    const nameBuf = Buffer.from(String(name).replace(/\\/g, '/').replace(/^\/+/, ''), 'utf8');
    const crc = crc32(buf);
    const { time, date } = dosTime(when);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(45, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(buf.length, 18); h.writeUInt32LE(buf.length, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    const at = this.offset;
    await this.write(Buffer.concat([h, nameBuf]));
    await this.write(buf);
    this.entries.push({ nameBuf, crc, size: buf.length, time, date, at });
  }

  /** Writes the central directory and closes the file → { size, entries }. */
  async close() {
    const cdStart = this.offset;
    for (const e of this.entries) { // eslint-disable-line no-restricted-syntax
      const big = this.force64 || e.at >= U32;
      const extra = big ? Buffer.alloc(12) : Buffer.alloc(0);
      if (big) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(8, 2); extra.writeBigUInt64LE(BigInt(e.at), 4); }
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(45, 4); c.writeUInt16LE(45, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
      c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.size, 20); c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.nameBuf.length, 28); c.writeUInt16LE(extra.length, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36);
      c.writeUInt32LE(0, 38); c.writeUInt32LE(big ? U32 : e.at, 42);
      await this.write(Buffer.concat([c, e.nameBuf, extra])); // eslint-disable-line no-await-in-loop
    }
    const cdSize = this.offset - cdStart;
    const n = this.entries.length;
    const need64 = this.force64 || n >= 0xffff || cdStart >= U32 || cdSize >= U32;
    if (need64) {
      const z64At = this.offset;
      const r = Buffer.alloc(56);
      r.writeUInt32LE(0x06064b50, 0); r.writeBigUInt64LE(44n, 4); r.writeUInt16LE(45, 12); r.writeUInt16LE(45, 14); r.writeUInt32LE(0, 16); r.writeUInt32LE(0, 20);
      r.writeBigUInt64LE(BigInt(n), 24); r.writeBigUInt64LE(BigInt(n), 32); r.writeBigUInt64LE(BigInt(cdSize), 40); r.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0); loc.writeUInt32LE(0, 4); loc.writeBigUInt64LE(BigInt(z64At), 8); loc.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([r, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
    end.writeUInt16LE(need64 ? 0xffff : n, 8); end.writeUInt16LE(need64 ? 0xffff : n, 10);
    end.writeUInt32LE(need64 ? U32 : cdSize, 12); end.writeUInt32LE(need64 ? U32 : cdStart, 16); end.writeUInt16LE(0, 20);
    await this.write(end);
    await new Promise((resolve, reject) => { this.out.end(resolve); this.out.once('error', reject); });
    return { size: this.offset, entries: n };
  }

  /** Stops writing (the caller removes the file). */
  abort() { try { this.out.destroy(); } catch { /* already closed */ } }
}

module.exports = { ZipFile, crc32 };
