// 1) A second, square clinic logo for square places (booking summary, the public pages' badge, the browser icon);
//    the main logo stays for wide places (website header, invoices).
// 2) Prices on the website and the booking pages are hidden unless the clinic turns them on (Website → Booking).
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('businesses', 'logo_square_mime'))) {
    await knex.schema.alterTable('businesses', (t) => {
      t.specificType('logo_square', 'MEDIUMBLOB').nullable();
      t.string('logo_square_mime', 40).nullable();
      t.integer('logo_square_version').unsigned().notNullable().defaultTo(0);
    });
  }
  await knex.raw('ALTER TABLE businesses ALTER prices_on_site SET DEFAULT 0, ALTER prices_on_booking SET DEFAULT 0');
  await knex('businesses').update({ prices_on_site: false, prices_on_booking: false });
};
exports.down = async (knex) => {
  await knex.raw('ALTER TABLE businesses ALTER prices_on_site SET DEFAULT 1, ALTER prices_on_booking SET DEFAULT 1');
  if (await knex.schema.hasColumn('businesses', 'logo_square_mime')) {
    await knex.schema.alterTable('businesses', (t) => { t.dropColumn('logo_square'); t.dropColumn('logo_square_mime'); t.dropColumn('logo_square_version'); });
  }
};
