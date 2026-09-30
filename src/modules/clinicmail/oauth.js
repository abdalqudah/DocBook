// "Send as" connections for clinic e-mail (redesign 4.12): the clinic signs in to its Google or Microsoft account and
// allows DocBook to SEND mail only (Gmail: gmail.send; Microsoft: SMTP.Send). The OAuth apps belong to the platform:
// Google reuses the platform's Google sign-in client (Admin → Google), Microsoft needs MS_CLIENT_ID / MS_CLIENT_SECRET.
// The refresh token is stored encrypted; the address that may send is the account that granted the permission.
const crypto = require('crypto');
const config = require('../../config');
const secrets = require('../../core/secrets');
const { AppError } = require('../../core/errors');

const PROVIDERS = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email https://www.googleapis.com/auth/gmail.send', extra: { access_type: 'offline', prompt: 'consent' },
  },
  microsoft: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid email offline_access https://outlook.office.com/SMTP.Send', extra: { prompt: 'select_account' },
  },
};
const PENDING_TTL_MS = 10 * 60_000;
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const redirectUri = () => `${config.appUrl.replace(/\/+$/, '')}/app/website/email/oauth/callback`;
const fail = (code, message, status = 400) => new AppError(code, message, status);
let fetchImpl = (...a) => fetch(...a);

async function client(provider) {
  if (provider === 'google') {
    const g = await require('../auth/google.service').settings(); // eslint-disable-line global-require
    if (!g.enabled) return null;
    return { id: g.client_id, secret: secrets.decrypt(g.secret_enc) };
  }
  if (provider === 'microsoft' && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET) return { id: process.env.MS_CLIENT_ID, secret: process.env.MS_CLIENT_SECRET };
  return null;
}

/** The sign-in URL and what this browser must remember (state, PKCE verifier) — kept in the session. */
async function start(provider, businessId) {
  const p = PROVIDERS[provider];
  const c = p && await client(provider);
  if (!c) throw fail('MAIL_PROVIDER_OFF', 'This provider is not available on this platform.', 404);
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  const u = new URL(p.authorize);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: c.id, redirect_uri: redirectUri(), scope: p.scope, state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', ...p.extra,
  }).toString();
  return { url: u.toString(), pending: { provider, state, verifier, businessId, createdAt: Date.now() } };
}

const claims = (idToken) => { try { return JSON.parse(Buffer.from(String(idToken).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return {}; } };

/**
 * Finishes the sign-in: checks state/age/clinic, exchanges the code (PKCE) over TLS directly with the provider's token
 * endpoint (so the ID token's claims can be read as received), → { provider, account, refreshToken }.
 */
async function finish(pending, query, businessId) {
  const same = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); };
  if (!pending || !same(query.state, pending.state) || Date.now() - Number(pending.createdAt) > PENDING_TTL_MS || pending.businessId !== businessId) {
    throw fail('MAIL_OAUTH_STATE', 'This connection link expired or was opened in another browser. Please start again.');
  }
  if (query.error) throw fail('MAIL_OAUTH_CANCELLED', 'The connection was cancelled.');
  if (typeof query.code !== 'string' || !query.code || query.code.length > 4096) throw fail('MAIL_OAUTH_FAILED', 'The provider did not return a code.');
  const p = PROVIDERS[pending.provider];
  const c = await client(pending.provider);
  if (!p || !c) throw fail('MAIL_PROVIDER_OFF', 'This provider is not available on this platform.', 404);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri(), code_verifier: pending.verifier, client_id: c.id, client_secret: c.secret });
  const res = await fetchImpl(p.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString(), signal: AbortSignal.timeout(10_000), redirect: 'error' });
  let j = null; try { j = await res.json(); } catch { j = null; }
  if (!res.ok || !j || !j.refresh_token) throw fail('MAIL_OAUTH_FAILED', `The provider refused the connection (${(j && j.error) || res.status}).`);
  const cl = claims(j.id_token);
  const account = String(cl.email || cl.preferred_username || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)) throw fail('MAIL_OAUTH_FAILED', 'The provider did not say which address may send.');
  return { provider: pending.provider, account: account.slice(0, 190), refreshToken: j.refresh_token };
}

/** nodemailer options for sending with a refresh token (the access token is fetched and renewed by nodemailer). */
async function transportOptions(provider, { user, refreshToken }) {
  const c = await client(provider);
  if (!c) throw fail('MAIL_PROVIDER_OFF', 'This provider is not available on this platform.', 409);
  const auth = { type: 'OAuth2', user, clientId: c.id, clientSecret: c.secret, refreshToken };
  if (provider === 'google') return { host: 'smtp.gmail.com', port: 465, secure: true, auth };
  return { host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true, auth: { ...auth, accessUrl: PROVIDERS.microsoft.token } };
}

module.exports = { PROVIDERS, start, finish, transportOptions, redirectUri, _setFetch: (fn) => { fetchImpl = fn; } };
