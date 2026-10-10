// Salary transfer files for any bank. Banks differ in what they want (columns, order, labels, separator, Excel or
// CSV, date format), so the clinic describes each bank once as a template — a list of columns picked from the payee
// fields below, each with its own header text — plus the bank's e-mail and the clinic's debit account. A month's
// payees (staff lines + doctors, net > 0) are grouped by bank: a payee whose bank name matches a template's name or
// one of its other spellings goes in that bank's file; the rest go in the default template. The file is downloaded or
// e-mailed to the bank as an attachment; every file is logged (bank_transfers) and audited, and the payees can be
// marked paid by bank transfer in the same step.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { z, validate, optionalString } = require('../../core/validate');
const xlsx = require('../../core/xlsx');
const staff = require('../finance/staff.service');
const doctorPay = require('../clinic/payroll.service');

const FIELDS = ['seq', 'name', 'iban', 'bank_name', 'amount', 'currency', 'period', 'reference', 'payee_type', 'job_title', 'email', 'phone',
  'debit_iban', 'debit_name', 'clinic', 'value_date', 'text'];
const FORMATS = ['csv', 'xlsx'];
const DELIMITERS = { comma: ',', semicolon: ';', tab: '\t', pipe: '|' };
const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYYMMDD', 'DD-MM-YYYY'];

// Ready layouts to start from (the labels are the clinic's to change).
const PRESETS = {
  simple: { format: 'csv', delimiter: ',', columns: ['seq', 'name', 'iban', 'bank_name', 'amount', 'currency', 'reference'] },
  detailed: { format: 'xlsx', delimiter: ',', columns: ['seq', 'debit_iban', 'name', 'iban', 'bank_name', 'amount', 'currency', 'value_date', 'reference', 'job_title', 'email'] },
};

// ------------------------------------------------------------------ IBAN
const compact = (v) => String(v || '').replace(/[\s-]+/g, '').toUpperCase();
/** True for a valid IBAN (ISO 13616 mod-97). Local account numbers (no country letters) are not IBANs. */
function ibanValid(v) {
  const s = compact(v);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) { // eslint-disable-line no-restricted-syntax
    const n = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) rem = (rem * 10 + Number(d)) % 97; // eslint-disable-line no-restricted-syntax
  }
  return rem === 1;
}
/** 'ok' (valid IBAN), 'account' (a local account number, taken as is), 'bad' (looks like an IBAN but fails), 'missing'. */
function accountState(v) {
  const s = compact(v);
  if (!s) return 'missing';
  if (/^[A-Z]{2}\d{2}/.test(s)) return ibanValid(s) ? 'ok' : 'bad';
  return /^[A-Z0-9]{4,34}$/.test(s) ? 'account' : 'bad';
}

// ------------------------------------------------------------------ templates
const parseCols = (v) => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; } catch { return []; } };
const shape = (r) => (r ? { ...r, columns: parseCols(r.columns), matchList: String(r.match || '').split(/[,،\n]/).map((x) => x.trim()).filter(Boolean) } : r);

const list = async (ctx) => (await knex('bank_templates').where({ business_id: ctx.businessId }).orderBy([{ column: 'is_default', order: 'desc' }, { column: 'name' }])).map(shape);
async function get(ctx, id) {
  const r = await knex('bank_templates').where({ id: Number(id) || 0, business_id: ctx.businessId }).first();
  if (!r) throw E.notFound('Bank template');
  return shape(r);
}

const tplSchema = z.object({
  name: z.string().trim().min(1, 'Required.').max(120),
  match: optionalString(500),
  email: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().toLowerCase().email('Enter a valid e-mail.').max(190).optional()),
  format: z.enum(FORMATS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  delimiter: z.enum(Object.keys(DELIMITERS), { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  decimals: z.coerce.number().int().min(0).max(3),
  date_format: z.enum(DATE_FORMATS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  debit_iban: optionalString(60),
  debit_name: optionalString(190),
});

/** Columns from the form: col_field[], col_label[], col_value[] (value = the fixed text of a "text" column). */
function columnsFrom(input) {
  const arr = (v) => (v === undefined ? [] : [].concat(v));
  const fields = arr(input.col_field); const labels = arr(input.col_label); const values = arr(input.col_value);
  const cols = fields.map((f, i) => ({ field: String(f), label: String(labels[i] || '').trim().slice(0, 80), value: String(values[i] || '').trim().slice(0, 120) }))
    .filter((c) => FIELDS.includes(c.field)).slice(0, 30);
  if (!cols.length) throw E.validation({ columns: 'Add at least one column.' });
  if (!cols.some((c) => c.field === 'amount') || !cols.some((c) => c.field === 'iban')) throw E.validation({ columns: 'The file needs the account (IBAN) and amount columns.' });
  return cols;
}

async function save(ctx, id, input) {
  const d = validate(tplSchema, input);
  const columns = columnsFrom(input);
  const row = {
    name: d.name, match: d.match || null, email: d.email || null, format: d.format, delimiter: DELIMITERS[d.delimiter], header: ['1', 'on', true].includes(input.header),
    columns: JSON.stringify(columns), decimals: d.decimals, date_format: d.date_format, debit_iban: d.debit_iban ? compact(d.debit_iban) : null, debit_name: d.debit_name || null,
    is_default: ['1', 'on', true].includes(input.is_default),
  };
  return knex.transaction(async (trx) => {
    let tid = id;
    if (id) {
      const before = await get(ctx, id);
      await trx('bank_templates').where({ id: before.id }).update({ ...row, updated_at: new Date() });
      await audit.record(ctx, 'bank_template.updated', { entityType: 'bank_template', entityId: before.id, oldValues: { name: before.name, email: before.email }, newValues: { name: row.name, email: row.email, columns: columns.length } }, trx);
    } else {
      [tid] = await trx('bank_templates').insert({ ...row, business_id: ctx.businessId });
      await audit.record(ctx, 'bank_template.created', { entityType: 'bank_template', entityId: tid, newValues: { name: row.name, email: row.email, columns: columns.length } }, trx);
    }
    // One default: the first template is the default; choosing another moves it.
    const count = await trx('bank_templates').where({ business_id: ctx.businessId, is_default: true }).whereNot({ id: tid }).count({ n: '*' }).first();
    if (row.is_default) await trx('bank_templates').where({ business_id: ctx.businessId }).whereNot({ id: tid }).update({ is_default: false });
    else if (!Number(count.n)) await trx('bank_templates').where({ id: tid }).update({ is_default: true });
    return tid;
  });
}

async function remove(ctx, id) {
  const r = await get(ctx, id);
  await knex('bank_templates').where({ id: r.id }).del();
  if (r.is_default) {
    const next = await knex('bank_templates').where({ business_id: ctx.businessId }).orderBy('id').first('id');
    if (next) await knex('bank_templates').where({ id: next.id }).update({ is_default: true });
  }
  await audit.record(ctx, 'bank_template.deleted', { entityType: 'bank_template', entityId: r.id, oldValues: { name: r.name } });
}

/** A new template from a ready layout, labelled in the clinic's language. */
async function fromPreset(ctx, key, t) {
  const p = PRESETS[key];
  if (!p) throw E.validation({ preset: 'Choose a valid value.' });
  const input = {
    name: t(`payouts.preset.${key}`), format: p.format, delimiter: Object.keys(DELIMITERS).find((k) => DELIMITERS[k] === p.delimiter), decimals: 3, date_format: 'YYYY-MM-DD', header: '1',
    col_field: p.columns, col_label: p.columns.map((f) => t(`payouts.field.${f}`)), col_value: p.columns.map(() => ''),
  };
  return save(ctx, null, input);
}

// ------------------------------------------------------------------ payees
/** Everyone to pay for the month: staff lines and doctors with a net above zero, with their bank details. */
async function payees(ctx, period) {
  const out = [];
  const sh = await staff.sheet(ctx, period);
  const emps = Object.fromEntries((await knex('staff_employees').where({ business_id: ctx.businessId }).select('id', 'email', 'phone')).map((e) => [e.id, e]));
  sh.rows.filter((r) => r.f.net > 0).forEach((r) => out.push({
    key: `staff:${r.id}`, type: 'staff', id: r.id, name: r.employee_name, job_title: r.job_title || '', bank_name: r.bank_name || '', iban: compact(r.iban),
    email: (emps[r.employee_id] || {}).email || '', phone: (emps[r.employee_id] || {}).phone || '', amount: r.f.net, paid: r.status === 'paid', method: r.payment_method || null,
  }));
  const docs = await knex('doctors').where({ business_id: ctx.businessId }).modify((q) => { if (ctx.workBranch) q.whereIn('id', require('../clinic/branches.service').payDoctorIds(ctx)); }).orderBy([{ column: 'sort_order' }, { column: 'full_name' }]);
  for (const d of docs) { // eslint-disable-line no-restricted-syntax
    const c = await doctorPay.calculate(ctx, d.id, period); // eslint-disable-line no-await-in-loop
    const net = c.payment ? Number(c.payment.net_pay) : c.netPayroll;
    if (!(net > 0) || (!d.is_active && !c.payment)) continue; // eslint-disable-line no-continue
    out.push({
      key: `doctor:${d.id}`, type: 'doctor', id: d.id, name: d.full_name, name_en: d.full_name_en, job_title: d.specialization || '', bank_name: d.bank_name || '', iban: compact(d.iban),
      email: d.email || '', phone: d.phone || '', amount: net, paid: Boolean(c.payment), method: c.payment ? c.payment.payment_method : null,
    });
  }
  return out.map((p) => ({ ...p, account: accountState(p.iban) }));
}

const norm = (v) => String(v || '').toLowerCase().normalize('NFKD').replace(/[ً-ٟ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/[^\p{L}\p{N}]+/gu, '');
/** The template for a bank name: by its name or another spelling, else the default one. */
function templateFor(templates, bankName) {
  const b = norm(bankName);
  if (b) {
    const hit = templates.find((t) => [t.name, ...t.matchList].some((m) => { const n = norm(m); return n && (b.includes(n) || n.includes(b)); }));
    if (hit) return hit;
  }
  return templates.find((t) => t.is_default) || templates[0] || null;
}

/** Payees grouped into one file per template. */
function groups(templates, list) {
  const map = new Map();
  list.forEach((p) => {
    const tpl = templateFor(templates, p.bank_name);
    const k = tpl ? tpl.id : 0;
    if (!map.has(k)) map.set(k, { template: tpl, payees: [] });
    map.get(k).payees.push(p);
  });
  return [...map.values()].map((g) => ({ ...g, total: Math.round(g.payees.reduce((s, p) => s + p.amount, 0) * 1000) / 1000 }));
}

// ------------------------------------------------------------------ the file
/** Half-up rounding at `d` decimals that survives binary fractions (1.005 → 1.01). */
const roundTo = (v, d) => { const f = 10 ** d; return Math.round(Number((Number(v) * f).toPrecision(12))) / f; };
function dateText(iso, f) {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return { 'YYYY-MM-DD': `${y}-${m}-${d}`, 'DD/MM/YYYY': `${d}/${m}/${y}`, 'MM/DD/YYYY': `${m}/${d}/${y}`, YYYYMMDD: `${y}${m}${d}`, 'DD-MM-YYYY': `${d}-${m}-${y}` }[f] || `${y}-${m}-${d}`;
}
const csvCell = (v, sep) => { const s = String(v ?? ''); return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/**
 * Builds one bank file. info = { period, valueDate, currency, clinicName, reference, t }.
 * Returns { buffer, filename, mime }.
 */
function build(tpl, list, info) {
  const val = (p, c, i) => {
    switch (c.field) {
      case 'seq': return i + 1;
      case 'name': return p.name;
      case 'iban': return p.iban;
      case 'bank_name': return p.bank_name;
      case 'amount': { const v = roundTo(p.amount, tpl.decimals); return tpl.format === 'xlsx' ? v : v.toFixed(tpl.decimals); }
      case 'currency': return info.currency;
      case 'period': return info.period;
      case 'reference': return c.value || info.reference;
      case 'payee_type': return info.t(`payouts.type.${p.type}`);
      case 'job_title': return p.job_title;
      case 'email': return p.email;
      case 'phone': return p.phone;
      case 'debit_iban': return tpl.debit_iban || '';
      case 'debit_name': return tpl.debit_name || info.clinicName;
      case 'clinic': return info.clinicName;
      case 'value_date': return dateText(info.valueDate, tpl.date_format);
      case 'text': return c.value;
      default: return '';
    }
  };
  const header = tpl.columns.map((c) => c.label || info.t(`payouts.field.${c.field}`));
  const rows = list.map((p, i) => tpl.columns.map((c) => val(p, c, i)));
  const slug = String(tpl.name).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'bank';
  const base = `salaries-${info.period}-${slug}`;
  if (tpl.format === 'xlsx') {
    const sheets = tpl.header ? [{ name: info.period, header, rows }] : [{ name: info.period, header: rows[0] || header, rows: rows.slice(1) }];
    return { buffer: xlsx.build(sheets), filename: `${base}.xlsx`, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  const sep = tpl.delimiter || ',';
  const lines = (tpl.header ? [header, ...rows] : rows).map((r) => r.map((v) => csvCell(v, sep)).join(sep));
  // UTF-8 with a BOM so Excel shows Arabic names; CRLF line ends as most bank portals expect.
  return { buffer: Buffer.concat([Buffer.from('﻿'), Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8')]), filename: `${base}.csv`, mime: 'text/csv; charset=utf-8' };
}

/**
 * Makes the file of one template for the chosen payees: download or e-mail to the bank (with the file attached),
 * logs it, and optionally marks the payees paid by bank transfer. Returns { file, sentTo, marked }.
 */
async function make(ctx, { templateId, period, keys, action, to, markPaid, valueDate, locale = 'ar', t }) {
  const tpl = await get(ctx, templateId);
  const all = await payees(ctx, period);
  const wanted = new Set([].concat(keys || []).map(String));
  // Each amount at the bank's decimals once, so the file, its total, the log and the e-mail agree.
  const chosen = all.filter((p) => wanted.has(p.key) && p.account !== 'missing' && p.account !== 'bad').map((p) => ({ ...p, amount: roundTo(p.amount, tpl.decimals) }));
  if (!chosen.length) throw new AppError('NO_PAYEES', 'Choose at least one person with a valid account.', 422);
  const clinic = await knex('businesses').where({ id: ctx.businessId }).first('id', 'name', 'name_en', 'email', 'currency', 'slug', 'color', 'logo_mime', 'logo_version');
  const clinicName = (locale === 'en' && clinic.name_en) || clinic.name;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(valueDate || '')) ? valueDate : ctx.today;
  const reference = t('payouts.reference_text', { period });
  const file = build(tpl, chosen, { period, valueDate: date, currency: clinic.currency, clinicName, reference, t });
  const total = roundTo(chosen.reduce((s, p) => s + p.amount, 0), tpl.decimals);
  let sentTo = null;
  if (action === 'email') {
    const address = String(to || tpl.email || '').trim().toLowerCase();
    if (!/^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(address) || address.length > 190) throw new AppError('NO_EMAIL', 'No e-mail address for this bank.', 422);
    const mailer = require('../../core/mailer'); // eslint-disable-line global-require
    if (!(await mailer.configuredFor(ctx.businessId))) throw new AppError('NO_MAIL', 'E-mail is not set up.', 409);
    const texts = require('../messaging/texts.service'); // eslint-disable-line global-require
    const tt = await texts.translatorFor(ctx.businessId, locale);
    const { formatMonth, formatMoney } = require('../../core/format'); // eslint-disable-line global-require
    const vars = { clinic: clinicName, bank: tpl.name, period: formatMonth(period, locale), count: chosen.length, total: formatMoney(total, clinic.currency, locale), account: tpl.debit_iban || '—' };
    const subject = tt('payouts.msg.bank_subject', vars);
    const html = mailer.layout({ locale, title: subject, body: tt('payouts.msg.bank_body', vars), clinic, base: ctx.baseUrl });
    let ok = false;
    try { ok = await mailer.send({ to: address, subject, html, replyTo: clinic.email || undefined, businessId: ctx.businessId, kind: 'suppliers', fromName: clinicName, attachments: [{ filename: file.filename, content: file.buffer, contentType: file.mime.split(';')[0] }] }); } catch { ok = false; }
    if (!ok) throw new AppError('MAIL_FAILED', 'The e-mail could not be sent.', 502);
    sentTo = address;
  }
  await knex('bank_transfers').insert({ business_id: ctx.businessId, template_id: tpl.id, bank_name: tpl.name, period, payees: chosen.length, total, action: sentTo ? 'email' : 'download', sent_to: sentTo, created_by: ctx.userId || null });
  await audit.record(ctx, sentTo ? 'bank_transfer.emailed' : 'bank_transfer.downloaded', { entityType: 'bank_template', entityId: tpl.id, newValues: { period, payees: chosen.length, total, to: sentTo || undefined } });
  let marked = 0;
  if (markPaid) {
    for (const p of chosen.filter((x) => !x.paid)) { // eslint-disable-line no-restricted-syntax
      try {
        if (p.type === 'staff') await staff.markPaid(ctx, p.id, { paid_on: date, payment_method: 'bank_transfer', reference: reference.slice(0, 100) }); // eslint-disable-line no-await-in-loop
        else await doctorPay.markPaid(ctx, p.id, period, { method: 'bank_transfer', reference: reference.slice(0, 100) }); // eslint-disable-line no-await-in-loop
        marked += 1;
      } catch { /* a locked or pending month stays as it is; the page shows it unpaid */ }
    }
  }
  return { file, sentTo, marked, count: chosen.length, total };
}

const history = (ctx, period) => knex('bank_transfers as b').leftJoin('users as u', 'u.id', 'b.created_by').where({ 'b.business_id': ctx.businessId })
  .modify((q) => { if (period) q.where('b.period', period); }).orderBy('b.created_at', 'desc').limit(30).select('b.*', 'u.name as by_name');

module.exports = { roundTo, FIELDS, FORMATS, DELIMITERS, DATE_FORMATS, PRESETS, ibanValid, accountState, list, get, save, remove, fromPreset, payees, templateFor, groups, build, make, history };
