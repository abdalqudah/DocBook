// Sign in with Google or Microsoft (OpenID Connect, authorization-code flow with PKCE, state and nonce).
//
// Account matching is deliberately strict, because an e-mail address in a token is only as good as the provider's
// promise about it:
//   • a linked external account (provider + subject) always signs in its own user;
//   • otherwise the address is used to find or create an account only when the provider vouches for it —
//     Google: email_verified = true; Microsoft: the domain-owner-verified claim (xms_edov) or a single-tenant setup
//     (your own Microsoft 365 directory). A Microsoft address that is not verified is never trusted, which blocks
//     the known "unverified e-mail" account-takeover pattern;
//   • new accounts are created only for students; staff accounts are created by GEC administrators and can then
//     sign in with their work account.
//
// The ID token is taken directly from the provider's token endpoint over TLS with our client secret, so — as the
// OpenID Connect core spec allows for this flow — its issuer, audience, expiry and nonce are checked instead of
// fetching signing keys.
const crypto = require('crypto');
const knex = require('../../db/knex');
const config = require('../../config');
const secrets = require('../../core/secrets');
const audit = require('../../core/audit');
const { AppError } = require('../../core/errors');
const settings = require('../settings/settings.service');

const SINGLE_TENANT = (t) => !!t && !['common', 'organizations', 'consumers'].includes(String(t).toLowerCase());
const PROVIDERS = {
  google: {
    authUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    validIssuer: (iss) => iss === 'https://accounts.google.com' || iss === 'accounts.google.com',
    subject: (c) => c.sub,
    email: (c) => (c.email ? String(c.email).toLowerCase() : null),
    trusted: (c) => c.email_verified === true || c.email_verified === 'true',
  },
  microsoft: {
    authUrl: (s) => `https://login.microsoftonline.com/${encodeURIComponent(s.tenant || 'common')}/oauth2/v2.0/authorize`,
    tokenUrl: (s) => `https://login.microsoftonline.com/${encodeURIComponent(s.tenant || 'common')}/oauth2/v2.0/token`,
    validIssuer: (iss, c, s) => {
      if (!c.tid || iss !== `https://login.microsoftonline.com/${c.tid}/v2.0`) return false;
      return !SINGLE_TENANT(s.tenant) || !/^[0-9a-f-]{36}$/i.test(s.tenant) || c.tid.toLowerCase() === s.tenant.toLowerCase();
    },
    subject: (c) => (c.tid && c.oid ? `${c.tid}:${c.oid}` : c.sub),
    email: (c) => { const e = c.email || (c.preferred_username && /@/.test(c.preferred_username) ? c.preferred_username : null); return e ? String(e).toLowerCase() : null; },
    trusted: (c, s) => c.xms_edov === true || c.xms_edov === 'true' || c.xms_edov === 1 || (SINGLE_TENANT(s.tenant) && !!c.tid),
  },
};
const NAMES = Object.keys(PROVIDERS);

let fetchImpl = (...a) => fetch(...a);
/** Tests: replace the HTTP client. */
const useFetch = (fn) => { fetchImpl = fn; };

const fail = (code, message, status = 400) => new AppError(code, message, status);
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const redirectUri = (provider) => `${config.appUrl}/auth/${provider}/callback`;

async function providerSettings(provider) {
  if (!PROVIDERS[provider]) return null;
  const all = (await settings.get('integration.sso')) || {};
  const s = all[provider] || {};
  if (!s.enabled || !s.client_id || !s.client_secret_enc) return null;
  return { ...s, clientSecret: secrets.decrypt(s.client_secret_enc) };
}

/** Providers switched on for a portal ('student' | 'staff'). */
async function available(portal) {
  const out = [];
  for (const p of NAMES) {
    const s = await providerSettings(p); // eslint-disable-line no-await-in-loop
    if (s && (portal === 'staff' ? s.staff : s.students)) out.push(p);
  }
  return out;
}

/** Starts the flow: remembers state / PKCE verifier / nonce in the session and returns the provider's address. */
async function begin(req, provider, { portal, mode = 'login' }) {
  const s = await providerSettings(provider);
  if (!s || (mode === 'login' && !(portal === 'staff' ? s.staff : s.students))) throw fail('SSO_NOT_AVAILABLE', 'This sign-in option is not available.', 404);
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  req.session.sso = { provider, portal, mode, state, nonce, verifier, userId: mode === 'link' ? req.user.id : null, at: Date.now() };
  const p = new URLSearchParams({
    client_id: s.client_id, response_type: 'code', redirect_uri: redirectUri(provider), scope: 'openid email profile',
    state, nonce, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${PROVIDERS[provider].authUrl(s)}?${p}`;
}

function decodeIdToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw fail('SSO_FAILED', 'The provider returned an invalid token.');
  try { return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { throw fail('SSO_FAILED', 'The provider returned an invalid token.'); }
}

/** Finishes the flow: checks state, exchanges the code, validates the ID token. Returns the pending flow + claims. */
async function complete(req, provider, query) {
  const flow = req.session.sso;
  delete req.session.sso;
  if (query.error) throw fail('SSO_CANCELLED', 'Sign-in was cancelled.');
  if (!flow || flow.provider !== provider || !query.state || query.state.length !== flow.state.length
    || !crypto.timingSafeEqual(Buffer.from(String(query.state)), Buffer.from(flow.state)) || Date.now() - flow.at > 10 * 60_000) throw fail('SSO_STATE', 'This sign-in link expired. Please try again.');
  const s = await providerSettings(provider);
  if (!s) throw fail('SSO_NOT_AVAILABLE', 'This sign-in option is not available.', 404);
  const res = await fetchImpl(PROVIDERS[provider].tokenUrl(s), {
    method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: String(query.code || ''), redirect_uri: redirectUri(provider), client_id: s.client_id, client_secret: s.clientSecret, code_verifier: flow.verifier }).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.id_token) throw fail('SSO_FAILED', 'The provider did not confirm the sign-in.');
  const c = decodeIdToken(json.id_token);
  const def = PROVIDERS[provider];
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(s.client_id) || !def.validIssuer(c.iss, c, s) || !(Number(c.exp) > now - 60) || c.nonce !== flow.nonce) throw fail('SSO_FAILED', 'The sign-in could not be verified.');
  const subject = def.subject(c);
  if (!subject) throw fail('SSO_FAILED', 'The sign-in could not be verified.');
  return { flow, claims: { provider, subject: String(subject).slice(0, 191), email: def.email(c), emailTrusted: !!def.email(c) && def.trusted(c, s), name: c.name || [c.given_name, c.family_name].filter(Boolean).join(' ') || null, locale: c.locale } };
}

async function link(userId, claims) {
  await knex('user_identities').insert({ user_id: userId, provider: claims.provider, subject: claims.subject, email: claims.email, last_used_at: new Date() });
}

/** The account to sign in for these claims on this portal (creating a student account when allowed). */
async function resolveUser(ctx, claims, portal) {
  const ident = await knex('user_identities').where({ provider: claims.provider, subject: claims.subject }).first();
  if (ident) {
    const u = await knex('users').where({ id: ident.user_id }).first();
    if (!u || u.kind !== portal) throw fail('SSO_WRONG_PORTAL', 'This account belongs to the other sign-in page.');
    if (u.status === 'disabled') throw fail('ACCOUNT_DISABLED', 'This account is disabled.', 403);
    await knex('user_identities').where({ id: ident.id }).update({ last_used_at: new Date(), email: claims.email || ident.email });
    return u;
  }
  if (!claims.emailTrusted) throw fail('SSO_EMAIL_UNVERIFIED', 'This account’s e-mail address is not verified by the provider. Sign in with your password, then connect the account from your settings.', 403);
  let u = await knex('users').where({ kind: portal, email: claims.email }).first();
  if (u) {
    if (u.status === 'disabled') throw fail('ACCOUNT_DISABLED', 'This account is disabled.', 403);
    if (await knex('user_identities').where({ user_id: u.id, provider: claims.provider }).first()) throw fail('SSO_OTHER_LINKED', 'A different account from this provider is already connected. Sign in with that one or with your password.', 403);
    await link(u.id, claims);
    if (!u.email_verified_at || u.status === 'invited') await knex('users').where({ id: u.id }).update({ email_verified_at: u.email_verified_at || new Date(), status: 'active' });
    await audit.record({ ...ctx, userId: u.id }, 'auth.sso_linked', { entityType: 'user', entityId: u.id, newValues: { provider: claims.provider, automatic: true } });
    u = await knex('users').where({ id: u.id }).first();
    if (portal === 'student') await require('../portal/account').linkStudent(ctx, u, { visitorId: ctx.visitorId }); // eslint-disable-line global-require
    return u;
  }
  if (portal === 'staff') throw fail('SSO_NO_STAFF_ACCOUNT', 'There is no staff account for this address. Ask an administrator to add you.', 403);
  const [id] = await knex('users').insert({ kind: 'student', email: claims.email, name: (claims.name || claims.email).slice(0, 160), password_hash: null, locale: /^ar/.test(claims.locale || '') ? 'ar' : 'en', status: 'active', email_verified_at: new Date(), notification_prefs: JSON.stringify({ marketing: false }) });
  await link(id, claims);
  u = await knex('users').where({ id }).first();
  await audit.record({ ...ctx, userId: id }, 'portal.registered', { entityType: 'user', entityId: id, newValues: { via: claims.provider } });
  await require('../portal/account').linkStudent(ctx, u, { visitorId: ctx.visitorId }); // eslint-disable-line global-require
  return u;
}

/** Connects an external account to the signed-in user. */
async function connect(ctx, userId, claims) {
  const other = await knex('user_identities').where({ provider: claims.provider, subject: claims.subject }).first();
  if (other && other.user_id !== userId) throw fail('SSO_ALREADY_LINKED', 'This account is already connected to another user.', 409);
  if (other) return;
  await knex('user_identities').where({ user_id: userId, provider: claims.provider }).del(); // replace an earlier one
  await link(userId, claims);
  await audit.record({ ...ctx, userId }, 'auth.sso_linked', { entityType: 'user', entityId: userId, newValues: { provider: claims.provider } });
}

/** Disconnects; refused when it would leave the user without any way to sign in. */
async function disconnect(ctx, userId, provider) {
  const u = await knex('users').where({ id: userId }).first();
  const ids = await knex('user_identities').where({ user_id: userId });
  if (!ids.some((i) => i.provider === provider)) return;
  if (!u.password_hash && ids.length <= 1) throw fail('SSO_LAST_METHOD', 'Set a password first — otherwise you could not sign in any more.', 409);
  await knex('user_identities').where({ user_id: userId, provider }).del();
  await audit.record({ ...ctx, userId }, 'auth.sso_unlinked', { entityType: 'user', entityId: userId, newValues: { provider } });
}

const identitiesOf = (userId) => knex('user_identities').where({ user_id: userId }).select('provider', 'email', 'created_at', 'last_used_at');

module.exports = { PROVIDERS, NAMES, available, begin, complete, resolveUser, connect, disconnect, identitiesOf, providerSettings, redirectUri, useFetch, SINGLE_TENANT };
