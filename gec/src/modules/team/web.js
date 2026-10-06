// Team: employees and branches.
const express = require('express');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { ah, idParam } = require('../../core/http');
const { validate, z, reqStr, str, email, phone, reqId, id, bool, list, password, optEmail } = require('../../core/validate');
const nav = require('../staff/nav');
const registry = require('../staff/registry');
const settingsWeb = require('../settings/web');
const employees = require('./employees.service');
const emailCh = require('../comms/email');
const ref = require('../catalog/reference');
const { translator } = require('../../core/i18n');

nav.add('team', { key: 'employees', href: '/staff/employees', icon: 'users-round', perms: ['employees.view'] });
settingsWeb.addSection({ key: 'branches', icon: 'building-2', href: '/staff/branches', perms: ['settings.manage'] }, { after: 'company' });
settingsWeb.addSection({ key: 'users', icon: 'users-round', href: '/staff/employees', perms: ['employees.manage'] }, { after: 'branches' });
registry.addSearch(async (req, q) => {
  if (!req.can('employees.view')) return null;
  const rows = (await employees.list({ q })).slice(0, 5);
  return { key: 'employees', label: req.t('nav.employees'), items: rows.map((r) => ({ title: r.name, sub: [r.job_title, r.email].filter(Boolean).join(' · '), href: `/staff/employees/${r.id}`, icon: 'user' })) };
});

const router = express.Router();

async function formData(req) {
  return {
    roles: await knex('roles').orderBy('is_system', 'desc').orderBy('id'),
    branches: await knex('branches').where({ is_active: true }).orderBy('name'),
    managers: await employees.options(),
    destinations: await ref.destinationOptions(req.locale),
  };
}

const employeeSchema = z.object({
  name: reqStr(160), phone: phone(), role_id: reqId(), branch_id: id(), manager_id: id(), job_title: str(120), department: str(80),
  is_counsellor: bool(), auto_assign: bool(), countries: list(30), locale: z.enum(['en', 'ar']).optional(),
});

router.get('/employees', can('employees.view'), ah(async (req, res) => {
  res.page('pages/staff/team/employees', { layout: 'staff', title: req.t('nav.employees'), rows: await employees.list(req.query), ...(await formData(req)) });
}));

router.get('/employees/new', can('employees.manage'), ah(async (req, res) => {
  res.page('pages/staff/team/employee-form', { layout: 'staff', narrow: true, title: req.t('team.new_employee'), e: { auto_assign: true, countries: [] }, ...(await formData(req)), old: { mode: 'invite' } });
}));

router.post('/employees', can('employees.manage'), ah(async (req, res) => {
  try {
    const base = validate(employeeSchema.extend({ email: email(), mode: z.enum(['invite', 'password']) }), req.body);
    if (base.mode === 'password') {
      if (req.body.temp_password !== req.body.temp_password_confirm) throw Object.assign(new Error('x'), { code: 'VALIDATION_FAILED', details: { temp_password_confirm: 'Passwords do not match.' } });
      base.temp_password = validate(z.object({ p: password() }), { p: req.body.temp_password }).p;
    }
    const { id: empId, inviteLink } = await employees.create(req.ctx, req.staff, base);
    if (inviteLink) {
      const t = translator(base.locale || 'en');
      const html = await emailCh.layout({ locale: base.locale || 'en', title: t('team.invite_subject', { brand: res.locals.branding.name }), body: t('team.invite_body', { name: base.name, brand: res.locals.branding.legal_name }), cta: t('team.invite_cta'), href: inviteLink });
      const r = await emailCh.send({ to: base.email, subject: t('team.invite_subject', { brand: res.locals.branding.name }), html }).catch(() => ({ sent: false }));
      if (!r.sent) req.session.inviteLink = inviteLink; // shown once to the admin to pass on
      flash(req, 'ok', r.sent ? req.t('team.invite_sent') : req.t('team.invite_not_sent'));
    } else flash(req, 'ok', req.t('team.created_with_password'));
    return res.redirect(`/staff/employees/${empId}`);
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return res.page('pages/staff/team/employee-form', { layout: 'staff', narrow: true, title: req.t('team.new_employee'), e: {}, ...(await formData(req)), old: req.body, errors: e.details });
  }
}));

router.get('/employees/:id', can('employees.view'), ah(async (req, res) => {
  const e = await employees.get(idParam(req.params.id));
  const inviteLink = req.session.inviteLink || null;
  delete req.session.inviteLink;
  const stats = {
    leads: Number((await knex('leads').where({ counsellor_id: e.id, status: 'open' }).count({ n: '*' }))[0].n),
    students: Number((await knex('students').where({ counsellor_id: e.id }).whereIn('status', ['active', 'on_hold']).count({ n: '*' }))[0].n),
    tasks: Number((await knex('tasks').where({ assignee_id: e.id }).whereNot('status', 'completed').count({ n: '*' }))[0].n),
  };
  res.page('pages/staff/team/employee-form', { layout: 'staff', narrow: true, title: e.name, e, stats, inviteLink, ...(await formData(req)) });
}));

router.post('/employees/:id', can('employees.manage'), ah(async (req, res) => {
  const empId = idParam(req.params.id);
  try {
    const data = validate(employeeSchema, req.body);
    await employees.update(req.ctx, req.staff, empId, data);
    flash(req, 'ok', req.t('common.saved'));
    return res.redirect(`/staff/employees/${empId}`);
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    const emp = await employees.get(empId);
    return res.page('pages/staff/team/employee-form', { layout: 'staff', narrow: true, title: emp.name, e: emp, ...(await formData(req)), old: req.body, errors: e.details });
  }
}));

router.post('/employees/:id/status', can('employees.manage'), ah(async (req, res) => {
  await employees.setStatus(req.ctx, req.staff, idParam(req.params.id), req.body.status === 'disabled' ? 'disabled' : 'active');
  flash(req, 'ok', req.t('common.saved'));
  res.redirect(`/staff/employees/${req.params.id}`);
}));

router.post('/employees/:id/reset-link', can('employees.manage'), ah(async (req, res) => {
  // The link goes to the employee's own inbox; it is shown here only when e-mail is not connected yet.
  const r = await employees.resetLink(req.ctx, req.staff, idParam(req.params.id));
  if (r) {
    const auth = require('../auth/auth.service'); // eslint-disable-line global-require
    const t = translator(r.user.locale || 'en');
    const html = await emailCh.layout({ locale: r.user.locale || 'en', title: t('auth.reset_mail_subject'), body: t('auth.reset_mail_body', { minutes: auth.RESET_MINUTES }), cta: t('auth.reset_mail_cta'), href: r.link });
    const sent = await emailCh.send({ to: r.user.email, subject: t('auth.reset_mail_subject'), html }).catch(() => ({ sent: false }));
    if (!sent.sent) req.session.inviteLink = r.link;
    flash(req, 'ok', sent.sent ? req.t('team.reset_sent') : req.t('team.invite_not_sent'));
  }
  res.redirect(`/staff/employees/${req.params.id}`);
}));

// ---- Branches
const branchSchema = z.object({ name: reqStr(120), name_ar: str(120), country: str(80), city: str(80), address: str(255), phone: str(40), email: optEmail(), timezone: str(60), manager_id: id(), is_active: bool() });

router.get('/branches', can('settings.manage'), ah(async (req, res) => {
  const rows = await knex('branches as b').leftJoin('employees as e', 'e.id', 'b.manager_id').leftJoin('users as u', 'u.id', 'e.user_id')
    .select('b.*', 'u.name as manager_name', knex.raw('(SELECT COUNT(*) FROM employees x WHERE x.branch_id = b.id) AS staff_count')).orderBy('b.name');
  res.page('pages/staff/team/branches', { layout: 'staff', title: req.t('settings.branches'), rows, managers: await employees.options(), edit: req.query.edit ? rows.find((r) => r.id === Number(req.query.edit)) : null });
}));

router.post('/branches', can('settings.manage'), ah(async (req, res) => {
  const data = validate(branchSchema, req.body);
  const bid = req.body.id ? Number(req.body.id) : null;
  const row = { ...data, timezone: data.timezone || 'UTC', manager_id: data.manager_id || null };
  if (bid) {
    const before = await knex('branches').where({ id: bid }).first();
    await knex('branches').where({ id: bid }).update({ ...row, updated_at: new Date() });
    const d = audit.diff(before, row);
    if (d.changed) await audit.record(req.ctx, 'branch.updated', { entityType: 'branch', entityId: bid, oldValues: d.oldValues, newValues: d.newValues });
  } else {
    const [nid] = await knex('branches').insert(row);
    await audit.record(req.ctx, 'branch.created', { entityType: 'branch', entityId: nid, newValues: row });
  }
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/staff/branches');
}));

module.exports = router;
