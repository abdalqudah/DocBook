// Roles & permissions (/staff/roles). Built-in roles are read-only; custom roles can be created.
const express = require('express');
const rbac = require('./rbac.service');
const { GROUPS } = require('./permissions');
const { can } = require('../../middleware/auth');
const { ah, idParam } = require('../../core/http');
const { flash } = require('../../middleware/web');
const { validate, z, reqStr, str } = require('../../core/validate');

const router = express.Router();
router.use(can('roles.manage'));

router.get('/', ah(async (req, res) => {
  res.page('pages/staff/roles/index', { layout: 'staff', title: req.t('settings.roles'), roles: await rbac.listRoles(), groups: GROUPS });
}));

async function form(req, res, role, extra = {}) {
  res.page('pages/staff/roles/form', { layout: 'staff', narrow: true, title: role.id ? role.name_en : req.t('roles.new'), role, groups: GROUPS, ...extra });
}

router.get('/new', ah((req, res) => form(req, res, { data_scope: 'own', permissions: ['dashboard.view'] })));
router.get('/:id', ah(async (req, res) => {
  const role = (await rbac.listRoles()).find((r) => r.id === idParam(req.params.id));
  if (!role) return res.redirect('/staff/roles');
  return form(req, res, role);
}));

const schema = z.object({ name_en: reqStr(120), name_ar: str(120), description: str(255), data_scope: z.enum(['own', 'branch', 'all']) });
const save = (id) => ah(async (req, res) => {
  try {
    const data = validate(schema, req.body);
    const perms = [].concat(req.body.permissions || []).map(String);
    const roleId = await rbac.saveRole(req.ctx, id ? idParam(req.params.id) : null, { ...data, permissions: perms });
    flash(req, 'ok', req.t('common.saved'));
    return res.redirect(`/staff/roles/${roleId}`);
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED' && e.code !== 'SYSTEM_ROLE') throw e;
    res.status(422);
    return form(req, res, { id: id ? idParam(req.params.id) : null, ...req.body, permissions: [].concat(req.body.permissions || []) }, { errors: e.details || {}, formError: e.code === 'SYSTEM_ROLE' ? e.message : null });
  }
});
router.post('/', save(false));
router.post('/:id', save(true));
router.post('/:id/delete', ah(async (req, res) => {
  await rbac.deleteRole(req.ctx, idParam(req.params.id));
  flash(req, 'ok', req.t('common.deleted'));
  res.redirect('/staff/roles');
}));

module.exports = router;
