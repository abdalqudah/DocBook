// Global search for the ⌘K palette: patients, recent/upcoming appointments, invoices and doctors —
// only the kinds of records the signed-in person may open, and a doctor-scoped login only sees its own.
const express = require('express');
const knex = require('../../db/knex');
const fmtCore = require('../../core/format');
const { wrap } = require('../../routes/helpers');
const lib = require('./records.lib');

const router = express.Router();
const MAX = 12;

router.get('/', wrap(async (req, res) => {
  const { ctx } = req;
  const raw = String(req.query.q || '').trim().slice(0, 80);
  if (raw.length < 2) return res.json({ data: [] });
  const perms = ctx.permissions;
  const term = lib.likeTerm(raw);
  const digits = raw.replace(/^#|^inv-?/i, '');
  const en = req.locale === 'en';
  const d = (v) => fmtCore.formatDate(v, req.locale);
  const jobs = [];

  if (perms.has('patients.view')) {
    const q = knex('patients').where('business_id', ctx.businessId)
      .andWhere((w) => w.where('full_name', 'like', term).orWhere('phone', 'like', term).orWhere('national_id', 'like', term))
      .orderBy('full_name').limit(6).select('id', 'full_name', 'phone', 'national_id');
    lib.scopePatientsToDoctor(q, ctx.ownDoctorId);
    jobs.push(q.then((rows) => rows.map((p) => ({ title: p.full_name, subtitle: [req.t('dashboard.search.patient'), p.phone].filter(Boolean).join(' · '), href: `/app/patients/${p.id}`, icon: 'user-round' }))));
  }
  if (perms.has('appointments.view')) {
    const q = knex('appointments as a').leftJoin('doctors as dr', 'dr.id', 'a.doctor_id').where('a.business_id', ctx.businessId).whereNot('a.appointment_type', 'blocked')
      .where('a.appointment_date', '>=', lib.addDays(ctx.today, -30))
      .andWhere((w) => w.where('a.patient_name', 'like', term).orWhere('a.patient_phone', 'like', term))
      .orderBy([{ column: 'a.appointment_date' }, { column: 'a.appointment_time' }]).limit(5)
      .select('a.id', 'a.patient_name', 'a.appointment_date', 'a.appointment_time', 'a.status', 'dr.full_name', 'dr.full_name_en');
    if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId);
    jobs.push(q.then((rows) => rows.map((a) => ({
      title: `${a.patient_name} — ${d(a.appointment_date)} ${a.appointment_time}`,
      subtitle: [req.t(`dashboard.statuses.${a.status}`), (en && a.full_name_en) || a.full_name].filter(Boolean).join(' · '),
      href: `/app/appointments/${a.id}`, icon: 'calendar-days',
    }))));
  }
  if (perms.has('billing.view')) {
    const q = knex('invoices').where('business_id', ctx.businessId)
      .andWhere((w) => { w.where('patient_name', 'like', term).orWhere('patient_phone', 'like', term); if (/^\d+$/.test(digits)) w.orWhere('invoice_number', Number(digits)); })
      .orderBy('invoice_number', 'desc').limit(5).select('id', 'invoice_number', 'patient_name', 'amount', 'created_at');
    if (ctx.ownDoctorId) q.where('doctor_id', ctx.ownDoctorId);
    jobs.push(q.then((rows) => rows.map((i) => ({
      title: `${req.t('billing.invoice_no', { n: i.invoice_number })} · ${i.patient_name}`,
      subtitle: `${fmtCore.formatMoney(i.amount, ctx.currency, req.locale)} · ${d((lib.localTime(i.created_at, ctx.timezone) || {}).date)}`,
      href: `/app/billing/${i.id}`, icon: 'receipt',
    }))));
  }
  if (perms.has('doctors.manage') || perms.has('appointments.view_all')) {
    jobs.push(knex('doctors').where('business_id', ctx.businessId)
      .andWhere((w) => w.where('full_name', 'like', term).orWhere('full_name_en', 'like', term).orWhere('specialization', 'like', term).orWhere('phone', 'like', term))
      .orderBy('full_name').limit(4).select('id', 'full_name', 'full_name_en', 'specialization', 'specialization_en')
      .then((rows) => rows.map((r) => ({ title: (en && r.full_name_en) || r.full_name, subtitle: [req.t('dashboard.search.doctor'), (en && r.specialization_en) || r.specialization].filter(Boolean).join(' · '), href: `/app/doctors/${r.id}`, icon: 'stethoscope' }))));
  }

  const groups = await Promise.all(jobs);
  // Interleave so one category can't crowd out the others, then cap.
  const out = [];
  for (let i = 0; out.length < MAX && groups.some((g) => g[i]); i += 1) groups.forEach((g) => { if (g[i] && out.length < MAX) out.push(g[i]); });
  // Keep each category together for a calmer list.
  const rank = ['user-round', 'calendar-days', 'receipt', 'stethoscope'];
  out.sort((a, b) => rank.indexOf(a.icon) - rank.indexOf(b.icon));
  return res.json({ data: out });
}));

module.exports = router;
