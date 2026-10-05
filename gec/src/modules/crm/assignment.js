// Counsellor assignment for new leads: manual, round-robin, or destination rules then round-robin.
// Round-robin picks the active counsellor who was assigned least recently (fair across restarts and processes).
const knex = require('../../db/knex');
const settings = require('../settings/settings.service');

async function candidates({ branchId, countries }) {
  const q = knex('employees as e').join('users as u', 'u.id', 'e.user_id')
    .where({ 'e.is_counsellor': true, 'e.auto_assign': true, 'u.status': 'active' })
    .select('e.id', 'e.branch_id', 'e.countries', 'e.last_assigned_at');
  let list = await q;
  const parse = (v) => { if (!v) return []; if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch { return []; } };
  if (branchId) { const same = list.filter((c) => c.branch_id === branchId); if (same.length) list = same; }
  if (countries && countries.length) {
    const wanted = new Set(countries.map((c) => String(c).toLowerCase()));
    const fit = list.filter((c) => parse(c.countries).some((x) => wanted.has(String(x).toLowerCase())));
    if (fit.length) return { list: fit, rule: 'destination' };
  }
  return { list, rule: 'round_robin' };
}

/** Chooses a counsellor for a lead and stamps them; returns { employeeId, rule } or null (manual / nobody). */
async function pick({ branchId = null, countries = [] } = {}, trx = knex) {
  const mode = (await settings.get('leads')).assignment;
  if (mode === 'manual') return null;
  const { list, rule } = await candidates({ branchId, countries: mode === 'rules' ? countries : [] });
  if (!list.length) return null;
  list.sort((a, b) => (a.last_assigned_at ? new Date(a.last_assigned_at).getTime() : 0) - (b.last_assigned_at ? new Date(b.last_assigned_at).getTime() : 0) || a.id - b.id);
  const chosen = list[0];
  await trx('employees').where({ id: chosen.id }).update({ last_assigned_at: new Date() });
  return { employeeId: chosen.id, rule };
}

module.exports = { pick };
