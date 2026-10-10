const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const svc = require('./doctors.service');
const ops = require('../platformops/ops.service'); // service categories
const branches = require('./branches.service');

const router = express.Router();
router.use(can('services.manage'));

async function render(req, res, extra = {}) {
  const rows = await knex('services as s').leftJoin('doctors as d', 'd.id', 's.doctor_id').where('s.business_id', req.ctx.businessId)
    // the branch the member works in: its doctors' services and the clinic-wide ones
    .modify((q) => { if (req.ctx.workBranch) q.where((w) => w.whereNull('s.doctor_id').orWhere((x) => branches.scopeDoctors(x.whereNotNull('s.doctor_id'), req.ctx, 'd'))); })
    .orderBy([{ column: 's.is_active', order: 'desc' }, { column: 's.sort_order' }, { column: 's.name' }]).select('s.*', 'd.full_name as doctor_name', 'd.color as doctor_color');
  const doctors = await branches.scopeDoctors(knex('doctors').where({ business_id: req.ctx.businessId }), req.ctx).orderBy('full_name').select('id', 'full_name');
  const categories = await ops.listCategories(req.ctx.businessId);
  const counts = {};
  rows.forEach((r) => { if (r.category_id) counts[r.category_id] = (counts[r.category_id] || 0) + 1; });
  const cat = req.query.category === 'none' ? 'none' : Number(req.query.category) || null;
  const shown = cat === 'none' ? rows.filter((r) => !r.category_id) : cat ? rows.filter((r) => r.category_id === cat) : rows;
  const groups = categories.length ? ops.groupByCategory(shown, categories) : [{ category: null, items: shown }];
  res.page('pages/clinic/services', {
    title: req.t('nav.services'), rows, groups, doctors, categories, counts, cat, pageStyles: ['/css/platformops.css'], ...extra,
  });
}
router.get('/', wrap((req, res) => render(req, res)));
const rerender = (req, res, extra) => render(req, res, { ...extra, openDialog: 'service-dialog', formAction: req.originalUrl });
async function saveWithCategory(req, id) {
  await ops.checkCategory(req.ctx, req.body.category_id); // before saving, so a bad category saves nothing
  const saved = await svc.saveService(req.ctx, id, req.body);
  await ops.setServiceCategory(req.ctx, Number(saved || id), req.body.category_id);
}
router.post('/', form(async (req, res) => { await saveWithCategory(req, null); flash(req, 'success', req.t('services.saved')); res.redirect('/app/services'); }, rerender));
router.post('/:id(\\d+)', form(async (req, res) => { await saveWithCategory(req, Number(req.params.id)); flash(req, 'success', req.t('common.updated')); res.redirect('/app/services'); }, rerender));
router.post('/:id(\\d+)/delete', wrap(async (req, res) => { await svc.services.remove(req.ctx, Number(req.params.id)); flash(req, 'success', req.t('common.deleted')); res.redirect('/app/services'); }));

// ---------------------------------------------------------------- categories (platformops)
const catRerender = (req, res, extra) => render(req, res, { ...extra, openDialog: 'category-dialog', catAction: req.originalUrl });
router.post('/categories', form(async (req, res) => { await ops.saveCategory(req.ctx, null, req.body); flash(req, 'success', req.t('svc_cat.saved')); res.redirect('/app/services'); }, catRerender));
router.post('/categories/:id(\\d+)', form(async (req, res) => { await ops.saveCategory(req.ctx, Number(req.params.id), req.body); flash(req, 'success', req.t('common.updated')); res.redirect('/app/services'); }, catRerender));
router.post('/categories/:id(\\d+)/delete', wrap(async (req, res) => { await ops.removeCategory(req.ctx, Number(req.params.id)); flash(req, 'success', req.t('svc_cat.deleted')); res.redirect('/app/services'); }));

module.exports = router;
