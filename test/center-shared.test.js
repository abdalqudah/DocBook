// Medical centre run by its admin (the founding account): a doctor added directly gets a separate practice and their
// own login; shared staff with a reception login in the admin account; shared expenses split equally / by percentage /
// by custom amounts; each practice sees only its own shares and paying one records it in its own expenses; the shared
// desk and the shared cash screen have a tab per practice that never reaches outside the centre.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const scheduling = require('../src/modules/clinic/scheduling');
const centers = require('../src/modules/center/center.service');
const shared = require('../src/modules/center/shared.service');
const mailer = require('../src/core/mailer');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `cs-${k}-${tag}@t.test`;
let app; let A; let B; let C; let X; let centerId; let link;
const today = () => scheduling.clinicNow('Asia/Amman').date;
mailer.configured = () => false;

async function owned(email, name) {
  const id = await knex.transaction(async (trx) => {
    const u = await auth.createUser(trx, { name: 'Dr', email, password: 'Passw0rd!x' });
    await businesses.create(u, { name, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return u;
  });
  await knex('users').where({ id }).update({ email_verified_at: new Date() });
  const { last_business_id: b } = await knex('users').where({ id }).first('last_business_id');
  await knex('businesses').where({ id: b }).update({ onboarding_completed_at: new Date() });
  return b;
}
async function visit(b, name) {
  const [doc] = await knex('doctors').insert({ business_id: b, full_name: `د. ${name}`, is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()) });
  const [id] = await knex('appointments').insert({ business_id: b, doctor_id: doc, patient_name: name, patient_phone: '0790000000', appointment_date: today(), appointment_time: '10:00', duration_minutes: 20, status: 'completed', doctor_finished_at: new Date(), amount_due: 20 });
  return id;
}
const loginAs = async (who, pw = 'Passw0rd!x') => { const a = app.agent(); await a.login(mail(who), pw); return a; };

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  app = await serve();
  A = await owned(mail('a'), 'مجمع — الإدارة');
  const u = await knex('users').where({ email: mail('a') }).first('id');
  await centers.create({ businessId: A, userId: u.id }, { name: 'مجمع النور' });
  centerId = (await knex('centers').where({ owner_business_id: A }).first('id')).id;
  X = await owned(mail('x'), 'Outside');
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('the admin adds a doctor: a separate practice in the centre with the doctor\'s own login', async () => {
  const a = await loginAs('a');
  const pg = await a.get('/app/center?tab=practices');
  assert.equal(pg.status, 200);
  assert.match(pg.text, /name="doctor_name"/);
  const r = await a.post('/app/center/doctors', { _csrf: a.csrf(pg.text), doctor_name: 'Sami Haddad', email: mail('b'), practice_name: 'عيادة الأسنان', specialization: 'Dentistry' });
  assert.equal(r.status, 302);
  const user = await knex('users').where({ email: mail('b') }).first();
  assert.ok(user && user.must_change_password);
  B = user.last_business_id;
  const b = await knex('businesses').where({ id: B }).first();
  assert.equal(b.center_id, (await knex('centers').where({ owner_business_id: A }).first()).id);
  assert.equal(b.name, 'عيادة الأسنان');
  assert.notEqual(B, A);
  assert.ok((await knex('memberships').where({ business_id: B, user_id: user.id }).first()).doctor_id); // the doctor's profile, linked to the login
  assert.equal(await knex('memberships').where({ business_id: A, user_id: user.id }).first(), undefined); // not in the admin account
  // The set-password link is shown once and works.
  const page = await a.get('/app/center?tab=practices');
  link = page.text.match(/\/reset\/([A-Za-z0-9_-]{30,})/)[1];
  assert.doesNotMatch((await a.get('/app/center?tab=practices')).text, /\/reset\//);
  const d = app.agent();
  const form = await d.get(`/reset/${link}`);
  assert.equal(form.status, 200);
  await d.post(`/reset/${link}`, { _csrf: d.csrf(form.text), password: 'Passw0rd!x-B', password_confirm: 'Passw0rd!x-B' });
  const doc = await loginAs('b', 'Passw0rd!x-B');
  assert.equal((await doc.get('/app')).status, 200);
  // An e-mail that already has an account is invited, never taken over.
  await a.post('/app/center/doctors', { _csrf: a.csrf(page.text), doctor_name: 'Outsider', email: mail('x') });
  assert.equal((await knex('businesses').where({ id: X }).first()).center_id, null);
  assert.ok(await knex('center_invites').where({ email: mail('x') }).first());
  C = (await shared.addDoctor({ businessId: A, userId: null, baseUrl: 'http://t' }, { doctor_name: 'Lina', email: mail('c') })).practiceId;
  assert.ok(await knex('audit_logs').where({ action: 'center.doctor_added' }).first());
});

test('only the admin account runs the centre: another practice is refused', async () => {
  const b = await loginAs('b', 'Passw0rd!x-B');
  const pg = await b.get('/app/center');
  assert.equal(pg.status, 200);
  assert.doesNotMatch(pg.text, /name="doctor_name"/);
  const csrf = b.csrf(pg.text);
  for (const [path, body] of [['/app/center/doctors', { doctor_name: 'Z Z', email: mail('z') }], ['/app/center/staff', { name: 'Z Z' }], ['/app/center/expenses', { title: 'Rent', amount: '90' }], ['/app/center/salaries', { month: '2026-01' }], ['/app/center/split', { split_mode: 'equal' }]]) {
    const r = await b.post(path, { _csrf: csrf, ...body });
    assert.equal(r.status, 302, path); // refused with a message, nothing done
  }
  assert.equal(await knex('users').where({ email: mail('z') }).first(), undefined);
  assert.equal(await knex('center_staff').where({ center_id: centerId, name: 'Z Z' }).first(), undefined);
  assert.equal(await knex('center_expenses').where({ center_id: centerId }).first(), undefined);
  await assert.rejects(shared.addExpense({ businessId: B }, { title: 'Rent', amount: '90' }), { status: 403 });
});

test('shared staff: a reception login in the admin account; salaries posted once a month and split', async () => {
  const a = await loginAs('a');
  const pg = await a.get('/app/center?tab=staff');
  const r = await a.post('/app/center/staff', { _csrf: a.csrf(pg.text), name: 'Hala', job_title: 'Reception', salary_monthly: '400', login_email: mail('r'), login_role: 'receptionist' });
  assert.equal(r.status, 302);
  const s = await knex('center_staff').where({ name: 'Hala', center_id: centerId }).first();
  assert.ok(s.user_id);
  const m = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id').where({ 'm.user_id': s.user_id }).select('m.business_id', 'r.key');
  assert.deepEqual(m.map((x) => [x.business_id, x.key]), [[A, 'receptionist']]); // only in the admin account
  assert.match((await a.get('/app/center?tab=staff')).text, /Hala/);
  await a.post('/app/center/staff', { _csrf: a.csrf(pg.text), name: 'Omar', salary_monthly: '200' });
  const ctx = { businessId: A, userId: null };
  const id = await shared.postSalaries(ctx, '2026-09');
  const e = await knex('center_expenses').where({ id }).first();
  assert.equal(Number(e.amount), 600);
  const shares = await knex('center_expense_shares').where({ expense_id: id });
  assert.equal(shares.length, 3);
  assert.equal(shares.reduce((t, x) => t + Number(x.amount), 0), 600);
  await assert.rejects(shared.postSalaries(ctx, '2026-09'), { code: 'CENTER_SALARIES_DONE' });
});

test('splits: equal (rest to one practice), by percentage (must total 100), custom (must match the total)', async () => {
  const ps = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const eq = shared.splitAmounts(100, ps, 'equal');
  assert.equal(eq.reduce((t, x) => t + x.amount, 0), 100);
  assert.throws(() => shared.splitAmounts(100, ps.map((p) => ({ ...p, center_percent: 30 })), 'percent'), { code: 'CENTER_PERCENT_100' });
  assert.deepEqual(shared.splitAmounts(200, [{ id: 1, center_percent: 50 }, { id: 2, center_percent: 30 }, { id: 3, center_percent: 20 }], 'percent').map((x) => x.amount), [100, 60, 40]);
  assert.throws(() => shared.splitAmounts(100, ps, 'custom', { 1: 50, 2: 20, 3: 10 }), { code: 'CENTER_CUSTOM_TOTAL' });
  const ctx = { businessId: A, userId: null };
  await assert.rejects(shared.setSplit(ctx, { split_mode: 'percent', [`pct_${A}`]: 50, [`pct_${B}`]: 20, [`pct_${C}`]: 20 }), { code: 'CENTER_PERCENT_100' });
  await shared.setSplit(ctx, { split_mode: 'percent', [`pct_${A}`]: 50, [`pct_${B}`]: 30, [`pct_${C}`]: 20 });
  const eid = await shared.addExpense(ctx, { title: 'Rent', amount: '1000', category: 'rent' });
  const by = Object.fromEntries((await knex('center_expense_shares').where({ expense_id: eid })).map((s) => [s.business_id, Number(s.amount)]));
  assert.deepEqual(by, { [A]: 500, [B]: 300, [C]: 200 });
  const cid = await shared.addExpense(ctx, { title: 'Cleaning', amount: '90', split_mode: 'custom', [`share_${A}`]: '0', [`share_${B}`]: '60', [`share_${C}`]: '30' });
  assert.equal((await knex('center_expense_shares').where({ expense_id: cid })).length, 2); // a zero share is no share
  assert.ok(await knex('notifications').where({ business_id: B, link: '/app/center/costs' }).first());
});

test('each practice sees only its own shares and pays them into its own expenses', async () => {
  const b = await loginAs('b', 'Passw0rd!x-B');
  const pg = await b.get('/app/center/costs');
  assert.equal(pg.status, 200);
  assert.match(pg.text, /Rent/);
  const mine = await knex('center_expense_shares').where({ business_id: B, paid_at: null }).first();
  const theirs = await knex('center_expense_shares').where({ business_id: C, paid_at: null }).first();
  // Another practice's share: not found.
  await b.post(`/app/center/costs/${theirs.id}/pay`, { _csrf: b.csrf(pg.text), payment_method: 'cash' });
  assert.equal((await knex('center_expense_shares').where({ id: theirs.id }).first()).paid_at, null);
  assert.equal(await knex('expenses').where({ business_id: B, category: 'center_share' }).first(), undefined);
  // Its own share: paid once, recorded as its expense.
  await b.post(`/app/center/costs/${mine.id}/pay`, { _csrf: b.csrf(pg.text), payment_method: 'bank_transfer' });
  await b.post(`/app/center/costs/${mine.id}/pay`, { _csrf: b.csrf(pg.text), payment_method: 'cash' });
  const ex = await knex('expenses').where({ business_id: B, category: 'center_share' });
  assert.equal(ex.length, 1);
  assert.equal(Number(ex[0].amount), Number(mine.amount));
  assert.equal((await knex('center_expense_shares').where({ id: mine.id }).first()).practice_expense_id, ex[0].id);
  // A paid share locks its expense.
  await assert.rejects(shared.removeExpense({ businessId: A }, mine.expense_id), { code: 'CENTER_SHARE_PAID' });
  // The admin sees the balances; an outside clinic has no centre costs.
  const a = await loginAs('a');
  const costs = await a.get('/app/center?tab=costs');
  assert.equal(costs.status, 200);
  assert.match(costs.text, /عيادة الأسنان/);
  const x = await loginAs('x');
  assert.equal((await x.get('/app/center/costs')).status, 302);
  assert.deepEqual(await shared.myShares({ businessId: X }), []);
});

test('practice tabs: the shared desk and cash screen filter by a practice of the centre only', async () => {
  const vA = await visit(A, 'Adam'); const vB = await visit(B, 'Basma'); const vX = await visit(X, 'Xena');
  await knex('businesses').whereIn('id', [A, B]).update({ center_share_cash: true });
  const a = await loginAs('a');
  let desk = await a.get('/app/center/desk');
  assert.match(desk.text, new RegExp(`\\?p=${B}`));
  desk = await a.get(`/app/center/desk?p=${B}`);
  assert.match(desk.text, /Basma/); assert.doesNotMatch(desk.text, /Adam/);
  desk = await a.get(`/app/center/desk?p=${X}`); // not of this centre: ignored
  assert.match(desk.text, /Basma/); assert.match(desk.text, /Adam/); assert.doesNotMatch(desk.text, /Xena/);
  const ids = async (q) => JSON.parse((await a.get(`/app/cashier/screen/data?scope=center${q}`)).text).visits.map((v) => v.id);
  let v = await ids('');
  assert.ok(v.includes(vA) && v.includes(vB) && !v.includes(vX));
  v = await ids(`&p=${B}`);
  assert.ok(v.includes(vB) && !v.includes(vA));
  v = await ids(`&p=${X}`);
  assert.ok(!v.includes(vX) && v.includes(vA));
  const screen = await a.get(`/app/cashier/screen?scope=center&p=${B}`);
  assert.equal(screen.status, 200);
  assert.match(screen.text, /pos-practices/);
});
