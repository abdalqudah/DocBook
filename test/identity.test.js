// Sign in with Google (state/nonce/PKCE, ID-token validation, account matching, portal rules) and
// verified custom domains (host validation, DNS verification with a mocked resolver, host-based routing).
// Google's endpoints and DNS are stubbed: nothing leaves the machine.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const google = require('../src/modules/auth/google.service');
const domains = require('../src/modules/branding/domain.service');

const CLIENT_ID = '1234567890-testclient.apps.googleusercontent.com';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

function idToken(claims = {}, { key = privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub: '1000001', email: 'staff@a.test', email_verified: true, name: 'Staff', iat: now, exp: now + 3600, nonce: 'n-1', ...claims };
  const head = b64({ alg, kid, typ: 'JWT' });
  const payload = b64(body);
  const sig = alg === 'none' ? '' : crypto.sign('sha256', Buffer.from(`${head}.${payload}`), key).toString('base64url');
  return `${head}.${payload}.${sig}`;
}

/** A fetch stand-in for Google's token endpoint and key set. */
function googleStub(tokenFor) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const json = (status, body) => ({ status, text: async () => JSON.stringify(body), headers: new Map() });
    if (url === google.GOOGLE.jwks) return json(200, { keys: [JWK] });
    if (url === google.GOOGLE.token) {
      const form = new URLSearchParams(init.body);
      return tokenFor(form);
    }
    return json(404, {});
  };
  fn.calls = calls;
  return fn;
}

let owner; let clinicA; let clinicB; let staffId; let adminId;

async function clinic(email, name, slug) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  await businesses.setSlug({ businessId, userId }, slug);
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date() });
  businesses.forget && businesses.forget(businessId);
  return { businessId, userId };
}

async function enableGoogle() {
  await google.save({ userId: adminId }, { client_id: CLIENT_ID, client_secret: 'GOCSPX-unit-test-secret', enabled: '1' });
}

test.before(async () => {
  await knex.migrate.rollback(undefined, true);
  await knex.migrate.latest();
  cache.clear();
  clinicA = await clinic('owner@a.test', 'Clinic A', 'clinic-a');
  clinicB = await clinic('owner@b.test', 'Clinic B', 'clinic-b');
  owner = clinicA;
  staffId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Staff', email: 'staff@a.test', password: 'Passw0rd!x' }));
  const role = await knex('roles').where({ business_id: clinicA.businessId, key: 'receptionist' }).first('id');
  await knex('memberships').insert({ business_id: clinicA.businessId, user_id: staffId, role_id: role.id, status: 'active' });
  adminId = await knex.transaction((trx) => auth.createUser(trx, { name: 'Admin', email: 'admin@platform.test', password: 'Passw0rd!x' }));
  await knex('users').where({ id: adminId }).update({ is_platform_admin: true });
});

test.after(async () => { google.setFetch(null); await knex.destroy(); });

// ---------------------------------------------------------------- Google: settings & start
test('Google settings: validation, encrypted secret, masked hint', async () => {
  await assert.rejects(google.save({ userId: adminId }, { client_id: 'not-a-client', enabled: '1' }), { code: 'VALIDATION_FAILED' });
  await assert.rejects(google.save({ userId: adminId }, { client_id: CLIENT_ID, enabled: '1' }), (e) => Boolean(e.details && e.details.client_secret));
  await enableGoogle();
  const row = await knex('platform_settings').where({ key: 'google' }).first();
  assert.ok(!row.value.includes('GOCSPX-unit-test-secret'), 'the secret is stored encrypted');
  const s = await google.settings();
  assert.equal(s.enabled, true);
  assert.equal(google.secretHint(s), 'GOC…ret');
  // Saving again without a secret keeps the stored one.
  await google.save({ userId: adminId }, { client_id: CLIENT_ID, client_secret: '', enabled: '1' });
  assert.equal((await google.settings()).enabled, true);
  const audit = await knex('audit_logs').where({ action: 'platform.google_updated' }).orderBy('id', 'desc').first();
  assert.ok(!JSON.stringify(audit.new_values).includes('GOCSPX'), 'the audit trail never holds the secret');
});

test('start: authorization URL carries state, nonce and an S256 PKCE challenge', async () => {
  await enableGoogle();
  const { url, pending } = await google.start({ portal: 'clinic-a', as: 'receptionist' });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const q = Object.fromEntries(u.searchParams);
  assert.equal(q.client_id, CLIENT_ID);
  assert.equal(q.response_type, 'code');
  assert.equal(q.scope, 'openid email profile');
  assert.equal(q.redirect_uri, google.redirectUri());
  assert.equal(q.state, pending.state);
  assert.equal(q.nonce, pending.nonce);
  assert.equal(q.code_challenge_method, 'S256');
  assert.equal(q.code_challenge, crypto.createHash('sha256').update(pending.verifier).digest('base64url'));
  assert.ok(pending.state.length >= 32 && pending.nonce.length >= 32 && pending.verifier.length >= 43);
  assert.equal(pending.portal, 'clinic-a');
  const bad = await google.start({ portal: '../evil', as: '<x>' });
  assert.equal(bad.pending.portal, '');
  assert.equal(bad.pending.as, '');
});

test('checkState: wrong, missing, expired and cancelled answers are refused', () => {
  const p = { state: 'abcdefgh', nonce: 'n', verifier: 'v', createdAt: Date.now() };
  assert.throws(() => google.checkState(null, { state: 'abcdefgh', code: 'c' }), { code: 'GOOGLE_STATE' });
  assert.throws(() => google.checkState(p, { state: 'abcdefgX', code: 'c' }), { code: 'GOOGLE_STATE' });
  assert.throws(() => google.checkState(p, { code: 'c' }), { code: 'GOOGLE_STATE' });
  assert.throws(() => google.checkState({ ...p, createdAt: Date.now() - google.PENDING_TTL_MS - 1000 }, { state: 'abcdefgh', code: 'c' }), { code: 'GOOGLE_STATE' });
  assert.throws(() => google.checkState(p, { state: 'abcdefgh', error: 'access_denied' }), { code: 'GOOGLE_CANCELLED' });
  assert.throws(() => google.checkState(p, { state: 'abcdefgh' }), { code: 'GOOGLE_FAILED' });
  assert.doesNotThrow(() => google.checkState(p, { state: 'abcdefgh', code: 'c' }));
});

// ---------------------------------------------------------------- ID token
test('verifyIdToken: accepts a valid token and checks signature, iss, aud, exp, nonce, email_verified', async () => {
  const opts = { clientId: CLIENT_ID, nonce: 'n-1', keys: [JWK] };
  const ok = await google.verifyIdToken(idToken(), opts);
  assert.deepEqual(ok, { sub: '1000001', email: 'staff@a.test', name: 'Staff' });
  assert.equal((await google.verifyIdToken(idToken({ iss: 'accounts.google.com', email: 'Staff@A.test' }), opts)).email, 'staff@a.test');
  const reject = (tok, code = 'GOOGLE_TOKEN') => assert.rejects(google.verifyIdToken(tok, opts), { code });
  await reject(idToken({}, { key: other.privateKey }));                       // signed by someone else
  await reject(idToken({}, { alg: 'none' }));                                  // unsigned
  await reject(idToken({}, { alg: 'HS256' }));
  await reject(idToken({}, { kid: 'unknown' }));
  await reject(idToken({ iss: 'https://evil.example.com' }));
  await reject(idToken({ aud: 'other.apps.googleusercontent.com', azp: 'other.apps.googleusercontent.com' }));
  await reject(idToken({ azp: 'other.apps.googleusercontent.com' }));
  await reject(idToken({ exp: Math.floor(Date.now() / 1000) - 600 }));
  await reject(idToken({ iat: Math.floor(Date.now() / 1000) + 3600 }));
  await reject(idToken({ nonce: 'n-2' }));
  await reject(idToken({ nonce: undefined }));
  await reject(idToken({ email_verified: false }), 'GOOGLE_NO_EMAIL');
  await reject(idToken({ email: undefined }), 'GOOGLE_NO_EMAIL');
  await reject('not.a.token');
  const tampered = idToken().split('.'); tampered[1] = b64({ ...JSON.parse(Buffer.from(tampered[1], 'base64url')), sub: '999' });
  await reject(tampered.join('.'));
});

test('verify: exchanges the code server-side with the PKCE verifier and validates the answer', async () => {
  await enableGoogle();
  const { pending } = await google.start();
  const stub = googleStub((form) => ({ status: 200, text: async () => JSON.stringify({ access_token: 'x', id_token: idToken({ nonce: pending.nonce }) }), headers: new Map() }));
  google.setFetch(stub);
  const g = await google.verify(pending, { state: pending.state, code: 'auth-code-1' });
  assert.equal(g.email, 'staff@a.test');
  const tokenCall = stub.calls.find((c) => c.url === google.GOOGLE.token);
  const sent = new URLSearchParams(tokenCall.init.body);
  assert.equal(tokenCall.init.method, 'POST');
  assert.equal(sent.get('code'), 'auth-code-1');
  assert.equal(sent.get('code_verifier'), pending.verifier);
  assert.equal(sent.get('client_secret'), 'GOCSPX-unit-test-secret');
  assert.equal(sent.get('redirect_uri'), google.redirectUri());
  // A token issued for another sign-in (nonce) is refused; so is an error from the token endpoint.
  google.setFetch(googleStub(() => ({ status: 200, text: async () => JSON.stringify({ id_token: idToken({ nonce: 'someone-else' }) }), headers: new Map() })));
  await assert.rejects(google.verify(pending, { state: pending.state, code: 'c' }), { code: 'GOOGLE_TOKEN' });
  google.setFetch(googleStub(() => ({ status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }), headers: new Map() })));
  await assert.rejects(google.verify(pending, { state: pending.state, code: 'c' }), { code: 'GOOGLE_FAILED' });
  google.setFetch(async () => { throw new Error('network down'); });
  await assert.rejects(google.verify(pending, { state: pending.state, code: 'c' }), { code: 'GOOGLE_FAILED' });
  google.setFetch(null);
});

// ---------------------------------------------------------------- accounts
test('resolve: existing accounts only; links on first use; refuses other/unknown/admin/disabled', async () => {
  const ctx = { ip: '127.0.0.1' };
  await assert.rejects(google.resolve({ sub: 'g-unknown', email: 'nobody@x.test', name: 'X' }, ctx), { code: 'GOOGLE_NO_ACCOUNT' });
  assert.equal(await knex('users').where({ email: 'nobody@x.test' }).first(), undefined, 'no silent sign-up');
  const u = await google.resolve({ sub: 'g-staff', email: 'staff@a.test', name: 'Staff' }, ctx);
  assert.equal(u.id, staffId);
  assert.equal(u.google_sub, 'g-staff');
  assert.ok(u.email_verified_at, 'Google verified the address');
  assert.ok(await knex('audit_logs').where({ user_id: staffId, action: 'auth.google_linked' }).first());
  // Found by the linked subject even when the Google e-mail changed.
  assert.equal((await google.resolve({ sub: 'g-staff', email: 'renamed@gmail.test', name: 'S' }, ctx)).id, staffId);
  // The e-mail matches but a different Google account is linked.
  await assert.rejects(google.resolve({ sub: 'g-intruder', email: 'staff@a.test', name: 'S' }, ctx), { code: 'GOOGLE_OTHER' });
  await assert.rejects(google.resolve({ sub: 'g-admin', email: 'admin@platform.test', name: 'A' }, ctx), { code: 'GOOGLE_NOT_ALLOWED' });
  await knex('users').where({ id: clinicB.userId }).update({ status: 'disabled' });
  await assert.rejects(google.resolve({ sub: 'g-b', email: 'owner@b.test', name: 'B' }, ctx), { code: 'ACCOUNT_DISABLED' });
  await knex('users').where({ id: clinicB.userId }).update({ status: 'active' });
});

test('link / unlink from Settings → Security', async () => {
  const ctx = { userId: owner.userId, ip: '127.0.0.1' };
  await assert.rejects(google.link(ctx, owner.userId, { sub: 'g-staff', email: 'x@gmail.test' }), { code: 'GOOGLE_TAKEN' });
  await google.link(ctx, owner.userId, { sub: 'g-owner', email: 'owner.personal@gmail.test' });
  let u = await knex('users').where({ id: owner.userId }).first();
  assert.equal(u.google_email, 'owner.personal@gmail.test');
  assert.equal((await google.resolve({ sub: 'g-owner', email: 'owner.personal@gmail.test' }, {})).id, owner.userId);
  assert.equal(await google.unlink(ctx, owner.userId), true);
  u = await knex('users').where({ id: owner.userId }).first();
  assert.equal(u.google_sub, null);
  assert.ok(await knex('audit_logs').where({ user_id: owner.userId, action: 'auth.google_unlinked' }).first());
  await assert.rejects(google.link({ userId: adminId }, adminId, { sub: 'g-x', email: 'a@x.test' }), { code: 'GOOGLE_NOT_ALLOWED' });
});

// ---------------------------------------------------------------- custom domains
test('host names: normalised and strictly validated', () => {
  assert.equal(domains.normalizeHost(' https://Book.MyClinic.com:443/path?q=1 '), 'book.myclinic.com');
  assert.equal(domains.normalizeHost('book.myclinic.com.'), 'book.myclinic.com');
  assert.match(domains.normalizeHost('عيادة.com'), /^xn--[a-z0-9]+\.com$/);
  for (const ok of ['book.myclinic.com', 'myclinic.jo', 'a-b.c-d.example.org', domains.normalizeHost('عيادة.com')]) assert.equal(domains.validateHost(ok), null, ok);
  for (const bad of ['', 'localhost', 'myclinic', '127.0.0.1', '10.0.0.1', '::1', '*.myclinic.com', 'my_clinic.com', '-bad.com', 'bad-.com',
    'a..com', 'clinic.local', 'x.internal', 'x.localhost', 'myclinic.123', `${'a'.repeat(64)}.com`, `${'a.'.repeat(130)}com`]) {
    assert.ok(domains.validateHost(domains.normalizeHost(bad)), `should refuse ${bad}`);
  }
  const main = domains.platformHost();
  if (main !== 'localhost') assert.ok(domains.validateHost(`x.${main}`));
});

function resolver({ txt = {}, cname = {}, a = {} } = {}) {
  const nx = () => Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
  return {
    resolveTxt: (n) => (txt[n] ? Promise.resolve(txt[n].map((v) => [v])) : nx()),
    resolveCname: (n) => (cname[n] ? Promise.resolve(cname[n]) : nx()),
    resolve4: (n) => (a[n] ? Promise.resolve(a[n]) : nx()),
  };
}

test('domain verification: TXT ownership + CNAME pointing, one clinic per verified host, suspend/resume', async () => {
  const ctxA = { businessId: clinicA.businessId, userId: clinicA.userId };
  const ctxB = { businessId: clinicB.businessId, userId: clinicB.userId };
  const host = 'book.clinic-a.com';
  await assert.rejects(domains.save(ctxA, '192.168.1.10'), { code: 'VALIDATION_FAILED' });
  const d = await domains.save(ctxA, `https://${host}/`);
  assert.equal(d.status, 'pending');
  assert.match(d.token, /^[0-9a-f]{32}$/);
  const rec = domains.records(d);
  assert.equal(rec.txt.name, `_docbook.${host}`);
  assert.equal(rec.txt.value, `docbook-verify=${d.token}`);
  assert.equal(rec.cname.value, domains.platformHost());

  // Nothing in DNS yet.
  let r = await domains.check(ctxA, clinicA.businessId, { resolver: resolver() });
  assert.deepEqual([r.owned, r.pointed, r.live], [false, false, false]);
  assert.equal(await domains.clinicForHost(host), null);
  // The TXT alone proves ownership but the domain does not point here yet.
  const txt = { [`_docbook.${host}`]: ['v=spf1 -all', `docbook-verify=${d.token}`] };
  r = await domains.check(ctxA, clinicA.businessId, { resolver: resolver({ txt }) });
  assert.deepEqual([r.owned, r.pointed, r.live], [true, false, false]);
  // A wrong token does not count.
  r = await domains.check(ctxA, clinicA.businessId, { resolver: resolver({ txt: { [`_docbook.${host}`]: ['docbook-verify=0000'] }, cname: { [host]: [`${domains.platformHost()}.`] } }) });
  assert.equal(r.live, false);
  // A DNS lookup that never answers times out instead of hanging.
  const hang = { resolveTxt: () => new Promise(() => {}), resolveCname: () => new Promise(() => {}), resolve4: () => new Promise(() => {}) };
  const t0 = Date.now();
  r = await domains.check(ctxA, clinicA.businessId, { resolver: hang, timeoutMs: 200 });
  assert.equal(r.live, false);
  assert.equal(r.errors.txt, 'ETIMEOUT');
  assert.ok(Date.now() - t0 < 2000);
  // TXT + CNAME → live.
  r = await domains.check(ctxA, clinicA.businessId, { resolver: resolver({ txt, cname: { [host]: [`${domains.platformHost()}.`] } }) });
  assert.equal(r.live, true);
  assert.equal(r.justVerified, true);
  assert.deepEqual(await domains.clinicForHost(host), { businessId: clinicA.businessId, slug: 'clinic-a' });
  assert.deepEqual(await domains.clinicForHost(`${host.toUpperCase()}.`), { businessId: clinicA.businessId, slug: 'clinic-a' });
  assert.ok(await knex('audit_logs').where({ business_id: clinicA.businessId, action: 'domain.verified' }).first());

  // Another clinic cannot take a verified host.
  await assert.rejects(domains.save(ctxB, host), (e) => Boolean(e.details && /another clinic/.test(e.details.host)));
  // It can claim a different pending host (squatting a pending claim blocks nobody).
  const dB = await domains.save(ctxB, 'book.clinic-b.com');
  assert.equal(dB.status, 'pending');

  // The platform admin suspends: the host stops serving at once and the clinic cannot change it.
  const row = await domains.forClinic(clinicA.businessId);
  await domains.suspend({ userId: adminId }, row.id);
  assert.equal(await domains.clinicForHost(host), null);
  await assert.rejects(domains.check(ctxA, clinicA.businessId, { resolver: resolver({ txt }) }), { code: 'DOMAIN_SUSPENDED' });
  await assert.rejects(domains.remove(ctxA), { code: 'DOMAIN_SUSPENDED' });
  // Resume re-checks DNS.
  r = await domains.resume({ userId: adminId }, row.id, { resolver: resolver({ txt, cname: { [host]: [domains.platformHost()] } }) });
  assert.equal(r.live, true);

  // Admin approval needs proven ownership.
  const rowB = await domains.forClinic(clinicB.businessId);
  await assert.rejects(domains.approve({ userId: adminId }, rowB.id), { code: 'DOMAIN_NOT_OWNED' });
  await domains.check(ctxB, clinicB.businessId, { resolver: resolver({ txt: { '_docbook.book.clinic-b.com': [`docbook-verify=${rowB.token}`] }, a: { 'book.clinic-b.com': ['203.0.113.9'] } }) });
  await domains.approve({ userId: adminId }, rowB.id);
  assert.equal((await domains.clinicForHost('book.clinic-b.com')).slug, 'clinic-b');

  // Changing the domain starts over with a fresh token; removing stops serving.
  const moved = await domains.save(ctxB, 'www.clinic-b.com');
  assert.equal(moved.status, 'pending');
  assert.notEqual(moved.token, rowB.token);
  assert.equal(await domains.clinicForHost('book.clinic-b.com'), null);
  await domains.remove(ctxB);
  assert.equal(await domains.forClinic(clinicB.businessId), null);
});

test('A records must match the DocBook server (SERVER_IP) to count as pointing', async () => {
  process.env.SERVER_IP = '203.0.113.5';
  const row = { host: 'myclinic.com', token: 'tok' };
  const txt = { '_docbook.myclinic.com': ['docbook-verify=tok'] };
  assert.equal((await domains.inspect(row, resolver({ txt, a: { 'myclinic.com': ['203.0.113.5'] } }))).pointed, true);
  assert.equal((await domains.inspect(row, resolver({ txt, a: { 'myclinic.com': ['203.0.113.5', '198.51.100.7'] } }))).pointed, false);
  delete process.env.SERVER_IP;
});

// ---------------------------------------------------------------- HTTP: callback and host routing
async function serve() {
  const http = require('http'); // eslint-disable-line global-require
  const config = require('../src/config'); // eslint-disable-line global-require
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  const app = createApp();
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const { port } = server.address();
  config.appUrl = `http://127.0.0.1:${port}`; // this server is the main DocBook address
  const jar = {};
  const call = (path, { host, cookies = jar } = {}) => new Promise((resolve, reject) => {
    const headers = { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '), host: host || `127.0.0.1:${port}` };
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      for (const h of res.headers['set-cookie'] || []) { const [kv] = h.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
      let text = ''; res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || null, text }));
    }).on('error', reject);
  });
  const post = (path, form, cookies = jar) => new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const headers = { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '), host: `127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) };
    const r = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      for (const h of res.headers['set-cookie'] || []) { const [kv] = h.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
      let text = ''; res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || null, text }));
    });
    r.on('error', reject); r.end(body);
  });
  return { server, call, post, jar };
}

test('HTTP: Google sign-in on the clinic staff login enforces membership of THIS clinic', async () => {
  await enableGoogle();
  const { server, call } = await serve();
  try {
    let r = await call('/clinic-a/login?as=receptionist');
    assert.ok(r.text.includes('/auth/google?portal=clinic-a&amp;as=receptionist'), 'button on the clinic staff login');
    r = await call('/login');
    assert.ok(r.text.includes('href="/auth/google"'), 'button on the main login');

    // Staff member of clinic A, signing in from clinic A's page.
    r = await call('/auth/google?portal=clinic-a&as=receptionist');
    assert.equal(r.status, 302);
    let q = new URL(r.location).searchParams;
    google.setFetch(googleStub(() => ({ status: 200, text: async () => JSON.stringify({ id_token: idToken({ sub: 'g-staff', email: 'staff@a.test', nonce: q.get('nonce') }) }), headers: new Map() })));
    r = await call(`/auth/google/callback?state=${q.get('state')}&code=abc`);
    assert.equal(r.status, 302, (r.text.match(/alert-title">([^<]+)/) || [])[1]);
    assert.equal(r.location, '/app/front-desk');
    // The state is single-use.
    r = await call(`/auth/google/callback?state=${q.get('state')}&code=abc`);
    assert.equal(r.status, 400);

    // The same person from clinic B's page is refused (fresh browser).
    const other = {};
    r = await call('/auth/google?portal=clinic-b', { cookies: other });
    q = new URL(r.location).searchParams;
    google.setFetch(googleStub(() => ({ status: 200, text: async () => JSON.stringify({ id_token: idToken({ sub: 'g-staff', email: 'staff@a.test', nonce: q.get('nonce') }) }), headers: new Map() })));
    r = await call(`/auth/google/callback?state=${q.get('state')}&code=abc`, { cookies: other });
    assert.equal(r.location, '/clinic-b/login');
    r = await call('/app', { cookies: other });
    assert.equal(r.location, '/login', 'not signed in');

    // Temporary password accounts still choose their own first.
    await knex('users').where({ id: staffId }).update({ must_change_password: true });
    const third = {};
    r = await call('/auth/google', { cookies: third });
    q = new URL(r.location).searchParams;
    google.setFetch(googleStub(() => ({ status: 200, text: async () => JSON.stringify({ id_token: idToken({ sub: 'g-staff', email: 'staff@a.test', nonce: q.get('nonce') }) }), headers: new Map() })));
    r = await call(`/auth/google/callback?state=${q.get('state')}&code=abc`, { cookies: third });
    assert.equal(r.location, '/password/new');
    await knex('users').where({ id: staffId }).update({ must_change_password: false });

    // Unknown Google e-mail: the login page explains, nobody is created.
    const fourth = {};
    r = await call('/auth/google', { cookies: fourth });
    q = new URL(r.location).searchParams;
    google.setFetch(googleStub(() => ({ status: 200, text: async () => JSON.stringify({ id_token: idToken({ sub: 'g-new', email: 'new@gmail.test', nonce: q.get('nonce') }) }), headers: new Map() })));
    r = await call(`/auth/google/callback?state=${q.get('state')}&code=abc`, { cookies: fourth });
    assert.equal(r.status, 404);
    assert.equal(await knex('users').where({ email: 'new@gmail.test' }).first(), undefined);
  } finally {
    google.setFetch(null);
    server.close();
  }
});

test('HTTP: a verified custom domain serves only the clinic page and booking', async () => {
  const host = 'book.clinic-a.com';
  assert.ok(await domains.clinicForHost(host));
  const { server, call } = await serve();
  try {
    let r = await call('/', { host, cookies: {} });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('Clinic A'));
    r = await call('/book', { host, cookies: {} });
    assert.equal(r.status, 200);
    r = await call('/clinic-a/book', { host, cookies: {} });
    assert.equal(r.status, 200);
    r = await call('/clinic-a', { host, cookies: {} });
    assert.equal(r.location, '/');
    const main = require('../src/config').appUrl.replace(/\/+$/, ''); // eslint-disable-line global-require
    r = await call('/login', { host, cookies: {} });
    assert.equal(r.location, `${main}/clinic-a/login`);
    r = await call('/clinic-a/login?as=doctor', { host, cookies: {} });
    assert.equal(r.location, `${main}/clinic-a/login?as=doctor`);
    r = await call('/app/settings', { host, cookies: {} });
    assert.equal(r.location, `${main}/app/settings`);
    r = await call('/admin', { host, cookies: {} });
    assert.equal(r.location, `${main}/admin`);
    r = await call('/auth/google', { host, cookies: {} });
    assert.equal(r.location, `${main}/auth/google`);
    // Hosts that are not verified are ignored (the normal site answers).
    r = await call('/', { host: 'book.clinic-b.com', cookies: {} });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('/clinic-b/book'), 'a removed domain no longer serves the clinic');
    r = await call('/', { host: 'evil.example.com', cookies: {} });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('Clinic A'));
  } finally { server.close(); }
});

test('HTTP: linking Google from Settings → Security needs the password, then Google', async () => {
  await enableGoogle();
  const { server, call, post } = await serve();
  const csrf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  try {
    let r = await call('/login');
    r = await post('/login', { _csrf: csrf(r.text), email: 'owner@b.test', password: 'Passw0rd!x' });
    assert.equal(r.status, 302);
    r = await call('/app/settings/security');
    assert.ok(r.text.includes('/app/settings/security/google/link'), `${r.status} ${r.location} ${(r.text.match(/<title>[^<]*/) || [])[0]}`);
    // Without the password step the link start goes nowhere.
    r = await call('/auth/google/link');
    assert.equal(r.location, '/app/settings/security#google');
    r = await call('/app/settings/security');
    r = await post('/app/settings/security/google/link', { _csrf: csrf(r.text), google_password: 'wrong' });
    assert.equal(r.status, 422);
    r = await post('/app/settings/security/google/link', { _csrf: csrf(r.text), google_password: 'Passw0rd!x' });
    assert.equal(r.location, '/app/settings/security#google');
    r = await call('/app/settings/security');
    assert.ok(r.text.includes('href="/auth/google/link"'));
    r = await call('/auth/google/link');
    const q = new URL(r.location).searchParams;
    assert.equal(new URL(r.location).hostname, 'accounts.google.com');
    google.setFetch(googleStub(() => ({ status: 200, text: async () => JSON.stringify({ id_token: idToken({ sub: 'g-owner-b', email: 'b.personal@gmail.test', nonce: q.get('nonce') }) }), headers: new Map() })));
    r = await call(`/auth/google/callback?state=${q.get('state')}&code=abc`);
    assert.equal(r.location, '/app/settings/security');
    const u = await knex('users').where({ id: clinicB.userId }).first();
    assert.equal(u.google_sub, 'g-owner-b');
    assert.equal(u.google_email, 'b.personal@gmail.test');
    r = await call('/app/settings/security');
    r = await post('/app/settings/security/google/unlink', { _csrf: csrf(r.text) });
    assert.equal((await knex('users').where({ id: clinicB.userId }).first()).google_sub, null);
  } finally {
    google.setFetch(null);
    server.close();
  }
});
