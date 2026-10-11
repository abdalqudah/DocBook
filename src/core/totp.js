// Time-based one-time codes (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps) for an authenticator app (Google
// Authenticator, Microsoft Authenticator, 1Password…). A code is accepted one step either side for clock drift, and
// the step it matched is returned so the caller refuses the same code twice.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) { // eslint-disable-line no-restricted-syntax
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) { // eslint-disable-line no-restricted-syntax
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
const newSecret = () => base32(crypto.randomBytes(20));
function codeAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
const stepOf = (now = Date.now()) => Math.floor(now / 30_000);
/** The matched step, or null. `after`: the last step already used (a code is accepted once). */
function verify(secret, code, { now = Date.now(), after = null } = {}) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const s = stepOf(now);
  for (const st of [s - 1, s, s + 1]) { // eslint-disable-line no-restricted-syntax
    if (after !== null && st <= after) continue; // eslint-disable-line no-continue
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, st)), Buffer.from(c))) return st;
  }
  return null;
}
const otpauth = (secret, account, issuer) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { newSecret, codeAt, stepOf, verify, otpauth, base32, unbase32 };
