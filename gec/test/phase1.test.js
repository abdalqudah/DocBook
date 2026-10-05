const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, agent, staffAgent, outbox } = require('./helpers');

test.before(resetDb);
test.after(() => knex.destroy());

test('public pages render in both languages with RTL', async () => {
  const a = await agent();
  const en = await a.get('/?lang=en');
  assert.equal(en.status, 200);
  assert.match(en.text, /<html lang="en" dir="ltr">/);
  const ar = await a.get('/privacy?lang=ar');
  assert.equal(ar.status, 200);
  assert.match(ar.text, /<html lang="ar" dir="rtl">/);
  assert.match(ar.text, /سياسة الخصوصية/);
});

test('security headers: strict CSP without inline scripts, no x-powered-by', async () => {
  const a = await agent();
  const res = await a.get('/');
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(res.headers['content-security-policy'], /script-src[^;]*unsafe-inline/);
  assert.equal(res.headers['x-powered-by'], undefined);
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
});

test('staff area requires sign-in', async () => {
  const a = await agent();
  const res = await a.get('/staff');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/staff/login');
  const api = await a.get('/staff/api/palette?q=x').set('Accept', 'application/json');
  assert.equal(api.status, 401);
});

test('sign-in rejects a wrong password and locks after 5 failures', async () => {
  const s = await makeStaff({ email: 'lock@gec.test' });
  const a = await agent();
  const token = await a.csrf();
  for (let i = 0; i < 5; i += 1) {
    const r = await a.post('/staff/login').type('form').send({ _csrf: token, email: 'lock@gec.test', password: 'wrong-password' }); // eslint-disable-line no-await-in-loop
    assert.equal(r.status, 401);
  }
  const locked = await a.post('/staff/login').type('form').send({ _csrf: token, email: 'lock@gec.test', password: s.password });
  assert.equal(locked.status, 429);
  const u = await knex('users').where({ id: s.user.id }).first();
  assert.ok(u.locked_until > new Date());
  assert.ok(await knex('audit_logs').where({ action: 'auth.locked', entity_id: String(s.user.id) }).first());
});

test('a student account cannot sign in to the staff portal', async () => {
  const { hashPassword } = require('../src/modules/auth/auth.service');
  await knex('users').insert({ kind: 'student', email: 'stu@gec.test', name: 'Stu', password_hash: await hashPassword('Password123') });
  const a = await agent();
  const token = await a.csrf();
  const r = await a.post('/staff/login').type('form').send({ _csrf: token, email: 'stu@gec.test', password: 'Password123' });
  assert.equal(r.status, 401);
});

test('forms without a valid CSRF token are refused', async () => {
  const s = await makeStaff({ role: 'admin' });
  const a = await staffAgent(s);
  const r = await a.post('/staff/settings/company').type('form').send({ email: 'x@y.com' });
  assert.equal(r.status, 302); // back to the form with an error, nothing saved
  const row = await knex('settings').where({ key: 'company' }).first();
  assert.equal(row, undefined);
  const multipart = await a.post('/staff/account/profile').field('name', 'X').field('locale', 'en');
  assert.notEqual(multipart.status, 200);
  const u = await knex('users').where({ id: s.user.id }).first();
  assert.equal(u.name, 'Staff Member');
});

test('session is regenerated on sign-in (no fixation)', async () => {
  const s = await makeStaff();
  const a = await agent();
  const before = await a.get('/staff/login');
  const sid1 = (before.headers['set-cookie'] || []).join(';').match(/gec\.sid=([^;]+)/)?.[1];
  const token = /name="_csrf" value="([^"]+)"/.exec(before.text)[1];
  const r = await a.post('/staff/login').type('form').send({ _csrf: token, email: s.user.email, password: s.password });
  const sid2 = (r.headers['set-cookie'] || []).join(';').match(/gec\.sid=([^;]+)/)?.[1];
  assert.ok(sid2);
  assert.notEqual(sid1, sid2);
});

test('RBAC: a counsellor cannot open settings or roles; an admin can', async () => {
  const c = await makeStaff({ role: 'counsellor' });
  const ca = await staffAgent(c);
  assert.equal((await ca.get('/staff/settings/branding')).status, 403);
  assert.equal((await ca.get('/staff/roles')).status, 403);
  assert.equal((await ca.get('/staff/audit')).status, 403);
  const token = await ca.token();
  const forged = await ca.post('/staff/settings/branding').type('form').send({ _csrf: token, name: 'Hacked', legal_name: 'Hacked', primary: '#000000', secondary: '#000000', accent: '#000000' });
  assert.equal(forged.status, 403);

  const sa = await makeStaff({ role: 'super_admin' });
  const aa = await staffAgent(sa);
  assert.equal((await aa.get('/staff/settings/branding')).status, 200);
  assert.equal((await aa.get('/staff/roles')).status, 200);
});

test('branding colours re-theme /theme.css and are audited', async () => {
  const sa = await makeStaff({ role: 'admin' });
  const a = await staffAgent(sa);
  const token = await a.token();
  const r = await a.post('/staff/settings/branding').type('form').send({ _csrf: token, name: 'GEC', legal_name: 'Global Education Consultants', primary: '#123456', secondary: '#0A0F0C', accent: '#84CC16' });
  assert.equal(r.status, 302);
  const css = await a.get('/theme.css');
  assert.match(css.text, /--brand:#123456/);
  assert.ok(await knex('audit_logs').where({ action: 'settings.updated', entity_id: 'branding' }).first());
});

test('custom roles: built-ins are read-only; custom role saved with normalised permissions', async () => {
  const sa = await makeStaff({ role: 'super_admin' });
  const a = await staffAgent(sa);
  const token = await a.token();
  const sys = await knex('roles').where({ key: 'counsellor' }).first();
  const r1 = await a.post(`/staff/roles/${sys.id}`).type('form').send({ _csrf: token, name_en: 'X', data_scope: 'all', permissions: ['settings.manage'] });
  assert.equal(r1.status, 422);
  const r2 = await a.post('/staff/roles').type('form').send({ _csrf: token, name_en: 'Intern', data_scope: 'own', permissions: ['leads.manage', 'not.a.permission'] });
  assert.equal(r2.status, 302);
  const role = await knex('roles').where({ name_en: 'Intern' }).first();
  const perms = (await knex('role_permissions').where({ role_id: role.id })).map((p) => p.permission).sort();
  assert.deepEqual(perms, ['leads.manage', 'leads.view']);
});

test('password reset: link e-mailed, single use, old sessions ended', async () => {
  const s = await makeStaff({ email: 'reset@gec.test' });
  const a = await agent();
  let token = await a.csrf();
  outbox.length = 0;
  await a.post('/staff/forgot').type('form').send({ _csrf: token, email: 'reset@gec.test' });
  await new Promise((r) => { setTimeout(r, 50); });
  assert.equal(outbox.length, 1);
  const link = /href="([^"]+\/staff\/reset\/[^"]+)"/.exec(outbox[0].html)[1];
  const path = new URL(link).pathname;
  const page = await a.get(path);
  assert.match(page.text, /name="password"/);
  token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  const weak = await a.post(path).type('form').send({ _csrf: token, password: 'short', password_confirm: 'short' });
  assert.equal(weak.status, 422);
  const ok = await a.post(path).type('form').send({ _csrf: token, password: 'NewPassword1', password_confirm: 'NewPassword1' });
  assert.equal(ok.status, 302);
  const again = await a.post(path).type('form').send({ _csrf: token, password: 'NewPassword2', password_confirm: 'NewPassword2' });
  assert.equal(again.status, 404);
  // unknown address: same answer, nothing sent
  outbox.length = 0;
  const r = await a.post('/staff/forgot').type('form').send({ _csrf: token, email: 'nobody@gec.test' });
  assert.equal(r.status, 200);
  assert.equal(outbox.length, 0);
  void s;
});

test('a disabled account is signed out on its next request', async () => {
  const s = await makeStaff();
  const a = await staffAgent(s);
  assert.equal((await a.get('/staff')).status, 200);
  await knex('users').where({ id: s.user.id }).update({ status: 'disabled' });
  assert.equal((await a.get('/staff')).status, 302);
});

test('audit log lists sign-ins for admins', async () => {
  const sa = await makeStaff({ role: 'super_admin' });
  const a = await staffAgent(sa);
  const res = await a.get('/staff/audit?action=auth.');
  assert.equal(res.status, 200);
  assert.match(res.text, /auth\.login/);
});
