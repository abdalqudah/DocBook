// Clinic side of the medical documents: /app/certificates (list, issue form, document page / print, revoke, export)
// and the data for the "Documents" panel on the visit page (/app/visits/:id — loaded here into res.locals.certPanel
// so the visit router does not need to know about documents).
// Mounted at /app (one line in routes/app.js, before /visits).
const express = require('express');
const knex = require('../../db/knex');
const { wrap, form, flash } = require('../../routes/helpers');
const { can } = require('../../middleware/context');
const { phoneBase } = require('../../middleware/web');
const { translator } = require('../../core/i18n');
const fmt = require('../../core/format');
const exporter = require('../../core/exporter');
const { E } = require('../../core/errors');
const svc = require('./certificates.service');

const router = express.Router();
const ASSETS = { pageStyles: ['/css/certs.css'], pageScripts: ['/js/certs.js'] };

// ---------------------------------------------------------------- visit page panel data
router.get('/visits/:id(\\d+)', wrap(async (req, res, next) => {
  const perms = req.ctx.permissions;
  if (perms.has('certificates.view')) {
    const id = Number(req.params.id);
    const a = await knex('appointments').where({ id, business_id: req.ctx.businessId }).first('id', 'status', 'appointment_date', 'appointment_type', 'doctor_id');
    if (a && (!req.ctx.ownDoctorId || a.doctor_id === req.ctx.ownDoctorId)) {
      const canIssue = perms.has('certificates.issue') && a.appointment_type !== 'blocked' && !['cancelled', 'no_show'].includes(a.status) && a.appointment_date <= req.ctx.today;
      res.locals.certPanel = { docs: await svc.forVisit(req.ctx, id), canIssue, visitId: id, types: svc.TYPES };
    }
  }
  next();
}));

// ---------------------------------------------------------------- helpers
/** Date and 'HH:MM' of a timestamp in the clinic's time zone. */
function localParts(tz, d) {
  if (!d) return { date: null, time: null };
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

/** Translator + formatters in the document's own language (the page chrome stays in the user's language). */
function docTools(lang) {
  const dt = translator(lang);
  const days = (n) => {
    const k = n === 1 ? 'day_1' : n === 2 ? 'day_2' : n <= 10 ? 'day_few' : 'day_many';
    return dt(`certificates.doc.${k}`, { n });
  };
  return {
    dt, days, dlang: lang, ddir: lang === 'ar' ? 'rtl' : 'ltr',
    dfmt: { date: (v, o) => fmt.formatDate(v, lang, o || { year: 'numeric', month: 'long', day: 'numeric' }), num: (v) => fmt.formatNumber(v, lang) },
  };
}

const typeLabel = (req, type) => req.t(`certificates.types.${type}`);
const doctorName = (req, r) => (req.locale === 'en' && r.doctor_name_en) || r.doctor_name || '—';

async function doctorsList(req) {
  const q = knex('doctors').where({ business_id: req.ctx.businessId }).orderBy('full_name').select('id', 'full_name', 'full_name_en', 'color');
  if (req.ctx.ownDoctorId) q.where('id', req.ctx.ownDoctorId);
  return q;
}

// ---------------------------------------------------------------- pages
const pages = express.Router();
pages.use(can('certificates.view'));

pages.get('/', wrap(async (req, res) => {
  const { rows, meta } = await svc.list(req.ctx, req.query);
  const tz = req.business.timezone;
  rows.forEach((r) => { r.issued = localParts(tz, r.issued_at); });
  res.page('pages/certificates/index', {
    title: req.t('certificates.title'), rows, meta, doctors: await doctorsList(req), types: svc.TYPES,
    filtered: ['q', 'type', 'doctor', 'from', 'to', 'status', 'patient'].some((k) => req.query[k] && req.query[k] !== 'all'), ...ASSETS,
  });
}));

pages.get('/export', can('data.export'), wrap(async (req, res) => {
  const { rows } = await svc.list(req.ctx, req.query, { all: true });
  const t = req.t;
  const tz = req.business.timezone;
  exporter.send(req, res, {
    name: t('certificates.title'),
    header: [t('certificates.serial'), t('certificates.type'), t('certificates.issued_at'), t('common.patient'), t('certificates.doctor'), t('certificates.period'), t('certificates.status_label'), t('certificates.revoked_at'), t('certificates.revoke_reason'), t('certificates.issued_by')],
    rows: rows.map((r) => {
      const i = localParts(tz, r.issued_at);
      return [r.serial, typeLabel(req, r.doc_type), `${i.date} ${i.time}`, r.patient_name, doctorName(req, r), r.leave_start ? `${r.leave_start} – ${r.leave_end}` : '',
        t(`certificates.status.${r.revoked_at ? 'revoked' : 'valid'}`), r.revoked_at ? localParts(tz, r.revoked_at).date : '', r.revoke_reason || '', r.issued_by_name || ''];
    }),
  });
}));

// Issue form: /app/certificates/new?visit=<appointment>&type=<type>[&from=<revoked document to copy>]
async function renderNew(req, res, extra = {}) {
  const src = { ...req.query, ...req.body };
  const visitId = Number(src.visit);
  if (!visitId) throw E.notFound('Appointment');
  const a = await svc.visitFor(req.ctx, visitId);
  const type = svc.TYPES.includes(src.doc_type || src.type) ? (src.doc_type || src.type) : 'sick_leave';
  const d = await svc.defaults(req.ctx, a, req.business);
  let copy = null;
  if (req.query.from && /^\d+$/.test(String(req.query.from))) {
    const old = await svc.get(req.ctx, Number(req.query.from));
    if (old.appointment_id === a.id && old.revoked_at) copy = old;
  }
  if (copy) {
    Object.assign(d, {
      language: copy.language, include_national_id: copy.patient_national_id ? '1' : '', leave_start: copy.leave_start || d.leave_start, leave_days: copy.leave_days || d.leave_days,
      show_diagnosis: copy.doc_type === 'sick_leave' && copy.show_diagnosis ? '1' : '', diagnosis: copy.diagnosis || d.diagnosis,
      companion_leave: copy.companion_leave ? '1' : '', companion_name: copy.companion_name || '', companion_relation: copy.companion_relation || '',
      addressee: copy.body.addressee || '', findings: copy.body.findings || '', recommendations: copy.body.recommendations || '', attachments: (copy.body.attachments || []).join('\n'),
      time_from: copy.time_from || d.time_from, time_to: copy.time_to || d.time_to, replaces_id: copy.id,
    });
  }
  res.page('pages/certificates/new', {
    title: req.t('certificates.new_title', { type: typeLabel(req, type) }), a, type, d, copy, maxDays: svc.MAX_LEAVE_DAYS, ...ASSETS, ...extra,
    old: extra.old ? { ...d, include_national_id: '', show_diagnosis: '', companion_leave: '', ...extra.old } : d,
  });
}
// Without a visit (the "+ New" menu) the doctor first picks a recent visit that took place.
async function renderPick(req, res) {
  const since = new Date(`${req.ctx.today}T00:00:00Z`); since.setUTCDate(since.getUTCDate() - 30);
  const q = knex('appointments as a').leftJoin('patients as p', 'p.id', 'a.patient_id').leftJoin('doctors as d', 'd.id', 'a.doctor_id')
    .where('a.business_id', req.ctx.businessId).whereNot('a.appointment_type', 'blocked').whereNotIn('a.status', ['cancelled', 'no_show'])
    .whereNotNull('a.patient_id').whereBetween('a.appointment_date', [since.toISOString().slice(0, 10), req.ctx.today])
    .orderBy([{ column: 'a.appointment_date', order: 'desc' }, { column: 'a.appointment_time', order: 'desc' }]).limit(50)
    .select('a.id', 'a.appointment_date', 'a.appointment_time', 'p.full_name as patient_name', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en');
  if (req.ctx.ownDoctorId) q.where('a.doctor_id', req.ctx.ownDoctorId);
  const term = String(req.query.q || '').trim().slice(0, 80);
  if (term) q.where('p.full_name', 'like', `%${term.replace(/[%_\\]/g, '\\$&')}%`);
  const type = svc.TYPES.includes(req.query.type) ? req.query.type : 'sick_leave';
  res.page('pages/certificates/pick', { title: req.t('certificates.pick_title'), visits: await q, type, term, ...ASSETS });
}

pages.get('/new', can('certificates.issue'), wrap((req, res) => (req.query.visit ? renderNew(req, res) : renderPick(req, res))));
pages.post('/new', can('certificates.issue'), form(async (req, res) => {
  const id = await svc.issue(req.ctx, Number(req.body.visit), req.body, { business: req.business });
  flash(req, 'success', req.t('certificates.issued'));
  res.redirect(`/app/certificates/${id}`);
}, (req, res, extra) => {
  if (extra.formError && req.t(`errors_certificates.${extra.formError.code}`) !== `errors_certificates.${extra.formError.code}`) extra.formError.message = req.t(`errors_certificates.${extra.formError.code}`);
  return renderNew(req, res, extra);
}));

async function renderShow(req, res, extra = {}) {
  const doc = await svc.get(req.ctx, Number(req.params.id));
  const printing = req.query.print === '1';
  const tools = docTools(doc.language);
  const tz = req.business.timezone;
  const base = phoneBase(req).base;
  const url = svc.verifyUrl(base, doc.verify_code);
  const [qr, replaces, replacedBy] = await Promise.all([
    svc.qrSvg(url),
    doc.replaces_id ? knex('certificates').where({ id: doc.replaces_id, business_id: req.ctx.businessId }).first('id', 'serial') : null,
    knex('certificates').where({ replaces_id: doc.id, business_id: req.ctx.businessId }).first('id', 'serial'),
  ]);
  if (printing) {
    // The printed sheet (letterhead, footer) is entirely in the document's language.
    Object.assign(res.locals, { t: tools.dt, locale: doc.language, dir: tools.ddir });
    res.locals.fmt = { ...res.locals.fmt, date: (v, o) => fmt.formatDate(v, doc.language, o) };
  }
  res.page('pages/certificates/show', {
    title: `${typeLabel(req, doc.doc_type)} · ${doc.serial}`, printable: true, doc, qr, verifyUrl: url, verifyBase: `${base.replace(/^https?:\/\//, '')}/verify`,
    code: svc.formatCode(doc.verify_code), issued: localParts(tz, doc.issued_at), revoked: localParts(tz, doc.revoked_at), replaces, replacedBy, ...tools, ...ASSETS,
    ...(printing && doc.language === 'en' && req.business.name_en ? { business: { ...req.business, name: req.business.name_en } } : {}),
    ...extra,
  });
}
pages.get('/:id(\\d+)', wrap((req, res) => renderShow(req, res)));

pages.post('/:id(\\d+)/revoke', can('certificates.issue'), form(async (req, res) => {
  const doc = await svc.revoke(req.ctx, Number(req.params.id), req.body);
  flash(req, 'success', req.t('certificates.revoked_flash'));
  if (req.body.reissue === '1' && doc.appointment_id) return res.redirect(`/app/certificates/new?visit=${doc.appointment_id}&type=${doc.doc_type}&from=${doc.id}`);
  return res.redirect(`/app/certificates/${doc.id}`);
}, (req, res, extra) => {
  if (extra.formError && req.t(`errors_certificates.${extra.formError.code}`) !== `errors_certificates.${extra.formError.code}`) extra.formError.message = req.t(`errors_certificates.${extra.formError.code}`);
  if (extra.formError && extra.formError.code === 'ALREADY_REVOKED') { flash(req, 'error', extra.formError.message); return res.redirect(`/app/certificates/${req.params.id}`); }
  return renderShow(req, res, { ...extra, openDialog: 'revoke-dialog' });
}));

router.use('/certificates', pages);

module.exports = router;
module.exports.localParts = localParts;
