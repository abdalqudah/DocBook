// The PDF documents given to a patient: the prescription and the consultation report (summary), plus a medical
// certificate issued in the certificates module (rendered here from its stored snapshot, with its QR code).
// Every builder takes plain data (see docs.service.js) and a locale, and resolves with the PDF bytes.
const QRCode = require('qrcode');
const { translator } = require('../../core/i18n');
const { formatDate } = require('../../core/format');
const { Writer, ltr, colors: C } = require('./pdf');
const signatures = require('../signatures/signatures.service');

const pick = (en, a, b) => (en ? b || a : a || b) || '';

function dateText(v, locale) {
  if (!v) return '';
  try { return formatDate(v, locale, { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return String(v).slice(0, 10); }
}

/** Letterhead: logo at the start side, clinic name and contacts; returns the writer for chaining. */
function letterhead(w, clinic, locale) {
  const en = locale === 'en';
  const top = w.y;
  let textX = w.left;
  let textW = w.width;
  if (clinic.logo) {
    const box = w.image(clinic.logo, { side: 'start', height: 54, maxWidth: 120, y: top });
    if (box) { textW = w.width - box.w - 16; if (!w.rtl) textX = w.left + box.w + 16; }
  }
  w.text(pick(en, clinic.name, clinic.name_en), { size: 16, bold: true, x: textX, width: textW, y: top });
  const lines = [
    [pick(en, clinic.address, clinic.address_en), clinic.city].filter(Boolean).join(' · '),
    [clinic.phone ? ltr(clinic.phone) : '', clinic.email ? ltr(clinic.email) : ''].filter(Boolean).join('   '),
  ].filter(Boolean);
  lines.forEach((l) => w.text(l, { size: 9, color: C.textMuted, x: textX, width: textW }));
  w.y = Math.max(w.y, top + 58);
  w.rule({ gap: 10, color: C.borderStrong });
}

/** Document title at the start side, reference/date at the end side (same line). */
function titleRow(w, title, meta) {
  const y = w.y;
  w.text(title, { size: 15, bold: true, y, fixed: true, width: w.width * 0.6, x: w.rtl ? w.right - w.width * 0.6 : w.left });
  meta.forEach((m, i) => w.text(m, { size: 9, color: C.textMuted, y: y + i * 15, fixed: true, align: 'end', lineHeight: 15 }));
  w.y = y + Math.max(30, meta.length * 15 + 6);
}

function section(w, label) {
  w.ensure(40);
  w.space(6);
  w.text(label, { size: 9, color: C.textSubtle, bold: true, gap: 0 });
}

/**
 * The images of the signature area: `d.marks` when the caller passed them, else the clinic's stamp (if switched on
 * for this kind of document) and the signature of `doctorId` — the doctor printed on the document, nobody else.
 */
async function marksFor(d, kind, doctorId) {
  if (d.marks !== undefined) return d.marks || {};
  if (!d.clinic || !d.clinic.id) return {};
  try { return await signatures.forDocument(d.clinic.id, kind, doctorId); } catch { return {}; }
}

/**
 * Signature line at the end side with the doctor's name under it. With `marks.signature` the signature image sits
 * on the line; with `marks.stamp` the stamp sits beside the signature (towards the page's start side).
 */
function signature(w, doctorName, t, marks = {}) {
  const sig = marks.signature || null;
  const stamp = marks.stamp || null;
  const lineW = 190;
  const stampSize = 84;
  const lift = sig || stamp ? 62 : 34; // room above the line
  w.ensure(lift + 60);
  w.space(lift);
  const x = w.rtl ? w.left : w.right - lineW; // the signature sits at the end side
  const lineY = w.y;
  if (sig) w.fitImage(sig, x + 20, w.y - 58, lineW - 40, 56, { align: 'center', valign: 'bottom' });
  if (stamp) {
    const sx = w.rtl ? x + lineW + 18 : x - 18 - stampSize;
    w.fitImage(stamp, sx, w.y - 58, stampSize, stampSize, { align: 'center', valign: 'center' });
  }
  w.doc.moveTo(x, w.y).lineTo(x + lineW, w.y).lineWidth(0.8).strokeColor(C.borderStrong).stroke();
  w.space(4);
  w.text(doctorName ? `${t('patient_docs.pdf.signature')} — ${doctorName}` : t('patient_docs.pdf.signature'), { size: 9, color: C.textMuted, x, width: lineW, align: 'center' });
  if (stamp) w.y = Math.max(w.y, lineY - 58 + stampSize + 4); // below the stamp
}

function footer(w, clinicName, ref, t) {
  w.footer(`${clinicName} · ${ref}`, (i, n) => t('patient_docs.pdf.page', { i, n }));
}

function doctorFields(d, locale, t) {
  const en = locale === 'en';
  return [
    { label: t('patient_docs.pdf.doctor'), value: pick(en, d.doctor_name, d.doctor_name_en) || '—' },
    { label: t('patient_docs.pdf.specialty'), value: pick(en, d.specialization, d.specialization_en) || '—' },
    { label: t('patient_docs.pdf.licence'), value: d.license_number ? ltr(d.license_number) : '—' },
  ];
}

function patientFields(d, locale, t) {
  return [
    { label: t('patient_docs.pdf.patient'), value: d.patient_name || '—' },
    { label: t('patient_docs.pdf.age'), value: d.age !== null && d.age !== undefined ? t('patient_docs.pdf.age_years', { n: d.age }) : '—' },
    { label: t('patient_docs.pdf.gender'), value: d.gender ? t(`patient_docs.pdf.genders.${d.gender}`) : '—' },
    { label: t('patient_docs.pdf.visit_date'), value: dateText(d.visit_date, locale) || '—' },
  ];
}

/**
 * Prescription.
 * @param d { clinic, rx: { id, created_at, diagnosis, notes, items[] }, doctor fields, patient_name, age, gender, visit_date, online }
 */
/** ICD-10 codes of the visit, one per line: "E11.9 — title" (primary first). */
function codeLines(w, codes, locale) {
  (codes || []).forEach((c) => {
    const title = (locale === 'en' ? c.title_en || c.title_ar : c.title_ar || c.title_en) || '';
    w.text(`${ltr(c.code)} — ${title}`, { size: 10, gap: 2, bold: Boolean(c.is_primary) });
  });
}

async function prescription(d, locale = 'ar') {
  const t = translator(locale);
  const en = locale === 'en';
  const clinicName = pick(en, d.clinic.name, d.clinic.name_en);
  const w = new Writer({ locale, title: `${t('patient_docs.kinds.prescription')} #${d.rx.id}`, author: clinicName, subject: d.patient_name });
  letterhead(w, d.clinic, locale);
  titleRow(w, t('patient_docs.kinds.prescription'), [t('patient_docs.pdf.rx_no', { n: d.rx.id }), dateText(d.rx.created_at, locale)]);
  w.fields(doctorFields(d, locale, t), { cols: 3, size: 10 });
  w.fields(patientFields(d, locale, t), { cols: 4, size: 10 });
  if (d.rx.diagnosis || (d.codes && d.codes.length)) {
    section(w, t('patient_docs.pdf.diagnosis'));
    if (d.rx.diagnosis) w.text(d.rx.diagnosis, { size: 10.5, gap: 4 });
    codeLines(w, d.codes, locale);
  }
  w.rule({ gap: 8 });
  w.text('Rx', { size: 18, bold: true, color: C.primary, gap: 2, align: 'start' });
  const numW = 24;
  (d.rx.items || []).forEach((it, i) => {
    w.ensure(60);
    const y = w.y;
    const numX = w.rtl ? w.right - numW : w.left;
    const bodyX = w.rtl ? w.left : w.left + numW;
    w.text(`${i + 1}.`, { size: 12, bold: true, x: numX, width: numW, y, fixed: true, color: C.textMuted });
    w.text(it.medicationName || '—', { size: 12, bold: true, x: bodyX, width: w.width - numW });
    const dose = [it.dosage, it.frequency, it.duration].filter(Boolean).join(' — ');
    if (dose) w.text(dose, { size: 10.5, x: bodyX, width: w.width - numW });
    if (it.instructions) w.text(it.instructions, { size: 9.5, color: C.textMuted, x: bodyX, width: w.width - numW });
    w.space(8);
  });
  if (d.rx.notes) { section(w, t('patient_docs.pdf.notes')); w.text(d.rx.notes, { size: 10, gap: 4 }); }
  if (d.online) { w.space(6); w.text(t('patient_docs.pdf.online_note'), { size: 9, color: C.textMuted }); }
  // The signature of the visit's doctor (the one printed above) — only when the prescription is theirs.
  const rxDoctor = d.a && d.a.doctor_id && (!d.rx.doctor_id || d.rx.doctor_id === d.a.doctor_id) ? d.a.doctor_id : null;
  signature(w, pick(en, d.doctor_name, d.doctor_name_en), t, await marksFor(d, 'prescriptions', rxDoctor));
  footer(w, clinicName, t('patient_docs.pdf.rx_no', { n: d.rx.id }), t);
  return w.end();
}

const REPORT_SECTIONS = ['diagnosis', 'subjective', 'objective', 'assessment', 'plan_text', 'vitals'];
const VITAL_KEYS = ['bloodPressure', 'pulseBpm', 'temperatureC', 'spo2', 'respiratoryRate', 'bloodSugar', 'weightKg', 'heightCm'];
const VITAL_UNITS = { bloodPressure: 'mmHg', pulseBpm: 'bpm', temperatureC: '°C', spo2: '%', respiratoryRate: '/min', bloodSugar: 'mg/dL', weightKg: 'kg', heightCm: 'cm' };

/**
 * Consultation report (summary): only the sections the doctor chose.
 * @param d { clinic, consult, sections[], doctor fields, patient_name, age, gender, visit_date, online, appointment_id }
 */
async function report(d, locale = 'ar') {
  const t = translator(locale);
  const en = locale === 'en';
  const clinicName = pick(en, d.clinic.name, d.clinic.name_en);
  const w = new Writer({ locale, title: t('patient_docs.kinds.report'), author: clinicName, subject: d.patient_name });
  letterhead(w, d.clinic, locale);
  titleRow(w, t('patient_docs.kinds.report'), [t('patient_docs.pdf.visit_no', { n: d.appointment_id }), dateText(d.visit_date, locale)]);
  w.fields(doctorFields(d, locale, t), { cols: 3, size: 10 });
  w.fields(patientFields(d, locale, t), { cols: 4, size: 10 });
  if (d.online) w.text(t('patient_docs.pdf.online_report_note'), { size: 9, color: C.textMuted, gap: 2 });
  w.rule({ gap: 8 });
  const c = d.consult || {};
  const chosen = REPORT_SECTIONS.filter((s) => (d.sections || []).includes(s));
  let wrote = 0;
  chosen.forEach((s) => {
    if (s === 'vitals') {
      const v = c.vital_signs || {};
      const items = VITAL_KEYS.filter((k) => v[k] !== undefined && v[k] !== null && v[k] !== '')
        .map((k) => ({ label: t(`patient_docs.pdf.vitals.${k}`), value: ltr(`${v[k]} ${VITAL_UNITS[k]}`) }));
      if (!items.length) return;
      section(w, t('patient_docs.sections.vitals'));
      w.fields(items, { cols: 4, size: 10, gap: 4 });
      wrote += 1;
      return;
    }
    const codes = s === 'diagnosis' && d.codes && d.codes.length ? d.codes : null;
    if (!c[s] && !codes) return;
    section(w, t(`patient_docs.sections.${s}`));
    if (c[s]) w.text(c[s], { size: s === 'diagnosis' ? 12 : 10.5, bold: s === 'diagnosis', gap: 6 });
    if (codes) codeLines(w, codes, locale);
    wrote += 1;
  });
  if (!wrote) w.text(t('patient_docs.pdf.nothing'), { size: 10, color: C.textMuted });
  signature(w, pick(en, d.doctor_name, d.doctor_name_en), t, await marksFor(d, 'reports', d.a ? d.a.doctor_id : null));
  footer(w, clinicName, t('patient_docs.pdf.visit_no', { n: d.appointment_id }), t);
  return w.end();
}

/**
 * A certificate from the certificates module (sick leave, medical report, attendance) — its stored snapshot,
 * the verification code and a QR code pointing to the public verification page.
 * @param d { clinic, cert (certificates row, parsed), verifyUrl, age }
 */
async function certificate(d, locale) {
  const cert = d.cert;
  const loc = cert.language === 'en' ? 'en' : (locale || 'ar');
  const t = translator(loc);
  const en = loc === 'en';
  const clinicName = pick(en, cert.clinic_name || d.clinic.name, cert.clinic_name_en || d.clinic.name_en);
  const title = t(`patient_docs.cert_types.${cert.doc_type}`);
  const w = new Writer({ locale: loc, title: `${title} ${cert.serial}`, author: clinicName, subject: cert.patient_name });
  letterhead(w, d.clinic, loc);
  titleRow(w, title, [ltr(cert.serial), dateText(cert.issued_at, loc)]);
  w.fields([
    { label: t('patient_docs.pdf.doctor'), value: pick(en, cert.doctor_name, cert.doctor_name_en) || '—' },
    { label: t('patient_docs.pdf.specialty'), value: pick(en, cert.doctor_specialty, cert.doctor_specialty_en) || '—' },
    { label: t('patient_docs.pdf.licence'), value: cert.doctor_license ? ltr(cert.doctor_license) : '—' },
  ], { cols: 3, size: 10 });
  w.fields([
    { label: t('patient_docs.pdf.patient'), value: cert.patient_name || '—' },
    { label: t('patient_docs.pdf.visit_date'), value: dateText(cert.visit_date, loc) || '—' },
    ...(cert.doc_type === 'sick_leave' ? [
      { label: t('patient_docs.pdf.leave_from'), value: dateText(cert.leave_start, loc) },
      { label: t('patient_docs.pdf.leave_to'), value: dateText(cert.leave_end, loc) },
    ] : []),
    ...(cert.doc_type === 'attendance' && cert.time_from ? [{ label: t('patient_docs.pdf.time'), value: ltr(`${cert.time_from} – ${cert.time_to || ''}`) }] : []),
  ], { cols: 4, size: 10 });
  w.rule({ gap: 8 });
  if (cert.doc_type === 'sick_leave') {
    w.text(t('patient_docs.pdf.leave_text', { days: cert.leave_days, from: dateText(cert.leave_start, loc), to: dateText(cert.leave_end, loc) }), { size: 11, gap: 6 });
    if (cert.companion_leave && cert.companion_name) w.text(t('patient_docs.pdf.companion', { name: cert.companion_name, relation: cert.companion_relation || '' }), { size: 10.5, gap: 6 });
  }
  if (cert.show_diagnosis && cert.diagnosis) { section(w, t('patient_docs.pdf.diagnosis')); w.text(cert.diagnosis, { size: 10.5, gap: 6 }); }
  const body = cert.body || {};
  if (typeof body.addressee === 'string' && body.addressee.trim()) w.text(t('patient_docs.pdf.addressee', { to: body.addressee }), { size: 10.5, bold: true, gap: 6 });
  ['findings', 'recommendations'].forEach((k) => {
    if (typeof body[k] === 'string' && body[k].trim()) { section(w, t(`patient_docs.pdf.cert_fields.${k}`)); w.text(body[k], { size: 10.5, gap: 6 }); }
  });
  if (Array.isArray(body.attachments) && body.attachments.length) {
    section(w, t('patient_docs.pdf.cert_fields.attachments'));
    body.attachments.forEach((a, i) => w.text(`${i + 1}. ${a}`, { size: 10 }));
  }
  if (cert.revoked_at) { w.space(6); w.text(t('patient_docs.pdf.revoked'), { size: 11, bold: true, color: C.danger }); }
  // QR + verification code at the end side.
  if (d.verifyUrl) {
    w.ensure(120);
    w.space(10);
    const png = await QRCode.toBuffer(d.verifyUrl, { type: 'png', margin: 1, width: 240, errorCorrectionLevel: 'M' });
    const size = 84;
    const x = w.rtl ? w.left : w.right - size;
    w.doc.image(png, x, w.y, { width: size, height: size });
    const tx = w.rtl ? w.left + size + 12 : w.left;
    const tw = w.width - size - 12;
    const y0 = w.y + 14;
    w.text(t('patient_docs.pdf.verify_hint'), { size: 9, color: C.textMuted, x: tx, width: tw, y: y0, fixed: true });
    w.text(ltr(d.verifyUrl), { size: 8.5, color: C.textMuted, x: tx, width: tw, y: y0 + 18, fixed: true });
    w.y += size + 6;
  }
  // A withdrawn certificate keeps no signature or stamp.
  signature(w, pick(en, cert.doctor_name, cert.doctor_name_en), t, cert.revoked_at ? {} : await marksFor(d, 'certificates', cert.doctor_id));
  footer(w, clinicName, ltr(cert.serial), t);
  return w.end();
}

module.exports = { prescription, report, certificate, marksFor, REPORT_SECTIONS, VITAL_KEYS };
