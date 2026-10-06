// Staff: System → System update (system.update). Shows the running version, updates waiting on the Git branch, the
// updater's live progress, and the buttons that ask the server updater to check or install.
const express = require('express');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah } = require('../../core/http');
const { AppError } = require('../../core/errors');
const nav = require('../staff/nav');
const updates = require('./updates');

nav.add('system', { key: 'system_update', href: '/staff/system/update', icon: 'refresh-cw', perms: ['system.update'], badge: async () => { const s = updates.status(); return s.connected ? s.pending.length : 0; } });

const router = express.Router();

router.get('/system/update', can('system.update'), ah(async (req, res) => {
  res.page('pages/staff/system/update', { layout: 'staff', narrow: true, title: req.t('nav.system_update'), s: updates.status(), pageScripts: ['/js/updates.js'] });
}));
// Polled by the page while an update runs (the app restarts during it, so the script tolerates failures).
router.get('/system/update/status.json', can('system.update'), (req, res) => {
  const s = updates.status();
  res.set('Cache-Control', 'no-store').json({ state: s.state, connected: s.connected, queued: !!s.queued, commit: s.app.short, log: s.run ? s.run.log.slice(-30) : [], message: s.run ? s.run.message || null : null });
});
router.post('/system/update/:action(check|update)', can('system.update'), ah(async (req, res) => {
  try {
    await updates.request(req.ctx, req.params.action, `${req.user.name} <${req.user.email}>`);
    flash(req, 'ok', req.t(req.params.action === 'update' ? 'sysupdate.started' : 'sysupdate.check_started'));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    flash(req, 'error', req.t(`sysupdate.err.${e.code}`));
  }
  res.redirect('/staff/system/update');
}));

module.exports = router;
