// Booking widget (embed mode). A clinic's website loads /widget.js, which opens /<slug>/book?embed=1 in an
// overlay <iframe>. Only these embed responses may be framed (CSP frame-ancestors = the clinic's allowed
// websites, or any website); every other page keeps frame-ancestors 'none'.
//
// Inside a third-party iframe browsers do not send (or keep) our SameSite=Lax session cookie, so the embed
// booking form cannot rely on the session: its CSRF field carries a signed, short-lived embed token
// (clinic + channel + time, HMAC with the session secret) instead, and the confirmation page is reached with a
// signed link to the new appointment. The token grants nothing but "submit the public booking form of this
// clinic", which anyone may do anyway (rate limit, honeypot and the max-pending rule still apply).
//
// wrapCsrf(csrf) replaces the CSRF middleware in src/app.js: it also captures the booking channel of public
// visits (channels.capture) and records the channel of online-consultation bookings.
const crypto = require('crypto');
const knex = require('../../db/knex');
const config = require('../../config');
const cache = require('../../core/cache');
const businesses = require('../businesses/business.service');
const channels = require('./channels');

const EMBED_TTL = 6 * 3_600_000;
const DONE_TTL = 24 * 3_600_000;

const sig = (payload) => crypto.createHmac('sha256', config.sessionSecret).update(`docbook-embed:${payload}`).digest('base64url').slice(0, 27);
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Token placed in the embed booking form's _csrf field. */
function formToken(clinicId, src, at = Date.now()) {
  const p = `e1.${clinicId}.${src}.${at.toString(36)}`;
  return `${p}.${sig(p)}`;
}
/** { clinicId, src } of a valid form token (null when invalid/expired). */
function readFormToken(token, now = Date.now()) {
  const m = /^(e1\.(\d+)\.([a-z]{1,20})\.([0-9a-z]{1,12}))\.([A-Za-z0-9_-]{27})$/.exec(String(token || ''));
  if (!m || !safeEq(m[5], sig(m[1]))) return null;
  const at = parseInt(m[4], 36);
  if (!(at <= now + 60_000 && now - at < EMBED_TTL)) return null;
  const src = channels.whitelist(m[3]);
  return src ? { clinicId: Number(m[2]), src } : null;
}
/** Signed link parameter to the confirmation of appointment `id` (embed mode has no session). */
function doneToken(clinicId, apptId, at = Date.now()) {
  const p = `d1.${clinicId}.${apptId}.${at.toString(36)}`;
  return `${p}.${sig(p)}`;
}
function readDoneToken(token, now = Date.now()) {
  const m = /^(d1\.(\d+)\.(\d+)\.([0-9a-z]{1,12}))\.([A-Za-z0-9_-]{27})$/.exec(String(token || ''));
  if (!m || !safeEq(m[5], sig(m[1]))) return null;
  const at = parseInt(m[4], 36);
  if (!(at <= now + 60_000 && now - at < DONE_TTL)) return null;
  return { clinicId: Number(m[2]), apptId: Number(m[3]) };
}

// ---------------------------------------------------------------- allowed websites (frame-ancestors)
const ORIGIN_RE = /^https?:\/\/(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?$/i;
/** Parses the clinic's "allowed websites" text into origins (invalid lines are reported). */
function parseOrigins(text) {
  const origins = []; const invalid = [];
  for (const raw of String(text || '').split(/[\s,]+/)) {
    const line = raw.trim().replace(/\/+$/, '');
    if (!line) continue; // eslint-disable-line no-continue
    const withScheme = /^https?:\/\//i.test(line) ? line : `https://${line}`;
    if (ORIGIN_RE.test(withScheme)) origins.push(withScheme.toLowerCase()); else invalid.push(raw);
  }
  return { origins: [...new Set(origins)].slice(0, 20), invalid };
}
const originsOf = (clinicId) => cache.remember(`discover:origins:${clinicId}`, async () => {
  const row = await knex('businesses').where({ id: clinicId }).first('widget_origins');
  return parseOrigins(row && row.widget_origins).origins;
}, 60_000);

/** Lets this response be framed by the clinic's allowed websites (or any website). */
function allowFraming(res, origins) {
  const csp = res.getHeader('Content-Security-Policy');
  const fa = `frame-ancestors ${origins && origins.length ? `'self' ${origins.join(' ')}` : '*'}`;
  if (csp) res.setHeader('Content-Security-Policy', /frame-ancestors[^;]*/.test(csp) ? String(csp).replace(/frame-ancestors[^;]*/, fa) : `${csp};${fa}`);
  res.removeHeader('X-Frame-Options');
}

async function enterEmbed(req, res, clinic, src) {
  req.embed = { clinicId: clinic.id, slug: clinic.slug, src };
  res.locals.embedMode = true;
  res.locals.embedSrc = src;
  res.locals.csrfToken = formToken(clinic.id, src);
  allowFraming(res, await originsOf(clinic.id));
  res.set('Cache-Control', 'no-store');
}

const clinicOf = async (slug) => {
  const b = await businesses.bySlug(slug);
  return b && b.status === 'active' ? b : null;
};

/** Stores the booking channel of an online consultation (its booking flow ends with a redirect to /c/<token>). */
async function tagOnline(req, slug, token) {
  const b = await clinicOf(slug);
  if (!b) return;
  const row = await require('../telehealth/telehealth.service').byToken(token); // eslint-disable-line global-require
  if (!row || row.business_id !== b.id) return;
  await knex('appointments').where({ id: row.appointment_id, business_id: b.id }).where((q) => q.whereNull('booking_channel').orWhere('booking_channel', 'website'))
    .update({ booking_channel: channels.current(req, b) });
}

/** Replaces the CSRF middleware: embed-mode requests carry a signed token instead of the session token. */
function wrapCsrf(csrf) {
  return async function discoverCsrf(req, res, next) {
    try {
      channels.capture(req);
      const m = /^\/([a-z0-9-]+)\/book(\/done|\/online)?\/?$/.exec(req.path);
      if (m && !businesses.RESERVED.has(m[1])) {
        const [, slug, sub] = m;
        if (req.method === 'GET' && !sub && req.query.embed === '1') {
          const clinic = await clinicOf(slug);
          if (clinic) await enterEmbed(req, res, clinic, channels.whitelist(req.query.src) || 'widget');
        } else if (req.method === 'GET' && sub === '/done' && req.query.e) {
          const t = readDoneToken(req.query.e);
          const clinic = t && await clinicOf(slug);
          if (clinic && clinic.id === t.clinicId) { await enterEmbed(req, res, clinic, 'widget'); req.embedDone = t; }
        } else if (req.method === 'POST' && !sub && String((req.body && req.body._csrf) || '').startsWith('e1.')) {
          const t = readFormToken(req.body._csrf);
          const clinic = t && await clinicOf(slug);
          if (clinic && clinic.id === t.clinicId) {
            await enterEmbed(req, res, clinic, t.src);
            // After a successful embed booking, show the confirmation through a signed link (no session in the frame).
            const redirect = res.redirect.bind(res);
            res.redirect = (...args) => {
              const url = args[args.length - 1];
              const b = req.session && req.session.booked;
              if (url === `/${clinic.slug}/book/done` && b && b.businessId === clinic.id) return redirect(`/${clinic.slug}/book/done?e=${doneToken(clinic.id, b.id)}`);
              return redirect(...args);
            };
            return next(); // the signed token replaces the session CSRF token
          }
        } else if (req.method === 'POST' && sub === '/online') {
          const redirect = res.redirect.bind(res);
          res.redirect = (...args) => {
            const url = String(args[args.length - 1]);
            const tm = /^\/c\/([^/?#]+)/.exec(url);
            if (!tm) return redirect(...args);
            return tagOnline(req, slug, decodeURIComponent(tm[1])).catch(() => {}).then(() => redirect(...args));
          };
        }
      }
      return csrf(req, res, next);
    } catch (err) { return next(err); }
  };
}

module.exports = { formToken, readFormToken, doneToken, readDoneToken, parseOrigins, originsOf, allowFraming, wrapCsrf };
