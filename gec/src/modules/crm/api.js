// /api/leads — list, read, create, move stage, assign.
const express = require('express');
const { requireStaff, can } = require('../../middleware/auth');
const { ah, ok, idParam } = require('../../core/http');
const { validate } = require('../../core/validate');
const leads = require('./leads.service');
const forms = require('./forms');

const router = express.Router();
router.use(requireStaff);

router.get('/', can('leads.view'), ah(async (req, res) => ok(res, await leads.list(req.staff, req.query))));
router.get('/:id', can('leads.view'), ah(async (req, res) => ok(res, { lead: await leads.get(req.staff, idParam(req.params.id)) })));
router.post('/', can('leads.manage'), ah(async (req, res) => {
  const data = validate(forms.leadSchema, req.body);
  const { lead, created } = await leads.capture(req.ctx, { ...data, counsellor_id: req.can('leads.assign') ? data.counsellor_id : req.staff.employee.id }, { source: data.source || 'manual', consent: { contact: true } }, { staff: req.staff });
  ok(res, { lead, created }, 201);
}));
router.patch('/:id/stage', can('leads.manage'), ah(async (req, res) => {
  const lead = await leads.moveStage(req.ctx, req.staff, idParam(req.params.id), req.body.stage_id, { reason: req.body.reason });
  ok(res, { lead, message: req.t('leads.stage_changed') });
}));
router.patch('/:id/assign', can('leads.assign'), ah(async (req, res) => {
  ok(res, { lead: await leads.assign(req.ctx, req.staff, idParam(req.params.id), req.body.counsellor_id ? Number(req.body.counsellor_id) : null) });
}));

module.exports = router;
