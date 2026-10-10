// A clinic owner who is also a doctor and was set to "all branches" on the team page (before a doctor's login followed
// its doctor's branches): the doctor now works in every branch, as meant. Once; nothing else changes.
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('doctor_branches'))) return;
  const rows = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').join('doctors as d', 'd.id', 'm.doctor_id')
    .where('r.key', 'owner').where('m.work_branch', '').whereNotNull('m.doctor_id')
    .whereIn('m.business_id', knex('clinic_branches').distinct('business_id'))
    .select('m.business_id', 'm.doctor_id', 'd.branch_id').catch(() => []);
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    const ids = await knex('clinic_branches').where({ business_id: r.business_id }).pluck('id'); // eslint-disable-line no-await-in-loop
    const keys = ['main', ...ids.map(String)].filter((k) => k !== (r.branch_id ? String(r.branch_id) : 'main'));
    if (keys.length) await knex('doctor_branches').insert(keys.map((k) => ({ business_id: r.business_id, doctor_id: r.doctor_id, branch_key: k }))).onConflict(['doctor_id', 'branch_key']).ignore(); // eslint-disable-line no-await-in-loop
  }
};
exports.down = async () => {};
