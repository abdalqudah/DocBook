// Data & audit: the clinic's audit log, a full Excel export, and deleting the clinic (danger zone).
const express = require('express');
const knex = require('../../db/knex');
const xlsx = require('../../core/xlsx');
const audit = require('../../core/audit');
const { has } = require('../../core/i18n');
const { E } = require('../../core/errors');
const { wrap, flash } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const businesses = require('../businesses/business.service');
const { form } = require('./form');
const { render } = require('./common');
const payParts = require('../clinic/payment-parts');

const router = express.Router();
router.use(canAny('audit.view', 'data.export', 'data.manage'));

const PER_PAGE = 30;
const parse = (v) => { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

/** Human-readable action: a specific label when one exists, else "<entity> · <verb>". */
function actionLabel(t, locale, action) {
  if (has(locale, `settings.act.${action}`)) return t(`settings.act.${action}`);
  const [entity, ...rest] = String(action).split('.');
  const verb = rest.join('_');
  const e = has(locale, `settings.act_entity.${entity}`) ? t(`settings.act_entity.${entity}`) : entity;
  const v = has(locale, `settings.act_verb.${verb}`) ? t(`settings.act_verb.${verb}`) : verb.replace(/_/g, ' ');
  return `${e} · ${v}`;
}

function auditQuery(req) {
  const q = knex('audit_logs as a').leftJoin('users as u', 'u.id', 'a.user_id').where('a.business_id', req.ctx.businessId);
  if (/^\d+$/.test(req.query.user || '')) q.andWhere('a.user_id', Number(req.query.user));
  if (/^[a-z_]+$/.test(req.query.action || '')) q.andWhere('a.action', 'like', `${req.query.action}.%`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) q.andWhere('a.created_at', '>=', `${req.query.from} 00:00:00`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) q.andWhere('a.created_at', '<=', `${req.query.to} 23:59:59`);
  return q;
}

async function renderData(req, res, extra = {}) {
  const p = req.ctx.permissions;
  let log = null;
  if (p.has('audit.view')) {
    const base = auditQuery(req);
    const [{ n }] = await base.clone().count({ n: '*' });
    const total = Number(n);
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
    const rows = await base.clone().orderBy('a.id', 'desc').limit(PER_PAGE).offset((page - 1) * PER_PAGE)
      .select('a.id', 'a.action', 'a.entity_type', 'a.entity_id', 'a.old_values', 'a.new_values', 'a.ip', 'a.created_at', 'u.name as user_name', 'u.email as user_email');
    const [users, prefixes] = await Promise.all([
      knex('audit_logs as a').join('users as u', 'u.id', 'a.user_id').where('a.business_id', req.ctx.businessId).distinct('u.id', 'u.name').orderBy('u.name'),
      knex('audit_logs').where('business_id', req.ctx.businessId).distinct(knex.raw("SUBSTRING_INDEX(action, '.', 1) as p")).then((r) => r.map((x) => x.p).sort()),
    ]);
    log = {
      rows: rows.map((r) => ({ ...r, label: actionLabel(req.t, req.locale, r.action), oldV: parse(r.old_values), newV: parse(r.new_values) })),
      meta: { total, page, pages, perPage: PER_PAGE }, users, prefixes,
      entityLabel: (e) => (has(req.locale, `settings.act_entity.${e}`) ? req.t(`settings.act_entity.${e}`) : e),
      filtered: ['user', 'action', 'from', 'to'].some((k) => req.query[k]),
    };
  }
  const counts = {};
  if (p.has('data.export') || p.has('data.manage')) {
    for (const tb of ['patients', 'appointments', 'invoices', 'doctors', 'services', 'expenses']) {
      const [{ n }] = await knex(tb).where({ business_id: req.ctx.businessId }).count({ n: '*' }); // eslint-disable-line no-await-in-loop
      counts[tb] = Number(n);
    }
  }
  render(req, res, 'data', 'data', { log, counts, b: req.business, ...extra });
}
router.get('/', wrap((req, res) => renderData(req, res)));

// ---------------------------------------------------------------- full export (one workbook, one sheet per table)
router.get('/export', can('data.export'), wrap(async (req, res) => {
  const b = req.ctx.businessId;
  const t = req.t;
  const L = res.locals.label;
  const yn = (v) => (v ? t('common.yes') : t('common.no'));
  const br = require('../clinic/branches.service'); // eslint-disable-line global-require -- the branch chosen in the account menu
  const [patients, appointments, invoices, doctors, services, expenses, insurers] = await Promise.all([
    br.scopePatients(knex('patients').where({ business_id: b }), req.ctx, 'patients.id').orderBy('id'),
    br.scope(knex('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id').where('a.business_id', b), req.ctx, 'a.branch_id')
      .orderBy([{ column: 'a.appointment_date' }, { column: 'a.appointment_time' }]).select('a.*', 'd.full_name as doctor_name', 's.name as service_name'),
    br.scopeByVisit(knex('invoices').where({ business_id: b }), req.ctx, 'appointment_id').orderBy('invoice_number'),
    br.scopeDoctors(knex('doctors').where({ business_id: b }), req.ctx).orderBy('full_name'),
    knex('services as s').leftJoin('doctors as d', 'd.id', 's.doctor_id').where('s.business_id', b).orderBy('s.name').select('s.*', 'd.full_name as doctor_name'),
    br.scope(knex('expenses').where({ business_id: b }), req.ctx, 'branch_id').orderBy('date'),
    knex('insurance_providers').where({ business_id: b }).select('id', 'name'),
  ]);
  await payParts.attach(b, invoices); // the method column spells out the parts, never "mixed"
  const insName = Object.fromEntries(insurers.map((i) => [i.id, i.name]));
  const n = (v) => (v === null || v === undefined || v === '' ? '' : Number(v));
  const dt = (v) => (v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 16) : v || '');
  const sheets = [
    { name: t('settings.sheet_patients'), header: ['ID', t('common.name'), t('common.phone'), t('common.email'), t('settings.x_dob'), t('settings.x_gender'), t('settings.x_national_id'), t('settings.x_insurance'), t('settings.x_insurance_no'), t('settings.x_allergies'), t('settings.x_chronic'), t('common.notes'), t('common.created_at')],
      rows: patients.map((r) => [r.id, r.full_name, r.phone || '', r.email || '', r.date_of_birth || '', r.gender || '', r.national_id || '', insName[r.insurance_provider_id] || '', r.insurance_number || '', r.allergies || '', r.chronic_conditions || '', r.notes || '', dt(r.created_at)]) },
    { name: t('settings.sheet_appointments'), header: ['ID', t('common.date'), t('common.time'), t('settings.x_duration'), t('common.patient'), t('common.phone'), t('common.doctor'), t('common.service'), t('common.status'), t('common.type'), t('settings.x_source'), t('settings.x_amount_due'), t('settings.x_payment'), t('common.notes')],
      rows: appointments.map((r) => [r.id, r.appointment_date, r.appointment_time, n(r.duration_minutes), r.patient_name, r.patient_phone || '', r.doctor_name || '', r.service_name || '', L('settings.x_status', r.status), L('settings.x_type', r.appointment_type), L('settings.x_src', r.source), n(r.amount_due), L('settings.x_pay', r.payment_status), r.notes || '']) },
    { name: t('settings.sheet_invoices'), header: [t('settings.x_invoice_no'), t('common.date'), t('common.patient'), t('common.phone'), t('common.doctor'), t('common.service'), t('settings.x_discount_pct'), t('settings.x_discount'), t('common.amount'), t('settings.x_method'), t('settings.x_insurance')],
      rows: invoices.map((r) => [n(r.invoice_number), dt(r.created_at), r.patient_name, r.patient_phone || '', r.doctor_name || '', r.service_name || '', n(r.discount_percent), n(r.discount_amount), n(r.amount), payParts.describe(t, r.parts, { insuranceName: r.insurance_provider_name, amount: n }), r.insurance_provider_name || '']) },
    { name: t('settings.sheet_doctors'), header: ['ID', t('common.name'), t('settings.x_name_en'), t('settings.x_specialty'), t('common.phone'), t('common.email'), t('settings.x_license'), t('settings.x_fee'), t('settings.x_slot'), t('settings.x_salary'), t('common.active')],
      rows: doctors.map((r) => [r.id, r.full_name, r.full_name_en || '', r.specialization || '', r.phone || '', r.email || '', r.license_number || '', n(r.consultation_fee), n(r.slot_duration_minutes), n(r.base_salary), yn(r.is_active)]) },
    { name: t('settings.sheet_services'), header: ['ID', t('common.name'), t('settings.x_name_en'), t('common.doctor'), t('settings.x_duration'), t('settings.x_price'), t('common.active')],
      rows: services.map((r) => [r.id, r.name, r.name_en || '', r.doctor_name || '', n(r.duration_minutes), n(r.price), yn(r.is_active)]) },
    { name: t('settings.sheet_expenses'), header: [t('common.date'), t('common.category'), t('settings.x_title'), t('common.amount'), t('settings.x_method'), t('settings.x_invoice_no'), t('settings.x_recorded_by'), t('common.notes')],
      rows: expenses.map((r) => [r.date, L('categories', r.category), r.title, n(r.amount), L('payment_methods', r.payment_method), r.invoice_number || '', r.recorded_by || '', r.notes || '']) },
  ];
  await audit.record(req.ctx, 'data.exported', { entityType: 'clinic', entityId: b, newValues: Object.fromEntries(sheets.map((s, i) => [['patients', 'appointments', 'invoices', 'doctors', 'services', 'expenses'][i], s.rows.length])) });
  const slug = req.business.slug || `clinic-${b}`;
  xlsx.send(res, `docbook-${slug}-${req.ctx.today}.xlsx`, sheets, { rtl: req.locale === 'ar' });
}));

// ---------------------------------------------------------------- delete the clinic
router.post('/delete', can('data.manage'), form(async (req, res) => {
  const role = req.ctx.roleKey;
  if (role !== 'owner') throw E.forbidden('owner');
  const name = req.business.name;
  await businesses.destroy(req.ctx, req.body.confirm_name);
  req.session.businessId = null;
  const others = await businesses.listForUser(req.ctx.userId);
  flash(req, 'success', req.t('settings.clinic_deleted', { name }));
  res.redirect(others.length ? '/app' : '/workspaces/new');
}, (req, res, extra) => renderData(req, res, { ...extra, openDialog: 'delete' })));

module.exports = router;
