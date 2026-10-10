// A doctor who also works in other branches (Doctors → a doctor → also works in): doctors.branch_id stays the main
// one (pay, the default); doctor_branches lists the others ('main' or a branch id). The doctor shows in each of them.
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('doctor_branches'))) {
    await knex.schema.createTable('doctor_branches', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('doctor_id').unsigned().notNullable().references('doctors.id').onDelete('CASCADE');
      t.string('branch_key', 12).notNullable();
      t.unique(['doctor_id', 'branch_key'], 'dbr_doctor_uq');
      t.index(['business_id', 'branch_key'], 'dbr_branch_idx');
    });
  }
};
exports.down = async (knex) => { await knex.schema.dropTableIfExists('doctor_branches'); };
