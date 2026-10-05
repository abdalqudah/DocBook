const crypto = require('crypto');

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
/** Short human-friendly reference, e.g. APP-7K3Q9D (no 0/O/1/I). */
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const shortCode = (n = 6) => Array.from(crypto.randomBytes(n), (b) => ALPHA[b % ALPHA.length]).join('');

module.exports = { randomToken, sha256, safeEqual, shortCode };
