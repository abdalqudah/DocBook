// The clinic (room / chair) number a doctor works in on a day — doctors move from room to room. Reception sets it on
// the calendar and the front desk; the waiting-room screen shows it ("Clinic 3"). Without one for the day, the
// doctor's usual room (doctors.room).
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('doctor_day_rooms'))) {
    await knex.schema.createTable('doctor_day_rooms', (t) => {
      t.increments('id');
      t.integer('business_id').unsigned().notNullable().references('businesses.id').onDelete('CASCADE');
      t.integer('doctor_id').unsigned().notNullable().references('doctors.id').onDelete('CASCADE');
      t.date('day').notNullable();
      t.string('room', 20).nullable();
      t.integer('set_by').unsigned().nullable();
      t.timestamps(true, true);
      t.unique(['doctor_id', 'day'], 'ddr_doctor_day_uq');
      t.index(['business_id', 'day'], 'ddr_business_day_idx');
    });
  }
};
exports.down = async (knex) => { await knex.schema.dropTableIfExists('doctor_day_rooms'); };
