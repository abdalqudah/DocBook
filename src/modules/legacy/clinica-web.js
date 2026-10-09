// Reading Clinica's own pages (for the direct pull, remote.service): the patients list, a patient's form, the
// treatments table of a patient's dental page and the appointments list of a calendar day. Tables are read by their
// header labels (Clinica's English labels, as its pages show them), a form by its field names; a patient's Clinica id
// comes from the links in a row (/edit_patient/<id>, /dental/<id>…), never from a name.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', laquo: '«', raquo: '»' };
const decode = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return NAMED[e.toLowerCase()] ?? m;
});
/** A piece of HTML as text: tags out, line breaks kept as new lines, spaces tidied. */
const textOf = (html) => decode(String(html || '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|tr)>/gi, '\n').replace(/<[^>]+>/g, ' '))
  .split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
const attr = (tag, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag); return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null; };
const norm = (h) => String(h || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Every table of a page: { headers: [label], rows: [{ cells: [{ text, html }], links: [href], cls }] }. */
function tables(html) {
  return (String(html || '').match(/<table\b[\s\S]*?<\/table>/gi) || []).map((t) => {
    const headers = (t.match(/<th\b[\s\S]*?<\/th>/gi) || []).map((h) => textOf(h).replace(/\n/g, ' '));
    const rows = (t.match(/<tr\b[\s\S]*?<\/tr>/gi) || []).filter((r) => /<td\b/i.test(r)).map((r) => ({
      cls: attr(r.slice(0, r.indexOf('>') + 1), 'class') || '',
      cells: (r.match(/<td\b[\s\S]*?<\/td>/gi) || []).map((c) => ({ text: textOf(c), html: c })),
      links: (r.match(/href\s*=\s*("[^"]*"|'[^']*')/gi) || []).map((h) => decode(h.replace(/^href\s*=\s*/i, '').slice(1, -1))),
    }));
    return { headers, rows };
  });
}
/** The first table having every one of `need` among its headers → rows as { Header: text } (+ links, cls, html). */
function tableBy(html, need) {
  const t = tables(html).find((x) => need.every((h) => x.headers.some((y) => norm(y) === norm(h))));
  if (!t) return null;
  return t.rows.map((r) => {
    const o = { links: r.links, cls: r.cls, cellHtml: {} };
    t.headers.forEach((h, i) => { if (r.cells[i]) { o[h] = r.cells[i].text; o.cellHtml[h] = r.cells[i].html; } });
    return o;
  });
}
/** A Clinica patient id in a row's links (/edit_patient/<id>, /dental/<id>, /patient_summary/<id>…), or null. */
const idIn = (links) => { for (const l of links || []) { const m = /\/(?:ar\/)?(?:edit_patient|dental|patient_summary|patient_payments)\/(\d+)/.exec(l); if (m) return m[1]; } return null; }; // eslint-disable-line no-restricted-syntax

/** The values a form shows: text / hidden inputs, checked boxes, the chosen option of a select (text and value), textareas. */
function formValues(html) {
  const v = {};
  const h = String(html || '');
  (h.match(/<input\b[^>]*>/gi) || []).forEach((t) => {
    const name = attr(t, 'name'); if (!name) return;
    const type = (attr(t, 'type') || 'text').toLowerCase();
    if (['submit', 'button', 'file', 'image', 'password'].includes(type)) return;
    if (type === 'checkbox' || type === 'radio') { if (/\schecked\b/i.test(t)) v[name] = attr(t, 'value') ?? 'on'; return; }
    v[name] = attr(t, 'value') ?? '';
  });
  (h.match(/<select\b[\s\S]*?<\/select>/gi) || []).forEach((s) => {
    const name = attr(s.slice(0, s.indexOf('>') + 1), 'name'); if (!name) return;
    const chosen = (s.match(/<option\b[^>]*\sselected\b[^>]*>[\s\S]*?(?=<option\b|<\/select>)/gi) || []).map((o) => ({ value: attr(o.slice(0, o.indexOf('>') + 1), 'value'), text: textOf(o.slice(o.indexOf('>') + 1)) }))
      .filter((o) => o.value !== '' && o.value !== '_none' && o.value !== '0');
    v[name] = chosen.map((o) => o.text).join(', ');
  });
  (h.match(/<textarea\b[\s\S]*?<\/textarea>/gi) || []).forEach((t) => {
    const name = attr(t.slice(0, t.indexOf('>') + 1), 'name'); if (!name) return;
    v[name] = decode(t.slice(t.indexOf('>') + 1).replace(/<\/textarea>$/i, '')).trim();
  });
  return v;
}

/** The patients list (/patients?page=N) → [{ id, number, name, mobile, telephone, group, nationality }]. */
function patientsList(html) {
  const rows = tableBy(html, ['Name', 'Mobile']) || [];
  return rows.map((r) => ({ id: idIn(r.links), number: r['Patient Number'] || '', name: (r.Name || '').replace(/\n/g, ' '), mobile: r.Mobile || '', telephone: r['Tel. No'] || r['Tel. No.'] || '', group: r.Group || '', nationality: r.Nationality || '' }))
    .filter((p) => p.id);
}

/** A patient's form (/edit_patient/<id>) → the patient's details as DocBook fields (empty ones left out). */
function patientDetails(html) {
  const f = String(html || '').match(/<form\b[^>]*action\s*=\s*["'][^"']*edit_patient[\s\S]*?<\/form>/i);
  const v = formValues(f ? f[0] : html);
  const pick = (...names) => { for (const n of names) { const x = v[n]; if (x !== undefined && String(x).trim()) return String(x).trim(); } return null; }; // eslint-disable-line no-restricted-syntax
  const g = norm(pick('p_gender'));
  return {
    number: pick('p_number'), name: pick('p_name'), name_en: pick('p_en_name'), mobile: pick('p_mobile_no'), telephone: pick('p_tel_no'), email: pick('p_email'),
    birth: pick('p_dob[date]', 'p_dob'), national_id: pick('p_national_num'), gender: /^(male|ذكر|m)$/.test(g) ? 'male' : /^(female|أنثى|انثى|f)$/.test(g) ? 'female' : null,
    nationality: pick('p_nationality'), group: pick('patient_group[]', 'patient_group'), address: pick('p_address'), occupation: pick('occupation'),
    important_note: pick('p_impoNote'), important_on_booking: v.p_show_impoNote ? true : null, medical_history: pick('p_medical_history'),
    medications: pick('p_medication'), general_note: pick('p_general_note'),
  };
}

/** The treatments table of a patient's dental page → treatments in the backup's shape (date, tooth, description…). */
function dentalTreatments(html) {
  const rows = tableBy(html, ['Date', 'Tooth', 'Description', 'Doctor', 'Price', 'Status']) || tableBy(html, ['Date', 'Tooth', 'Description', 'Doctor']) || [];
  return rows.map((r) => ({
    date: r.Date || '', tooth: (r.Tooth || '').replace(/\n/g, ' '), description: r.Description || '', doctor: (r.Doctor || '').replace(/\n/g, ' '), price: r.Price || '',
    type: r.Type || '', status: r.Status || '', complete_date: r['Complete Date'] || '', note: r.Note || '', referred_by: r['Referred by'] || '',
  })).filter((t) => /\d/.test(t.date) && (t.description || t.tooth));
}

const STATUS = [[/cancel/i, 'cancelled'], [/miss|no.?show/i, 'no_show'], [/complete|served|checkout/i, 'completed'], [/confirm/i, 'confirmed']];
// Clinica's call outcomes (radio buttons beside the status): no-answer, recall → the appointment's call outcome.
const CALL = [[/no.?answer/i, 'no_answer'], [/recall/i, 'recall']];
/** A calendar day's appointments list (/ncalendar?date=…) → [{ time, id, number, name, mobile, calendar, doctor, status }]. */
function calendarDay(html) {
  const rows = tableBy(html, ['Time', 'Patient Name', 'Calendar']) || [];
  if (!rows.length) return calendarGrid(html);
  return rows.map((r) => {
    const st = STATUS.find(([re]) => re.test(r.cls || '') || re.test(r.Status || ''));
    const call = CALL.find(([re]) => re.test(r.cls || '') || re.test(r.Status || ''));
    const note = String(r.Note || r.Notes || r.Comment || r.Comments || '').replace(/\s+/g, ' ').trim();
    return { callStatus: call ? call[1] : null, note: note || null, time: r.Time || '', id: idIn(r.links), number: r['Patient Number'] || '', name: (r['Patient Name'] || '').replace(/\n/g, ' '), mobile: r.Mobile || '', calendar: (r.Calendar || '').replace(/\n/g, ' '), doctor: (r.Doctor || '').replace(/\n/g, ' '), status: st ? st[1] : null };
  }).filter((a) => a.name || a.id);
}

/** The day grid (rows: times, columns: calendars) when the page has no list: each patient link in a cell is an appointment. */
function calendarGrid(html) {
  const t = tables(html).find((x) => x.headers.length > 2 && norm(x.headers[0]) === 'time');
  if (!t) return [];
  const out = [];
  t.rows.forEach((r) => {
    const time = r.cells[0] ? r.cells[0].text : '';
    r.cells.slice(1).forEach((c, i) => {
      const cal = t.headers[i + 1] || '';
      const re = /<a\b[^>]*href\s*=\s*["']([^"']*\/(?:edit_patient|dental|patient_summary)\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = re.exec(c.html))) out.push({ time, id: m[2], number: '', name: textOf(m[3]).replace(/\n/g, ' '), mobile: '', calendar: cal, doctor: '', status: null }); // eslint-disable-line no-cond-assign
    });
  });
  const seen = new Set();
  return out.filter((a) => { const k = `${a.time}|${a.id}|${a.calendar}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

module.exports = { calendarGrid, decode, textOf, tables, tableBy, formValues, patientsList, patientDetails, dentalTreatments, calendarDay, idIn };
