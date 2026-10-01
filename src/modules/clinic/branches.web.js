// Clinic → Branches (/app/clinic/branches): the main branch (the clinic itself) and the other branches — add, edit,
// turn off / on, delete an unused one. How many may run is the clinic's package (Settings → Subscription).
const express = require('express');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const knex = require('../../db/knex');
const branches = require('./branches.service');
const subs = require('../subscriptions/subscriptions.service');

const router = express.Router();
router.use(can('settings.manage'));
const BASE = '/app/clinic/branches';

async function render(req, res, extra = {}) {
  const rows = await branches.list(req.ctx.businessId);
  const [allowed, doctorCounts, subsOn] = await Promise.all([
    subs.branchAllowance(req.business),
    knex('doctors').where({ business_id: req.ctx.businessId, is_active: true }).groupBy('branch_id').select('branch_id').count({ n: '*' }),
    subs.settings().then((c) => c.enabled),
  ]);
  const doctorsIn = Object.fromEntries(doctorCounts.map((r) => [r.branch_id || 'main', Number(r.n)]));
  const active = rows.filter((r) => r.is_active).length + 1;
  res.page('pages/clinic/branches', {
    title: req.t('branches.title'), rows, allowed, active, room: allowed === null || active < allowed, doctorsIn, subsOn,
    clinic: req.business, errors: {}, formError: null, old: {}, ...extra,
  });
}
const rerender = (req, res, extra) => render(req, res, { ...extra, openDialog: true, formAction: req.originalUrl });

// Turning a branch off / on and deleting it come back to the list with the reason when refused.
const act = (fn, okKey) => wrap(async (req, res) => {
  try {
    await fn(req);
    flash(req, 'success', req.t(okKey));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 || e.status === 403) throw e;
    const tr = req.t(`errors.${e.code}`);
    flash(req, 'error', tr !== `errors.${e.code}` ? tr : e.message);
  }
  res.redirect(BASE);
});

router.get('/', wrap((req, res) => render(req, res)));
router.post('/', form(async (req, res) => { await branches.save(req.ctx, req.business, null, req.body); flash(req, 'success', req.t('branches.saved')); res.redirect(BASE); }, rerender));
router.post('/:id(\\d+)', form(async (req, res) => { await branches.save(req.ctx, req.business, Number(req.params.id), req.body); flash(req, 'success', req.t('common.updated')); res.redirect(BASE); }, rerender));
router.post('/:id(\\d+)/off', act((req) => branches.setActive(req.ctx, req.business, Number(req.params.id), false), 'branches.turned_off'));
router.post('/:id(\\d+)/on', act((req) => branches.setActive(req.ctx, req.business, Number(req.params.id), true), 'branches.turned_on'));
router.post('/:id(\\d+)/delete', act((req) => branches.remove(req.ctx, Number(req.params.id)), 'common.deleted'));

module.exports = router;
