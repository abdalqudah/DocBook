const knex = require('../db/knex');

const SENSITIVE = new Set(['password', 'password_hash', 'token', 'token_hash', 'api_key', 'api_key_enc', 'webhook_enc', 'logo']);

function scrub(values) {
  if (!values) return null;
  const out = {};
  for (const [k, v] of Object.entries(values)) out[k] = SENSITIVE.has(k) ? '[redacted]' : (v instanceof Date ? v.toISOString() : v);
  return JSON.stringify(out);
}

/** Only the fields that changed between two records (compared as strings, numbers normalised). */
function diff(before, after) {
  const oldValues = {};
  const newValues = {};
  for (const key of Object.keys(after)) {
    const a = before?.[key];
    const b = after[key];
    const norm = (v) => (v === null || v === undefined ? '' : typeof v === 'number' || (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) && /^-?\d/.test(v)) ? String(Number(v)) : typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (norm(a) !== norm(b)) {
      oldValues[key] = a ?? null;
      newValues[key] = b ?? null;
    }
  }
  return { oldValues, newValues, changed: Object.keys(newValues).length > 0 };
}

/** @param {object} ctx { businessId, userId, ip, userAgent } */
async function record(ctx, action, { entityType, entityId, oldValues, newValues } = {}, trx = knex) {
  // In that clinic's own database, wherever the action was taken from (sign-up, platform admin…) — src/db/tenant.js.
  const table = await require('../db/tenant').tableFor(ctx.businessId, 'audit_logs'); // eslint-disable-line global-require
  await trx(table).insert({
    business_id: ctx.businessId ?? null,
    user_id: ctx.userId ?? null,
    action,
    entity_type: entityType ?? null,
    entity_id: entityId != null ? String(entityId) : null,
    old_values: scrub(oldValues),
    new_values: scrub(newValues),
    ip: ctx.ip ? String(ctx.ip).slice(0, 64) : null,
    user_agent: ctx.userAgent ? String(ctx.userAgent).slice(0, 255) : null,
  });
}

module.exports = { record, diff, scrub };
