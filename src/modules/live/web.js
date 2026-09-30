// Live agenda updates (server-sent events) and calendar import / subscription (worker: live).
// Mounted at '/' inside /app, so every path here is a full sub-path of /app.
//   GET  /live/events                                   SSE: "appointments" events when the clinic's agenda changes
//   GET  /appointments/import-calendar                  step 1 — .ics file or private iCal address, range, doctor mapping
//   POST /appointments/import                           step 2 — preview (multipart: the file)
//   POST /appointments/import-calendar/confirm          step 3 — import the selected rows, summary
//   GET  /appointments/calendar-feed                    a doctor's private iCal subscription (on / rotate / off)
const express = require('express');
const multer = require('multer');
const { wrap, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { verifyCsrfAfterUpload } = require('../../middleware/web');
const { AppError, E } = require('../../core/errors');
const scheduling = require('../clinic/scheduling');
const feed = require('./feed');
const importer = require('./import.service');
const ical = require('./ical');
const feeds = require('./feeds');

const router = express.Router();
const ASSETS = { pageScripts: ['/js/appointments.js'], pageStyles: ['/css/appointments.css', '/css/live.css'] };

const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const pickDate = (v, fallback) => (scheduling.isDate(v) ? v : fallback);
const errText = (req, e) => {
  for (const k of [`errors_live.${e.code}`, `errors.${e.code}`]) { const s = req.t(k); if (s !== k) return s; }
  return e.message;
};

// ---------------------------------------------------------------- live events (SSE)
router.get('/live/events', canAny('appointments.view', 'frontdesk.use'), (req, res) => {
  const { ctx } = req;
  const ok = feed.subscribe({ businessId: ctx.businessId, userId: ctx.userId, timezone: ctx.timezone, doctorId: ctx.ownDoctorId || null }, res);
  if (!ok) return res.status(429).set('Retry-After', '60').type('text/plain').send('Too many live connections');
  // no-transform keeps the compression middleware (and proxies) from buffering the stream; X-Accel-Buffering for nginx.
  res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  if (req.socket) { req.socket.setTimeout(0); req.socket.setNoDelay(true); req.socket.setKeepAlive(true); }
  res.flushHeaders();
  const texts = { updated: req.t('live.updated'), checked_in: req.t('live.checked_in'), with_doctor: req.t('live.with_doctor'), live_on: req.t('live.indicator_on'), live_off: req.t('live.indicator_off'), close: req.t('common.close') };
  res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ poll: feed.POLL_MS, today: ctx.today, doctorId: ctx.ownDoctorId || null, texts })}\n\n`);
  if (typeof res.flush === 'function') res.flush();
  return undefined;
});

// ---------------------------------------------------------------- calendar import
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: importer.MAX_BYTES, files: 1, fields: 80 } });
const icsUpload = (req, res, next) => upload.single('ics')(req, res, (err) => {
  if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'CAL_TOO_BIG' : 'CAL_NOT_ICS';
  next();
});

async function doctorsFor(req) {
  const rows = await require('../clinic/doctors.service').listActive(req.ctx); // eslint-disable-line global-require
  return req.ctx.ownDoctorId ? rows.filter((d) => d.id === req.ctx.ownDoctorId) : rows;
}

async function renderImport(req, res, extra = {}) {
  const today = req.ctx.today;
  const doctors = await doctorsFor(req);
  const b = extra.old || {};
  const v = {
    source: b.source === 'url' ? 'url' : 'file', url: b.url || '', from: pickDate(b.from, today), to: pickDate(b.to, addDays(today, 90)),
    doctor_mode: b.doctor_mode === 'keyword' ? 'keyword' : 'one', doctor_id: Number(b.doctor_id) || (doctors[0] && doctors[0].id) || '', fallback_doctor_id: Number(b.fallback_doctor_id) || '',
  };
  const kw = {};
  doctors.forEach((d) => { kw[d.id] = b[`kw_${d.id}`] !== undefined ? b[`kw_${d.id}`] : [d.full_name, d.full_name_en].filter(Boolean).join(', '); });
  res.page('pages/clinic/appointments/import', {
    title: req.t('calimport.title'), step: 'source', doctors, v, kw, ...ASSETS, ...extra,
  });
}

router.get('/appointments/import-calendar', can('appointments.manage'), wrap((req, res) => renderImport(req, res)));

router.post('/appointments/import', can('appointments.manage'), icsUpload, verifyCsrfAfterUpload, wrap(async (req, res) => {
  const { ctx } = req;
  const b = req.body || {};
  const today = ctx.today;
  const from = pickDate(b.from, today);
  let to = pickDate(b.to, addDays(from, 90));
  if (to < from) to = from;
  if (to > addDays(from, 366)) to = addDays(from, 366);
  try {
    if (req.uploadError) throw new AppError(req.uploadError, req.uploadError, 422);
    const sourceKind = b.source === 'url' ? 'url' : 'file';
    const text = await importer.readSource(sourceKind === 'url' ? { url: b.url } : { file: req.file });
    const cal = ical.parse(text);
    const occ = ical.expand(cal, { from, to, timezone: ctx.timezone });
    const doctorMode = b.doctor_mode === 'keyword' ? 'keyword' : 'one';
    const keywords = {};
    Object.keys(b).forEach((k) => { const m = k.match(/^kw_(\d+)$/); if (m) keywords[m[1]] = String(b[k]).slice(0, 300); });
    const p = await importer.plan(ctx, occ, { from, to, doctorMode, doctorId: b.doctor_id, keywords, fallbackDoctorId: b.fallback_doctor_id });
    return res.page('pages/clinic/appointments/import', {
      title: req.t('calimport.preview_title'), step: 'preview', plan: p, calName: cal.name, from, to, sourceKind, doctors: p.doctors,
      rowsJson: JSON.stringify(p.rows.map((r) => ({ k: r.key, d: r.date, t: r.time, m: r.minutes, n: r.name, p: r.phone, pid: r.patientId, x: r.notes }))), ...ASSETS,
    });
  } catch (e) {
    if (!(e instanceof AppError) || e.status >= 500 && e.status !== 502) throw e;
    res.status(422);
    return renderImport(req, res, { old: { ...b, from, to }, formError: { code: e.code, message: errText(req, e) } });
  }
}));

router.post('/appointments/import-calendar/confirm', can('appointments.manage'), wrap(async (req, res) => {
  const b = req.body || {};
  let rows;
  try { rows = JSON.parse(String(b.rows_json || '[]')); } catch { rows = null; }
  if (!Array.isArray(rows) || rows.length > importer.MAX_ROWS) throw E.validation({ _: 'Choose a valid value.' });
  const sel = [].concat(b.sel || []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < rows.length);
  const chosen = [...new Set(sel)].sort((x, y) => x - y).map((i) => {
    const r = rows[i] || {};
    return { i, key: String(r.k || '').slice(0, 400), date: String(r.d || ''), time: String(r.t || ''), minutes: Number(r.m) || null, name: String(r.n || '').slice(0, 190),
      phone: String(r.p || '').slice(0, 40), patientId: Number(r.pid) || null, notes: String(r.x || '').slice(0, 3000), doctorId: Number(b[`doc_${i}`]) || null };
  }).filter((r) => r.key);
  if (!chosen.length) {
    flash(req, 'error', req.t('calimport.nothing_selected'));
    return res.redirect('/app/appointments/import-calendar');
  }
  const result = await importer.commit(req.ctx, chosen, { allowOutsideHours: b.allow_outside === '1', sourceKind: b.source_kind === 'url' ? 'url' : 'file' });
  if (result.imported) flash(req, 'success', req.t('calimport.done_flash', { n: result.imported }));
  const firstDate = chosen.filter((r) => !result.skipped.some((s) => s.row === r)).map((r) => r.date).sort()[0] || null;
  return res.page('pages/clinic/appointments/import', { title: req.t('calimport.result_title'), step: 'result', result, firstDate, doctors: await doctorsFor(req), ...ASSETS });
}));

// ---------------------------------------------------------------- a doctor's calendar subscription
/** Doctors whose feed the current user may manage: their own (linked doctor), or all with doctors.manage. */
async function feedDoctors(req) {
  const all = await require('../clinic/doctors.service').listActive(req.ctx); // eslint-disable-line global-require
  if (req.ctx.permissions.has('doctors.manage')) return all;
  return all.filter((d) => d.id === req.ctx.doctorId);
}

router.get('/appointments/calendar-feed', can('appointments.view'), wrap(async (req, res) => {
  const doctors = await feedDoctors(req);
  const map = await feeds.forBusiness(req.ctx.businessId);
  const base = res.locals.baseUrl || `${req.protocol}://${req.get('host')}`;
  const rows = doctors.map((d) => {
    const f = map.get(d.id);
    const url = f && f.token ? `${base}/calendar/${f.token}.ics` : null;
    // fmt.date formats in UTC: pass the clinic's wall-clock time as a UTC instant.
    let lastUsed = null;
    if (f && f.last_used_at) { const w = ical.wallOf(new Date(f.last_used_at).getTime(), req.ctx.timezone || 'UTC'); lastUsed = new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi)); }
    return { doctor: d, on: Boolean(f), url, webcal: url ? url.replace(/^https?:\/\//, 'webcal://') : null, lastUsed };
  });
  res.page('pages/clinic/appointments/calendar-feed', { title: req.t('live.feed_title'), rows, ...ASSETS });
}));

router.post('/appointments/calendar-feed/:doctorId(\\d+)/:action(enable|rotate|disable)', can('appointments.view'), wrap(async (req, res) => {
  const doctorId = Number(req.params.doctorId);
  if (!(await feedDoctors(req)).some((d) => d.id === doctorId)) throw E.forbidden('doctors.manage');
  if (req.params.action === 'disable') { await feeds.disable(req.ctx, doctorId); flash(req, 'success', req.t('live.feed_disabled')); } else {
    await feeds.enable(req.ctx, doctorId, req.locale);
    flash(req, 'success', req.t(req.params.action === 'rotate' ? 'live.feed_rotated' : 'live.feed_enabled'));
  }
  res.redirect('/app/appointments/calendar-feed');
}));

module.exports = router;
