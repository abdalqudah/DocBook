// Waiting-room and attendance door screens: show the clinic name or not, and a message in the middle of the top bar
// ("Welcome", "Happy Eid"…), per screen.
exports.up = async (knex) => {
  for (const table of ['queue_screens', 'attendance_kiosks']) { // eslint-disable-line no-restricted-syntax
    if (!(await knex.schema.hasColumn(table, 'show_name'))) await knex.schema.alterTable(table, (t) => { t.boolean('show_name').notNullable().defaultTo(true); }); // eslint-disable-line no-await-in-loop
    if (!(await knex.schema.hasColumn(table, 'message'))) await knex.schema.alterTable(table, (t) => { t.string('message', 160).nullable(); }); // eslint-disable-line no-await-in-loop
  }
};
exports.down = async (knex) => {
  for (const table of ['queue_screens', 'attendance_kiosks']) { // eslint-disable-line no-restricted-syntax
    if (await knex.schema.hasColumn(table, 'message')) await knex.schema.alterTable(table, (t) => { t.dropColumn('message'); }); // eslint-disable-line no-await-in-loop
    if (await knex.schema.hasColumn(table, 'show_name')) await knex.schema.alterTable(table, (t) => { t.dropColumn('show_name'); }); // eslint-disable-line no-await-in-loop
  }
};
