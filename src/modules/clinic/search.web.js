// Global search for the ⌘K palette: patients, recent/upcoming appointments, invoices and doctors —
// only the kinds of records the signed-in person may open, and a doctor-scoped login only sees its own.
const express = require('express');
const knex = require('../../db/knex');
const fmtCore = require('../../core/format');
const { wrap } = require('../../routes/helpers');
const lib = require('./records.lib');

const router = express.Router();
const MAX = 14;

// Arabic spelling variants match each other: أ/إ/آ/ا, ى/ي, ة/ه, ؤ/و, ئ/ي — each becomes LIKE's one-character
// wildcard, so "احمد" finds "أحمد". Arabic-Indic digits are read as 0-9.
const ARABIC_VARIANTS = /[أإآاىيةهؤوئ]/g;
const toLatinDigits = (s) => String(s).replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06F0));
const nameTerm = (raw) => `%${String(raw).trim().replace(/[%_\\]/g, (m) => `\\${m}`).replace(ARABIC_VARIANTS, '_')}%`;

router.get('/', wrap(async (req, res) => {
  const { ctx } = req;
  const raw = toLatinDigits(String(req.query.q || '').trim().slice(0, 80));
  if (raw.length < 2) return res.json({ data: [] });
  const perms = ctx.permissions;
  const term = nameTerm(raw);
  const digits = raw.replace(/^#|^inv-?/i, '');
  const phone = raw.replace(/[^0-9]/g, '');
  const phoneTerm = phone.length >= 3 ? `%${phone}%` : null;
  const en = req.locale === 'en';
  const d = (v) => fmtCore.formatDate(v, req.locale);
  const jobs = [];

  if (perms.has('patients.view')) {
    const q = knex('patients').where('business_id', ctx.businessId)
      .andWhere((w) => { w.where('full_name', 'like', term).orWhere('national_id', 'like', lib.likeTerm(raw)); if (phoneTerm) w.orWhere('phone', 'like', phoneTerm); })
      .orderBy('full_name').limit(6).select('id', 'full_name', 'phone', 'national_id');
    lib.scopePatientsToDoctor(q, ctx.ownDoctorId);
    const book = perms.has('appointments.manage');
    jobs.push(q.then((rows) => rows.map((p) => ({
      group: 'patients', title: p.full_name, subtitle: [p.phone, p.national_id].filter(Boolean).join(' · '), href: `/app/patients/${p.id}`, icon: 'user-round',
      action: book ? { label: req.t('dashboard.search.book'), href: `/app/appointments/new?patient=${p.id}` } : null,
    }))));
  }
  if (perms.has('appointments.view')) {
    const q = knex('appointments as a').leftJoin('doctors as dr', 'dr.id', 'a.doctor_id').where('a.business_id', ctx.businessId).whereNot('a.appointment_type', 'blocked')
      .where('a.appointment_date', '>=', lib.addDays(ctx.today, -30))
      .andWhere((w) => { w.where('a.patient_name', 'like', term); if (phoneTerm) w.orWhere('a.patient_phone', 'like', phoneTerm); })
      .orderByRaw('a.appointment_date < ? , ABS(DATEDIFF(a.appointment_date, ?))', [ctx.today, ctx.today]).orderBy('a.appointment_time').limit(5)
      .select('a.id', 'a.patient_name', 'a.appointment_date', 'a.appointment_time', 'a.status', 'a.checked_in', 'dr.full_name', 'dr.full_name_en');
    if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId);
    const desk = perms.has('frontdesk.use');
    jobs.push(q.then((rows) => rows.map((a) => ({
      group: 'appointments',
      title: `${a.patient_name} — ${a.appointment_date === ctx.today ? req.t('common.today') : d(a.appointment_date)} ${a.appointment_time}`,
      action: desk && a.appointment_date === ctx.today && !a.checked_in && ['pending', 'confirmed'].includes(a.status) ? { label: req.t('dashboard.search.check_in'), href: '/app/front-desk#fx-expected' } : null,
      subtitle: [req.t(`dashboard.statuses.${a.status}`), (en && a.full_name_en) || a.full_name].filter(Boolean).join(' · '),
      href: `/app/appointments/${a.id}`, icon: 'calendar-days',
    }))));
  }
  if (perms.has('billing.view')) {
    const q = knex('invoices').where('business_id', ctx.businessId)
      .andWhere((w) => { w.where('patient_name', 'like', term); if (phoneTerm) w.orWhere('patient_phone', 'like', phoneTerm); if (/^\d+$/.test(digits)) w.orWhere('invoice_number', Number(digits)); })
      .orderBy('invoice_number', 'desc').limit(5).select('id', 'invoice_number', 'patient_name', 'amount', 'created_at');
    if (ctx.ownDoctorId) q.where('doctor_id', ctx.ownDoctorId);
    jobs.push(q.then((rows) => rows.map((i) => ({
      group: 'invoices',
      title: `${req.t('billing.invoice_no', { n: i.invoice_number })} · ${i.patient_name}`,
      subtitle: `${fmtCore.formatMoney(i.amount, ctx.currency, req.locale)} · ${d((lib.localTime(i.created_at, ctx.timezone) || {}).date)}`,
      href: `/app/billing/${i.id}`, icon: 'receipt',
    }))));
  }
  if (perms.has('doctors.manage') || perms.has('appointments.view_all')) {
    jobs.push(knex('doctors').where('business_id', ctx.businessId)
      .andWhere((w) => { w.where('full_name', 'like', term).orWhere('full_name_en', 'like', lib.likeTerm(raw)).orWhere('specialization', 'like', term); if (phoneTerm) w.orWhere('phone', 'like', phoneTerm); })
      .orderBy('full_name').limit(4).select('id', 'full_name', 'full_name_en', 'specialization', 'specialization_en')
      .then((rows) => rows.map((r) => ({ group: 'doctors', title: (en && r.full_name_en) || r.full_name, subtitle: [req.t('dashboard.search.doctor'), (en && r.specialization_en) || r.specialization].filter(Boolean).join(' · '), href: `/app/doctors/${r.id}`, icon: 'stethoscope' }))));
  }

  const groups = await Promise.all(jobs);
  // Interleave so one category can't crowd out the others, then cap.
  const out = [];
  for (let i = 0; out.length < MAX && groups.some((g) => g[i]); i += 1) groups.forEach((g) => { if (g[i] && out.length < MAX) out.push(g[i]); });
  // Keep each category together (the palette shows a heading per group).
  const rank = ['patients', 'appointments', 'invoices', 'doctors'];
  out.sort((a, b) => rank.indexOf(a.group) - rank.indexOf(b.group));
  return res.json({ data: out, groups: Object.fromEntries(rank.map((g) => [g, req.t(`dashboard.search.group_${g}`)])) });
}));

module.exports = router;
