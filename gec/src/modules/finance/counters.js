// Gap-free yearly numbering (INV-2026-0001, RC-2026-0001) under a row lock, safe with concurrent requests.
const knex = require('../../db/knex');

async function next(name, prefix, trx = null) {
  const year = new Date().getUTCFullYear();
  const key = `${name}:${year}`;
  const run = async (t) => {
    await t.raw('INSERT IGNORE INTO counters (`key`, `value`) VALUES (?, 0)', [key]);
    const row = await t('counters').where({ key }).forUpdate().first();
    const value = row.value + 1;
    await t('counters').where({ key }).update({ value });
    return `${prefix}-${year}-${String(value).padStart(4, '0')}`;
  };
  return trx ? run(trx) : knex.transaction(run);
}

module.exports = { next };
