// PDFs of the finance pages (payslip, partner voucher, income statement) with the Arabic-capable writer of the
// patient documents (src/modules/patientdocs/pdf.js). Every builder takes plain data and resolves with the bytes.
const knex = require('../../db/knex');
const { Writer, ltr, colors: C } = require('../patientdocs/pdf');
const { formatMoney, formatDate, formatMonth, formatPercent } = require('../../core/format');

const pick = (en, a, b) => (en ? b || a : a || b) || '';

/** Clinic row with its logo bytes. */
const clinicOf = (businessId) => knex('businesses').where({ id: businessId })
  .first('id', 'name', 'name_en', 'address', 'city', 'phone', 'email', 'currency', 'logo', 'logo_mime', 'tax_number');

function letterhead(w, clinic, en) {
  const top = w.y;
  let textX = w.left; let textW = w.width;
  if (clinic.logo && /png|jpe?g/.test(String(clinic.logo_mime || ''))) {
    const box = w.image(clinic.logo, { side: 'start', height: 50, maxWidth: 120, y: top });
    if (box) { textW = w.width - box.w - 16; if (!w.rtl) textX = w.left + box.w + 16; }
  }
  w.text(pick(en, clinic.name, clinic.name_en), { size: 15, bold: true, x: textX, width: textW, y: top });
  const lines = [
    [clinic.address, clinic.city].filter(Boolean).join(' · '),
    [clinic.phone ? ltr(clinic.phone) : '', clinic.email ? ltr(clinic.email) : ''].filter(Boolean).join('   '),
  ].filter(Boolean);
  lines.forEach((l) => w.text(l, { size: 9, color: C.textMuted, x: textX, width: textW }));
  w.y = Math.max(w.y, top + 54);
  w.rule({ gap: 10, color: C.borderStrong });
}

function titleRow(w, title, meta) {
  const y = w.y;
  w.text(title, { size: 14, bold: true, y, fixed: true, width: w.width * 0.6, x: w.rtl ? w.right - w.width * 0.6 : w.left });
  meta.forEach((m, i) => w.text(m, { size: 9, color: C.textMuted, y: y + i * 15, fixed: true, align: 'end', lineHeight: 15 }));
  w.y = y + Math.max(28, meta.length * 15 + 6);
}

/** A label … value line; `sub` indents the label, `strong` makes both bold with a rule above. */
function line(w, label, value, { sub = false, strong = false, muted = false } = {}) {
  const size = strong ? 11 : 10;
  w.ensure(22);
  if (strong) { w.doc.moveTo(w.left, w.y).lineTo(w.right, w.y).lineWidth(0.8).strokeColor(C.text).stroke(); w.y += 4; }
  const indent = sub ? 16 : 0;
  const labelW = w.width * 0.68 - indent;
  const x = w.rtl ? w.right - indent - labelW : w.left + indent;
  const y = w.y;
  const h = w.text(label, { x, width: labelW, y, size, bold: strong, fixed: true, color: muted || sub ? C.textMuted : C.text, lineHeight: size * 1.6 });
  w.text(value, { y, size, bold: strong, fixed: true, align: 'end', lineHeight: size * 1.6, color: muted ? C.textMuted : C.text });
  w.y = y + Math.max(h, size * 1.6) + 4;
  if (!strong) { w.doc.moveTo(w.left, w.y - 2).lineTo(w.right, w.y - 2).lineWidth(0.4).strokeColor(C.border).stroke(); }
}

function signatures(w, labels) {
  w.ensure(80);
  w.space(40);
  const colW = (w.width - 32) / labels.length;
  labels.forEach((l, i) => {
    const x = w.rtl ? w.right - (i + 1) * colW - i * 32 : w.left + i * (colW + 32);
    w.doc.moveTo(x, w.y).lineTo(x + colW, w.y).lineWidth(0.6).strokeColor(C.borderStrong).stroke();
    w.text(l, { x, width: colW, y: w.y + 4, size: 8.5, color: C.textSubtle, fixed: true });
  });
  w.space(24);
}

/** Staff payslip. data = staff.payslip() */
async function payslip(ctx, data, t, locale) {
  const en = locale === 'en';
  const clinic = await clinicOf(ctx.businessId);
  const cur = clinic.currency;
  const money = (v, sign = '') => ltr(`${sign ? `${sign} ` : ''}${formatMoney(v, cur, locale)}`);
  const { line: l, f, employee: e, adjustments } = data;
  const w = new Writer({ locale, title: `${t('staffpay.payslip')} ${l.employee_name} ${l.period}` });
  letterhead(w, clinic, en);
  titleRow(w, t('staffpay.payslip'), [formatMonth(l.period, locale), l.status === 'paid' ? t('staffpay.status.paid') : t('staffpay.draft')]);
  w.fields([
    { label: t('staffpay.employee'), value: l.employee_name },
    { label: t('staffpay.job_title'), value: l.job_title || '—' },
    { label: t('staffpay.bank'), value: [e && e.bank_name, e && e.iban ? ltr(e.iban) : ''].filter(Boolean).join(' · ') || '—' },
  ], { cols: 3 });
  w.space(4);
  line(w, t('staffpay.base_salary'), money(f.base));
  line(w, t('staffpay.allowances'), money(f.allowances, '+'));
  line(w, t('staffpay.bonuses'), money(f.bonuses, '+'));
  line(w, t('staffpay.fixed_deductions'), money(f.deductions, '−'));
  line(w, t('staffpay.extra_deductions'), money(f.extraDeductions, '−'));
  line(w, t('staffpay.advances'), money(f.advances, '−'));
  line(w, t('staffpay.net_pay'), money(f.net), { strong: true });
  if (adjustments.length) {
    w.space(10);
    w.text(t('staffpay.adjustments'), { size: 9, bold: true, color: C.textSubtle });
    adjustments.forEach((a) => line(w, `${t(`staffpay.types.${a.type}`)} — ${a.reason}`, money(a.amount, a.type === 'bonus' ? '+' : '−'), { sub: true }));
  }
  if (l.status === 'paid') {
    w.space(10);
    w.text(t('staffpay.paid_line', { date: formatDate(l.paid_on, locale), method: t(`payment_methods.${l.payment_method}`), ref: l.reference || '—' }), { size: 9, color: C.textMuted });
  }
  signatures(w, [t('staffpay.sign_prepared'), t('staffpay.sign_employee')]);
  w.footer(`${pick(en, clinic.name, clinic.name_en)} · ${t('staffpay.payslip')} ${l.period}`, (i, n) => `${i} / ${n}`);
  return w.end();
}

/** Partner voucher (capital injection, withdrawal or profit share). data = partners.voucher() */
async function voucher(ctx, data, t, locale) {
  const en = locale === 'en';
  const clinic = await clinicOf(ctx.businessId);
  const money = (v, sign = '') => ltr(`${sign ? `${sign} ` : ''}${formatMoney(v, clinic.currency, locale)}`);
  const { tx, partner, dist } = data;
  const w = new Writer({ locale, title: `${t(`partners.tx.${tx.type}`)} ${partner.name}` });
  letterhead(w, clinic, en);
  titleRow(w, t(`partners.voucher_title.${tx.type}`), [`${t('partners.voucher_no')} ${ltr(`P-${tx.id}`)}`, formatDate(tx.date, locale)]);
  w.fields([
    { label: t('partners.partner'), value: partner.name },
    { label: t('partners.equity'), value: formatPercent(tx.equity_percent ?? partner.equity_percent, locale, 2) },
    { label: t('common.amount'), value: money(tx.amount) },
  ], { cols: 3 });
  if (dist) {
    w.space(4);
    line(w, t('partners.month'), formatMonth(dist.period, locale));
    line(w, t('pnl.revenue'), money(dist.revenue));
    line(w, t('pnl.total_costs'), money(dist.costs, '−'));
    line(w, Number(dist.net_profit) < 0 ? t('pnl.net_loss') : t('pnl.net_profit'), money(dist.net_profit), { strong: true });
    line(w, t('partners.share_line', { pct: formatPercent(tx.equity_percent, locale, 2) }), money(tx.amount), { strong: true });
  }
  if (tx.note) { w.space(8); w.text(tx.note, { size: 10, color: C.textMuted }); }
  signatures(w, [t('partners.sign_accountant'), t('partners.sign_partner')]);
  w.footer(`${pick(en, clinic.name, clinic.name_en)} · ${t('partners.voucher_no')} P-${tx.id}`, (i, n) => `${i} / ${n}`);
  return w.end();
}

/** Income statement. data = pnl.build(); catName(key) → label */
async function statement(ctx, data, t, locale, catName, periodLabel) {
  const en = locale === 'en';
  const clinic = await clinicOf(ctx.businessId);
  const money = (v, sign = '') => ltr(`${sign ? `${sign} ` : ''}${formatMoney(v, clinic.currency, locale)}`);
  const s = data.cur;
  const w = new Writer({ locale, title: `${t('pnl.title')} ${periodLabel}` });
  letterhead(w, clinic, en);
  titleRow(w, t('pnl.title'), [periodLabel, t('pnl.basis_short')]);
  line(w, t('pnl.gross_revenue'), money(s.gross));
  line(w, t('pnl.discounts'), money(s.discounts, '−'), { sub: true });
  line(w, t('pnl.revenue'), money(s.revenue), { strong: true });
  if (s.online) line(w, t('pnl.of_which_online'), money(s.online), { sub: true, muted: true });
  w.space(8);
  w.text(t('pnl.operating_expenses'), { size: 9, bold: true, color: C.textSubtle });
  if (!s.expenses.length) line(w, t('pnl.no_expenses'), money(0), { sub: true, muted: true });
  s.expenses.forEach((e) => line(w, catName(e.category), money(e.amount), { sub: true }));
  line(w, t('pnl.doctor_payroll'), money(s.doctorPayroll));
  line(w, t('pnl.staff_salaries'), money(s.staffSalaries));
  line(w, t('pnl.total_costs'), money(s.costs), { strong: true });
  w.space(6);
  line(w, s.net < 0 ? t('pnl.net_loss') : t('pnl.net_profit'), money(s.net), { strong: true });
  line(w, t('pnl.margin'), s.margin === null ? '—' : formatPercent(s.margin, locale, 1), { muted: true });
  w.space(8);
  w.text(t('pnl.memo'), { size: 9, bold: true, color: C.textSubtle });
  line(w, t('pnl.refunds_memo'), money(s.refunds), { sub: true, muted: true });
  line(w, t('pnl.supplies_memo'), money(s.suppliesReceived), { sub: true, muted: true });
  w.space(8);
  w.text(t('pnl.basis_text'), { size: 8.5, color: C.textMuted });
  w.footer(`${pick(en, clinic.name, clinic.name_en)} · ${t('pnl.title')} · ${periodLabel}`, (i, n) => `${i} / ${n}`);
  return w.end();
}

const send = (res, name, buf, download) => {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${String(name).replace(/[^A-Za-z0-9_.-]+/g, '-') || 'document'}.pdf"; filename*=UTF-8''${encodeURIComponent(name)}.pdf`);
  res.set('Cache-Control', 'private, no-store');
  res.send(buf);
};

module.exports = { payslip, voucher, statement, send };
