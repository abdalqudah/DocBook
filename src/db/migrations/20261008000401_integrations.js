// Google Sheets export and the clinic media library (worker: integrations).
//  • sheet_sync_settings: one row per clinic — connection method (Google account via OAuth, or an Apps Script
//    web app), the encrypted refresh token / web-app URL / shared secret, the spreadsheet created for the clinic,
//    what is exported, the sheet language, the automatic daily run, and the patient-data acknowledgement.
//  • sheet_sync_runs: the log of every export (manual or automatic) with the per-tab result.
//  • clinic_media: images (PNG/JPEG/WebP/GIF) and PDFs uploaded by the clinic, stored as blobs, with folder,
//    Arabic/English alt text and a "public" flag (only public images are served on the clinic page).
//  • media_usages: where a library file is used (the clinic page cover and gallery today). Deleting a file that is
//    in use is warned about; the clinic page reads its cover/gallery from here.
exports.up = async (knex) => {
  await knex.schema.createTable('sheet_sync_settings', (t) => {
    t.integer('business_id').unsigned().notNullable().primary().references('businesses.id').onDelete('CASCADE');
    t.string('method', 10).nullable(); // oauth | webhook | null (not connected)
    t.text('oauth_refresh_enc').nullable();
    t.string('oauth_email', 190).nullable();
    t.string('spreadsheet_id', 120).nullable();
    t.text('webhook_url_enc').nullable();
    t.text('webhook_secret_enc').nullable();
    t.text('tabs').nullable(); // JSON list of tab keys
    t.string('sheet_locale', 5).notNullable().defaultTo('ar');
    t.smallint('months_back').notNullable().defaultTo(12); // 0 = everything
    t.boolean('include_patients').notNullable().defaultTo(false);
    t.integer('patients_ack_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('patients_ack_at').nullable();
    t.boolean('auto_daily').notNullable().defaultTo(false);
    t.timestamp('running_since').nullable();
    t.timestamp('last_run_at').nullable();
    t.string('last_status', 10).nullable(); // ok | partial | failed
    t.timestamps(true, true);
  });

  await knex.schema.createTable('sheet_sync_runs', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('trigger', 10).notNullable(); // manual | auto
    t.string('method', 10).notNullable();
    t.string('status', 10).notNullable(); // running | ok | partial | failed
    t.text('tabs').nullable(); // JSON [{ key, rows, ok, error, truncated }]
    t.integer('rows_total').unsigned().notNullable().defaultTo(0);
    t.string('error', 400).nullable();
    t.integer('started_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('finished_at').nullable();
    t.index(['business_id', 'started_at'], 'sheet_runs_clinic_idx');
  });

  await knex.schema.createTable('clinic_media', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.string('name', 150).notNullable();
    t.string('folder', 60).notNullable().defaultTo('');
    t.string('alt_ar', 255).notNullable().defaultTo('');
    t.string('alt_en', 255).notNullable().defaultTo('');
    t.string('mime', 40).notNullable();
    t.integer('size').unsigned().notNullable();
    t.integer('width').unsigned().nullable();
    t.integer('height').unsigned().nullable();
    t.string('sha', 16).notNullable();
    t.specificType('data', 'MEDIUMBLOB').notNullable();
    t.boolean('is_public').notNullable().defaultTo(false);
    t.integer('uploaded_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['business_id', 'folder'], 'clinic_media_folder_idx');
  });

  await knex.schema.createTable('media_usages', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('media_id').unsigned().notNullable().references('clinic_media.id').onDelete('CASCADE');
    t.string('context', 40).notNullable(); // portal.cover | portal.gallery
    t.integer('ref_id').unsigned().nullable();
    t.smallint('sort_order').notNullable().defaultTo(0);
    t.index(['business_id', 'context'], 'media_usage_ctx_idx');
    t.index(['media_id'], 'media_usage_media_idx');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('media_usages');
  await knex.schema.dropTableIfExists('clinic_media');
  await knex.schema.dropTableIfExists('sheet_sync_runs');
  await knex.schema.dropTableIfExists('sheet_sync_settings');
};
