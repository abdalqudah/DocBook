// Workspaces ("businesses"). DocBook called these projects/branches; a user can belong to several,
// each with its own role — the equivalent of DocBook's per-user allowedProjectIds.
const knex = require('../../db/knex');
const config = require('../../config');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const brand = require('../../config/brand');
const { translator } = require('../../core/i18n');
const { randomToken, sha256 } = require('../../core/tokens');
const { AppError, E } = require('../../core/errors');
const rbac = require('../rbac/rbac.service');

const PUBLIC_COLUMNS = ['id', 'name', 'legal_name', 'industry', 'country', 'currency', 'tax_number', 'phone', 'email', 'address', 'website', 'color',
  'logo_mime', 'logo_version', 'default_delivery_fee', 'invoice_prefix', 'invoice_next_number', 'onboarding_step', 'onboarding_completed_at', 'created_at'];

async function create(userId, { name, currency, industry, country }, trx = knex) {
  const [id] = await trx('businesses').insert({ name, currency: currency || 'USD', industry: industry || null, country: country || null, created_by: userId, onboarding_step: 'company' });
  await rbac.seedRoles(id, trx);
  const owner = await rbac.getRoleByKey(id, 'owner', trx);
  await trx('memberships').insert({ business_id: id, user_id: userId, role_id: owner.id });
  await trx('users').where({ id: userId }).update({ last_business_id: id });
  await audit.record({ businessId: id, userId }, 'business.created', { entityType: 'business', entityId: id, newValues: { name, currency } }, trx);
  return id;
}

const get = (id) => cache.remember(`biz:${id}`, () => knex('businesses').where({ id }).first(PUBLIC_COLUMNS));
const forget = (id) => cache.forgetPrefix(`biz:${id}`);

async function listForUser(userId) {
  return knex('memberships as m').join('businesses as b', 'b.id', 'm.business_id').join('roles as r', 'r.id', 'm.role_id')
    .where({ 'm.user_id': userId, 'm.status': 'active' }).orderBy('b.name').select('b.id', 'b.name', 'b.currency', 'b.color', 'r.key as role_key', 'r.name as role_name', 'r.is_system');
}

async function isMember(userId, businessId) {
  return Boolean(await knex('memberships').where({ user_id: userId, business_id: businessId, status: 'active' }).first('id'));
}

const PROFILE_FIELDS = ['name', 'legal_name', 'industry', 'country', 'currency', 'tax_number', 'phone', 'email', 'address', 'website', 'default_delivery_fee', 'invoice_prefix', 'invoice_next_number'];

async function updateProfile(ctx, data) {
  const before = await knex('businesses').where({ id: ctx.businessId }).first(PROFILE_FIELDS);
  const patch = Object.fromEntries(Object.entries(data).filter(([k, v]) => PROFILE_FIELDS.includes(k) && v !== undefined));
  const { oldValues, newValues, changed } = audit.diff(before, patch);
  if (!changed) return;
  await knex('businesses').where({ id: ctx.businessId }).update({ ...patch, updated_at: new Date() });
  await audit.record(ctx, 'business.updated', { entityType: 'business', entityId: ctx.businessId, oldValues, newValues });
  forget(ctx.businessId);
}

async function setAppearance(ctx, { color, logo, logoMime, removeLogo }) {
  const patch = { updated_at: new Date() };
  if (color !== undefined) patch.color = color || null;
  if (logo) { patch.logo = logo; patch.logo_mime = logoMime; patch.logo_version = knex.raw('logo_version + 1'); }
  if (removeLogo) { patch.logo = null; patch.logo_mime = null; patch.logo_version = knex.raw('logo_version + 1'); }
  await knex('businesses').where({ id: ctx.businessId }).update(patch);
  await audit.record(ctx, 'business.appearance_updated', { entityType: 'business', entityId: ctx.businessId, newValues: { color: color || null, logo: logo ? 'uploaded' : removeLogo ? 'removed' : undefined } });
  forget(ctx.businessId);
}

const logo = (id) => knex('businesses').where({ id }).first('logo', 'logo_mime', 'logo_version');

async function setOnboarding(businessId, step, done = false) {
  await knex('businesses').where({ id: businessId }).update({ onboarding_step: step, ...(done ? { onboarding_completed_at: new Date() } : {}) });
  forget(businessId);
}

/** Claims the next invoice number atomically (DocBook: prefix + next number). */
async function claimInvoiceNumber(businessId, trx) {
  const row = await trx('businesses').where({ id: businessId }).forUpdate().first('invoice_prefix', 'invoice_next_number');
  await trx('businesses').where({ id: businessId }).update({ invoice_next_number: row.invoice_next_number + 1 });
  forget(businessId);
  return `${row.invoice_prefix || ''}${row.invoice_next_number}`;
}

// ---------------------------------------------------------------- members & invitations
async function listMembers(businessId) {
  return knex('memberships as m').join('users as u', 'u.id', 'm.user_id').join('roles as r', 'r.id', 'm.role_id')
    .where('m.business_id', businessId)
    .select('m.id', 'm.user_id', 'm.status', 'm.role_id', 'm.partner_id', 'm.created_at', 'u.name', 'u.email', 'u.last_login_at', 'r.key as role_key', 'r.name as role_name', 'r.is_system')
    .orderBy('u.name');
}

async function ownerCount(businessId, trx = knex) {
  const [{ n }] = await trx('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.business_id': businessId, 'r.key': 'owner', 'm.status': 'active' }).count({ n: '*' });
  return Number(n);
}

async function changeMember(ctx, membershipId, { roleId, status, partnerId }) {
  const m = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.id': membershipId, 'm.business_id': ctx.businessId }).first('m.*', 'r.key as role_key');
  if (!m) throw E.notFound('Member');
  const role = roleId ? await knex('roles').where({ id: roleId, business_id: ctx.businessId }).first() : null;
  if (roleId && !role) throw E.validation({ role_id: 'Choose a valid role.' });
  const losingOwner = m.role_key === 'owner' && ((role && role.key !== 'owner') || status === 'disabled');
  if (losingOwner && (await ownerCount(ctx.businessId)) <= 1) throw E.conflict('LAST_OWNER', 'A workspace must keep at least one active owner.');
  if (m.user_id === ctx.userId && status === 'disabled') throw E.conflict('SELF_DISABLE', 'You cannot disable your own access.');
  const patch = {};
  if (role) patch.role_id = role.id;
  if (status) patch.status = status;
  if (partnerId !== undefined) patch.partner_id = partnerId || null;
  await knex('memberships').where({ id: membershipId }).update({ ...patch, updated_at: new Date() });
  await audit.record(ctx, 'member.updated', { entityType: 'member', entityId: m.user_id, oldValues: { role: m.role_key, status: m.status }, newValues: { role: role?.key, status } });
  rbac.invalidate(ctx.businessId);
}

async function removeMember(ctx, membershipId) {
  const m = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.id': membershipId, 'm.business_id': ctx.businessId }).first('m.*', 'r.key as role_key');
  if (!m) throw E.notFound('Member');
  if (m.user_id === ctx.userId) throw E.conflict('SELF_REMOVE', 'You cannot remove yourself.');
  if (m.role_key === 'owner' && (await ownerCount(ctx.businessId)) <= 1) throw E.conflict('LAST_OWNER', 'A workspace must keep at least one active owner.');
  await knex('memberships').where({ id: membershipId }).del();
  await audit.record(ctx, 'member.removed', { entityType: 'member', entityId: m.user_id });
  rbac.invalidate(ctx.businessId);
}

/**
 * Invites someone by e-mail. If they already have an account they are added directly; otherwise an
 * invitation link is created (e-mailed when SMTP is configured, and always returned so it can be shared).
 */
async function invite(ctx, { email, roleId, locale }) {
  const role = await knex('roles').where({ id: roleId, business_id: ctx.businessId }).first();
  if (!role) throw E.validation({ role_id: 'Choose a valid role.' });
  if (role.key === 'owner' && !(await require('../rbac/rbac.service').getUserPermissions(ctx.businessId, ctx.userId)).has('data.manage')) throw E.forbidden('owner'); // eslint-disable-line global-require
  const user = await knex('users').where({ email }).first();
  if (user) {
    const existing = await knex('memberships').where({ business_id: ctx.businessId, user_id: user.id }).first();
    if (existing) throw E.conflict('ALREADY_MEMBER', 'This person is already a member.');
    await knex('memberships').insert({ business_id: ctx.businessId, user_id: user.id, role_id: role.id });
    await audit.record(ctx, 'member.added', { entityType: 'member', entityId: user.id, newValues: { email, role: role.key } });
    return { added: true };
  }
  const token = randomToken(32);
  await knex('invitations').insert({ business_id: ctx.businessId, email, role_id: role.id, token_hash: sha256(token), invited_by: ctx.userId, expires_at: new Date(Date.now() + 7 * 86400_000) });
  const link = `${config.appUrl.replace(/\/+$/, '')}/invite/${token}`;
  const business = await get(ctx.businessId);
  const t = translator(locale || 'en');
  const sent = await mailer.send({
    to: email, subject: `${brand.name} — ${t('users.invite_mail_subject', { business: business.name })}`,
    html: mailer.layout({ locale, title: t('users.invite_mail_subject', { business: business.name }), body: t('users.invite_mail_body', { business: business.name }), cta: t('users.invite_mail_cta'), href: link }),
  }).catch(() => false);
  await audit.record(ctx, 'member.invited', { entityType: 'invitation', entityId: email, newValues: { email, role: role.key } });
  return { link, sent };
}

async function listInvitations(businessId) {
  return knex('invitations as i').join('roles as r', 'r.id', 'i.role_id').where('i.business_id', businessId).whereNull('i.accepted_at').whereNull('i.revoked_at')
    .where('i.expires_at', '>', new Date()).select('i.id', 'i.email', 'i.expires_at', 'r.key as role_key', 'r.name as role_name', 'r.is_system');
}

async function revokeInvitation(ctx, id) {
  const n = await knex('invitations').where({ id, business_id: ctx.businessId }).whereNull('accepted_at').update({ revoked_at: new Date() });
  if (!n) throw E.notFound('Invitation');
  await audit.record(ctx, 'member.invitation_revoked', { entityType: 'invitation', entityId: id });
}

async function findInvitation(token) {
  return knex('invitations as i').join('businesses as b', 'b.id', 'i.business_id').where('i.token_hash', sha256(String(token || '')))
    .whereNull('i.accepted_at').whereNull('i.revoked_at').where('i.expires_at', '>', new Date()).first('i.*', 'b.name as business_name');
}

async function acceptInvitation(inv, userId, trx = knex) {
  const exists = await trx('memberships').where({ business_id: inv.business_id, user_id: userId }).first();
  if (!exists) await trx('memberships').insert({ business_id: inv.business_id, user_id: userId, role_id: inv.role_id });
  await trx('invitations').where({ id: inv.id }).update({ accepted_at: new Date() });
  await trx('users').where({ id: userId }).update({ last_business_id: inv.business_id });
  await audit.record({ businessId: inv.business_id, userId }, 'member.joined', { entityType: 'member', entityId: userId }, trx);
}

/** Deletes a whole workspace. Requires typing its exact name (checked by the caller) and the data.manage permission. */
async function destroy(ctx, confirmName) {
  const b = await knex('businesses').where({ id: ctx.businessId }).first('name');
  if (!b || String(confirmName || '').trim() !== b.name) throw E.validation({ confirm_name: 'Type the workspace name exactly to confirm.' });
  await audit.record(ctx, 'business.deleted', { entityType: 'business', entityId: ctx.businessId, oldValues: { name: b.name } });
  await knex('businesses').where({ id: ctx.businessId }).del();
  forget(ctx.businessId);
}

module.exports = {
  create, get, forget, listForUser, isMember, updateProfile, setAppearance, logo, setOnboarding, claimInvoiceNumber,
  listMembers, changeMember, removeMember, invite, listInvitations, revokeInvitation, findInvitation, acceptInvitation, destroy, AppError,
};
