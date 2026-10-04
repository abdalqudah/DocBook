// Reading across clinics when each may have its own database (src/db/tenant.js) — for the few platform pages that
// list several clinics: the reps' portal, the clinic directory, the main site.
//   gatherFor(ids, fn)       fn(idsOfThatDatabase) run in each database holding some of these clinics; rows concatenated
//   fillDoctors(rows, opts)  rows with business_id + doctor_id get the doctor's name from the clinic's own database
const tenant = require('./tenant');

async function gatherFor(ids, fn) {
  const groups = new Map();
  for (const id of [...new Set(ids.map(Number).filter(Boolean))]) { // eslint-disable-line no-restricted-syntax
    const db = (await tenant.dbOf(id)) || null; // eslint-disable-line no-await-in-loop
    groups.set(db, [...(groups.get(db) || []), id]);
  }
  const out = [];
  for (const [db, list] of groups) out.push(...(await tenant.run(db, () => fn(list)))); // eslint-disable-line no-restricted-syntax, no-await-in-loop
  return out;
}

/**
 * Fills doctor fields on rows from each clinic's database. opts: { bid: 'business_id', id: 'doctor_id',
 * map: { doctor_name: 'full_name', … } } — only rows still missing the first mapped field are looked up.
 */
async function fillDoctors(rows, { bid = 'business_id', id = 'doctor_id', map = { doctor_name: 'full_name', doctor_name_en: 'full_name_en' } } = {}) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => r && r[id] && r[bid]);
  const first = Object.keys(map)[0];
  const need = list.filter((r) => r[first] === null || r[first] === undefined);
  if (!need.length) return rows;
  const knex = require('./knex'); // eslint-disable-line global-require
  const cols = [...new Set(['id', 'business_id', ...Object.values(map)])];
  const docs = await gatherFor(need.map((r) => r[bid]), (ids) => knex('doctors').whereIn('business_id', ids).whereIn('id', [...new Set(need.map((r) => r[id]))]).select(cols));
  need.forEach((r) => {
    const d = docs.find((x) => Number(x.id) === Number(r[id]) && Number(x.business_id) === Number(r[bid]));
    if (d) Object.entries(map).forEach(([to, from]) => { r[to] = d[from]; });
  });
  return rows;
}

module.exports = { gatherFor, fillDoctors };
