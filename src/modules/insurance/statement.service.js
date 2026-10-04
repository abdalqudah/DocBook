// Insurance claims statements: for one insurance company and a period, every invoice of the clinic where the insurer
// pays a part — date, invoice number, patient and insurance number, doctor, service, diagnosis codes, the invoice
// total, coverage and the insurer's share — with totals. Exported as Excel or PDF, or e-mailed to the company with both
// attached (the clinic's own wording, Settings → Message texts). Every statement made is logged and audited.
// The insurer's share is the invoice's "insurance" payment part (older invoices paid wholly by insurance: the amount).
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { formatMoney, formatDate } = require('../../core/format');
const xlsx = require('../../core/xlsx');
const lib = require('../clinic/records.lib');
const parts = require('../clinic/payment-parts');

const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/** The period asked for, else last month (the usual claims period). */
function periodOf(q, today) {
  if (isDate(q.from) && isDate(q.to) && q.from <= q.to) return { from: q.from, to: q.to };
  const m = lib.addMonths(today.slice(0, 7), -1);
  return lib.monthBounds(m);
}

const providers = (ctx) => knex('insurance_providers').where({ business_id: ctx.businessId }).orderBy([{ column: 'is_active', order: 'desc' }, { column: 'sort_order' }, { column: 'name' }]);
async function provider(ctx, id) {
  const p = await knex('insurance_providers').where({ business_id: ctx.businessId, id: Number(id) || 0 }).first();
  if (!p) throw E.notFound('Insurance company');
  return p;
}

/** Statement lines and totals of one company for clinic dates from..to (inclusive). */
async function build(ctx, providerId, from, to) {
  const p = await provider(ctx, providerId);
  const q = lib.whereLocalDates(knex('invoices as i').where('i.business_id', ctx.businessId), 'i.created_at', from, to, ctx.timezone)
    .where((w) => w.where('i.insurance_provider_id', p.id).orWhere((x) => x.whereNull('i.insurance_provider_id').where('i.insurance_provider_name', p.name)))
    .leftJoin('patients as pt', function j() { this.on('pt.id', 'i.patient_id').andOn('pt.business_id', 'i.business_id'); })
    .orderBy('i.created_at').select('i.*', 'pt.insurance_number', 'pt.date_of_birth', 'pt.national_id');
  const rows = await q;
  const map = await parts.partsMap(ctx.businessId, rows.map((r) => r.id));
  const dx = await require('../clinicalplus/icd.service').diagnosesByAppointment(ctx.businessId, rows.map((r) => r.appointment_id)); // eslint-disable-line global-require
  const lines = [];
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    const ps = parts.partsOf(r, map);
    const insurer = r3(ps.filter((x) => x.method === 'insurance').reduce((t, x) => t + Number(x.amount || 0), 0));
    if (!(insurer > 0)) continue; // eslint-disable-line no-continue
    const codes = ((r.appointment_id && dx.get(r.appointment_id)) || []).map((d) => d.code).filter(Boolean).join(', ');
    const local = lib.localTime(r.created_at, ctx.timezone);
    lines.push({
      id: r.id, number: r.invoice_number, date: local.date, patient: r.patient_name, insuranceNo: r.insurance_number || '', nationalId: r.national_id || '',
      doctor: r.doctor_name || '', service: r.service_name || '', codes, total: r3(r.amount), coverage: r.insurance_coverage_percent !== null && r.insurance_coverage_percent !== undefined ? Number(r.insurance_coverage_percent) : null,
      insurer, patientPart: r3(Number(r.amount) - insurer),
    });
  }
  const totals = lines.reduce((t, l) => ({ count: t.count + 1, total: r3(t.total + l.total), insurer: r3(t.insurer + l.insurer), patient: r3(t.patient + l.patientPart) }), { count: 0, total: 0, insurer: 0, patient: 0 });
  return { provider: p, from, to, lines, totals };
}

/** Insurer totals per company for the period (the page's summary). */
async function summary(ctx, from, to) {
  const list = await providers(ctx);
  const out = [];
  for (const p of list) { // eslint-disable-line no-restricted-syntax
    const s = await build(ctx, p.id, from, to); // eslint-disable-line no-await-in-loop
    if (s.totals.count || p.is_active) out.push({ provider: p, totals: s.totals });
  }
  return out;
}

// ---------------------------------------------------------------- files
function header(t) {
  return [t('inscl.col.no'), t('inscl.col.date'), t('inscl.col.invoice'), t('inscl.col.patient'), t('inscl.col.insurance_no'), t('inscl.col.national_id'), t('inscl.col.doctor'),
    t('inscl.col.service'), t('inscl.col.codes'), t('inscl.col.total'), t('inscl.col.coverage'), t('inscl.col.insurer'), t('inscl.col.patient_part')];
}
function excel(st, t, locale) {
  const rows = st.lines.map((l, i) => [i + 1, l.date, l.number, l.patient, l.insuranceNo, l.nationalId, l.doctor, l.service, l.codes, l.total, l.coverage === null ? '' : l.coverage, l.insurer, l.patientPart]);
  rows.push([t('common.total'), '', st.totals.count, '', '', '', '', '', '', st.totals.total, '', st.totals.insurer, st.totals.patient]);
  return xlsx.build([{ name: st.provider.name.slice(0, 28) || 'Statement', header: header(t), rows }], { rtl: locale === 'ar' });
}

async function pdf(ctx, st, t, locale) {
  const { Writer, ltr, colors: C } = require('../patientdocs/pdf'); // eslint-disable-line global-require
  const en = locale === 'en';
  const clinic = await require('../../core/imageopt').pdfLogo(await knex('businesses').where({ id: ctx.businessId }).first('id', 'name', 'name_en', 'address', 'city', 'phone', 'email', 'currency', 'logo', 'logo_mime', 'tax_number')); // eslint-disable-line global-require
  const money = (v) => ltr(formatMoney(v, clinic.currency, locale));
  const w = new Writer({ locale, title: `${t('inscl.title')} ${st.provider.name}` });
  // Letterhead
  const top = w.y;
  let textX = w.left; let textW = w.width;
  if (clinic.logo && /png|jpe?g/.test(String(clinic.logo_mime || ''))) {
    const box = w.image(clinic.logo, { side: 'start', height: 44, maxWidth: 150, y: top });
    if (box) { textW = w.width - box.w - 16; if (!w.rtl) textX = w.left + box.w + 16; }
  }
  w.text((en && clinic.name_en) || clinic.name, { size: 14, bold: true, x: textX, width: textW, y: top });
  w.text([clinic.address, clinic.city].filter(Boolean).join(' · '), { size: 9, color: C.textMuted, x: textX, width: textW });
  w.text([clinic.phone ? ltr(clinic.phone) : '', clinic.email ? ltr(clinic.email) : '', clinic.tax_number ? `${t('inscl.tax_no')} ${ltr(clinic.tax_number)}` : ''].filter(Boolean).join('   '), { size: 9, color: C.textMuted, x: textX, width: textW });
  w.y = Math.max(w.y, top + 50);
  w.rule({ gap: 10, color: C.borderStrong });
  w.text(t('inscl.title'), { size: 15, bold: true });
  w.fields([
    { label: t('inscl.company'), value: st.provider.name },
    { label: t('inscl.period'), value: `${formatDate(st.from, locale)} – ${formatDate(st.to, locale)}` },
    { label: t('inscl.invoices'), value: String(st.totals.count) },
    { label: t('inscl.col.insurer'), value: money(st.totals.insurer) },
  ], { cols: 4 });
  w.space(6);
  // Table
  const cols = [
    { k: 'n', f: 0.04 }, { k: 'date', f: 0.09 }, { k: 'number', f: 0.07 }, { k: 'patient', f: 0.16 }, { k: 'insuranceNo', f: 0.11 }, { k: 'doctor', f: 0.12 },
    { k: 'service', f: 0.13 }, { k: 'codes', f: 0.08 }, { k: 'total', f: 0.09, num: true }, { k: 'insurer', f: 0.11, num: true },
  ];
  const labels = { n: '#', date: t('inscl.col.date'), number: t('inscl.col.invoice'), patient: t('inscl.col.patient'), insuranceNo: t('inscl.col.insurance_no'), doctor: t('inscl.col.doctor'), service: t('inscl.col.service'), codes: t('inscl.col.codes'), total: t('inscl.col.total'), insurer: t('inscl.col.insurer') };
  const xs = []; let acc = 0;
  cols.forEach((c) => { const width = w.width * c.f; xs.push({ x: w.rtl ? w.right - acc - width : w.left + acc, width: width - 4 }); acc += width; });
  const row = (vals, { bold = false, size = 7.5, rule = true } = {}) => {
    w.ensure(28);
    const y = w.y;
    let h = 0;
    cols.forEach((c, i) => {
      const v = vals[c.k] === undefined || vals[c.k] === null ? '' : String(vals[c.k]);
      const used = w.text(v, { x: xs[i].x, width: xs[i].width, y, size, bold, fixed: true, align: c.num ? 'end' : undefined, lineHeight: size * 1.5 });
      h = Math.max(h, used || size * 1.5);
    });
    w.y = y + h + 4;
    if (rule) w.doc.moveTo(w.left, w.y - 2).lineTo(w.right, w.y - 2).lineWidth(0.4).strokeColor(C.border).stroke();
  };
  row(labels, { bold: true, size: 7.5 });
  st.lines.forEach((l, i) => row({ n: i + 1, date: ltr(l.date), number: ltr(String(l.number)), patient: l.patient, insuranceNo: l.insuranceNo ? ltr(l.insuranceNo) : '', doctor: l.doctor, service: l.service, codes: l.codes ? ltr(l.codes) : '', total: money(l.total), insurer: money(l.insurer) }));
  row({ patient: t('common.total'), total: money(st.totals.total), insurer: money(st.totals.insurer) }, { bold: true, size: 8.5, rule: false });
  w.space(24);
  w.text(t('inscl.pdf_note'), { size: 8.5, color: C.textMuted });
  w.footer(`${(en && clinic.name_en) || clinic.name} · ${t('inscl.title')} · ${st.provider.name}`, (i, n) => `${i} / ${n}`);
  return w.end();
}

const fileBase = (st) => `insurance-${String(st.provider.name).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || st.provider.id}-${st.from}-${st.to}`;

async function log(ctx, st, action, sentTo = null) {
  await knex('insurance_statements').insert({ business_id: ctx.businessId, provider_id: st.provider.id, provider_name: st.provider.name, date_from: st.from, date_to: st.to, invoices: st.totals.count, total: st.totals.insurer, action, sent_to: sentTo, created_by: ctx.userId || null });
  await audit.record(ctx, action === 'email' ? 'insurance_statement.emailed' : 'insurance_statement.exported', { entityType: 'insurance_provider', entityId: st.provider.id, newValues: { from: st.from, to: st.to, invoices: st.totals.count, insurer_total: st.totals.insurer, format: action, sent_to: sentTo || undefined } });
}

/** E-mails the statement (PDF + Excel attached) to the company. */
async function email(ctx, st, { to, locale, t }) {
  const address = String(to || st.provider.email || '').trim().toLowerCase();
  if (!/^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(address) || address.length > 190) throw new AppError('NO_EMAIL', 'No e-mail address for this company.', 422);
  if (!st.totals.count) throw new AppError('EMPTY', 'Nothing to send for this period.', 422);
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  if (!(await mailer.configuredFor(ctx.businessId))) throw new AppError('NO_MAIL', 'E-mail is not set up.', 409);
  const clinic = await knex('businesses').where({ id: ctx.businessId }).first('id', 'name', 'name_en', 'email', 'slug', 'color', 'logo_mime', 'logo_version', 'currency');
  await mailer.warmLogo(clinic);
  const texts = require('../messaging/texts.service'); // eslint-disable-line global-require
  const tt = await texts.translatorFor(ctx.businessId, locale);
  const clinicName = (locale === 'en' && clinic.name_en) || clinic.name;
  const vars = { company: st.provider.name, clinic: clinicName, from: formatDate(st.from, locale), to: formatDate(st.to, locale), count: st.totals.count, total: formatMoney(st.totals.insurer, clinic.currency, locale) };
  const subject = tt('inscl.msg.subject', vars);
  const html = mailer.layout({ locale, title: subject, body: tt('inscl.msg.body', vars), clinic, base: ctx.baseUrl });
  const base = fileBase(st);
  const attachments = [
    { filename: `${base}.pdf`, content: await pdf(ctx, st, t, locale), contentType: 'application/pdf' },
    { filename: `${base}.xlsx`, content: excel(st, t, locale), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  ];
  let ok = false;
  try { ok = await mailer.send({ to: address, subject, html, replyTo: clinic.email || undefined, businessId: ctx.businessId, kind: 'suppliers', fromName: clinicName, attachments }); } catch { ok = false; }
  if (!ok) throw new AppError('MAIL_FAILED', 'The e-mail could not be sent.', 502);
  await log(ctx, st, 'email', address);
  return address;
}

const history = (ctx) => knex('insurance_statements as s').leftJoin('users as u', 'u.id', 's.created_by').where('s.business_id', ctx.businessId).orderBy('s.created_at', 'desc').limit(30).select('s.*', 'u.name as by_name');

module.exports = { periodOf, providers, provider, build, summary, excel, pdf, fileBase, log, email, history };
