// Billing: issued invoices (filters, totals, export), printable invoice / receipt, voiding, and visits still awaiting payment.
const express = require('express');
const knex = require('../../db/knex');
const exporter = require('../../core/exporter');
const fmtCore = require('../../core/format');
const { E } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const appts = require('./appointments.service');
const lib = require('./records.lib');
const payParts = require('./payment-parts');
const invoiceDoc = require('./invoice-doc');

const router = express.Router();
router.use(can('billing.view'));

const PAGE = { pageScripts: ['/js/records.js'], pageStyles: ['/css/records.css', '/css/invoice.css'] };

/** Invoices matching the filters (clinic-time-zone dates, invoice-number search, a doctor's own scope). */
function invoiceQuery(ctx, query) {
  const q = knex('invoices').where('invoices.business_id', ctx.businessId);
  const s = String(query.q || '').trim();
  if (s) {
    const term = lib.likeTerm(s);
    // "#159", "INV-159" or the template's own letter prefix.
    const num = s.replace(/^#/, '').replace(/^[A-Za-z\-/_.]+/, '');
    q.andWhere((w) => {
      ['patient_name', 'patient_phone', 'doctor_name', 'service_name'].forEach((c) => w.orWhere(`invoices.${c}`, 'like', term));
      if (/^\d+$/.test(num)) w.orWhere('invoices.invoice_number', Number(num));
    });
  }
  if (ctx.ownDoctorId) q.where('invoices.doctor_id', ctx.ownDoctorId);
  else if (/^\d+$/.test(query.doctor || '')) q.where('invoices.doctor_id', Number(query.doctor));
  // An invoice paid cash + card matches both "cash" and "card" (its parts), never a "mixed" bucket.
  if (payParts.METHODS.includes(query.method)) payParts.whereHasMethod(q, query.method, 'invoices.id', 'invoices.payment_method');
  if (query.insurance === 'none') q.whereNull('invoices.insurance_provider_id');
  else if (/^\d+$/.test(query.insurance || '')) q.where('invoices.insurance_provider_id', Number(query.insurance));
  const from = lib.isIso(query.from) ? query.from : null;
  const to = lib.isIso(query.to) ? query.to : null;
  if (from || to) lib.whereLocalDates(q, 'invoices.created_at', from || '2000-01-01', to || '2999-12-31', ctx.timezone);
  return q;
}

async function filterOptions(ctx) {
  const [doctors, insurance] = await Promise.all([
    knex('doctors').where({ business_id: ctx.businessId }).orderBy([{ column: 'is_active', order: 'desc' }, { column: 'sort_order' }, { column: 'full_name' }]).select('id', 'full_name', 'full_name_en'),
    knex('insurance_providers').where({ business_id: ctx.businessId }).orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('id', 'name'),
  ]);
  return { doctors, insurance };
}

function unpaidQuery(ctx) {
  const q = knex('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id')
    .where('a.business_id', ctx.businessId).where('a.payment_status', 'unpaid').whereNot('a.appointment_type', 'blocked')
    .whereNotIn('a.status', ['cancelled', 'no_show']).where('a.appointment_date', '<=', ctx.today)
    .andWhere((w) => w.where('a.status', 'completed').orWhere('a.checked_in', true));
  if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId);
  return q;
}

router.get('/', wrap(async (req, res) => {
  const tab = req.query.tab === 'unpaid' ? 'unpaid' : 'invoices';
  const [{ n: unpaidCount }] = await unpaidQuery(req.ctx).count({ n: '*' });
  const opts = await filterOptions(req.ctx);
  if (tab === 'unpaid') {
    const rows = await unpaidQuery(req.ctx).orderBy([{ column: 'a.appointment_date', order: 'desc' }, { column: 'a.appointment_time', order: 'desc' }]).limit(300)
      .select('a.*', 'd.full_name as doctor_name', 'd.color as doctor_color', 's.name as service_name');
    const due = rows.reduce((s, r) => s + Number(r.amount_due || 0), 0);
    return res.page('pages/clinic/billing/index', { title: req.t('billing.title'), tab, rows, due, unpaidCount: Number(unpaidCount), ...opts, ...PAGE });
  }
  const base = invoiceQuery(req.ctx, req.query);
  const [sums] = await base.clone().select(knex.raw('COUNT(*) as n'), knex.raw('COALESCE(SUM(amount),0) as amount'), knex.raw('COALESCE(SUM(discount_amount),0) as discount'),
    knex.raw('SUM(CASE WHEN discount_amount > 0 THEN 1 ELSE 0 END) as discounted'));
  const sortCol = { amount: 'invoices.amount', date: 'invoices.created_at' }[req.query.sort] || 'invoices.invoice_number';
  const [{ rows, meta }, byMethod] = await Promise.all([
    lib.paginate(base.clone().select('invoices.*').orderBy(sortCol, req.query.dir === 'asc' ? 'asc' : 'desc').orderBy('invoices.id', 'desc'), { page: req.query.page, perPage: 25 }),
    payParts.totalsByMethod(base, 'invoices.id', req.ctx.businessId),
  ]);
  await payParts.attach(req.ctx.businessId, rows);
  const filtered = ['q', 'doctor', 'method', 'insurance', 'from', 'to'].some((k) => req.query[k] && req.query[k] !== 'all');
  return res.page('pages/clinic/billing/index', {
    title: req.t('billing.title'), tab, rows, meta, totals: { count: Number(sums.n) || 0, amount: Number(sums.amount) || 0, discount: Number(sums.discount) || 0, discounted: Number(sums.discounted) || 0 },
    filtered, unpaidCount: Number(unpaidCount), methods: payParts.METHODS, byMethod, localTime: (d) => lib.localTime(d, req.ctx.timezone), ...opts, ...PAGE,
  });
}));

router.get('/export', can('data.export'), wrap(async (req, res) => {
  const rows = await invoiceQuery(req.ctx, req.query).orderBy('invoices.invoice_number', 'desc').limit(50000).select('invoices.*');
  await payParts.attach(req.ctx.businessId, rows);
  const t = req.t;
  const tz = req.ctx.timezone;
  const prefix = (res.locals.invoiceTpl && res.locals.invoiceTpl.prefix) || '';
  const amount = (v) => fmtAmount(v, req);
  // The method column spells out the parts ("Cash 20.000 + Card 20.000"); one column per method carries the amounts
  // so the file adds up by method in a spreadsheet.
  exporter.send(req, res, {
    name: t('billing.invoices'),
    header: [t('billing.number'), t('common.date'), t('common.time'), t('common.patient'), t('common.phone'), t('common.doctor'), t('common.service'),
      t('billing.original_price'), t('billing.discount_pct'), t('billing.discount_amount'), t('billing.net_paid'), t('billing.method'),
      ...payParts.METHODS.map((m) => t(`invoicex.col_${m}`)), t('billing.insurance')],
    rows: rows.map((r) => { const lt = lib.localTime(r.created_at, tz) || {}; return [`${prefix}${r.invoice_number}`, lt.date || '', lt.time || '', r.patient_name, r.patient_phone || '', r.doctor_name || '', r.service_name || '',
      Number(r.amount) + Number(r.discount_amount), Number(r.discount_percent), Number(r.discount_amount), Number(r.amount),
      payParts.describe(t, r.parts, { insuranceName: r.insurance_provider_name, amount }),
      ...payParts.METHODS.map((m) => payParts.amountBy(r.parts, m)), r.insurance_provider_name || '']; }),
  });
}));

/** Plain number with the currency's decimals (for export text). */
const fmtAmount = (v, req) => fmtCore.formatAmount(v, req.ctx.currency, 'en');

async function loadInvoice(req) {
  const inv = await knex('invoices as i').leftJoin('users as u', 'u.id', 'i.created_by').leftJoin('appointments as a', function j() { this.on('a.id', 'i.appointment_id').andOn('a.business_id', 'i.business_id'); })
    .where({ 'i.business_id': req.ctx.businessId, 'i.id': Number(req.params.id) })
    .first('i.*', 'u.name as cashier', 'a.appointment_date', 'a.appointment_time', 'a.status as appointment_status', 'a.appointment_type');
  if (!inv || (req.ctx.ownDoctorId && inv.doctor_id !== req.ctx.ownDoctorId)) throw E.notFound('Invoice');
  return inv;
}

router.get('/:id(\\d+)', wrap(async (req, res) => {
  const paper = invoiceDoc.paperOf(req.query, res.locals.invoiceTpl);
  const doc = await invoiceDoc.load(req.ctx, req.params.id, { paper });
  const number = `${(res.locals.invoiceTpl && res.locals.invoiceTpl.prefix) || ''}${doc.inv.invoice_number}`;
  res.page('pages/clinic/billing/show', {
    title: req.t('billing.invoice_no', { n: number }), doc, inv: doc.inv, patient: doc.patient, issued: doc.issued, paper, number, printable: true, ...PAGE,
  });
}));

router.post('/:id(\\d+)/void', can('billing.manage'), wrap(async (req, res) => {
  const inv = await loadInvoice(req);
  if (String(req.body.confirm_name || '').trim() !== String(inv.invoice_number)) {
    flash(req, 'error', req.t('billing.void_mismatch'));
    return res.redirect(`/app/billing/${inv.id}`);
  }
  await appts.voidInvoice(req.ctx, inv.id);
  flash(req, 'success', req.t('billing.voided', { n: inv.invoice_number }));
  return res.redirect('/app/billing');
}));

module.exports = router;
