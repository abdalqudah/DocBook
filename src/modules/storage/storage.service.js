// A clinic's file storage, one size for everything the clinic keeps: the website media library, the patients' files
// (scans, results, X-rays), the team chat attachments, the files patients send with an online consultation, and
// uploaded fonts.
//   quotaOf(businessId) → { mb, source }: the size the platform admin set for this clinic (businesses.media_quota_mb),
//     else the package's media.storage_mb (null = no limit), else DEFAULT_MB while no package applies.
//   stats(businessId)   → { bytes, files, by: { media, patients, chat, online, fonts }, quota, quotaMb, source }
//   assertRoom(businessId, addBytes) → throws STORAGE_FULL when the new files do not fit.
// Files a patient sends with an online booking are counted but never refused here (the patient is not the one
// who can free space).
const knex = require('../../db/knex');
const { AppError } = require('../../core/errors');

const DEFAULT_MB = 200;
const MB = 1024 * 1024;
const PARTS = [
  { key: 'media', table: 'clinic_media' },
  { key: 'patients', table: 'patient_files' },
  { key: 'chat', table: 'staff_chat_files' },
  { key: 'online', table: 'online_consultation_files' },
  { key: 'fonts', table: 'clinic_fonts' },
];

async function quotaOf(businessId) {
  const b = await knex('businesses').where({ id: businessId }).first();
  if (!b) return { mb: DEFAULT_MB, source: 'default' };
  if (b.media_quota_mb !== null && b.media_quota_mb !== undefined) return { mb: Number(b.media_quota_mb), source: 'clinic' };
  const ops = require('../platformops/ops.service'); // eslint-disable-line global-require
  const features = await ops.planFeatures(b);
  if (!features) return { mb: DEFAULT_MB, source: 'default' };
  const entitlements = require('../subscriptions/entitlements'); // eslint-disable-line global-require
  return { mb: entitlements.valueIn(features, 'media.storage_mb'), source: 'plan' };
}

async function usage(businessId) {
  const rows = await Promise.all(PARTS.map((p) => knex(p.table).where({ business_id: businessId }).count({ n: '*' }).sum({ bytes: 'size' }).then(([r]) => r)));
  const by = {}; const counts = {};
  PARTS.forEach((p, i) => { by[p.key] = Number(rows[i].bytes) || 0; counts[p.key] = Number(rows[i].n) || 0; });
  return { by, counts, bytes: Object.values(by).reduce((a, b) => a + b, 0), files: Object.values(counts).reduce((a, b) => a + b, 0) };
}

async function stats(businessId) {
  const [u, q] = await Promise.all([usage(businessId), quotaOf(businessId)]);
  return { ...u, quota: q.mb === null ? null : q.mb * MB, quotaMb: q.mb, source: q.source };
}

async function assertRoom(businessId, addBytes, s) {
  const st = s || await stats(businessId);
  if (st.quota !== null && st.bytes + (Number(addBytes) || 0) > st.quota) {
    throw new AppError('STORAGE_FULL', "The clinic's file storage is full.", 409, { files: 'STORAGE_FULL', mb: st.quotaMb });
  }
  return st;
}

/** Bytes used by every clinic (or the given ones) → Map(businessId → bytes), one query. */
async function usageAll(ids = null) {
  const out = new Map();
  // Every database (each clinic may have its own — src/db/tenant.js).
  await require('../../db/tenant').eachDb(async () => { // eslint-disable-line global-require
    const parts = PARTS.map((p) => knex(p.table).select('business_id', 'size').modify((q) => { if (ids) q.whereIn('business_id', ids); }));
    const rows = await knex.select('business_id').sum({ bytes: 'size' }).from(knex.unionAll(parts, true).as('f')).groupBy('business_id');
    rows.forEach((r) => out.set(Number(r.business_id), (out.get(Number(r.business_id)) || 0) + (Number(r.bytes) || 0)));
  });
  return out;
}

module.exports = { DEFAULT_MB, MB, PARTS, quotaOf, usage, usageAll, stats, assertRoom };
