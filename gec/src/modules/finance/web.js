// Staff finance: invoices (draft → issued → paid, void), payments with receipts and refunds, a finance overview,
// university partner agreements and commissions (partners.* permissions only), and the student "Finance" tab.
const express = require('express');
const knex = require('../../db/knex');
const fmt = require('../../core/format');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { safeBack } = require('../../middleware/errors');
const { ah, idParam } = require('../../core/http');
const { E } = require('../../core/errors');
const { validate, z, str, reqStr, optEmail } = require('../../core/validate');
const { toCsv } = require('../../core/csv');
const nav = require('../staff/nav');
const registry = require('../staff/registry');
const dashboard = require('../staff/dashboard');
const tabs = require('../crm/tabs');
const money = require('../catalog/money');
const notify = require('../comms/notify');
const settings = require('../settings/settings.service');
const config = require('../../config');
const inv = require('./invoices.service');
const { docHelpers } = require('./doc');
const partners = require('./partners');
require('./handlers');
require('./hooks');
const online = require('./online');
const secrets = require('../../core/secrets');
const { bool } = require('../../core/validate');
require('../settings/web').addSection({ key: 'payments', icon: 'credit-card', href: '/staff/settings/payments', perms: ['integrations.manage'] }, { after: 'whatsapp' });

nav.add('finance', { key: 'finance', href: '/staff/finance', icon: 'wallet', perms: ['finance.view'], exact: true });
nav.add('finance', { key: 'invoices', href: '/staff/invoices', icon: 'receipt', perms: ['finance.view'] });
nav.add('finance', { key: 'payments', href: '/staff/payments', icon: 'banknote', perms: ['finance.view'] });
nav.add('finance', { key: 'partners', href: '/staff/partners', icon: 'handshake', perms: ['partners.view'] });
nav.add('finance', { key: 'commissions', href: '/staff/commissions', icon: 'percent', perms: ['partners.view'] });
registry.addAction({ key: 'invoice', icon: 'receipt', href: '/staff/invoices/new', perms: ['finance.manage'] });
registry.addAttention(async (req) => {
  if (!req.can('finance.view')) return [];
  const rows = await inv.base(req.staff).whereIn('i.status', ['issued', 'partially_paid']).where('i.due_date', '<', fmt.today()).orderBy('i.due_date').limit(8).select('i.*');
  return rows.map((r) => ({ kind: 'invoice', icon: 'receipt', tone: 'bad', title: req.t('attention.invoice_overdue', { number: r.number, name: r.bill_to_name }), sub: `${fmt.formatMoney(Number(r.total) - Number(r.paid), r.currency, req.locale)} · ${req.t('finance.due')} ${fmt.formatDate(r.due_date, req.locale)}`, href: `/staff/invoices/${r.id}`, chip: req.t('finance.overdue'), due: r.due_date }));
});
dashboard.page.kpis.push(async (req) => {
  if (!req.can('finance.view')) return [];
  const g = (await settings.get('general')) || {};
  const from = `${fmt.today().slice(0, 7)}-01`;
  const rows = await inv.paymentsBase(req.staff).where('p.status', 'received').where('p.received_on', '>=', from).groupBy('p.currency').select('p.currency').sum({ v: 'p.amount' });
  const main = rows.find((r) => r.currency === g.default_currency) || rows[0];
  return [{ key: 'collected', label: req.t('kpi.collected'), value: main ? fmt.formatMoney(main.v, main.currency, req.locale) : fmt.formatMoney(0, g.default_currency || 'USD', req.locale), href: '/staff/payments' }];
});
tabs.add({ key: 'finance', icon: 'wallet', perms: ['finance.view'], order: 30, view: 'pages/staff/finance/tab-finance',
  load: async (req, s) => ({ s, invoices: await inv.base(req.staff).where('i.student_id', s.id).orderBy('i.id', 'desc').select('i.*'), payments: await inv.paymentsBase(req.staff).where('p.student_id', s.id).orderBy('p.received_on', 'desc').select('p.*', 'i.number') }) });

const router = express.Router();
const currencies = async () => money.codes();
const dateQ = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

// ------------------------------------------------------------------ Overview
router.get('/finance', can('finance.view'), ah(async (req, res) => {
  const from = dateQ(req.query.from) || `${fmt.today().slice(0, 7)}-01`;
  const to = dateQ(req.query.to) || fmt.today();
  const sum = await inv.summary(req.staff, { from, to });
  const recent = await inv.paymentsBase(req.staff).orderBy('p.id', 'desc').limit(8).select('p.*', 'i.number', knex.raw("COALESCE(CONCAT(s.first_name, ' ', COALESCE(s.last_name, '')), CONCAT(l.first_name, ' ', COALESCE(l.last_name, ''))) AS payer"));
  const commissions = req.can('partners.view') ? await knex('commissions').whereIn('status', ['expected', 'invoiced']).groupBy('currency').select('currency').sum({ v: 'expected_amount' }) : null;
  res.page('pages/staff/finance/overview', { layout: 'staff', title: req.t('nav.finance'), from, to, sum, recent, commissions });
}));

// ------------------------------------------------------------------ Invoices
router.get('/invoices', can('finance.view'), ah(async (req, res) => {
  const r = await inv.list(req.staff, { status: req.query.status, q: String(req.query.q || '').trim().slice(0, 100), overdue: req.query.overdue === '1', page: Math.max(1, Number(req.query.page) || 1) });
  res.page('pages/staff/finance/invoices', { layout: 'staff', title: req.t('nav.invoices'), ...r, statuses: inv.STATUSES });
}));

const itemsFrom = (body) => {
  const desc = [].concat(body.item_description || []); const qty = [].concat(body.item_quantity || []); const price = [].concat(body.item_unit_price || []);
  return desc.map((d, i) => ({ description: String(d || '').trim().slice(0, 255), quantity: Number(qty[i] || 1), unit_price: Number(String(price[i] || '').replace(/,/g, '')) }))
    .filter((it) => it.description && Number.isFinite(it.unit_price) && it.unit_price >= 0 && Number.isFinite(it.quantity) && it.quantity > 0 && it.quantity <= 1000);
};
const invoiceSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/, 'Choose a currency.'), locale: z.enum(['en', 'ar']).optional(), due_date: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  discount: z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(v)), z.number().min(0).max(1e9)), tax_rate: z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(v)), z.number().min(0).max(100)),
  bill_to_name: str(190), bill_to_email: optEmail(), bill_to_address: str(500), notes: str(2000),
});

async function formPage(req, res, { invoice = null, old = {}, errors = {} } = {}) {
  const studentId = Number(req.query.student_id || old.student_id || (invoice && invoice.student_id)) || null;
  const leadId = Number(req.query.lead_id || old.lead_id || (invoice && invoice.lead_id)) || null;
  let who = null;
  if (studentId || leadId) who = await inv.billTo(req.staff, { student_id: studentId, lead_id: studentId ? null : leadId });
  const g = await settings.get('general');
  res.page('pages/staff/finance/invoice-form', { layout: 'staff', narrow: true, title: invoice ? invoice.number : req.t('finance.new_invoice'), invoice, who, studentId, leadId, currencies: await currencies(), defaultCurrency: g.default_currency || 'USD', old, errors });
}

router.get('/invoices/new', can('finance.manage'), ah(async (req, res) => formPage(req, res)));
router.post('/invoices', can('finance.manage'), ah(async (req, res) => {
  try {
    const d = validate(invoiceSchema, req.body);
    const id = await inv.create(req.ctx, req.staff, { ...d, student_id: Number(req.body.student_id) || null, lead_id: Number(req.body.lead_id) || null, items: itemsFrom(req.body), issue: req.body.issue === '1' });
    flash(req, 'ok', req.t(req.body.issue === '1' ? 'finance.issued' : 'finance.draft_saved'));
    return res.redirect(`/staff/invoices/${id}`);
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return formPage(req, res, { old: req.body, errors: e.details });
  }
}));

router.get('/invoices/:id', can('finance.view'), ah(async (req, res) => {
  const i = await inv.get(req.staff, idParam(req.params.id));
  if (req.query.edit === '1' && i.status === 'draft' && req.can('finance.manage')) return formPage(req, res, { invoice: i });
  return res.page('pages/staff/finance/invoice', { layout: 'staff', narrow: true, title: i.number, i, methods: inv.METHODS, publicUrl: `${config.appUrl}/invoices/${i.public_token}`, company: await settings.get('company'), ...docHelpers(i) });
}));

router.post('/invoices/:id', can('finance.manage'), ah(async (req, res) => {
  const id = idParam(req.params.id);
  try {
    const d = validate(invoiceSchema, req.body);
    await inv.updateDraft(req.ctx, req.staff, id, { ...d, items: itemsFrom(req.body) });
    if (req.body.issue === '1') await inv.issue(req.ctx, req.staff, id);
    flash(req, 'ok', req.t('common.saved'));
    return res.redirect(`/staff/invoices/${id}`);
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return formPage(req, res, { invoice: await inv.get(req.staff, id), old: req.body, errors: e.details });
  }
}));

router.post('/invoices/:id/issue', can('finance.manage'), ah(async (req, res) => {
  await inv.issue(req.ctx, req.staff, idParam(req.params.id));
  flash(req, 'ok', req.t('finance.issued'));
  res.redirect(`/staff/invoices/${req.params.id}`);
}));

router.post('/invoices/:id/void', can('finance.manage'), ah(async (req, res) => {
  await inv.voidInvoice(req.ctx, req.staff, idParam(req.params.id), String(req.body.reason || '').trim());
  flash(req, 'ok', req.t('finance.voided'));
  res.redirect(`/staff/invoices/${req.params.id}`);
}));

router.post('/invoices/:id/send', can('finance.manage'), ah(async (req, res) => {
  const i = await inv.get(req.staff, idParam(req.params.id));
  if (i.status === 'draft' || i.status === 'void' || !i.bill_to_email) throw E.validation({ bill_to_email: 'Issue the invoice and add an e-mail address first.' });
  const r = await notify.sendTemplate('invoice_issued', { email: i.bill_to_email, name: i.bill_to_name, locale: i.locale, leadId: i.lead_id, studentId: i.student_id }, {
    invoice_number: i.number, amount: fmt.formatMoney(i.total, i.currency, i.locale), due_date: i.due_date ? fmt.formatDate(i.due_date, i.locale) : '—',
  }, { link: `${config.appUrl}/invoices/${i.public_token}` });
  flash(req, r.sent ? 'ok' : 'error', r.sent ? req.t('finance.sent_to', { to: i.bill_to_email }) : req.t('comms.not_connected_saved', { channel: req.t('channels.email') }));
  res.redirect(`/staff/invoices/${i.id}`);
}));

// ------------------------------------------------------------------ Payments
const paymentSchema = z.object({
  amount: z.preprocess((v) => Number(String(v || '').replace(/,/g, '')), z.number({ invalid_type_error: 'Enter an amount.' }).positive('Enter an amount.').max(1e9)),
  currency: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^[A-Z]{3}$/).optional()), method: z.enum(['cash', 'bank_transfer', 'card', 'online', 'cheque', 'other']),
  reference: str(120), received_on: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()), notes: str(500),
});

router.post('/invoices/:id/payments', can('finance.manage'), ah(async (req, res) => {
  const id = idParam(req.params.id);
  try {
    const d = validate(paymentSchema, req.body);
    const p = await inv.recordPayment(req.ctx, req.staff, { ...d, invoice_id: id });
    flash(req, 'ok', req.t('finance.payment_recorded', { receipt: p.receipt_no }));
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED' && e.code !== 'NOT_PAYABLE') throw e;
    flash(req, 'error', e.details ? Object.values(e.details).join(' ') : e.message);
  }
  res.redirect(`/staff/invoices/${id}`);
}));

router.post('/payments/:id/refund', can('finance.manage'), ah(async (req, res) => {
  await inv.refund(req.ctx, req.staff, idParam(req.params.id), String(req.body.reason || '').trim());
  flash(req, 'ok', req.t('finance.refunded'));
  res.redirect(safeBack(req, '/staff/payments'));
}));

router.get('/payments', can('finance.view'), ah(async (req, res) => {
  const from = dateQ(req.query.from); const to = dateQ(req.query.to);
  const q = inv.paymentsBase(req.staff);
  if (from) q.where('p.received_on', '>=', from);
  if (to) q.where('p.received_on', '<=', to);
  if (inv.METHODS.includes(req.query.method)) q.where('p.method', req.query.method);
  q.select('p.*', 'i.number', 'u.name as received_by_name', knex.raw("COALESCE(CONCAT(s.first_name, ' ', COALESCE(s.last_name, '')), CONCAT(l.first_name, ' ', COALESCE(l.last_name, ''))) AS payer")).orderBy('p.received_on', 'desc').orderBy('p.id', 'desc');
  if (req.query.format === 'csv') {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="payments.csv"' });
    return res.send(toCsv(['receipt_no', 'received_on', 'payer', 'number', 'amount', 'currency', 'method', 'reference', 'status', 'received_by_name'].map((k) => ({ key: k })), await q.limit(10000)));
  }
  const page = Math.max(1, Number(req.query.page) || 1);
  const [{ n }] = await q.clone().clearSelect().clearOrder().count({ n: 'p.id' });
  return res.page('pages/staff/finance/payments', { layout: 'staff', title: req.t('nav.payments'), rows: await q.limit(30).offset((page - 1) * 30), meta: { total: Number(n), page, pages: Math.max(1, Math.ceil(Number(n) / 30)) }, methods: inv.METHODS });
}));

// ------------------------------------------------------------------ Commissions
router.get('/commissions', can('partners.view'), ah(async (req, res) => {
  const q = knex('commissions as c').leftJoin('universities as u', 'u.id', 'c.university_id').leftJoin('students as s', 's.id', 'c.student_id').leftJoin('applications as a', 'a.id', 'c.application_id')
    .select('c.*', 'u.name_en as university_name', 's.first_name', 's.last_name', 's.id as sid', 'a.ref as application_ref').orderBy('c.id', 'desc');
  if (partners.C_STATUSES.includes(req.query.status)) q.where('c.status', req.query.status);
  const rows = await q.limit(200);
  const totals = await knex('commissions').groupBy('status', 'currency').select('status', 'currency').sum({ v: 'expected_amount' }).sum({ r: 'received_amount' });
  res.page('pages/staff/finance/commissions', { layout: 'staff', title: req.t('nav.commissions'), rows, totals, statuses: partners.C_STATUSES });
}));
router.post('/commissions/:id', can('partners.manage'), ah(async (req, res) => {
  await partners.updateCommission(req.ctx, idParam(req.params.id), { status: String(req.body.status || ''), received_amount: req.body.received_amount, received_on: dateQ(req.body.received_on), expected_amount: req.body.expected_amount === undefined || req.body.expected_amount === '' ? undefined : Number(req.body.expected_amount), notes: req.body.notes });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect(safeBack(req, '/staff/commissions'));
}));
router.post('/applications/:id/commission', can('partners.manage'), ah(async (req, res) => {
  const app = await knex('applications').where({ id: idParam(req.params.id) }).first();
  if (!app) throw E.notFound();
  const id = await partners.expectFor(app, req.ctx);
  flash(req, id ? 'ok' : 'error', id ? req.t('finance.commission_created') : req.t('finance.no_agreement'));
  res.redirect(safeBack(req, '/staff/commissions'));
}));

router.use('/partners', partners.partners.router);

// ------------------------------------------------------------------ Settings → Payments (Stripe)
router.get('/settings/payments', can('integrations.manage'), ah(async (req, res) => {
  const s = (await settings.get('integration.stripe')) || {};
  res.page('pages/staff/settings/payments', { layout: 'staff', narrow: true, title: req.t('settings.payments'), s, connected: !!(await online.currentConfig()), hasKey: !!s.secret_key_enc, hasHook: !!s.webhook_secret_enc, hook: `${config.appUrl}/hooks/stripe` });
}));
router.post('/settings/payments', can('integrations.manage'), ah(async (req, res) => {
  const d = validate(z.object({ enabled: bool(), secret_key: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/, 'Paste the secret key (sk_live_… or sk_test_…).').optional()), webhook_secret: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().regex(/^whsec_[A-Za-z0-9+/=]{10,}$/, 'Paste the signing secret (whsec_…).').optional()) }), req.body);
  const cur = (await settings.get('integration.stripe')) || {};
  if (d.enabled && !(d.secret_key || cur.secret_key_enc)) throw E.validation({ secret_key: 'A secret key is required to connect.' });
  if (d.enabled && !(d.webhook_secret || cur.webhook_secret_enc)) throw E.validation({ webhook_secret: 'The webhook signing secret is required, otherwise payments cannot be confirmed.' });
  if (d.secret_key) await online.test(d.secret_key).catch((e) => { throw E.validation({ secret_key: `Stripe refused this key: ${e.message}` }); });
  await settings.set(req.ctx, 'integration.stripe', { enabled: d.enabled, secret_key_enc: d.secret_key ? secrets.encrypt(d.secret_key) : cur.secret_key_enc || null, webhook_secret_enc: d.webhook_secret ? secrets.encrypt(d.webhook_secret) : cur.webhook_secret_enc || null, mode: d.secret_key ? (/_live_/.test(d.secret_key) ? 'live' : 'test') : cur.mode || null });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/staff/settings/payments');
}));

module.exports = router;
