// Salaries out of the clinic (payroll.view to look, payroll.manage to act):
//   GET  /bank                          the month's transfer: payees grouped by bank, download or e-mail each file
//   POST /bank/make                     build one bank's file (download / e-mail), optionally mark the payees paid
//   GET  /bank/templates                the clinic's bank file layouts; /new, /:id to edit; POST to save / delete
//   POST /bank/templates/preset         start from a ready layout
//   POST /slips/staff/:lineId           e-mail one staff payslip (PDF)
//   POST /slips/doctor/:id              e-mail one doctor's payslip for ?period
//   POST /slips/all                     e-mail every paid payslip of the month not sent yet
const express = require('express');
const { wrap, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { translateMessage } = require('../../core/i18n');
const bank = require('./bank.service');
const slips = require('./payslips.service');

const router = express.Router();
router.use(can('payroll.view'));
const manage = can('payroll.manage');

const isMonth = (p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));
const periodOf = (req) => [req.query.period, req.body && req.body.period].find(isMonth) || req.ctx.today.slice(0, 7);
function shift(period, n) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const safe = (v, fallback) => (typeof v === 'string' && /^\/app\/[\w\-/?=&.%]*$/.test(v) && !v.startsWith('//') ? v : fallback);
const errText = (req, err) => {
  for (const k of [`payouts.err.${err.code}`, `errors.${err.code}`]) { const tr = req.t(k); if (tr !== k) return tr; }
  if (err.code === 'VALIDATION_FAILED') return `${req.t('errors.VALIDATION_FAILED')} ${Object.values(err.details || {}).map((v) => translateMessage(req.locale, v)).join(' ')}`;
  return err.message;
};
/** A POST whose expected errors become a toast and a redirect back. */
const act = (fn, back) => wrap(async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (!(err instanceof AppError) || (err.status >= 500 && err.code !== 'MAIL_FAILED') || err.status === 403) throw err;
    flash(req, 'error', errText(req, err));
    return res.redirect(back(req));
  }
  return undefined;
});
const lang = (req) => (['ar', 'en'].includes(req.body.lang_msg) ? req.body.lang_msg : req.locale);

// ================================================================ BANK TRANSFER
router.get('/bank', wrap(async (req, res) => {
  const period = periodOf(req);
  const [templates, people, log] = await Promise.all([bank.list(req.ctx), bank.payees(req.ctx, period), bank.history(req.ctx)]);
  const groups = templates.length ? bank.groups(templates, people) : [];
  res.page('pages/payouts/bank', {
    title: req.t('payouts.bank_title'), period, prevPeriod: shift(period, -1), nextPeriod: shift(period, 1), templates, people, groups, log,
    total: people.reduce((s, p) => s + p.amount, 0), pageStyles: ['/css/finance.css'], pageScripts: ['/js/payouts.js'],
  });
}));

router.post('/bank/make', manage, act(async (req, res) => {
  const period = periodOf(req);
  const r = await bank.make(req.ctx, {
    templateId: req.body.template_id, period, keys: req.body.p, action: req.body.action === 'email' ? 'email' : 'download', to: req.body.to,
    markPaid: req.body.mark_paid === '1', valueDate: req.body.value_date, locale: lang(req), t: req.t,
  });
  if (r.sentTo) {
    flash(req, 'success', req.t('payouts.bank_emailed', { to: r.sentTo, n: r.count }) + (r.marked ? ` ${req.t('payouts.marked', { n: r.marked })}` : ''));
    return res.redirect(`/app/payouts/bank?period=${period}`);
  }
  res.set('Content-Type', r.file.mime);
  res.set('Content-Disposition', `attachment; filename="${r.file.filename}"`);
  res.set('Cache-Control', 'private, no-store');
  return res.send(r.file.buffer);
}, (req) => `/app/payouts/bank?period=${periodOf(req)}`));

// ---------------------------------------------------------------- templates
router.get('/bank/templates', wrap(async (req, res) => {
  res.page('pages/payouts/templates', { title: req.t('payouts.templates_title'), templates: await bank.list(req.ctx), pageStyles: ['/css/finance.css'] });
}));
const renderForm = async (req, res, tpl, extra = {}) => res.page('pages/payouts/template-form', {
  title: tpl ? tpl.name : req.t('payouts.new_template'), tpl, fields: bank.FIELDS, formats: bank.FORMATS, delimiters: Object.keys(bank.DELIMITERS), dateFormats: bank.DATE_FORMATS,
  delimiterKey: tpl ? Object.keys(bank.DELIMITERS).find((k) => bank.DELIMITERS[k] === tpl.delimiter) || 'comma' : 'comma',
  pageStyles: ['/css/finance.css'], pageScripts: ['/js/payouts.js'], ...extra,
});
router.get('/bank/templates/new', manage, wrap((req, res) => renderForm(req, res, null)));
router.get('/bank/templates/:id(\\d+)', manage, wrap(async (req, res) => renderForm(req, res, await bank.get(req.ctx, req.params.id))));

const saveTpl = (id) => wrap(async (req, res) => {
  try {
    await bank.save(req.ctx, id, req.body);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'VALIDATION_FAILED') throw err;
    res.status(422);
    const errors = Object.fromEntries(Object.entries(err.details || {}).map(([k, v]) => [k, translateMessage(req.locale, v)]));
    const draft = { ...(id ? await bank.get(req.ctx, id) : {}), id: id || null, name: req.body.name, columns: [].concat(req.body.col_field || []).map((f, i) => ({ field: f, label: [].concat(req.body.col_label || [])[i] || '', value: [].concat(req.body.col_value || [])[i] || '' })) };
    return renderForm(req, res, id ? draft : null, { errors, old: req.body, formError: { message: req.t('errors.VALIDATION_FAILED') }, draftCols: draft.columns });
  }
  flash(req, 'success', req.t('payouts.template_saved'));
  return res.redirect('/app/payouts/bank/templates');
});
router.post('/bank/templates', manage, saveTpl(null));
router.post('/bank/templates/:id(\\d+)', manage, (req, res, next) => saveTpl(Number(req.params.id))(req, res, next));
router.post('/bank/templates/:id(\\d+)/delete', manage, act(async (req, res) => {
  await bank.remove(req.ctx, req.params.id);
  flash(req, 'success', req.t('common.deleted'));
  res.redirect('/app/payouts/bank/templates');
}, () => '/app/payouts/bank/templates'));
router.post('/bank/templates/preset', manage, act(async (req, res) => {
  await bank.fromPreset(req.ctx, req.body.preset, req.t);
  flash(req, 'success', req.t('payouts.template_saved'));
  res.redirect(safe(req.body._return, '/app/payouts/bank/templates'));
}, (req) => safe(req.body._return, '/app/payouts/bank/templates')));

// ================================================================ PAYSLIPS BY E-MAIL
router.post('/slips/staff/:id(\\d+)', manage, act(async (req, res) => {
  const to = await slips.sendStaff(req.ctx, Number(req.params.id), { locale: lang(req), to: req.body.to });
  flash(req, 'success', req.t('payouts.slip_sent', { to }));
  res.redirect(safe(req.body._return, '/app/staff-payroll'));
}, (req) => safe(req.body._return, '/app/staff-payroll')));

router.post('/slips/doctor/:id(\\d+)', manage, act(async (req, res) => {
  const period = periodOf(req);
  const to = await slips.sendDoctor(req.ctx, Number(req.params.id), period, { locale: lang(req), to: req.body.to });
  flash(req, 'success', req.t('payouts.slip_sent', { to }));
  res.redirect(safe(req.body._return, `/app/payroll/doctors/${req.params.id}/payslip?period=${period}`));
}, (req) => safe(req.body._return, `/app/payroll/doctors/${req.params.id}/payslip?period=${periodOf(req)}`)));

router.post('/slips/all', manage, act(async (req, res) => {
  const period = periodOf(req);
  const r = await slips.sendAll(req.ctx, period, { locale: lang(req), again: req.body.again === '1' });
  const parts = [req.t('payouts.slips_sent', { n: r.sent })];
  if (r.noEmail.length) parts.push(req.t('payouts.slips_no_email', { names: r.noEmail.join('، ') }));
  if (r.failed.length) parts.push(req.t('payouts.slips_failed', { names: r.failed.join('، ') }));
  flash(req, r.sent || !(r.noEmail.length + r.failed.length) ? 'success' : 'error', parts.join(' '));
  res.redirect(safe(req.body._return, `/app/staff-payroll?period=${period}`));
}, (req) => safe(req.body._return, `/app/staff-payroll?period=${periodOf(req)}`)));

module.exports = router;
