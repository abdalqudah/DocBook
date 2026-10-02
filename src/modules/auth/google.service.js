// Sign in with Google (OpenID Connect, authorization-code flow with state + nonce + PKCE).
// Set up once by the platform admin (/admin/google) with an OAuth client from Google Cloud.
// • The code is exchanged server-side (Node's fetch) and the ID token is verified locally:
//   RS256 signature against Google's published keys, issuer, audience, expiry, nonce, verified e-mail.
// • Only EXISTING DocBook accounts can sign in: found by their linked Google account, else by the verified
//   e-mail (then linked). Unknown addresses are refused — nobody joins a clinic without an invitation.
// • Platform admin accounts keep signing in with their password only.
const crypto = require('crypto');
const knex = require('../../db/knex');
const config = require('../../config');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { E, AppError } = require('../../core/errors');

const GOOGLE = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
};
const PENDING_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_S = 120;
const CLIENT_ID_RE = /^[\w.-]{8,200}\.apps\.googleusercontent\.com$/;

// Tests replace Google's endpoints with a stub (same signature as fetch).
let fetchImpl = (...a) => globalThis.fetch(...a);
const setFetch = (fn) => { fetchImpl = fn || ((...a) => globalThis.fetch(...a)); cache.forgetPrefix('google:jwks'); };

const appBase = () => config.appUrl.replace(/\/+$/, '');
const redirectUri = () => `${appBase()}/auth/google/callback`;
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const safeEq = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); };
const fail = (code, message, status = 400) => new AppError(code, message, status);

// ---------------------------------------------------------------- settings (platform admin)
async function settings() {
  return cache.remember('google:settings', async () => {
    const row = await knex('platform_settings').where({ key: 'google' }).first();
    let v = {};
    try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
    const clientId = v.client_id || '';
    // A secret that no longer decrypts (APP_KEY changed) keeps the button hidden.
    return { enabled: Boolean(v.enabled && clientId && v.secret_enc && secrets.decrypt(v.secret_enc)), switchedOn: Boolean(v.enabled), client_id: clientId, secret_enc: v.secret_enc || null };
  }, 60_000);
}
const enabled = async () => (await settings()).enabled;
/** "abc…xyz" hint of the saved secret, never the secret itself. */
const secretHint = (s) => (s && s.secret_enc ? secrets.mask(secrets.decrypt(s.secret_enc) || '') : null);

async function save(ctx, body) {
  const cur = await settings();
  const clientId = String(body.client_id || '').trim();
  const secret = String(body.client_secret || '').trim();
  const on = body.enabled === '1' || body.enabled === 'on';
  const errors = {};
  if (clientId && !CLIENT_ID_RE.test(clientId)) errors.client_id = 'Paste the Client ID from Google Cloud; it ends with .apps.googleusercontent.com.';
  if (on && !clientId) errors.client_id = 'Enter the Client ID to turn Google sign-in on.';
  if (secret && (secret.length < 10 || secret.length > 200 || /\s/.test(secret))) errors.client_secret = 'Paste the Client secret exactly as Google shows it.';
  if (on && !secret && !cur.secret_enc) errors.client_secret = 'Enter the Client secret to turn Google sign-in on.';
  if (Object.keys(errors).length) throw E.validation(errors);
  // Removing the Client ID forgets the secret too.
  let secretEnc = !clientId ? null : cur.secret_enc;
  if (clientId && secret) {
    try { secretEnc = secrets.encrypt(secret); } catch { throw fail('SECRETS_KEY', 'Set APP_KEY (or SESSION_SECRET) in the server environment to store credentials.', 409); }
  }
  const value = JSON.stringify({ enabled: on, client_id: clientId, secret_enc: secretEnc });
  await knex('platform_settings').insert({ key: 'google', value }).onConflict('key').merge({ value, updated_at: new Date() });
  cache.forgetPrefix('google:');
  await audit.record(ctx, 'platform.google_updated', {
    entityType: 'platform', entityId: 'google',
    oldValues: { enabled: cur.switchedOn, client_id: cur.client_id },
    newValues: { enabled: on, client_id: clientId, client_secret: secret ? 'changed' : (secretEnc ? 'kept' : 'removed') },
  });
}

// ---------------------------------------------------------------- the flow
const INTENTS = ['login', 'link'];
/**
 * Starts a sign-in. Returns Google's URL and the `pending` record the caller keeps in the session until the callback:
 * state (CSRF), nonce (binds the ID token to this browser) and the PKCE verifier (binds the code to this browser).
 */
async function start({ intent = 'login', portal = '', as = '' } = {}) {
  const s = await settings();
  if (!s.enabled) throw fail('GOOGLE_OFF', 'Google sign-in is not available.', 404);
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const u = new URL(GOOGLE.authorize);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: s.client_id, redirect_uri: redirectUri(), scope: 'openid email profile',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  }).toString();
  return {
    url: u.toString(),
    pending: {
      state, nonce, verifier, createdAt: Date.now(),
      intent: INTENTS.includes(intent) ? intent : 'login',
      portal: /^[a-z0-9-]{2,40}$/.test(String(portal || '')) ? String(portal) : '',
      as: /^[a-z_]{2,30}$/.test(String(as || '')) ? String(as) : '',
    },
  };
}

/** Checks the callback against what this browser started (state, age). Throws on any mismatch. */
function checkState(pending, query) {
  if (!pending || !pending.state || !safeEq(query.state, pending.state) || !(Date.now() - Number(pending.createdAt) <= PENDING_TTL_MS)) {
    throw fail('GOOGLE_STATE', 'This sign-in link has expired or was opened in another browser. Please start again.');
  }
  if (query.error) throw fail('GOOGLE_CANCELLED', 'Google sign-in was cancelled.');
  if (!query.code || typeof query.code !== 'string' || query.code.length > 2048) throw fail('GOOGLE_FAILED', 'Google did not return a sign-in code.');
}

async function fetchJson(url, init) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: 'error' });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, body, headers: res.headers };
}

/** Exchanges the authorization code (with the PKCE verifier) for tokens at Google's token endpoint. */
async function exchangeCode({ code, verifier, clientId, clientSecret }) {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier, client_id: clientId, client_secret: clientSecret });
  const r = await fetchJson(GOOGLE.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() });
  if (r.status !== 200 || !r.body || typeof r.body.id_token !== 'string') {
    const why = r.body && r.body.error ? String(r.body.error).slice(0, 60) : `HTTP ${r.status}`;
    throw fail('GOOGLE_FAILED', `Google refused the sign-in code (${why}).`);
  }
  return r.body;
}

/** Google's signing keys (cached for an hour; refreshed once when a token names an unknown key). */
async function jwks(refresh = false) {
  if (refresh) cache.forgetPrefix('google:jwks');
  return cache.remember('google:jwks', async () => {
    const r = await fetchJson(GOOGLE.jwks, { method: 'GET', headers: { accept: 'application/json' } });
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.keys)) throw fail('GOOGLE_FAILED', 'Could not load Google’s signing keys.');
    return r.body.keys;
  }, 3_600_000);
}

/**
 * Verifies an ID token and returns its claims. Throws AppError GOOGLE_TOKEN with the reason.
 * `keys` may be passed directly (unit tests); otherwise Google's JWKS is used.
 */
async function verifyIdToken(idToken, { clientId, nonce, now = Date.now(), keys } = {}) {
  const bad = (why) => fail('GOOGLE_TOKEN', `Google sign-in failed: ${why}`);
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw bad('the ID token is malformed.');
  let header; let claims;
  try {
    header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    claims = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  } catch { throw bad('the ID token is malformed.'); }
  if (!header || header.alg !== 'RS256') throw bad('unexpected token algorithm.');
  let list = keys || await jwks();
  let jwk = list.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk && !keys) { list = await jwks(true); jwk = list.find((k) => k.kid === header.kid && k.kty === 'RSA'); }
  if (!jwk) throw bad('the signing key is unknown.');
  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), key, fromB64url(parts[2]));
  } catch { ok = false; }
  if (!ok) throw bad('the ID token signature is invalid.');
  const t = Math.floor(now / 1000);
  if (!GOOGLE.issuers.includes(claims.iss)) throw bad('the ID token was issued by someone else.');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!clientId || !aud.includes(clientId)) throw bad('the ID token is for a different application.');
  if (claims.azp && claims.azp !== clientId) throw bad('the ID token is for a different application.');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < t) throw bad('the ID token has expired.');
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > t) throw bad('the ID token is not valid yet.');
  if (!nonce || !safeEq(claims.nonce, nonce)) throw bad('the answer does not belong to this browser session.');
  if (!claims.sub || typeof claims.sub !== 'string') throw bad('no account id.');
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || !(claims.email_verified === true || claims.email_verified === 'true')) {
    throw fail('GOOGLE_NO_EMAIL', 'Your Google account did not share a verified e-mail address.');
  }
  return { sub: claims.sub.slice(0, 64), email: email.slice(0, 190), name: typeof claims.name === 'string' ? claims.name.trim().slice(0, 160) : '' };
}

/** The whole callback check: state → code exchange → ID token. Returns { sub, email, name }. */
async function verify(pending, query) {
  checkState(pending, query);
  const s = await settings();
  if (!s.enabled) throw fail('GOOGLE_OFF', 'Google sign-in is not available.', 404);
  const clientSecret = secrets.decrypt(s.secret_enc);
  if (!clientSecret) throw fail('GOOGLE_OFF', 'Google sign-in is not available.', 404);
  try {
    const tokens = await exchangeCode({ code: query.code, verifier: pending.verifier, clientId: s.client_id, clientSecret });
    return await verifyIdToken(tokens.id_token, { clientId: s.client_id, nonce: pending.nonce });
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw fail('GOOGLE_FAILED', 'Could not reach Google. Please try again.', 502);
  }
}

// ---------------------------------------------------------------- accounts
/** The DocBook account for a verified Google identity (existing accounts only). Links it on first use. */
async function resolve(g, ctx = {}) {
  let user = await knex('users').where({ google_sub: g.sub }).first();
  let linkedNow = false;
  if (!user) {
    user = await knex('users').where({ email: g.email }).first();
    if (!user) {
      await audit.record({ ip: ctx.ip, userAgent: ctx.userAgent }, 'auth.google_login_failed', { entityType: 'user', newValues: { email: g.email, reason: 'no_account' } });
      throw fail('GOOGLE_NO_ACCOUNT', 'There is no DocBook account with this e-mail. Ask your clinic for an invitation, or create a clinic with the sign-up form.', 404);
    }
    if (user.google_sub && user.google_sub !== g.sub) {
      await audit.record({ ...ctx, userId: user.id }, 'auth.google_login_failed', { entityType: 'user', entityId: user.id, newValues: { email: g.email, reason: 'other_google_account' } });
      throw fail('GOOGLE_OTHER', 'This DocBook account is linked to a different Google account.', 409);
    }
    linkedNow = true;
  }
  if (user.status !== 'active') throw fail('ACCOUNT_DISABLED', 'This account is disabled.', 403);
  if (user.is_platform_admin) {
    await audit.record({ ...ctx, userId: user.id }, 'auth.google_login_failed', { entityType: 'user', entityId: user.id, newValues: { reason: 'platform_admin' } });
    throw fail('GOOGLE_NOT_ALLOWED', 'Platform admin accounts sign in with their password only.', 403);
  }
  const values = { last_login_at: new Date() };
  if (linkedNow) Object.assign(values, { google_sub: g.sub, google_email: g.email, google_linked_at: new Date() });
  const claimedNow = linkedNow && !user.email_verified_at;
  if (!user.email_verified_at && user.email.toLowerCase() === g.email) values.email_verified_at = new Date(); // Google verified the address
  // The address was never proven before: whoever set that account up (and its password) loses it — the owner of
  // the Google address takes it over, signs in with Google and can set a new password from Forgot password.
  if (claimedNow) values.password_hash = await require('./auth.service').hashPassword(require('crypto').randomBytes(24).toString('hex')); // eslint-disable-line global-require
  await knex('users').where({ id: user.id }).update(values);
  if (claimedNow) await require('./security.service').endOtherSessions(user.id, null).catch(() => {}); // eslint-disable-line global-require
  if (linkedNow) await audit.record({ ...ctx, userId: user.id }, 'auth.google_linked', { entityType: 'user', entityId: user.id, newValues: { google_email: g.email, via: 'sign_in' } });
  await audit.record({ ...ctx, userId: user.id }, 'auth.login', { entityType: 'user', entityId: user.id, newValues: { method: 'google' } });
  return knex('users').where({ id: user.id }).first();
}

/** Links a Google account to the signed-in user (Settings → Security). */
async function link(ctx, userId, g) {
  const user = await knex('users').where({ id: userId }).first();
  if (!user) throw E.notFound('User');
  if (user.is_platform_admin) throw fail('GOOGLE_NOT_ALLOWED', 'Platform admin accounts sign in with their password only.', 403);
  const other = await knex('users').where({ google_sub: g.sub }).whereNot({ id: userId }).first('id');
  if (other) throw fail('GOOGLE_TAKEN', 'This Google account is already linked to another DocBook account.', 409);
  await knex('users').where({ id: userId }).update({ google_sub: g.sub, google_email: g.email, google_linked_at: new Date() });
  await audit.record({ ...ctx, userId }, 'auth.google_linked', { entityType: 'user', entityId: userId, newValues: { google_email: g.email, via: 'settings' } });
}

async function unlink(ctx, userId) {
  const user = await knex('users').where({ id: userId }).first('google_email', 'google_sub');
  if (!user || !user.google_sub) return false;
  await knex('users').where({ id: userId }).update({ google_sub: null, google_email: null, google_linked_at: null });
  await audit.record({ ...ctx, userId }, 'auth.google_unlinked', { entityType: 'user', entityId: userId, oldValues: { google_email: user.google_email } });
  return true;
}

module.exports = {
  GOOGLE, PENDING_TTL_MS, CLIENT_ID_RE, setFetch, redirectUri, appBase, settings, enabled, secretHint, save,
  start, checkState, exchangeCode, verifyIdToken, verify, resolve, link, unlink,
};
