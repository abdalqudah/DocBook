// Clinic home (GET /app, role-aware — worker: owner) and a doctor's own day (GET /app/my-day).
const express = require('express');
const knex = require('../../db/knex');
const charts = require('../../core/charts');
const fmtCore = require('../../core/format');
const { E } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { entryFor } = require('../rbac/permissions');
const scheduling = require('./scheduling');
const lib = require('./records.lib');

const router = express.Router();
const PAGE = { pageScripts: ['/js/records.js'], pageStyles: ['/css/records.css'] };
const ACTIVE = ['pending', 'confirmed'];

const apptBase = (ctx) => {
  const q = knex('appointments as a').where('a.business_id', ctx.businessId).whereNot('a.appointment_type', 'blocked');
  if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId);
  return require('./branches.service').scope(q, ctx); // eslint-disable-line global-require -- the branch chosen in the account menu
};
const invBase = (ctx) => {
  const q = knex('invoices as i').where('i.business_id', ctx.businessId);
  if (ctx.ownDoctorId) q.where('i.doctor_id', ctx.ownDoctorId);
  return require('./branches.service').scopeByVisit(q, ctx, 'i.appointment_id'); // eslint-disable-line global-require
};
const sumOf = async (q) => { const [r] = await q.select(knex.raw('COALESCE(SUM(i.amount),0) as v'), knex.raw('COUNT(*) as n')); return { value: Number(r.v) || 0, count: Number(r.n) || 0 }; };

/** The first name to greet the member with, in the page's language: Arabic when the page is Arabic, English when it is
 * English — from the account's name and the member's doctor profile (Arabic name / English name), titles left out. */
async function greetName(req) {
  const doctorId = (res0(req).myDoctorId) || req.ctx.ownDoctorId || null;
  const doc = doctorId ? await knex('doctors').where({ id: doctorId, business_id: req.ctx.businessId }).first('full_name', 'full_name_en').catch(() => null) : null;
  const first = (n) => String(n || '').split(/\s+/).filter((w) => w && !/^(د\.?|dr\.?|دكتور|الدكتور|الدكتورة|doctor|prof\.?)$/i.test(w))[0] || '';
  const ar = (n) => /[\u0600-\u06ff]/.test(n || ''); const lat = (n) => /[a-z]/i.test(n || '') && !ar(n);
  const names = [req.ctx.userName, doc && doc.full_name, doc && doc.full_name_en].filter(Boolean);
  const pick = req.locale === 'en' ? [doc && doc.full_name_en, ...names].find(lat) : names.find(ar);
  return first(pick || req.ctx.userName);
}
const res0 = (req) => (req.res && req.res.locals) || {};

function greetingKey(tz) {
  const { minutes } = scheduling.clinicNow(tz);
  if (minutes < 12 * 60) return 'dashboard.greet_morning';
  if (minutes < 17 * 60) return 'dashboard.greet_afternoon';
  return 'dashboard.greet_evening';
}

/** Where someone without the dashboard goes (never back to /app itself). */
function fallbackFor(req, res) {
  const entry = entryFor(req.ctx.roleKey);
  if (entry && entry !== '/app' && entry !== '/app/') {
    if (entry === '/app/my-day' && !req.ctx.doctorId) return null;
    return entry;
  }
  if (req.ctx.doctorId) return '/app/my-day';
  const first = (res.locals.navGroups || []).flatMap((g) => g.items).find((i) => i.href !== '/app' && i.href !== '/app/settings' && i.href !== '/app/help');
  return first ? first.href : null;
}

// ---------------------------------------------------------------- home (/app), by role
// owner / manager → today at a glance, quick actions, this month, setup checklist
// receptionist / nurse → today's queue and big buttons (they normally land on the reception board)
// accountant → today's collections, unpaid visits, cash drawer, this month's expenses
// doctor → their own day (/app/my-day)
function homeKind(ctx) {
  const p = ctx.permissions;
  if (['owner', 'clinic_manager'].includes(ctx.roleKey)) return 'owner';
  if (ctx.roleKey === 'doctor') return ctx.doctorId ? 'doctor' : 'owner';
  if (['receptionist', 'nurse'].includes(ctx.roleKey)) return 'reception';
  if (ctx.roleKey === 'accountant') return 'accounts';
  // Custom roles: by what they can do.
  if (p.has('settings.manage')) return 'owner';
  if (p.has('frontdesk.use')) return 'reception';
  if (p.has('finance.view') || p.has('expenses.manage')) return 'accounts';
  return 'owner';
}

const num = (v) => Number(v) || 0;
const invoicesOn = (ctx, from, to) => lib.whereLocalDates(invBase(ctx), 'i.created_at', from, to, ctx.timezone);

/** Finished visits of the last 30 days nobody has collected yet (count + amount the doctor entered). */
async function unpaidFinished(ctx) {
  const q = apptBase(ctx).where({ 'a.status': 'completed', 'a.payment_status': 'unpaid' }).whereBetween('a.appointment_date', [lib.addDays(ctx.today, -30), ctx.today]);
  const r = await q.first(knex.raw('COUNT(*) as n'), knex.raw('COALESCE(SUM(a.amount_due),0) as v'), knex.raw("SUM(CASE WHEN a.appointment_date = ? THEN 1 ELSE 0 END) as today", [ctx.today]));
  return { count: num(r.n), amount: num(r.v), today: num(r.today) };
}

async function todayCounts(ctx) {
  const rows = await apptBase(ctx).where('a.appointment_date', ctx.today)
    .select(knex.raw("SUM(CASE WHEN a.status <> 'cancelled' THEN 1 ELSE 0 END) as total"),
      knex.raw("SUM(CASE WHEN a.status IN ('pending','confirmed') AND a.checked_in = 0 AND a.with_doctor = 0 THEN 1 ELSE 0 END) as to_arrive"),
      knex.raw("SUM(CASE WHEN a.status IN ('pending','confirmed') AND a.checked_in = 1 AND a.with_doctor = 0 THEN 1 ELSE 0 END) as waiting"),
      knex.raw("SUM(CASE WHEN a.status IN ('pending','confirmed') AND a.with_doctor = 1 THEN 1 ELSE 0 END) as with_doctor"),
      knex.raw("SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as done"),
      knex.raw("SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) as no_show"),
      knex.raw("SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled"))
    .first();
  return {
    total: num(rows.total), toArrive: num(rows.to_arrive), waiting: num(rows.waiting), withDoctor: num(rows.with_doctor),
    done: num(rows.done), noShows: num(rows.no_show), cancelled: num(rows.cancelled),
  };
}

const todaySchedule = async (ctx) => withDocs(ctx, await apptBase(ctx).leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id')
  .where('a.appointment_date', ctx.today).orderBy('a.appointment_time').limit(60)
  .select('a.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.color as doctor_color', 's.name as service_name', 's.name_en as service_name_en'));

/**
 * Each visit's papers for the row icons on Today / My day: a.docs.items = one icon per paper — every prescription,
 * every lab and imaging request, every referral, then the invoice; a dim icon stands for a kind not issued yet.
 * Clinical staff open the paper's page; reception (billing.view) prints it as PDF from the cash desk routes.
 */
async function withDocs(ctx, rows) {
  const ids = rows.map((a) => a.id);
  const p = ctx.permissions;
  const clin = p.has('clinical.view');
  const billing = p.has('billing.view');
  const papers = clin || billing;
  const by = async (on, table, cols) => {
    if (!on || !ids.length) return {};
    const got = await knex(table).where('business_id', ctx.businessId).whereIn('appointment_id', ids).orderBy('id').select('appointment_id', ...cols);
    return got.reduce((m, r) => { (m[r.appointment_id] = m[r.appointment_id] || []).push(r); return m; }, {});
  };
  const pids = [...new Set(rows.map((a) => a.patient_id).filter(Boolean))];
  const [rx, ord, ref, inv, mails, reps, certs, files] = await Promise.all([
    by(papers, 'prescriptions', ['id']), by(papers, 'medical_orders', ['id', 'kind', 'status']), by(papers, 'referrals', ['id', 'specialty']), by(billing, 'invoices', ['id', 'invoice_number']),
    pids.length ? knex('patients').where('business_id', ctx.businessId).whereIn('id', pids).whereNotNull('email').select('id', 'email') : [],
    by(clin, 'consultations', ['id']), by(clin && ['certificates.view', 'certificates.issue'].some((k) => p.has(k)), 'certificates', ['id', 'doc_type', 'revoked_at']), by(clin, 'patient_files', ['id', 'title', 'name'])]);
  const mailOf = Object.fromEntries(mails.map((r) => [r.id, r.email]));
  // Consultation timer of each visit (running, paused or done): shown live beside the patient.
  const timer = require('../clinicalplus/timer.service'); // eslint-disable-line global-require
  const timers = ids.length ? await knex('consultation_timers').where('business_id', ctx.businessId).whereIn('appointment_id', ids) : [];
  const timerOf = Object.fromEntries(timers.map((t) => [t.appointment_id, timer.view(t)]));
  const paper = (a, kind, id) => `/app/cashier/papers/${a.id}/${kind}/${id}.pdf`;
  rows.forEach((a) => {
    const items = [];
    if (papers) {
      const rxs = rx[a.id] || [];
      if (!rxs.length) items.push({ key: 'prescription', ic: 'pill' });
      rxs.forEach((r) => items.push({ key: 'prescription', ic: 'pill', on: true, href: clin ? `/app/visits/${a.id}/prescriptions/${r.id}` : paper(a, 'prescription', r.id) }));
      const os = (ord[a.id] || []).filter((o) => o.status !== 'cancelled');
      if (!os.length) items.push({ key: 'orders', ic: 'activity' });
      os.forEach((o) => items.push({ key: o.kind === 'imaging' ? 'imaging' : 'lab', ic: o.kind === 'imaging' ? 'scan-line' : 'activity', on: true, href: clin ? `/app/orders/${o.id}` : paper(a, 'order', o.id) }));
      (ref[a.id] || []).forEach((r) => items.push({ key: 'referral', ic: 'send', on: true, extra: r.specialty, href: clin ? `/app/referrals/${r.id}` : paper(a, 'referral', r.id) }));
    }
    if (billing) {
      const is = inv[a.id] || [];
      if (!is.length) items.push({ key: 'invoice', ic: 'receipt' });
      is.forEach((i) => items.push({ key: 'invoice', ic: 'receipt', on: true, href: `/app/billing/${i.id}` }));
    }
    // What can go to the patient (the send menu): ticked by default; the server checks each one again when sending.
    const send = [
      ...(inv[a.id] || []).map((i) => ({ kind: 'invoice', id: i.id, key: 'share.list.invoice', ic: 'receipt' })),
      ...(rx[a.id] || []).map((r) => ({ kind: 'prescription', id: r.id, key: 'share.doc.prescription', ic: 'pill' })),
      ...((reps[a.id] || []).length ? [{ kind: 'report', id: a.id, key: 'share.doc.report', ic: 'stethoscope' }] : []),
      ...(ord[a.id] || []).filter((o) => o.status !== 'cancelled').map((o) => ({ kind: 'order', id: o.id, key: o.kind === 'imaging' ? 'share.list.imaging' : 'share.list.lab', ic: o.kind === 'imaging' ? 'scan-line' : 'activity' })),
      ...(ref[a.id] || []).map((r) => ({ kind: 'referral', id: r.id, key: 'share.doc.referral', vars: { specialty: r.specialty }, ic: 'send' })),
      ...(certs[a.id] || []).filter((c) => !c.revoked_at).map((c) => ({ kind: 'certificate', id: c.id, key: 'share.doc.certificate', ic: 'badge-check' })),
      ...(files[a.id] || []).map((f) => ({ kind: 'file', id: f.id, key: 'share.doc.file', vars: { title: f.title || f.name }, ic: 'paperclip' })),
    ];
    // The same four places on every row (prescription · tests · referral · invoice), so the icons line up down the
    // list: an empty place stays dimmed, several papers of one kind show their number.
    const slot = (key, ic, list) => ({ key, ic, n: list.length, on: list.length > 0, href: list.length ? list[0].href : null, extra: list.map((x) => x.extra).filter(Boolean).join('، ') || null, list });
    const on = (k) => items.filter((x) => x.on && k.includes(x.key));
    const slots = [
      ...(papers ? [slot('prescription', 'pill', on(['prescription'])), slot(on(['imaging']).length && !on(['lab']).length ? 'imaging' : 'orders', on(['imaging']).length && !on(['lab']).length ? 'scan-line' : 'activity', on(['lab', 'imaging'])), slot('referral', 'send', on(['referral']))] : []),
      ...(billing ? [slot('invoice', 'receipt', on(['invoice']))] : []),
    ];
    a.docs = { items, slots, send, print: !clin, clinical: papers, billing, any: items.some((x) => x.on) };
    a.email = mailOf[a.patient_id] || a.patient_email || null;
    a.timer = timerOf[a.id] || null;
  });
  return rows;
}

async function onlineRequests(ctx) {
  const base = () => apptBase(ctx).where({ 'a.source': 'website', 'a.status': 'pending' }).where('a.appointment_date', '>=', ctx.today);
  const [rows, count] = await Promise.all([
    base().leftJoin('doctors as d', 'd.id', 'a.doctor_id').orderBy([{ column: 'a.appointment_date' }, { column: 'a.appointment_time' }]).limit(5)
      .select('a.*', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.color as doctor_color'),
    base().count({ n: '*' }).first(),
  ]);
  return { rows, count: num(count.n) };
}

async function collected(ctx) {
  const yesterday = lib.addDays(ctx.today, -1);
  const [today, before] = await Promise.all([sumOf(invoicesOn(ctx, ctx.today, ctx.today)), sumOf(invoicesOn(ctx, yesterday, yesterday))]);
  return { today, yesterday: before };
}

/** This month so far, the same way the profit & loss page counts it (cash basis). */
async function thisMonth(ctx) {
  const pnl = require('../finance/pnl.service'); // eslint-disable-line global-require
  const month = ctx.today.slice(0, 7);
  const [cur, prev] = await Promise.all([pnl.monthNet(ctx, month), pnl.monthNet(ctx, lib.addMonths(month, -1))]);
  return { month, income: cur.revenue, expenses: cur.costs, opex: cur.opex, payroll: cur.payroll, net: cur.net, prevIncome: prev.revenue };
}

async function expensesThisMonth(ctx) {
  const month = ctx.today.slice(0, 7);
  const r = await require('./branches.service').scope(knex('expenses').where({ business_id: ctx.businessId }), ctx, 'branch_id').whereBetween('date', [`${month}-01`, ctx.today]).first(knex.raw('COALESCE(SUM(amount),0) as v'), knex.raw('COUNT(*) as n'));
  return { total: num(r.v), count: num(r.n) };
}

/** Things waiting for a decision: online requests, low stock, rep visit requests, pay adjustments to approve. */
/**
 * "Needs attention now" (Today, every role): one line per thing to act on, most urgent first, each opening the page
 * where it is done. Only what the member may act on; nothing when there is nothing.
 */
const LATE_AFTER_MIN = 15;
async function attention(ctx, { online, unpaid } = {}) {
  const p = ctx.permissions;
  const b = ctx.businessId;
  const now = scheduling.clinicNow(ctx.timezone);
  const lateBefore = scheduling.minutesToTime(Math.max(0, now.minutes - LATE_AFTER_MIN));
  const [doc, late, low, reps, adj] = await Promise.all([
    p.has('doctors.manage') ? knex('doctors').where({ business_id: b, is_active: true }).first('id') : true,
    p.has('frontdesk.use') || p.has('appointments.manage') ? apptBase(ctx).where('a.appointment_date', ctx.today).whereIn('a.status', ['pending', 'confirmed'])
      .where({ 'a.checked_in': false, 'a.with_doctor': false }).where('a.appointment_time', '<', lateBefore).count({ n: '*' }).first() : null,
    p.has('supplies.view') ? knex('supply_items').where({ business_id: b }).whereRaw('current_stock <= reorder_level').count({ n: '*' }).first() : null,
    p.has('vendors.view') ? knex('rep_visits').where({ business_id: b, status: 'requested' }).where('visit_date', '>=', ctx.today).modify((q) => { if (ctx.ownDoctorId) q.where('doctor_id', ctx.ownDoctorId); }).count({ n: '*' }).first() : null,
    p.has('payroll.approve') ? knex('payroll_adjustments').where({ business_id: b, approval_status: 'pending' }).count({ n: '*' }).first() : null,
  ]);
  return [
    // No doctor yet: nothing can be booked (the online booking page shows the clinic's phone instead).
    doc ? null : { key: 'no_doctors', n: 1, noCount: true, href: '/app/doctors/new', icon: 'stethoscope', tone: 'danger' },
    unpaid && unpaid.today && p.has('billing.manage') ? { key: 'to_pay', n: unpaid.today, href: '/app/cashier/screen', icon: 'banknote', tone: 'danger' } : null,
    late ? { key: 'late', n: num(late.n), href: p.has('frontdesk.use') ? '/app/front-desk' : '/app/appointments', icon: 'hourglass', tone: 'danger' } : null,
    online && p.has('appointments.view') ? { key: 'online', n: online.count, href: '/app/appointments?status=pending', icon: 'globe' } : null,
    unpaid && unpaid.count > unpaid.today && p.has('billing.view') ? { key: 'unpaid_old', n: unpaid.count - unpaid.today, href: '/app/billing?tab=unpaid', icon: 'receipt' } : null,
    low ? { key: 'low_stock', n: num(low.n), href: '/app/supplies?low=yes', icon: 'package', tone: 'danger' } : null,
    reps ? { key: 'rep_visits', n: num(reps.n), href: '/app/rep-visits', icon: 'briefcase-business' } : null,
    adj ? { key: 'pay_approvals', n: num(adj.n), href: '/app/payroll', icon: 'wallet' } : null,
  ].filter((x) => x && x.n > 0);
}

/** Appointments per day for the last 30 days + this month's income by doctor (the "last 30 days" section). */
async function trends(req) {
  const { ctx } = req;
  const from30 = lib.addDays(ctx.today, -29);
  const perDay = await apptBase(ctx).whereBetween('a.appointment_date', [from30, ctx.today]).whereNot('a.status', 'cancelled').groupBy('a.appointment_date').select('a.appointment_date as d').count({ n: '*' })
    .select(knex.raw("SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as done"));
  const counts = Object.fromEntries(perDay.map((r) => [r.d, { n: Number(r.n), done: Number(r.done) }]));
  const L = (d, o) => fmtCore.formatDate(d, req.locale, o);
  const points = [];
  for (let i = 0; i < 30; i += 1) {
    const d = lib.addDays(from30, i);
    points.push({ label: L(d, { weekday: 'short', day: 'numeric', month: 'short' }), short: L(d, { day: 'numeric', month: 'numeric' }), value: (counts[d] || {}).n || 0, done: (counts[d] || {}).done || 0 });
  }
  const nf = (v) => fmtCore.formatNumber(v, req.locale, 0);
  const apptChart = points.some((p) => p.value) ? charts.columns({
    points, title: req.t('dashboard.chart_30'), fmt: nf, height: 220, width: 720, series: [{ key: 'value', cls: '' }, { key: 'done', cls: 's2' }],
    tipFmt: (p) => `${req.t('dashboard.booked_n', { n: nf(p.value) })} · ${req.t('dashboard.done_n', { n: nf(p.done) })}`, labelMax: false,
  }) : null;
  let byDoctor = null;
  if (ctx.permissions.has('finance.view')) {
    const month = ctx.today.slice(0, 7);
    const rows = await invoicesOn(ctx, `${month}-01`, ctx.today).leftJoin('doctors as d', 'd.id', 'i.doctor_id')
      .groupBy('i.doctor_id', 'i.doctor_name', 'd.full_name_en').select('i.doctor_id', 'i.doctor_name', 'd.full_name_en').sum({ v: 'i.amount' }).count({ n: '*' }).orderBy('v', 'desc');
    const money2 = (v) => fmtCore.formatCompact(v, ctx.currency, req.locale);
    byDoctor = rows.length ? charts.bars({ items: rows.slice(0, 8).map((r) => ({ label: (req.locale === 'en' && r.full_name_en) || r.doctor_name || req.t('dashboard.no_doctor'), value: Number(r.v), note: `(${nf(r.n)})` })), fmt: money2 }) : null;
  }
  return { apptChart, byDoctor };
}

router.get('/', wrap(async (req, res) => {
  const { ctx } = req;
  const perms = ctx.permissions;
  if (!perms.has('dashboard.view')) {
    const to = fallbackFor(req, res);
    if (to) return res.redirect(to);
    return res.redirect('/app/settings');
  }
  const kind = homeKind(ctx);
  if (kind === 'doctor') return res.redirect('/app/my-day');
  const money = perms.has('finance.view') || perms.has('billing.view');
  const cashier = require('./cashier.service'); // eslint-disable-line global-require

  const [counts, schedule, online, unpaid, cash, month, checklist] = await Promise.all([
    todayCounts(ctx),
    kind !== 'accounts' ? todaySchedule(ctx) : [],
    kind !== 'accounts' && perms.has('appointments.view') ? onlineRequests(ctx) : null,
    perms.has('billing.view') ? unpaidFinished(ctx) : null,
    money ? collected(ctx) : null,
    perms.has('finance.view') && kind !== 'reception' ? thisMonth(ctx) : null,
    kind === 'owner' && perms.has('settings.manage') ? require('../onboarding/setup.service').checklist(ctx.businessId) : null, // eslint-disable-line global-require
  ]);
  const data = { kind, counts, schedule, online, unpaid, cash, month, checklist: checklist && !checklist.dismissed && !checklist.complete ? checklist : null };
  data.mailOn = schedule.length ? await require('../../core/mailer').configuredFor(ctx.businessId) : false; // eslint-disable-line global-require
  data.attention = await attention(ctx, { online, unpaid });
  // Going online is optional and comes after the clinic works: shown once the setup checklist is done or hidden.
  if (perms.has('website.view') && !data.checklist && kind === 'owner') {
    const st = await require('../website/site.service').state(ctx.businessId); // eslint-disable-line global-require
    if (st.status !== 'live') data.goOnline = { status: st.status };
  }
  if (kind === 'owner') data.trends = await trends(req);
  if (kind === 'accounts') {
    const [byMethod, drawer, expenses] = await Promise.all([
      perms.has('billing.view') ? cashier.todayTotals(ctx) : null,
      perms.has('billing.view') ? cashier.openPeriod(ctx) : null,
      perms.has('expenses.view') ? expensesThisMonth(ctx) : null,
    ]);
    Object.assign(data, { byMethod, drawer, expenses, methods: cashier.PAYMENT_METHODS });
  }

  // A rep's paid ad (sponsored, matched to the clinic's specialty and city) for people who deal with reps.
  if (perms.has('vendors.view') || ctx.doctorId) data.sponsored = (await require('../vendorbilling/billing.service').adsFor(req.business, { limit: 1 }).catch(() => []))[0]
    || (await require('../hub/hub.service').cached('ad').catch(() => [])).sort(() => Math.random() - 0.5)[0] || null; // eslint-disable-line global-require
  return res.page('pages/clinic/dashboard/index', {
    title: req.t('navx.sec_today'), greeting: req.t(greetingKey(ctx.timezone), { name: await greetName(req) }),
    ...data, statusTone: lib.STATUS_TONE, nowTime: scheduling.minutesToTime(scheduling.clinicNow(ctx.timezone).minutes), localTime: (d) => lib.localTime(d, ctx.timezone),
    pageScripts: ['/js/records.js', '/js/ownerx.js'], pageStyles: ['/css/records.css', '/css/ownerx.css', '/css/vbill.css'],
  });
}));

// The owner hides the "finish setting up" card (it can still be reached from Settings and the setup wizard).
router.post('/setup-checklist/dismiss', can('settings.manage'), wrap(async (req, res) => {
  await require('../onboarding/setup.service').dismissChecklist(req.ctx); // eslint-disable-line global-require
  if (req.xhr || (req.get('accept') || '').includes('application/json')) return res.json({ ok: true });
  flash(req, 'info', req.t('ownerx.check.hidden'));
  return res.redirect('/app');
}));

// ---------------------------------------------------------------- my day
router.get('/my-day', wrap(async (req, res) => {
  const { ctx } = req;
  if (!ctx.doctorId) {
    if (ctx.permissions.has('dashboard.view')) return res.redirect('/app');
    throw E.notFound('Page');
  }
  if (!['appointments.view', 'clinical.view'].some((p) => ctx.permissions.has(p))) throw E.forbidden('appointments.view');
  const doctor = await knex('doctors').where({ id: ctx.doctorId, business_id: ctx.businessId }).first();
  if (!doctor) throw E.notFound('Doctor');
  const today = ctx.today;
  const date = lib.isIso(req.query.date) ? req.query.date : today;
  const tz = ctx.timezone;
  const now = scheduling.clinicNow(tz);
  const [rows, daysOff, offToday, weekRows] = await Promise.all([
    knex('appointments as a').leftJoin('services as s', 's.id', 'a.service_id')
      .where({ 'a.business_id': ctx.businessId, 'a.doctor_id': doctor.id, 'a.appointment_date': date })
      .orderBy('a.appointment_time')
      .select('a.*', 's.name as service_name', 's.name_en as service_name_en', knex.raw('COALESCE(a.duration_minutes, s.duration_minutes, ?) as length', [doctor.slot_duration_minutes || 30])),
    knex('doctor_days_off').where({ business_id: ctx.businessId, doctor_id: doctor.id }).where('off_date', '>=', today).orderBy('off_date').limit(6),
    knex('doctor_days_off').where({ business_id: ctx.businessId, doctor_id: doctor.id, off_date: date }).first(),
    knex('appointments').where({ business_id: ctx.businessId, doctor_id: doctor.id }).whereBetween('appointment_date', [lib.addDays(date, 1), lib.addDays(date, 7)])
      .whereNot('appointment_type', 'blocked').whereIn('status', ACTIVE).groupBy('appointment_date').select('appointment_date as d').count({ n: '*' }),
  ]);
  const isToday = date === today;
  // Doctor journey (round 8, dflow): a consultation timer that is running / paused means the patient is with the doctor.
  const openTimers = new Set(rows.length ? await knex('consultation_timers').where('business_id', ctx.businessId)
    .whereIn('appointment_id', rows.map((r) => r.id)).whereNull('ended_at').pluck('appointment_id') : []);
  const stateOf = (a) => {
    if (a.appointment_type === 'blocked') return 'blocked';
    if (a.status === 'cancelled' || a.status === 'no_show') return a.status;
    if (a.payment_status === 'paid') return 'paid';
    if (a.status === 'completed') return 'to_pay';
    if (a.with_doctor) return openTimers.has(a.id) ? 'with_me' : 'sent_in';
    if (a.checked_in) return 'waiting';
    return 'booked';
  };
  const items = rows.map((a) => {
    const arrived = a.arrived_at ? lib.localTime(a.arrived_at, tz) : null;
    let waitedMin = null;
    if (isToday && a.checked_in && !a.with_doctor && ACTIVE.includes(a.status) && a.arrived_at) waitedMin = Math.max(0, Math.round((Date.now() - new Date(a.arrived_at).getTime()) / 60000));
    const endMin = scheduling.timeToMinutes(a.appointment_time) + Number(a.length || 30);
    return {
      ...a, arrivedTime: arrived ? arrived.time : null, waitedMin, end: scheduling.minutesToTime(endMin % (24 * 60)),
      state: stateOf(a), past: isToday ? endMin <= now.minutes : date < today,
    };
  });
  const patients = items.filter((a) => a.state !== 'blocked');
  const counts = {
    total: patients.filter((a) => a.status !== 'cancelled').length,
    completed: patients.filter((a) => a.status === 'completed').length,
    waiting: patients.filter((a) => a.state === 'waiting' || a.state === 'sent_in').length,
    remaining: patients.filter((a) => a.state === 'booked').length,
    toPay: patients.filter((a) => a.state === 'to_pay').length,
    noShows: patients.filter((a) => a.status === 'no_show').length,
  };
  const withMe = patients.find((a) => a.state === 'with_me') || null;
  const byArrival = (x, y) => String(x.arrived_at || '').localeCompare(String(y.arrived_at || ''));
  const waitingQueue = patients.filter((a) => a.state === 'sent_in').sort(byArrival).concat(patients.filter((a) => a.state === 'waiting').sort(byArrival));
  let next = withMe || waitingQueue[0] || null;
  if (!next) {
    const nowT = scheduling.minutesToTime(now.minutes);
    next = patients.find((a) => a.state === 'booked' && (!isToday || a.appointment_time >= nowT))
      || (isToday ? patients.find((a) => a.state === 'booked') : null) || null;
  }
  const wh = typeof doctor.working_hours === 'string' ? JSON.parse(doctor.working_hours || 'null') : doctor.working_hours;
  const day = scheduling.normalizeDayConfig((wh || {})[scheduling.dayKeyOf(date)]);

  let revenue = null;
  if (ctx.permissions.has('finance.view')) {
    revenue = await sumOf(lib.whereLocalDates(knex('invoices as i').where({ 'i.business_id': ctx.businessId, 'i.doctor_id': doctor.id }), 'i.created_at', date, date, tz));
  }
  const week = [];
  const wk = Object.fromEntries(weekRows.map((r) => [r.d, Number(r.n)]));
  for (let i = 1; i <= 7; i += 1) { const d = lib.addDays(date, i); week.push({ date: d, n: wk[d] || 0 }); }

  // Recent patients (Today, doctor): the last five people this doctor finished a visit with.
  const recent = ctx.permissions.has('patients.view') ? await knex('appointments').where({ business_id: ctx.businessId, doctor_id: doctor.id, status: 'completed' }).whereNotNull('patient_id')
    .where('appointment_date', '<=', today).groupBy('patient_id').select('patient_id').max({ last: 'appointment_date' }).max({ name: 'patient_name' }).orderBy('last', 'desc').limit(5) : [];

  await withDocs(ctx, items.filter((a) => a.state !== 'blocked'));
  const mailOn = await require('../../core/mailer').configuredFor(ctx.businessId); // eslint-disable-line global-require
  return res.page('pages/clinic/dashboard/my-day', {
    title: req.t('my_day.title'), mailOn, doctor, date, isToday, prev: lib.addDays(date, -1), next: lib.addDays(date, 1), items, counts, withMe, nextPatient: next,
    waitingQueue, daysOff, offToday, day, revenue, week, recent, statusTone: lib.STATUS_TONE, autoRefresh: isToday,
    pageScripts: [...PAGE.pageScripts, '/js/dflow.js'], pageStyles: [...PAGE.pageStyles, '/css/dflow.css'],
  });
}));

module.exports = router;
