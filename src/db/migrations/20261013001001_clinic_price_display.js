// Clinic-wide price display: show prices on the website (doctors' fees, services) and in online booking. On by default,
// so nothing changes for existing clinics; each doctor's and service's own "show" choice still applies when on.
exports.up = async (knex) => {
  for (const col of ['prices_on_site', 'prices_on_booking']) {
    if (!(await knex.schema.hasColumn('businesses', col))) await knex.schema.alterTable('businesses', (t) => { t.boolean(col).notNullable().defaultTo(true); });
  }
};
exports.down = async (knex) => {
  for (const col of ['prices_on_site', 'prices_on_booking']) {
    if (await knex.schema.hasColumn('businesses', col)) await knex.schema.alterTable('businesses', (t) => { t.dropColumn(col); });
  }
};
