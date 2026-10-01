// A doctor's working hours follow the clinic's usual week ("clinic") or are the doctor's own ("custom"). Doctors whose
// hours already equal the clinic's week start as "clinic"; everyone else keeps their own hours unchanged.
const parse = (v) => { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
const norm = (w) => JSON.stringify(Object.keys(w || {}).sort().map((k) => [k, Boolean(w[k] && w[k].enabled), ((w[k] && w[k].shifts) || []).map((s) => `${s.start}-${s.end}`), ((w[k] && w[k].breaks) || []).map((s) => `${s.start}-${s.end}`)]));

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('doctors', 'hours_mode'))) {
    await knex.schema.alterTable('doctors', (t) => { t.string('hours_mode', 8).notNullable().defaultTo('custom'); });
  }
  const clinics = await knex('businesses').whereNotNull('default_working_hours').select('id', 'default_working_hours');
  for (const c of clinics) {
    const week = norm(parse(c.default_working_hours));
    const docs = await knex('doctors').where({ business_id: c.id }).select('id', 'working_hours'); // eslint-disable-line no-await-in-loop
    const same = docs.filter((d) => norm(parse(d.working_hours)) === week).map((d) => d.id);
    if (same.length) await knex('doctors').whereIn('id', same).update({ hours_mode: 'clinic' }); // eslint-disable-line no-await-in-loop
  }
};
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('doctors', 'hours_mode')) await knex.schema.alterTable('doctors', (t) => { t.dropColumn('hours_mode'); });
};
