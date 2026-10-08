#!/usr/bin/env node
// Cleans a Clinica backup (clinica-patients-*.json) before it is imported, on the clinic's own computer or server —
// nothing is sent anywhere. Usage:
//   node scripts/clinica-clean.js <clinica-patients.json> <out-dir>
// Writes to <out-dir>:
//   • clinica-patients-clean.json — the same records, with
//       – each doctor name written one way ("Raghad  Kafina" → "Raghad Kafina"),
//       – each treatment's description cleaned of Clinica's page text ("more…", "View Notes"); its details
//         ("Chief Complaint: …", "HPI: …") put before the treatment's note,
//       – the clinical tables that hold no patient data left out (Clinica's empty forms, copies of the treatments);
//   • clinica-doctors.csv — each doctor spelling → the one name, with its number of treatments;
//   • clinica-report.json / clinica-report.md — counts only (no patient names or numbers).
// Chairs written where the doctor goes ("Clinic One"…) and treatments without a doctor are left as they are: the
// import gives them the patient's doctor of that day, else the patient's usual doctor (Import Center → Doctors, where
// the clinic can choose otherwise); the report shows what that gives.
const fs = require('fs');
const path = require('path');
const clean = require('../src/modules/legacy/clinica-clean');

const [src, outDir] = process.argv.slice(2);
if (!src || !outDir) { console.error('Usage: node scripts/clinica-clean.js <clinica-patients.json> <out-dir>'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const data = JSON.parse(fs.readFileSync(src, 'utf8'));
const patients = Array.isArray(data) ? data : (data.patients || []);
const key = (n) => clean.doctorName(n).toLowerCase();

const spellings = new Map(); // key → Map(spelling → count)
const r = {
  patients: patients.length, treatments: 0, visits: 0, patients_with_treatments: 0, attachment_links: 0, patients_with_attachments: 0,
  files_listed_not_downloaded: 0, patients_with_files_not_downloaded: 0, descriptions_cleaned: 0, details_moved_to_note: 0,
  clinical_rows_before: 0, clinical_rows_kept: 0, clinical_tables_dropped: 0, groups: {}, treatment_years: {}, statuses: {},
  chair_treatments: 0, no_doctor_treatments: 0, inferred: { same_day_or_usual: 0, clinic_number: 0, none: 0 }, inferred_by_name: {},
};
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

// The doctor seen most with each chair / no name, over all patients (the last fallback of the import).
const coDoctors = new Map();
patients.forEach((p) => {
  const tr = p.treatments || [];
  const real = tr.filter((t) => clean.doctorName(t.doctor) && clean.chairOf(t.doctor) === null);
  tr.filter((t) => !clean.doctorName(t.doctor) || clean.chairOf(t.doctor) !== null).forEach((t) => {
    const k = key(t.doctor);
    if (!coDoctors.has(k)) coDoctors.set(k, new Map());
    real.forEach((x) => coDoctors.get(k).set(clean.doctorName(x.doctor), (coDoctors.get(k).get(clean.doctorName(x.doctor)) || 0) + 1));
  });
});
const usualOf = (name) => {
  const m = coDoctors.get(key(name));
  return m && m.size ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
};

const out = patients.map((p) => {
  const q = { ...p };
  const tr = (p.treatments || []).map((t) => ({ ...t }));
  if (tr.length) r.patients_with_treatments += 1;
  const days = new Set();
  tr.forEach((t) => {
    r.treatments += 1;
    if (t.date) { days.add(t.date); inc(r.treatment_years, String(t.date).slice(0, 4)); }
    inc(r.statuses, t.status || '(none)');
    const name = clean.doctorName(t.doctor);
    if (!spellings.has(key(name))) spellings.set(key(name), new Map());
    spellings.get(key(name)).set(String(t.doctor || ''), (spellings.get(key(name)).get(String(t.doctor || '')) || 0) + 1);
    t.doctor = name;
    const d = clean.cleanTreatment(t.description);
    if (d.name !== String(t.description || '')) r.descriptions_cleaned += 1;
    if (d.lines.length) { r.details_moved_to_note += 1; t.note = [...d.lines, String(t.note || '').trim()].filter(Boolean).join('\n'); }
    t.description = d.name;
  });
  r.visits += days.size;
  // what the import will give the chairs / no-doctor treatments
  const needs = (t) => !t.doctor || clean.chairOf(t.doctor) !== null;
  const got = clean.inferDoctors(tr, { needs, doctorOf: (t) => t.doctor, dayOf: (t) => t.date });
  tr.filter(needs).forEach((t) => {
    if (t.doctor) r.chair_treatments += 1; else r.no_doctor_treatments += 1;
    const label = t.doctor || '(no doctor)';
    let doc = got.get(t);
    if (doc) r.inferred.same_day_or_usual += 1;
    else if ((doc = usualOf(t.doctor))) r.inferred.clinic_number += 1;
    else r.inferred.none += 1;
    if (!r.inferred_by_name[label]) r.inferred_by_name[label] = {};
    inc(r.inferred_by_name[label], doc || '(none)');
  });
  q.treatments = tr;
  const att = p.attachments || [];
  r.attachment_links += att.length;
  if (att.length) r.patients_with_attachments += 1;
  String(p.group || '').split(',').map((g) => g.trim()).filter(Boolean).forEach((g) => inc(r.groups, g));
  const ct = {};
  Object.entries(p.clinical_tables || {}).forEach(([k, v]) => {
    const before = Array.isArray(v) ? v.length : 0;
    r.clinical_rows_before += before;
    const kept = clean.clinicalRows(v);
    if (Array.isArray(kept) && kept.length === 0) { r.clinical_tables_dropped += 1; return; }
    ct[k] = kept;
    r.clinical_rows_kept += Array.isArray(kept) ? kept.length : 0;
    // Clinica's files table: files listed in Clinica (header "File Name") that were not downloaded
    if (Array.isArray(kept) && kept[0] && kept[0].some((c) => /^file name$/i.test(String(c).trim())) && !att.length) {
      const n = kept.length - 1;
      if (n > 0) { r.files_listed_not_downloaded += n; r.patients_with_files_not_downloaded += 1; }
    }
  });
  q.clinical_tables = ct;
  return q;
});

fs.writeFileSync(path.join(outDir, 'clinica-patients-clean.json'), JSON.stringify(out));
const csv = [['clinica_spelling', 'name', 'treatments', 'kind'].join(',')];
const doctors = [...spellings.entries()].map(([k, m]) => {
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  const name = clean.doctorName([...m.keys()][0]);
  const kind = !name ? 'no doctor' : (clean.chairOf(name) !== null ? 'clinic chair' : 'doctor');
  [...m.entries()].forEach(([s, n]) => csv.push([JSON.stringify(s), JSON.stringify(name), n, kind].join(',')));
  return { name: name || '(no doctor)', spellings: [...m.keys()], treatments: total, kind };
}).sort((a, b) => b.treatments - a.treatments);
fs.writeFileSync(path.join(outDir, 'clinica-doctors.csv'), `${csv.join('\n')}\n`);
r.doctors = doctors;
r.doctors_after_merge = doctors.filter((d) => d.kind === 'doctor').length;
fs.writeFileSync(path.join(outDir, 'clinica-report.json'), JSON.stringify(r, null, 2));
const md = [
  '# Clinica data — cleaned', '',
  `- Patients: ${r.patients}`, `- Treatments: ${r.treatments} (patients with treatments: ${r.patients_with_treatments})`,
  `- Visits (patient + day): ${r.visits}`, `- Attachment links: ${r.attachment_links} (patients: ${r.patients_with_attachments})`,
  `- Files listed in Clinica but not downloaded: ${r.files_listed_not_downloaded} (patients: ${r.patients_with_files_not_downloaded})`,
  `- Descriptions cleaned: ${r.descriptions_cleaned}; details moved to the note: ${r.details_moved_to_note}`,
  `- Clinical rows: ${r.clinical_rows_before} → ${r.clinical_rows_kept} kept (${r.clinical_tables_dropped} tables without patient data left out)`,
  `- Doctors after merge: ${r.doctors_after_merge}`, '',
  '| Doctor | Spellings in Clinica | Treatments | Kind |', '|---|---|---|---|',
  ...doctors.map((d) => `| ${d.name} | ${d.spellings.map((s) => `\`${s}\``).join(', ')} | ${d.treatments} | ${d.kind} |`), '',
  '## Chairs and treatments without a doctor → doctor (as the import will do)', '',
  `- Patient's doctor of the day / usual doctor: ${r.inferred.same_day_or_usual}`, `- Doctor seen most with that clinic number: ${r.inferred.clinic_number}`, `- Still no doctor: ${r.inferred.none}`, '',
  ...Object.entries(r.inferred_by_name).map(([n, m]) => `- ${n}: ${Object.entries(m).sort((a, b) => b[1] - a[1]).map(([d, c]) => `${d} ${c}`).join(', ')}`), '',
  '## Groups', '', ...Object.entries(r.groups).sort((a, b) => b[1] - a[1]).map(([g, n]) => `- ${g}: ${n}`), '',
];
fs.writeFileSync(path.join(outDir, 'clinica-report.md'), md.join('\n'));
console.log(md.join('\n'));
