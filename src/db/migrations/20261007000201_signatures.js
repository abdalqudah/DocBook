// Doctor signatures and the clinic stamp printed on prescriptions, medical reports, certificates and invoices.
//  • doctor_signatures: one image per doctor (uploaded or drawn on the screen), PNG or JPEG only so that it can be
//    embedded in the PDFs as is.
//  • clinic_stamps: the clinic's stamp image (one per clinic) and where it appears. A row may exist without an
//    image (the clinic chose where the stamp goes before uploading it).
exports.up = async (knex) => {
  await knex.schema.createTable('doctor_signatures', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('doctor_id').unsigned().notNullable().references('doctors.id').onDelete('CASCADE');
    t.specificType('image', 'MEDIUMBLOB').notNullable();
    t.string('mime', 40).notNullable();
    t.string('source', 10).notNullable().defaultTo('upload'); // upload | drawn
    t.integer('width').unsigned();
    t.integer('height').unsigned();
    t.integer('version').unsigned().notNullable().defaultTo(1);
    t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['business_id', 'doctor_id']);
  });

  await knex.schema.createTable('clinic_stamps', (t) => {
    t.integer('business_id').unsigned().notNullable().primary().references('businesses.id').onDelete('CASCADE');
    t.specificType('image', 'MEDIUMBLOB').nullable();
    t.string('mime', 40).nullable();
    t.integer('width').unsigned();
    t.integer('height').unsigned();
    t.integer('version').unsigned().notNullable().defaultTo(0);
    t.boolean('on_prescriptions').notNullable().defaultTo(true);
    t.boolean('on_reports').notNullable().defaultTo(true);
    t.boolean('on_certificates').notNullable().defaultTo(true);
    t.boolean('on_invoices').notNullable().defaultTo(false);
    t.integer('updated_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('clinic_stamps');
  await knex.schema.dropTableIfExists('doctor_signatures');
};
