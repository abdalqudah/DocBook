// Reads one record of the Clinica backup into plain parts — the old patient's identity, phones, group, links, its
// treatments, its clinical tables and its attachment links — and keeps every other field as (field, value) pairs so
// nothing of the source is lost (clinical tables that hold no patient data — Clinica's empty forms, copies of the
// treatments table — are left out: clinica-clean.clinicalRows). Field names are matched loosely (case, spaces, dashes and underscores ignored)
// against the names the backup uses for each part; the patient's identity is the old id (never the name).
const crypto = require('crypto');
const { clinicalRows } = require('./clinica-clean');

const norm = (k) => String(k).toLowerCase().replace(/[\s_\-.]+/g, '');
const ALIASES = {
  id: ['patient_id', 'legacy_patient_id', 'patientid', 'pid', 'id'],
  number: ['patient_number', 'patient_no', 'patientnumber', 'file_number', 'file_no', 'number', 'no', 'code'],
  name: ['patient_name', 'full_name', 'fullname', 'name', 'arabic_name'],
  mobile: ['mobile', 'mobile_number', 'mobile_no', 'cell', 'cellphone', 'phone'],
  telephone: ['telephone', 'tel', 'tel_no', 'telephone_number', 'home_phone', 'phone2', 'landline'],
  group: ['group', 'groups', 'patient_group', 'group_name'],
  nationality: ['nationality', 'nation', 'country'],
  gender: ['gender', 'sex'],
  birth: ['birth_date', 'date_of_birth', 'dob', 'birthday', 'birthdate'],
  email: ['email', 'e_mail', 'mail'],
  url: ['url', 'source_url', 'profile_url', 'link', 'page_url', 'patient_url'],
  urls: ['urls', 'links', 'source_urls', 'pages'],
  treatments: ['treatments', 'treatment', 'dental_treatments', 'procedures'],
  clinical: ['clinical_tables', 'clinicaltables', 'clinical', 'clinical_records'],
  attachments: ['attachments', 'attachment_links', 'files', 'documents'],
};
const T_ALIASES = {
  id: ['treatment_id', 'id', 'tid'],
  patient: ['patient_id', 'legacy_patient_id', 'patientid', 'pid'],
  date: ['date', 'treatment_date', 'visit_date', 'created', 'created_at', 'start_date'],
  tooth: ['tooth', 'teeth', 'tooth_no', 'tooth_number', 'tooth_num'],
  description: ['description', 'treatment', 'procedure', 'details', 'title', 'name', 'treatment_name'],
  doctor: ['doctor', 'doctor_name', 'dr', 'provider', 'dentist'],
  price: ['price', 'cost', 'amount', 'fee', 'total', 'fees'],
  type: ['type', 'treatment_type', 'category', 'kind'],
  status: ['status', 'state'],
  complete: ['complete_date', 'completed_date', 'completion_date', 'done_date', 'completed_at', 'completed_on'],
  note: ['note', 'notes', 'comment', 'comments', 'remarks'],
  referred: ['referred_by', 'referredby', 'referral', 'referrer', 'referred'],
};
const A_ALIASES = {
  url: ['url', 'source_url', 'link', 'href', 'download_url'],
  name: ['original_filename', 'filename', 'file_name', 'name', 'title'],
};

function pickKey(obj, names) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = Object.keys(obj);
  for (const n of names) { const k = keys.find((x) => norm(x) === norm(n)); if (k !== undefined) return k; }
  return null;
}
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const text = (v, max = 1000) => (v === null || v === undefined ? null : String(typeof v === 'object' ? JSON.stringify(v) : v).trim().slice(0, max) || null);

/** An object's fields as (field, value) pairs: nested objects as a.b, lists as a[0].b — values as text. */
function flatten(value, prefix = '', out = []) {
  if (isScalar(value)) { out.push([prefix || 'value', value === null ? null : String(value)]); return out; }
  if (Array.isArray(value)) {
    if (value.every(isScalar)) { out.push([prefix || 'value', value.map((x) => (x === null ? '' : String(x))).join(' | ')]); return out; }
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

/** The old id as text (numbers and strings both), or null. */
function legacyId(record) {
  const k = pickKey(record, ALIASES.id);
  const v = k === null ? null : record[k];
  return isScalar(v) && v !== null && String(v).trim() ? String(v).trim().slice(0, 64) : null;
}

/** Rows of a clinical table, whatever its shape: list of objects, {headers, rows}, list of lists, or one object. */
function tableRows(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    if (!value.length) return [];
    if (value.every((r) => Array.isArray(r))) {
      const [head, ...rest] = value;
      const named = head.every((h) => typeof h === 'string') && rest.length;
      return (named ? rest : value).map((r) => Object.fromEntries(r.map((v, i) => [named ? head[i] || `col${i + 1}` : `col${i + 1}`, v])));
    }
    return value.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r : { value: r }));
  }
  if (typeof value === 'object') {
    const hk = pickKey(value, ['headers', 'columns', 'head']);
    const rk = pickKey(value, ['rows', 'data', 'body', 'records']);
    if (hk && rk && Array.isArray(value[hk]) && Array.isArray(value[rk])) {
      const heads = value[hk].map((h, i) => (h && typeof h === 'object' ? text(h.label || h.name || h.title) : text(h)) || `col${i + 1}`);
      return value[rk].map((r) => (Array.isArray(r) ? Object.fromEntries(r.map((v, i) => [heads[i] || `col${i + 1}`, v])) : (r && typeof r === 'object' ? r : { value: r })));
    }
    if (rk && Array.isArray(value[rk])) return tableRows(value[rk]);
    return [value];
  }
  return [{ value }];
}

const fingerprint = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 40);

/** One treatment → its columns + the other fields; row_key = the old id, else a fingerprint of its content. */
function treatment(t, position) {
  const o = t && typeof t === 'object' && !Array.isArray(t) ? t : { description: t };
  const used = new Set();
  const get = (names, max) => { const k = pickKey(o, names); if (k === null) return null; used.add(k); return text(o[k], max); };
  const id = get(T_ALIASES.id, 64);
  get(T_ALIASES.patient, 64);
  const priceRaw = get(T_ALIASES.price, 60);
  const priceNum = priceRaw !== null ? Number(String(priceRaw).replace(/[^\d.-]/g, '')) : null;
  const row = {
    row_key: id ? `id:${id}`.slice(0, 64) : `fp:${fingerprint(o)}:${position}`.slice(0, 64), position,
    treatment_date: get(T_ALIASES.date, 40), tooth: get(T_ALIASES.tooth, 60), description: get(T_ALIASES.description, 5000),
    doctor: get(T_ALIASES.doctor, 190), price_raw: priceRaw, price: priceRaw !== null && Number.isFinite(priceNum) && String(priceRaw).match(/\d/) ? priceNum : null,
    type: get(T_ALIASES.type, 120), status: get(T_ALIASES.status, 60), complete_date: get(T_ALIASES.complete, 40),
    note: get(T_ALIASES.note, 5000), referred_by: get(T_ALIASES.referred, 190),
  };
  row.treatment_on = isoDay(row.treatment_date);
  const extra = Object.keys(o).filter((k) => !used.has(k)).flatMap((k) => flatten(o[k], k));
  return { row, extra };
}

/** A date written as 2024-03-01, 01/03/2024 or 2024-03-01T10:00 → '2024-03-01' (else null). */
function isoDay(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  let y; let mo; let d;
  if (m) [, y, mo, d] = m.map(Number);
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s))) { [, d, mo, y] = m.map(Number); }
  else return null;
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) || new Date(`${iso}T00:00:00Z`).getUTCDate() !== d ? null : iso;
}

/** A patient record of the backup → { id, number, name, …, treatments, clinical, attachments, links, extra }. */
function patient(record) {
  const r = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  const used = new Set();
  const get = (names, max) => { const k = pickKey(r, names); if (k === null) return null; used.add(k); return isScalar(r[k]) ? text(r[k], max) : text(r[k], max); };
  const id = legacyId(r); used.add(pickKey(r, ALIASES.id));
  const out = {
    id, number: get(ALIASES.number, 64), name: get(ALIASES.name, 190), mobile: get(ALIASES.mobile, 60), telephone: get(ALIASES.telephone, 60),
    group: null, nationality: get(ALIASES.nationality, 100), gender: get(ALIASES.gender, 20), birth: get(ALIASES.birth, 40), email: get(ALIASES.email, 190),
    links: [], treatments: [], clinical: [], attachments: [], extra: [],
  };
  const gk = pickKey(r, ALIASES.group);
  if (gk !== null) { used.add(gk); const g = r[gk]; out.group = text(Array.isArray(g) ? g.map((x) => (x && typeof x === 'object' ? x.name || x.title || JSON.stringify(x) : x)).join(' | ') : (g && typeof g === 'object' ? g.name || g.title || JSON.stringify(g) : g), 190); }
  const uk = pickKey(r, ALIASES.url);
  if (uk !== null) { used.add(uk); if (text(r[uk])) out.links.push({ label: null, url: text(r[uk], 1000) }); }
  const usk = pickKey(r, ALIASES.urls);
  if (usk !== null) {
    used.add(usk);
    const v = r[usk];
    const list = Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.entries(v).map(([label, url]) => ({ label, url })) : [v]);
    list.forEach((x) => { const url = x && typeof x === 'object' ? text(x.url || x.href || x.link, 1000) : text(x, 1000); if (url) out.links.push({ label: x && typeof x === 'object' ? text(x.label || x.name || x.title, 190) : null, url }); });
  }
  const tk = pickKey(r, ALIASES.treatments);
  if (tk !== null) { used.add(tk); const list = Array.isArray(r[tk]) ? r[tk] : tableRows(r[tk]); out.treatments = list.map((t, i) => treatment(t, i)); }
  const ck = pickKey(r, ALIASES.clinical);
  if (ck !== null) {
    used.add(ck);
    const c = r[ck];
    const tables = c && typeof c === 'object' && !Array.isArray(c) ? Object.entries(c) : (Array.isArray(c) ? c.map((x, i) => [text(x && (x.table || x.name || x.key), 60) || `table_${i + 1}`, x && (x.rows || x.data || x)]) : []);
    for (const [key, val] of tables) {
      // Clinica's empty forms, copies of the treatments table and "No … found." rows carry no patient data.
      const rows = tableRows(clinicalRows(val));
      if (!rows.length) continue; // eslint-disable-line no-continue
      out.clinical.push({ key: String(key).replace(/[^\p{L}\p{N}_\- ]+/gu, '').trim().slice(0, 60) || 'table', rows: rows.map((row, i) => ({ row_key: `fp:${fingerprint(row)}:${i}`.slice(0, 64), position: i, values: flatten(row) })) });
    }
  }
  const ak = pickKey(r, ALIASES.attachments);
  if (ak !== null) {
    used.add(ak);
    const list = Array.isArray(r[ak]) ? r[ak] : [];
    out.attachments = list.map((a) => (a && typeof a === 'object' ? { url: text(a[pickKey(a, A_ALIASES.url)], 1000), name: text(a[pickKey(a, A_ALIASES.name)], 255) } : { url: text(a, 1000), name: null })).filter((a) => a.url || a.name);
    out.attachments.forEach((a) => { if (a.url && !out.links.some((l) => l.url === a.url)) { /* attachment links are files, not pages */ } });
  }
  out.extra = Object.keys(r).filter((k) => !used.has(k)).flatMap((k) => flatten(r[k], k));
  return out;
}

/** Which patient an element of a separate top-level list (treatments: [...]) belongs to. */
const ownerOf = (el) => { const k = pickKey(el, T_ALIASES.patient); return k !== null && isScalar(el[k]) && el[k] !== null ? String(el[k]).trim().slice(0, 64) : null; };

/** The role of a top-level list of the backup by its name. */
function roleOf(path) {
  const n = norm(path || '');
  if (!n || ['patients', 'patient', 'records', 'data', 'items', 'rows'].includes(n)) return 'patients';
  if (ALIASES.treatments.map(norm).includes(n)) return 'treatments';
  if (ALIASES.attachments.map(norm).includes(n) || n === 'attachmentlinks') return 'attachments';
  if (['appointments', 'appointment', 'visits', 'bookings', 'calendar', 'reservations', 'sessions'].includes(n)) return 'appointments';
  if (n.startsWith('clinical') || ['periodontal', 'pocketmeasurements', 'pocketdistribution', 'anesthesia', 'treatmentdetails1', 'treatmentdetails2'].includes(n)) return 'clinical';
  return 'other';
}

module.exports = { norm, pickKey, flatten, legacyId, tableRows, treatment, patient, ownerOf, roleOf, isoDay, ALIASES, T_ALIASES };
