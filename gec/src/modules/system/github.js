// "System update" for managed hosting (Hostinger Web Apps and similar) that rebuilds the site whenever a branch on
// GitHub changes. New versions land on the source branch (e.g. main); the site runs the deploy branch (e.g.
// production). "Update" fast-forwards the deploy branch to the source branch through the GitHub API, and the host
// rebuilds and restarts the app. "Roll back" moves the deploy branch back to the commit it had before.
// Needs GITHUB_REPO and a fine-grained GITHUB_TOKEN with Contents: read and write on that repository only.
const config = require('../../config');
const settings = require('../settings/settings.service');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');

const STARTED_AT = new Date(); // when this process started — a restart after an update means the new version is live
const API = 'https://api.github.com';
const cfg = () => config.updates;
const configured = () => Boolean(cfg().repo && cfg().token);

async function gh(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${API}/repos/${cfg().repo}${path}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { authorization: `Bearer ${cfg().token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'gec-platform', ...(body ? { 'content-type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.message || `GitHub ${r.status}`); e.status = r.status; throw e; }
  return data;
}
const clean = (s, n = 200) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, n);
const brief = (c) => ({ commit: c.sha, date: c.commit && c.commit.committer ? c.commit.committer.date : null, subject: clean((c.commit && c.commit.message || '').split('\n')[0]) });

let cache = null; // { at, value } — GitHub is asked at most once a minute
async function status({ fresh = false } = {}) {
  const base = { mode: 'github', connected: false, configured: configured(), repo: cfg().repo, branch: cfg().deployBranch, source: cfg().sourceBranch, pending: [], run: null, state: 'idle', queued: null };
  const run = await settings.get('system_update_run');
  if (run) {
    const live = run.action === 'update' || run.action === 'rollback' ? new Date(run.requested_at) < STARTED_AT : true;
    base.run = { ...run, log: run.log || [], message: run.message || null };
    base.state = live ? (run.result || 'done') : 'running';
  }
  if (!configured()) return base;
  if (!fresh && cache && Date.now() - cache.at < 60_000) return { ...base, ...cache.value };
  try {
    const cmp = await gh(`/compare/${encodeURIComponent(cfg().deployBranch)}...${encodeURIComponent(cfg().sourceBranch)}`);
    const [head, src] = await Promise.all([gh(`/commits/${encodeURIComponent(cfg().deployBranch)}`), gh(`/commits/${encodeURIComponent(cfg().sourceBranch)}`)]);
    const value = {
      connected: true, checkedAt: new Date(), checkError: null, serverCommit: head.sha, sourceHead: src.sha, deployedSubject: brief(head).subject,
      pending: cmp.status === 'ahead' || cmp.status === 'diverged' ? (cmp.commits || []).slice().reverse().slice(0, 50).map(brief) : [],
      diverged: cmp.status === 'diverged', behind: cmp.behind_by || 0,
    };
    cache = { at: Date.now(), value };
    return { ...base, ...value };
  } catch (e) {
    return { ...base, connected: false, checkError: e.status === 401 || e.status === 403 ? 'token' : e.status === 404 ? 'not_found' : clean(e.message, 200) };
  }
}

/** Fast-forwards the deploy branch to the newest source commit (never a force push). */
async function update(ctx, by) {
  const s = await status({ fresh: true });
  if (!s.configured || !s.connected) throw E.notConfigured('GitHub updates');
  if (s.state === 'running') throw E.conflict('UPDATE_RUNNING', 'An update is already running.');
  if (!s.pending.length) throw E.conflict('UP_TO_DATE', 'There is nothing to install: the system is up to date.');
  if (s.diverged) throw E.conflict('DIVERGED', 'The deployed branch has changes that are not on the source branch.');
  const target = s.sourceHead; // the newest commit on the source branch (the compare list can be truncated)
  await gh(`/git/refs/heads/${encodeURIComponent(cfg().deployBranch)}`, { method: 'PATCH', body: { sha: target, force: false } });
  cache = null;
  const run = { action: 'update', from: s.serverCommit, to: target, requested_by: clean(by), requested_at: new Date().toISOString(), started_at: new Date().toISOString(),
    log: [`${cfg().deployBranch} → ${target.slice(0, 7)} (${s.pending.length} change(s)). The host is rebuilding the site.`] };
  await settings.set(null, 'system_update_run', run);
  await audit.record(ctx, 'system.update_requested', { entityType: 'system', newValues: { from: s.serverCommit, to: target, mode: 'github' } });
  return run;
}

/** Moves the deploy branch back to the commit it had before the last update. */
async function rollback(ctx, by) {
  const run = await settings.get('system_update_run');
  if (!configured()) throw E.notConfigured('GitHub updates');
  if (!run || run.action !== 'update' || !run.from) throw E.conflict('NOTHING_TO_ROLL_BACK', 'There is no previous version to return to.');
  await gh(`/git/refs/heads/${encodeURIComponent(cfg().deployBranch)}`, { method: 'PATCH', body: { sha: run.from, force: true } });
  cache = null;
  const next = { action: 'rollback', from: run.to, to: run.from, requested_by: clean(by), requested_at: new Date().toISOString(), started_at: new Date().toISOString(), log: [`${cfg().deployBranch} → ${run.from.slice(0, 7)} (back to the previous version).`] };
  await settings.set(null, 'system_update_run', next);
  await audit.record(ctx, 'system.update_rolled_back', { entityType: 'system', newValues: { to: run.from, mode: 'github' } });
  return next;
}

/** Called once at start-up: if this process started after an update was requested, that update is now live. */
async function markLive() {
  const run = await settings.get('system_update_run');
  if (run && !run.result && new Date(run.requested_at) < STARTED_AT) {
    await settings.set(null, 'system_update_run', { ...run, result: run.action === 'rollback' ? 'rolled_back' : 'done', finished_at: STARTED_AT.toISOString(), message: run.action === 'rollback' ? 'The previous version is running again.' : 'The new version is running.' });
  }
}

/** Pending count from the last check only (the staff menu badge must never wait for GitHub). */
const cachedPending = () => (cache ? cache.value.pending.length : 0);

module.exports = { status, update, rollback, markLive, configured, cachedPending, STARTED_AT, _reset: () => { cache = null; } };
