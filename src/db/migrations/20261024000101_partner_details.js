// Pharmacies, labs and imaging centres (Clinic → Medical setup): more of their details — the person to talk to, a
// second number (landline), city, map link, opening hours, website.
const COLS = [['contact_name', 120], ['phone2', 40], ['city', 100], ['map_url', 500], ['hours', 255], ['website', 255]];
exports.up = async (knex) => {
  for (const [c, n] of COLS) { // eslint-disable-line no-restricted-syntax
    if (!(await knex.schema.hasColumn('clinic_partners', c))) await knex.schema.alterTable('clinic_partners', (t) => { t.string(c, n).nullable(); }); // eslint-disable-line no-await-in-loop
  }
};
exports.down = async (knex) => {
  for (const [c] of COLS) { // eslint-disable-line no-restricted-syntax
    if (await knex.schema.hasColumn('clinic_partners', c)) await knex.schema.alterTable('clinic_partners', (t) => { t.dropColumn(c); }); // eslint-disable-line no-await-in-loop
  }
};
