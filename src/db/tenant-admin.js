// Giving clinics their own database, moving them, keeping every database's structure current.
//   newDb()                         a new, empty clinic database (its own block of ids), built and registered
//   move(ids, to)                   moves these clinics' rows from their database to `to` (a database name, or null
//                                   for the main one) in one transaction; the clinics answer "moving" meanwhile
//   placeNew(businessId)            a new clinic: its own database — or its medical centre's
//   syncAll()                       after a migration: every clinic database in step with the main one
// Everything runs on the main connection with qualified table names (`db`.`table`) — one server, one transaction.
const tenant = require('./tenant');
const schema = require('./tenant-schema');
const provision = require('./provision');
const { TENANT } = require('./tables');

const q = (s) => `\`${String(s).replace(/`/g, '')}\``;
const main = () => tenant.main;
const MAIN = tenant.MAIN;
const SETTLE_MS = () => Number(process.env.TENANT_MOVE_SETTLE_MS ?? 12_000); // > the clinic → database cache (10 s)
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Clinic tables without business_id: their rows follow a parent's.
const CHILDREN = {
  notification_reads: (src, ids) => [`notification_id IN (SELECT id FROM ${q(src)}.notifications WHERE business_id IN (${ids}))`],
  staff_chat_members: (src, ids) => [`chat_id IN (SELECT id FROM ${q(src)}.staff_chats WHERE business_id IN (${ids}))`],
  telehealth_signals: (src, ids) => [`consultation_id IN (SELECT id FROM ${q(src)}.online_consultations WHERE business_id IN (${ids}))`],
  center_expenses: (src, ids) => [`center_id IN (SELECT id FROM ${q(MAIN)}.centers WHERE owner_business_id IN (${ids}))`],
  center_staff: (src, ids) => [`center_id IN (SELECT id FROM ${q(MAIN)}.centers WHERE owner_business_id IN (${ids}))`],
};
const scopeOf = (t, src, ids) => (CHILDREN[t] ? CHILDREN[t](src, ids)[0] : `business_id IN (${ids})`);

async function columns(db, t) {
  const rows = await main()('information_schema.columns').where({ table_schema: db, table_name: t }).orderBy('ordinal_position').select('column_name');
  return rows.map((r) => r.column_name || r.COLUMN_NAME);
}

/** The name a unit's database should have: the clinic's address (slug) — for a medical centre, the centre's. */
async function labelOf(ids) {
  const k = main();
  const rows = await k('businesses').whereIn('id', ids).select('id', 'slug', 'center_id');
  const centerId = rows.map((r) => r.center_id).find(Boolean);
  if (centerId) {
    const c = await k('centers').where({ id: centerId }).first('owner_business_id');
    const owner = c && await k('businesses').where({ id: c.owner_business_id }).first('slug');
    if (owner && owner.slug) return owner.slug;
  }
  const first = rows.sort((a, b) => a.id - b.id)[0];
  return first ? first.slug : '';
}

/** A free database name for `label` (never one registered or already on the server). */
async function freeName(label, fallback) {
  const k = main();
  const base = provision.nameFor(label, fallback);
  const [taken] = await k.raw('SELECT schema_name AS s FROM information_schema.schemata');
  const used = new Set([...taken.map((r) => r.s || r.SCHEMA_NAME), ...(await k('tenant_dbs').pluck('db_name')), MAIN]);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
  throw new Error(`No free database name for ${base}.`);
}

/** A new clinic database (named after the clinic): registered with its block of ids, created on the server, tables and views built. */
async function newDb(label = '') {
  const k = main();
  const [{ m }] = await k('tenant_dbs').max({ m: 'block' });
  const block = Math.max(schema.FIRST_BLOCK, (Number(m) || 0) + 1);
  const [id] = await k('tenant_dbs').insert({ db_name: `__pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, block, driver: provision.DRIVER });
  const name = await freeName(label, `c${id}`);
  await k('tenant_dbs').where({ id }).update({ db_name: name });
  try {
    await provision.createDatabase(k, name);
    await schema.build(k, MAIN, name);
    await k('tenant_dbs').where({ id }).update({ synced_at: new Date() });
    return name;
  } catch (e) {
    await provision.dropDatabase(k, name).catch(() => {});
    await k('tenant_dbs').where({ id }).del().catch(() => {});
    throw e;
  }
}

/**
 * Moves the rows of clinics `ids` (all in the same database) to database `to` (null = main). The clinics answer
 * "moving, try again in a minute" while it runs; the copy and the removal happen in one transaction.
 */
async function move(ids, to, { settle = SETTLE_MS() } = {}) {
  const k = main();
  const list = [...new Set(ids.map(Number).filter(Boolean))];
  if (!list.length) return { moved: 0 };
  const rows = await k('businesses').whereIn('id', list).select('id', 'db_name');
  if (rows.length !== list.length) throw new Error('Unknown clinic.');
  const from = [...new Set(rows.map((r) => r.db_name || null))];
  if (from.length !== 1) throw new Error('These clinics are in different databases.');
  if (from[0] && from[0].startsWith('!')) throw new Error('A move is already running for these clinics.');
  const src = from[0] || MAIN;
  const dst = to || MAIN;
  if (src === dst) return { moved: 0 };
  if (dst !== MAIN && !(await k('tenant_dbs').where({ db_name: dst }).first('id'))) throw new Error(`Unknown clinic database: ${dst}`);
  await k('businesses').whereIn('id', list).update({ db_name: '!moving' });
  list.forEach((id) => tenant.forget(id));
  try {
    if (settle) await sleep(settle);
    const idList = list.join(',');
    const counts = {};
    await k.transaction(async (trx) => {
      await trx.raw('SET FOREIGN_KEY_CHECKS = 0');
      try {
        for (const t of TENANT) { // eslint-disable-line no-restricted-syntax
          const cols = await columns(dst, t); // eslint-disable-line no-await-in-loop
          const srcCols = new Set(await columns(src, t)); // eslint-disable-line no-await-in-loop
          const use = cols.filter((c) => srcCols.has(c));
          const scope = scopeOf(t, src, idList);
          if (use.includes('id')) {
            const [[clash]] = await trx.raw(`SELECT COUNT(*) AS n FROM ${q(dst)}.${q(t)} x JOIN ${q(src)}.${q(t)} y ON y.id = x.id WHERE ${scope.replace(/\b(business_id|notification_id|chat_id|consultation_id|center_id)\b/, 'y.$1')}`); // eslint-disable-line no-await-in-loop
            if (Number(clash.n)) throw new Error(`Rows of ${t} would share ids with rows already in ${dst}.`);
          }
          const colSql = use.map(q).join(', ');
          const [r] = await trx.raw(`INSERT INTO ${q(dst)}.${q(t)} (${colSql}) SELECT ${colSql} FROM ${q(src)}.${q(t)} WHERE ${scope}`); // eslint-disable-line no-await-in-loop
          counts[t] = r.affectedRows || 0;
        }
        // Children first (their scope reads the parents), then everything else.
        const order = [...Object.keys(CHILDREN), ...TENANT.filter((t) => !CHILDREN[t])];
        for (const t of order) { // eslint-disable-line no-restricted-syntax
          const [r] = await trx.raw(`DELETE FROM ${q(src)}.${q(t)} WHERE ${scopeOf(t, src, idList)}`); // eslint-disable-line no-await-in-loop
          if ((r.affectedRows || 0) !== counts[t]) throw new Error(`${t}: copied ${counts[t]} rows but found ${r.affectedRows} to remove — nothing was moved.`);
        }
      } finally { await trx.raw('SET FOREIGN_KEY_CHECKS = 1'); }
      await trx('businesses').whereIn('id', list).update({ db_name: dst === MAIN ? null : dst });
    });
    return { moved: Object.values(counts).reduce((a, b) => a + b, 0), counts };
  } catch (e) {
    await k('businesses').whereIn('id', list).update({ db_name: src === MAIN ? null : src });
    throw e;
  } finally {
    list.forEach((id) => tenant.forget(id));
  }
}

/** The clinics that share one database: a medical centre (its administration and every practice), else the clinic. */
async function unitOf(businessId) {
  const k = main();
  const b = await k('businesses').where({ id: businessId }).first('id', 'center_id');
  if (!b) return [];
  if (!b.center_id) return [b.id];
  return k('businesses').where({ center_id: b.center_id }).pluck('id');
}

/**
 * Where a new clinic belongs: inside its medical centre's database (practices of one centre always share it — the
 * shared reception and cash screen work across them), else a new database of its own. Nothing happens while
 * separate databases are off. A brand-new clinic is moved at once (nobody uses it yet).
 */
async function placeNew(businessId) {
  const k = main();
  const b = await k('businesses').where({ id: businessId }).first('id', 'db_name', 'center_id');
  if (!b || b.db_name) return b ? b.db_name : null;
  if (b.center_id) {
    const c = await k('centers').where({ id: b.center_id }).first('owner_business_id');
    if (c && c.owner_business_id !== b.id) {
      const owner = await k('businesses').where({ id: c.owner_business_id }).first('db_name');
      const target = owner ? owner.db_name || null : null;
      if (target) await move([b.id], target, { settle: 0 });
      return target; // a centre still in the main database keeps its practices there too (whatever the setting)
    }
  }
  if (!provision.enabled()) return null;
  const target = await newDb(await labelOf([b.id]));
  await move([b.id], target, { settle: 0 });
  return target;
}

/** A clinic (or a whole medical centre) into a database of its own. */
async function separate(businessId) {
  const ids = await unitOf(businessId);
  if (!ids.length) throw new Error('Unknown clinic.');
  const target = await newDb(await labelOf(ids));
  try { return { db: target, ...(await move(ids, target)) }; } catch (e) {
    await provision.dropDatabase(main(), target).catch(() => {});
    await main()('tenant_dbs').where({ db_name: target }).del().catch(() => {});
    throw e;
  }
}

/** A clinic joining a medical centre: its rows go to the centre's database (when that is another one). */
async function intoCenter(businessId) {
  const k = main();
  const b = await k('businesses').where({ id: businessId }).first('id', 'db_name', 'center_id');
  if (!b || !b.center_id) return null;
  const c = await k('centers').where({ id: b.center_id }).first('owner_business_id');
  const owner = c ? await k('businesses').where({ id: c.owner_business_id }).first('db_name') : null;
  const target = owner ? owner.db_name || null : null;
  if ((b.db_name || null) === target) return target;
  await move([b.id], target);
  return target;
}

/** A practice leaving its medical centre: out of the centre's database into one of its own (when separate databases are on). */
async function outOfCenter(businessId) {
  if (!provision.enabled()) return null;
  const b = await main()('businesses').where({ id: businessId }).first('id', 'db_name');
  if (!b || !b.db_name) return null;
  const target = await newDb(await labelOf([b.id]));
  await move([b.id], target);
  return target;
}

/** Every clinic database in step with the main database (after migrations). */
async function syncAll(log = () => {}) {
  const k = main();
  if (!(await k.schema.hasTable('tenant_dbs'))) return [];
  const dbs = await k('tenant_dbs').pluck('db_name');
  const out = [];
  for (const db of dbs) { // eslint-disable-line no-restricted-syntax
    const changes = await schema.sync(k, MAIN, db); // eslint-disable-line no-await-in-loop
    await k('tenant_dbs').where({ db_name: db }).update({ synced_at: new Date() }); // eslint-disable-line no-await-in-loop
    if (changes.length) log(`[db] ${db}: ${changes.join('; ')}`);
    out.push({ db, changes });
  }
  return out;
}

/** The database's wanted name (its clinic's or centre's), or null when it already has it / holds no clinic. */
async function wantedName(db) {
  const ids = await main()('businesses').where({ db_name: db }).pluck('id');
  if (!ids.length) return null;
  const label = await labelOf(ids);
  const base = provision.nameFor(label, '');
  if (!label || base === provision.PREFIX || db === base || (db.startsWith(`${base}_`) && /^\d+$/.test(db.slice(base.length + 1)))) return null; // "_2": the name was taken
  return { ids, label };
}

/**
 * Gives a clinic database its clinic's name (MySQL cannot rename a database): a new database with the right name,
 * the clinics moved into it (the same safe move), then the old, now empty, database removed.
 */
async function rename(db) {
  const want = await wantedName(db);
  if (!want) return { db, renamed: false };
  const target = await newDb(want.label);
  try {
    const r = await move(want.ids, target);
    await provision.dropDatabase(main(), db).catch(() => {});
    await main()('tenant_dbs').where({ db_name: db }).del();
    return { db: target, from: db, renamed: true, moved: r.moved };
  } catch (e) {
    await provision.dropDatabase(main(), target).catch(() => {});
    await main()('tenant_dbs').where({ db_name: target }).del().catch(() => {});
    throw e;
  }
}

/** placeNew that never stops sign-up: a failure leaves the clinic in the main database (the admin can move it later). */
const placeSafely = (businessId) => placeNew(businessId).catch((e) => { console.error('[db] own database for clinic', businessId, 'failed:', e.message); return null; }); // eslint-disable-line no-console

module.exports = { placeSafely, CHILDREN, labelOf, wantedName, rename, newDb, move, placeNew, unitOf, separate, intoCenter, outOfCenter, syncAll };
