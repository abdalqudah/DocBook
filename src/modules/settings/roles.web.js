// Roles & permissions (Clinic → Team → Roles, /app/clinic/roles). Also mounted at /app/settings/roles so forms posted from
// an old page keep working; GET /app/settings/roles redirects here (src/routes/app.js).
const express = require('express');
const { z, validate, optionalString } = require('../../core/validate');
const { E } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const rbac = require('../rbac/rbac.service');
const { GROUPS, SYSTEM_ROLES } = require('../rbac/permissions');
const { dictionaries } = require('../../core/i18n');
const { form } = require('./form');
const { render } = require('./common');

const router = express.Router();

const renderRoles = async (req, res, extra = {}) => {
  const roles = await rbac.listRoles(req.ctx.businessId);
  const order = SYSTEM_ROLES.map((r) => r.key);
  roles.sort((a, b) => (b.is_system - a.is_system) || (order.indexOf(a.key) - order.indexOf(b.key)) || (a.id - b.id));
  const dict = (dictionaries[req.locale] || {}).perms || {};
  const en = (dictionaries.en || {}).perms || {};
  render(req, res, 'roles', 'roles', { roles, groups: GROUPS, permLabel: (p) => dict[p] || en[p] || p, ...extra });
};
router.get('/', can('roles.manage'), wrap((req, res) => renderRoles(req, res)));
const roleInput = (body) => {
  const d = validate(z.object({ name: z.string().trim().min(2, 'Required.').max(120), description: optionalString(255) }), body);
  const perms = [].concat(body.permissions || []).map(String);
  if (!perms.length) throw E.validation({ permissions: 'Choose at least one permission.' });
  return { name: d.name, description: d.description, permissions: perms };
};
const rerenderRole = (req, res, extra) => renderRoles(req, res, { ...extra, openDialog: 'role-dialog', formAction: req.originalUrl });
router.post('/', can('roles.manage'), form(async (req, res) => {
  const id = await rbac.saveRole(req.ctx, roleInput(req.body));
  flash(req, 'success', req.t('settings.role_saved'));
  res.redirect(`/app/clinic/roles#role-${id}`);
}, rerenderRole));
router.post('/:id(\\d+)', can('roles.manage'), form(async (req, res) => {
  const role = await rbac.getRole(req.ctx.businessId, Number(req.params.id));
  if (role.is_system) throw E.conflict('ROLE_LOCKED', 'Built-in roles cannot be changed.');
  await rbac.saveRole(req.ctx, { id: role.id, ...roleInput(req.body) });
  flash(req, 'success', req.t('common.updated'));
  res.redirect('/app/clinic/roles');
}, rerenderRole));
router.post('/:id(\\d+)/delete', can('roles.manage'), form(async (req, res) => {
  await rbac.deleteRole(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('common.deleted'));
  res.redirect('/app/clinic/roles');
}, renderRoles));

module.exports = router;
