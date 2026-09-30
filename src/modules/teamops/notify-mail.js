// E-mail copies of in-app notifications, per clinic and event (Settings → Notifications).
// notification.service.notify() calls `schedule()` after it stores a notification. When SMTP is configured and the
// clinic enabled e-mail for that event, the recipients are resolved and mailed in the background — the request that
// created the notification never waits, and failures are only logged.
// Recipient rules (resolveRecipients):
//  • candidates = active members whose role is ticked, plus the members picked by name (each needs an e-mail);
//  • a notification aimed at one person (userId) is e-mailed to that person only, and only if they are a candidate —
//    it is never sent to the extra addresses (ticket replies, a doctor's own rep visit…);
//  • a notification aimed at a permission is e-mailed only to candidates who hold that permission (a receptionist
//    ticked for "payments" still gets nothing if their role can't see payments) — plus the extra addresses;
//  • addresses are de-duplicated (case-insensitive).
const knex = require('../../db/knex');
const mailer = require('../../core/mailer');
const config = require('../../config');
const { translator } = require('../../core/i18n');
const rbac = require('../rbac/rbac.service');

/** Event keys shown in settings → the notification types they cover. */
const EVENTS = [
  { key: 'booking_online', types: ['appointment.booked_online'], icon: 'calendar-plus' },
  { key: 'booking_cancelled', types: ['appointment.patient_cancelled'], icon: 'calendar-x' },
  { key: 'payment_received', types: ['payment.received'], icon: 'credit-card' },
  { key: 'invoice_paid', types: ['invoice.paid'], icon: 'receipt' },
  { key: 'low_stock', types: ['supplies.low_stock'], icon: 'package' },
  { key: 'review_new', types: ['review.new'], icon: 'star' },
  { key: 'rep_visit_request', types: ['rep_visit.requested'], icon: 'briefcase-business' },
  { key: 'po_acknowledged', types: ['purchasing.acknowledged'], icon: 'clipboard-check' },
  { key: 'budget_alert', types: ['budget_alert'], prefix: 'budget', icon: 'wallet' },
  { key: 'ticket_reply', types: ['ticket.reply', 'ticket.new', 'ticket.assigned', 'ticket.status'], icon: 'message-square' },
];
const EVENT_KEYS = EVENTS.map((e) => e.key);

function eventFor(type) {
  const s = String(type || '');
  const hit = EVENTS.find((e) => e.types.includes(s) || (e.prefix && (s === e.prefix || s.startsWith(`${e.prefix}.`) || s.startsWith(`${e.prefix}_`))));
  return hit ? hit.key : null;
}

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const parseJson = (v, fb) => { if (v == null) return fb; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return fb; } };

function normaliseRule(r) {
  if (!r) return null;
  return {
    event_key: r.event_key, enabled: Boolean(r.enabled),
    roles: parseJson(r.roles, []).map(String), user_ids: parseJson(r.user_ids, []).map(Number).filter(Boolean),
    emails: parseJson(r.emails, []).map((e) => String(e).trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)),
  };
}

async function rules(businessId) {
  const rows = await knex('notification_email_rules').where({ business_id: businessId });
  const by = Object.fromEntries(rows.map((r) => [r.event_key, normaliseRule(r)]));
  return Object.fromEntries(EVENT_KEYS.map((k) => [k, by[k] || { event_key: k, enabled: false, roles: [], user_ids: [], emails: [] }]));
}

/** Splits a free-text list of addresses; returns { emails, invalid }. */
function parseEmails(text) {
  const parts = String(text || '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const emails = [...new Set(parts.filter((p) => EMAIL_RE.test(p) && p.length <= 190))];
  return { emails, invalid: parts.filter((p) => !EMAIL_RE.test(p)) };
}

/**
 * Saves every event's rule from the settings form: enabled_<key>, roles_<key>[], users_<key>[], emails_<key>.
 * Unknown roles / members are dropped. Returns { invalid: { <key>: [bad addresses] } } (nothing saved then).
 */
async function saveRules(ctx, body, { roleKeys, memberIds }) {
  const arr = (x) => (Array.isArray(x) ? x : x === undefined || x === null || x === '' ? [] : [x]);
  const out = []; const invalid = {};
  for (const k of EVENT_KEYS) {
    const { emails, invalid: bad } = parseEmails(body[`emails_${k}`]);
    if (bad.length) invalid[k] = bad;
    if (emails.length > 10) invalid[k] = (invalid[k] || []).concat(emails.slice(10));
    out.push({
      event_key: k, enabled: ['1', 'on', 'true'].includes(String(body[`enabled_${k}`] || '')),
      roles: [...new Set(arr(body[`roles_${k}`]).map(String).filter((r) => roleKeys.includes(r)))],
      user_ids: [...new Set(arr(body[`users_${k}`]).map(Number).filter((id) => memberIds.includes(id)))],
      emails: emails.slice(0, 10),
    });
  }
  if (Object.keys(invalid).length) return { invalid };
  await knex.transaction(async (trx) => {
    for (const r of out) {
      const row = { business_id: ctx.businessId, event_key: r.event_key, enabled: r.enabled, roles: JSON.stringify(r.roles), user_ids: JSON.stringify(r.user_ids), emails: JSON.stringify(r.emails), updated_by: ctx.userId };
      await trx('notification_email_rules').insert(row).onConflict(['business_id', 'event_key']).merge({ ...row, updated_at: new Date() }); // eslint-disable-line no-await-in-loop
    }
    await require('../../core/audit').record(ctx, 'notifications.email_rules', { entityType: 'business', entityId: ctx.businessId, newValues: { enabled: out.filter((r) => r.enabled).map((r) => r.event_key).join(', ') || '—' } }, trx); // eslint-disable-line global-require
  });
  return { invalid: null, rules: out };
}

/**
 * Pure: who gets the e-mail. `members` = [{ userId, email, roleKey, permissions:Set, locale }] (active members only).
 * `n` = the notification ({ user_id, permission }). Returns [{ email, locale, userId|null }].
 */
function resolveRecipients(rule, members, n) {
  if (!rule || !rule.enabled) return [];
  const roles = new Set(rule.roles || []);
  const users = new Set((rule.user_ids || []).map(Number));
  let list = members.filter((m) => m.email && (roles.has(m.roleKey) || users.has(Number(m.userId))));
  const targeted = n.user_id != null && n.user_id !== '';
  if (targeted) list = list.filter((m) => Number(m.userId) === Number(n.user_id));
  else if (n.permission) list = list.filter((m) => m.permissions && m.permissions.has(n.permission));
  const out = []; const seen = new Set();
  const add = (email, locale, userId) => {
    const e = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(e) || seen.has(e)) return;
    seen.add(e); out.push({ email: e, locale: locale === 'en' ? 'en' : 'ar', userId });
  };
  list.forEach((m) => add(m.email, m.locale, m.userId));
  if (!targeted) (rule.emails || []).forEach((e) => add(e, null, null));
  return out;
}

async function activeMembers(businessId) {
  const rows = await knex('memberships as m').join('users as u', 'u.id', 'm.user_id').join('roles as r', 'r.id', 'm.role_id')
    .where({ 'm.business_id': businessId, 'm.status': 'active', 'u.status': 'active' })
    .select('u.id as userId', 'u.email', 'u.locale', 'r.key as roleKey');
  for (const m of rows) m.permissions = await rbac.getUserPermissions(businessId, m.userId); // eslint-disable-line no-await-in-loop
  return rows;
}

const appBase = () => String(config.appUrl || '').replace(/\/+$/, '');

/** Builds and sends the e-mails for one stored notification. `deps.mail` is injectable for tests. */
async function deliver(businessId, n, deps = {}) {
  const mail = deps.mail || mailer;
  if (!mail.configured()) return [];
  const key = eventFor(n.type);
  if (!key) return [];
  const rule = normaliseRule(await knex('notification_email_rules').where({ business_id: businessId, event_key: key }).first());
  if (!rule || !rule.enabled) return [];
  const recipients = resolveRecipients(rule, deps.members || await activeMembers(businessId), n);
  if (!recipients.length) return [];
  const clinic = await knex('businesses').where({ id: businessId }).first('name', 'name_en', 'email');
  const sent = [];
  for (const r of recipients) {
    const t = translator(r.locale);
    const clinicName = (r.locale === 'en' && clinic.name_en) || clinic.name;
    const subject = `${clinicName} · ${n.title}`.slice(0, 200);
    const html = mail.layout({
      locale: r.locale, title: n.title, body: [n.body && n.body !== 'online' && n.body !== 'telehealth' ? n.body : null, t(`notify_settings.mail_foot.${key}`)].filter(Boolean).join(' — '),
      cta: n.link ? t('notify_settings.mail_cta') : null, href: n.link ? `${appBase()}${n.link}` : null,
    });
    try {
      await mail.send({ to: r.email, subject, html, replyTo: clinic.email || undefined }); // eslint-disable-line no-await-in-loop
      sent.push(r.email);
    } catch (err) {
      console.error(`[teamops] notification e-mail (${key}) failed:`, err.message); // eslint-disable-line no-console
    }
  }
  return sent;
}

/**
 * Called by notification.service after it inserted a notification. Waits for the surrounding transaction (if any)
 * to commit, then delivers in the background. Never throws.
 */
function schedule(businessId, n, trx) {
  if (!mailer.configured()) return;
  const run = () => setImmediate(() => {
    deliver(businessId, n).catch((err) => console.error('[teamops] notification e-mail:', err.message)); // eslint-disable-line no-console
  });
  if (trx && trx.isTransaction && trx.executionPromise) trx.executionPromise.then(run, () => {});
  else run();
}

module.exports = { EVENTS, EVENT_KEYS, eventFor, rules, saveRules, parseEmails, resolveRecipients, activeMembers, deliver, schedule };
