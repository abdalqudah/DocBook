// /api/applications — list, read, move stage (Kanban).
const express = require('express');
const { requireStaff, can } = require('../../middleware/auth');
const { ah, ok, idParam } = require('../../core/http');
const apps = require('./applications.service');

const router = express.Router();
router.use(requireStaff);
router.get('/', can('applications.view'), ah(async (req, res) => ok(res, await apps.list(req.staff, req.query))));
router.get('/:id', can('applications.view'), ah(async (req, res) => ok(res, { application: await apps.get(req.staff, idParam(req.params.id)) })));
router.patch('/:id/stage', can('applications.manage'), ah(async (req, res) => {
  const application = await apps.moveStage(req.ctx, req.staff, idParam(req.params.id), req.body.stage_id, { reason: req.body.reason });
  ok(res, { application, message: req.t('applications.stage_changed') });
}));
module.exports = router;
