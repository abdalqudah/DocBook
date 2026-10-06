// Invoices and payments. Invoices belong to a student (or a lead before they become a student) and follow that
// person's data scope. Totals are computed on the server; issued invoices cannot be edited, only voided.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const events = require('../../core/events');
const { E } = require('../../core/errors');
const { randomToken } = require('../../core/tokens');
const { scope } = require('../rbac/rbac.service');
const settings = require('../settings/settings.service');
const activity = require('../crm/activity.service');
const people = require('../crm/people');
const money = require('./money');
const counters = require('./counters');

const STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'void'];
const METHODS = ['cash', 'bank_transfer', 'card', 'online', 'cheque', 'other'];

function base(staff) {
  const q = knex('invoices as i').leftJoin('students as s', 's.id', 'i.student_id').leftJoin('leads as l', 'l.id', 'i.lead_id');
  return scope(q, staff, { owner: knex.raw('COALESCE(s.counsellor_id, l.counsellor_id)'), branch: 'i.branch_id' });
}
const COLS = ['i.*', 's.ref as student_ref', 'l.ref as lead_ref'];

async function list(staff, { status, q, overdue, page = 1, from, to } = {}) {
  const query = base(staff);
  if (STATUSES.includes(status)) query.where('i.status', status);
  if (overdue) query.whereIn('i.status', ['issued', 'partially_paid']).where('i.due_date', '<', new Date().toISOString().slice(0, 10));
  if (from) query.where('i.issue_date', '>=', from);
  if (to) query.where('i.issue_date', '<=', to);
  if (q) query.where((w) => w.where('i.number', 'like', `%${q}%`).orWhere('i.bill_to_name', 'like', `%${q}%`).orWhere('i.bill_to_email', 'like', `%${q}%`));
  const [{ n }] = await query.clone().clearSelect().count({ n: 'i.id' });
  const rows = await query.select(COLS).orderBy('i.id', 'desc').limit(30).offset((page - 1) * 30);
  return { rows, meta: { total: Number(n), page, pages: Math.max(1, Math.ceil(Number(n) / 30)) } };
}

async function get(staff, id) {
  const inv = await base(staff).where('i.id', id).first(COLS);
  if (!inv) throw E.notFound('Invoice');
  inv.items = await knex('invoice_items').where({ invoice_id: id }).orderBy('position');
  inv.payments = await knex('payments as p').leftJoin('users as u', 'u.id', 'p.received_by').where('p.invoice_id', id).orderBy('p.received_on').select('p.*', 'u.name as received_by_name');
  return inv;
}

async function byToken(token) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(token || ''))) return null;
  const inv = await knex('invoices').where({ public_token: token }).whereNot('status', 'draft').first();
  if (!inv) return null;
  inv.items = await knex('invoice_items').where({ invoice_id: inv.id }).orderBy('position');
  inv.payments = await knex('payments').where({ invoice_id: inv.id, status: 'received' }).orderBy('received_on');
  return inv;
}

/** Who is billed: a student (preferred) or a lead, both inside the employee's scope. */
async function billTo(staff, { student_id: studentId, lead_id: leadId }) {
  if (studentId) {
    const s = await require('../crm/students.service').get(staff, studentId); // eslint-disable-line global-require
    return { student_id: s.id, lead_id: null, branch_id: s.branch_id, name: people.fullName(s), email: s.email, phone: s.phone, locale: s.preferred_locale };
  }
  if (leadId) {
    const l = await require('../crm/leads.service').get(staff, leadId); // eslint-disable-line global-require
    return { student_id: l.student_id || null, lead_id: l.id, branch_id: l.branch_id, name: people.fullName(l), email: l.email, phone: l.phone, locale: l.preferred_locale };
  }
  throw E.validation({ student_id: 'Choose who the invoice is for.' });
}

async function create(ctx, staff, d) {
  const who = await billTo(staff, d);
  if (!d.items.length) throw E.validation({ items: 'Add at least one line.' });
  const t = money.totals(d.items, { discount: d.discount, taxRate: d.tax_rate });
  if (t.total <= 0) throw E.validation({ items: 'The total must be more than zero.' });
  const prefix = ((await settings.get('finance')) || {}).invoice_prefix || 'INV';
  const id = await knex.transaction(async (trx) => {
    const number = await counters.next('invoice', prefix, trx);
    const [newId] = await trx('invoices').insert({
      number, student_id: who.student_id, lead_id: who.lead_id, application_id: d.application_id || null, bill_to_name: d.bill_to_name || who.name, bill_to_email: d.bill_to_email || who.email || null,
      bill_to_phone: who.phone || null, bill_to_address: d.bill_to_address || null, currency: d.currency, locale: d.locale || (who.locale === 'ar' ? 'ar' : 'en'), status: 'draft',
      due_date: d.due_date || null, subtotal: t.subtotal, discount: t.discount, tax_rate: d.tax_rate || 0, tax: t.tax, total: t.total, notes: d.notes || null,
      public_token: randomToken(24), branch_id: who.branch_id || staff.employee.branchId || null, created_by: ctx.userId,
    });
    await trx('invoice_items').insert(t.items.map((it, i) => ({ invoice_id: newId, description: it.description, quantity: it.quantity, unit_price: it.unit_price, amount: it.amount, position: i })));
    return newId;
  });
  await audit.record(ctx, 'invoice.created', { entityType: 'invoice', entityId: id, newValues: { total: t.total, currency: d.currency } });
  if (d.issue) await issue(ctx, staff, id); // eslint-disable-line no-use-before-define
  return id;
}

async function updateDraft(ctx, staff, id, d) {
  const inv = await get(staff, id);
  if (inv.status !== 'draft') throw E.conflict('NOT_DRAFT', 'Only draft invoices can be edited.');
  if (!d.items.length) throw E.validation({ items: 'Add at least one line.' });
  const t = money.totals(d.items, { discount: d.discount, taxRate: d.tax_rate });
  if (t.total <= 0) throw E.validation({ items: 'The total must be more than zero.' });
  await knex.transaction(async (trx) => {
    await trx('invoices').where({ id }).update({ currency: d.currency, locale: d.locale || inv.locale, due_date: d.due_date || null, bill_to_name: d.bill_to_name || inv.bill_to_name, bill_to_email: d.bill_to_email || null, bill_to_address: d.bill_to_address || null, subtotal: t.subtotal, discount: t.discount, tax_rate: d.tax_rate || 0, tax: t.tax, total: t.total, notes: d.notes || null, updated_at: new Date() });
    await trx('invoice_items').where({ invoice_id: id }).del();
    await trx('invoice_items').insert(t.items.map((it, i) => ({ invoice_id: id, description: it.description, quantity: it.quantity, unit_price: it.unit_price, amount: it.amount, position: i })));
  });
  await audit.record(ctx, 'invoice.updated', { entityType: 'invoice', entityId: id, oldValues: { total: inv.total }, newValues: { total: t.total } });
}

async function issue(ctx, staff, id) {
  const inv = await get(staff, id);
  if (inv.status !== 'draft') return inv;
  const today = new Date().toISOString().slice(0, 10);
  const due = inv.due_date || new Date(Date.now() + (((await settings.get('finance')) || {}).due_days || 14) * 86400_000).toISOString().slice(0, 10);
  await knex('invoices').where({ id }).update({ status: 'issued', issue_date: today, due_date: due, updated_at: new Date() });
  await activity.log({ leadId: inv.lead_id, studentId: inv.student_id }, { type: 'payment', title: 'invoice_issued', meta: { number: inv.number, amount: Number(inv.total), currency: inv.currency }, actorId: ctx.userId, shareable: true });
  await audit.record(ctx, 'invoice.issued', { entityType: 'invoice', entityId: id });
  await events.emit('invoice.issued', { invoiceId: id });
  return get(staff, id);
}

async function voidInvoice(ctx, staff, id, reason) {
  const inv = await get(staff, id);
  if (inv.status === 'void') return;
  if (Number(inv.paid) > 0) throw E.conflict('HAS_PAYMENTS', 'Refund the payments before voiding this invoice.');
  if (!reason) throw E.validation({ reason: 'Give a reason.' });
  await knex('invoices').where({ id }).update({ status: 'void', void_reason: String(reason).slice(0, 255), updated_at: new Date() });
  await audit.record(ctx, 'invoice.voided', { entityType: 'invoice', entityId: id, oldValues: { status: inv.status }, newValues: { status: 'void', reason } });
}

/** Recomputes paid amount and status from the payments (the source of truth). */
async function recompute(id, trx = knex) {
  const inv = await trx('invoices').where({ id }).first();
  if (!inv) return;
  const [{ s }] = await trx('payments').where({ invoice_id: id, status: 'received' }).sum({ s: 'amount' });
  const paid = Number(s || 0);
  let status = inv.status;
  if (status !== 'void' && status !== 'draft') status = paid <= 0 ? 'issued' : (money.cents(paid) >= money.cents(inv.total) ? 'paid' : 'partially_paid');
  await trx('invoices').where({ id }).update({ paid, status, updated_at: new Date() });
}

/**
 * Records money received: against an invoice (currency must match, no overpayment) or on its own for a person.
 * Returns the payment row.
 */
async function recordPayment(ctx, staff, d) {
  let inv = null; let who = null;
  if (d.invoice_id) {
    inv = await get(staff, d.invoice_id);
    if (!['issued', 'partially_paid'].includes(inv.status)) throw E.conflict('NOT_PAYABLE', 'Issue the invoice before recording a payment.');
    if (d.currency && d.currency !== inv.currency) throw E.validation({ currency: `This invoice is in ${inv.currency}.` });
    const remaining = money.cents(inv.total) - money.cents(inv.paid);
    if (money.cents(d.amount) > remaining) throw E.validation({ amount: `The balance is ${money.fromCents(remaining).toFixed(2)} ${inv.currency}.` });
  } else {
    who = await billTo(staff, d);
  }
  if (!(money.cents(d.amount) > 0)) throw E.validation({ amount: 'Enter an amount.' });
  const id = await knex.transaction(async (trx) => {
    const receipt = await counters.next('receipt', ((await settings.get('finance')) || {}).receipt_prefix || 'RC', trx);
    const [pid] = await trx('payments').insert({
      receipt_no: receipt, invoice_id: inv ? inv.id : null, student_id: inv ? inv.student_id : who.student_id, lead_id: inv ? inv.lead_id : who.lead_id, course_registration_id: d.course_registration_id || null,
      amount: money.fromCents(money.cents(d.amount)), currency: inv ? inv.currency : d.currency, method: d.method, reference: d.reference || null, received_on: d.received_on || new Date().toISOString().slice(0, 10),
      notes: d.notes || null, received_by: ctx.userId, branch_id: inv ? inv.branch_id : (who.branch_id || null),
    });
    if (inv) await recompute(inv.id, trx);
    return pid;
  });
  const p = await knex('payments').where({ id }).first();
  await activity.log({ leadId: p.lead_id, studentId: p.student_id }, { type: 'payment', title: 'payment_received', meta: { amount: Number(p.amount), currency: p.currency, receipt: p.receipt_no, number: inv ? inv.number : null }, actorId: ctx.userId, shareable: true });
  await audit.record(ctx, 'payment.recorded', { entityType: 'payment', entityId: id, newValues: { amount: Number(p.amount), currency: p.currency, method: p.method, invoice: inv ? inv.number : null } });
  await events.emit('payment.received', { paymentId: id, invoiceId: inv ? inv.id : null });
  return p;
}

async function refund(ctx, staff, paymentId, reason) {
  const p = await knex('payments').where({ id: paymentId }).first();
  if (!p) throw E.notFound('Payment');
  if (p.invoice_id) await get(staff, p.invoice_id); // scope check
  else if (p.student_id) await require('../crm/students.service').get(staff, p.student_id); // eslint-disable-line global-require
  if (p.status === 'refunded') return;
  if (!reason) throw E.validation({ reason: 'Give a reason.' });
  await knex.transaction(async (trx) => {
    await trx('payments').where({ id: p.id }).update({ status: 'refunded', refund_reason: String(reason).slice(0, 255), updated_at: new Date() });
    if (p.invoice_id) await recompute(p.invoice_id, trx);
  });
  await activity.log({ leadId: p.lead_id, studentId: p.student_id }, { type: 'payment', title: 'payment_refunded', meta: { amount: Number(p.amount), currency: p.currency, receipt: p.receipt_no }, actorId: ctx.userId });
  await audit.record(ctx, 'payment.refunded', { entityType: 'payment', entityId: p.id, newValues: { reason } });
}

/** Payments visible to the employee (scope through the student / lead). */
function paymentsBase(staff) {
  const q = knex('payments as p').leftJoin('students as s', 's.id', 'p.student_id').leftJoin('leads as l', 'l.id', 'p.lead_id').leftJoin('invoices as i', 'i.id', 'p.invoice_id').leftJoin('users as u', 'u.id', 'p.received_by');
  return scope(q, staff, { owner: knex.raw('COALESCE(s.counsellor_id, l.counsellor_id)'), branch: 'p.branch_id' });
}

/** Totals per currency for a period: invoiced (issued), collected (payments), outstanding, overdue. */
async function summary(staff, { from, to }) {
  const today = new Date().toISOString().slice(0, 10);
  const invoiced = await base(staff).whereNotIn('i.status', ['draft', 'void']).whereBetween('i.issue_date', [from, to]).groupBy('i.currency').select('i.currency').sum({ v: 'i.total' });
  const collected = await paymentsBase(staff).where('p.status', 'received').whereBetween('p.received_on', [from, to]).groupBy('p.currency').select('p.currency').sum({ v: 'p.amount' });
  const outstanding = await base(staff).whereIn('i.status', ['issued', 'partially_paid']).groupBy('i.currency').select('i.currency').sum({ v: knex.raw('i.total - i.paid') });
  const overdue = await base(staff).whereIn('i.status', ['issued', 'partially_paid']).where('i.due_date', '<', today).groupBy('i.currency').select('i.currency').sum({ v: knex.raw('i.total - i.paid') }).count({ n: '*' });
  return { invoiced, collected, outstanding, overdue };
}

module.exports = { STATUSES, METHODS, base, list, get, byToken, create, updateDraft, issue, voidInvoice, recordPayment, refund, recompute, paymentsBase, summary, billTo };
