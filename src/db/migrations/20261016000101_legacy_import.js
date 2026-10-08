// Legacy Patient Recovery & Import (src/modules/legacy): patients, treatments, clinical records and files of a
// previous system (first: Clinica) brought into the clinic as ordinary rows, each tied to its patient by the old
// system's patient id — never by name.
//
//  • patients.legacy_*: where a patient came from (source, the old id and number, the job, when). One old patient →
//    at most one patient per clinic (unique).
//  • import_jobs / import_batches / import_items / import_errors: an import is a job made of uploaded batches (the
//    patients JSON, the attachment ZIPs) and one item per patient or per file; every item keeps its own status so a
//    stopped job (closed browser, restarted server) carries on from where it was. Errors are kept with their stage.
//  • legacy_patients: the old file of each patient (name, phones, group, nationality, links), linked to a patient
//    here once matched or recovered; legacy_patient_links: its original pages in the old system.
//  • legacy_treatments: one row per old treatment; legacy_clinical_records + legacy_clinical_values: the old
//    clinical tables (periodontal, pocket measurements, anesthesia, treatment details…) row by row, field by field;
//    legacy_field_values: any other field of the old record, so nothing of the source is lost.
//  • patient_attachments: files of the old system kept in the clinic's private storage (content-addressed: one
//    copy per SHA-256), linked to the patient; downloaded only through the app with permission.
exports.up = async (knex) => {
  const add = async (table, name, fn) => { if (!(await knex.schema.hasColumn(table, name))) await knex.schema.alterTable(table, fn); };
  await add('patients', 'legacy_source', (t) => { t.string('legacy_source', 20).nullable(); });
  await add('patients', 'legacy_patient_id', (t) => { t.string('legacy_patient_id', 64).nullable(); });
  await add('patients', 'legacy_patient_number', (t) => { t.string('legacy_patient_number', 64).nullable(); });
  await add('patients', 'legacy_import_job_id', (t) => { t.integer('legacy_import_job_id').unsigned().nullable(); });
  await add('patients', 'legacy_imported_at', (t) => { t.timestamp('legacy_imported_at').nullable(); });
  const idx = async (table, name, cols, unique = false) => {
    const r = await knex.raw(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [name]);
    if (!r[0].length) await knex.schema.alterTable(table, (t) => { if (unique) t.unique(cols, name); else t.index(cols, name); });
  };
  await idx('patients', 'patients_legacy_uq', ['business_id', 'legacy_source', 'legacy_patient_id'], true);
  await idx('patients', 'patients_legacy_number_idx', ['business_id', 'legacy_patient_number']);

  const create = async (name, fn) => { if (!(await knex.schema.hasTable(name))) await knex.schema.createTable(name, fn); };
  await create('import_jobs', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('type', 30).notNullable(); // legacy_clinica
    t.string('status', 24).notNullable().defaultTo('draft'); // draft | analyzing | ready | processing | completed | completed_with_issues | failed | cancelled
    t.string('stage', 24).nullable(); // what runs now: patients_analysis | attachments_analysis | patients_import | attachments_import | reconcile
    t.boolean('create_unmatched').notNullable().defaultTo(false);
    t.integer('total').unsigned().notNullable().defaultTo(0);
    t.integer('processed').unsigned().notNullable().defaultTo(0);
    t.integer('success').unsigned().notNullable().defaultTo(0);
    t.integer('failed').unsigned().notNullable().defaultTo(0);
    t.integer('skipped').unsigned().notNullable().defaultTo(0);
    // What the source holds (counted while analysing) and what the system holds after the import (reconciliation).
    t.integer('src_patients').unsigned().notNullable().defaultTo(0);
    t.integer('src_treatments').unsigned().notNullable().defaultTo(0);
    t.integer('src_clinical').unsigned().notNullable().defaultTo(0);
    t.integer('src_links').unsigned().notNullable().defaultTo(0);
    t.integer('src_attachments').unsigned().notNullable().defaultTo(0);
    t.integer('sys_patients').unsigned().nullable();
    t.integer('sys_treatments').unsigned().nullable();
    t.integer('sys_clinical').unsigned().nullable();
    t.integer('sys_attachments').unsigned().nullable();
    t.string('error', 255).nullable();
    t.integer('created_by').unsigned().nullable();
    t.timestamp('started_at').nullable();
    t.timestamp('completed_at').nullable();
    t.timestamp('heartbeat_at').nullable();
    t.string('runner', 40).nullable(); // the process running it now (with heartbeat_at: a stopped one is taken over)
    t.timestamps(true, true);
    t.index(['business_id', 'status'], 'ijobs_status_idx');
  });
  await create('import_batches', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('job_id').unsigned().notNullable().references('import_jobs.id').onDelete('CASCADE');
    t.string('kind', 20).notNullable(); // patients_json | attachments_zip
    t.string('original_name', 255).notNullable();
    t.string('stored_path', 500).nullable(); // private storage; removed when the job no longer needs it
    t.bigInteger('size').unsigned().notNullable().defaultTo(0);
    t.string('sha256', 64).notNullable();
    t.integer('batch_no').unsigned().nullable();
    t.integer('batch_total').unsigned().nullable();
    t.string('status', 20).notNullable().defaultTo('uploaded'); // uploaded | analyzing | valid | invalid | duplicate
    t.integer('entries').unsigned().notNullable().defaultTo(0);
    t.integer('valid_files').unsigned().notNullable().defaultTo(0);
    t.integer('invalid_files').unsigned().notNullable().defaultTo(0);
    t.string('error', 255).nullable();
    t.integer('uploaded_by').unsigned().nullable();
    t.timestamp('uploaded_at').notNullable().defaultTo(knex.fn.now());
    t.index(['job_id', 'kind'], 'ibatch_job_idx');
  });
  await create('import_items', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('job_id').unsigned().notNullable().references('import_jobs.id').onDelete('CASCADE');
    t.integer('batch_id').unsigned().nullable();
    t.string('kind', 12).notNullable(); // patient | attachment
    t.string('ref', 500).notNullable(); // patient: the old id; attachment: its path in the ZIP
    t.string('legacy_patient_id', 64).nullable();
    t.string('legacy_patient_number', 64).nullable();
    t.string('display_name', 190).nullable();
    t.bigInteger('src_offset').unsigned().nullable(); // where the record is in the source (patients JSON): byte offset…
    t.integer('src_length').unsigned().nullable(); // …and length, so one patient is read again without the rest
    t.string('source_checksum', 64).nullable();
    t.string('match', 12).nullable(); // matched | unmatched | new
    t.string('status', 12).notNullable().defaultTo('pending'); // pending | processing | imported | failed | skipped | duplicate | unmatched | invalid
    t.integer('target_id').unsigned().nullable(); // patient id / attachment id
    t.integer('treatments').unsigned().notNullable().defaultTo(0);
    t.integer('clinical').unsigned().notNullable().defaultTo(0);
    t.integer('links').unsigned().notNullable().defaultTo(0);
    t.bigInteger('size').unsigned().nullable();
    t.string('mime', 100).nullable();
    t.string('message', 255).nullable();
    t.integer('attempts').unsigned().notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.unique(['job_id', 'kind', 'ref'], 'iitems_ref_uq');
    t.index(['job_id', 'kind', 'status'], 'iitems_status_idx');
    t.index(['business_id', 'legacy_patient_id'], 'iitems_legacy_idx');
  });
  await create('import_errors', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('job_id').unsigned().notNullable().references('import_jobs.id').onDelete('CASCADE');
    t.integer('item_id').unsigned().nullable();
    t.integer('batch_id').unsigned().nullable();
    t.string('legacy_patient_id', 64).nullable();
    t.string('file', 500).nullable();
    t.string('stage', 30).notNullable();
    t.string('error_code', 40).notNullable();
    t.string('message', 500).nullable();
    t.string('level', 8).notNullable().defaultTo('error'); // error | warning
    t.string('status', 10).notNullable().defaultTo('open'); // open | ignored | resolved
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['job_id', 'status'], 'ierr_job_idx');
  });
  await create('legacy_patients', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('patient_id').unsigned().nullable().references('patients.id').onDelete('SET NULL');
    t.string('legacy_source', 20).notNullable();
    t.string('legacy_patient_id', 64).notNullable();
    t.string('legacy_patient_number', 64).nullable();
    t.string('old_name', 190).nullable();
    t.string('old_mobile', 60).nullable();
    t.string('old_telephone', 60).nullable();
    t.string('old_group', 190).nullable();
    t.string('nationality', 100).nullable();
    t.string('gender', 20).nullable();
    t.string('birth_date', 40).nullable();
    t.string('email', 190).nullable();
    t.string('source_checksum', 64).nullable();
    t.integer('import_job_id').unsigned().nullable();
    t.timestamp('imported_at').notNullable().defaultTo(knex.fn.now());
    t.timestamps(true, true);
    t.unique(['business_id', 'legacy_source', 'legacy_patient_id'], 'lpat_legacy_uq');
    t.index(['business_id', 'patient_id'], 'lpat_patient_idx');
    t.index(['business_id', 'legacy_patient_number'], 'lpat_number_idx');
  });
  await create('legacy_patient_links', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('legacy_patient_ref').unsigned().notNullable().references('legacy_patients.id').onDelete('CASCADE');
    t.string('label', 190).nullable();
    t.string('url', 1000).notNullable();
    t.index(['legacy_patient_ref'], 'lplink_idx');
  });
  await create('legacy_treatments', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('legacy_patient_ref').unsigned().notNullable().references('legacy_patients.id').onDelete('CASCADE');
    t.integer('patient_id').unsigned().nullable().references('patients.id').onDelete('SET NULL');
    t.string('legacy_patient_id', 64).notNullable();
    t.string('row_key', 64).notNullable(); // the old treatment id, else a fingerprint — the same treatment is never added twice
    t.integer('position').unsigned().notNullable().defaultTo(0);
    t.string('treatment_date', 40).nullable(); // as written in the source; treatment_on when it reads as a date
    t.date('treatment_on').nullable();
    t.string('tooth', 60).nullable();
    t.text('description').nullable();
    t.string('doctor', 190).nullable();
    t.decimal('price', 14, 3).nullable();
    t.string('price_raw', 60).nullable();
    t.string('type', 120).nullable();
    t.string('status', 60).nullable();
    t.string('complete_date', 40).nullable();
    t.text('note').nullable();
    t.string('referred_by', 190).nullable();
    t.integer('import_job_id').unsigned().nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['legacy_patient_ref', 'row_key'], 'ltreat_row_uq');
    t.index(['business_id', 'patient_id'], 'ltreat_patient_idx');
  });
  await create('legacy_clinical_records', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('legacy_patient_ref').unsigned().notNullable().references('legacy_patients.id').onDelete('CASCADE');
    t.integer('patient_id').unsigned().nullable().references('patients.id').onDelete('SET NULL');
    t.string('legacy_patient_id', 64).notNullable();
    t.string('table_key', 60).notNullable(); // periodontal | pocket_measurements | pocket_distribution | anesthesia | treatment_details_1 | …
    t.string('row_key', 64).notNullable();
    t.integer('position').unsigned().notNullable().defaultTo(0);
    t.integer('import_job_id').unsigned().nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['legacy_patient_ref', 'table_key', 'row_key'], 'lclin_row_uq');
    t.index(['business_id', 'patient_id', 'table_key'], 'lclin_patient_idx');
  });
  await create('legacy_clinical_values', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('record_id').unsigned().notNullable().references('legacy_clinical_records.id').onDelete('CASCADE');
    t.integer('position').unsigned().notNullable().defaultTo(0);
    t.string('field', 190).notNullable();
    t.text('value').nullable();
    t.index(['record_id'], 'lcval_record_idx');
  });
  await create('legacy_field_values', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('owner_type', 12).notNullable(); // patient | treatment
    t.integer('owner_id').unsigned().notNullable();
    t.integer('position').unsigned().notNullable().defaultTo(0);
    t.string('field', 190).notNullable();
    t.text('value').nullable();
    t.index(['owner_type', 'owner_id'], 'lfval_owner_idx');
  });
  await create('patient_attachments', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('patient_id').unsigned().nullable().references('patients.id').onDelete('SET NULL');
    t.integer('legacy_patient_ref').unsigned().nullable().references('legacy_patients.id').onDelete('SET NULL');
    t.string('legacy_source', 20).nullable();
    t.string('legacy_patient_id', 64).nullable();
    t.string('legacy_patient_number', 64).nullable();
    t.string('original_filename', 255).notNullable();
    t.string('stored_filename', 255).notNullable();
    t.string('mime_type', 100).notNullable();
    t.string('category', 12).notNullable(); // image | document | other
    t.bigInteger('file_size').unsigned().notNullable();
    t.bigInteger('stored_bytes').unsigned().notNullable().defaultTo(0); // 0 for a duplicate that shares a stored copy
    t.string('storage_path', 255).notNullable(); // relative to the private store
    t.string('checksum', 64).notNullable(); // SHA-256
    t.integer('duplicate_of').unsigned().nullable();
    t.string('source_url', 1000).nullable();
    t.string('zip_path', 500).nullable();
    t.integer('import_batch_id').unsigned().nullable();
    t.integer('import_job_id').unsigned().nullable();
    t.integer('uploaded_by').unsigned().nullable();
    t.timestamp('uploaded_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['business_id', 'legacy_patient_id', 'checksum'], 'patt_patient_sum_uq');
    t.index(['business_id', 'patient_id'], 'patt_patient_idx');
    t.index(['business_id', 'checksum'], 'patt_sum_idx');
  });
};

exports.down = async (knex) => {
  for (const tb of ['patient_attachments', 'legacy_field_values', 'legacy_clinical_values', 'legacy_clinical_records', 'legacy_treatments', 'legacy_patient_links', 'legacy_patients', 'import_errors', 'import_items', 'import_batches', 'import_jobs']) {
    await knex.schema.dropTableIfExists(tb); // eslint-disable-line no-await-in-loop
  }
  for (const [n] of [['patients_legacy_number_idx'], ['patients_legacy_uq']]) {
    const r = await knex.raw('SHOW INDEX FROM `patients` WHERE Key_name = ?', [n]); // eslint-disable-line no-await-in-loop
    if (r[0].length) await knex.raw(`ALTER TABLE \`patients\` DROP INDEX \`${n}\``); // eslint-disable-line no-await-in-loop
  }
  for (const c of ['legacy_imported_at', 'legacy_import_job_id', 'legacy_patient_number', 'legacy_patient_id', 'legacy_source']) {
    if (await knex.schema.hasColumn('patients', c)) await knex.schema.alterTable('patients', (t) => { t.dropColumn(c); }); // eslint-disable-line no-await-in-loop
  }
};
