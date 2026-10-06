// System updates from the workspace. The app never runs commands on the server: the "Update" button writes a request
// file into a folder shared with the server-side updater (deploy/updater.py, run by systemd as root). The updater
// backs up, pulls the new version from Git, rebuilds, checks health and rolls back on failure, and writes its status
// back into the same folder for this page. Without a running updater the page says "not connected".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { version } = require('./version');

const HEARTBEAT_MS = 3 * 60_000; // the updater runs every minute
const STATE = 'updater.json';
const REQUEST = 'request.json';

const file = (name) => path.join(config.updaterDir, name);
function readJson(name) { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return null; } }
function writeJson(name, data) {
  fs.mkdirSync(config.updaterDir, { recursive: true });
  const tmp = file(`.${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o640 });
  fs.renameSync(tmp, file(name)); // atomic: the updater never reads half a file
}

const clean = (s, n = 300) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, n);

/** Everything the page shows. */
function status() {
  const s = readJson(STATE);
  const req = readJson(REQUEST);
  const heartbeat = s && s.heartbeat_at ? new Date(s.heartbeat_at) : null;
  const connected = Boolean(heartbeat && Date.now() - heartbeat.getTime() < HEARTBEAT_MS);
  const pending = (s && Array.isArray(s.pending) ? s.pending : []).slice(0, 50).map((c) => ({ commit: clean(c.commit, 40), date: clean(c.date, 40), subject: clean(c.subject, 200) }));
  const run = s && s.run ? { ...s.run, log: (Array.isArray(s.run.log) ? s.run.log : []).slice(-80).map((l) => clean(l, 400)) } : null;
  return {
    app: version(), connected, heartbeat, mode: s ? clean(s.mode, 20) : null, branch: s ? clean(s.branch, 100) : null,
    serverCommit: s ? clean(s.current_commit, 40) : null, checkedAt: s && s.checked_at ? new Date(s.checked_at) : null, checkError: s ? clean(s.check_error, 300) || null : null,
    pending, state: s ? clean(s.state || 'idle', 20) : 'idle', run, queued: req ? { action: clean(req.action, 10), at: req.requested_at } : null,
  };
}

/** Asks the updater to check for updates or to install them. */
function request(ctx, action, by) {
  if (!['check', 'update'].includes(action)) throw E.validation({ action: 'Unknown action.' });
  const s = status();
  if (!s.connected) throw E.notConfigured('The server updater');
  if (s.state === 'running') throw E.conflict('UPDATE_RUNNING', 'An update is already running.');
  if (s.queued) throw E.conflict('UPDATE_QUEUED', 'A request is already waiting for the updater.');
  if (action === 'update' && !s.pending.length) throw E.conflict('UP_TO_DATE', 'There is nothing to install: the system is up to date.');
  const req = { id: crypto.randomUUID(), action, requested_at: new Date().toISOString(), requested_by: clean(by, 200), target: action === 'update' ? s.pending[0].commit : null };
  writeJson(REQUEST, req);
  return audit.record(ctx, action === 'update' ? 'system.update_requested' : 'system.update_check', { entityType: 'system', newValues: { target: req.target, from: s.serverCommit } }).then(() => req);
}

module.exports = { status, request, readJson, writeJson, HEARTBEAT_MS };
