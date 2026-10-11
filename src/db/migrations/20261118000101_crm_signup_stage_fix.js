// The CRM put every clinic that signed up at "customer" (its account was active), even on a trial or after the trial
// ended. Clinics the admin never moved by hand go back to "trial" unless their subscription is paid or comped.
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('crm_contacts')) || !(await knex.schema.hasTable('clinic_subscriptions'))) return;
  await knex('crm_contacts as c').where({ 'c.source': 'signup', 'c.stage': 'customer' }).whereNotNull('c.business_id')
    .whereNotExists(function paid() { this.select(knex.raw('1')).from('clinic_subscriptions as s').whereRaw('s.business_id = c.business_id').whereIn('s.status', ['active', 'past_due', 'comped']); })
    .whereNotExists(function moved() { this.select(knex.raw('1')).from('crm_activities as a').whereRaw('a.contact_id = c.id').where('a.kind', 'stage'); })
    .update({ stage: 'trial' });
};
exports.down = async () => {};
