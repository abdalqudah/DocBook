// Platform admin → Clinic databases (/admin/databases): status, moving clinics to their own databases (background,
// followed as JSON), and syncing every database's structure. Inside the super-admin router; every action is audited.
const express = require('express');
const { wrap, flash } = require('../../routes/helpers');
const svc = require('./databases.service');

const router = express.Router();

router.get('/databases', wrap(async (req, res) => {
  res.page('pages/admin/databases', {
    layout: 'admin', title: req.t('dbsep.title'), o: await svc.overview(), job: svc.status(),
    pageStyles: ['/css/admin.css'], pageScripts: ['/js/dbsep.js'],
  });
}));
router.get('/databases/status', wrap(async (req, res) => { res.set('Cache-Control', 'no-store').json({ job: svc.status() }); }));
const said = (req, r) => {
  if (r.ok) flash(req, 'success', req.t('dbsep.started', { n: r.total }));
  else flash(req, 'error', req.t(`dbsep.not_started.${r.reason}`));
};
router.post('/databases/move-all', wrap(async (req, res) => { said(req, await svc.startAll(req.ctx)); res.redirect('/admin/databases'); }));
router.post('/databases/move/:id(\\d+)', wrap(async (req, res) => { said(req, await svc.start(req.ctx, [req.params.id])); res.redirect('/admin/databases'); }));
router.post('/databases/stop', wrap(async (req, res) => { svc.stop(); flash(req, 'success', req.t('dbsep.stopping')); res.redirect('/admin/databases'); }));
router.post('/databases/sync', wrap(async (req, res) => {
  const r = await svc.syncNow(req.ctx);
  flash(req, 'success', req.t('dbsep.synced_done', { n: r.databases, c: r.changes }));
  res.redirect('/admin/databases');
}));

module.exports = router;
