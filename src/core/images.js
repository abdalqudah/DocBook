// Image uploads checked by their first bytes (never by the file name or the browser's word): PNG, JPEG, WebP, and
// ICO for browser icons. SVG is not accepted (it can carry scripts).
const SIG = {
  'image/png': (b) => b.length > 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP',
  'image/x-icon': (b) => b.length > 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0,
};

/** The real type of an image buffer among `allowed`, or null. */
function sniff(buffer, allowed = ['image/png', 'image/jpeg', 'image/webp']) {
  if (!Buffer.isBuffer(buffer)) return null;
  return allowed.find((m) => SIG[m] && SIG[m](buffer)) || null;
}

/** Headers for serving a stored image: no sniffing, nothing active even when opened directly. */
const headers = (mime, cache) => ({ 'Content-Type': mime, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });

module.exports = { sniff, headers, ICON_TYPES: ['image/png', 'image/x-icon', 'image/webp', 'image/jpeg'] };
