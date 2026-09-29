// Medical reps & drug warehouses ("vendors") and their link to clinics:
//  • vendors register on the main site, list products and target doctor specialties (e.g. dentistry)
//  • products appear in a clinic's catalog by specialty; a clinic can add a vendor as its supplier and
//    a product as a supply item
//  • vendors publish offers/ads to doctors of the chosen specialties
//  • reps book visits with a doctor in the time the doctor/clinic reserves for reps
//  • clinics send purchase orders (items + quantities) to a supplier by e-mail; linked vendors also see them
// Specialty keys are the ones used for clinics (auth.specialties: dentistry, dermatology, …).
exports.up = async (knex) => {
  await knex.schema.createTable('vendors', (t) => {
    t.increments('id');
    t.string('type', 20).notNullable().defaultTo('rep'); // rep | warehouse | company
    t.string('name', 190).notNullable();
    t.string('name_en', 190);
    t.string('contact_name', 190);
    t.string('email', 190).notNullable();
    t.string('phone', 40);
    t.string('whatsapp', 40);
    t.string('country', 2);
    t.string('city', 100);
    t.text('about');
    t.text('about_en');
    t.specificType('logo', 'MEDIUMBLOB');
    t.string('logo_mime', 40);
    t.string('status', 20).notNullable().defaultTo('pending'); // pending | active | suspended (platform moderation)
    t.timestamp('approved_at').nullable();
    t.integer('approved_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['status']);
  });
  await knex.schema.createTable('vendor_users', (t) => {
    t.increments('id');
    t.integer('vendor_id').unsigned().notNullable().references('vendors.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
    t.string('role', 20).notNullable().defaultTo('owner'); // owner | member
    t.timestamps(true, true);
    t.unique(['vendor_id', 'user_id']);
  });
  await knex.schema.createTable('vendor_specialties', (t) => {
    t.integer('vendor_id').unsigned().notNullable().references('vendors.id').onDelete('CASCADE');
    t.string('specialty', 40).notNullable();
    t.primary(['vendor_id', 'specialty']);
  });

  await knex.schema.createTable('vendor_products', (t) => {
    t.increments('id');
    t.integer('vendor_id').unsigned().notNullable().references('vendors.id').onDelete('CASCADE');
    t.string('name', 190).notNullable();
    t.string('name_en', 190);
    t.string('brand', 120);
    t.string('sku', 80);
    t.text('description');
    t.text('description_en');
    t.string('unit', 40);           // box, pack, bottle…
    t.string('pack_size', 80);      // e.g. "100 pcs"
    t.decimal('price', 12, 2).nullable(); // optional list price
    t.string('currency', 3);
    t.specificType('image', 'MEDIUMBLOB');
    t.string('image_mime', 40);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamps(true, true);
    t.index(['vendor_id', 'is_active']);
  });
  await knex.schema.createTable('vendor_product_specialties', (t) => {
    t.integer('product_id').unsigned().notNullable().references('vendor_products.id').onDelete('CASCADE');
    t.string('specialty', 40).notNullable();
    t.primary(['product_id', 'specialty']);
    t.index(['specialty']);
  });

  await knex.schema.createTable('vendor_offers', (t) => {
    t.increments('id');
    t.integer('vendor_id').unsigned().notNullable().references('vendors.id').onDelete('CASCADE');
    t.string('title', 190).notNullable();
    t.string('title_en', 190);
    t.text('body');
    t.text('body_en');
    t.specificType('image', 'MEDIUMBLOB');
    t.string('image_mime', 40);
    t.date('starts_on').nullable();
    t.date('ends_on').nullable();
    t.string('status', 20).notNullable().defaultTo('draft'); // draft | published | archived
    t.timestamp('published_at').nullable();
    t.timestamps(true, true);
    t.index(['status', 'ends_on']);
  });
  await knex.schema.createTable('vendor_offer_specialties', (t) => {
    t.integer('offer_id').unsigned().notNullable().references('vendor_offers.id').onDelete('CASCADE');
    t.string('specialty', 40).notNullable();
    t.primary(['offer_id', 'specialty']);
    t.index(['specialty']);
  });
  await knex.schema.createTable('vendor_offer_products', (t) => {
    t.integer('offer_id').unsigned().notNullable().references('vendor_offers.id').onDelete('CASCADE');
    t.integer('product_id').unsigned().notNullable().references('vendor_products.id').onDelete('CASCADE');
    t.primary(['offer_id', 'product_id']);
  });
  // What a clinic did with an offer (seen / dismissed) — per clinic, not per person.
  await knex.schema.createTable('vendor_offer_views', (t) => {
    t.integer('offer_id').unsigned().notNullable().references('vendor_offers.id').onDelete('CASCADE');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.timestamp('seen_at').defaultTo(knex.fn.now());
    t.timestamp('dismissed_at').nullable();
    t.primary(['offer_id', 'business_id']);
  });

  // Clinic ↔ vendor: a clinic's supplier can be a registered vendor, a supply item can come from a vendor product.
  await knex.schema.alterTable('suppliers', (t) => {
    t.integer('vendor_id').unsigned().nullable().references('vendors.id').onDelete('SET NULL');
    t.string('contact_name', 190);
  });
  await knex.schema.alterTable('supply_items', (t) => {
    t.integer('vendor_product_id').unsigned().nullable().references('vendor_products.id').onDelete('SET NULL');
  });

  // Rep visits: weekly windows the clinic (or one doctor) reserves for reps, and the bookings made in them.
  await knex.schema.createTable('rep_visit_slots', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('CASCADE'); // null = clinic-wide
    t.string('weekday', 3).notNullable(); // sun … sat
    t.string('start_time', 5).notNullable();
    t.string('end_time', 5).notNullable();
    t.integer('slot_minutes').unsigned().notNullable().defaultTo(15);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamps(true, true);
    t.index(['business_id', 'doctor_id']);
  });
  await knex.schema.createTable('rep_visits', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('doctor_id').unsigned().nullable().references('doctors.id').onDelete('SET NULL');
    t.integer('vendor_id').unsigned().notNullable().references('vendors.id').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable().references('users.id').onDelete('SET NULL'); // the rep who booked
    t.date('visit_date').notNullable();
    t.string('visit_time', 5).notNullable();
    t.integer('duration_minutes').unsigned().notNullable().defaultTo(15);
    t.string('purpose', 500);
    t.string('status', 20).notNullable().defaultTo('requested'); // requested | confirmed | declined | cancelled | done
    t.string('clinic_note', 500);
    t.integer('decided_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['business_id', 'visit_date']);
    t.index(['vendor_id', 'visit_date']);
  });
  await knex.schema.alterTable('businesses', (t) => {
    t.boolean('rep_visits_enabled').notNullable().defaultTo(false);
    t.boolean('rep_visits_auto_confirm').notNullable().defaultTo(false);
    t.integer('po_next_number').unsigned().notNullable().defaultTo(1);
  });

  // Purchase orders sent by a clinic to a supplier (e-mailed; visible to the vendor when the supplier is linked).
  await knex.schema.createTable('purchase_orders', (t) => {
    t.increments('id');
    t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
    t.integer('po_number').unsigned().notNullable();
    t.integer('supplier_id').unsigned().nullable().references('suppliers.id').onDelete('SET NULL');
    t.integer('vendor_id').unsigned().nullable().references('vendors.id').onDelete('SET NULL');
    t.string('supplier_name', 190).notNullable(); // snapshot
    t.string('sent_to_email', 190);
    t.string('status', 20).notNullable().defaultTo('draft'); // draft | sent | acknowledged | received | cancelled
    t.text('notes');
    t.timestamp('sent_at').nullable();
    t.timestamp('acknowledged_at').nullable();
    t.timestamp('received_at').nullable();
    t.integer('created_by').unsigned().nullable().references('users.id').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['business_id', 'po_number']);
    t.index(['vendor_id', 'status']);
  });
  await knex.schema.createTable('purchase_order_items', (t) => {
    t.increments('id');
    t.integer('purchase_order_id').unsigned().notNullable().references('purchase_orders.id').onDelete('CASCADE');
    t.integer('supply_item_id').unsigned().nullable().references('supply_items.id').onDelete('SET NULL');
    t.integer('vendor_product_id').unsigned().nullable().references('vendor_products.id').onDelete('SET NULL');
    t.string('name', 190).notNullable(); // snapshot
    t.string('unit', 40);
    t.decimal('quantity', 15, 2).notNullable();
    t.decimal('received_quantity', 15, 2).notNullable().defaultTo(0);
    t.decimal('unit_cost', 12, 2).nullable();
  });
};

exports.down = async (knex) => {
  for (const tb of ['purchase_order_items', 'purchase_orders', 'rep_visits', 'rep_visit_slots', 'vendor_offer_views', 'vendor_offer_products',
    'vendor_offer_specialties', 'vendor_offers', 'vendor_product_specialties']) await knex.schema.dropTableIfExists(tb); // eslint-disable-line no-await-in-loop
  await knex.schema.alterTable('supply_items', (t) => { t.dropForeign('vendor_product_id'); t.dropColumn('vendor_product_id'); });
  await knex.schema.alterTable('suppliers', (t) => { t.dropForeign('vendor_id'); t.dropColumn('vendor_id'); t.dropColumn('contact_name'); });
  await knex.schema.alterTable('businesses', (t) => { t.dropColumn('rep_visits_enabled'); t.dropColumn('rep_visits_auto_confirm'); t.dropColumn('po_next_number'); });
  for (const tb of ['vendor_products', 'vendor_specialties', 'vendor_users', 'vendors']) await knex.schema.dropTableIfExists(tb); // eslint-disable-line no-await-in-loop
};
