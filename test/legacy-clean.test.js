// Cleaning of the Clinica backup: descriptions as scraped from Clinica's page, chairs written where the doctor goes,
// English ↔ Arabic doctor names, the doctor of a chair's treatment, and clinical tables that hold no patient data.
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/modules/legacy/clinica-clean');

test('description: the name, and its details for the note', () => {
  const raw = 'Follow up     more...X\n      Chief Complaint\n      pain\n    \n      HPI\n      no complaints \n    \n   View Notes';
  assert.deepEqual(c.description(raw), { name: 'Follow up', details: [['Chief Complaint', 'pain'], ['HPI', 'no complaints']] });
  assert.deepEqual(c.cleanTreatment(raw).lines, ['Chief Complaint: pain', 'HPI: no complaints']);
  assert.equal(c.description('Examination\n        \n           View Notes').name, 'Examination');
  assert.equal(c.description('Examination     more... View Notes').name, 'Examination');
  assert.equal(c.description('Zircon Crown (bridge)').name, 'Zircon Crown (bridge)');
  assert.equal(c.description('').name, '');
});

test('chairs: "Clinic One" / "Clinic 2" / "عيادة 3" are not doctors', () => {
  assert.equal(c.chairOf('Clinic One'), 1); assert.equal(c.chairOf('clinic  five'), 5); assert.equal(c.chairOf('Clinic 2'), 2);
  assert.equal(c.chairOf('عيادة 3'), 3); assert.equal(c.chairOf('Clinic Lama'), null); assert.equal(c.chairOf('Lama Ashour'), null); assert.equal(c.chairOf(''), null);
  assert.equal(c.doctorName('Raghad  Kafina '), 'Raghad Kafina');
});

test('doctor names: English ↔ Arabic, titles and "al" ignored; relatives stay apart', () => {
  const same = [['Faris Qudah', 'د. فارس القضاة'], ['Dr Fares', 'د. فارس'], ['Raghad  Kafina', 'رغد كفينة'], ['Ruba qudah', 'ربى القضاة'],
    ['Mansour AlQudah', 'منصور القضاة'], ['Lama Ashour', 'لمى عاشور'], ['Anas Anshasi', 'أنس العنشاصي'], ['Haitham Rabadi', 'هيثم الربضي'], ['Yazan Samawi', 'يزن السماوي']];
  same.forEach(([a, b]) => assert.ok(c.sameDoctor(a, b), `${a} = ${b}`));
  assert.equal(c.sameDoctor('Zain Alqudah', 'منصور القضاة'), false);
  assert.equal(c.sameDoctor('Faris Qudah', 'فارس الخطيب'), false);
  const docs = [{ id: 1, names: ['د. فارس القضاة'] }, { id: 2, names: ['د. زين القضاة', 'Zain Alqudah'] }, { id: 3, names: ['لمى عاشور'] }];
  assert.equal(c.matchDoctor('Faris Qudah', docs), 1);
  assert.equal(c.matchDoctor('Zain Alqudah', docs), 2);
  assert.equal(c.matchDoctor('Rami Alshayeb', docs), null);
  assert.equal(c.matchDoctor('Fares', [...docs, { id: 4, names: ['فارس عبيدات'] }]), null, 'two doctors could be it → none');
});

test("a chair's treatment: the patient's doctor of that day, else the usual doctor, else the fallback", () => {
  const tr = [
    { id: 1, d: 'A', day: '2024-01-01' }, { id: 2, d: 'chair', day: '2024-01-01' },
    { id: 3, d: 'B', day: '2024-02-01' }, { id: 4, d: 'B', day: '2024-03-01' }, { id: 5, d: 'chair', day: '2024-04-01' },
  ];
  const opts = { needs: (t) => t.d === 'chair', doctorOf: (t) => t.d, dayOf: (t) => t.day };
  const got = c.inferDoctors(tr, opts);
  assert.equal(got.get(tr[1]), 'A', 'same day');
  assert.equal(got.get(tr[4]), 'B', 'usual doctor');
  const only = [{ d: 'chair', day: '2024-01-01' }];
  assert.equal(c.inferDoctors(only, opts).size, 0);
  assert.equal(c.inferDoctors(only, { ...opts, fallback: () => 'Z' }).get(only[0]), 'Z');
});

test('clinical tables: empty forms, copies of the treatments and "No … found." rows are left out', () => {
  const perio = [['Factor', 'Normal', 'Abnormal'], ['Plaque', 'Good', 'Poor'], ['Gingival Bleeding (BOP)', 'Absent', 'Present'], ['Calculus', 'Absent', 'Supragingival\n     \n    Subgingival']];
  assert.deepEqual(c.clinicalRows(perio), []);
  assert.deepEqual(c.clinicalRows([['Pocket Distribution', 'Localized\n\n   Generalized'], ['Treatment Notes', '']]), []);
  assert.deepEqual(c.clinicalRows([['Entry Date', 'Type of Anesthesia', 'Author', 'Delete'], ['No local anesthesia records found.']]), []);
  assert.deepEqual(c.clinicalRows([['Select / Print', 'Date', 'Tooth', 'Description', 'Doctor'], ['', '2022-01-01', '11', 'Filling', 'X']]), []);
  assert.deepEqual(c.clinicalRows([['-', 'File Name', 'Description', 'Upload Date', 'Delete']]), [], 'files table with no files');
  const files = [['-', 'File Name', 'Description', 'Upload Date', 'Delete'], ['', 'scan.pdf', '', '2025-02-01', '']];
  assert.deepEqual(c.clinicalRows(files), files, 'a files table with files is kept');
  const real = [['Factor', 'Value'], ['Plaque', '3 mm on 16']];
  assert.deepEqual(c.clinicalRows(real), real, 'a value that is not part of the form is kept');
  assert.deepEqual(c.clinicalRows([{ tooth: 16, depth: 3 }]), [{ tooth: 16, depth: 3 }], 'other shapes untouched');
});
