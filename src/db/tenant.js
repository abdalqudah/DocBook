// Which database a query goes to. Every clinic (or medical centre, with all its doctors' practices) can have its own
// MySQL database — businesses.db_name — holding its patients, visits, money, files… The shared data (users, the list
// of clinics, subscriptions, the reps' marketplace…) stays in the main database, and each clinic database sees those
// tables through views of the same name, so one connection reads and joins both, and a transaction covers both.
// A clinic without db_name still lives in the main database (clinics are moved one by one, see tenant-move.js).
//
// The context is carried by AsyncLocalStorage: the app sets it for the request's clinic (middleware/context.js),
// the public pages for the clinic they show, background jobs for each database in turn. src/db/knex.js routes every
// query to the context's database (the main one when there is none).
//   run(db, fn)              run fn with `db` as the database (null / main name = the main database)
//   runFor(businessId, fn)   … with the database of that clinic
//   dbOf(businessId)         that clinic's database name (null = main)
//   eachDb(fn)               fn once per database (main, then every clinic database) — for jobs and platform totals
//   main / forDb(name)       the knex instances themselves
const { AsyncLocalStorage } = require('async_hooks');
const config = require('../config');
const { connect } = require('./connection');

const als = new AsyncLocalStorage();
const MAIN = config.db.database;
const main = connect(MAIN);
const pools = new Map(); // db name → { k, used }
const POOL_MAX = Number(process.env.TENANT_POOL_MAX || 3);
const SAFE_NAME = /^[A-Za-z0-9_]{1,64}$/;

function forDb(name) {
  if (!name || name === MAIN) return main;
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid database name: ${name}`);
  let p = pools.get(name);
  if (!p) { p = { k: connect(name, { poolMax: POOL_MAX, migrations: false }), used: Date.now() }; pools.set(name, p); }
  p.used = Date.now();
  return p.k;
}
// Connections of a clinic nobody used for a while are closed (a shared host allows few connections).
const reaper = setInterval(() => {
  const old = Date.now() - 15 * 60_000;
  for (const [name, p] of pools) if (p.used < old) { pools.delete(name); p.k.destroy().catch(() => {}); }
}, 5 * 60_000);
reaper.unref();

// ---------------------------------------------------------------- clinic → database
const dbCache = new Map(); // businessId → { db, at }
async function dbOf(businessId) {
  const id = Number(businessId) || 0;
  if (!id) return null;
  if (TEST_DB) return TEST_DB;
  const hit = dbCache.get(id);
  let db;
  if (hit && Date.now() - hit.at < 10_000) db = hit.db;
  else {
    const row = await main('businesses').where({ id }).first('db_name').catch(() => null);
    db = (row && row.db_name) || null;
    dbCache.set(id, { db, at: Date.now() });
  }
  // Being moved to another database (tenant-admin.js): nothing is read or written until it is done.
  if (db && db.startsWith('!')) {
    const { AppError } = require('../core/errors'); // eslint-disable-line global-require
    throw new AppError('CLINIC_DB_MOVING', 'This clinic is being moved to its own database. Try again in a minute.', 503);
  }
  return db;
}
const forget = (businessId) => { if (businessId) dbCache.delete(Number(businessId)); else dbCache.clear(); };

// ---------------------------------------------------------------- the context
const run = (db, fn) => als.run({ ...(als.getStore() || {}), db: db || null, knex: forDb(db) }, fn);
const runFor = async (businessId, fn) => run(await dbOf(businessId), fn);
/** For express: the rest of the request runs on this clinic's database. */
const middlewareFor = (getBusinessId) => async (req, res, next) => {
  try { const id = await getBusinessId(req); return run(await dbOf(id), () => next()); } catch (e) { return next(e); }
};
const current = () => { const s = als.getStore(); return s && s.knex ? s.db : null; };
/** The database queries go to right now (null = main). */
const activeDb = () => { const s = als.getStore(); if (s && s.knex) return s.db || null; if (s && s.req) return null; return TEST_DB || null; };
/** Is `businessId`'s database the one queries go to now? */
const isHere = async (businessId) => ((await dbOf(businessId)) || MAIN) === (activeDb() || MAIN);
/** `table` of that clinic as seen from here: the bare name when it is the current database, else `db`.`table`. */
async function tableFor(businessId, table) {
  if (!businessId) return table;
  const db = (await dbOf(businessId)) || MAIN;
  return db === (activeDb() || MAIN) ? table : `${db}.${table}`;
}

/** Every database in use: main first, then each clinic / centre database (distinct). */
async function allDbs() {
  if (TEST_DB) return [null, TEST_DB];
  const rows = await main('tenant_dbs').pluck('db_name').catch(() => []);
  return [null, ...rows.filter((n) => n && n !== MAIN)];
}
/** fn in that clinic's database (as is when it is the current one) — for platform pages that show one clinic's data. */
const inClinic = async (businessId, fn) => ((await isHere(businessId)) ? fn() : runFor(businessId, fn));
/** A number added up over every database (platform totals). */
const sum = async (fn) => (await eachDb(async () => Number(await fn()) || 0)).reduce((a, b) => a + b, 0);
async function eachDb(fn) {
  const out = [];
  for (const db of await allDbs()) out.push(await run(db, () => fn(db))); // eslint-disable-line no-restricted-syntax, no-await-in-loop
  return out;
}

// ---------------------------------------------------------------- public links: which clinic's database has it?
// A patient's link (document, payment, consultation, door / waiting screen, calendar…) carries no clinic: it is looked
// for in each database once, then remembered (token → database) for a while.
const found = new Map();
const FOUND_MAX = 5000;
/** Express middleware: `find(req)` is tried in each database; the request goes on in the first one that has it. */
const resolveBy = (find, key = null) => async (req, res, next) => {
  try {
    const cur = als.getStore();
    if (cur && cur.knex) return next(); // already in a clinic's database
    const k = key ? key(req) : null;
    if (k && found.has(k)) {
      const db = found.get(k);
      if (await run(db, () => find(req))) return run(db, () => next());
      found.delete(k);
    }
    for (const db of await allDbs()) { // eslint-disable-line no-restricted-syntax
      if (await run(db, () => find(req))) { // eslint-disable-line no-await-in-loop
        if (k) { if (found.size >= FOUND_MAX) found.delete(found.keys().next().value); found.set(k, db); }
        return run(db, () => next());
      }
    }
    return next();
  } catch (e) { return next(e); }
};
/** router.param form: `find(value, req)`. */
const byParam = (ns, find) => (req, res, next, value) => resolveBy((r) => find(value, r), () => `${ns}:${value}`)(req, res, next);

/** The clinic of a /<slug>/… address (its public pages, booking, website, media): the rest runs in its database. */
const slugCache = new Map();
async function dbOfSlug(slug) {
  const hit = slugCache.get(slug);
  if (hit && Date.now() - hit.at < 10_000) return hit;
  const row = await main('businesses').where({ slug }).first('id').catch(() => null);
  const v = { at: Date.now(), id: row ? row.id : null, db: row ? await dbOf(row.id) : null };
  if (slugCache.size > 5000) slugCache.clear();
  slugCache.set(slug, v);
  return v;
}
const slugMiddleware = (reserved) => async (req, res, next) => {
  try {
    const cur = als.getStore();
    if (cur && cur.knex) return next();
    const seg = decodeURIComponent(String(req.path || '').split('/')[1] || '').toLowerCase();
    if (!seg || reserved.has(seg) || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(seg)) return next();
    const v = await dbOfSlug(seg);
    return v.id ? run(v.db, () => next()) : next();
  } catch (e) { return next(e); }
};

// ---------------------------------------------------------------- tests: every clinic in one separate database
// TENANT_TEST_DB=<name>: all clinics use that database; test code (no context) does too. A query made with no
// context outside test code is noted (a request that lost its clinic) — see test/tenant-*.test.js.
const TEST_DB = process.env.NODE_ENV === 'test' ? (process.env.TENANT_TEST_DB || null) : null;
const lost = [];
function active() {
  const s = als.getStore();
  if (s && s.knex) return s.knex;
  if (s && s.req) return main; // a platform request (sign-in, platform admin, reps' portal…)
  if (TEST_DB) {
    const stack = new Error().stack || '';
    if (!/[/\\]test[/\\][^/\\]+\.test\.js/.test(stack) && !/[/\\]scripts[/\\]/.test(stack) && lost.length < 200) lost.push(stack.split('\n').slice(2, 9).join('\n'));
    return forDb(TEST_DB);
  }
  return main;
}

// Test runs: the queries that lost their clinic are written out for review (TENANT_LOST_LOG=<file>).
if (TEST_DB && process.env.TENANT_LOST_LOG) {
  process.on('exit', () => { if (lost.length) require('fs').appendFileSync(process.env.TENANT_LOST_LOG, `${lost.join('\n----\n')}\n====\n`); }); // eslint-disable-line global-require
}

async function destroyAll() {
  clearInterval(reaper);
  await Promise.all([...pools.values()].map((p) => p.k.destroy().catch(() => {})));
  pools.clear();
  await main.destroy();
}

/** router.param form for a slug that is not first in the path (/m/<slug>/<id>). */
const slugParam = (req, res, next, slug) => dbOfSlug(String(slug || '').toLowerCase()).then((v) => (v.id && !(als.getStore() || {}).knex ? run(v.db, () => next()) : next()), next);

module.exports = { inClinic, sum, activeDb, isHere, tableFor, slugParam, als, MAIN, main, forDb, dbOf, forget, run, runFor, middlewareFor, current, allDbs, eachDb, active, destroyAll, lost, TEST_DB, resolveBy, byParam, slugMiddleware, dbOfSlug };
