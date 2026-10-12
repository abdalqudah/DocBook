// `node app.js check-secrets` (src/db/secrets-check.js): after moving servers, the stored credentials are readable only
// with the old APP_KEY. It finds encrypted values in platform_settings and *_enc columns and reports, without printing
// them, whether they decrypt: exit 0 with the right key, 1 with another one.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const knex = require('../src/db/knex');
const secrets = require('../src/core/secrets');

const KEY = `secrets-check-${Date.now()}`;
const run = (env) => spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'db', 'secrets-check.js')], { env: { ...process.env, NODE_ENV: 'test', ...env }, encoding: 'utf8' });

test.before(async () => { await knex.migrate.latest(); });
test.after(async () => { await knex('platform_settings').where({ key: KEY }).del(); await knex.destroy(); });

test('stored credentials: readable with the key they were saved with, reported (not printed) with another key', async () => {
  // Saved with this test run's own key (APP_KEY unset → the session secret), like the values other tests leave behind.
  const child = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(__dirname, '..', 'src', 'core', 'secrets'))}).encrypt('smtp-password-123'))`], { env: { ...process.env, NODE_ENV: 'test', APP_KEY: '' }, encoding: 'utf8' });
  const token = child.stdout.trim();
  assert.match(token, /^v1:/);
  assert.ok(secrets.decrypt(token) === 'smtp-password-123');
  await knex('platform_settings').insert({ key: KEY, value: JSON.stringify({ mail: { pass_enc: token } }) });
  const good = run({ APP_KEY: '' });
  assert.doesNotMatch(good.stdout, new RegExp(`platform_settings\\[${KEY}\\]`), good.stdout + good.stderr);
  assert.match(good.stdout, /encrypted value\(s\)/);
  if (/OK: every stored credential/.test(good.stdout)) assert.equal(good.status, 0);
  const bad = run({ APP_KEY: 'another-key-'.repeat(4) });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, new RegExp(`NOT readable \\(.*platform_settings\\[${KEY}\\]`));
  assert.match(bad.stdout, /FAILED: APP_KEY does not match/);
  assert.doesNotMatch(bad.stdout + good.stdout, /smtp-password-123/, 'values are never printed');
});
