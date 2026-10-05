// Shared helpers for people records (leads and students): names, references, phone matching, duplicates.
const crypto = require('crypto');
const knex = require('../../db/knex');
const { shortCode } = require('../../core/tokens');

const fullName = (p) => [p && p.first_name, p && p.last_name].filter(Boolean).join(' ') || '—';
const digits = (v) => String(v || '').replace(/\D/g, '');
/** Last 9 digits of a phone number: matches "+962 79…", "0079…" and "079…" as the same person. */
const phoneTail = (v) => { const d = digits(v); return d.length >= 7 ? d.slice(-9) : null; };

/** Splits "Ahmad Al Ali" into first / last name. */
function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first_name: '', last_name: null };
  return { first_name: parts[0].slice(0, 80), last_name: parts.slice(1).join(' ').slice(0, 80) || null };
}

async function newRef(table, prefix) {
  for (let i = 0; i < 6; i += 1) {
    const ref = `${prefix}-${shortCode(6)}`;
    if (!(await knex(table).where({ ref }).first('id'))) return ref; // eslint-disable-line no-await-in-loop
  }
  throw new Error('Could not allocate a reference');
}

/** Keyed hash of a passport number (letters/digits only, upper case) — comparable, not reversible. */
function passportHash(value) {
  const v = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.length < 5) return null;
  const key = process.env.APP_KEY || process.env.SESSION_SECRET || 'gec-dev-passport';
  return crypto.createHmac('sha256', key).update(`passport:${v}`).digest('hex');
}

/**
 * Possible duplicates of a person among leads and students (same e-mail, same phone, same passport).
 * `exclude` = { leadId, studentId } to leave the record itself out. Merged / lost leads are ignored.
 */
async function findDuplicates({ email, phone, passport }, exclude = {}) {
  const tail = phoneTail(phone);
  const pHash = passportHash(passport);
  const mail = String(email || '').trim().toLowerCase() || null;
  if (!mail && !tail && !pHash) return [];
  const match = (q) => q.where((w) => {
    if (mail) w.orWhere('email', mail);
    if (tail) w.orWhere('phone_tail', tail);
  });
  const leads = (mail || tail) ? await match(knex('leads').whereNot('status', 'merged')).modify((q) => { if (exclude.leadId) q.whereNot('id', exclude.leadId); })
    .select('id', 'ref', 'first_name', 'last_name', 'email', 'phone', 'phone_tail', 'status', 'student_id', 'created_at').limit(10) : [];
  const students = await knex('students').whereNull('merged_into_id').where((w) => {
    if (mail) w.orWhere('email', mail);
    if (tail) w.orWhere('phone_tail', tail);
    if (pHash) w.orWhere('passport_hash', pHash);
  }).modify((q) => { if (exclude.studentId) q.whereNot('id', exclude.studentId); })
    .select('id', 'ref', 'first_name', 'last_name', 'email', 'phone', 'phone_tail', 'passport_hash', 'status', 'created_at').limit(10);
  const why = (r) => [mail && r.email === mail && 'email', tail && r.phone_tail === tail && 'phone', pHash && r.passport_hash === pHash && 'passport'].filter(Boolean);
  return [
    ...leads.filter((l) => !(exclude.studentId && l.student_id === exclude.studentId)).map((l) => ({ kind: 'lead', ...l, matched: why(l) })),
    ...students.map((s) => ({ kind: 'student', ...s, matched: why(s) })),
  ];
}

module.exports = { fullName, splitName, phoneTail, digits, newRef, passportHash, findDuplicates };
