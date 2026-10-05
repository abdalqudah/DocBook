// Who may open a clinic's screen link — the waiting-room TV (/queue/<token>) and the attendance door screen
// (/kiosk/<token>). The secret link alone is not enough: the device must first be opened while an owner, a clinic
// manager of that clinic or a system admin is signed in. That device then gets a pass for that one screen (a signed,
// http-only cookie limited to the screen's own address), so the manager can sign out and the screen keeps working
// without a staff session left on a TV or a door tablet. Anyone else opening the link is sent to sign in.
// A new link (Settings → screens) makes every earlier pass stop working. Requests are limited per address.
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { E } = require('./errors');

const PASS_DAYS = 180;
const ALLOWED_ROLES = ['owner', 'clinic_manager'];

const sign = (kind, token, exp) => crypto.createHmac('sha256', config.sessionSecret).update(`screen|${kind}|${token}|${exp}`).digest('base64url');
const cookieName = (kind) => `dbs_${kind}`;

function passValid(req, kind, token) {
  const raw = req.cookies && req.cookies[cookieName(kind)];
  const m = /^(\d{10,13})\.([A-Za-z0-9_-]{20,})$/.exec(String(raw || ''));
  if (!m || Number(m[1]) < Date.now()) return false;
  const want = Buffer.from(sign(kind, token, m[1]));
  const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function givePass(req, res, kind, token) {
  const exp = String(Date.now() + PASS_DAYS * 86_400_000);
  res.cookie(cookieName(kind), `${exp}.${sign(kind, token, exp)}`, {
    httpOnly: true, sameSite: 'lax', secure: config.isProd ? req.secure : false, path: `/${kind}/${token}`, maxAge: PASS_DAYS * 86_400_000,
  });
}

/** Is the signed-in user an owner / clinic manager of this clinic, or a system admin? */
async function mayAuthorise(req, businessId) {
  const u = req.user;
  if (!u) return false;
  if (u.is_platform_admin) return true;
  const knex = require('../db/knex'); // eslint-disable-line global-require
  const m = await knex.main('memberships as m').join('roles as r', 'r.id', 'm.role_id')
    .where({ 'm.business_id': businessId, 'm.user_id': u.id, 'm.status': 'active' }).first('r.key');
  return Boolean(m && ALLOWED_ROLES.includes(m.key));
}

/** Per-address limit on a screen's link (the pages poll every few seconds; a clinic may run several screens). */
const limiter = rateLimit({ windowMs: 60_000, limit: config.isTest ? 5000 : 300, standardHeaders: true, legacyHeaders: false, handler: (req, res, next) => next(E.rateLimited()) });

/**
 * Guard for every address under /<kind>/<token>: a valid pass, or an allowed signed-in user (who gives the device
 * its pass). `screenOf(token)` → { b } or null (unknown link: left to the 404).
 */
function guard(kind, screenOf) {
  return async (req, res, next) => {
    try {
      const { token } = req.params;
      if (passValid(req, kind, token)) return next();
      const s = await screenOf(token);
      if (!s) return next(); // unknown / disabled link → the usual "not found"
      if (await mayAuthorise(req, s.b.id)) { givePass(req, res, kind, token); return next(); }
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
      const page = req.method === 'GET' && (req.path === '/' || req.path === ''); // the screen page itself (not its data)
      if (!page) return res.status(401).json({ error: { code: 'SCREEN_NOT_AUTHORISED' } });
      if (req.user) return next(E.forbidden('screen')); // signed in, but not an owner / manager of this clinic
      if (req.session) req.session.returnTo = req.originalUrl.split('?')[0];
      return res.redirect('/login');
    } catch (e) { return next(e); }
  };
}

/** Tests: the Cookie header a device holding a pass for this screen sends. */
const _passCookie = (kind, token) => { const exp = String(Date.now() + 86_400_000); return `${cookieName(kind)}=${exp}.${sign(kind, token, exp)}`; };

module.exports = { guard, limiter, passValid, ALLOWED_ROLES, _passCookie };
