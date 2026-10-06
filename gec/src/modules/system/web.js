// Staff: System → System update (system.update). Shows the running version, updates waiting on the Git branch, the
// updater's live progress, and the buttons that ask the server updater to check or install.
const express = require('express');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah } = require('../../core/http');
const { AppError } = require('../../core/errors');
const nav = require('../staff/nav');
const config = require('../../config');
const updates = require('./updates');
const github = require('./github');

const provider = () => config.updates.mode;
const statusOf = async () => {
  if (provider() === 'github') return github.status();
  if (provider() === 'upload') return { mode: 'upload', connected: false, pending: [], state: 'idle', run: null, queued: null };
  return { ...updates.status(), mode: updates.status().mode || 'server' };
};

nav.add('system', { key: 'system_update', href: '/staff/system/update', icon: 'refresh-cw', perms: ['system.update'], badge: async () => { if (provider() === 'github') return github.cachedPending(); if (provider() === 'upload') return 0; const s = updates.status(); return s.connected ? s.pending.length : 0; } });

const router = express.Router();

router.get('/system/update', can('system.update'), ah(async (req, res) => {
  const s = await statusOf();
  res.page('pages/staff/system/update', { layout: 'staff', narrow: true, title: req.t('nav.system_update'), s: { app: require('./version').version(), ...s }, provider: provider(), cfg: config.updates, pageScripts: ['/js/updates.js'] }); // eslint-disable-line global-require
}));
// Polled by the page while an update runs (the app restarts during it, so the script tolerates failures).
router.get('/system/update/status.json', can('system.update'), ah(async (req, res) => {
  const s = { app: require('./version').version(), ...(await statusOf()) }; // eslint-disable-line global-require
  res.set('Cache-Control', 'no-store').json({ state: s.state, connected: s.connected, queued: !!s.queued, commit: s.app.short, log: s.run ? (s.run.log || []).slice(-30) : [], message: s.run ? s.run.message || null : null });
}));
router.post('/system/update/:action(check|update|rollback)', can('system.update'), ah(async (req, res) => {
  const by = `${req.user.name} <${req.user.email}>`;
  try {
    if (provider() === 'github') {
      if (req.params.action === 'update') await github.update(req.ctx, by);
      else if (req.params.action === 'rollback') await github.rollback(req.ctx, by);
      else await github.status({ fresh: true });
    } else if (provider() === 'upload') {
      throw new AppError('UPLOAD_MODE', 'Updates are uploaded in the hosting panel.', 409);
    } else if (req.params.action === 'rollback') {
      throw new AppError('VALIDATION_FAILED', 'Rollback is automatic on a server install.', 422);
    } else await updates.request(req.ctx, req.params.action, by);
    flash(req, 'ok', req.t({ update: provider() === 'github' ? 'sysupdate.started_github' : 'sysupdate.started', rollback: 'sysupdate.rollback_started', check: provider() === 'github' ? 'sysupdate.checked' : 'sysupdate.check_started' }[req.params.action]));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', req.t(`sysupdate.err.${e.code}`));
  }
  res.redirect('/staff/system/update');
}));

module.exports = router;
