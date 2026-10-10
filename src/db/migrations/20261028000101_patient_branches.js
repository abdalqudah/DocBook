// Branches kept apart: which branch(es) a patient belongs to. branch_key is 'main' or a branch id. A patient may be in
// both; moving a patient = taking one branch off and putting the other on. A patient with no row is seen in every
// branch (a path that does not know the branch yet); booking a visit in a branch adds that branch.
// Filled once for the clinics that have branches: the branches of each patient's visits, else the main branch.
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('patient_branches'))) {
    await knex.schema.createTable('patient_branches', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('patient_id').unsigned().notNullable().references('patients.id').onDelete('CASCADE');
      t.string('branch_key', 12).notNullable(); // 'main' | branch id
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['patient_id', 'branch_key'], 'pbr_patient_uq');
      t.index(['business_id', 'branch_key'], 'pbr_branch_idx');
    });
    const withBranches = knex('clinic_branches').distinct('business_id');
    await knex.raw(`INSERT IGNORE INTO patient_branches (business_id, patient_id, branch_key)
      SELECT DISTINCT a.business_id, a.patient_id, COALESCE(CAST(a.branch_id AS CHAR), 'main') FROM appointments a
      WHERE a.patient_id IS NOT NULL AND a.business_id IN (${withBranches.toQuery()})`);
    await knex.raw(`INSERT IGNORE INTO patient_branches (business_id, patient_id, branch_key)
      SELECT p.business_id, p.id, 'main' FROM patients p
      WHERE p.business_id IN (${withBranches.toQuery()}) AND NOT EXISTS (SELECT 1 FROM patient_branches pb WHERE pb.patient_id = p.id)`);
  }
};
exports.down = async (knex) => { await knex.schema.dropTableIfExists('patient_branches'); };
