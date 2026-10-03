// Money that repeats and money that leaves: recurring expenses (automatic on their date with catch-up, or waiting
// for a confirmation with the amount changeable, or skipped), payslips by e-mail (staff and doctors, PDF attached,
// stamped as sent), and the salary transfer file for any bank (a clinic-made layout per bank: columns, labels,
// separator, Excel or CSV; payees matched to their bank, IBAN checked, e-mailed to the bank, logged, marked paid).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const recurring = require('../src/modules/expenses/recurring.service');
const staff = require('../src/modules/finance/staff.service');
const bank = require('../src/modules/payouts/bank.service');
const mailer = require('../src/core/mailer');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `po-${k}-${tag}@t.test`;
let app; let B; let ctx; let doc; let empA; let empB; let empC;
const sent = [];
const today = () => scheduling.clinicNow('Asia/Amman').date;
const month = () => today().slice(0, 7);

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const owner = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email: mail('o'), password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'عيادة الرواتب', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: owner }).update({ email_verified_at: new Date() });
  ({ last_business_id: B } = await knex('users').where({ id: owner }).first('last_business_id'));
  await knex('businesses').where({ id: B }).update({ onboarding_completed_at: new Date() });
  ctx = { businessId: B, userId: owner, userName: 'Owner', permissions: await rbac.getUserPermissions(B, owner), currency: 'JOD', timezone: 'Asia/Amman', today: today(), locale: 'en' };
  [doc] = await knex('doctors').insert({ business_id: B, full_name: 'د. سامي', full_name_en: 'Dr Sami', is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()), base_salary: 1200, email: 'sami@doc.test', bank_name: 'Arab Bank', iban: 'JO94CBJO0010000000000131000302' });
  [empA] = await knex('staff_employees').insert({ business_id: B, name: 'Lina', job_title: 'Nurse', email: 'lina@staff.test', bank_name: 'البنك العربي', iban: 'GB82 WEST 1234 5698 7654 32', base_salary: 500, hire_date: '2025-01-01', status: 'active' });
  [empB] = await knex('staff_employees').insert({ business_id: B, name: 'Omar', job_title: 'Reception', bank_name: 'Housing Bank', iban: '0012345678', base_salary: 400, hire_date: '2025-01-01', status: 'active' });
  [empC] = await knex('staff_employees').insert({ business_id: B, name: 'Huda', job_title: 'Cleaner', bank_name: 'Housing Bank', iban: 'JO00BAD', base_salary: 300, hire_date: '2025-01-01', status: 'active' });
  mailer.configuredFor = async () => true;
  mailer.send = async (m) => { sent.push(m); return true; };
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('next date: month end kept, quarters, weeks, leap years', () => {
  assert.equal(recurring.nextOf('2026-01-31', 'month', 31), '2026-02-28');
  assert.equal(recurring.nextOf('2026-02-28', 'month', 31), '2026-03-31');
  assert.equal(recurring.nextOf('2026-11-15', 'quarter', 15), '2027-02-15');
  assert.equal(recurring.nextOf('2026-12-29', 'week'), '2027-01-05');
  assert.equal(recurring.nextOf('2024-02-29', 'year', 29), '2025-02-28');
});

test('recurring: automatic ones are recorded on their date (missed months caught up); confirm ones wait', async () => {
  const o = app.agent(); await o.login(mail('o'));
  const page = await o.get('/app/expenses/recurring');
  assert.equal(page.status, 200);
  assert.match(page.text, /recurring-dialog/);
  // Rent: automatic, two months overdue → recorded twice by the hourly run, next date in the future.
  const [y, m] = today().split('-').map(Number);
  const twoAgo = new Date(Date.UTC(y, m - 3, 5)).toISOString().slice(0, 10);
  let r = await o.post('/app/expenses/recurring', { _csrf: o.csrf(page.text), _has_active: '1', is_active: '1', title: 'Clinic rent', category: 'rent', amount: '650', payment_method: 'bank_transfer', every: 'month', next_date: twoAgo, mode: 'auto', end_date: '' });
  assert.equal(r.status, 302);
  const rent = await knex('recurring_expenses').where({ business_id: B, title: 'Clinic rent' }).first();
  assert.equal(rent.day_of_month, 5);
  // Internet: waits for confirmation.
  r = await o.post('/app/expenses/recurring', { _csrf: o.csrf(page.text), _has_active: '1', is_active: '1', title: 'Internet', category: 'utilities', amount: '35', payment_method: 'card', every: 'month', next_date: today(), mode: 'confirm' });
  assert.equal(r.status, 302);
  await recurring.runDue();
  const rows = await knex('expenses').where({ business_id: B, title: 'Clinic rent' }).orderBy('date');
  assert.ok(rows.length >= 2 && rows.length <= 3, `rent recorded ${rows.length} times`);
  assert.equal(Number(rows[0].amount), 650);
  assert.equal(rows[0].payment_method, 'bank_transfer');
  const after = await knex('recurring_expenses').where({ id: rent.id }).first();
  assert.ok(String(after.next_date) > today());
  await recurring.runDue(); // nothing more
  assert.equal((await knex('expenses').where({ business_id: B, title: 'Clinic rent' })).length, rows.length);
  assert.equal((await knex('expenses').where({ business_id: B, title: 'Internet' })).length, 0);
  // The expenses page tells about the waiting one; it is recorded with this month's actual amount.
  const ex = await o.get('/app/expenses');
  assert.match(ex.text, /\/app\/expenses\/recurring/);
  assert.match(ex.text, /waiting for confirmation|ينتظر التأكيد/);
  const net = await knex('recurring_expenses').where({ business_id: B, title: 'Internet' }).first();
  r = await o.post(`/app/expenses/recurring/${net.id}/post`, { _csrf: o.csrf(ex.text), amount: '41.5' });
  assert.equal(r.status, 302);
  const e = await knex('expenses').where({ business_id: B, title: 'Internet' }).first();
  assert.equal(Number(e.amount), 41.5);
  assert.equal(String(e.date), today());
  assert.equal(String((await knex('recurring_expenses').where({ id: net.id }).first()).next_date), recurring.nextOf(today(), 'month', net.day_of_month));
  assert.ok(await knex('audit_logs').where({ business_id: B, action: 'recurring_expense.posted' }).first());
});

test('recurring: skip moves on without an expense; end date stops it; another clinic cannot touch it', async () => {
  const id = await recurring.save(ctx, null, { title: 'Phone', category: 'utilities', amount: '20', payment_method: 'cash', every: 'month', next_date: today(), mode: 'confirm', end_date: today() });
  let r = await recurring.get(ctx, id);
  await recurring.skip(ctx, r);
  r = await recurring.get(ctx, id);
  assert.equal(r.is_active, 0); // the next date is past the end date
  assert.equal((await knex('expenses').where({ business_id: B, title: 'Phone' })).length, 0);
  await assert.rejects(() => recurring.get({ businessId: B + 100000 }, id), /not found/i);
  await assert.rejects(() => recurring.save(ctx, null, { title: 'x', category: 'nope', amount: '1', payment_method: 'cash', every: 'month', next_date: today(), mode: 'auto' }), /VALIDATION|valid/i);
});

test('payslips: a paid staff line is e-mailed with its PDF, stamped; no address → a clear error', async () => {
  const o = app.agent(); await o.login(mail('o'));
  await staff.prepare(ctx, month());
  const lineA = await knex('staff_payroll_lines').where({ employee_id: empA, period: month() }).first();
  const lineB = await knex('staff_payroll_lines').where({ employee_id: empB, period: month() }).first();
  await staff.markPaid(ctx, lineA.id, { paid_on: today(), payment_method: 'bank_transfer' });
  await staff.markPaid(ctx, lineB.id, { paid_on: today(), payment_method: 'cash' });
  const page = await o.get(`/app/staff-payroll?period=${month()}`);
  assert.match(page.text, new RegExp(`/app/payouts/slips/staff/${lineA.id}`));
  assert.match(page.text, /\/app\/payouts\/slips\/all/);
  sent.length = 0;
  let r = await o.post(`/app/payouts/slips/staff/${lineA.id}`, { _csrf: o.csrf(page.text), _return: `/app/staff-payroll?period=${month()}` });
  assert.equal(r.status, 302);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'lina@staff.test');
  assert.equal(sent[0].attachments[0].contentType, 'application/pdf');
  assert.equal(sent[0].attachments[0].content.slice(0, 4).toString(), '%PDF');
  assert.doesNotMatch(sent[0].html, /500/); // amounts only in the attachment
  assert.ok((await knex('staff_payroll_lines').where({ id: lineA.id }).first()).slip_sent_at);
  r = await o.post(`/app/payouts/slips/staff/${lineB.id}`, { _csrf: o.csrf(page.text), _return: `/app/staff-payroll?period=${month()}` });
  assert.equal(r.status, 302);
  assert.equal(sent.length, 1); // Omar has no e-mail
  // Send all: only the ones not sent yet; Omar listed as without e-mail.
  sent.length = 0;
  r = await o.post('/app/payouts/slips/all', { _csrf: o.csrf(page.text), period: month() });
  assert.equal(r.status, 302);
  assert.equal(sent.length, 0);
});

test('payslips: a doctor gets a PDF payslip (route and e-mail)', async () => {
  const o = app.agent(); await o.login(mail('o'));
  const pdf = await o.get(`/app/payroll/doctors/${doc}/payslip?period=${month()}&format=pdf`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.type, /application\/pdf/);
  const page = await o.get(`/app/payroll/doctors/${doc}/payslip?period=${month()}`);
  assert.match(page.text, new RegExp(`/app/payouts/slips/doctor/${doc}`));
  sent.length = 0;
  const r = await o.post(`/app/payouts/slips/doctor/${doc}`, { _csrf: o.csrf(page.text), period: month() });
  assert.equal(r.status, 302);
  assert.equal(sent[0].to, 'sami@doc.test');
  assert.ok(await knex('audit_logs').where({ business_id: B, action: 'payslip.sent', entity_type: 'doctor' }).first());
});

test('bank: start from a preset, IBAN checks, payees grouped by their bank', async () => {
  assert.equal(bank.accountState('JO94CBJO0010000000000131000302'), 'ok');
  assert.equal(bank.accountState('JO00BAD'), 'bad');
  assert.equal(bank.accountState(''), 'missing');
  const o = app.agent(); await o.login(mail('o'));
  let page = await o.get(`/app/payouts/bank?period=${month()}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /\/app\/payouts\/bank\/templates\/preset/);
  let r = await o.post('/app/payouts/bank/templates/preset', { _csrf: o.csrf(page.text), preset: 'simple' });
  assert.equal(r.status, 302);
  // Arab Bank layout: semicolon, no decimals beyond 2, its own labels and e-mail, matched by an Arabic spelling.
  const form = await o.get('/app/payouts/bank/templates/new');
  assert.equal(form.status, 200);
  r = await o.post('/app/payouts/bank/templates', [['_csrf', o.csrf(form.text)], ['name', 'Arab Bank'], ['match', 'العربي, ARAB'], ['email', 'payroll@arabbank.test'], ['format', 'csv'], ['delimiter', 'semicolon'],
    ['decimals', '2'], ['date_format', 'DD/MM/YYYY'], ['debit_iban', 'JO71 ARAB 1234 0000 0000 1234 5678 90'], ['header', '1'],
    ['col_field', 'iban'], ['col_label', 'Beneficiary Account'], ['col_value', ''],
    ['col_field', 'name'], ['col_label', 'Beneficiary Name'], ['col_value', ''],
    ['col_field', 'amount'], ['col_label', 'Amount'], ['col_value', ''],
    ['col_field', 'value_date'], ['col_label', 'Value Date'], ['col_value', ''],
    ['col_field', 'text'], ['col_label', 'Purpose'], ['col_value', 'SALA']]);
  assert.equal(r.status, 302);
  // Missing the amount column → refused.
  r = await o.post('/app/payouts/bank/templates', [['_csrf', o.csrf(form.text)], ['name', 'Bad'], ['format', 'csv'], ['delimiter', 'comma'], ['decimals', '3'], ['date_format', 'YYYY-MM-DD'], ['col_field', 'name'], ['col_label', 'N'], ['col_value', '']]);
  assert.equal(r.status, 422);
  const tpls = await bank.list(ctx);
  assert.equal(tpls.length, 2);
  assert.equal(tpls.filter((t) => t.is_default).length, 1);
  const people = await bank.payees(ctx, month());
  const keyOf = (n) => people.find((p) => p.name === n);
  assert.equal(keyOf('Lina').account, 'ok');
  assert.equal(keyOf('Omar').account, 'account');
  assert.equal(keyOf('Huda').account, 'bad');
  assert.equal(keyOf('د. سامي').type, 'doctor');
  const groups = bank.groups(tpls, people);
  const arab = groups.find((g) => g.template.name === 'Arab Bank');
  assert.deepEqual(arab.payees.map((p) => p.name).sort(), ['Lina', 'د. سامي'].sort()); // "البنك العربي" and "Arab Bank"
  page = await o.get(`/app/payouts/bank?period=${month()}`);
  assert.match(page.text, /payroll@arabbank\.test/);
  assert.match(page.text, /JO00BAD/);
});

test('bank: the file in the bank\'s layout; e-mailed to the bank with the file attached; logged; marked paid', async () => {
  const o = app.agent(); await o.login(mail('o'));
  const tpl = (await bank.list(ctx)).find((t) => t.name === 'Arab Bank');
  const page = await o.get(`/app/payouts/bank?period=${month()}`);
  const lina = await knex('staff_payroll_lines').where({ employee_id: empA, period: month() }).first();
  const huda = await knex('staff_payroll_lines').where({ employee_id: empC, period: month() }).first();
  const base = [['_csrf', o.csrf(page.text)], ['period', month()], ['template_id', String(tpl.id)], ['value_date', '2026-10-01'], ['p', `staff:${lina.id}`], ['p', `doctor:${doc}`], ['p', `staff:${huda.id}`]];
  let r = await o.post('/app/payouts/bank/make', [...base, ['action', 'download']]);
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/csv/);
  const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Beneficiary Account;Beneficiary Name;Amount;Value Date;Purpose');
  assert.equal(lines.length, 3); // Huda's bad IBAN is left out
  assert.ok(lines.includes('GB82WEST12345698765432;Lina;500.00;01/10/2026;SALA'));
  assert.ok(lines.some((l) => l.startsWith('JO94CBJO0010000000000131000302;د. سامي;1200.00;')));
  // Excel layout works too.
  await knex('bank_templates').where({ id: tpl.id }).update({ format: 'xlsx' });
  r = await o.post('/app/payouts/bank/make', [...base, ['action', 'download']]);
  assert.match(r.type, /spreadsheetml/);
  assert.equal(r.body.slice(0, 2).toString(), 'PK');
  await knex('bank_templates').where({ id: tpl.id }).update({ format: 'csv' });
  // E-mail to the bank + mark paid.
  sent.length = 0;
  r = await o.post('/app/payouts/bank/make', [...base, ['action', 'email'], ['to', 'payroll@arabbank.test'], ['mark_paid', '1']]);
  assert.equal(r.status, 302);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'payroll@arabbank.test');
  assert.match(sent[0].attachments[0].filename, /^salaries-.*arab-bank\.csv$/);
  const log = await knex('bank_transfers').where({ business_id: B }).orderBy('id');
  assert.equal(log.length, 3);
  assert.equal(log[2].action, 'email');
  assert.equal(log[2].payees, 2);
  assert.equal(Number(log[2].total), 1700);
  assert.ok(await knex('payroll_payments').where({ business_id: B, doctor_id: doc, period: month(), payment_method: 'bank_transfer' }).first());
  assert.ok(await knex('audit_logs').where({ business_id: B, action: 'bank_transfer.emailed' }).first());
  // Nobody valid chosen → error, no file.
  r = await o.post('/app/payouts/bank/make', [['_csrf', o.csrf(page.text)], ['period', month()], ['template_id', String(tpl.id)], ['p', `staff:${huda.id}`], ['action', 'download']]);
  assert.equal(r.status, 302);
});

test('bank: permissions and tenant isolation', async () => {
  const other = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Other', email: mail('x'), password: 'Passw0rd!x' });
    await businesses.create(id, { name: 'Other clinic', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  await knex('users').where({ id: other }).update({ email_verified_at: new Date() });
  const { last_business_id: B2 } = await knex('users').where({ id: other }).first('last_business_id');
  await knex('businesses').where({ id: B2 }).update({ onboarding_completed_at: new Date() });
  const x = app.agent(); await x.login(mail('x'));
  const tpl = (await bank.list(ctx))[0];
  assert.equal((await x.get(`/app/payouts/bank/templates/${tpl.id}`)).status, 404);
  const page = await x.get('/app/payouts/bank');
  assert.doesNotMatch(page.text, /arabbank/);
  const r = await x.post('/app/payouts/bank/make', [['_csrf', x.csrf(page.text)], ['template_id', String(tpl.id)], ['p', `doctor:${doc}`], ['action', 'download']]);
  assert.notEqual(r.status, 200);
  // A receptionist (no payroll.view) cannot open it.
  const rUser = await knex.transaction((trx) => auth.createUser(trx, { name: 'Rec', email: mail('r'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: rUser }).update({ last_business_id: B, email_verified_at: new Date() });
  await knex('memberships').insert({ business_id: B, user_id: rUser, role_id: (await rbac.getRoleByKey(B, 'receptionist')).id });
  const rec = app.agent(); await rec.login(mail('r'));
  assert.equal((await rec.get('/app/payouts/bank')).status, 403);
});
