// A separate, encrypted backup of ONE clinic's data — everything stored under its business_id (patients, visits,
// invoices, files…), the rows that hang off those (order lines, chat members, read marks) and its staff's user
// accounts — so the platform admin can give a clinic its data back without touching any other clinic.
//
//   createBackup(businessId, { reason })  → writes storage/clinic-backups/<id>/<stamp>.dbk and returns its info
//   list(businessId)                      → the clinic's backups, newest first
//   read(businessId, name)                → the file (encrypted bytes) for download
//   restore(buffer, { businessId })       → replaces that clinic's data with the backup's (a deleted clinic too)
//   runNightly()                          → one backup per active clinic per day, the last KEEP kept
//
// File: "DBKB1" + 12-byte IV + 16-byte tag + AES-256-GCM(gzip(JSON)), with a key derived from APP_KEY (or the session
// secret): only this server can read it. Never served from /public.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');

const DIR = process.env.CLINIC_BACKUP_DIR || path.join(__dirname, '..', '..', '..', 'storage', 'clinic-backups');
const KEEP = 7;
const MAGIC = Buffer.from('DBKB1');
// Rows without a business_id that belong to a clinic through their parent row.
const CHILDREN = [
  { table: 'purchase_order_items', fk: 'purchase_order_id', parent: 'purchase_orders' },
  { table: 'staff_chat_members', fk: 'chat_id', parent: 'staff_chats' },
  { table: 'notification_reads', fk: 'notification_id', parent: 'notifications' },
  { table: 'support_ticket_reads', fk: 'ticket_id', parent: 'support_tickets' },
];
const SKIP = new Set(['sessions', 'knex_migrations', 'knex_migrations_lock', 'audit_logs_archive']);

let cachedKey;
function key() {
  if (cachedKey) return cachedKey;
  const base = process.env.APP_KEY || process.env.SESSION_SECRET || require('../../config').sessionSecret; // eslint-disable-line global-require
  cachedKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(base)), Buffer.from('clinic-backup'), Buffer.from('clinic-backup-v1'), 32));
  return cachedKey;
}
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(obj)))), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), data]);
}
function open(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 40 || !buf.subarray(0, 5).equals(MAGIC)) throw new AppError('BACKUP_INVALID', 'This is not a clinic backup file.', 422);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(5, 17));
    d.setAuthTag(buf.subarray(17, 33));
    return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(33)), d.final()])).toString('utf8'));
  } catch { throw new AppError('BACKUP_UNREADABLE', 'This backup cannot be read on this server (different key, or the file is damaged).', 422); }
}

// Dates, binary data and JSON columns (read back as arrays / objects) survive the trip.
const isPlain = (v) => v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v);
const pack = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? { $d: v.toISOString() } : Buffer.isBuffer(v) ? { $b: v.toString('base64') } : isPlain(v) ? { $j: v } : v]));
const unpack = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => {
  if (!isPlain(v)) return [k, v];
  if ('$d' in v) return [k, new Date(v.$d)];
  if ('$b' in v) return [k, Buffer.from(v.$b, 'base64')];
  if ('$j' in v) return [k, JSON.stringify(v.$j)];
  return [k, JSON.stringify(v)];
}));

/** Tables that carry a business_id column (this database). */
async function tenantTables(db = knex) {
  const isPg = /pg|postgres/.test(db.client.config.client);
  const rows = isPg
    ? (await db.raw("select table_name as t from information_schema.columns where table_schema = current_schema() and column_name = 'business_id'")).rows
    : (await db.raw("select table_name as t from information_schema.columns where table_schema = database() and column_name = 'business_id'"))[0];
  return [...new Set(rows.map((r) => r.t || r.T || r.TABLE_NAME))].filter((t) => !SKIP.has(t)).sort();
}

async function snapshot(businessId) {
  const biz = await knex('businesses').where({ id: businessId }).first();
  if (!biz) throw E.notFound('Clinic');
  const tables = {};
  for (const t of await tenantTables()) tables[t] = (await knex(t).where({ business_id: businessId })).map(pack); // eslint-disable-line no-await-in-loop
  for (const c of CHILDREN) { // eslint-disable-line no-restricted-syntax
    const ids = (tables[c.parent] || []).map((r) => r.id);
    tables[c.table] = ids.length ? (await knex(c.table).whereIn(c.fk, ids)).map(pack) : []; // eslint-disable-line no-await-in-loop
  }
  const userIds = [...new Set((tables.memberships || []).map((m) => m.user_id))];
  const users = userIds.length ? (await knex('users').whereIn('id', userIds)).map(pack) : [];
  return { format: 1, created_at: new Date().toISOString(), business: pack(biz), tables, users };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');

async function createBackup(businessId, { reason = 'manual', ctx = null } = {}) {
  const data = await snapshot(businessId);
  const file = seal(data);
  const dir = path.join(DIR, String(Number(businessId)));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${stamp()}-${reason === 'nightly' ? 'auto' : 'manual'}.dbk`;
  fs.writeFileSync(path.join(dir, name), file, { mode: 0o600 });
  prune(businessId);
  const rows = Object.values(data.tables).reduce((n, list) => n + list.length, 0);
  if (ctx) await audit.record(ctx, 'clinic.backup_created', { entityType: 'clinic', entityId: businessId, newValues: { file: name, rows } });
  return { name, size: file.length, rows };
}

function list(businessId) {
  const dir = path.join(DIR, String(Number(businessId)));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^[0-9]{8}-[0-9]{6}-(auto|manual)\.dbk$/.test(f)).sort().reverse()
    .map((f) => { const st = fs.statSync(path.join(dir, f)); return { name: f, size: st.size, at: st.mtime, auto: f.includes('-auto') }; });
}

/** Keeps the last KEEP automatic backups (manual ones stay until the admin removes them). */
function prune(businessId) {
  const auto = list(businessId).filter((b) => b.auto);
  auto.slice(KEEP).forEach((b) => { try { fs.unlinkSync(path.join(DIR, String(Number(businessId)), b.name)); } catch { /* gone */ } });
}

function read(businessId, name) {
  const safe = path.basename(String(name || ''));
  if (!/^[0-9]{8}-[0-9]{6}-(auto|manual)\.dbk$/.test(safe)) throw E.notFound('Backup');
  const p = path.join(DIR, String(Number(businessId)), safe);
  if (!fs.existsSync(p)) throw E.notFound('Backup');
  return fs.readFileSync(p);
}

/**
 * Puts a clinic back as it was in the backup: its current rows are removed and the backup's written in one
 * transaction (other clinics are never touched). Staff accounts missing from the platform are re-created;
 * existing accounts are left as they are. `businessId`, when given, must match the backup's clinic.
 */
async function restore(buf, { businessId = null, ctx = null } = {}) {
  const data = open(buf);
  const id = Number(data.business && data.business.id);
  if (!id || (businessId && Number(businessId) !== id)) throw new AppError('BACKUP_OTHER_CLINIC', 'This backup belongs to another clinic.', 422);
  const isPg = /pg|postgres/.test(knex.client.config.client);
  const present = new Set(await tenantTables());
  let rows = 0;
  await knex.transaction(async (trx) => {
    if (!isPg) await trx.raw('SET FOREIGN_KEY_CHECKS=0');
    try {
      for (const c of CHILDREN) { // eslint-disable-line no-restricted-syntax
        const ids = trx(c.parent).where({ business_id: id }).select('id');
        await trx(c.table).whereIn(c.fk, ids).del(); // eslint-disable-line no-await-in-loop
      }
      for (const t of present) await trx(t).where({ business_id: id }).del(); // eslint-disable-line no-await-in-loop
      await trx('businesses').where({ id }).del();
      await trx('businesses').insert(unpack(data.business));
      for (const u of data.users || []) { // eslint-disable-line no-restricted-syntax
        const row = unpack(u);
        const taken = await trx('users').where({ id: row.id }).orWhere({ email: row.email }).first('id'); // eslint-disable-line no-await-in-loop
        if (!taken) await trx('users').insert({ ...row, is_platform_admin: false }); // eslint-disable-line no-await-in-loop
      }
      for (const [t, list] of Object.entries(data.tables || {})) { // eslint-disable-line no-restricted-syntax
        if (!list.length || !(present.has(t) || CHILDREN.some((c) => c.table === t))) continue; // eslint-disable-line no-continue
        const cols = new Set(Object.keys(await trx(t).columnInfo())); // eslint-disable-line no-await-in-loop
        const clean = list.map((r) => Object.fromEntries(Object.entries(unpack(r)).filter(([k]) => cols.has(k))));
        for (let i = 0; i < clean.length; i += 200) await trx(t).insert(clean.slice(i, i + 200)); // eslint-disable-line no-await-in-loop
        rows += clean.length;
      }
    } finally {
      if (!isPg) await trx.raw('SET FOREIGN_KEY_CHECKS=1');
    }
  });
  require('../../core/cache').forgetPrefix(''); // eslint-disable-line global-require
  if (ctx) await audit.record(ctx, 'clinic.backup_restored', { entityType: 'clinic', entityId: id, newValues: { taken_at: data.created_at, rows } });
  return { businessId: id, rows, takenAt: data.created_at };
}

/** Once a day: a backup of every active clinic (the last KEEP automatic ones are kept). */
async function runNightly() {
  const ids = await knex('businesses').whereNot('status', 'deleted').pluck('id');
  for (const id of ids) {
    const last = list(id).find((b) => b.auto);
    if (last && Date.now() - new Date(last.at).getTime() < 20 * 3600_000) continue; // eslint-disable-line no-continue
    try { await createBackup(id, { reason: 'nightly' }); } catch (e) { console.error('[clinic-backup]', id, e.message); } // eslint-disable-line no-await-in-loop, no-console
  }
}

module.exports = { DIR, KEEP, createBackup, list, read, restore, runNightly, snapshot, tenantTables, seal, open };
