// A patient's whole file as one ZIP, for the clinic to keep, hand over or move to another system:
//   00-summary.pdf      — the file on the clinic's letterhead: details, allergies, visits with diagnoses, vitals,
//                         prescriptions, tests, referrals, certificates, the list of files and invoices
//   papers/…pdf         — each prescription, consultation report, test request, referral, certificate and invoice,
//                         exactly as the patient's copy
//   files/…             — the stored files themselves (X-rays, scans, results), as uploaded
//   data.json           — every record in a machine-readable form (to import elsewhere)
//   README.txt          — what is inside, in Arabic and English
// Only what the member may already see is exported: clinical parts need clinical.view and the record's privacy,
// invoices need billing.view, a doctor login gets only their own visits. Every export is in the audit log and the
// record's access log.
const AdmZip = require('adm-zip');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const { translator } = require('../../core/i18n');
const lib = require('../clinic/records.lib');

const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || d); } catch { return d; } };
const day = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : '');
const ascii = (s, fallback) => String(s || '').normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || fallback;
const noBlobs = (r) => { const { data: _d, business_id: _b, ...rest } = r; return rest; };

/** This installation's id (platform_settings.instance_id, made once): with the clinic id it tells an import whether
 *  a file comes back to the clinic it left, or moves to another clinic. */
async function instanceId() {
  const row = await knex('platform_settings').where({ key: 'instance_id' }).first('value');
  if (row && row.value) return String(row.value);
  const id = require('crypto').randomBytes(12).toString('hex'); // eslint-disable-line global-require
  await knex('platform_settings').insert({ key: 'instance_id', value: id }).onConflict('key').ignore();
  return String((await knex('platform_settings').where({ key: 'instance_id' }).first('value')).value);
}

/** Everything of the patient this member may see. */
async function gather(ctx, patientId) {
  const q = knex('patients').leftJoin('insurance_providers as ip', function j() { this.on('ip.id', 'patients.insurance_provider_id').andOn('ip.business_id', 'patients.business_id'); })
    .where({ 'patients.business_id': ctx.businessId, 'patients.id': Number(patientId) || 0 }).first('patients.*', 'ip.name as insurance_name');
  lib.scopePatientsToDoctor(q, ctx.ownDoctorId);
  const patient = await q;
  if (!patient) throw E.notFound('Patient');
  const has = (p) => ctx.permissions.has(p);
  const access = await require('../clinicalplus/privacy.service').access(ctx, { patientId: patient.id }); // eslint-disable-line global-require
  const clinicalOk = has('clinical.view') && Boolean(access.clinical);
  const billingOk = has('billing.view');
  const certsOk = clinicalOk && (has('certificates.view') || has('certificates.issue'));
  const w = { business_id: ctx.businessId, patient_id: patient.id };
  const mine = (qb, col = 'doctor_id') => { if (ctx.ownDoctorId) qb.where(col, ctx.ownDoctorId); return qb; };
  const rows = (table, on, order = 'created_at') => (on ? mine(knex(table).where(w)).orderBy(order).select() : Promise.resolve([]));

  const [appointments, consultations, diagnoses, prescriptions, orders, referrals, certificates, files, invoices, dental, plan, growth, pregnancies, surgeries, specialtyRecords] = await Promise.all([
    mine(knex('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').leftJoin('services as s', 's.id', 'a.service_id')
      .where({ 'a.business_id': ctx.businessId, 'a.patient_id': patient.id }).whereNot('a.appointment_type', 'blocked'), 'a.doctor_id')
      .orderBy([{ column: 'a.appointment_date' }, { column: 'a.appointment_time' }])
      .select('a.*', 'd.full_name as doctor_name', 's.name as service_name'),
    rows('consultations', clinicalOk),
    clinicalOk ? mine(knex('consultation_diagnoses').where(w)).orderBy('id').select() : [],
    rows('prescriptions', clinicalOk),
    rows('medical_orders', clinicalOk),
    rows('referrals', clinicalOk),
    certsOk ? mine(knex('certificates').where(w)).whereNull('revoked_at').orderBy('id').select() : [],
    clinicalOk ? (ctx.ownDoctorId
      ? knex('patient_files as f').leftJoin('appointments as a', 'a.id', 'f.appointment_id').where({ 'f.business_id': ctx.businessId, 'f.patient_id': patient.id })
        .where((x) => x.whereNull('f.appointment_id').orWhere('a.doctor_id', ctx.ownDoctorId)).orderBy('f.id').select('f.*')
      : knex('patient_files').where(w).orderBy('id').select()) : [],
    rows('invoices', billingOk),
    rows('dental_entries', clinicalOk),
    rows('dental_plan_items', clinicalOk),
    clinicalOk ? knex('growth_measurements').where(w).orderBy('created_at').select() : [],
    rows('pregnancies', clinicalOk),
    clinicalOk ? mine(knex('surgeries').where(w)).orderBy([{ column: 'surgery_date' }, { column: 'surgery_time' }]).select() : [],
    rows('specialty_records', clinicalOk),
  ]);
  const invIds = invoices.map((i) => i.id);
  const payments = invIds.length ? await knex('invoice_payments').whereIn('invoice_id', invIds).orderBy('id').select() : [];
  return { patient, access, clinicalOk, billingOk, appointments, consultations, diagnoses, prescriptions, orders, referrals, certificates, files, invoices, payments, dental, plan, growth, pregnancies, surgeries, specialtyRecords };
}

/**
 * Writes one patient's file through add(path, buffer) (an in-memory zip, or a folder of the whole-clinic export)
 * → { patient, access, counts, clinicalOk, billingOk }. Nothing is logged here; the callers log.
 */
async function collect(ctx, patientId, locale, add, { transfer = false } = {}) {
  const d = await gather(ctx, patientId);
  const t = translator(locale);
  const { paper } = require('../share/papers'); // eslint-disable-line global-require
  const docsSvc = require('../patientdocs/docs.service'); // eslint-disable-line global-require
  const documents = require('../patientdocs/documents'); // eslint-disable-line global-require
  const zip = { addFile: (name, buf) => add(name, buf) };
  const index = []; // what is in the zip, for the summary and the README
  const missing = [];

  // Papers, oldest first, named by date so they sort on any computer.
  const visitDate = new Map(d.appointments.map((a) => [a.id, day(a.appointment_date)]));
  const papers = [
    ...d.prescriptions.map((r) => ({ kind: 'prescription', id: r.id, date: visitDate.get(r.appointment_id) || day(r.created_at) })),
    ...d.consultations.map((c) => ({ kind: 'report', id: c.appointment_id, date: visitDate.get(c.appointment_id) || day(c.created_at) })),
    ...d.orders.filter((o) => o.status !== 'cancelled').map((o) => ({ kind: 'order', id: o.id, date: day(o.created_at), sub: o.kind })),
    ...d.referrals.map((r) => ({ kind: 'referral', id: r.id, date: day(r.created_at) })),
    ...d.certificates.map((c) => ({ kind: 'certificate', id: c.id, date: day(c.created_at) })),
    ...d.invoices.map((i) => ({ kind: 'invoice', id: i.id, date: day(i.created_at) })),
  ].filter((p) => p.id).filter((p) => !transfer || ['invoice', 'certificate'].includes(p.kind)) // a clinic-to-clinic copy needs only the papers that are not re-created
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const p of papers) { // eslint-disable-line no-restricted-syntax
    try {
      const out = await paper(ctx, p.kind, p.id, locale); // eslint-disable-line no-await-in-loop
      const name = `papers/${p.date || 'undated'}_${p.kind}${p.sub ? `-${ascii(p.sub, '')}` : ''}-${p.id}.pdf`;
      await zip.addFile(name, Buffer.from(out.content)); // eslint-disable-line no-await-in-loop
      index.push({ path: name, kind: p.kind, date: p.date });
    } catch (e) { missing.push(`${p.kind} #${p.id}`); }
  }
  // The stored files as uploaded.
  for (const f of d.files) { // eslint-disable-line no-restricted-syntax
    const ext = (String(f.name || '').match(/\.([A-Za-z0-9]{1,5})$/) || [])[1] || (String(f.mime).split('/')[1] || 'bin');
    const base = ascii(String(f.name || '').replace(/\.[A-Za-z0-9]{1,5}$/, ''), f.category || 'file');
    const name = `files/${day(f.created_at)}_${f.id}_${base}.${ext.toLowerCase()}`;
    await zip.addFile(name, Buffer.from(f.data)); // eslint-disable-line no-await-in-loop
    index.push({ path: name, kind: 'file', date: day(f.created_at), title: f.title || f.name, category: f.category, id: f.id });
  }

  // The summary PDF (not for a clinic-to-clinic copy: the receiving clinic has the records themselves).
  const clinic = await docsSvc.clinicInfo(ctx.businessId);
  const today = require('../clinic/scheduling').clinicNow(clinic.timezone || 'Asia/Amman').date; // eslint-disable-line global-require -- the clinic's own day
  const doctorOf = new Map(d.appointments.map((a) => [a.doctor_id, a.doctor_name]));
  const consultBy = new Map(d.consultations.map((c) => [c.appointment_id, c]));
  const icd = require('../clinicalplus/icd.service'); // eslint-disable-line global-require
  const codesBy = d.clinicalOk ? await icd.diagnosesByAppointment(ctx.businessId, d.appointments.map((a) => a.id)) : new Map();
  const summary = transfer ? null : await documents.patientFile({
    clinic, patient: d.patient, age: lib.ageOf(d.patient.date_of_birth, today), today, clinicalOk: d.clinicalOk, billingOk: d.billingOk,
    visits: d.appointments.map((a) => ({ ...a, consultation: consultBy.get(a.id) || null, codes: codesBy.get(a.id) || [] })),
    prescriptions: d.prescriptions.map((r) => ({ ...r, items: parse(r.items, []), visit_date: visitDate.get(r.appointment_id) || null, doctor_name: doctorOf.get(r.doctor_id) || null })),
    orders: d.orders, referrals: d.referrals, certificates: d.certificates, invoices: d.invoices, surgeries: d.surgeries, files: index.filter((x) => x.kind === 'file'),
    vitals: d.consultations.slice().reverse().map((c) => ({ at: c.created_at, v: parse(c.vital_signs, {}) })).find((x) => x.v && Object.values(x.v).some(Boolean)) || null,
    icdTitle: (r) => icd.titleOf(r, locale),
  }, locale);
  if (summary) await zip.addFile('00-summary.pdf', Buffer.from(summary));

  // Machine-readable copy.
  const data = {
    format: 'docbook.patient-export', version: 1, exported_at: new Date().toISOString(), locale,
    source: { instance: await instanceId(), business_id: ctx.businessId },
    clinic: { name: clinic.name, name_en: clinic.name_en || null },
    doctors: await (async () => {
      const ids = [...new Set([d.appointments, d.consultations, d.prescriptions, d.orders, d.referrals, d.dental, d.plan, d.pregnancies, d.surgeries, d.specialtyRecords].flat().map((r) => r.doctor_id).filter(Boolean))];
      return ids.length ? knex('doctors').where({ business_id: ctx.businessId }).whereIn('id', ids).select('id', 'full_name', 'full_name_en') : [];
    })(),
    patient: noBlobs(d.patient), appointments: d.appointments.map(noBlobs),
    consultations: d.consultations.map((c) => ({ ...noBlobs(c), vital_signs: parse(c.vital_signs, {}) })), diagnoses: d.diagnoses.map(noBlobs),
    prescriptions: d.prescriptions.map((r) => ({ ...noBlobs(r), items: parse(r.items, []) })), orders: d.orders.map((o) => ({ ...noBlobs(o), items: parse(o.items, []) })), referrals: d.referrals.map(noBlobs),
    certificates: d.certificates.map(noBlobs), invoices: d.invoices.map((i) => ({ ...noBlobs(i), items: parse(i.items, null) })), payments: d.payments,
    files: d.files.map((f) => ({ ...noBlobs(f), path: (index.find((x) => x.kind === 'file' && x.id === f.id) || {}).path })),
    dental: d.dental.map(noBlobs), dental_plan: d.plan.map(noBlobs), growth: d.growth.map(noBlobs), pregnancies: d.pregnancies.map(noBlobs),
    surgeries: d.surgeries.map(noBlobs),
    specialty_records: d.specialtyRecords.map((r) => ({ ...noBlobs(r), data: parse(r.data, {}), results: parse(r.results, []) })),
    papers: index.filter((x) => x.kind !== 'file'),
    not_included: [...(d.clinicalOk ? [] : ['clinical']), ...(d.billingOk ? [] : ['billing']), ...missing],
  };
  await zip.addFile('data.json', Buffer.from(JSON.stringify(data, null, 2)));
  const readme = [t('patient_export.readme', { name: d.patient.full_name, date: today, clinic: clinic.name }), '',
    translator(locale === 'en' ? 'ar' : 'en')('patient_export.readme', { name: d.patient.full_name, date: today, clinic: clinic.name_en || clinic.name }),
    ...(missing.length || !d.clinicalOk || !d.billingOk ? ['', t('patient_export.readme_partial')] : [])].join('\r\n');
  await zip.addFile('README.txt', Buffer.from(`\ufeff${readme}`, 'utf8'));
  const counts = { papers: index.filter((x) => x.kind !== 'file').length, files: d.files.length, visits: d.appointments.length };
  return { patient: d.patient, access: d.access, counts, clinicalOk: d.clinicalOk, billingOk: d.billingOk };
}

/** One patient's ZIP (in memory) → { filename, buffer, counts }; audited and written to the record's access log. */
async function build(ctx, patientId, locale = 'ar') {
  const zip = new AdmZip();
  const r = await collect(ctx, patientId, locale, (name, buf) => zip.addFile(name, buf));
  await audit.record(ctx, 'patient.exported', { entityType: 'patient', entityId: r.patient.id, newValues: { ...r.counts, clinical: r.clinicalOk, billing: r.billingOk } });
  const privacy = require('../clinicalplus/privacy.service'); // eslint-disable-line global-require
  await privacy.log(ctx, { patientId: r.patient.id, what: 'export', access: privacy.levelOf(r.access) });
  return { filename: `patient-${r.patient.id}-${ascii(r.patient.full_name, 'file')}-${new Date().toISOString().slice(0, 10)}.zip`, buffer: zip.toBuffer(), counts: r.counts };
}

module.exports = { gather, collect, build, ascii, instanceId };
