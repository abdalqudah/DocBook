// Owner setup journey (worker: owner).
//  • businesses.default_working_hours: the clinic's usual week (same shape as doctors.working_hours), chosen in the
//    setup wizard and used for every doctor added there (each doctor can still have their own hours later).
//  • businesses.setup_dismissed_at: the owner hid the "Finish setting up" checklist on the home page.
exports.up = async (knex) => {
  await knex.schema.alterTable('businesses', (t) => {
    t.json('default_working_hours').nullable();
    t.timestamp('setup_dismissed_at').nullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('businesses', (t) => { t.dropColumn('default_working_hours'); t.dropColumn('setup_dismissed_at'); });
};
