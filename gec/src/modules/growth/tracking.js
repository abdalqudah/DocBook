// First-party analytics, only after the visitor chose "Accept all" in the cookie banner (gec_consent=all) and
// never when the browser sends Global Privacy Control / Do Not Track. No fingerprinting: one random first-party
// cookie (gec_vid), no IP address stored, the user agent reduced to "mobile / tablet / desktop".
// Page views are recorded on the server (no script needed); a small beacon (/t/e) records clicks the server
// cannot see. Withdrawing consent deletes the visitor's browsing history.
const express = require('express');
const knex = require('../../db/knex');
const config = require('../../config');
const events = require('../../core/events');
const { randomToken } = require('../../core/tokens');
const limits = require('../../middleware/limits');

const COOKIE = 'gec_vid';
const UTM = ['source', 'medium', 'campaign', 'term', 'content'];
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit|whatsapp|curl|wget|python|axios|node-fetch/i;
const SKIP = /^\/(staff|api|hooks|t|media|icons|css|js|fonts|brand|img|art|flags|theme\.css|healthz|favicon)/;
const BEACON_NAMES = new Set(['consent_granted', 'book_click', 'whatsapp_click', 'phone_click', 'email_click', 'compare_open', 'share', 'print', 'outbound', 'video_play', 'cta_click']);

const consented = (req) => req.cookies && req.cookies.gec_consent === 'all' && req.get('sec-gpc') !== '1' && req.get('dnt') !== '1';
const deviceOf = (ua) => (/ipad|tablet/i.test(ua) ? 'tablet' : (/mobi|android|iphone/i.test(ua) ? 'mobile' : 'desktop'));
const external = (ref) => { try { const u = new URL(ref); return u.host !== new URL(config.appUrl).host ? ref.slice(0, 500) : null; } catch { return null; } };
const asReqVisitor = (v) => (v ? { ...v, utm: Object.fromEntries(UTM.map((k) => [k, v[`utm_${k}`]]).filter(([, x]) => x)) } : null);

/** Loads (or, for a consenting visitor on a public page, creates) req.visitor. */
async function visitor(req, res, next) {
  try {
    if (SKIP.test(req.path) || !consented(req) || BOT.test(req.get('user-agent') || '')) return next();
    const id = req.cookies[COOKIE];
    let v = /^[A-Za-z0-9_-]{20,40}$/.test(id || '') ? await knex('visitors').where({ id }).first() : null;
    if (req.method !== 'GET') { req.visitor = asReqVisitor(v); return next(); } // forms: link to the visit, never create one
    const utm = Object.fromEntries(UTM.map((k) => [k, req.query[`utm_${k}`] ? String(req.query[`utm_${k}`]).slice(0, 160) : null]));
    if (!v) {
      const nid = randomToken(24);
      v = { id: nid, landing_page: req.originalUrl.slice(0, 500), referrer: external(req.get('referer') || ''), device: deviceOf(req.get('user-agent') || ''), locale: req.locale || null, pageviews: 0,
        ...Object.fromEntries(UTM.map((k) => [`utm_${k}`, utm[k]])), last_utm_source: utm.source, last_utm_medium: utm.medium, last_utm_campaign: utm.campaign };
      await knex('visitors').insert(v);
      v = await knex('visitors').where({ id: nid }).first();
      res.cookie(COOKIE, nid, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 395 * 86_400_000 });
    } else if (utm.source) {
      await knex('visitors').where({ id: v.id }).update({ last_utm_source: utm.source, last_utm_medium: utm.medium, last_utm_campaign: utm.campaign });
    }
    req.visitor = asReqVisitor(v);
    // Record the page view once the page has been served successfully.
    res.on('finish', () => {
      if (res.statusCode !== 200 || !/html/.test(res.get('content-type') || '')) return;
      record(v.id, 'pageview', { path: req.originalUrl }).catch(() => {}); // eslint-disable-line no-use-before-define
    });
  } catch (e) { console.error('[tracking]', e.message); } // eslint-disable-line no-console
  return next();
}

async function record(visitorId, name, { path = null, refType = null, refId = null, meta = null } = {}) {
  if (!visitorId) return;
  await knex('tracking_events').insert({ visitor_id: visitorId, name, path: path ? String(path).slice(0, 500) : null, ref_type: refType, ref_id: refId || null, meta: meta ? JSON.stringify(meta) : null });
  const upd = { last_seen_at: new Date() };
  if (name === 'pageview') upd.pageviews = knex.raw('pageviews + 1');
  await knex('visitors').where({ id: visitorId }).update(upd);
  await events.emit('tracking.recorded', { visitorId, name, refType, refId });
}

// Server-side facts from the public site.
events.on('site.view', ({ req, type, id }) => (req && req.visitor ? record(req.visitor.id, `${type}_view`, { path: req.originalUrl, refType: type, refId: id }) : null));
events.on('site.search', ({ req, query, total }) => (req && req.visitor ? record(req.visitor.id, 'search', { path: req.originalUrl, meta: { q: String(query || '').slice(0, 120), total } }) : null));
events.on('site.calculator', ({ req }) => (req && req.visitor ? record(req.visitor.id, 'calculator', { path: req.originalUrl }) : null));
events.on('site.whatsapp_click', ({ req }) => (req && req.visitor ? record(req.visitor.id, 'whatsapp_click', { path: req.originalUrl }) : null));
events.on('site.lead_captured', async ({ req, lead, source }) => {
  if (!req || !req.visitor) return;
  await knex('visitors').where({ id: req.visitor.id }).update({ lead_id: lead.id, student_id: lead.student_id || null });
  if (!lead.visitor_id) await knex('leads').where({ id: lead.id }).update({ visitor_id: req.visitor.id });
  await record(req.visitor.id, 'lead_captured', { path: req.originalUrl, refType: 'lead', refId: lead.id, meta: { source } });
});

const router = express.Router();
// Beacon for clicks the server cannot see (calls, WhatsApp links, outbound links).
router.post('/t/e', limits.tracking, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '');
    const id = req.cookies && req.cookies[COOKIE];
    if (consented(req) && BEACON_NAMES.has(name) && /^[A-Za-z0-9_-]{20,40}$/.test(id || '') && await knex('visitors').where({ id }).first('id')) {
      await record(id, name, { path: String((req.body && req.body.path) || '').slice(0, 500) });
    }
  } catch (e) { /* analytics never breaks the page */ }
  res.status(204).end();
});

// Consent changes. "necessary" deletes the browsing history (attribution already copied onto a lead stays).
router.post('/t/consent', async (req, res) => {
  const choice = req.body && req.body.consent === 'all' ? 'all' : 'necessary';
  const id = req.cookies && req.cookies[COOKIE];
  if (choice === 'necessary' && id) {
    await knex('tracking_events').where({ visitor_id: id }).del();
    await knex('visitors').where({ id }).del();
    res.clearCookie(COOKIE);
  }
  res.status(204).end();
});

module.exports = { visitor, record, router, consented, COOKIE };
