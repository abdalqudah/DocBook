// Waiting-room screen: read the patient's name and room aloud after the chime (on by default; off = chime only).
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('queue_screens', 'voice'))) await knex.schema.alterTable('queue_screens', (t) => { t.boolean('voice').notNullable().defaultTo(true); });
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('queue_screens', 'voice')) await knex.schema.alterTable('queue_screens', (t) => { t.dropColumn('voice'); });
};
