// Medical centres. A centre links several doctors' practices; each practice remains its own clinic account (team,
// patients, appointments, money, website, e-mail and domain stay separate — nothing is shared through the database
// except what is listed here). Shared:
//   • the reception desk (/app/center/desk): today's visits of every practice; reception checks patients in and
//     sends them in to their doctor, whichever practice they belong to;
//   • the waiting-room screen (a queue screen with scope "center");
//   • the cash screen, only for the practices that turn on "share my payments" (each invoice still belongs to, is
//     numbered by and is reported in the patient's own practice).
// Acting for another practice always goes through actCtx(): the practice must be an active member of the SAME centre
// as the signed-in practice (checked here, never taken from the form), with only the permissions the action needs;
// the action is audited in that practice with the acting user and the practice they acted from.
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { clinicNow } = require('../clinic/scheduling');

const INVITE_DAYS = 14;
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const cleanName = (v) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 160);

const get = (id) => (id ? knex('centers').where({ id }).first() : null);
async function ofBusiness(businessId) {
  const b = await knex('businesses').where({ id: businessId }).first('center_id');
  return b && b.center_id ? get(b.center_id) : null;
}
/** The centre's active practices (with the doctors' names for the pages). */
async function members(centerId) {
  // The doctors' practices (the centre's administration account is not one of them).
  return knex('businesses').where({ center_id: centerId, status: 'active' }).whereNot('kind', 'center_admin').orderBy('center_joined_at')
    .select('id', 'name', 'name_en', 'slug', 'specialty', 'timezone', 'currency', 'center_share_cash', 'center_joined_at', 'logo_mime', 'logo_version');
}
const isFounder = (center, businessId) => Boolean(center && center.owner_business_id === businessId);

/** Creates a centre with this practice as its first member (and founder). */
async function create(ctx, { name, name_en: nameEn } = {}, trx = knex) {
  const n = cleanName(name);
  if (n.length < 2) throw E.validation({ center_name: 'Required.' });
  const b = await trx('businesses').where({ id: ctx.businessId }).first('center_id');
  if (b && b.center_id) throw new AppError('CENTER_ALREADY', 'This clinic is already in a medical centre.', 409);
  const [id] = await trx('centers').insert({ name: n, name_en: cleanName(nameEn) || null, owner_user_id: ctx.userId || null, owner_business_id: ctx.businessId });
  await trx('businesses').where({ id: ctx.businessId }).update({ center_id: id, center_joined_at: new Date() });
  await audit.record(ctx, 'center.created', { entityType: 'center', entityId: id, newValues: { name: n } }, trx);
  forgetBiz(ctx.businessId);
  return id;
}

async function rename(ctx, { name, name_en: nameEn }) {
  const c = await ofBusiness(ctx.businessId);
  if (!c || !isFounder(c, ctx.businessId)) throw E.forbidden('center.manage');
  const n = cleanName(name);
  if (n.length < 2) throw E.validation({ center_name: 'Required.' });
  await knex('centers').where({ id: c.id }).update({ name: n, name_en: cleanName(nameEn) || null, updated_at: new Date() });
  await audit.record(ctx, 'center.renamed', { entityType: 'center', entityId: c.id, oldValues: { name: c.name }, newValues: { name: n } });
}

// ---------------------------------------------------------------- invitations
/** Invites a doctor by e-mail (founder practice only). Returns the link (sent by e-mail when e-mail works). */
async function invite(ctx, email, { base, locale = 'ar', t } = {}) {
  const c = await ofBusiness(ctx.businessId);
  if (!c || !isFounder(c, ctx.businessId)) throw E.forbidden('center.manage');
  const to = String(email || '').trim().toLowerCase();
  if (!/^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(to) || to.length > 190) throw E.validation({ email: 'Enter a valid email address.' });
  const token = crypto.randomBytes(24).toString('base64url');
  await knex('center_invites').insert({ center_id: c.id, email: to, token_hash: hash(token), invited_by: ctx.userId || null, expires_at: new Date(Date.now() + INVITE_DAYS * 86_400_000) });
  await audit.record(ctx, 'center.invited', { entityType: 'center', entityId: c.id, newValues: { email: to } });
  const link = `${String(base || '').replace(/\/+$/, '')}/workspaces/center/${token}`;
  try {
    const mailer = require('../../core/mailer'); // eslint-disable-line global-require
    if (t && mailer.configured()) {
      const vars = { center: (locale === 'en' && c.name_en) || c.name };
      await mailer.send({ to, subject: t('center.mail.subject', vars), html: mailer.layout({ locale, title: t('center.mail.subject', vars), body: t('center.mail.body', vars), cta: t('center.mail.cta'), href: link, base }) });
    }
  } catch { /* the link is also shown to copy */ }
  return { link, email: to };
}
const pendingInvites = (centerId) => knex('center_invites').where({ center_id: centerId }).whereNull('accepted_at').where('expires_at', '>', new Date()).orderBy('created_at', 'desc');
async function revokeInvite(ctx, id) {
  const c = await ofBusiness(ctx.businessId);
  if (!c || !isFounder(c, ctx.businessId)) throw E.forbidden('center.manage');
  await knex('center_invites').where({ id: Number(id) || 0, center_id: c.id }).whereNull('accepted_at').del();
  await audit.record(ctx, 'center.invite_revoked', { entityType: 'center', entityId: c.id, newValues: { invite: Number(id) } });
}
async function inviteByToken(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
  const inv = await knex('center_invites').where({ token_hash: hash(token) }).whereNull('accepted_at').where('expires_at', '>', new Date()).first();
  if (!inv) return null;
  const center = await get(inv.center_id);
  return center ? { ...inv, center } : null;
}

/** Joins a practice the user owns (not in a centre yet) to the invitation's centre. */
async function accept(userId, token, businessId, trx = knex) {
  const inv = await inviteByToken(token);
  if (!inv) throw new AppError('CENTER_INVITE_INVALID', 'This invitation is no longer valid.', 410);
  const own = await trx('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.user_id': userId, 'm.business_id': businessId, 'r.key': 'owner' }).first('m.id');
  if (!own) throw E.forbidden('clinic.owner');
  const b = await trx('businesses').where({ id: businessId }).first('center_id', 'currency');
  if (b.center_id) throw new AppError('CENTER_ALREADY', 'This clinic is already in a medical centre.', 409);
  await trx('businesses').where({ id: businessId }).update({ center_id: inv.center_id, center_joined_at: new Date() });
  await trx('center_invites').where({ id: inv.id }).update({ accepted_at: new Date(), accepted_business_id: businessId });
  await audit.record({ businessId, userId }, 'center.joined', { entityType: 'center', entityId: inv.center_id, newValues: { center: inv.center.name } }, trx);
  forgetBiz(businessId);
  return inv.center_id;
}

/** A practice leaves its centre (not the founder's); the founder can also remove a practice. */
async function leave(ctx, businessId = ctx.businessId) {
  const c = await ofBusiness(ctx.businessId);
  if (!c) throw E.notFound('Centre');
  const self = Number(businessId) === ctx.businessId;
  if (!self && !isFounder(c, ctx.businessId)) throw E.forbidden('center.manage');
  if (Number(businessId) === c.owner_business_id) throw new AppError('CENTER_FOUNDER', 'The founding practice stays in the centre.', 409);
  const target = await knex('businesses').where({ id: Number(businessId) || 0, center_id: c.id }).first('id');
  if (!target) throw E.notFound('Practice');
  await knex('businesses').where({ id: target.id }).update({ center_id: null, center_share_cash: false, center_joined_at: null });
  await audit.record({ ...ctx, businessId: target.id }, 'center.left', { entityType: 'center', entityId: c.id, newValues: { by: ctx.businessId } });
  if (!self) await audit.record(ctx, 'center.member_removed', { entityType: 'center', entityId: c.id, newValues: { practice: target.id } });
  forgetBiz(target.id);
}

/** This practice's choice: its visits on the centre's shared cash screen, or only on its own. */
async function setShareCash(ctx, on) {
  const c = await ofBusiness(ctx.businessId);
  if (!c) throw E.notFound('Centre');
  await knex('businesses').where({ id: ctx.businessId }).update({ center_share_cash: Boolean(on) });
  await audit.record(ctx, on ? 'center.cash_shared' : 'center.cash_private', { entityType: 'center', entityId: c.id });
  forgetBiz(ctx.businessId);
}

function forgetBiz(id) { try { require('../businesses/business.service').forget(id); } catch { /* cache only */ } } // eslint-disable-line global-require

// ---------------------------------------------------------------- acting for another practice of the centre
/**
 * ctx for practice `bid`, from a member of a practice of the same centre. `need`: the permission the user must hold
 * in their own practice; the ctx carries only `grant`. Throws 404 for anything outside the centre.
 */
async function actCtx(ctx, bid, { need, grant = [] } = {}) {
  if (need && !ctx.permissions.has(need)) throw E.forbidden(need);
  const id = Number(bid) || 0;
  if (id === ctx.businessId) return ctx;
  const me = await knex('businesses').where({ id: ctx.businessId }).first('center_id');
  const b = me && me.center_id ? await knex('businesses').where({ id, center_id: me.center_id, status: 'active' }).first('id', 'currency', 'timezone', 'center_share_cash') : null;
  if (!b) throw E.notFound('Practice');
  return {
    ...ctx, businessId: b.id, currency: b.currency, timezone: b.timezone, today: clinicNow(b.timezone).date, permissions: new Set(grant),
    ownDoctorId: null, doctorId: null, roleKey: 'center_desk', viaPractice: ctx.businessId, shareCash: Boolean(b.center_share_cash),
  };
}

/** The practice an appointment belongs to, when it is one of the signed-in practice's centre (else null). */
async function practiceOfAppointment(ctx, apptId) {
  const a = await knex('appointments').where({ id: Number(apptId) || 0 }).first('business_id');
  if (!a) return null;
  if (a.business_id === ctx.businessId) return a.business_id;
  const me = await knex('businesses').where({ id: ctx.businessId }).first('center_id');
  const b = me && me.center_id ? await knex('businesses').where({ id: a.business_id, center_id: me.center_id, status: 'active' }).first('id') : null;
  return b ? b.id : null;
}

/** Practices whose visits appear on the shared cash screen (those sharing, plus the signed-in one). */
async function cashPractices(ctx) {
  const me = await knex('businesses').where({ id: ctx.businessId }).first('center_id');
  if (!me || !me.center_id) return [ctx.businessId];
  const rows = await knex('businesses').where({ center_id: me.center_id, status: 'active' }).where((q) => q.where('center_share_cash', true).orWhere('id', ctx.businessId)).pluck('id');
  return rows;
}

module.exports = { INVITE_DAYS, get, ofBusiness, members, isFounder, create, rename, invite, pendingInvites, revokeInvite, inviteByToken, accept, leave, setShareCash, actCtx, practiceOfAppointment, cashPractices };
