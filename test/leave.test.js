// Staff leave: request → approve → balance, reject, cancel, working days (closed weekdays skipped), "on leave" in
// attendance instead of absent, leave.manage required to decide (service and HTTP), unpaid leave on the payroll line
// and as a draft deduction, audit and notifications, and the pages render in both languages.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const att = require('../src/modules/attendance/attendance.service');
const staffPay = require('../src/modules/finance/staff.service');
const leave = require('../src/modules/leave/leave.service');

let A; let B; let nurse; let manager;

async function clinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), timezone: 'Asia/Amman', today: scheduling.clinicNow('Asia/Amman').date, ip: '10.0.0.1', userAgent: 'test', locale: 'en' };
}

async function member(c, email, roleKey, name) {
  const id = await knex.transaction((trx) => auth.createUser(trx, { name: name || `Staff ${roleKey}`, email, password: 'Passw0rd!x' }));
  const role = await knex('roles').where({ business_id: c.businessId, key: roleKey }).first('id');
  await knex('memberships').insert({ business_id: c.businessId, user_id: id, role_id: role.id, status: 'active' });
  await knex('users').where({ id }).update({ last_business_id: c.businessId });
  rbac.invalidate(c.businessId);
  return { ...c, userId: id, permissions: await rbac.getUserPermissions(c.businessId, id) };
}

test.before(async () => {
  await knex.migrate.rollback(undefined, true);
  await knex.migrate.latest();
  A = await clinic('owner@leave-a.test', 'Clinic A');
  B = await clinic('owner@leave-b.test', 'Clinic B');
  nurse = await member(A, 'nurse@leave-a.test', 'nurse', 'Nadia Nurse');
  manager = await member(A, 'manager@leave-a.test', 'clinic_manager', 'Mona Manager');
  // Clinic hours: open every day but Friday.
  await knex('businesses').where({ id: A.businessId }).update({ default_working_hours: JSON.stringify(scheduling.defaultWorkingHours()), onboarding_completed_at: new Date() });
});

test.after(() => knex.destroy());

test('leave.manage is in the catalogue and the owner / clinic manager hold it by default; a nurse does not', () => {
  const perms = require('../src/modules/rbac/permissions');
  assert.ok(perms.ALL.includes('leave.manage'));
  assert.ok(A.permissions.has('leave.manage'));
  assert.ok(manager.permissions.has('leave.manage'));
  assert.ok(!nurse.permissions.has('leave.manage'));
});

test('days are counted on the clinic\'s open weekdays (Friday closed); a half day counts 0.5', async () => {
  const open = await leave.openDays(A.businessId);
  assert.ok(!open.includes('fri') && open.length === 6);
  // 2027-03-04 Thursday, 03-05 Friday, 03-06 Saturday.
  assert.equal(leave.countDays('2027-03-04', '2027-03-06', open), 2);
  assert.equal(leave.countDays('2027-03-04', '2027-03-04', open, true), 0.5);
  assert.equal(leave.countDays('2027-03-05', '2027-03-05', open), 0);
  assert.equal(leave.countDays('2027-03-05', '2027-03-05', null), 1, 'no hours set: every day counts');
  await assert.rejects(leave.request(nurse, { kind: 'annual', from_date: '2027-03-05', reason: 'Friday only' }), { code: 'LEAVE_NO_WORKING_DAYS' });
  await assert.rejects(leave.request(nurse, { kind: 'holiday', from_date: 'x', to_date: '2027-01-01', reason: '' }),
    (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.kind && e.details.from_date && e.details.reason));
  await assert.rejects(leave.request(nurse, { kind: 'annual', from_date: '2027-03-06', to_date: '2027-03-04', reason: 'x' }), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.to_date), 'end before start');
  await assert.rejects(leave.request(nurse, { kind: 'annual', from_date: '2027-12-30', to_date: '2028-01-03', reason: 'x' }), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.to_date), 'one year at a time');
});

test('request → notified approvers → approve → balance decreases; the requester is notified; audited', async () => {
  const before = (await leave.balances(A.businessId, '2027', [nurse.userId])).get(nurse.userId).annual;
  assert.deepEqual([before.allowance, before.used, before.remaining], [14, 0, 14]);
  const id = await leave.request(nurse, { kind: 'annual', from_date: '2027-03-04', to_date: '2027-03-06', reason: 'Family wedding' });
  const row = await knex('staff_leave_requests').where({ id }).first();
  assert.equal(row.status, 'pending');
  assert.equal(Number(row.days), 2, 'Friday skipped');
  let b = (await leave.balances(A.businessId, '2027', [nurse.userId])).get(nurse.userId).annual;
  assert.deepEqual([b.used, b.pending, b.remaining], [0, 2, 14]);
  const n = await knex('notifications').where({ business_id: A.businessId, type: 'leave.requested', permission: 'leave.manage' }).first();
  assert.ok(n && /Nadia Nurse/.test(n.title) && n.link === '/app/leave?tab=requests');
  await assert.rejects(leave.request(nurse, { kind: 'sick', from_date: '2027-03-06', reason: 'Overlap' }), { code: 'LEAVE_OVERLAP' });

  const r = await leave.decide(manager, id, 'approve', 'Enjoy');
  assert.equal(r.status, 'approved');
  b = (await leave.balances(A.businessId, '2027', [nurse.userId])).get(nurse.userId).annual;
  assert.deepEqual([b.used, b.pending, b.remaining], [2, 0, 12]);
  assert.ok(await knex('notifications').where({ business_id: A.businessId, user_id: nurse.userId, type: 'leave.approved' }).first());
  await assert.rejects(leave.decide(manager, id, 'reject'), { code: 'LEAVE_NOT_PENDING' }, 'decided once');
  for (const action of ['leave.requested', 'leave.approved']) assert.ok(await knex('audit_logs').where({ business_id: A.businessId, action, entity_id: String(id) }).first(), action);

  // More than what is left is refused (pending requests are held against the balance too).
  await assert.rejects(leave.request(nurse, { kind: 'annual', from_date: '2027-04-01', to_date: '2027-04-30', reason: 'Long trip' }), { code: 'LEAVE_BALANCE' });
  // A person's own allowance replaces the clinic's.
  await leave.saveAllowance(A, nurse.userId, { annual_days: '21', sick_days: '' });
  b = (await leave.balances(A.businessId, '2027', [nurse.userId])).get(nurse.userId);
  assert.deepEqual([b.annual.allowance, b.annual.remaining, b.sick.allowance], [21, 19, 14]);
  await leave.saveAllowance(A, nurse.userId, { annual_days: '', sick_days: '' });
  await leave.saveSettings(A, { annual_days: '20', sick_days: '10' });
  b = (await leave.balances(A.businessId, '2027', [nurse.userId])).get(nurse.userId);
  assert.deepEqual([b.annual.allowance, b.annual.remaining, b.sick.allowance], [20, 18, 10]);
  await assert.rejects(leave.saveSettings(A, { annual_days: '-1', sick_days: '400' }), (e) => e.code === 'VALIDATION_FAILED' && Boolean(e.details.annual_days && e.details.sick_days));
  await leave.saveSettings(A, { annual_days: '14', sick_days: '14' });
  assert.ok(await knex('audit_logs').where({ business_id: A.businessId, action: 'leave.settings_updated' }).first());
});

test('reject with a note: the balance is untouched and the requester is told why', async () => {
  const id = await leave.request(nurse, { kind: 'sick', from_date: '2027-05-06', reason: 'Dentist' });
  const r = await leave.decide(A, id, 'reject', 'Busy day, please move it');
  assert.equal(r.status, 'rejected');
  const row = await knex('staff_leave_requests').where({ id }).first();
  assert.equal(row.decision_note, 'Busy day, please move it');
  assert.equal(row.decided_by, A.userId);
  const b = (await leave.balances(A.businessId, '2027', [nurse.userId])).get(nurse.userId).sick;
  assert.deepEqual([b.used, b.pending], [0, 0]);
  const n = await knex('notifications').where({ user_id: nurse.userId, type: 'leave.rejected' }).first();
  assert.ok(n && n.body.includes('Busy day'));
  assert.ok(await knex('audit_logs').where({ action: 'leave.rejected', entity_id: String(id) }).first());
});

test('the requester cancels while pending; others cannot; a manager can cancel an approved leave', async () => {
  const id = await leave.request(nurse, { kind: 'other', from_date: '2027-06-03', reason: 'Moving house' });
  await assert.rejects(leave.cancel({ ...B, permissions: new Set() }, id), { code: 'NOT_FOUND' }, 'another clinic');
  const other = await member(A, 'reception@leave-a.test', 'receptionist');
  await assert.rejects(leave.cancel(other, id), { code: 'NOT_FOUND' }, 'a colleague without leave.manage');
  const r = await leave.cancel(nurse, id);
  assert.equal(r.status, 'cancelled');
  await assert.rejects(leave.cancel(nurse, id), { code: 'LEAVE_NOT_PENDING' });
  assert.ok(await knex('audit_logs').where({ action: 'leave.cancelled', entity_id: String(id) }).first());
  // An approved leave: the requester can no longer cancel it, a manager can.
  const id2 = await leave.record(manager, { user_id: nurse.userId, kind: 'annual', from_date: '2027-06-10' });
  assert.equal((await knex('staff_leave_requests').where({ id: id2 }).first()).status, 'approved', 'recorded by a manager: approved at once');
  assert.ok(await knex('audit_logs').where({ action: 'leave.recorded', entity_id: String(id2) }).first());
  await assert.rejects(leave.cancel(nurse, id2), { code: 'LEAVE_NOT_PENDING' });
  assert.equal((await leave.cancel(manager, id2)).status, 'cancelled');
});

test('a staff member without leave.manage cannot approve, reject or record leave', async () => {
  const id = await leave.request(manager, { kind: 'annual', from_date: '2027-07-01', reason: 'Summer' });
  await assert.rejects(leave.decide(nurse, id, 'approve'), { code: 'PERMISSION_DENIED' });
  await assert.rejects(leave.decide(nurse, id, 'reject'), { code: 'PERMISSION_DENIED' });
  await assert.rejects(leave.record(nurse, { user_id: nurse.userId, kind: 'annual', from_date: '2027-07-08' }), { code: 'PERMISSION_DENIED' });
  assert.equal((await knex('staff_leave_requests').where({ id }).first()).status, 'pending');
  await assert.rejects(leave.decide({ ...B, permissions: new Set(['leave.manage']) }, id, 'approve'), { code: 'NOT_FOUND' }, 'another clinic\'s request');
});

test('attendance shows approved leave as "on leave" instead of absent', async () => {
  await att.saveSettings(A, { workDays: ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'], workStart: '09:00', workEnd: '17:00', grace: 10 });
  // A past day the clinic is open (not a Friday).
  let d = att.shiftDay(A.today, -1);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() === 5) d = att.shiftDay(d, -1);
  await knex('attendance_settings').where({ business_id: A.businessId }).update({ plan_since: att.shiftDay(d, -3) }); // tracking started before that day
  await knex('memberships').where({ business_id: A.businessId, user_id: nurse.userId }).update({ created_at: new Date(`${att.shiftDay(d, -10)}T00:00:00Z`) });
  const month = d.slice(0, 7);
  let sheet = await att.timesheet(A, nurse.userId, month);
  assert.equal(sheet.days.find((x) => x.date === d).status, 'absent', 'no clock-in, no leave: absent');
  await leave.record(A, { user_id: nurse.userId, kind: 'sick', from_date: d, reason: 'Flu' });
  sheet = await att.timesheet(A, nurse.userId, month);
  const day = sheet.days.find((x) => x.date === d);
  assert.equal(day.status, 'leave');
  assert.equal(day.leaveKind, 'sick');
  assert.ok(sheet.totals.leave >= 1);
  const board = await att.board(A, d);
  assert.equal(board.rows.find((p) => p.user_id === nurse.userId).status, 'leave');
  assert.ok(board.summary.leave >= 1);
  const rep = await att.monthReport(A, month);
  const line = rep.rows.find((p) => p.user_id === nurse.userId);
  assert.ok(line.leave >= 1);
  const absentBefore = line.absent;
  // A shift on a leave day still counts as present.
  assert.equal(att.withLeave({ status: 'present' }, { kind: 'sick' }).status, 'present');
  assert.equal(att.withLeave({ status: 'off' }, { kind: 'sick' }).status, 'off');
  assert.ok(absentBefore >= 0);
  // The month view of who is on leave lists the day.
  const cal = await leave.calendar(A, month);
  assert.ok(cal.days.some((x) => x.date === d && x.people.some((p) => p.user_id === nurse.userId && p.kind === 'sick')));
});

test('unpaid leave appears on the month\'s payroll line and can be added once as a draft deduction', async () => {
  const ms = await knex('memberships').where({ business_id: A.businessId, user_id: nurse.userId }).first('id');
  const empId = await staffPay.saveEmployee(A, null, { name: 'Nadia Nurse', base_salary: '600', allowances: '0', deductions: '0', status: 'active', membership_id: String(ms.id) });
  // 2027-03-04 Thu → 03-06 Sat is already annual leave; unpaid leave 03-10 (Wed) → 03-13 (Sat): Friday skipped = 3 days.
  await leave.record(A, { user_id: nurse.userId, kind: 'unpaid', from_date: '2027-03-10', to_date: '2027-03-13', reason: 'Personal' });
  const days = await leave.unpaidByEmployee(A.businessId, '2027-03', [empId]);
  assert.equal(days.get(empId), 3);
  await staffPay.prepare(A, '2027-03');
  let sh = await staffPay.sheet(A, '2027-03');
  let row = sh.rows.find((r) => r.employee_id === empId);
  assert.equal(row.unpaidLeaveDays, 3);
  assert.equal(row.leaveDeducted, false);
  await assert.rejects(leave.addPayrollDeduction(nurse, row.id), { code: 'PERMISSION_DENIED' });
  const res = await leave.addPayrollDeduction(A, row.id);
  assert.equal(res.amount, 60); // 600 ÷ 30 × 3
  await assert.rejects(leave.addPayrollDeduction(A, row.id), { code: 'LEAVE_DEDUCTION_EXISTS' });
  sh = await staffPay.sheet(A, '2027-03');
  row = sh.rows.find((r) => r.employee_id === empId);
  assert.equal(row.leaveDeducted, true);
  assert.equal(row.f.extraDeductions, 60);
  assert.equal(row.status, 'draft');
  const adj = row.adjustments.find((a) => a.source === 'leave');
  assert.match(adj.reason, /Unpaid leave: 3 days \(2027-03\)/);
  // Other months carry nothing.
  await staffPay.prepare(A, '2027-02');
  assert.equal((await staffPay.sheet(A, '2027-02')).rows.find((r) => r.employee_id === empId).unpaidLeaveDays, 0);
  await assert.rejects(leave.addPayrollDeduction(A, (await staffPay.sheet(A, '2027-02')).rows.find((r) => r.employee_id === empId).id), { code: 'LEAVE_NO_UNPAID' });
});

// ---------------------------------------------------------------- HTTP
async function serve() {
  const { createApp } = require('../src/app'); // eslint-disable-line global-require
  const server = await new Promise((resolve) => { const s = createApp().listen(0, '127.0.0.1', () => resolve(s)); });
  const { port } = server.address();
  const jar = {};
  const send = (method, path, form) => new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : '';
    const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), host: `127.0.0.1:${port}` };
    if (form) Object.assign(headers, { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) });
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      for (const h of res.headers['set-cookie'] || []) { const [kv] = h.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
      let text = ''; res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || null, text }));
    });
    r.on('error', reject); r.end(body);
  });
  const csrf = (html) => (html.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
  const login = async (email) => { Object.keys(jar).forEach((k) => delete jar[k]); const r = await send('GET', '/login'); return send('POST', '/login', { _csrf: csrf(r.text), email, password: 'Passw0rd!x' }); };
  return { server, get: (p) => send('GET', p), post: (p, f) => send('POST', p, f), csrf, login };
}

test('HTTP: a nurse asks for leave and cannot approve it; the owner approves; every page renders', async () => {
  const { server, get, post, csrf, login } = await serve();
  try {
    let r = await login('nurse@leave-a.test');
    assert.equal(r.status, 302);
    r = await get('/app/leave');
    assert.equal(r.status, 200);
    assert.match(r.text, /request-dialog/);
    assert.doesNotMatch(r.text, /tab=balances/, 'no manager tabs');
    r = await post('/app/leave/requests', { _csrf: csrf(r.text), kind: 'annual', from_date: '2027-08-05', to_date: '2027-08-05', reason: 'Exam' });
    assert.equal(r.status, 302);
    const row = await knex('staff_leave_requests').where({ user_id: nurse.userId, from_date: '2027-08-05' }).first();
    assert.equal(row.status, 'pending');
    r = await get('/app/leave');
    r = await post(`/app/leave/requests/${row.id}/approve`, { _csrf: csrf(r.text) });
    assert.equal(r.status, 403, 'no leave.manage');
    // Invalid request: re-rendered with the dialog open (422).
    r = await get('/app/leave');
    r = await post('/app/leave/requests', { _csrf: csrf(r.text), kind: 'annual', from_date: '', reason: '' });
    assert.equal(r.status, 422);
    assert.match(r.text, /data-open-on-load/);
    assert.equal((await knex('staff_leave_requests').where({ id: row.id }).first()).status, 'pending');

    r = await login('owner@leave-a.test');
    assert.equal(r.status, 302);
    for (const path of ['/app/leave', '/app/leave?tab=requests', '/app/leave?tab=calendar&month=2027-03', '/app/leave?tab=balances', '/app/leave?tab=me',
      '/app/attendance?view=today', '/app/attendance?view=month', `/app/attendance/staff/${nurse.userId}`, '/app/staff-payroll?period=2027-03', '/app/clinic/roles']) {
      r = await get(path); // eslint-disable-line no-await-in-loop
      assert.equal(r.status, 200, `${path} → ${r.location}`);
      if (!path.includes('roles')) assert.doesNotMatch(r.text, /[>" ](leave|errors_leave|attendance)\.[a-z_]+(\.[a-z_]+)?[<"]/, `untranslated key on ${path}`);
    }
    r = await get('/app/staff-payroll?period=2027-03');
    assert.match(r.text, /Unpaid leave: 3 days/);
    r = await get('/app/leave?tab=requests');
    assert.match(r.text, /Nadia Nurse/);
    r = await post(`/app/leave/requests/${row.id}/decide`, { _csrf: csrf(r.text), decision: 'approve', note: 'OK', _return: '/app/leave?tab=requests' });
    assert.equal(r.status, 302);
    assert.equal(r.location, '/app/leave?tab=requests');
    assert.equal((await knex('staff_leave_requests').where({ id: row.id }).first()).status, 'approved');
    r = await get('/app/clinic/roles');
    assert.match(r.text, /Approve or reject staff leave/);
    // Arabic pages.
    for (const tab of ['requests', 'calendar', 'balances', 'me']) {
      r = await get(`/app/leave?tab=${tab}&lang=ar`); // eslint-disable-line no-await-in-loop
      assert.equal(r.status, 200, tab);
      assert.match(r.text, /dir="rtl"/);
      assert.match(r.text, /إجازات الموظفين/);
      assert.doesNotMatch(r.text, /[>" ](leave|attendance)\.[a-z_]+(\.[a-z_]+)?[<"]/, `untranslated key (ar) on ${tab}`);
    }
    r = await get('/app/attendance?view=month&lang=ar');
    assert.match(r.text, /أيام الإجازة/);
  } finally {
    server.close();
  }
});
