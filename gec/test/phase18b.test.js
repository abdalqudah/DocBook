const test = require('node:test');
const assert = require('node:assert');
const { knex, resetDb, makeStaff, staffAgent } = require('./helpers');
const config = require('../src/config');
const github = require('../src/modules/system/github');

const form = async (a, url, body = {}) => { const t = await a.token(); return a.post(url).type('form').send({ _csrf: t, ...body }); };
const commit = (sha, msg) => ({ sha, commit: { message: msg, committer: { date: '2026-10-06T10:00:00Z' } } });
const A = 'a'.repeat(40); const B = 'b'.repeat(40); const C = 'c'.repeat(40);
let refs; let calls; const realFetch = global.fetch;
function fakeGitHub() {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.github.com/repos/gec/platform/')) return realFetch(url, opts);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.authorization });
    const json = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (u.includes('/compare/production...main')) {
      const ahead = refs.main === refs.production ? [] : [commit(B, 'Faster search'), commit(C, 'Partner portal\n\ndetails')].filter((c) => c.sha !== refs.production);
      return json(200, { status: ahead.length ? 'ahead' : 'identical', commits: ahead, behind_by: 0 });
    }
    if (u.endsWith('/commits/production')) return json(200, commit(refs.production, refs.production === A ? 'Initial' : 'Partner portal'));
    if (u.endsWith('/commits/main')) return json(200, commit(refs.main, 'Partner portal'));
    if (u.endsWith('/git/refs/heads/production') && opts.method === 'PATCH') { refs.production = JSON.parse(opts.body).sha; return json(200, {}); }
    return json(404, { message: 'Not Found' });
  };
}
let superAdmin;
test.before(async () => {
  await resetDb(); superAdmin = await makeStaff({ role: 'super_admin' });
  Object.assign(config.updates, { mode: 'github', repo: 'gec/platform', token: 'github_pat_test', sourceBranch: 'main', deployBranch: 'production' });
  fakeGitHub();
});
test.after(() => { global.fetch = realFetch; Object.assign(config.updates, { mode: 'server', repo: null, token: null }); return knex.destroy(); });
test.beforeEach(() => { calls = []; github._reset(); });

test('GitHub mode: shows what is waiting on main, update fast-forwards production (no force), then shows live after restart', async () => {
  refs = { main: C, production: A };
  const a = await staffAgent(superAdmin);
  const page = await a.get('/staff/system/update?lang=en');
  assert.equal(page.status, 200);
  assert.match(page.text, /2 update\(s\) available/);
  assert.match(page.text, /Partner portal/);
  assert.match(page.text, /gec\/platform · main → production/);
  assert.ok(calls.every((c) => c.auth === 'Bearer github_pat_test'));
  await form(a, '/staff/system/update/update');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(patch.body, { sha: C, force: false });
  assert.equal(refs.production, C);
  const run = (await knex('settings').where({ key: 'system_update_run' }).first()).value;
  const r = typeof run === 'string' ? JSON.parse(run) : run;
  assert.equal(r.from, A);
  assert.equal(r.to, C);
  assert.ok(await knex('audit_logs').where({ action: 'system.update_requested' }).first());
  // This process started before the request → still "running" (Hostinger is rebuilding).
  assert.equal((await a.get('/staff/system/update/status.json')).body.state, 'running');
  await form(a, '/staff/system/update/update');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1, 'no second update while one is deploying');
  // Simulate the restart: a run requested before this process started is live.
  const settings = require('../src/modules/settings/settings.service');
  await settings.set(null, 'system_update_run', { ...r, requested_at: new Date(github.STARTED_AT.getTime() - 1000).toISOString() });
  await github.markLive();
  const done = await a.get('/staff/system/update?lang=en');
  assert.match(done.text, /The new version is running/);
  assert.match(done.text, /The system is up to date/);
  assert.match(done.text, /Roll back to the previous version/);
});

test('GitHub mode: rollback moves production back; bad token says so; non-super-admins are refused', async () => {
  const a = await staffAgent(superAdmin);
  await form(a, '/staff/system/update/rollback');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(patch.body, { sha: A, force: true });
  assert.equal(refs.production, A);
  assert.ok(await knex('audit_logs').where({ action: 'system.update_rolled_back' }).first());
  config.updates.token = 'bad';
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) });
  github._reset();
  const page = await a.get('/staff/system/update?lang=en');
  assert.match(page.text, /GitHub refused the token/);
  fakeGitHub(); config.updates.token = 'github_pat_test';
  const o = await staffAgent(await makeStaff({ role: 'admin' }));
  assert.equal((await form(o, '/staff/system/update/rollback')).status, 403);
});
