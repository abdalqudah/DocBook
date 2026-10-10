// Payslips by e-mail: the PDF payslip of a staff member or a doctor for a month, sent from the clinic's mail to the
// person's own address (staff record e-mail, else the linked login's; doctor record e-mail, else the linked login's).
// Each sending is stamped on the paid line (slip_sent_at / slip_sent_to) and audited. The subject and text are the
// clinic's own (Settings → Message texts → Salaries & bank). Amounts are only in the attached PDF, never in the text.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError } = require('../../core/errors');
const { formatMonth } = require('../../core/format');
const { translator } = require('../../core/i18n');
const staff = require('../finance/staff.service');
const doctorPay = require('../clinic/payroll.service');
const pdf = require('../finance/pdf');

const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;
const clean = (v) => { const e = String(v || '').trim().toLowerCase(); return EMAIL.test(e) && e.length <= 190 ? e : null; };

/** Figures of a doctor's month: the stored ones once paid, else the live calculation. */
async function doctorSlip(ctx, doctorId, period) {
  const doctor = await knex('doctors').where({ id: Number(doctorId) || 0, business_id: ctx.businessId }).first();
  if (!doctor) throw new AppError('NOT_FOUND', 'Doctor not found.', 404);
  const c = await doctorPay.calculate(ctx, doctor.id, period);
  const p = c.payment;
  const figures = p
    ? { base: Number(p.base_salary), commission: Number(p.commission), bonuses: Number(p.bonuses), deductions: Number(p.deductions), advances: Number(p.advances), net: Number(p.net_pay) }
    : { base: c.baseSalary, commission: c.commission, bonuses: c.bonuses, deductions: c.deductions, advances: c.advances, net: c.netPayroll };
  return { doctor, period, figures, payment: p || null };
}

async function doctorEmail(businessId, d) {
  if (clean(d.email)) return clean(d.email);
  const u = await knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.business_id': businessId, 'm.doctor_id': d.id }).first('u.email');
  return u ? clean(u.email) : null;
}
async function staffEmail(e) {
  if (!e) return null;
  if (clean(e.email)) return clean(e.email);
  if (!e.membership_id) return null;
  const u = await knex('memberships as m').join('users as u', 'u.id', 'm.user_id').where({ 'm.id': e.membership_id }).first('u.email');
  return u ? clean(u.email) : null;
}

/** The message in the clinic's words (Settings → Message texts), in the person's language choice. */
async function message(ctx, { name, period, locale }) {
  const texts = require('../messaging/texts.service'); // eslint-disable-line global-require
  const t = await texts.translatorFor(ctx.businessId, locale);
  const clinic = await knex('businesses').where({ id: ctx.businessId }).first('id', 'name', 'name_en', 'email', 'slug', 'color', 'logo_mime', 'logo_version');
  const vars = { name, clinic: (locale === 'en' && clinic.name_en) || clinic.name, period: formatMonth(period, locale) };
  return { subject: t('payouts.msg.slip_subject', vars), body: t('payouts.msg.slip_body', vars), clinic, vars };
}

async function mail(ctx, { to, locale, name, period, buf, filename }) {
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  if (!(await mailer.configuredFor(ctx.businessId))) throw new AppError('NO_MAIL', 'E-mail is not set up.', 409);
  const msg = await message(ctx, { name, period, locale });
  const html = mailer.layout({ locale, title: msg.subject, body: msg.body, clinic: msg.clinic, base: ctx.baseUrl });
  let ok = false;
  try {
    ok = await mailer.send({ to, subject: msg.subject, html, replyTo: msg.clinic.email || undefined, businessId: ctx.businessId, kind: 'suppliers', fromName: msg.vars.clinic, attachments: [{ filename, content: buf, contentType: 'application/pdf' }] });
  } catch { ok = false; }
  if (!ok) throw new AppError('MAIL_FAILED', 'The e-mail could not be sent.', 502);
}

/** Sends one staff payslip (a prepared month line). `to` overrides the stored address. */
async function sendStaff(ctx, lineId, { locale = 'ar', to } = {}) {
  const data = await staff.payslip(ctx, lineId);
  const address = clean(to) || await staffEmail(data.employee);
  if (!address) throw new AppError('NO_EMAIL', 'No e-mail address for this person.', 422);
  const t = translator(locale);
  const buf = await pdf.payslip(ctx, data, t, locale);
  await mail(ctx, { to: address, locale, name: data.line.employee_name, period: data.line.period, buf, filename: `payslip-${data.line.period}.pdf` });
  await knex('staff_payroll_lines').where({ id: data.line.id, business_id: ctx.businessId }).update({ slip_sent_at: new Date(), slip_sent_to: address });
  await audit.record(ctx, 'payslip.sent', { entityType: 'staff_payroll_line', entityId: data.line.id, newValues: { period: data.line.period, to: address } });
  return address;
}

/** Sends one doctor's payslip for a month. */
async function sendDoctor(ctx, doctorId, period, { locale = 'ar', to } = {}) {
  const data = await doctorSlip(ctx, doctorId, period);
  const address = clean(to) || await doctorEmail(ctx.businessId, data.doctor);
  if (!address) throw new AppError('NO_EMAIL', 'No e-mail address for this person.', 422);
  const t = translator(locale);
  const buf = await pdf.doctorPayslip(ctx, data, t, locale);
  const name = (locale === 'en' && data.doctor.full_name_en) || data.doctor.full_name;
  await mail(ctx, { to: address, locale, name, period, buf, filename: `payslip-${period}.pdf` });
  if (data.payment) await knex('payroll_payments').where({ id: data.payment.id, business_id: ctx.businessId }).update({ slip_sent_at: new Date(), slip_sent_to: address });
  await audit.record(ctx, 'payslip.sent', { entityType: 'doctor', entityId: data.doctor.id, newValues: { period, to: address } });
  return address;
}

/**
 * Sends the payslips of every person PAID for the month (staff lines marked paid, doctors with a payment), skipping
 * those already sent unless `again`. Returns { sent, noEmail: [names], failed: [names] }.
 */
async function sendAll(ctx, period, { locale = 'ar', again = false } = {}) {
  const out = { sent: 0, noEmail: [], failed: [] };
  const mailer = require('../../core/mailer'); // eslint-disable-line global-require
  if (!(await mailer.configuredFor(ctx.businessId))) throw new AppError('NO_MAIL', 'E-mail is not set up.', 409);
  const lines = await knex('staff_payroll_lines').where({ business_id: ctx.businessId, period, status: 'paid' }).modify((q) => { if (!again) q.whereNull('slip_sent_at'); if (ctx.workBranch) q.whereIn('employee_id', knex('staff_employees').where({ business_id: ctx.businessId, branch_key: String(ctx.workBranch) }).select('id')); }).select('id', 'employee_name');
  const pays = await knex('payroll_payments as p').join('doctors as d', 'd.id', 'p.doctor_id').where({ 'p.business_id': ctx.businessId, 'p.period': period })
    .modify((q) => { if (!again) q.whereNull('p.slip_sent_at'); if (ctx.workBranch) q.whereIn('p.doctor_id', require('../clinic/branches.service').payDoctorIds(ctx)); }).select('p.doctor_id', 'd.full_name');
  const run = async (name, fn) => {
    try { await fn(); out.sent += 1; } catch (e) { (e.code === 'NO_EMAIL' ? out.noEmail : out.failed).push(name); }
  };
  for (const l of lines) await run(l.employee_name, () => sendStaff(ctx, l.id, { locale })); // eslint-disable-line no-await-in-loop
  for (const p of pays) await run(p.full_name, () => sendDoctor(ctx, p.doctor_id, period, { locale })); // eslint-disable-line no-await-in-loop
  if (out.sent) await audit.record(ctx, 'payslip.sent_all', { entityType: 'payroll', entityId: period, newValues: { sent: out.sent, no_email: out.noEmail.length, failed: out.failed.length } });
  return out;
}

module.exports = { doctorSlip, sendStaff, sendDoctor, sendAll };
