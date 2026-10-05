// Audit log: who did what to which record, with the changed values (secrets redacted) and the request's IP.
const knex = require('../db/knex');

const SENSITIVE = /password|token|secret|api_key|_enc$|passport_number/i;

function scrub(values) {
  if (!values || typeof values !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(values)) out[k] = SENSITIVE.test(k) && v ? '[redacted]' : (v instanceof Date ? v.toISOString() : v);
  return JSON.stringify(out).slice(0, 60000);
}

const norm = (v) => {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v))) return String(Number(v));
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/** Only the fields that changed between `before` and `after`. */
function diff(before, after) {
  const oldValues = {};
  const newValues = {};
  for (const key of Object.keys(after || {})) {
    if (norm(before?.[key]) !== norm(after[key])) {
      oldValues[key] = before?.[key] ?? null;
      newValues[key] = after[key] ?? null;
    }
  }
  return { oldValues, newValues, changed: Object.keys(newValues).length > 0 };
}

/** ctx: { userId, ip, userAgent } — req.ctx on every request. */
async function record(ctx, action, { entityType, entityId, oldValues, newValues } = {}, trx = knex) {
  await trx('audit_logs').insert({
    user_id: ctx?.userId ?? null,
    action,
    entity_type: entityType ?? null,
    entity_id: entityId != null ? String(entityId) : null,
    old_values: scrub(oldValues),
    new_values: scrub(newValues),
    ip: ctx?.ip ? String(ctx.ip).slice(0, 64) : null,
    user_agent: ctx?.userAgent ? String(ctx.userAgent).slice(0, 255) : null,
  });
}

module.exports = { record, diff, scrub };
