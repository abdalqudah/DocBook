// Platform admin → Clinic databases (/admin/databases): which clinics have their own database, which still live in the
// main one, moving them (one, or all — a medical centre always moves with every practice), and bringing every
// database's structure in step. Moves run in the background, one after another; each is audited.
const audit = require('../../core/audit');
const tenant = require('../../db/tenant');
const admin = require('../../db/tenant-admin');
const provision = require('../../db/provision');

const main = () => tenant.main;

/** Separate databases: on/off, how they are created (never a secret), the databases and the clinics still in the main one. */
async function overview() {
  const k = main();
  const [dbs, clinics, sizes] = await Promise.all([
    k('tenant_dbs').orderBy('id').select('db_name', 'driver', 'created_at', 'synced_at'),
    k('businesses').whereNot('status', 'deleted').select('id', 'name', 'name_en', 'slug', 'status', 'db_name', 'center_id', 'kind', 'created_at').orderBy('id'),
    k.raw("SELECT table_schema AS s, SUM(data_length + index_length) AS b FROM information_schema.tables WHERE table_type = 'BASE TABLE' GROUP BY table_schema").then(([r]) => new Map(r.map((x) => [x.s || x.TABLE_SCHEMA, Number(x.b) || 0]))).catch(() => new Map()),
  ]);
  const byDb = new Map(dbs.map((d) => [d.db_name, { ...d, clinics: [], bytes: sizes.get(d.db_name) || 0 }]));
  const inMain = [];
  clinics.forEach((c) => {
    if (c.db_name && byDb.has(c.db_name)) byDb.get(c.db_name).clinics.push(c);
    else if (!c.db_name) inMain.push(c);
  });
  // Units still in the main database: a medical centre with all its practices, or one clinic.
  const units = new Map();
  inMain.forEach((c) => { const key = c.center_id ? `c${c.center_id}` : `b${c.id}`; units.set(key, [...(units.get(key) || []), c]); });
  return {
    driver: provision.DRIVER, enabled: provision.enabled(), prefix: provision.PREFIX,
    cpanelReady: Boolean(process.env.CPANEL_URL && process.env.CPANEL_USER && process.env.CPANEL_TOKEN),
    mainDb: tenant.MAIN, mainBytes: sizes.get(tenant.MAIN) || 0,
    databases: [...byDb.values()], units: [...units.values()], counts: { total: clinics.length, own: clinics.length - inMain.length, main: inMain.length },
  };
}

// ---------------------------------------------------------------- the background job (one at a time)
let job = null;
const status = () => (job ? { ...job, errors: [...job.errors] } : { running: false });

async function runMoves(ctx, unitIds) {
  try {
    for (const id of unitIds) { // eslint-disable-line no-restricted-syntax
      if (job.stop) break;
      job.current = id;
      try {
        const r = await admin.separate(id); // eslint-disable-line no-await-in-loop
        job.done += 1; job.rows += r.moved || 0;
        await audit.record({ ...ctx, businessId: null }, 'platform.clinic_db_moved', { entityType: 'clinic', entityId: id, newValues: { db: r.db, rows: r.moved } }); // eslint-disable-line no-await-in-loop
      } catch (e) {
        job.failed += 1; job.errors.push(`#${id}: ${e.message}`);
      }
    }
  } finally {
    job.running = false; job.current = null; job.finishedAt = new Date();
  }
}

/** Moves clinics (by id; each with its medical centre) to their own databases, in the background. */
async function start(ctx, ids) {
  if (!provision.enabled()) return { ok: false, reason: 'off' };
  if (job && job.running) return { ok: false, reason: 'running' };
  const k = main();
  const rows = await k('businesses').whereIn('id', ids.map(Number).filter(Boolean)).whereNull('db_name').select('id', 'center_id');
  const seen = new Set(); const unitIds = [];
  rows.forEach((r) => { const key = r.center_id ? `c${r.center_id}` : `b${r.id}`; if (!seen.has(key)) { seen.add(key); unitIds.push(r.id); } });
  if (!unitIds.length) return { ok: false, reason: 'nothing' };
  job = { running: true, total: unitIds.length, done: 0, failed: 0, rows: 0, errors: [], startedAt: new Date(), finishedAt: null, current: null, stop: false };
  await audit.record({ ...ctx, businessId: null }, 'platform.clinic_db_moves_started', { entityType: 'platform', newValues: { units: unitIds.length } });
  runMoves(ctx, unitIds).catch(() => {});
  return { ok: true, total: unitIds.length };
}
async function startAll(ctx) {
  const ids = await main()('businesses').whereNull('db_name').whereNot('status', 'deleted').pluck('id');
  return start(ctx, ids);
}
function stop() { if (job && job.running) job.stop = true; }
const wait = async () => { while (job && job.running) await new Promise((r) => { setTimeout(r, 50); }); }; // eslint-disable-line no-await-in-loop

async function syncNow(ctx) {
  const out = await admin.syncAll();
  const changes = out.reduce((n, d) => n + d.changes.length, 0);
  await audit.record({ ...ctx, businessId: null }, 'platform.clinic_dbs_synced', { entityType: 'platform', newValues: { databases: out.length, changes } });
  return { databases: out.length, changes };
}

module.exports = { overview, status, start, startAll, stop, wait, syncNow };
