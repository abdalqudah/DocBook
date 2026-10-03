// Platform notifications (admin and reps). Writing one never breaks the action that caused it.
const knex = require('../../db/knex');

const SEVERITIES = ['info', 'success', 'warning'];
const parse = (v) => { try { return v ? JSON.parse(v) : {}; } catch { return {}; } };

async function push(audience, vendorId, kind, params = {}, { link = null, severity = 'info', dedupeKey = null } = {}, trx = knex) {
  try {
    if (dedupeKey) {
      const q = trx('platform_notifications').where({ audience, dedupe_key: dedupeKey });
      if (vendorId) q.where('vendor_id', vendorId); else q.whereNull('vendor_id');
      if (await q.first('id')) return null;
    }
    const [id] = await trx('platform_notifications').insert({
      audience, vendor_id: vendorId || null, kind, params: JSON.stringify(params || {}), link: link ? String(link).slice(0, 300) : null,
      severity: SEVERITIES.includes(severity) ? severity : 'info', dedupe_key: dedupeKey ? String(dedupeKey).slice(0, 120) : null,
    });
    return id;
  } catch (e) {
    console.error('[notify] failed:', e.message); // eslint-disable-line no-console
    return null;
  }
}
const admin = (kind, params, opts, trx) => push('admin', null, kind, params, opts, trx);
const vendor = (vendorId, kind, params, opts, trx) => (vendorId ? push('vendor', Number(vendorId), kind, params, opts, trx) : null);

const scope = (q, audience, vendorId) => { q.where('audience', audience); if (audience === 'vendor') q.where('vendor_id', vendorId); else q.whereNull('vendor_id'); return q; };
async function list(audience, vendorId, { limit = 50 } = {}) {
  const rows = await scope(knex('platform_notifications'), audience, vendorId).orderBy('id', 'desc').limit(limit);
  rows.forEach((r) => { r.params = parse(r.params); });
  return rows;
}
async function unread(audience, vendorId) {
  const [{ n }] = await scope(knex('platform_notifications'), audience, vendorId).whereNull('read_at').count({ n: '*' });
  return Number(n);
}
const markAllRead = (audience, vendorId) => scope(knex('platform_notifications'), audience, vendorId).whereNull('read_at').update({ read_at: new Date() });

/** Title and body in the reader's language: pnotify.<kind>.title / .body with the stored params. */
function text(t, row) {
  const p = { ...row.params };
  return { title: t(`pnotify.${row.kind}.title`, p), body: t(`pnotify.${row.kind}.body`, p) === `pnotify.${row.kind}.body` ? '' : t(`pnotify.${row.kind}.body`, p) };
}

module.exports = { push, admin, vendor, list, unread, markAllRead, text };
