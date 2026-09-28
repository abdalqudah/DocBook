const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const svc = require('./doctors.service');

const router = express.Router();
router.use(can('services.manage'));

async function render(req, res, extra = {}) {
  const rows = await knex('services as s').leftJoin('doctors as d', 'd.id', 's.doctor_id').where('s.business_id', req.ctx.businessId)
    .orderBy([{ column: 's.is_active', order: 'desc' }, { column: 's.sort_order' }, { column: 's.name' }]).select('s.*', 'd.full_name as doctor_name');
  const doctors = await knex('doctors').where({ business_id: req.ctx.businessId }).orderBy('full_name').select('id', 'full_name');
  res.page('pages/clinic/services', { title: req.t('nav.services'), rows, doctors, ...extra });
}
router.get('/', wrap((req, res) => render(req, res)));
const rerender = (req, res, extra) => render(req, res, { ...extra, openDialog: 'service-dialog', formAction: req.originalUrl });
router.post('/', form(async (req, res) => { await svc.saveService(req.ctx, null, req.body); flash(req, 'success', req.t('services.saved')); res.redirect('/app/services'); }, rerender));
router.post('/:id(\\d+)', form(async (req, res) => { await svc.saveService(req.ctx, Number(req.params.id), req.body); flash(req, 'success', req.t('common.updated')); res.redirect('/app/services'); }, rerender));
router.post('/:id(\\d+)/delete', wrap(async (req, res) => { await svc.services.remove(req.ctx, Number(req.params.id)); flash(req, 'success', req.t('common.deleted')); res.redirect('/app/services'); }));

module.exports = router;
