// Booking channels: where a public booking came from.
// A clinic shares tracked links (…/<slug>/book?src=instagram); a visitor arriving on the clinic page or the
// booking page gets the channel from `src` (whitelisted) or, without it, from the page that sent them (Referer).
// The channel is kept in the session until the booking is made and stored on appointments.booking_channel.
// Staff bookings are 'staff'; public bookings without a known channel are 'website'.
const { RESERVED } = require('../businesses/business.service');

/** Every channel shown in reports, in display order. */
const CHANNELS = ['staff', 'website', 'directory', 'widget', 'instagram', 'facebook', 'google', 'whatsapp', 'qr', 'x'];
/** Values accepted in ?src= on public links. */
const LINK_SOURCES = ['website', 'directory', 'widget', 'instagram', 'facebook', 'google', 'whatsapp', 'qr', 'x'];
/** Channels offered as ready-made tracked links in Settings → Booking links. */
const SHARE_LINKS = [
  { key: 'instagram', icon: 'instagram' },
  { key: 'facebook', icon: 'facebook' },
  { key: 'google', icon: 'map-pin' },
  { key: 'whatsapp', icon: 'message-circle' },
  { key: 'x', icon: 'twitter' },
  { key: 'qr', icon: 'qr-code' },
];
const KEEP_MS = 24 * 3_600_000;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

const whitelist = (v) => { const s = String(v || '').trim().toLowerCase(); return LINK_SOURCES.includes(s) ? s : null; };

const hostIs = (host, domain) => host === domain || host.endsWith(`.${domain}`);

/**
 * Channel from a Referer header. `ownHost` is this site's host (links from the directory are 'directory';
 * other internal navigation returns null so an earlier channel is kept). Any other website is 'website'.
 */
function fromReferer(ref, ownHost) {
  if (!ref) return null;
  let u;
  try { u = new URL(String(ref)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (ownHost && host === String(ownHost).toLowerCase().replace(/:\d+$/, '')) return u.pathname === '/clinics' || u.pathname.startsWith('/clinics/') ? 'directory' : null;
  if (hostIs(host, 'instagram.com') || host === 'instagr.am') return 'instagram';
  if (hostIs(host, 'facebook.com') || hostIs(host, 'fb.com') || host === 'fb.me' || hostIs(host, 'messenger.com')) return 'facebook';
  if (host === 't.co' || hostIs(host, 'x.com') || hostIs(host, 'twitter.com')) return 'x';
  if (hostIs(host, 'whatsapp.com') || host === 'wa.me') return 'whatsapp';
  // google.com, google.jo, google.co.uk, maps.google.com, business.google.com, g.page, goo.gl…
  if (/(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host) || host === 'g.page' || host === 'goo.gl' || host === 'g.co') return 'google';
  return 'website';
}

/** The clinic slug of a public clinic page / booking page path (null for anything else). */
function clinicPath(path) {
  const m = /^\/([a-z0-9-]+)(\/book(?:\/online)?)?\/?$/.exec(path || '');
  if (!m || !SLUG_RE.test(m[1]) || RESERVED.has(m[1])) return null;
  return m[1];
}

/** On GET of a clinic page or booking page: remember where the visitor came from (session). */
function capture(req) {
  if (!req.session || !['GET', 'HEAD'].includes(req.method)) return;
  const slug = clinicPath(req.path);
  if (!slug) return;
  const src = whitelist(req.query.src) || fromReferer(req.get('referer'), req.hostname);
  if (!src) return;
  const cur = req.session.bookingSrc;
  // Explicit links always win; a plain Referer never overwrites a tracked link for the same clinic.
  if (!whitelist(req.query.src) && cur && cur.slug === slug && Date.now() - cur.at < KEEP_MS && cur.src !== 'website') return;
  req.session.bookingSrc = { slug, src, at: Date.now() };
}

/** Channel to store on a public booking of this clinic (embed token › session › 'website'). */
function current(req, clinic) {
  if (req.embed && req.embed.clinicId === clinic.id) return req.embed.src;
  const cur = req.session && req.session.bookingSrc;
  if (cur && cur.slug === clinic.slug && Date.now() - cur.at < KEEP_MS && LINK_SOURCES.includes(cur.src)) return cur.src;
  return 'website';
}

/** Tracked link for a channel. */
const link = (base, slug, src, page = 'book') => `${base}/${slug}${page === 'book' ? '/book' : ''}?src=${src}`;

module.exports = { CHANNELS, LINK_SOURCES, SHARE_LINKS, whitelist, fromReferer, clinicPath, capture, current, link };
