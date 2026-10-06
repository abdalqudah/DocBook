// Student accounts. Two ways in:
//  1. Self sign-up at /register: the account stays unconfirmed until the person opens the link e-mailed to them.
//     Only then is it linked to an existing student / lead with that address (so nobody can read someone else's
//     file by registering with their e-mail), or a new lead + student is created in the CRM.
//  2. A counsellor invites an existing student: the invitation link sets the password (and confirms the address).
const knex = require('../../db/knex');
const config = require('../../config');
const audit = require('../../core/audit');
const events = require('../../core/events');
const { E } = require('../../core/errors');
const { randomToken, sha256 } = require('../../core/tokens');
const settings = require('../settings/settings.service');
const people = require('../crm/people');
const email = require('../comms/email');
const notify = require('../comms/notify');
const { translator } = require('../../core/i18n');

const SYSTEM = { employee: { dataScope: 'all', id: null }, permissions: new Set() };
const VERIFY_HOURS = 48;
const INVITE_DAYS = 7;

/** The student record of the signed-in portal user (or null). */
async function studentOf(req) {
  if (!req.user || req.user.kind !== 'student') return null;
  return knex('students').where({ user_id: req.user.id }).whereNull('merged_into_id').first();
}

async function sendVerification(user, locale) {
  const token = randomToken(32);
  await knex('email_verifications').insert({ user_id: user.id, token_hash: sha256(token), expires_at: new Date(Date.now() + VERIFY_HOURS * 3600_000) });
  const t = translator(locale);
  const link = `${config.appUrl}/verify/${token}`;
  const html = await email.layout({ locale, title: t('portal.verify_mail_subject'), body: t('portal.verify_mail_body', { hours: VERIFY_HOURS }), cta: t('portal.verify_mail_cta'), href: link });
  return email.send({ to: user.email, subject: t('portal.verify_mail_subject'), html, text: `${t('portal.verify_mail_body', { hours: VERIFY_HOURS })}\n${link}` });
}

/**
 * Self sign-up. Always answers the same way (no account enumeration): if the address already has an account,
 * that person gets a "you already have an account" e-mail instead.
 */
async function register(ctx, { firstName, lastName, address, password, locale, consentMarketing }) {
  const auth = require('../auth/auth.service'); // eslint-disable-line global-require
  const mail = String(address).trim().toLowerCase();
  const existing = await knex('users').where({ kind: 'student', email: mail }).first();
  if (existing) {
    const t = translator(locale);
    const html = await email.layout({ locale, title: t('portal.exists_mail_subject'), body: t('portal.exists_mail_body'), cta: t('auth.sign_in'), href: `${config.appUrl}/login` });
    const r = await email.send({ to: mail, subject: t('portal.exists_mail_subject'), html });
    return { sent: r.sent, reason: r.reason || null };
  }
  const [id] = await knex('users').insert({ kind: 'student', email: mail, name: [firstName, lastName].filter(Boolean).join(' ').slice(0, 160), password_hash: await auth.hashPassword(password), locale: locale === 'ar' ? 'ar' : 'en', status: 'invited', notification_prefs: JSON.stringify({ marketing: !!consentMarketing }) });
  const user = await knex('users').where({ id }).first();
  await audit.record({ ...ctx, userId: id }, 'portal.registered', { entityType: 'user', entityId: id });
  const r = await sendVerification(user, user.locale);
  return { sent: r.sent, reason: r.reason || null };
}

/** Confirms the address and links (or creates) the CRM records. Returns the user. */
async function verify(ctx, token, { visitorId = null } = {}) {
  if (!/^[A-Za-z0-9_-]{20,60}$/.test(String(token || ''))) return null;
  const row = await knex('email_verifications').where({ token_hash: sha256(token) }).whereNull('used_at').where('expires_at', '>', new Date()).first();
  if (!row) return null;
  await knex('email_verifications').where({ id: row.id }).update({ used_at: new Date() });
  await knex('users').where({ id: row.user_id }).update({ email_verified_at: new Date(), status: 'active' });
  const user = await knex('users').where({ id: row.user_id }).first();
  await linkStudent(ctx, user, { visitorId }); // eslint-disable-line no-use-before-define
  await audit.record({ ...ctx, userId: user.id }, 'portal.verified', { entityType: 'user', entityId: user.id });
  return user;
}

const prefsOf = (u) => (u && u.notification_prefs ? (typeof u.notification_prefs === 'string' ? JSON.parse(u.notification_prefs) : u.notification_prefs) : {});

/** After the address is confirmed: existing student → link; lead → convert; nobody → new lead + student. */
async function linkStudent(ctx, user, { visitorId = null } = {}) {
  const already = await knex('students').where({ user_id: user.id }).first();
  if (already) return already;
  let student = await knex('students').where({ email: user.email }).whereNull('user_id').whereNull('merged_into_id').orderBy('id').first();
  if (!student) {
    const leads = require('../crm/leads.service'); // eslint-disable-line global-require
    const students = require('../crm/students.service'); // eslint-disable-line global-require
    let lead = await knex('leads').where({ email: user.email }).whereNot('status', 'merged').orderBy('id', 'desc').first();
    const p = prefsOf(user);
    if (!lead) {
      const nm = people.splitName(user.name);
      ({ lead } = await leads.capture({ userId: user.id, ip: ctx.ip }, { first_name: nm.first_name || user.email, last_name: nm.last_name, email: user.email, preferred_locale: user.locale }, { source: 'website', sourceDetail: 'portal sign-up', visitorId, consent: { contact: true, marketing: !!p.marketing } }));
    }
    student = lead.student_id ? await knex('students').where({ id: lead.student_id }).first() : await students.convertLead({ userId: user.id, ip: ctx.ip }, SYSTEM, lead.id);
    if (student.user_id && student.user_id !== user.id) throw E.conflict('ALREADY_LINKED', 'This record already has a portal account.');
  }
  await knex('students').where({ id: student.id }).update({ user_id: user.id, updated_at: new Date() });
  await require('../crm/activity.service').log({ studentId: student.id }, { type: 'system', title: 'portal_joined', actorId: user.id }); // eslint-disable-line global-require
  await events.emit('portal.joined', { userId: user.id, studentId: student.id });
  return knex('students').where({ id: student.id }).first();
}

/** Called after every student sign-in: the visitor's saved programs move to the student. */
async function afterSignIn(req, user) {
  const s = await knex('students').where({ user_id: user.id }).first('id');
  if (s && req.session.shortlistKey) {
    await require('../catalog/shortlist.service').adopt(req.session.shortlistKey, s.id); // eslint-disable-line global-require
    delete req.session.shortlistKey;
  }
}

/** A counsellor invites a student to the portal. Returns { link, sent }. */
async function invite(ctx, staff, studentId, inviterName) {
  const students = require('../crm/students.service'); // eslint-disable-line global-require
  const s = await students.get(staff, studentId);
  if (!s.email) throw E.validation({ email: 'Add the student’s e-mail address first.' });
  let user = s.user_id ? await knex('users').where({ id: s.user_id }).first() : await knex('users').where({ kind: 'student', email: s.email.toLowerCase() }).first();
  if (user && user.email_verified_at && user.password_hash && s.user_id === user.id) throw E.conflict('ALREADY_LINKED', 'This student already uses the portal.');
  if (user) {
    const other = await knex('students').where({ user_id: user.id }).whereNot({ id: s.id }).first('id');
    if (other) throw E.conflict('ALREADY_LINKED', 'This e-mail address belongs to another student’s portal account.');
  } else {
    const [uid] = await knex('users').insert({ kind: 'student', email: s.email.toLowerCase(), name: people.fullName(s), locale: s.preferred_locale === 'ar' ? 'ar' : 'en', status: 'invited' });
    user = await knex('users').where({ id: uid }).first();
  }
  await knex('students').where({ id: s.id }).update({ user_id: user.id });
  const token = randomToken(32);
  await knex('password_resets').insert({ user_id: user.id, token_hash: sha256(token), expires_at: new Date(Date.now() + INVITE_DAYS * 86400_000) });
  const link = `${config.appUrl}/reset/${token}`;
  const branding = await settings.get('branding');
  const r = await notify.sendTemplate('portal_invite', { email: s.email, name: people.fullName(s), locale: s.preferred_locale, studentId: s.id }, { counsellor_name: inviterName, company_name: branding.legal_name }, { link });
  await audit.record(ctx, 'portal.invited', { entityType: 'student', entityId: s.id, newValues: { user_id: user.id, sent: r.sent } });
  return { link, sent: r.sent };
}

module.exports = { studentOf, register, verify, linkStudent, afterSignIn, invite, sendVerification, prefsOf };
