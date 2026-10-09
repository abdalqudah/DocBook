// "Clean up doubled appointments": after Clinica's calendar was read, a patient's day may still have a visit the file
// import made at 09:00 beside the real appointment of that day (for instance a second doctor's treatments that day,
// or a pull run before 2.9.5). Such a leftover is folded into the calendar appointment of the same patient and day
// (same doctor first, else the earliest): its treatments and plan items move over, its doctor / branch / note fill
// what the appointment lacks, and it is removed.
// Only what the import itself made is touched: a leftover is kept when anything of the clinic hangs on it (an
// invoice, a payment, a consultation, a prescription, a file, a follow-up… — any table with an appointment_id), when
// it was checked in, or when it was charged. Owner-only, previewed, audited; runs in the background; safe to repeat.
const knex = require('../../db/knex');
const tenant = require('../../db/tenant');
const audit = require('../../core/audit');

const SOURCE = 'clinica';
const MOVED = ['legacy_treatments', 'dental_plan_items']; // moved over to the kept appointment
const IGNORED = ['appointments', ...MOVED, 'legacy_doctor_map'];
const running = new Map();
const last = new Map(); // businessId → the last run's report

/** Leftovers of the import on a day Clinica's calendar has an appointment for the same patient. */
function leftovers(businessId) {
  return knex('appointments as l').where({ 'l.business_id': businessId, 'l.external_source': SOURCE })
    .where((w) => w.where('l.external_uid', 'like', 'clinica:%:v:%')
      .orWhere((x) => x.where('l.external_uid', 'like', 'clinica:%:a:%').whereNot('l.external_uid', 'like', 'clinica:%:a:cal:%').where('l.appointment_time', 'like', '09:00%')))
    .whereExists(function cal() {
      this.select(knex.raw('1')).from('appointments as k').whereRaw('k.business_id = l.business_id AND k.patient_id = l.patient_id AND k.appointment_date = l.appointment_date')
        .where('k.external_source', SOURCE).where('k.external_uid', 'like', 'clinica:%:a:cal:%');
    });
}

/** Tables that point at an appointment (read from the database itself, so a table added later is covered too). */
async function refTables() {
  const rows = await knex('information_schema.COLUMNS').whereRaw('TABLE_SCHEMA = DATABASE()').where('COLUMN_NAME', 'appointment_id').distinct('TABLE_NAME as t');
  return rows.map((r) => r.t).filter((t) => !IGNORED.includes(t));
}

/** The leftovers that something of the clinic hangs on (kept). */
async function blockedOf(ids) {
  const out = new Set();
  if (!ids.length) return out;
  for (const t of await refTables()) { // eslint-disable-line no-restricted-syntax
    (await knex(t).whereIn('appointment_id', ids).distinct('appointment_id').pluck('appointment_id').catch(() => [])).forEach((x) => out.add(Number(x))); // eslint-disable-line no-await-in-loop
  }
  (await knex('appointments').whereIn('parent_appointment_id', ids).distinct('parent_appointment_id').pluck('parent_appointment_id')).forEach((x) => out.add(Number(x)));
  return out;
}
const touched = (a) => Boolean(a.checked_in) || !['imported', 'unpaid', null, undefined].includes(a.payment_status) || Number(a.amount_due || 0) > 0;

async function candidates(businessId) {
  const rows = await leftovers(businessId).select('l.id', 'l.patient_id', 'l.appointment_date', 'l.doctor_id', 'l.branch_id', 'l.notes', 'l.checked_in', 'l.payment_status', 'l.amount_due');
  const blocked = new Set();
  for (let i = 0; i < rows.length; i += 500) (await blockedOf(rows.slice(i, i + 500).map((r) => r.id))).forEach((x) => blocked.add(x)); // eslint-disable-line no-await-in-loop
  const ok = []; const kept = [];
  rows.forEach((r) => ((blocked.has(Number(r.id)) || touched(r)) ? kept : ok).push(r));
  return { ok, kept };
}

/** What a run would do (for the page). */
async function preview(businessId) {
  const { ok, kept } = await candidates(businessId);
  return { doubled: ok.length, kept: kept.length, running: running.has(businessId), last: last.get(businessId) || null };
}

async function run(ctx) {
  const b = ctx.businessId;
  const { ok, kept } = await candidates(b);
  const report = { merged: 0, kept: kept.length, treatments: 0 };
  for (const l of ok) { // eslint-disable-line no-restricted-syntax
    await knex.transaction(async (trx) => { // eslint-disable-line no-await-in-loop
      const cal = await trx('appointments').where({ business_id: b, patient_id: l.patient_id, appointment_date: l.appointment_date, external_source: SOURCE })
        .where('external_uid', 'like', 'clinica:%:a:cal:%').select('id', 'doctor_id', 'branch_id', 'notes', 'appointment_time').orderBy('appointment_time').orderBy('id');
      if (!cal.length || !(await trx('appointments').where({ id: l.id }).first('id'))) return;
      const k = cal.find((c) => l.doctor_id && c.doctor_id === l.doctor_id) || cal[0];
      report.treatments += await trx('legacy_treatments').where({ appointment_id: l.id }).update({ appointment_id: k.id });
      await trx('dental_plan_items').where({ appointment_id: l.id }).update({ appointment_id: k.id });
      const patch = {};
      if (!k.doctor_id && l.doctor_id) patch.doctor_id = l.doctor_id;
      if (!k.branch_id && l.branch_id) patch.branch_id = l.branch_id;
      const n = String(l.notes || '').trim();
      if (n && !String(k.notes || '').includes(n)) patch.notes = [k.notes, n].filter(Boolean).join('\n').slice(0, 3000);
      if (Object.keys(patch).length) await trx('appointments').where({ id: k.id }).update(patch);
      await trx('appointments').where({ id: l.id }).del();
      report.merged += 1;
    });
  }
  last.set(b, { ...report, at: new Date() });
  await audit.record(ctx, 'legacy.appointments_deduped', { entityType: 'business', entityId: b, newValues: report });
  return report;
}

function start(ctx) {
  if (running.has(ctx.businessId)) return running.get(ctx.businessId);
  const p = tenant.runFor(ctx.businessId, () => run(ctx)).finally(() => running.delete(ctx.businessId));
  running.set(ctx.businessId, p);
  p.catch((e) => console.error('[legacy-dedupe]', e.message)); // eslint-disable-line no-console
  return p;
}

module.exports = { preview, run, start };
