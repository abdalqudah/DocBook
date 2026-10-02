// Doctor journey (round 8): one form on the visit page — note + quick prescription + "amount to collect" — and one
// button "Finish visit & send to reception".
//
// finish(): in ONE transaction, with the appointment row locked (two clicks / two tabs are serialised):
//   • saves the visit note (SOAP fields + free-text diagnosis) when the member may write notes,
//   • saves the quick prescription (rows with a medication name) when the member may prescribe — the visit's
//     prescription `rx_id` is UPDATED rather than duplicated; without rx_id an identical prescription of the same
//     visit is reused, so pressing Finish twice never creates two prescriptions,
//   • stores the bill the doctor set: appointments.doctor_lines (JSON lines) + appointments.amount_due (their total),
//   • marks the visit completed and no longer "with the doctor" (the live feed picks the change up and reception's
//     screens refresh on their own).
// After the commit: ICD-10 codes (their own service/transaction) and the consultation timer is stopped.
// Refused: cancelled / no-show visits, already paid (or invoiced) visits, blocked time.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { z, validate, optionalString, emptyToUndefined } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const { round } = require('../../core/money');

const MAX_LINES = 20;
const MAX_RX = 30;
const n = (v) => Number(v) || 0;
const parseJson = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || d); } catch { return d; } };
const asList = (v) => (Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.keys(v).sort((x, y) => Number(x) - Number(y)).map((k) => v[k]) : []));
const money = (v) => (v === '' || v === null || v === undefined ? undefined : Number(String(v).replace(/[,\s]/g, '').replace('٫', '.').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))));

// ---------------------------------------------------------------- validation
const noteSchema = z.object({
  subjective: optionalString(10000), objective: optionalString(10000), assessment: optionalString(10000), plan_text: optionalString(10000), diagnosis: optionalString(2000),
});
const rxItemSchema = z.object({
  medicationName: z.string().trim().min(1, 'Required.').max(190), dosage: optionalString(120), frequency: optionalString(120), duration: optionalString(120), instructions: optionalString(500),
});
const lineSchema = z.object({
  name: z.preprocess(emptyToUndefined, z.string().trim().max(190).optional()),
  name_en: z.preprocess(emptyToUndefined, z.string().trim().max(190).optional()),
  service_id: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  qty: z.preprocess((v) => (v === '' || v === undefined || v === null ? 1 : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(1, 'Too small.').max(99, 'Too large.')),
  unit_price: z.preprocess(money, z.number({ invalid_type_error: 'Enter a number.' }).finite('Enter a number.').min(0, 'Must be zero or more.').max(1e6, 'Too large.').optional()),
});

/** Rows of the quick prescription that carry a medication name (blank rows are ignored). */
function cleanRx(input) {
  const rows = asList(input).filter((r) => r && String(r.medicationName || '').trim());
  if (rows.length > MAX_RX) throw E.validation({ rx: 'Too large.' });
  return rows.map((r, i) => {
    let d;
    try { d = validate(rxItemSchema, r); } catch (err) {
      const [k, msg] = Object.entries(err.details || { _: 'Required.' })[0];
      throw E.validation({ rx: msg, [`rx.${i}.${k}`]: msg });
    }
    return Object.fromEntries(Object.entries({ medicationName: d.medicationName, dosage: d.dosage, frequency: d.frequency, duration: d.duration, instructions: d.instructions }).filter(([, v]) => v));
  });
}

/**
 * Bill lines from the form. A row with neither a price nor a name/service is a blank row and is dropped; a row
 * without a name and without a service is the consultation line (name null, like the cashier's default line).
 * Returns { lines, total } — total rounded to the currency's precision. At least one line is required.
 */
function cleanLines(input, currency) {
  const raw = asList(input).filter((r) => r && (String(r.unit_price === undefined ? '' : r.unit_price).trim() !== '' || String(r.name || '').trim() || String(r.service_id || '').trim()));
  if (!raw.length) throw E.validation({ amount: 'Required.' });
  if (raw.length > MAX_LINES) throw E.validation({ amount: 'Too large.' });
  const lines = raw.map((r, i) => {
    let d;
    try { d = validate(lineSchema, r); } catch (err) {
      const first = err.details ? Object.values(err.details)[0] : 'Enter a number.';
      throw E.validation({ amount: first, [`lines.${i}`]: first });
    }
    // A service row without a price takes the service's price (filled in by finish(); forms without JavaScript).
    if (d.unit_price === undefined && !d.service_id) throw E.validation({ amount: 'Required.', [`lines.${i}`]: 'Required.' });
    const line = { name: d.name || null, name_en: d.name_en || null, service_id: d.service_id || null, qty: d.qty, unit_price: d.unit_price === undefined ? null : round(d.unit_price, currency) };
    if (!line.name && !line.service_id) line.consultation = true;
    return line;
  });
  return { lines, total: totalOf(lines, currency) };
}

const totalOf = (lines, currency) => round(lines.reduce((s, l) => s + n(l.qty || 1) * n(l.unit_price), 0), currency);

// ---------------------------------------------------------------- the bill the doctor sees
/** The pre-filled bill: the doctor's saved lines, else the booked service at its price, else the consultation fee. */
function defaultLines(a) {
  const saved = parseJson(a.doctor_lines, null);
  if (Array.isArray(saved) && saved.length) return saved;
  if (a.service_id && a.service_name) {
    return [{ name: a.service_name, name_en: a.service_name_en || null, service_id: a.service_id, qty: 1, unit_price: n(a.service_price) > 0 ? n(a.service_price) : n(a.amount_due) }];
  }
  return [{ name: null, name_en: null, service_id: null, qty: 1, unit_price: n(a.amount_due) || n(a.consultation_fee), consultation: true }];
}

/** Bill data for the page: lines, total, clinic services the doctor may add (shared ones + this doctor's). */
async function billFor(ctx, apptId) {
  const a = await knex('appointments as a').leftJoin('services as s', function j() { this.on('s.id', 'a.service_id').andOn('s.business_id', 'a.business_id'); }).leftJoin('doctors as d', function j() { this.on('d.id', 'a.doctor_id').andOn('d.business_id', 'a.business_id'); })
    .where({ 'a.business_id': ctx.businessId, 'a.id': apptId })
    .first('a.id', 'a.service_id', 'a.amount_due', 'a.doctor_lines', 'a.doctor_id', 'a.doctor_finished_at', 's.name as service_name', 's.name_en as service_name_en', 's.price as service_price', 'd.consultation_fee');
  if (!a) throw E.notFound('Appointment');
  const lines = defaultLines(a);
  const services = await knex('services').where({ business_id: ctx.businessId, is_active: true })
    .andWhere((w) => { w.whereNull('doctor_id'); if (a.doctor_id) w.orWhere('doctor_id', a.doctor_id); })
    .orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('id', 'name', 'name_en', 'price');
  return {
    lines, total: totalOf(lines, ctx.currency), services,
    finishedAt: a.doctor_finished_at || null, fromDoctor: Boolean(parseJson(a.doctor_lines, null)),
  };
}

// ---------------------------------------------------------------- writes
async function lockVisit(trx, ctx, apptId) {
  const a = await trx('appointments').where({ business_id: ctx.businessId, id: Number(apptId) })
    .modify((q) => { if (ctx.ownDoctorId) q.where('doctor_id', ctx.ownDoctorId); }).forUpdate().first();
  if (!a || a.appointment_type === 'blocked') throw E.notFound('Appointment');
  return a;
}

async function writeNote(trx, ctx, a, note) {
  const patch = Object.fromEntries(Object.entries(note).map(([k, v]) => [k, v || null]));
  const existing = await trx('consultations').where({ business_id: ctx.businessId, appointment_id: a.id }).first();
  if (existing) {
    const changed = Object.keys(patch).some((k) => (existing[k] || null) !== patch[k]);
    if (!changed) return false;
    await trx('consultations').where({ id: existing.id }).update({ ...patch, updated_at: new Date() });
  } else {
    if (!Object.values(patch).some(Boolean)) return false;
    await trx('consultations').insert({ business_id: ctx.businessId, appointment_id: a.id, doctor_id: a.doctor_id, patient_id: a.patient_id, patient_name: a.patient_name, patient_phone: a.patient_phone, ...patch });
  }
  await audit.record(ctx, 'consultation.note', { entityType: 'appointment', entityId: a.id, newValues: Object.fromEntries(Object.keys(patch).map((k) => [k, '[updated]'])) }, trx);
  return true;
}

/** Creates or updates the visit's quick prescription. Returns its id (or the given rx id when there are no rows). */
async function writeRx(trx, ctx, a, items, { rxId, notes, diagnosis }) {
  let target = null;
  if (rxId) {
    target = await trx('prescriptions').where({ business_id: ctx.businessId, appointment_id: a.id, id: Number(rxId) }).first();
    if (!target) throw E.validation({ rx: 'Choose a valid value.' });
  }
  if (!items.length) return target ? target.id : null;
  const json = JSON.stringify(items);
  if (!target) {
    // Idempotency without an id (double submit, a second tab): the same items on the same visit are the same prescription.
    const same = await trx('prescriptions').where({ business_id: ctx.businessId, appointment_id: a.id }).orderBy('id', 'desc').select('id', 'items');
    target = same.find((r) => JSON.stringify(parseJson(r.items, [])) === json) || null;
    if (target) return target.id;
    const [id] = await trx('prescriptions').insert({
      business_id: ctx.businessId, appointment_id: a.id, doctor_id: a.doctor_id, patient_id: a.patient_id, patient_name: a.patient_name, patient_phone: a.patient_phone,
      diagnosis: diagnosis || null, items: json, notes: notes || null, created_by: ctx.userId,
    });
    await audit.record(ctx, 'prescription.created', { entityType: 'prescription', entityId: id, newValues: { appointment_id: a.id, items: items.length } }, trx);
    return id;
  }
  const patch = { items: json, notes: notes || null, diagnosis: diagnosis || target.diagnosis || null };
  if (JSON.stringify(parseJson(target.items, [])) !== json || (target.notes || null) !== patch.notes || (target.diagnosis || null) !== patch.diagnosis) {
    await trx('prescriptions').where({ id: target.id }).update(patch);
    await audit.record(ctx, 'prescription.updated', { entityType: 'prescription', entityId: target.id, newValues: { appointment_id: a.id, items: items.length } }, trx);
  }
  return target.id;
}

/** Validates the clinical part of the form (note, ICD codes, prescription rows) before anything is written. */
async function prepareClinical(ctx, input, { note, rx }) {
  const out = { note: null, codes: null, rx: [], rxNotes: null };
  if (note) {
    out.note = validate(noteSchema, input);
    if (input.icd_present === '1') out.codes = await require('../clinicalplus/icd.service').resolveCodes(ctx.businessId, input.icd_codes); // eslint-disable-line global-require
  }
  if (rx) {
    out.rx = cleanRx(input.rx);
    out.rxNotes = validate(z.object({ rx_notes: optionalString(3000) }), input).rx_notes || null;
  }
  return out;
}

async function afterCommit(ctx, a, prep, { stopTimer }) {
  if (prep.codes) await require('../clinicalplus/icd.service').saveDiagnoses(ctx, a, prep.codes, ctx.icdPrimary); // eslint-disable-line global-require
  if (stopTimer) await require('../clinicalplus/timer.service').stop(ctx, a); // eslint-disable-line global-require
}

/**
 * Saves the note and the quick prescription without finishing the visit ("Save" button, autosave-free fallback).
 * opts: { note: may write the note, rx: may prescribe }. Returns { rxId }.
 */
async function saveDraft(ctx, apptId, input, opts) {
  const prep = await prepareClinical(ctx, input, opts);
  let a; let rxId = null;
  await knex.transaction(async (trx) => {
    a = await lockVisit(trx, ctx, apptId);
    if (a.status === 'cancelled') throw E.conflict('APPOINTMENT_CANCELLED', 'This appointment is cancelled.');
    if (prep.note) await writeNote(trx, ctx, a, prep.note);
    if (opts.rx) rxId = await writeRx(trx, ctx, a, prep.rx, { rxId: input.rx_id, notes: prep.rxNotes, diagnosis: prep.note ? prep.note.diagnosis : null });
  });
  await afterCommit({ ...ctx, icdPrimary: input.icd_primary }, a, prep, { stopTimer: false });
  return { rxId };
}

/**
 * Finish visit & send to reception. opts: { note, rx } as in saveDraft (the bill is always part of it).
 * Returns { total, lines, rxId, again } — again = the visit had already been finished by the doctor (amount corrected).
 */
async function finish(ctx, apptId, input, opts = {}) {
  const prep = await prepareClinical(ctx, input, opts);
  const bill = cleanLines(input.lines, ctx.currency);
  let a; let rxId = null; let again = false;
  await knex.transaction(async (trx) => {
    a = await lockVisit(trx, ctx, apptId);
    if (a.status === 'cancelled') throw E.conflict('APPOINTMENT_CANCELLED', 'This appointment is cancelled.');
    if (a.status === 'no_show') throw new AppError('VISIT_NO_SHOW', 'The patient did not come to this appointment.', 409);
    if (a.payment_status === 'paid') throw E.conflict('ALREADY_PAID', 'This visit is already paid.');
    const inv = await trx('invoices').where({ business_id: ctx.businessId, appointment_id: a.id }).first('id');
    if (inv) throw E.conflict('APPOINTMENT_INVOICED', 'This visit already has an invoice.');
    // Services on the bill must be services of this clinic; their names are snapshotted when the row has none.
    const ids = [...new Set(bill.lines.map((l) => l.service_id).filter(Boolean))];
    if (ids.length) {
      const rows = await trx('services').where({ business_id: ctx.businessId }).whereIn('id', ids).select('id', 'name', 'name_en', 'price');
      if (rows.length !== ids.length) throw E.validation({ amount: 'Choose a valid value.' });
      const by = new Map(rows.map((r) => [r.id, r]));
      bill.lines.forEach((l) => {
        if (!l.service_id) return;
        const s = by.get(l.service_id);
        if (!l.name) l.name = s.name;
        if (!l.name_en) l.name_en = s.name_en || null;
        if (l.unit_price === null) l.unit_price = round(n(s.price), ctx.currency);
      });
      bill.total = totalOf(bill.lines, ctx.currency);
    }
    again = Boolean(a.doctor_finished_at) && a.status === 'completed';
    if (prep.note) await writeNote(trx, ctx, a, prep.note);
    if (opts.rx) rxId = await writeRx(trx, ctx, a, prep.rx, { rxId: input.rx_id, notes: prep.rxNotes, diagnosis: prep.note ? prep.note.diagnosis : null });
    await trx('appointments').where({ id: a.id }).update({
      status: 'completed', with_doctor: false, amount_due: bill.total, doctor_lines: JSON.stringify(bill.lines),
      doctor_finished_at: new Date(), doctor_finished_by: ctx.userId || null, updated_at: new Date(),
    });
    await audit.record(ctx, again ? 'visit.bill_updated' : 'visit.finished', {
      entityType: 'appointment', entityId: a.id,
      oldValues: { status: a.status, amount_due: n(a.amount_due) }, newValues: { status: 'completed', amount_due: bill.total, lines: bill.lines.length },
    }, trx);
  });
  await afterCommit({ ...ctx, icdPrimary: input.icd_primary }, a, prep, { stopTimer: true });
  return { total: bill.total, lines: bill.lines, rxId, again };
}

/**
 * "Start visit" from My day: a patient who is here goes into the doctor's room (checked in + with the doctor) and the
 * consultation timer starts. Only for today's open visits; anything else simply opens the page.
 */
async function start(ctx, apptId, { timer = true } = {}) {
  const a = await knex('appointments').where({ business_id: ctx.businessId, id: Number(apptId) })
    .modify((q) => { if (ctx.ownDoctorId) q.where('doctor_id', ctx.ownDoctorId); }).first();
  if (!a || a.appointment_type === 'blocked') throw E.notFound('Appointment');
  if (a.appointment_date !== ctx.today || !['pending', 'confirmed'].includes(a.status)) return { started: false, a };
  if (!a.with_doctor || !a.checked_in) {
    const now = new Date();
    await knex('appointments').where({ id: a.id }).update({
      checked_in: true, arrived_at: a.arrived_at || now, with_doctor: true, called_at: a.called_at || now, status: 'confirmed', updated_at: now,
    });
    await audit.record(ctx, 'appointment.called_in', { entityType: 'appointment', entityId: a.id, newValues: { by: 'doctor' } });
    // The doctor called the patient in themselves: reception is told (bell + a "ding-dong" on their screen) to send
    // the patient in. Title = patient, body = doctor (shown as a sentence by notifications/web readable()).
    try {
      const d = a.doctor_id ? await knex('doctors').where({ id: a.doctor_id, business_id: ctx.businessId }).first('full_name') : null;
      await require('../notifications/notification.service').notify(ctx.businessId, { // eslint-disable-line global-require
        permission: 'frontdesk.use', type: 'patient.called_in', severity: 'warning', title: a.patient_name, body: d ? d.full_name : '', link: '/app/front-desk', dedupeKey: `call:${a.id}`,
      });
    } catch (err) { /* a notice must never stop the visit */ }
  }
  if (timer) await require('../clinicalplus/timer.service').start(ctx, a); // eslint-disable-line global-require
  return { started: true, a };
}

module.exports = { finish, saveDraft, start, billFor, defaultLines, cleanLines, cleanRx, MAX_LINES };
