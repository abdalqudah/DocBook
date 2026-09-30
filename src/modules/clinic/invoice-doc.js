// One invoice as a printable document (worker: invoice): the bill lines, the payment parts, the insurer's and the
// patient's shares, the patient's identifiers and whether the clinic stamp goes on invoices. Rendered by
// pages/clinic/billing/_document.ejs (invoice A4 / A5 and the 80 mm receipt).
const knex = require('../../db/knex');
const { E } = require('../../core/errors');
const { round } = require('../../core/money');
const lib = require('./records.lib');
const parts = require('./payment-parts');

const n = (v) => Number(v) || 0;
const parseJson = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

/** Whether the clinic stamp is printed on invoices (an image is set and "on invoices" is ticked). */
async function stampOnInvoices(businessId) {
  const row = await knex('clinic_stamps').where({ business_id: businessId }).first('mime', 'on_invoices').catch(() => null);
  return Boolean(row && row.mime && row.on_invoices);
}

/**
 * The insurer's share of an invoice: the stored amount (cash screen), else the coverage percent of the total
 * (front desk / older invoices), else 0.
 */
function insuranceShare(inv, currency) {
  if (inv.insurance_amount !== null && inv.insurance_amount !== undefined) return n(inv.insurance_amount);
  if (inv.insurance_coverage_percent !== null && inv.insurance_coverage_percent !== undefined) return round(n(inv.amount) * n(inv.insurance_coverage_percent) / 100, currency);
  return 0;
}

/** Everything the paper needs. Scoped to the clinic, and to a doctor's own invoices for a doctor login. */
async function load(ctx, invId, { paper } = {}) {
  const inv = await knex('invoices as i').leftJoin('users as u', 'u.id', 'i.created_by')
    .leftJoin('appointments as a', function j() { this.on('a.id', 'i.appointment_id').andOn('a.business_id', 'i.business_id'); })
    .where({ 'i.business_id': ctx.businessId, 'i.id': Number(invId) })
    .first('i.*', 'u.name as cashier', 'a.appointment_date', 'a.appointment_time', 'a.status as appointment_status', 'a.appointment_type');
  if (!inv || (ctx.ownDoctorId && inv.doctor_id !== ctx.ownDoctorId)) throw E.notFound('Invoice');
  const [map, patient, stampOn] = await Promise.all([
    parts.partsMap(ctx.businessId, [inv.id]),
    inv.patient_id ? knex('patients').where({ id: inv.patient_id, business_id: ctx.businessId }).first('id', 'full_name', 'phone', 'national_id', 'insurance_number') : null,
    stampOnInvoices(ctx.businessId),
  ]);
  const saved = parseJson(inv.items);
  const gross = round(n(inv.amount) + n(inv.discount_amount), ctx.currency);
  const insuranceAmount = insuranceShare(inv, ctx.currency);
  return {
    inv, patient, stampOn, paper,
    parts: parts.partsOf(inv, map),
    lines: Array.isArray(saved) && saved.length ? saved : [{ name: inv.service_name, qty: 1, unitPrice: gross, total: gross }],
    subtotal: inv.subtotal !== null && inv.subtotal !== undefined ? n(inv.subtotal) : gross,
    insuranceAmount, patientAmount: round(n(inv.amount) - insuranceAmount, ctx.currency),
    issued: lib.localTime(inv.created_at, ctx.timezone) || {},
  };
}

/** The paper to print on: ?paper= when valid, else the invoice template's paper, else A4. */
const paperOf = (query, tpl) => (['a4', 'a5', 'receipt80'].includes(query && query.paper) ? query.paper : (tpl && ['a4', 'a5', 'receipt80'].includes(tpl.paper) ? tpl.paper : 'a4'));

module.exports = { load, paperOf, insuranceShare, stampOnInvoices };
