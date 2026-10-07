// A fuller patient file: the clinic's own file number, English name, a second phone, address, nationality, work,
// marital status, blood group, profile category, case manager, how they heard of the clinic, a standing discount,
// an important note (shown on the file, the visit and when booking), current medicines, smoking and alcohol, and for
// women pregnancy and contraceptive pills. Groups (labels such as "Implant", "Ortho", "Hospital") per clinic, and
// the patient's photo kept apart from the record (patient_photos).
const COLS = [
  ['file_number', (t) => t.string('file_number', 30).nullable()],
  ['name_en', (t) => t.string('name_en', 190).nullable()],
  ['phone2', (t) => t.string('phone2', 40).nullable()],
  ['address', (t) => t.string('address', 255).nullable()],
  ['city', (t) => t.string('city', 100).nullable()],
  ['area', (t) => t.string('area', 100).nullable()],
  ['nationality', (t) => t.string('nationality', 2).nullable()],
  ['residence', (t) => t.string('residence', 2).nullable()],
  ['occupation', (t) => t.string('occupation', 120).nullable()],
  ['marital_status', (t) => t.string('marital_status', 12).nullable()],
  ['blood_group', (t) => t.string('blood_group', 4).nullable()],
  ['category', (t) => t.string('category', 16).nullable()],
  ['case_manager_id', (t) => t.integer('case_manager_id').unsigned().nullable()],
  ['referral_source', (t) => t.string('referral_source', 20).nullable()],
  ['referral_detail', (t) => t.string('referral_detail', 190).nullable()],
  ['discount_percent', (t) => t.decimal('discount_percent', 5, 2).nullable()],
  ['important_note', (t) => t.text('important_note').nullable()],
  ['important_on_booking', (t) => t.boolean('important_on_booking').notNullable().defaultTo(false)],
  ['current_medications', (t) => t.text('current_medications').nullable()],
  ['smoker', (t) => t.string('smoker', 8).nullable()],
  ['alcohol', (t) => t.string('alcohol', 8).nullable()],
  ['pregnant', (t) => t.string('pregnant', 8).nullable()],
  ['contraceptive', (t) => t.string('contraceptive', 8).nullable()],
  ['updated_by', (t) => t.integer('updated_by').unsigned().nullable()],
];

exports.up = async (knex) => {
  for (const [name, add] of COLS) {
    if (!(await knex.schema.hasColumn('patients', name))) await knex.schema.alterTable('patients', (t) => { add(t); }); // eslint-disable-line no-await-in-loop
  }
  const idx = await knex.raw("SHOW INDEX FROM patients WHERE Key_name = 'patients_file_number_uq'");
  if (!idx[0].length) await knex.schema.alterTable('patients', (t) => { t.unique(['business_id', 'file_number'], 'patients_file_number_uq'); });
  if (!(await knex.schema.hasTable('patient_groups'))) {
    await knex.schema.createTable('patient_groups', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.string('name', 60).notNullable();
      t.timestamps(true, true);
      t.unique(['business_id', 'name'], 'pgroups_name_uq');
    });
  }
  if (!(await knex.schema.hasTable('patient_group_members'))) {
    await knex.schema.createTable('patient_group_members', (t) => {
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('patient_id').unsigned().notNullable().references('patients.id').onDelete('CASCADE');
      t.integer('group_id').unsigned().notNullable().references('patient_groups.id').onDelete('CASCADE');
      t.primary(['patient_id', 'group_id']);
      t.index(['business_id', 'group_id'], 'pgm_group_idx');
    });
  }
  if (!(await knex.schema.hasTable('patient_photos'))) {
    await knex.schema.createTable('patient_photos', (t) => {
      t.integer('patient_id').unsigned().primary().references('patients.id').onDelete('CASCADE');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.string('mime', 30).notNullable();
      t.integer('size').unsigned().notNullable();
      t.specificType('data', 'MEDIUMBLOB').notNullable();
      t.integer('created_by').unsigned().nullable();
      t.timestamps(true, true);
      t.index(['business_id'], 'pphoto_business_idx');
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('patient_photos');
  await knex.schema.dropTableIfExists('patient_group_members');
  await knex.schema.dropTableIfExists('patient_groups');
  const idx = await knex.raw("SHOW INDEX FROM patients WHERE Key_name = 'patients_file_number_uq'");
  if (idx[0].length) await knex.schema.alterTable('patients', (t) => { t.dropUnique(['business_id', 'file_number'], 'patients_file_number_uq'); });
  for (const [name] of COLS.reverse()) {
    if (await knex.schema.hasColumn('patients', name)) await knex.schema.alterTable('patients', (t) => { t.dropColumn(name); }); // eslint-disable-line no-await-in-loop
  }
};
