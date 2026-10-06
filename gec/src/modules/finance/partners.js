// University partner agreements (resource CRUD, finance / admin only) and commissions: an expected commission is
// created when an application at a partner university reaches "Enrolled"; finance tracks it to received.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const events = require('../../core/events');
const { E } = require('../../core/errors');
const { resource } = require('../../core/resource');
const money = require('../catalog/money');
const fin = require('./money');

const uniOptions = async () => (await knex('universities').orderBy('name_en').select('id', 'name_en')).map((u) => ({ value: String(u.id), label: u.name_en }));
const currencyOptions = async () => (await money.codes()).map((c) => ({ value: c, label: c }));

const partners = resource({
  key: 'partners', table: 'partners', entity: 'partner', nameField: 'agreement_ref', perms: { view: 'partners.view', manage: 'partners.manage' },
  defaults: { status: 'active', commission_type: 'percent', currency: 'USD' },
  list: { search: ['agreement_ref', 'contact_name', 'contact_email'], defaultSort: ['id', 'desc'],
    select: (q) => q.leftJoin('universities as u', 'u.id', 'partners.university_id').select('partners.*', 'u.name_en as university_name'),
    columns: [{ key: 'university_name', label: 'resources.fields.university_id' }, { key: 'status', label: 'common.status', render: (r, req) => req.t(`finance.partner_status.${r.status}`) },
      { key: 'commission_rate', label: 'resources.fields.commission_rate', render: (r) => (r.commission_type === 'percent' ? `${Number(r.commission_rate)}%` : `${Number(r.commission_rate)} ${r.currency || ''}`) }, { key: 'ends_on', label: 'resources.fields.ends_on', type: 'date' }] },
  sections: [
    { key: 'agreement', fields: [{ name: 'university_id', type: 'select', required: true, options: uniOptions }, { name: 'status', type: 'select', required: true, options: ['prospect', 'pending', 'active', 'expired', 'terminated'], optionLabel: 'finance.partner_status' },
      { name: 'agreement_ref', type: 'text', max: 120 }, { name: 'starts_on', type: 'date' }, { name: 'ends_on', type: 'date' }] },
    { key: 'commission', fields: [{ name: 'commission_type', type: 'select', required: true, options: ['percent', 'fixed'], optionLabel: 'finance.commission_type' }, { name: 'commission_rate', type: 'number', step: '0.01', required: true, max: 1000000, hint: 'finance.rate_hint' },
      { name: 'currency', type: 'select', options: currencyOptions }, { name: 'payment_terms_days', type: 'int', max: 365 }] },
    { key: 'contact', fields: [{ name: 'contact_name', type: 'text' }, { name: 'contact_email', type: 'text', max: 190 }, { name: 'contact_phone', type: 'text' }, { name: 'notes', type: 'textarea', rows: 3 }] },
  ],
});

/** Creates the expected commission for an application (idempotent; one per application). */
async function expectFor(application, ctx = { userId: null }) {
  if (!application.university_id || await knex('commissions').where({ application_id: application.id }).first('id')) return null;
  const today = new Date().toISOString().slice(0, 10);
  const p = await knex('partners').where({ university_id: application.university_id, status: 'active' })
    .where((w) => w.whereNull('starts_on').orWhere('starts_on', '<=', today)).where((w) => w.whereNull('ends_on').orWhere('ends_on', '>=', today)).orderBy('id', 'desc').first();
  if (!p) return null;
  // A program can override the partnership's rate (GEC's margin on that program).
  const prog = application.program_id ? await knex('programs').where({ id: application.program_id }).first('commission_type', 'commission_rate') : null;
  const rule = prog && ['percent', 'fixed'].includes(prog.commission_type) && prog.commission_rate !== null
    ? { commission_type: prog.commission_type, commission_rate: prog.commission_rate, currency: p.currency, source: 'program' } : { ...p, source: 'partner' };
  let amount; let currency; let basis;
  if (rule.commission_type === 'percent') {
    if (!application.tuition_fee) return null; // nothing to base it on: finance adds it by hand
    currency = application.currency || p.currency || 'USD';
    amount = fin.fromCents(Math.round((fin.cents(application.tuition_fee) * Number(rule.commission_rate)) / 100));
    basis = `${Number(rule.commission_rate)}% × ${application.tuition_fee} ${currency}${rule.source === 'program' ? ' (program rate)' : ''}`;
  } else { amount = Number(rule.commission_rate); currency = p.currency || 'USD'; basis = rule.source === 'program' ? 'fixed (program rate)' : 'fixed'; }
  const due = p.payment_terms_days ? new Date(Date.now() + p.payment_terms_days * 86400_000).toISOString().slice(0, 10) : null;
  const [id] = await knex('commissions').insert({ partner_id: p.id, university_id: application.university_id, application_id: application.id, student_id: application.student_id, expected_amount: amount, currency, status: 'expected', due_on: due, basis });
  await audit.record(ctx, 'commission.expected', { entityType: 'commission', entityId: id, newValues: { amount, currency, application_id: application.id } });
  return id;
}

events.on('application.stage_changed', async ({ application, to, by }) => {
  if (to && to.key === 'enrolled') await expectFor(application, { userId: by || null });
});

const C_STATUSES = ['expected', 'invoiced', 'received', 'written_off'];
async function updateCommission(ctx, id, d) {
  const c = await knex('commissions').where({ id }).first();
  if (!c) throw E.notFound('Commission');
  if (!C_STATUSES.includes(d.status)) throw E.validation({ status: 'Choose a valid option.' });
  const row = { status: d.status, notes: d.notes !== undefined ? (d.notes || null) : c.notes, updated_at: new Date() };
  if (d.expected_amount !== undefined && d.expected_amount !== null && !Number.isNaN(Number(d.expected_amount))) row.expected_amount = Number(d.expected_amount);
  if (d.status === 'received') { row.received_amount = d.received_amount != null && d.received_amount !== '' ? Number(d.received_amount) : (c.received_amount || row.expected_amount || c.expected_amount); row.received_on = d.received_on || c.received_on || new Date().toISOString().slice(0, 10); }
  await knex('commissions').where({ id }).update(row);
  await audit.record(ctx, 'commission.updated', { entityType: 'commission', entityId: id, oldValues: { status: c.status, received_amount: c.received_amount }, newValues: row });
}

module.exports = { partners, expectFor, updateCommission, C_STATUSES };
