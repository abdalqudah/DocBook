const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gec-upd-'));
process.env.UPDATER_DIR = dir;
const { knex, resetDb, makeStaff, staffAgent } = require('./helpers');
const config = require('../src/config');

config.updaterDir = dir;
const form = async (a, url, body = {}) => { const t = await a.token(); return a.post(url).type('form').send({ _csrf: t, ...body }); };
const writeState = (s) => fs.writeFileSync(path.join(dir, 'updater.json'), JSON.stringify(s));
let superAdmin;
test.before(async () => { await resetDb(); superAdmin = await makeStaff({ role: 'super_admin' }); });
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); return knex.destroy(); });

test('system update: only the super admin; "not connected" until the server updater reports in', async () => {
  const a = await staffAgent(superAdmin);
  const page = await a.get('/staff/system/update?lang=en');
  assert.equal(page.status, 200);
  assert.match(page.text, /Updater not connected/);
  assert.match(page.text, /install-updater\.sh/);
  await form(a, '/staff/system/update/update');
  assert.equal(fs.existsSync(path.join(dir, 'request.json')), false, 'no request without an updater');
  for (const role of ['admin', 'counsellor']) {
    const o = await staffAgent(await makeStaff({ role }));
    assert.equal((await o.get('/staff/system/update')).status, 403, role);
    assert.equal((await form(o, '/staff/system/update/update')).status, 403);
  }
});

test('connected updater: shows pending updates, writes one request, refuses duplicates and stale heartbeats', async () => {
  const a = await staffAgent(superAdmin);
  writeState({ heartbeat_at: new Date().toISOString(), mode: 'docker', branch: 'main', current_commit: 'a'.repeat(40), checked_at: new Date().toISOString(), state: 'idle',
    pending: [{ commit: 'b'.repeat(40), date: '2026-10-06T10:00:00Z', subject: 'Add partner portal <script>' }] });
  const page = await a.get('/staff/system/update?lang=en');
  assert.match(page.text, /Updater connected/);
  assert.match(page.text, /1 update\(s\) available/);
  assert.match(page.text, /Add partner portal &lt;script&gt;/);
  assert.match(page.text, /Update the system now/);
  await form(a, '/staff/system/update/update');
  const req = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'));
  assert.equal(req.action, 'update');
  assert.equal(req.target, 'b'.repeat(40));
  assert.ok(await knex('audit_logs').where({ action: 'system.update_requested' }).first());
  await form(a, '/staff/system/update/check');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8')).action, 'update', 'queued request not replaced');
  const st = await a.get('/staff/system/update/status.json');
  assert.equal(st.body.queued, true);
  // Updater picked it up and is running.
  fs.rmSync(path.join(dir, 'request.json'));
  writeState({ heartbeat_at: new Date().toISOString(), state: 'running', pending: [{ commit: 'b'.repeat(40), subject: 'x' }], run: { log: ['10:00:01 1/5 Checking…'] } });
  assert.equal((await a.get('/staff/system/update/status.json')).body.state, 'running');
  await form(a, '/staff/system/update/update');
  assert.equal(fs.existsSync(path.join(dir, 'request.json')), false, 'no second update while running');
  // Heartbeat older than three minutes → not connected.
  writeState({ heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString(), state: 'done', pending: [{ commit: 'c'.repeat(40), subject: 'y' }] });
  await form(a, '/staff/system/update/update');
  assert.equal(fs.existsSync(path.join(dir, 'request.json')), false);
  // Up to date → nothing to install.
  writeState({ heartbeat_at: new Date().toISOString(), state: 'done', pending: [], run: { message: 'Updated', log: [] } });
  await form(a, '/staff/system/update/update');
  assert.equal(fs.existsSync(path.join(dir, 'request.json')), false);
  assert.match((await a.get('/staff/system/update?lang=ar')).text, /النظام محدّث/);
});
