// Program comparison: up to four programs side by side. Visitors build it in their session; saving creates an
// unguessable link that can be shared by e-mail or WhatsApp, printed or saved as PDF from the browser.
const knex = require('../../db/knex');
const { randomToken } = require('../../core/tokens');
const finder = require('./finder.service');
const money = require('./money');

const MAX = 4;

function current(req) { return (req.session && Array.isArray(req.session.compare) ? req.session.compare : []).map(Number).filter(Boolean).slice(0, MAX); }

function toggle(req, id) {
  const list = current(req);
  const n = Number(id);
  const next = list.includes(n) ? list.filter((x) => x !== n) : [...list, n].slice(-MAX);
  req.session.compare = next;
  return next;
}

/** Rows for the comparison table, with a living-cost estimate converted to USD. */
async function build(ids) {
  const programs = await finder.programsByIds(ids.slice(0, MAX));
  for (const p of programs) {
    const mid = p.living_month_min || p.living_month_max ? ((Number(p.living_month_min) || Number(p.living_month_max)) + (Number(p.living_month_max) || Number(p.living_month_min))) / 2 : null;
    p.living_year = mid ? Math.round(mid * 12) : null;
    p.living_year_usd = mid ? await money.toUsd(mid * 12, p.dest_currency || 'USD') : null; // eslint-disable-line no-await-in-loop
    p.documents_required = finder.parseJson(p.documents_required);
    p.scholarships = await knex('scholarships').where({ is_active: true }).where((w) => w.where('program_id', p.id).orWhere('university_id', p.university_id)).select('id', 'slug', 'name_en', 'name_ar').limit(3); // eslint-disable-line no-await-in-loop
  }
  return programs;
}

async function save(ids, { studentId = null, userId = null, title = null } = {}) {
  const token = randomToken(12).replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || randomToken(8);
  await knex('comparisons').insert({ token, title, program_ids: JSON.stringify(ids.slice(0, MAX)), student_id: studentId, created_by: userId });
  return token;
}

async function byToken(token) {
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(String(token || ''))) return null;
  const row = await knex('comparisons').where({ token }).first();
  if (!row) return null;
  return { ...row, program_ids: finder.parseJson(row.program_ids) };
}

module.exports = { current, toggle, build, save, byToken, MAX };
