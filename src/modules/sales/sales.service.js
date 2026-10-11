// The platform's sales documents (Admin → Quotations): the seller details printed on them, a services catalog,
// quotations (lines, discount, VAT, a link for the customer to view, print, accept, decline or negotiate), share links
// for the platform's subscription invoices, and a log of every send by e-mail or WhatsApp — also on the CRM timeline.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const cache = require('../../core/cache');
const { round } = require('../../core/money');
const { randomToken } = require('../../core/tokens');
const { E, AppError } = require('../../core/errors');

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const str = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) || {} : (v || {}); } catch { return {}; } };
const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const crm = () => require('../crm/crm.service'); // eslint-disable-line global-require

// ---------------------------------------------------------------- seller details
const PROFILE_FIELDS = {
  legal_name_ar: 150, legal_name_en: 150, vat_number: 40, cr_number: 40, address_ar: 255, address_en: 255, phone: 40, email: 190, website: 190,
  bank_name: 120, account_name: 150, iban: 40, terms_ar: 3000, terms_en: 3000,
};
/** VAT and currency by the customer's country (Seller details can change each). */
const COUNTRY_RATES = {
  JO: { tax: 16, currency: 'JOD' }, SA: { tax: 15, currency: 'SAR' }, AE: { tax: 5, currency: 'AED' }, KW: { tax: 0, currency: 'KWD' },
  QA: { tax: 0, currency: 'QAR' }, BH: { tax: 10, currency: 'BHD' }, OM: { tax: 5, currency: 'OMR' }, EG: { tax: 14, currency: 'EGP' },
  IQ: { tax: 0, currency: 'IQD' }, PS: { tax: 16, currency: 'ILS' }, LB: { tax: 11, currency: 'USD' },
};
const profile = () => cache.remember('sales:profile', async () => {
  const row = await knex('platform_settings').where({ key: 'sales_profile' }).first('value').catch(() => null);
  const p = { valid_days: 30, tax_rate: 16, currency: 'JOD', ...(row ? parse(row.value) : {}) };
  p.country_rates = { ...COUNTRY_RATES, ...(p.country_rates || {}) };
  return p;
}, 30_000);
/** The VAT and currency for a customer in `country` (else the defaults). */
const ratesFor = (p, country) => (country && p.country_rates[String(country).toUpperCase()]) || { tax: Number(p.tax_rate), currency: p.currency };

async function saveProfile(ctx, body) {
  const p = {};
  for (const [k, n] of Object.entries(PROFILE_FIELDS)) p[k] = str(body[k], n); // eslint-disable-line no-restricted-syntax
  const errors = {};
  if (p.email && !EMAIL_RE.test(p.email)) errors.email = 'Enter a valid email address.';
  p.iban = p.iban.replace(/\s+/g, '').toUpperCase();
  if (p.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(p.iban)) errors.iban = 'Enter a valid IBAN.';
  p.valid_days = Math.min(365, Math.max(1, Number.parseInt(body.valid_days, 10) || 30));
  p.tax_rate = Number(body.tax_rate);
  if (!Number.isFinite(p.tax_rate) || p.tax_rate < 0 || p.tax_rate > 100) errors.tax_rate = 'Enter the VAT rate (e.g. 16).';
  p.currency = /^[A-Z]{3}$/.test(String(body.currency || '').toUpperCase()) ? String(body.currency).toUpperCase() : 'JOD';
  p.country_rates = {};
  Object.keys(COUNTRY_RATES).forEach((cc) => {
    const tax = Number(body[`rate_tax_${cc}`]); const cur = String(body[`rate_currency_${cc}`] || '').trim().toUpperCase();
    if (body[`rate_tax_${cc}`] === undefined) return;
    if (!Number.isFinite(tax) || tax < 0 || tax > 100) errors[`rate_tax_${cc}`] = 'Enter the VAT rate (e.g. 16).';
    else if (!/^[A-Z]{3}$/.test(cur)) errors[`rate_currency_${cc}`] = 'Enter a 3-letter currency code.';
    else p.country_rates[cc] = { tax, currency: cur };
  });
  if (Object.keys(errors).length) throw E.validation(errors);
  const value = JSON.stringify(p);
  await knex('platform_settings').insert({ key: 'sales_profile', value }).onConflict('key').merge({ value, updated_at: new Date() });
  cache.forgetPrefix('sales:');
  await audit.record(ctx, 'platform.sales_profile_updated', { entityType: 'platform', entityId: 'sales_profile' });
}
const sellerName = (p, locale) => (locale === 'ar' ? p.legal_name_ar || p.legal_name_en : p.legal_name_en || p.legal_name_ar) || require('../../config/brand').name; // eslint-disable-line global-require

// ---------------------------------------------------------------- services catalog
const listServices = ({ activeOnly = false } = {}) => { const q = knex('sales_services').orderBy('sort').orderBy('id'); return activeOnly ? q.where({ active: true }) : q; };
function serviceText(sv, locale) {
  const en = locale === 'en';
  const name = (en ? sv.name_en || sv.name_ar : sv.name_ar || sv.name_en) || '';
  const unit = en ? sv.unit_en || sv.unit_ar : sv.unit_ar || sv.unit_en;
  const desc = en ? sv.description_en || sv.description_ar : sv.description_ar || sv.description_en;
  return `${name}${unit ? ` (${unit})` : ''}${desc ? `\n${desc}` : ''}`.slice(0, 500);
}
async function saveService(ctx, id, body) {
  const v = {
    name_ar: str(body.name_ar, 200), name_en: str(body.name_en, 200) || null, description_ar: str(body.description_ar, 1000) || null, description_en: str(body.description_en, 1000) || null,
    unit_ar: str(body.unit_ar, 60) || null, unit_en: str(body.unit_en, 60) || null, price: Number(String(body.price || '0').replace(/,/g, '')), active: [].concat(body.active ?? '1').map(String).includes('1'), sort: Number.parseInt(body.sort, 10) || 0,
  };
  const errors = {};
  if (!v.name_ar && !v.name_en) errors.name_ar = 'Enter the service name.';
  if (!v.name_ar) v.name_ar = v.name_en || '';
  if (!Number.isFinite(v.price) || v.price < 0) errors.price = 'Prices must be zero or more.';
  if (Object.keys(errors).length) throw E.validation(errors);
  let sid = Number(id) || null;
  if (sid) {
    if (!(await knex('sales_services').where({ id: sid }).first('id'))) throw E.notFound('Service');
    await knex('sales_services').where({ id: sid }).update({ ...v, updated_at: new Date() });
  } else [sid] = await knex('sales_services').insert(v);
  await audit.record(ctx, 'platform.sales_service_saved', { entityType: 'sales_service', entityId: sid, newValues: { name: v.name_ar, price: v.price } });
  return sid;
}
/** A service used in quotations is switched off instead (older quotations keep their lines). */
async function removeService(ctx, id) {
  const used = await knex('quote_items').where({ service_id: Number(id) }).first('id');
  if (used) await knex('sales_services').where({ id: Number(id) }).update({ active: false, updated_at: new Date() });
  else await knex('sales_services').where({ id: Number(id) }).del();
  return used ? 'deactivated' : 'deleted';
}

// ---------------------------------------------------------------- quotations
/** Lines from the form (parallel arrays), with amounts; empty rows are skipped. */
function readItems(body, currency) {
  const list = (k) => [].concat(body[k] === undefined ? [] : body[k]);
  const desc = list('item_description'); const qty = list('item_quantity'); const price = list('item_price'); const svc = list('item_service_id');
  const items = []; const errors = {};
  for (let i = 0; i < desc.length && items.length < 50; i += 1) {
    const d = str(desc[i], 500);
    if (!d && !String(price[i] || '').trim()) continue; // eslint-disable-line no-continue
    const q = Number(String(qty[i] === undefined || qty[i] === '' ? '1' : qty[i]).replace(/,/g, '')); const p = Number(String(price[i] || '0').replace(/,/g, ''));
    if (!d) errors.items = 'Every line needs a description.';
    else if (!Number.isFinite(q) || q <= 0 || q > 100000) errors.items = 'Quantities must be more than zero.';
    else if (!Number.isFinite(p) || p < 0 || p > 100000000) errors.items = 'Prices must be zero or more.';
    items.push({ description: d, quantity: q, unit_price: p, amount: round((Number.isFinite(q) ? q : 0) * (Number.isFinite(p) ? p : 0), currency), sort: items.length, service_id: Number(svc[i]) || null });
  }
  if (!items.length) errors.items = 'Add at least one line.';
  return { items, errors };
}
function totals(items, { discount, taxRate, currency }) {
  const subtotal = round(items.reduce((s, i) => s + i.amount, 0), currency);
  const disc = Math.min(subtotal, Math.max(0, round(discount, currency)));
  const tax = round(((subtotal - disc) * taxRate) / 100, currency);
  return { subtotal, discount: disc, tax, total: round(subtotal - disc + tax, currency) };
}
async function nextNumber(trx) {
  const prefix = `Q-${new Date().getUTCFullYear()}-`;
  const last = await trx('quotes').where('number', 'like', `${prefix}%`).orderBy('id', 'desc').forUpdate().first('number');
  return `${prefix}${String(last ? Number(last.number.slice(prefix.length)) + 1 : 1).padStart(4, '0')}`;
}
async function readQuote(body) {
  const p = await profile();
  const errors = {};
  const v = {
    contact_id: Number(body.contact_id) || null, customer_name: str(body.customer_name, 150), customer_company: str(body.customer_company, 150) || null,
    customer_email: str(body.customer_email, 190).toLowerCase() || null, customer_phone: str(body.customer_phone, 40) || null,
    customer_vat: str(body.customer_vat, 40) || null, customer_address: str(body.customer_address, 255) || null,
    locale: body.locale === 'en' ? 'en' : 'ar', currency: /^[A-Z]{3}$/.test(String(body.currency || '')) ? body.currency : p.currency,
    issue_date: /^\d{4}-\d{2}-\d{2}$/.test(body.issue_date || '') ? body.issue_date : today(),
    notes: str(body.notes, 3000) || null, terms: str(body.terms, 5000) || null,
  };
  v.valid_until = /^\d{4}-\d{2}-\d{2}$/.test(body.valid_until || '') ? body.valid_until : addDays(v.issue_date, p.valid_days);
  if (!v.customer_name) errors.customer_name = 'Enter the customer name.';
  if (v.customer_email && !EMAIL_RE.test(v.customer_email)) errors.customer_email = 'Enter a valid email address.';
  if (v.valid_until < v.issue_date) errors.valid_until = 'The quotation must be valid on or after its date.';
  const cRow = v.contact_id ? await knex('crm_contacts').where({ id: v.contact_id }).first('id', 'country') : null;
  if (!cRow) v.contact_id = null;
  const rates = ratesFor(p, cRow && cRow.country);
  if (!/^[A-Z]{3}$/.test(String(body.currency || ''))) v.currency = rates.currency;
  const taxRate = body.tax_rate === undefined || body.tax_rate === '' ? Number(rates.tax) : Number(body.tax_rate);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) errors.tax_rate = 'Enter the VAT rate (e.g. 16).';
  const discount = Number(String(body.discount || '0').replace(/,/g, ''));
  if (!Number.isFinite(discount) || discount < 0) errors.discount = 'The discount must be zero or more.';
  const { items, errors: itemErrors } = readItems(body, v.currency);
  Object.assign(errors, itemErrors);
  if (Object.keys(errors).length) throw E.validation(errors);
  return { v: { ...v, tax_rate: taxRate, ...totals(items, { discount, taxRate, currency: v.currency }) }, items };
}
const itemRows = (quoteId, items) => items.map((i) => ({ quote_id: quoteId, description: i.description, quantity: i.quantity, unit_price: i.unit_price, amount: i.amount, sort: i.sort, service_id: i.service_id || null }));

async function createQuote(ctx, body) {
  const { v, items } = await readQuote(body);
  const id = await knex.transaction(async (trx) => {
    const [qid] = await trx('quotes').insert({ ...v, number: await nextNumber(trx), token: randomToken(24), created_by: ctx.userId || null });
    await trx('quote_items').insert(itemRows(qid, items));
    return qid;
  });
  await audit.record(ctx, 'platform.quote_created', { entityType: 'quote', entityId: id, newValues: { total: v.total, customer: v.customer_name } });
  if (v.contact_id) await crm().log(ctx, v.contact_id, 'quote', `${(await getQuote(id)).number} · ${v.total} ${v.currency}`).catch(() => {});
  return id;
}
async function getQuote(id) {
  const q = await knex('quotes').where({ id: Number(id) || 0 }).first();
  if (!q) throw E.notFound('Quotation');
  q.items = await knex('quote_items').where({ quote_id: q.id }).orderBy('sort');
  return q;
}
async function updateQuote(ctx, id, body, { revised = false } = {}) {
  const q = await getQuote(id);
  if (['accepted', 'declined'].includes(q.status)) throw new AppError('QUOTE_CLOSED', 'This quotation was already answered by the customer. Duplicate it to make a new one.', 409);
  const { v, items } = await readQuote(body);
  await knex.transaction(async (trx) => {
    await trx('quotes').where({ id: q.id }).update({ ...v, ...(revised ? { revision: q.revision + 1, status: q.status === 'draft' ? 'draft' : 'sent' } : {}), updated_at: new Date() });
    await trx('quote_items').where({ quote_id: q.id }).del();
    await trx('quote_items').insert(itemRows(q.id, items));
    if (revised) await trx('quote_events').insert({ quote_id: q.id, type: 'revised', by: 'team', user_id: ctx.userId || null, amount: v.total, revision: q.revision + 1, message: str(body.revision_note, 2000) || null });
  });
  await audit.record(ctx, 'platform.quote_updated', { entityType: 'quote', entityId: q.id, newValues: { total: v.total, revised } });
  return q.id;
}
async function duplicateQuote(ctx, id) {
  const q = await getQuote(id);
  const p = await profile();
  const KEEP = ['contact_id', 'customer_name', 'customer_company', 'customer_email', 'customer_phone', 'customer_vat', 'customer_address', 'locale', 'currency', 'subtotal', 'discount', 'tax_rate', 'tax', 'total', 'notes', 'terms'];
  const newId = await knex.transaction(async (trx) => {
    const [qid] = await trx('quotes').insert({ ...Object.fromEntries(KEEP.map((k) => [k, q[k]])), issue_date: today(), valid_until: addDays(today(), p.valid_days), number: await nextNumber(trx), token: randomToken(24), created_by: ctx.userId || null });
    await trx('quote_items').insert(q.items.map((i) => ({ quote_id: qid, description: i.description, quantity: i.quantity, unit_price: i.unit_price, amount: i.amount, sort: i.sort, service_id: i.service_id })));
    return qid;
  });
  await audit.record(ctx, 'platform.quote_created', { entityType: 'quote', entityId: newId, newValues: { from: q.number } });
  return newId;
}
async function removeQuote(ctx, id) {
  const q = await getQuote(id);
  if (q.status !== 'draft') throw new AppError('QUOTE_SENT', 'Only draft quotations can be deleted. A sent quotation stays for the record.', 409);
  await knex('quotes').where({ id: q.id }).del();
  await audit.record(ctx, 'platform.quote_deleted', { entityType: 'quote', entityId: q.id, oldValues: { number: q.number } });
}
/** draft, sent, viewed, negotiating, accepted, declined or expired. */
function quoteState(q) {
  if (q.status === 'accepted' || q.status === 'declined') return q.status;
  if (dateOnly(q.valid_until) < today()) return 'expired';
  if (q.status === 'negotiating') return 'negotiating';
  if (q.first_viewed_at && q.status !== 'draft') return 'viewed';
  return q.status;
}
async function listQuotes({ state, contactId } = {}) {
  const q = knex('quotes as q').leftJoin('users as u', 'u.id', 'q.created_by').select('q.*', 'u.name as created_by_name').orderBy('q.id', 'desc').limit(500);
  if (contactId) q.where('q.contact_id', contactId);
  const out = (await q).map((x) => ({ ...x, state: quoteState(x) }));
  return state ? out.filter((x) => x.state === state) : out;
}
function quoteSummary(rows) {
  const year = String(new Date().getUTCFullYear());
  const sum = (list) => list.reduce((s, q) => s + Number(q.total), 0);
  const open = rows.filter((q) => ['sent', 'viewed', 'negotiating'].includes(q.state));
  const won = rows.filter((q) => q.state === 'accepted' && dateOnly(q.responded_at || q.updated_at).startsWith(year));
  return { open: open.length, openTotal: sum(open), won: won.length, wonTotal: sum(won), drafts: rows.filter((q) => q.state === 'draft').length };
}
/** The customer's link (views by the platform's team are not counted). */
async function quoteByToken(token, { count = true } = {}) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) throw E.notFound('Quotation');
  const q = await knex('quotes').where({ token }).first();
  if (!q) throw E.notFound('Quotation');
  if (count && q.status !== 'draft') {
    const now = new Date();
    await knex('quotes').where({ id: q.id }).update({ view_count: knex.raw('view_count + 1'), last_viewed_at: now, first_viewed_at: q.first_viewed_at || now });
    if (!q.first_viewed_at && q.contact_id) await crm().log({ userId: null }, q.contact_id, 'quote', `${q.number}: opened by the customer`).catch(() => {});
    q.first_viewed_at = q.first_viewed_at || now;
  }
  q.items = await knex('quote_items').where({ quote_id: q.id }).orderBy('sort');
  return q;
}
const events = (quoteId) => knex('quote_events as e').leftJoin('users as u', 'u.id', 'e.user_id').where('e.quote_id', quoteId).orderBy('e.id').select('e.*', 'u.name as user_name');

// ---------------------------------------------------------------- the platform's subscription invoices: a link
async function invoiceShareToken(invoiceId) {
  const inv = await knex('platform_invoices').where({ id: Number(invoiceId) || 0 }).first('id', 'share_token');
  if (!inv) throw E.notFound('Invoice');
  if (inv.share_token) return inv.share_token;
  await knex('platform_invoices').where({ id: inv.id }).whereNull('share_token').update({ share_token: randomToken(24) });
  return (await knex('platform_invoices').where({ id: inv.id }).first('share_token')).share_token;
}
async function invoiceByToken(token, { count = true } = {}) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) throw E.notFound('Invoice');
  const inv = await knex('platform_invoices as i').join('businesses as b', 'b.id', 'i.business_id').where('i.share_token', token).whereNot('i.status', 'void')
    .first('i.*', 'b.name as clinic_name', 'b.name_en as clinic_name_en', 'b.address as clinic_address', 'b.city as clinic_city', 'b.tax_number as clinic_tax');
  if (!inv) throw E.notFound('Invoice');
  if (count) await knex('platform_invoices').where({ id: inv.id }).update({ view_count: knex.raw('view_count + 1'), last_viewed_at: new Date() });
  return inv;
}
/** The clinic owner an invoice goes to. */
async function invoiceRecipient(businessId) {
  const b = await knex('businesses').where({ id: businessId }).first('id', 'name', 'phone', 'whatsapp', 'country');
  const owner = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').join('users as u', 'u.id', 'm.user_id')
    .where({ 'm.business_id': businessId, 'r.key': 'owner' }).orderBy('m.id').first('u.name', 'u.email', 'u.locale', 'u.phone');
  return { business: b, name: owner ? owner.name : b.name, email: owner ? owner.email : null, phone: (b && (b.whatsapp || b.phone)) || (owner && owner.phone) || null, locale: (owner && owner.locale) === 'en' ? 'en' : 'ar', country: b && b.country };
}

// ---------------------------------------------------------------- sending (e-mail, WhatsApp link)
const T = {
  ar: {
    quote_subject: 'عرض سعر {number} من {seller}', quote_body: 'مرحبا {customer}،\n\nمرفق عرض السعر رقم {number} بقيمة {total}، صالح حتى {valid_until}.\nبتقدر تشوفه وتطبعه وتوافق عليه أو تفاوض عليه من الرابط.\n\nمع التحية،\n{seller}', quote_cta: 'عرض السعر',
    quote_whatsapp: 'مرحبا {customer}، هذا عرض السعر رقم {number} بقيمة {total} من {seller}، صالح حتى {valid_until}:\n{link}',
    invoice_subject: 'فاتورة {number} من {seller}', invoice_body: 'مرحبا {customer}،\n\nفاتورة الاشتراك رقم {number} بقيمة {total}.\nبتقدر تشوفها وتطبعها من الرابط.\n\nمع التحية،\n{seller}', invoice_cta: 'الفاتورة',
    invoice_whatsapp: 'مرحبا {customer}، هذه فاتورة الاشتراك رقم {number} بقيمة {total} من {seller}:\n{link}',
    document_subject: '{number} — {seller}', document_body: 'مرحبا {customer}،\n\nمرفق {number}.\nبتقدر تشوفه وتطبعه من الرابط.\n\nمع التحية،\n{seller}', document_cta: 'فتح المستند',
    document_whatsapp: 'مرحبا {customer}، هذا {number} من {seller}:\n{link}',
    receipt_subject: 'تم استلام دفعتك — فاتورة {number}', receipt_body: 'مرحبا {customer}،\n\nاستلمنا دفعة الفاتورة رقم {number} بقيمة {total}. شكراً لك، اشتراكك فعّال.\nبتقدر تشوف الفاتورة وتطبعها من الرابط.\n\nمع التحية،\n{seller}',
    overdue_subject: 'تذكير: فاتورة {number} بانتظار الدفع', overdue_body: 'مرحبا {customer}،\n\nنذكّرك إنه فاتورة الاشتراك رقم {number} بقيمة {total} لسا ما انْدفعت.\nبتلاقي طرق الدفع على الرابط، وإذا دفعت بلّغنا من صفحة الاشتراك.\n\nمع التحية،\n{seller}',
  },
  en: {
    quote_subject: 'Quotation {number} from {seller}', quote_body: 'Hello {customer},\n\nHere is quotation {number} for {total}, valid until {valid_until}.\nYou can view, print, accept or negotiate it from the link.\n\nBest regards,\n{seller}', quote_cta: 'View quotation',
    quote_whatsapp: 'Hello {customer}, here is quotation {number} for {total} from {seller}, valid until {valid_until}:\n{link}',
    invoice_subject: 'Invoice {number} from {seller}', invoice_body: 'Hello {customer},\n\nHere is subscription invoice {number} for {total}.\nYou can view and print it from the link.\n\nBest regards,\n{seller}', invoice_cta: 'View invoice',
    invoice_whatsapp: 'Hello {customer}, here is subscription invoice {number} for {total} from {seller}:\n{link}',
    document_subject: '{number} — {seller}', document_body: 'Hello {customer},\n\nPlease find {number} at the link below; you can view and print it.\n\nBest regards,\n{seller}', document_cta: 'Open document',
    document_whatsapp: 'Hello {customer}, here is {number} from {seller}:\n{link}',
    receipt_subject: 'Payment received — invoice {number}', receipt_body: 'Hello {customer},\n\nWe received the payment of invoice {number} for {total}. Thank you — your subscription is active.\nYou can view and print the invoice from the link.\n\nBest regards,\n{seller}',
    overdue_subject: 'Reminder: invoice {number} is waiting for payment', overdue_body: 'Hello {customer},\n\nA reminder that subscription invoice {number} for {total} is not paid yet.\nThe payment details are at the link; once paid, let us know from the subscription page.\n\nBest regards,\n{seller}',
  },
};
const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
const moneyText = (amount, currency, locale) => { try { return require('../../core/format').formatMoney(amount, currency, locale); } catch { return `${amount} ${currency}`; } }; // eslint-disable-line global-require

/** Everything needed to send a document: recipient defaults, the customer link, ready texts. */
async function sendable(type, id, base, locale) {
  const p = await profile();
  const root = String(base || process.env.APP_URL || '').replace(/\/+$/, '');
  if (type === 'quote') {
    const q = await getQuote(id);
    const loc = locale === 'en' || locale === 'ar' ? locale : q.locale;
    const vars = { customer: q.customer_name, number: q.number, total: moneyText(q.total, q.currency, loc), valid_until: dateOnly(q.valid_until), seller: sellerName(p, loc), link: `${root}/quote/${q.token}` };
    return { type, id: q.id, label: q.number, locale: loc, contactId: q.contact_id, name: q.customer_name, email: q.customer_email, phone: q.customer_phone, link: vars.link, quote: q, vars, texts: texts('quote', loc, vars) };
  }
  if (type === 'invoice') {
    const inv = await knex('platform_invoices').where({ id: Number(id) || 0 }).first();
    if (!inv) throw E.notFound('Invoice');
    if (inv.status === 'void') throw new AppError('INVOICE_VOID', 'This invoice was voided and cannot be sent.', 409);
    const r = await invoiceRecipient(inv.business_id);
    const loc = locale === 'en' || locale === 'ar' ? locale : r.locale;
    const contact = await knex('crm_contacts').where({ business_id: inv.business_id }).orderBy('id').first('id');
    const vars = { customer: r.name, number: inv.number || `#${inv.id}`, total: moneyText(inv.amount, inv.currency, loc), seller: sellerName(p, loc), link: `${root}/invoice/${await invoiceShareToken(inv.id)}` };
    return { type, id: inv.id, label: vars.number, locale: loc, contactId: contact ? contact.id : null, name: r.name, email: r.email, phone: r.phone, country: r.country, link: vars.link, invoice: inv, vars, texts: texts('invoice', loc, vars) };
  }
  if (type === 'document') {
    const d = await knex('sales_documents').where({ id: Number(id) || 0 }).first();
    if (!d) throw E.notFound('Document');
    const loc = locale === 'en' || locale === 'ar' ? locale : d.locale;
    const c = d.contact_id ? await knex('crm_contacts').where({ id: d.contact_id }).first('country') : null;
    const vars = { customer: d.recipient_name || '', number: d.title, seller: sellerName(p, loc), link: `${root}/document/${d.token}` };
    return { type, id: d.id, label: d.title, locale: loc, contactId: d.contact_id, name: d.recipient_name, email: d.recipient_email, phone: d.recipient_phone, country: c && c.country, link: vars.link, document: d, vars, texts: texts('document', loc, vars) };
  }
  throw E.notFound('Document');
}
function texts(type, locale, vars) {
  const t = T[locale] || T.ar;
  if (type === 'invoice') return { subject: fill(t.invoice_subject, vars), body: fill(t.invoice_body, vars), cta: t.invoice_cta, whatsapp: fill(t.invoice_whatsapp, vars), receipt: { subject: fill(t.receipt_subject, vars), body: fill(t.receipt_body, vars) }, overdue: { subject: fill(t.overdue_subject, vars), body: fill(t.overdue_body, vars) } };
  return { subject: fill(t[`${type}_subject`], vars), body: fill(t[`${type}_body`], vars), cta: t[`${type}_cta`], whatsapp: fill(t[`${type}_whatsapp`], vars) };
}

async function logSend(ctx, doc, { channel, recipient, status, error, subject, body }) {
  await knex('document_sends').insert({ doc_type: doc.type, doc_id: doc.id, channel, recipient: str(recipient, 190), contact_id: doc.contactId || null, status, error: error ? str(error, 500) : null, subject: subject ? str(subject, 200) : null, body: body ? String(body).slice(0, 10000) : null, user_id: ctx.userId || null });
  if (doc.contactId) await crm().log(ctx, doc.contactId, channel, `${subject || doc.label}${body ? `\n\n${body}` : ''}`, status === 'opened' ? 'sent' : status).catch(() => {});
  if (doc.type === 'quote' && status !== 'failed' && doc.quote.status === 'draft') await knex('quotes').where({ id: doc.id }).update({ status: 'sent', sent_at: new Date() });
}

/** E-mails the document: the customer link as a button. */
async function sendEmail(ctx, type, id, body, base) {
  const doc = await sendable(type, id, base, body.locale);
  const to = str(body.to, 190).toLowerCase();
  const subject = str(body.subject, 200).replace(/[\r\n]+/g, ' ');
  const text = String(body.body || '').replace(/\r\n/g, '\n').trim().slice(0, 8000);
  const errors = {};
  if (!EMAIL_RE.test(to)) errors.to = 'Enter a valid email address.';
  if (!subject) errors.subject = 'Write a subject.';
  if (!text) errors.body = 'Write the message.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  let status = 'sent'; let error = null;
  try {
    const sent = await mailer.send({ kind: type, to, subject, html: mailer.layout({ locale: doc.locale, title: subject, body: text, cta: doc.texts.cta, href: doc.link }) });
    if (!sent) { status = 'failed'; error = 'The platform e-mail is not set up (Admin → Platform settings).'; }
  } catch (e) { status = 'failed'; error = e.message; }
  await logSend(ctx, doc, { channel: 'email', recipient: to, status, error, subject, body: text });
  if (status === 'failed') throw new AppError('SEND_FAILED', error, 502, { to: error });
  return doc;
}
/** The wa.me link with the text ready (WhatsApp opens on the team member's phone or computer); logged as opened. */
async function whatsappLink(ctx, type, id, body, base) {
  const doc = await sendable(type, id, base, body.locale);
  const ch = require('../messaging/channels'); // eslint-disable-line global-require
  const dial = { JO: '962', SA: '966', AE: '971', KW: '965', QA: '974', BH: '973', OM: '968', EG: '20', IQ: '964', PS: '970' }[doc.country] || (doc.locale === 'ar' ? '962' : '962');
  const n = ch.msisdn(body.phone || doc.phone, dial);
  if (!n) throw E.validation({ phone: 'Enter a valid mobile number with its country code.' });
  const text = String(body.text || doc.texts.whatsapp).replace(/\r\n/g, '\n').trim().slice(0, 4000);
  await logSend(ctx, doc, { channel: 'whatsapp', recipient: `+${n}`, status: 'opened', body: text });
  return ch.waMeLink(n, text);
}
const sendsFor = (type, id) => knex('document_sends as s').leftJoin('users as u', 'u.id', 's.user_id').where({ 's.doc_type': type, 's.doc_id': Number(id) || 0 }).select('s.*', 'u.name as user_name').orderBy('s.id', 'desc').limit(50);

module.exports = {
  PROFILE_FIELDS, COUNTRY_RATES, ratesFor, profile, saveProfile, sellerName,
  listServices, serviceText, saveService, removeService,
  readItems, totals, createQuote, getQuote, updateQuote, duplicateQuote, removeQuote, quoteState, listQuotes, quoteSummary, quoteByToken, events,
  invoiceShareToken, invoiceByToken, invoiceRecipient,
  sendable, sendEmail, whatsappLink, sendsFor, dateOnly,
};
