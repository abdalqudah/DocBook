// Notifications: an in-app inbox for every user (students and staff), plus e-mail / SMS / WhatsApp for students
// according to their preferences. In-app notifications are always kept; external channels can be switched off
// per category (and SMS / WhatsApp are opt-in, used only when the channel is connected).
const knex = require('../../db/knex');
const config = require('../../config');
const { translator } = require('../../core/i18n');

const CATEGORIES = ['applications', 'documents', 'appointments', 'visa', 'payments', 'messages', 'events'];
const STAFF_CATEGORIES = ['tasks', 'mentions', 'leads', 'messages', 'documents', 'appointments', 'partners'];
const EXTERNAL = ['email', 'sms', 'whatsapp'];
const DEFAULT = { email: true, sms: false, whatsapp: false };

function prefsOf(user) {
  const raw = user && user.notification_prefs ? (typeof user.notification_prefs === 'string' ? JSON.parse(user.notification_prefs) : user.notification_prefs) : {};
  const out = { marketing: !!raw.marketing, categories: {} };
  for (const c of CATEGORIES) out.categories[c] = { ...DEFAULT, ...((raw.categories || {})[c] || {}) };
  return out;
}

/** May we use `channel` for `category` with this student? (no account → defaults: e-mail only) */
async function allowed(studentId, category, channel) {
  if (!category) return channel === 'email';
  const s = await knex('students as s').leftJoin('users as u', 'u.id', 's.user_id').where('s.id', studentId).first('u.notification_prefs', 'u.id as uid');
  const p = prefsOf(s && s.uid ? s : null);
  return !!(p.categories[category] || DEFAULT)[channel];
}

async function toUser(userId, { category, title, body = null, href = null }) {
  if (!userId) return null;
  const tEn = translator('en'); const tAr = translator('ar');
  const en = typeof title === 'object' && title.key ? tEn(title.key, title.vars) : (title.en || String(title));
  const ar = typeof title === 'object' && title.key ? tAr(title.key, title.vars) : (title.ar || null);
  const [id] = await knex('notifications').insert({ user_id: userId, category, title_en: String(en).slice(0, 255), title_ar: ar ? String(ar).slice(0, 255) : null, body: body ? String(body).slice(0, 500) : null, href });
  return id;
}

async function toEmployee(employeeId, n, { exceptUserId = null } = {}) {
  if (!employeeId) return null;
  const e = await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('e.id', employeeId).where('u.status', 'active').first('u.id');
  if (!e || e.id === exceptUserId) return null;
  return toUser(e.id, n);
}

/**
 * Student notification: in-app (if they use the portal) + external channels per preferences.
 * `template` sends the bilingual message template by e-mail (and its SMS / WhatsApp version when opted in).
 */
async function toStudent(studentId, { category, title, href = null, template = null, vars = {}, link = null }) {
  const s = await knex('students').where({ id: studentId }).first();
  if (!s) return;
  if (s.user_id) await toUser(s.user_id, { category, title, href: href ? `${href}` : null });
  if (!template) return;
  const notify = require('../comms/notify'); // eslint-disable-line global-require
  await notify.sendTemplate(template, { email: s.email, name: [s.first_name, s.last_name].filter(Boolean).join(' '), locale: s.preferred_locale, studentId: s.id }, vars, { link: link || (href ? `${config.appUrl}${href}` : null) });
  for (const ch of ['sms', 'whatsapp']) {
    if (!(await allowed(s.id, category, ch))) continue; // eslint-disable-line no-await-in-loop, no-continue
    const to = ch === 'whatsapp' ? s.whatsapp || s.phone : s.phone;
    if (!to) continue; // eslint-disable-line no-continue
    const templates = require('../comms/templates'); // eslint-disable-line global-require
    const msg = await templates.render(template, s.preferred_locale === 'ar' ? 'ar' : 'en', { student_name: s.first_name, ...vars }, ch); // eslint-disable-line no-await-in-loop
    if (msg) await require('../comms/comms.service').send({ channel: ch, to, body: `${msg.body}${link || href ? `\n${link || `${config.appUrl}${href}`}` : ''}`, studentId: s.id, templateKey: template, automated: true }); // eslint-disable-line global-require, no-await-in-loop
  }
}

async function unread(userId) { return Number((await knex('notifications').where({ user_id: userId }).whereNull('read_at').count({ n: '*' }))[0].n); }
async function list(userId, { page = 1 } = {}) { return knex('notifications').where({ user_id: userId }).orderBy('id', 'desc').limit(30).offset((page - 1) * 30); }
async function markRead(userId, id = null) {
  const q = knex('notifications').where({ user_id: userId }).whereNull('read_at');
  if (id) q.where({ id });
  await q.update({ read_at: new Date() });
}

module.exports = { CATEGORIES, STAFF_CATEGORIES, EXTERNAL, prefsOf, allowed, toUser, toEmployee, toStudent, unread, list, markRead };
