// Staff attendance (/app/attendance).
//  • everyone (every active member): own month + clock in/out button (unless the clinic records by QR only)
//  • /kiosk (attendance.manage): the full-screen attendance screen with a QR code that changes every 10 seconds
//  • /scan?t=… (every member): opened by the phone camera; one tap to clock in or out
//  • team view (attendance.view): by day or month with per-person totals, filters and export (data.export)
//  • corrections and deletions (attendance.manage): reason required, audited
const express = require('express');
const { phoneBase } = require('../../middleware/web');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const exporter = require('../../core/exporter');
const businesses = require('../businesses/business.service');
const svc = require('./attendance.service');

const router = express.Router();
const STYLES = ['/css/attendance.css'];
const SCRIPTS = ['/js/attendance.js'];

const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const shiftDate = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
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

// ---------------------------------------------------------------- main page
async function render(req, res, extra = {}) {
  const { ctx } = req;
  const today = ctx.today;
  const canView = ctx.permissions.has('attendance.view');
  const view = canView && req.query.view === 'team' ? 'team' : 'me';
  const month = isMonth(req.query.month) && req.query.month <= today.slice(0, 7) ? req.query.month : today.slice(0, 7);
  const [settings, open, allStaff] = await Promise.all([svc.settings(ctx.businessId), svc.openShift(ctx.businessId, ctx.userId), svc.staff(ctx.businessId)]);
  const data = {
    title: req.t('attendance.title'), view, month, months: recentMonths(today), settings, open, openSince: open ? svc.localTime(ctx.timezone, open.clock_in) : null,
    roleLabel: (r) => roleLabel(req, r), pageStyles: STYLES, pageScripts: SCRIPTS, printable: true,
  };
  if (view === 'me') {
    data.mine = await svc.myMonth(ctx, month);
  } else {
    const mode = req.query.mode === 'month' ? 'month' : 'day';
    const date = isDate(req.query.date) && req.query.date <= today ? req.query.date : today;
    const userId = /^\d+$/.test(String(req.query.user || '')) ? Number(req.query.user) : null;
    const roleId = /^\d+$/.test(String(req.query.role || '')) ? Number(req.query.role) : null;
    const [from, to] = mode === 'day' ? [date, date] : svc.monthBounds(month);
    const rows = await svc.records(ctx, { from, to, userId, roleId });
    const people = svc.totalsByPerson(rows);
    const roles = [];
    allStaff.forEach((s) => { if (!roles.some((r) => r.role_id === s.role_id)) roles.push({ role_id: s.role_id, label: roleLabel(req, s) }); });
    // Day view: active staff (matching the filters) without any record that day.
    const noRecord = mode === 'day' ? allStaff.filter((s) => s.status === 'active' && (!userId || s.user_id === userId) && (!roleId || s.role_id === roleId) && !people.some((p) => p.user_id === s.user_id)) : [];
    Object.assign(data, {
      mode, date, prevDate: shiftDate(date, -1), nextDate: date < today ? shiftDate(date, 1) : null, userId, roleId, rows, people, noRecord,
      staffOptions: allStaff, roles, filtered: Boolean(userId || roleId),
      totals: { minutes: people.reduce((s, p) => s + p.minutes, 0), people: people.length, open: people.filter((p) => p.open).length },
    });
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
  res.redirect('/app/attendance');
}));

// ---------------------------------------------------------------- export (team view, same filters)
router.get('/export', can('attendance.view'), can('data.export'), wrap(async (req, res) => {
  const today = req.ctx.today;
  const mode = req.query.mode === 'month' ? 'month' : 'day';
  const month = isMonth(req.query.month) ? req.query.month : today.slice(0, 7);
  const date = isDate(req.query.date) ? req.query.date : today;
  const [from, to] = mode === 'day' ? [date, date] : svc.monthBounds(month);
  const rows = (await svc.records(req.ctx, {
    from, to, userId: /^\d+$/.test(String(req.query.user || '')) ? req.query.user : null, roleId: /^\d+$/.test(String(req.query.role || '')) ? req.query.role : null,
  })).reverse();
  const t = req.t;
  const how = (m) => (m ? t(`attendance.method_${m}`) : '');
  exporter.send(req, res, {
    name: t('attendance.export_name'),
    header: [t('common.date'), t('attendance.person'), t('attendance.role'), t('attendance.clock_in'), t('attendance.clock_out'), t('attendance.hours'), t('attendance.in_how'), t('attendance.out_how'), t('attendance.correction_reason')],
    rows: rows.map((r) => [r.work_date, r.user_name, roleLabel(req, r), r.inTime, r.outTime || '', r.clock_out ? Math.round((r.minutes / 60) * 100) / 100 : '', how(r.in_method), how(r.out_method), r.correction_reason || '']),
  });
}));

// ---------------------------------------------------------------- corrections (attendance.manage)
const back = (req) => (req.body._return && String(req.body._return).startsWith('/app/attendance') ? req.body._return : '/app/attendance?view=team');
router.post('/records/:id(\\d+)', can('attendance.manage'), form(async (req, res) => {
  await svc.correct(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('attendance.corrected'));
  res.redirect(back(req));
}, async (req, res, extra) => {
  // Re-open the correction dialog with the messages, on the page the manager came from.
  const url = new URL(back(req), 'http://x');
  req.query = Object.fromEntries(url.searchParams.entries());
  return render(req, res, { ...extra, openDialog: 'correct-dialog', formAction: `/app/attendance/records/${Number(req.params.id)}` });
}));
router.post('/records/:id(\\d+)/delete', can('attendance.manage'), wrap(async (req, res) => {
  await svc.remove(req.ctx, Number(req.params.id));
  flash(req, 'success', req.t('attendance.deleted'));
  res.redirect(back(req));
}));
router.post('/settings', can('attendance.manage'), wrap(async (req, res) => {
  await svc.saveSettings(req.ctx, { qrOnly: req.body.qr_only === '1' });
  flash(req, 'success', req.t('common.saved'));
  res.redirect('/app/attendance/kiosk/setup');
}));

// ---------------------------------------------------------------- attendance screen (kiosk)
router.get('/kiosk/setup', can('attendance.manage'), wrap(async (req, res) => {
  res.page('pages/attendance/setup', {
    title: req.t('attendance.kiosk_title'), settings: await svc.settings(req.ctx.businessId), kioskUrl: `${phoneBase(req).base}/app/attendance/kiosk`, reach: phoneBase(req), pageStyles: STYLES, pageScripts: SCRIPTS,
  });
}));
router.get('/kiosk', can('attendance.manage'), wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const reach = phoneBase(req); // phones cannot open "localhost": use the network address when needed
  const qr = await svc.currentQr(req.ctx.businessId, reach.base);
  res.page('pages/attendance/kiosk', { layout: 'kiosk', title: req.t('attendance.kiosk_title'), qr, reach, pageStyles: STYLES, pageScripts: SCRIPTS });
}));
router.get('/kiosk/qr', can('attendance.manage'), wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const q = await svc.currentQr(req.ctx.businessId, phoneBase(req).base);
  res.json({ data: { svg: q.svg, expiresIn: q.expiresIn, step: q.stepSeconds } });
}));

// ---------------------------------------------------------------- scan (phone camera → one tap)
const scanPage = (req, res, data = {}) => res.page('pages/attendance/scan', { layout: 'kiosk', kioskClass: 'scan-body', title: req.t('attendance.scan_title'), pageStyles: STYLES, pageScripts: SCRIPTS, ...data });
const failScan = (req, res, e) => { res.status(e.status || 400); return scanPage(req, res, { failed: errText(req, e) }); };
const ticketOk = (req) => {
  const tk = req.session.attTicket;
  return tk && tk.b === req.ctx.businessId && Date.now() - tk.at < svc.TICKET_MS;
};
const save = (req) => new Promise((resolve, reject) => { req.session.save((err) => (err ? reject(err) : resolve())); });

router.get('/scan', wrap(async (req, res) => {
  const pending = req.session.pendingScan;
  if (pending) {
    // A valid code was scanned just before signing in (see requireAuth): turn it into the usual ticket.
    delete req.session.pendingScan;
    if (Date.now() - pending.at < svc.TICKET_MS && (pending.b === req.ctx.businessId || await businesses.isMember(req.user.id, pending.b))) {
      if (pending.b !== req.ctx.businessId) req.session.businessId = pending.b;
      req.session.attTicket = { b: pending.b, at: pending.at };
      delete req.session.attDone;
      await save(req);
      if (pending.b !== req.ctx.businessId) return res.redirect('/app/attendance/scan');
    }
  }
  if (req.query.t !== undefined) {
    let tok;
    try {
      tok = svc.verifyToken(req.query.t);
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
      req.session.businessId = tok.businessId;
    }
    req.session.attTicket = { b: tok.businessId, at: Date.now() };
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
    r = await svc.toggle(req.ctx, { method: 'qr', expect: req.body.expect });
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
