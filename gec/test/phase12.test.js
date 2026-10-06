const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { knex, resetDb, makeStaff, staffAgent, agent } = require('./helpers');
const { hashPassword } = require('../src/modules/auth/auth.service');

const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)[1];
const form = async (a, url, body) => { const t = await a.token(); return a.post(url).type('form').send({ _csrf: t, ...body }); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const MS_TID = '72f988bf-86f1-41af-91ab-2d7cd011db47';

// Simulated token endpoints: the next ID-token claims are set per test.
let nextClaims = null; let lastTokenRequest = null;
const sso = require('../src/modules/auth/sso');
sso.useFetch(async (url, opts) => {
  lastTokenRequest = { url, body: new URLSearchParams(opts.body) };
  if (!nextClaims) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  return new Response(JSON.stringify({ id_token: `${b64({ alg: 'RS256' })}.${b64(nextClaims)}.sig`, access_token: 'x' }), { status: 200 });
});

/** Runs a whole sign-in: start → (provider) → callback. `claims(nonce)` builds the ID token. */
async function signIn(a, provider, portal, claims, { tamperState = false } = {}) {
  const start = await a.get(`/auth/${provider}/start?portal=${portal}`);
  assert.equal(start.status, 302, `start ${provider}`);
  const u = new URL(start.headers.location);
  nextClaims = claims(u.searchParams.get('nonce'), u);
  const state = tamperState ? 'x'.repeat(u.searchParams.get('state').length) : u.searchParams.get('state');
  const r = await a.get(`/auth/${provider}/callback?code=abc&state=${encodeURIComponent(state)}`);
  return { r, authUrl: u };
}
const now = () => Math.floor(Date.now() / 1000);
const google = (over = {}) => (nonce) => ({ iss: 'https://accounts.google.com', aud: 'google-client.apps.googleusercontent.com', exp: now() + 300, iat: now(), nonce, sub: '1001', email: 'noor@example.com', email_verified: true, name: 'Noor Khalil', ...over });
const microsoft = (over = {}) => (nonce) => ({ iss: `https://login.microsoftonline.com/${MS_TID}/v2.0`, aud: 'ms-client-id', exp: now() + 300, iat: now(), nonce, tid: MS_TID, oid: 'aaaa-1', sub: 'pairwise', email: 'noor@example.com', name: 'Noor', ...over });

let admin; let staffUser;
test.before(async () => {
  await resetDb();
  admin = await makeStaff({ role: 'super_admin' });
  staffUser = await makeStaff({ role: 'counsellor', email: 'counsellor@gec-staff.test' });
});
test.after(() => knex.destroy());

test('not configured: no buttons and the start address is unavailable', async () => {
  const a = await agent();
  assert.doesNotMatch((await a.get('/login')).text, /Continue with Google/);
  assert.equal((await a.get('/auth/google/start?portal=student')).status, 404);
});

test('settings: credentials encrypted, portals chosen per provider, buttons appear', async () => {
  const s = await staffAgent(admin);
  await form(s, '/staff/settings/sign-in', { provider: 'google', enabled: '1', students: '1', staff: '1', client_id: 'google-client.apps.googleusercontent.com', client_secret: 'g-secret-123' });
  await form(s, '/staff/settings/sign-in', { provider: 'microsoft', enabled: '1', students: '1', client_id: 'ms-client-id', client_secret: 'ms-secret-456', tenant: 'common' });
  const row = await knex('settings').where({ key: 'integration.sso' }).first();
  assert.doesNotMatch(JSON.stringify(row.value), /g-secret-123|ms-secret-456/, 'secrets encrypted');
  const a = await agent();
  const login = await a.get('/login');
  assert.match(login.text, /Continue with Google/); assert.match(login.text, /Continue with Microsoft/);
  const staffLogin = await a.get('/staff/login');
  assert.match(staffLogin.text, /Continue with Google/); assert.doesNotMatch(staffLogin.text, /Continue with Microsoft/, 'Microsoft not enabled for staff');
  assert.equal((await a.get('/auth/microsoft/start?portal=staff')).status, 404);
  assert.match((await a.get('/register')).text, /Continue with Google/);
});

test('Google: new student account with a verified address, PKCE, then signs in by account id', async () => {
  const a = await agent();
  const { r, authUrl } = await signIn(a, 'google', 'student', google());
  assert.equal(r.status, 302); assert.equal(r.headers.location, '/portal');
  assert.equal(authUrl.host, 'accounts.google.com'); assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  const verifier = lastTokenRequest.body.get('code_verifier');
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), authUrl.searchParams.get('code_challenge'), 'PKCE verifier matches');
  assert.equal(lastTokenRequest.body.get('client_secret'), 'g-secret-123');
  const u = await knex('users').where({ kind: 'student', email: 'noor@example.com' }).first();
  assert.ok(u); assert.equal(u.password_hash, null); assert.ok(u.email_verified_at);
  assert.ok(await knex('students').where({ user_id: u.id }).first(), 'student record created and linked');
  assert.equal((await a.get('/portal')).status, 200);
  // Same Google account, different e-mail in the token → still the same user
  const b = await agent();
  const again = await signIn(b, 'google', 'student', google({ email: 'noor.new@example.com' }));
  assert.equal(again.r.headers.location, '/portal');
  assert.equal(Number((await knex('users').where({ kind: 'student' }).count({ n: '*' }))[0].n), 1);
  assert.ok(await knex('audit_logs').where({ action: 'auth.login', user_id: u.id }).first());
});

test('the flow is bound to the browser: wrong state, nonce, audience or issuer are refused', async () => {
  const cases = [
    [{ tamperState: true }, google({ sub: 'x1', email: 'x1@example.com' })],
    [{}, (nonce) => google({ sub: 'x2', email: 'x2@example.com' })(`${nonce}-other`)],
    [{}, google({ sub: 'x3', email: 'x3@example.com', aud: 'someone-else' })],
    [{}, google({ sub: 'x4', email: 'x4@example.com', iss: 'https://evil.example' })],
    [{}, google({ sub: 'x5', email: 'x5@example.com', exp: now() - 600 })],
  ];
  for (const [opts, claims] of cases) {
    const { r } = await signIn(await agent(), 'google', 'student', claims, opts); // eslint-disable-line no-await-in-loop
    assert.notEqual(r.status, 302);
  }
  assert.equal(await knex('users').where('email', 'like', 'x%@example.com').first(), undefined, 'no accounts created');
  // Callback without having started (e.g. a forged link)
  const c = await (await agent()).get('/auth/google/callback?code=abc&state=whatever');
  assert.equal(c.status, 400);
});

test('existing accounts: linked only when the provider vouches for the address (blocks unverified Microsoft e-mails)', async () => {
  const [uid] = await knex('users').insert({ kind: 'student', email: 'rami@example.com', name: 'Rami', password_hash: await hashPassword('RamiPass123!'), status: 'active', email_verified_at: new Date() });
  // Google says the address is not verified → refused
  let res = await signIn(await agent(), 'google', 'student', google({ sub: 'g-rami', email: 'rami@example.com', email_verified: false }));
  assert.match(res.r.text, /did not confirm this e-mail/);
  // Microsoft multi-tenant without a verified-domain claim → refused (someone could put any address on their account)
  res = await signIn(await agent(), 'microsoft', 'student', microsoft({ oid: 'ms-rami', email: 'rami@example.com' }));
  assert.match(res.r.text, /did not confirm this e-mail/);
  assert.equal(await knex('user_identities').where({ user_id: uid }).first(), undefined);
  // With the verified-domain claim → linked to the existing account
  res = await signIn(await agent(), 'microsoft', 'student', microsoft({ oid: 'ms-rami', email: 'rami@example.com', xms_edov: true }));
  assert.equal(res.r.headers.location, '/portal');
  assert.equal((await knex('user_identities').where({ user_id: uid }).first()).provider, 'microsoft');
  assert.equal(Number((await knex('users').where({ email: 'rami@example.com' }).count({ n: '*' }))[0].n), 1, 'no duplicate account');
});

test('staff: only existing staff accounts; never created; portals kept apart; disabled accounts refused', async () => {
  let res = await signIn(await agent(), 'google', 'staff', google({ sub: 'g-staff', email: 'counsellor@gec-staff.test' }));
  assert.equal(res.r.headers.location, '/staff');
  res = await signIn(await agent(), 'google', 'staff', google({ sub: 'g-nobody', email: 'nobody@gec-staff.test' }));
  assert.match(res.r.text, /no staff account/);
  assert.equal(await knex('users').where({ email: 'nobody@gec-staff.test' }).first(), undefined);
  // The student's Google account cannot open the workspace
  res = await signIn(await agent(), 'google', 'staff', google());
  assert.match(res.r.text, /other sign-in page/);
  await knex('users').where({ id: staffUser.user.id }).update({ status: 'disabled' });
  res = await signIn(await agent(), 'google', 'staff', google({ sub: 'g-staff', email: 'counsellor@gec-staff.test' }));
  assert.notEqual(res.r.headers.location, '/staff');
  await knex('users').where({ id: staffUser.user.id }).update({ status: 'active' });
});

test('connect and disconnect from settings; the last sign-in method cannot be removed', async () => {
  // Rami (has a password) connects Google from the portal
  const a = await agent(); const lp = await a.get('/login');
  await a.post('/login').type('form').send({ _csrf: csrfOf(lp.text), email: 'rami@example.com', password: 'RamiPass123!' });
  const settings = await a.get('/portal/settings');
  assert.match(settings.text, /Sign-in accounts/);
  const go = await a.post('/auth/google/connect').type('form').send({ _csrf: csrfOf(settings.text) });
  assert.equal(go.status, 302);
  const u = new URL(go.headers.location);
  nextClaims = google({ sub: 'g-rami-2', email: 'rami.personal@example.com', email_verified: false })(u.searchParams.get('nonce'));
  const cb = await a.get(`/auth/google/callback?code=abc&state=${u.searchParams.get('state')}`);
  assert.equal(cb.headers.location, '/portal/settings');
  const rami = await knex('users').where({ email: 'rami@example.com' }).first();
  assert.ok(await knex('user_identities').where({ user_id: rami.id, provider: 'google', subject: 'g-rami-2' }).first(), 'an explicitly connected account needs no address match');
  // Someone else's account cannot be connected
  const s2 = await a.get('/portal/settings');
  const go2 = await a.post('/auth/google/connect').type('form').send({ _csrf: csrfOf(s2.text) });
  const u2 = new URL(go2.headers.location);
  nextClaims = google()(u2.searchParams.get('nonce')); // Noor's Google account
  await a.get(`/auth/google/callback?code=abc&state=${u2.searchParams.get('state')}`);
  assert.equal((await knex('user_identities').where({ provider: 'google', subject: '1001' }).first()).user_id !== rami.id, true);
  const s3 = await a.get('/portal/settings');
  await a.post('/auth/google/disconnect').type('form').send({ _csrf: csrfOf(s3.text) });
  assert.equal(await knex('user_identities').where({ user_id: rami.id, provider: 'google' }).first(), undefined, 'disconnected (password remains)');
  // Noor has no password and only Google → cannot disconnect it
  const n = await agent();
  await signIn(n, 'google', 'student', google());
  const ns = await n.get('/portal/settings');
  assert.match(ns.text, /no password yet/);
  await n.post('/auth/google/disconnect').type('form').send({ _csrf: csrfOf(ns.text) });
  assert.ok(await knex('user_identities').where({ provider: 'google', subject: '1001' }).first(), 'kept');
  // Connect requires CSRF
  const noCsrf = await n.post('/auth/microsoft/connect').type('form').send({});
  assert.doesNotMatch(String(noCsrf.headers.location || ''), /microsoftonline/, 'refused without a CSRF token');
});

test('Microsoft single-tenant (own directory) is trusted for staff', async () => {
  const s = await staffAgent(admin);
  await form(s, '/staff/settings/sign-in', { provider: 'microsoft', enabled: '1', students: '1', staff: '1', tenant: MS_TID });
  const res = await signIn(await agent(), 'microsoft', 'staff', microsoft({ oid: 'ms-staff', email: 'counsellor@gec-staff.test' }));
  assert.equal(res.authUrl.pathname, `/${MS_TID}/oauth2/v2.0/authorize`);
  assert.equal(res.r.headers.location, '/staff');
  const other = await signIn(await agent(), 'microsoft', 'staff', microsoft({ oid: 'ms-x', email: 'counsellor@gec-staff.test', tid: '11111111-1111-1111-1111-111111111111', iss: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0' }));
  assert.notEqual(other.r.headers.location, '/staff', 'another directory is refused');
});
