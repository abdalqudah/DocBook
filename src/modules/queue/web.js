// Waiting-room screens in the clinic (/app/queue-screens): add a screen, copy or open its secret link, rename it,
// choose short or full patient names and the branch, a new link, delete. Reception (frontdesk.use) can see and open
// the screens; changing them needs appointments.manage. The screen itself: screen.web.js (/queue/<token>).
const express = require('express');
const { phoneBase } = require('../../middleware/web');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { E } = require('../../core/errors');
const branches = require('../clinic/branches.service');
const svc = require('./queue.service');

const router = express.Router();
router.use(can('frontdesk.use'));

async function render(req, res, extra = {}) {
  const reach = phoneBase(req);
  const { ctx } = req;
  const wb = String(ctx.workBranch || '');
  const [all, multi, doctors] = await Promise.all([
    svc.list(ctx.businessId), branches.multi(ctx.businessId),
    branches.scopeDoctors(require('../../db/knex')('doctors').where({ business_id: ctx.businessId, is_active: true }), ctx).orderBy(['sort_order', 'full_name']).select('id', 'full_name', 'full_name_en', 'room'), // eslint-disable-line global-require
  ]);
  // the branch chosen in the account menu: its screens (and those showing every branch)
  const list = wb ? all.filter((x) => x.branch_id === null || x.branch_id === undefined || String(x.branch_id) === (wb === 'main' ? '0' : wb)) : all;
  let branchOptions = null;
  if (multi) {
    const opts = await branches.options(req.business, req.t, req.locale);
    branchOptions = [{ value: '', label: req.t('queue.all_branches') }, { ...opts[0], value: 'main' }, ...opts.slice(1)];
  }
  res.page('pages/queue/screens', {
    title: req.t('queue.title'), list: list.map((k) => ({ ...k, url: svc.displayUrl(k, reach.base) })), reach, doctors, branchOptions,
    canManage: ctx.permissions.has('appointments.manage'), pageStyles: ['/css/attendance.css'], ...extra,
  });
}


router.get('/', wrap((req, res) => render(req, res)));
router.get('/:id(\\d+)/open', wrap(async (req, res) => {
  const url = svc.displayUrl(await svc.get(req.ctx, Number(req.params.id)), phoneBase(req).base);
  if (!url) throw E.notFound('Screen');
  res.redirect(url);
}));
router.post('/', can('appointments.manage'), form(async (req, res) => {
  await svc.create(req.ctx, req.body);
  flash(req, 'success', req.t('queue.created'));
  res.redirect('/app/queue-screens');
}, render));
router.post('/:id(\\d+)', can('appointments.manage'), form(async (req, res) => {
  await svc.update(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/queue-screens');
}, render));
router.post('/:id(\\d+)/regenerate', can('appointments.manage'), wrap(async (req, res) => {
  await svc.regenerate(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('queue.regenerated'));
  res.redirect('/app/queue-screens');
}));
router.post('/:id(\\d+)/delete', can('appointments.manage'), wrap(async (req, res) => {
  await svc.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('queue.deleted'));
  res.redirect('/app/queue-screens');
}));

module.exports = router;
