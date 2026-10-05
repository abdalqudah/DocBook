// Staff & logins: every person who signs in to the clinic (doctors, nurses, reception, accounting, management).
// Add a login (invitation e-mail/link or temporary password), change role / doctor profile / status, remove access,
// generate a one-time password-reset link, and manage pending invitations. Protection rules (last owner, self) are in the service.
const express = require('express');
const knex = require('../../db/knex');
const mailer = require('../../core/mailer');
const { z, validate, optionalString, emptyToUndefined, email } = require('../../core/validate');
const { E } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const businesses = require('../businesses/business.service');
const rbac = require('../rbac/rbac.service');
const { PORTAL_ROLES, SYSTEM_ROLES } = require('../rbac/permissions');
const { form } = require('./form');
const { render, stash, takeStash, baseUrl } = require('./common');

const router = express.Router();
router.use(can('users.manage'));
router.use(require('../access/web')); // per-member page access: /app/clinic/team/:id/access

// Readable sections of the team list.
const GROUPS = [
  { key: 'doctors', roles: ['doctor'], icon: 'stethoscope' },
  { key: 'nurses', roles: ['nurse'], icon: 'heart-pulse' },
  { key: 'reception', roles: ['receptionist'], icon: 'clipboard-list' },
  { key: 'accounting', roles: ['accountant'], icon: 'wallet' },
  { key: 'management', roles: ['owner', 'clinic_manager'], icon: 'building-2' },
  { key: 'other', roles: null, icon: 'users' },
];
const groupOf = (roleKey) => (GROUPS.find((g) => g.roles && g.roles.includes(roleKey)) || GROUPS[GROUPS.length - 1]).key;
const ROLE_ORDER = SYSTEM_ROLES.map((r) => r.key);

async function teamData(req) {
  const b = req.ctx.businessId;
  const [members, roles, doctors, invitations, pageAccess] = await Promise.all([
    businesses.listMembers(b),
    rbac.listRoles(b),
    knex('doctors').where({ business_id: b }).orderBy([{ column: 'is_active', order: 'desc' }, { column: 'full_name' }]).select('id', 'full_name', 'full_name_en', 'specialization', 'is_active'),
    businesses.listInvitations(b),
    require('../access/access.service').summaries(b), // eslint-disable-line global-require
  ]);
  roles.sort((x, y) => (y.is_system - x.is_system) || (ROLE_ORDER.indexOf(x.key) - ROLE_ORDER.indexOf(y.key)) || (x.id - y.id));
  const linked = new Map(members.filter((m) => m.doctor_id).map((m) => [m.doctor_id, m]));
  const invitedDoctors = new Set(invitations.filter((i) => i.doctor_id).map((i) => i.doctor_id));
  const assignable = roles.filter((r) => r.key !== 'owner' || req.ctx.permissions.has('data.manage'));
  // Who the clinic may change the name / e-mail / phone of (businesses.memberDetailsAccess).
  const access = Object.fromEntries(await Promise.all(members.map(async (m) => [m.id, await businesses.memberDetailsAccess(req.ctx, m.id)])));
  return {
    members: members.map((m) => ({ ...m, group: groupOf(m.role_key), isSelf: m.user_id === req.ctx.userId, pageAccess: pageAccess[m.id] || null,
      detailsLock: access[m.id].ok ? '' : access[m.id].reason, emailLock: Boolean(access[m.id].emailLocked) })),
    roles, assignable, doctors: doctors.map((d) => ({ ...d, linkedTo: linked.get(d.id) || null, invited: invitedDoctors.has(d.id) })),
    invitations, groups: GROUPS,
  };
}

async function renderTeam(req, res, extra = {}) {
  const data = await teamData(req);
  const group = GROUPS.some((g) => g.key === req.query.group) ? req.query.group : 'all';
  const prefillDoctor = Number(req.query.doctor) || null;
  const doctorRole = data.roles.find((r) => r.key === 'doctor');
  render(req, res, 'team', 'team', {
    ...data, group, result: extra.result === undefined ? takeStash(req, 'teamResult') : extra.result,
    emailEnabled: mailer.configured(), portalRoles: PORTAL_ROLES, publicUrl: req.business.slug ? `${baseUrl(req)}/${req.business.slug}` : null,
    prefill: prefillDoctor && data.doctors.some((d) => d.id === prefillDoctor && !d.linkedTo) ? { doctor_id: prefillDoctor, role_id: doctorRole && doctorRole.id } : null,
    ...extra,
  });
}

router.get('/', wrap((req, res) => renderTeam(req, res)));

// ---------------------------------------------------------------- add a login
const addSchema = z.object({
  name: z.string().trim().min(2, 'Enter the full name.').max(160),
  email: email(),
  phone: z.preprocess(emptyToUndefined, z.string().trim().max(40).regex(/^[+0-9\s()-]{6,40}$/, 'Enter a valid phone number.').optional()),
  role_id: z.coerce.number({ invalid_type_error: 'Choose a valid role.' }).int().positive('Choose a valid role.'),
  doctor_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  job_title: optionalString(100),
  mode: z.enum(['invite', 'password'], { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  locale: z.enum(['ar', 'en']).default('ar'),
});

/** Adds a staff login and returns the shown-once result (also used by the setup wizard). */
async function addLogin(req, body) {
  const d = validate(addSchema, body);
  const role = await knex('roles').where({ id: d.role_id, business_id: req.ctx.businessId }).first('key', 'name', 'is_system');
  const out = await businesses.addStaff(req.ctx, { name: d.name, email: d.email, phone: d.phone, roleId: d.role_id, doctorId: d.doctor_id, jobTitle: d.job_title, mode: d.mode, locale: d.locale });
  const base = { name: d.name, email: d.email, role: role ? { key: role.key, name: role.name, is_system: role.is_system } : null };
  if (out.added) return { type: 'added', ...base };
  if (out.password) return { type: 'password', ...base, password: out.password };
  return { type: 'invite', ...base, link: out.link, sent: Boolean(out.sent) };
}

router.post('/', form(async (req, res) => {
  const result = await addLogin(req, req.body);
  stash(req, 'teamResult', result);
  flash(req, 'success', req.t(`team.added_${result.type}`, { name: result.name }));
  res.redirect('/app/clinic/team');
}, (req, res, extra) => renderTeam(req, res, { ...extra, result: null, openDialog: 'add-dialog' })));

// ---------------------------------------------------------------- change a member
const editSchema = z.object({
  name: z.preprocess(emptyToUndefined, z.string().trim().min(2, 'Enter the full name.').max(160).optional()),
  email: z.preprocess(emptyToUndefined, z.string().trim().max(190).email('Enter a valid e-mail.').optional()),
  phone: z.preprocess(emptyToUndefined, z.string().trim().max(40).regex(/^[+0-9\s()-]{6,40}$/, 'Enter a valid phone number.').optional()),
  role_id: z.coerce.number({ invalid_type_error: 'Choose a valid role.' }).int().positive('Choose a valid role.'),
  doctor_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  job_title: z.preprocess((v) => (v === undefined ? '' : v), z.string().trim().max(100)),
  status: z.enum(['active', 'disabled']),
});
router.post('/:id(\\d+)', form(async (req, res) => {
  const d = validate(editSchema, req.body);
  // Name / e-mail / phone (only sent when the clinic may change them: the fields are read-only otherwise).
  if (req.body.details_form === '1' && (d.name || d.email || req.body.phone !== undefined)) {
    const a = await businesses.memberDetailsAccess(req.ctx, Number(req.params.id));
    if (a.ok) await businesses.changeMemberDetails(req.ctx, Number(req.params.id), { name: d.name, email: a.emailLocked ? undefined : d.email, phone: d.phone });
  }
  await businesses.changeMember(req.ctx, Number(req.params.id), { roleId: d.role_id, status: d.status, doctorId: d.doctor_id || null, jobTitle: d.job_title });
  flash(req, 'success', req.t('team.member_updated'));
  res.redirect('/app/clinic/team');
}, (req, res, extra) => renderTeam(req, res, { ...extra, result: null, openDialog: 'edit-dialog', editAction: req.originalUrl })));

router.post('/:id(\\d+)/status', form(async (req, res) => {
  const status = req.body.status === 'active' ? 'active' : 'disabled';
  await businesses.changeMember(req.ctx, Number(req.params.id), { status });
  flash(req, 'success', req.t(status === 'active' ? 'team.enabled_done' : 'team.disabled_done'));
  res.redirect('/app/clinic/team');
}, (req, res, extra) => renderTeam(req, res, { ...extra, result: null })));

router.post('/:id(\\d+)/remove', form(async (req, res) => {
  const m = await knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.id': Number(req.params.id), 'm.business_id': req.ctx.businessId }).first('u.name');
  if (!m) throw E.notFound('Staff member');
  if (String(req.body.confirm_name || '').trim() !== m.name.trim()) throw E.validation({ confirm_name: 'Type the name exactly to confirm.' });
  await businesses.removeMember(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('team.removed', { name: m.name }));
  res.redirect('/app/clinic/team');
}, (req, res, extra) => renderTeam(req, res, { ...extra, result: null })));

router.post('/:id(\\d+)/reset-link', form(async (req, res) => {
  const out = await businesses.adminResetLink(req.ctx, Number(req.params.id));
  stash(req, 'teamResult', out.link ? { type: 'reset', name: out.name, email: out.email, link: out.link } : { type: 'reset_emailed', name: out.name, email: out.email });
  res.redirect('/app/clinic/team');
}, (req, res, extra) => renderTeam(req, res, { ...extra, result: null })));

// ---------------------------------------------------------------- sign-in details (e-mail / WhatsApp)
// E-mail: sent to the person's own address. WhatsApp: opens WhatsApp (new tab) with the ready message to the person's
// number — the clinic presses send. See businesses.sendLoginDetails for who may receive which.
router.post('/:id(\\d+)/send-login', form(async (req, res) => {
  const channel = req.body.channel === 'whatsapp' ? 'whatsapp' : 'email';
  const out = await businesses.sendLoginDetails(req.ctx, Number(req.params.id), channel);
  if (channel === 'whatsapp') return res.redirect(out.href);
  flash(req, 'success', req.t('team.login_sent_email', { name: out.name }));
  return res.redirect('/app/clinic/team');
}, (req, res, extra) => renderTeam(req, res, { ...extra, result: null })));

const SEND_GROUPS = { all: null, doctors: ['doctor'], nurses: ['nurse'], reception: ['receptionist'], accounting: ['accountant'], management: ['clinic_manager', 'owner'] };
router.post('/send-logins', form(async (req, res) => {
  const key = Object.prototype.hasOwnProperty.call(SEND_GROUPS, req.body.group) ? req.body.group : 'all';
  const out = await businesses.emailLoginDetailsToAll(req.ctx, { roleKeys: SEND_GROUPS[key] });
  flash(req, out.failed ? 'warning' : 'success', req.t('team.login_sent_all', { n: out.sent, failed: out.failed }));
  res.redirect('/app/clinic/team');
}, (req, res, extra) => renderTeam(req, res, { ...extra, result: null, openDialog: 'send-dialog' })));

// ---------------------------------------------------------------- invitations
router.post('/invitations/:id(\\d+)/revoke', form(async (req, res) => {
  await businesses.revokeInvitation(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('team.invite_revoked'));
  res.redirect('/app/clinic/team');
}, (req, res, extra) => renderTeam(req, res, { ...extra, result: null })));

// A new link for a pending invitation (the old one stops working). Links are stored hashed, so they can't be shown again.
router.post('/invitations/:id(\\d+)/renew', form(async (req, res) => {
  const inv = await knex('invitations').where({ id: Number(req.params.id), business_id: req.ctx.businessId }).whereNull('accepted_at').whereNull('revoked_at').first();
  if (!inv) throw E.notFound('Invitation');
  await businesses.revokeInvitation(req.ctx, inv.id);
  const out = await businesses.addStaff(req.ctx, { name: inv.name, email: inv.email, roleId: inv.role_id, doctorId: inv.doctor_id || undefined, mode: 'invite', locale: req.locale });
  const role = await knex('roles').where({ id: inv.role_id }).first('key', 'name', 'is_system');
  stash(req, 'teamResult', { type: 'invite', name: inv.name || inv.email, email: inv.email, role, link: out.link, sent: Boolean(out.sent), renewed: true });
  res.redirect('/app/clinic/team');
}, (req, res, extra) => renderTeam(req, res, { ...extra, result: null })));

module.exports = router;
module.exports.addLogin = addLogin;
module.exports.teamData = teamData;
