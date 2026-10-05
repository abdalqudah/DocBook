// Shortlist: programs, universities and scholarships a person saved. Anonymous visitors keep theirs in the session
// (visitor key) until they sign in; then the items move to their student record, where counsellors see them.
const crypto = require('crypto');
const knex = require('../../db/knex');
const events = require('../../core/events');
const { E } = require('../../core/errors');

const TYPES = { program: 'programs', university: 'universities', scholarship: 'scholarships' };

/** Who owns the shortlist for this request: { studentId } or { visitorKey } (created on first use). */
async function ownerOf(req, { create = false } = {}) {
  if (req.user && req.user.kind === 'student') {
    const s = await knex('students').where({ user_id: req.user.id }).first('id');
    if (s) return { studentId: s.id };
  }
  if (!req.session) return null;
  if (!req.session.shortlistKey && create) req.session.shortlistKey = crypto.randomBytes(16).toString('hex');
  return req.session.shortlistKey ? { visitorKey: req.session.shortlistKey } : null;
}
const where = (owner) => (owner.studentId ? { student_id: owner.studentId } : { visitor_key: owner.visitorKey });

async function toggle(owner, type, id, { addedBy = null, on } = {}) {
  if (!TYPES[type]) throw E.validation({ item_type: 'Choose a valid option.' });
  const exists = await knex(TYPES[type]).where({ id, is_active: true }).first('id');
  if (!exists) throw E.notFound();
  const row = await knex('shortlist_items').where({ ...where(owner), item_type: type, item_id: id }).first();
  const want = on === undefined ? !row : on;
  if (want && !row) {
    await knex('shortlist_items').insert({ ...where(owner), item_type: type, item_id: id, added_by: addedBy });
    await events.emit('shortlist.added', { owner, type, id, addedBy });
  } else if (!want && row) await knex('shortlist_items').where({ id: row.id }).del();
  return want;
}

async function ids(owner) {
  if (!owner) return { program: [], university: [], scholarship: [] };
  const rows = await knex('shortlist_items').where(where(owner)).select('item_type', 'item_id');
  const out = { program: [], university: [], scholarship: [] };
  rows.forEach((r) => out[r.item_type].push(r.item_id));
  return out;
}

/** Full items for display. */
async function items(owner) {
  if (!owner) return { programs: [], universities: [], scholarships: [] };
  const rows = await knex('shortlist_items').where(where(owner)).orderBy('created_at', 'desc');
  const byType = (t) => rows.filter((r) => r.item_type === t).map((r) => r.item_id);
  const finder = require('./finder.service'); // eslint-disable-line global-require
  const [programs, universities, scholarships] = await Promise.all([
    finder.programsByIds(byType('program')),
    byType('university').length ? knex('universities as u').leftJoin('destinations as d', 'd.id', 'u.destination_id').whereIn('u.id', byType('university')).select('u.*', 'd.name_en as destination_en', 'd.name_ar as destination_ar') : [],
    byType('scholarship').length ? knex('scholarships').whereIn('id', byType('scholarship')) : [],
  ]);
  const meta = (t, id) => rows.find((r) => r.item_type === t && r.item_id === id) || {};
  return {
    programs: programs.map((p) => ({ ...p, added_at: meta('program', p.id).created_at, added_by: meta('program', p.id).added_by })),
    universities, scholarships, count: rows.length,
  };
}

/** After sign-in: move the visitor's items to the student (duplicates ignored). */
async function adopt(visitorKey, studentId) {
  if (!visitorKey || !studentId) return 0;
  const rows = await knex('shortlist_items').where({ visitor_key: visitorKey });
  for (const r of rows) {
    await knex.raw('INSERT IGNORE INTO shortlist_items (student_id, item_type, item_id, created_at) VALUES (?, ?, ?, ?)', [studentId, r.item_type, r.item_id, r.created_at]); // eslint-disable-line no-await-in-loop
  }
  await knex('shortlist_items').where({ visitor_key: visitorKey }).del();
  return rows.length;
}

/** Student merge: move shortlist rows without breaking the unique keys. */
async function mergeStudents(keepId, dropId, trx = knex) {
  const rows = await trx('shortlist_items').where({ student_id: dropId });
  for (const r of rows) await trx.raw('INSERT IGNORE INTO shortlist_items (student_id, item_type, item_id, added_by, created_at) VALUES (?, ?, ?, ?, ?)', [keepId, r.item_type, r.item_id, r.added_by, r.created_at]); // eslint-disable-line no-await-in-loop
  await trx('shortlist_items').where({ student_id: dropId }).del();
}

module.exports = { ownerOf, toggle, ids, items, adopt, mergeStudents, TYPES };
