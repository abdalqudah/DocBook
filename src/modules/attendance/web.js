// Staff attendance (/app/attendance).
//  • everyone (every active member): own status + clock in/out button (unless the clinic records by QR only)
//    and their own month (timesheet: every day with its status, hours, late minutes)
//  • today's board and the monthly report (attendance.view): present / late / absent / not in yet / day off,
//    first in, last out, hours; per-person timesheet (/staff/:id); export (data.export)
//  • corrections and added shifts (attendance.manage): reason required, audited
//  • door screens (/screens, attendance.manage): each screen opens full-screen with its own secret link
//    (/kiosk/<token>, see kiosk.web.js); /kiosk is the same screen opened from a manager's own session
//  • working hours (/settings, attendance.manage): clinic hours, grace minutes, personal hours per staff member
//  • /scan?t=… (every member): opened by the phone camera; one tap to clock in or out. A code scanned while
//    signed out is remembered across the login (middleware/context.js → pendingScan).
const express = require('express');
const { phoneBase } = require('../../middleware/web');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError, E } = require('../../core/errors');
const exporter = require('../../core/exporter');
const businesses = require('../businesses/business.service');
const svc = require('./attendance.service');
const kiosks = require('./kiosk.service');

const router = express.Router();
const STYLES = ['/css/attendance.css'];
const SCRIPTS = ['/js/attendance.js'];

const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const idOf = (v) => (/^\d+$/.test(String(v || '')) ? Number(v) : null);
function recentMonths(today, n = 12) {
  const out = [];
  const [y, m] = today.split('-').map(Number);
  for (let i = 0; i < n; i += 1) { const d = new Date(Date.UTC(y, m - 1 - i, 1)); out.push(d.toISOString().slice(0, 7)); }
  return out;
}
/** Translates an error code from this area's own table, then the shared one, else the English message. */
function errText(req, e) {
  for (const key of [`errors_attendance.${e.code}`, `errors.${e.code}`]) { const s = req.t(key); if (s !== key) return s; }
  return e.message;
}
const roleLabel = (req, r) => (r && r.role_key && (r.is_system || r.is_system === 1) ? req.t(`roles.${r.role_key}`) : (r && r.role_name) || '—');
const hm = (m) => { const v = Math.max(0, Math.round(m || 0)); return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`; };

// ---------------------------------------------------------------- main page
async function render(req, res, extra = {}) {
  const { ctx } = req;
  const today = ctx.today;
  const canView = ctx.permissions.has('attendance.view');
  let view = String(req.query.view || '');
  if (view === 'team') view = req.query.mode === 'month' ? 'month' : 'today'; // older links
  if (!canView || !['me', 'today', 'month'].includes(view)) view = canView ? 'today' : 'me';
  const month = isMonth(req.query.month) && req.query.month <= today.slice(0, 7) ? req.query.month : today.slice(0, 7);
  const [settings, open, allStaff] = await Promise.all([svc.settings(ctx.businessId), svc.openShift(ctx.businessId, ctx.userId), svc.staff(ctx.businessId)]);
  const roles = [];
  allStaff.forEach((s) => { if (!roles.some((r) => r.role_id === s.role_id)) roles.push({ role_id: s.role_id, label: roleLabel(req, s) }); });
  const userId = idOf(req.query.user);
  const roleId = idOf(req.query.role);
  const data = {
    title: req.t('attendance.title'), view, month, months: recentMonths(today), settings, open, openSince: open ? svc.localTime(ctx.timezone, open.clock_in) : null,
    roleLabel: (r) => roleLabel(req, r), hm, staffOptions: allStaff.filter((s) => s.status === 'active'), roles, userId, roleId, filtered: Boolean(userId || roleId),
    pageStyles: STYLES, pageScripts: SCRIPTS, printable: true,
  };
  if (view === 'me') {
    data.sheet = await svc.timesheet(ctx, ctx.userId, month);
  } else if (view === 'today') {
    const date = isDate(req.query.date) && req.query.date <= today ? req.query.date : today;
    Object.assign(data, { date, prevDate: svc.shiftDay(date, -1), nextDate: date < today ? svc.shiftDay(date, 1) : null, board: await svc.board(ctx, date, { userId, roleId }) });
  } else {
    data.report = await svc.monthReport(ctx, month, { userId, roleId });
  }
  res.page('pages/attendance/index', { ...data, ...extra });
}

router.get('/', wrap((req, res) => render(req, res)));

// Clock in / out with the button (own page).
router.post('/clock', wrap(async (req, res) => {
  try {
    const r = await svc.toggle(req.ctx, { method: 'button', expect: req.body.expect });
    flash(req, 'success', req.t(r.action === 'in' ? 'attendance.done_in' : 'attendance.done_out', { time: svc.localTime(req.ctx.timezone, r.at) }));
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    flash(req, e.code === 'ATTENDANCE_ALREADY_IN' || e.code === 'ATTENDANCE_ALREADY_OUT' ? 'info' : 'error', errText(req, e));
  }
  res.redirect(req.body._return && String(req.body._return).startsWith('/app/attendance') ? req.body._return : '/app/attendance');
}));

// ---------------------------------------------------------------- one person's month (manager, or yourself)
async function renderStaff(req, res, extra = {}) {
  const uid = Number(req.params.id);
  if (uid !== req.ctx.userId && !req.ctx.permissions.has('attendance.view')) throw E.forbidden();
  const today = req.ctx.today;
  const month = isMonth(req.query.month) && req.query.month <= today.slice(0, 7) ? req.query.month : today.slice(0, 7);
  const sheet = await svc.timesheet(req.ctx, uid, month);
  // The export menu builds its links from the query: point it at this person's month.
  Object.assign(req.query, { view: 'month', user: String(uid), month });
  res.page('pages/attendance/staff', {
    title: `${req.t('attendance.title')} · ${sheet.person.name}`, sheet, month, months: recentMonths(today), roleLabel: (r) => roleLabel(req, r), hm,
    staffOptions: (await svc.staff(req.ctx.businessId)).filter((s) => s.status === 'active'), pageStyles: STYLES, pageScripts: SCRIPTS, printable: true, ...extra,
  });
}
router.get('/staff/:id(\\d+)', wrap((req, res) => renderStaff(req, res)));

// ---------------------------------------------------------------- export (same filters as the page)
router.get('/export', can('attendance.view'), can('data.export'), wrap(async (req, res) => {
  const { t } = req;
  const today = req.ctx.today;
  const month = isMonth(req.query.month) ? req.query.month : today.slice(0, 7);
  const userId = idOf(req.query.user);
  const roleId = idOf(req.query.role);
  const view = req.query.view === 'team' ? (req.query.mode === 'month' ? 'month' : 'today') : req.query.view;
  if (view === 'month' && !userId) {
    // Monthly report: one line per person.
    const rep = await svc.monthReport(req.ctx, month, { roleId });
    return exporter.send(req, res, {
      name: `${t('attendance.export_report_name')} ${month}`,
      header: [t('attendance.person'), t('attendance.role'), t('attendance.days_present'), t('attendance.hours_worked'), t('attendance.late_days'), t('attendance.late_minutes'), t('attendance.absent_days'), t('attendance.overtime'), t('attendance.missing_out')],
      rows: rep.rows.map((p) => [p.name, roleLabel(req, p), p.present, Math.round((p.worked / 60) * 100) / 100, p.late, p.lateMinutes, p.absent, Math.round((p.overtime / 60) * 100) / 100, p.missingOut]),
    });
  }
  if (view === 'today') {
    const date = isDate(req.query.date) ? req.query.date : today;
    const b = await svc.board(req.ctx, date, { userId, roleId });
    return exporter.send(req, res, {
      name: `${t('attendance.export_board_name')} ${date}`,
      header: [t('common.date'), t('attendance.person'), t('attendance.role'), t('common.status'), t('attendance.planned'), t('attendance.first_in'), t('attendance.last_out'), t('attendance.hours'), t('attendance.late_minutes')],
      rows: b.rows.map((p) => [date, p.name, roleLabel(req, p), t(`attendance.st_${p.status}`), p.plan && p.plan !== 'off' ? `${p.plan.start}–${p.plan.end}` : '', p.firstIn || '', p.lastOut || '', p.worked ? Math.round((p.worked / 60) * 100) / 100 : '', p.lateMinutes || '']),
    });
  }
  // Records (shifts) of a month — also one person's timesheet.
  const [from, to] = svc.monthBounds(month);
  const rows = (await svc.records(req.ctx, { from, to, userId, roleId })).reverse();
  const how = (m) => (m ? t(`attendance.method_${m}`) : '');
  return exporter.send(req, res, {
    name: t('attendance.export_name'),
    header: [t('common.date'), t('attendance.person'), t('attendance.role'), t('attendance.clock_in'), t('attendance.clock_out'), t('attendance.hours'), t('attendance.in_how'), t('attendance.out_how'), t('attendance.correction_reason')],
    rows: rows.map((r) => [r.work_date, r.user_name, roleLabel(req, r), r.inTime, r.outTime || '', r.clock_out ? Math.round((r.minutes / 60) * 100) / 100 : '', how(r.in_method), how(r.out_method), r.correction_reason || '']),
  });
}));

// ---------------------------------------------------------------- corrections and added shifts (attendance.manage)
const back = (req) => (req.body._return && String(req.body._return).startsWith('/app/attendance') ? req.body._return : '/app/attendance');
/** Re-renders the page the manager came from with the dialog open and its messages. */
const rerenderFrom = (dialog, action) => async (req, res, extra) => {
  const url = new URL(back(req), 'http://x');
  req.query = Object.fromEntries(url.searchParams.entries());
  const more = { ...extra, openDialog: dialog, formAction: action(req) };
  const m = /^\/app\/attendance\/staff\/(\d+)/.exec(url.pathname);
  if (m) { req.params.id = m[1]; return renderStaff(req, res, more); }
  return render(req, res, more);
};
router.post('/records', can('attendance.manage'), form(async (req, res) => {
  await svc.addManual(req.ctx, req.body);
  flash(req, 'success', req.t('attendance.added'));
  res.redirect(back(req));
}, rerenderFrom('add-dialog', () => '/app/attendance/records')));
router.post('/records/:id(\\d+)', can('attendance.manage'), form(async (req, res) => {
  await svc.correct(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('attendance.corrected'));
  res.redirect(back(req));
}, rerenderFrom('correct-dialog', (req) => `/app/attendance/records/${Number(req.params.id)}`)));
router.post('/records/:id(\\d+)/delete', can('attendance.manage'), wrap(async (req, res) => {
  await svc.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('attendance.deleted'));
  res.redirect(back(req));
}));

// ---------------------------------------------------------------- working hours and rules (attendance.manage)
async function renderSettings(req, res, extra = {}) {
  const b = req.ctx.businessId;
  const [settings, own, allStaff, { planFor }] = await Promise.all([svc.settings(b), svc.schedules(b), svc.staff(b), svc.planner(b, req.ctx.today, req.ctx.today)]);
  const staff = allStaff.filter((s) => s.status === 'active').map((s) => {
    const week = {};
    // This week's plan per day, to show where each person's hours come from.
    for (let i = 0; i < 7; i += 1) { const d = svc.shiftDay(req.ctx.today, i); week[svc.DAY_KEYS[new Date(`${d}T00:00:00Z`).getUTCDay()]] = planFor(s.user_id, d); }
    const any = Object.values(week).find((p) => p && p !== 'off');
    return { ...s, own: own.get(s.user_id) || null, week, source: own.has(s.user_id) ? 'own' : any ? any.source : Object.values(week).some((p) => p === 'off') ? 'off' : null };
  });
  res.page('pages/attendance/settings', { title: req.t('attendance.hours_title'), settings, staff, roleLabel: (r) => roleLabel(req, r), pageStyles: STYLES, pageScripts: SCRIPTS, ...extra });
}
router.get('/settings', can('attendance.manage'), wrap((req, res) => renderSettings(req, res)));
router.post('/settings', can('attendance.manage'), form(async (req, res) => {
  const b = req.body;
  if (b.section === 'hours') {
    await svc.saveSettings(req.ctx, { workStart: b.work_start, workEnd: b.work_end, workDays: b.work_days, grace: b.late_grace_minutes });
    flash(req, 'success', req.t('common.saved'));
    return res.redirect('/app/attendance/settings');
  }
  await svc.saveSettings(req.ctx, { qrOnly: b.qr_only === '1', ...(b.section === 'rules' ? { sameNetwork: b.same_network === '1' } : {}) });
  flash(req, 'success', req.t('common.saved'));
  return res.redirect('/app/attendance/screens');
}, (req, res, extra) => renderSettings(req, res, extra)));
router.post('/settings/staff/:id(\\d+)', can('attendance.manage'), form(async (req, res) => {
  await svc.saveSchedule(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('attendance.schedule_saved'));
  res.redirect('/app/attendance/settings');
}, (req, res, extra) => renderSettings(req, res, { ...extra, openDialog: 'schedule-dialog', formAction: `/app/attendance/settings/staff/${Number(req.params.id)}` })));
router.post('/settings/staff/:id(\\d+)/delete', can('attendance.manage'), wrap(async (req, res) => {
  await svc.removeSchedule(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('attendance.schedule_removed'));
  res.redirect('/app/attendance/settings');
}));

// ---------------------------------------------------------------- door screens (attendance.manage)
async function renderScreens(req, res, extra = {}) {
  const reach = phoneBase(req);
  const list = (await kiosks.list(req.ctx.businessId)).map((k) => ({ ...k, url: kiosks.displayUrl(k, reach.base) }));
  res.page('pages/attendance/screens', { title: req.t('attendance.screens_title'), list, reach, settings: await svc.settings(req.ctx.businessId), pageStyles: STYLES, pageScripts: SCRIPTS, ...extra });
}
router.get('/screens', can('attendance.manage'), wrap((req, res) => renderScreens(req, res)));
router.get('/kiosk/setup', can('attendance.manage'), (req, res) => res.redirect('/app/attendance/screens'));
router.post('/screens', can('attendance.manage'), form(async (req, res) => {
  await kiosks.create(req.ctx, req.body);
  flash(req, 'success', req.t('attendance.screen_created'));
  res.redirect('/app/attendance/screens');
}, renderScreens));
router.get('/screens/:id(\\d+)/open', can('attendance.manage'), wrap(async (req, res) => {
  const url = kiosks.displayUrl(await kiosks.get(req.ctx, Number(req.params.id)), phoneBase(req).base);
  if (!url) throw E.notFound('Screen');
  res.redirect(url);
}));
router.post('/screens/:id(\\d+)', can('attendance.manage'), form(async (req, res) => {
  await kiosks.update(req.ctx, Number(req.params.id), { name: req.body.name, is_active: req.body.is_active === '1' });
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/attendance/screens');
}, renderScreens));
router.post('/screens/:id(\\d+)/regenerate', can('attendance.manage'), wrap(async (req, res) => {
  await kiosks.regenerate(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('attendance.screen_regenerated'));
  res.redirect('/app/attendance/screens');
}));
router.post('/screens/:id(\\d+)/delete', can('attendance.manage'), wrap(async (req, res) => {
  await kiosks.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('attendance.screen_deleted'));
  res.redirect('/app/attendance/screens');
}));

// The same full-screen page opened from a manager's own session (preview, or a PC that stays signed in).
router.get('/kiosk', can('attendance.manage'), wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const reach = phoneBase(req); // phones cannot open "localhost": use the network address when needed
  const [qr, feed] = await Promise.all([svc.currentQr(req.ctx.businessId, reach.base), svc.feed(req.ctx.businessId, req.ctx.timezone)]);
  const b = req.business;
  res.page('pages/attendance/kiosk', {
    layout: 'kiosk', title: req.t('attendance.kiosk_title'), qr, reach, feed, src: '/app/attendance/kiosk/qr', exitHref: '/app/attendance/screens', screenName: null,
    clinic: { name: b.name, timezone: b.timezone, logoUrl: b.logo_mime ? `/app/logo/${b.id}?v=${b.logo_version}` : null }, pageStyles: STYLES, pageScripts: SCRIPTS,
  });
}));
router.get('/kiosk/qr', can('attendance.manage'), wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const [q, feed] = await Promise.all([svc.currentQr(req.ctx.businessId, phoneBase(req).base), svc.feed(req.ctx.businessId, req.ctx.timezone)]);
  res.json({ data: { svg: q.svg, expiresIn: q.expiresIn, step: q.stepSeconds, feed } });
}));

// ---------------------------------------------------------------- scan (phone camera → one tap)
const scanPage = async (req, res, data = {}) => {
  let today = null;
  if (!data.failed) {
    // The person's plan for today, shown under the button and on the confirmation.
    const { planFor, settings: set } = await svc.planner(req.ctx.businessId, req.ctx.today, req.ctx.today);
    today = { plan: planFor(req.ctx.userId, req.ctx.today), grace: set.grace };
  }
  return res.page('pages/attendance/scan', { layout: 'kiosk', kioskClass: 'scan-body', title: req.t('attendance.scan_title'), today, pageStyles: STYLES, pageScripts: SCRIPTS, ...data });
};
const failScan = (req, res, e) => { res.status(e.status || 400); return scanPage(req, res, { failed: errText(req, e) }); };
const ticketOk = (req) => {
  const tk = req.session.attTicket;
  return tk && tk.b === req.ctx.businessId && Date.now() - tk.at < svc.TICKET_MS;
};
const save = (req) => new Promise((resolve, reject) => { req.session.save((err) => (err ? reject(err) : resolve())); });
/** Same-network rule: { off } for the record, or throws when the clinic accepts scans only from its network. */
async function network(req, businessId) {
  const [set, net] = await Promise.all([svc.settings(businessId), kiosks.networkCheck(businessId, req.ip)]);
  if (!net.same && set.sameNetwork) throw new AppError('QR_NETWORK', 'Connect your phone to the clinic Wi-Fi and scan again.', 403);
  return { off: !net.same };
}

router.get('/scan', wrap(async (req, res) => {
  const pending = req.session.pendingScan;
  if (pending) {
    // A valid code was scanned just before signing in (see requireAuth): turn it into the usual ticket.
    delete req.session.pendingScan;
    if (Date.now() - pending.at < svc.TICKET_MS && (pending.b === req.ctx.businessId || await businesses.isMember(req.user.id, pending.b))) {
      let off = false;
      try { ({ off } = await network(req, pending.b)); } catch (e) { await save(req); return failScan(req, res, e); }
      if (pending.b !== req.ctx.businessId) req.session.businessId = pending.b;
      req.session.attTicket = { b: pending.b, at: pending.at, off };
      delete req.session.attDone;
      await save(req);
      if (pending.b !== req.ctx.businessId) return res.redirect('/app/attendance/scan');
    }
  }
  if (req.query.t !== undefined) {
    let tok;
    let off = false;
    try {
      tok = svc.verifyToken(req.query.t);
      if (tok.businessId === req.ctx.businessId) ({ off } = await network(req, tok.businessId));
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      return failScan(req, res, e);
    }
    if (tok.businessId !== req.ctx.businessId) {
      // The code belongs to another clinic: only its own active staff may use it (then that clinic opens).
      const other = await businesses.get(tok.businessId);
      if (!other || (other.status || 'active') !== 'active' || !(await businesses.isMember(req.user.id, tok.businessId))) {
        return failScan(req, res, new AppError('ATTENDANCE_OTHER_CLINIC', 'This code belongs to a clinic your account does not work at.', 403));
      }
      try { ({ off } = await network(req, tok.businessId)); } catch (e) { return failScan(req, res, e); }
      req.session.businessId = tok.businessId;
    }
    req.session.attTicket = { b: tok.businessId, at: Date.now(), off };
    delete req.session.attDone;
    await save(req);
    return res.redirect('/app/attendance/scan');
  }
  const done = req.session.attDone;
  if (done && done.b === req.ctx.businessId && Date.now() - done.ts < 10 * 60_000 && !ticketOk(req)) return scanPage(req, res, { done });
  if (!ticketOk(req)) return failScan(req, res, new AppError('QR_EXPIRED', 'This code has changed. Scan the code currently on the screen.', 410));
  const open = await svc.openShift(req.ctx.businessId, req.ctx.userId);
  return scanPage(req, res, { open, openSince: open ? svc.localTime(req.ctx.timezone, open.clock_in) : null });
}));

router.post('/scan', wrap(async (req, res) => {
  if (!ticketOk(req)) return failScan(req, res, new AppError('QR_EXPIRED', 'This code has changed. Scan the code currently on the screen.', 410));
  let r;
  try {
    r = await svc.toggle(req.ctx, { method: 'qr', expect: req.body.expect, offNetwork: Boolean(req.session.attTicket.off) });
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500) throw e;
    if (e.code === 'ATTENDANCE_ALREADY_IN' || e.code === 'ATTENDANCE_ALREADY_OUT') {
      const open = await svc.openShift(req.ctx.businessId, req.ctx.userId);
      return scanPage(req, res, { open, openSince: open ? svc.localTime(req.ctx.timezone, open.clock_in) : null, notice: errText(req, e) });
    }
    return failScan(req, res, e);
  }
  delete req.session.attTicket;
  req.session.attDone = { b: req.ctx.businessId, action: r.action, time: svc.localTime(req.ctx.timezone, r.at), minutes: r.minutes, ts: Date.now() };
  await save(req);
  return res.redirect('/app/attendance/scan');
}));

module.exports = router;
