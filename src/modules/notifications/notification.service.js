// In-app notifications. A notification targets one user, or everyone in the workspace holding `permission`.
// `dedupe_key` makes alert generation idempotent (e.g. one "budget exceeded" per budget per month).
const knex = require('../../db/knex');

async function notify(businessId, { userId = null, permission = null, type, title, body = null, link = null, severity = 'info', dedupeKey = null }, trx = knex) {
  // Sent from outside that clinic's own database (platform admin, another practice of a centre…): written there.
  const tenant = require('../../db/tenant'); // eslint-disable-line global-require
  if (!(await tenant.isHere(businessId))) return tenant.runFor(businessId, () => notify(businessId, { userId, permission, type, title, body, link, severity, dedupeKey }));
  if (dedupeKey) {
    const exists = await trx('notifications').where({ business_id: businessId, dedupe_key: dedupeKey }).first('id');
    if (exists) return exists.id;
  }
  const [id] = await trx('notifications').insert({ business_id: businessId, user_id: userId, permission, type, title, body, link, severity, dedupe_key: dedupeKey });
  // E-mail copy when the clinic enabled it for this event (Settings → Notifications). Background only, never throws.
  try {
    require('../teamops/notify-mail').schedule(businessId, { id, user_id: userId, permission, type, title, body, link, severity }, trx); // eslint-disable-line global-require
  } catch (err) { console.error('[notifications] e-mail hook:', err.message); } // eslint-disable-line no-console
  return id;
}

function visible(ctx) {
  const perms = [...ctx.permissions];
  return knex('notifications as n').where('n.business_id', ctx.businessId)
    .andWhere((q) => q.where('n.user_id', ctx.userId).orWhere((q2) => q2.whereNull('n.user_id').andWhere((q3) => q3.whereNull('n.permission').orWhereIn('n.permission', perms.length ? perms : ['-']))));
}

async function list(ctx, { limit = 50, unreadOnly = false, type = null } = {}) {
  const q = visible(ctx).leftJoin('notification_reads as r', function j() { this.on('r.notification_id', 'n.id').andOn('r.user_id', knex.raw('?', [ctx.userId])); })
    .select('n.*', 'r.read_at').orderBy('n.id', 'desc').limit(limit);
  if (unreadOnly) q.whereNull('r.read_at');
  if (type) q.where('n.type', type);
  return q;
}

async function unreadCount(ctx) {
  const [{ c }] = await visible(ctx).leftJoin('notification_reads as r', function j() { this.on('r.notification_id', 'n.id').andOn('r.user_id', knex.raw('?', [ctx.userId])); })
    .whereNull('r.read_at').count({ c: '*' });
  return Number(c);
}

async function markRead(ctx, id) {
  const ids = id ? [Number(id)] : (await list(ctx, { limit: 500, unreadOnly: true })).map((n) => n.id);
  for (const nid of ids) {
    await knex('notification_reads').insert({ notification_id: nid, user_id: ctx.userId }).onConflict(['notification_id', 'user_id']).ignore(); // eslint-disable-line no-await-in-loop
  }
}

module.exports = { notify, list, unreadCount, markRead };
