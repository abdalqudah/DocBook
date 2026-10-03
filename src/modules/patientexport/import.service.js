// Importing patient files exported from DocBook (one patient's ZIP, or every patient's ZIP) — each record goes back
// where it belongs: the patient, their visits, consultation notes and vital signs, diagnoses, prescriptions, tests,
// referrals, dental chart and plan, growth, pregnancies, and the stored files (X-rays, results) as they were.
//   analyze(ctx, file)        → what the file holds, which patients already exist here, which doctors need a match
//   start(ctx, token, input)  → imports in the background (progress + a report), one import at a time per clinic
// Rules:
//   • Same clinic (the file came from here): a record that still exists is left alone; a deleted one comes back,
//     with its old number when that is free. Another clinic: everything is added as new.
//   • A patient who already exists (same file, national ID, or the same name and phone) gets only what is missing.
//   • Importing the same file twice adds nothing twice (import_links).
//   • Invoices and certificates are never re-created (money and public verification codes): their PDFs are added to
//     the patient's files instead. Upcoming bookings are not imported (they could clash with the schedule).
//   • Files count toward the clinic's storage; when it is full the import stops and says so.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { translator } = require('../../core/i18n');
const { ZipReader } = require('../../core/zipread');
const storage = require('../storage/storage.service');
const { instanceId } = require('./export.service');

const ROOT = process.env.PATIENT_IMPORT_DIR || path.join(__dirname, '..', '..', '..', 'storage', 'patient-imports');
const TOKEN = /^[a-f0-9]{16}$/;
const KEEP_MS = 7 * 24 * 3600_000;
const running = new Map(); // businessId → job

const TABLES = {
  patient: 'patients', appointment: 'appointments', consultation: 'consultations', diagnosis: 'consultation_diagnoses',
  prescription: 'prescriptions', order: 'medical_orders', referral: 'referrals', file: 'patient_files',
  dental: 'dental_entries', dental_plan: 'dental_plan_items', growth: 'growth_measurements', pregnancy: 'pregnancies',
  paper_invoice: 'patient_files', paper_certificate: 'patient_files', surgery: 'surgeries',
};
const PATIENT_FILL = ['phone', 'email', 'date_of_birth', 'gender', 'national_id', 'insurance_number', 'allergies', 'chronic_conditions', 'notes'];

const dirOf = (businessId) => path.join(ROOT, String(Number(businessId)));
const zipPath = (businessId, token) => path.join(dirOf(businessId), `${token}.zip`);
const metaPath = (businessId, token) => path.join(dirOf(businessId), `${token}.json`);
const readMeta = (businessId, token) => { try { return JSON.parse(fs.readFileSync(metaPath(businessId, token), 'utf8')); } catch { return null; } };
const writeMeta = (businessId, token, m) => fs.writeFileSync(metaPath(businessId, token), JSON.stringify(m), { mode: 0o600 });
const unlink = (f) => { try { fs.unlinkSync(f); } catch { /* gone */ } };
const fail = (code, msg) => new AppError(code, msg, 422);

const columns = new Map();
async function columnsOf(table) {
  if (!columns.has(table)) columns.set(table, new Set(Object.keys(await knex(table).columnInfo())));
  return columns.get(table);
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const norm = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : typeof v === 'string' && ISO.test(v) ? new Date(v) : v);

/** Where the patients are in the archive: '' (one patient) or 'patients/<folder>/' (every patient). */
function prefixesOf(zip) {
  if (zip.has('data.json')) return [''];
  return zip.names().filter((n) => /^patients\/[^/]+\/data\.json$/.test(n)).map((n) => n.slice(0, -'data.json'.length)).sort();
}
function readData(zip, prefix) {
  let d;
  try { d = JSON.parse(zip.read(`${prefix}data.json`).toString('utf8')); } catch { throw fail('IMPORT_BAD_FILE', 'The file is damaged.'); }
  if (!d || d.format !== 'docbook.patient-export' || Number(d.version) !== 1 || !d.patient || !d.patient.full_name) throw fail('IMPORT_BAD_FILE', 'Not a DocBook patient export.');
  ['appointments', 'consultations', 'diagnoses', 'prescriptions', 'orders', 'referrals', 'files', 'dental', 'dental_plan', 'growth', 'pregnancies', 'papers', 'doctors', 'surgeries']
    .forEach((k) => { if (!Array.isArray(d[k])) d[k] = []; });
  return d;
}
const sourceKey = (d) => (d.source && d.source.instance ? `${d.source.instance}:${Number(d.source.business_id) || 0}` : `name:${crypto.createHash('sha1').update(String((d.clinic && d.clinic.name) || '')).digest('hex')}`).slice(0, 80);
const isSame = (d, ctx, inst) => Boolean(d.source && d.source.instance === inst && Number(d.source.business_id) === Number(ctx.businessId));

async function linked(db, ctx, key, kind, srcId) {
  const l = await db('import_links').where({ business_id: ctx.businessId, source_key: key, kind, src_id: Number(srcId) || 0 }).first('new_id');
  if (!l) return null;
  const row = await db(TABLES[kind]).where({ id: l.new_id, business_id: ctx.businessId }).first('id');
  if (row) return row.id;
  await db('import_links').where({ business_id: ctx.businessId, source_key: key, kind, src_id: Number(srcId) || 0 }).del(); // deleted since
  return null;
}
const link = (db, ctx, key, kind, srcId, newId) => db('import_links').insert({ business_id: ctx.businessId, source_key: key, kind, src_id: Number(srcId), new_id: newId })
  .onConflict(['business_id', 'source_key', 'kind', 'src_id']).merge({ new_id: newId });

/** An existing patient for this file: linked before, the same row (same clinic), the national ID, or name + phone. */
async function matchPatient(db, ctx, d, key, same) {
  const p = d.patient;
  const l = await linked(db, ctx, key, 'patient', p.id);
  if (l) return l;
  if (same) { const r = await db('patients').where({ id: Number(p.id) || 0, business_id: ctx.businessId }).first('id'); if (r) return r.id; }
  if (p.national_id) { const r = await db('patients').where({ business_id: ctx.businessId, national_id: String(p.national_id) }).first('id'); if (r) return r.id; }
  if (p.phone) { const r = await db('patients').where({ business_id: ctx.businessId, full_name: p.full_name, phone: String(p.phone) }).first('id'); if (r) return r.id; }
  return null;
}

/** A doctor here for a doctor of the file: the same one (same clinic), else the same name. */
async function matchDoctor(ctx, doc, same) {
  if (same) { const r = await knex('doctors').where({ id: Number(doc.id) || 0, business_id: ctx.businessId }).first('id'); if (r) return r.id; }
  const r = await knex('doctors').where({ business_id: ctx.businessId }).where((w) => { w.where('full_name', doc.full_name); if (doc.full_name_en) w.orWhere('full_name_en', doc.full_name_en); }).first('id');
  return r ? r.id : null;
}

/** Reads an uploaded file and stores it with what it holds → { token, …summary }. */
async function analyze(ctx, file) {
  const token = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(dirOf(ctx.businessId), { recursive: true, mode: 0o700 });
  const dest = zipPath(ctx.businessId, token);
  fs.renameSync(file, dest);
  let zip;
  try {
    zip = new ZipReader(dest);
    const prefixes = prefixesOf(zip);
    if (!prefixes.length) throw fail('IMPORT_BAD_FILE', 'Not a DocBook patient export.');
    const inst = await instanceId();
    const doctors = new Map(); const sample = [];
    let existing = 0; let files = 0; let visits = 0; let same = false;
    for (const prefix of prefixes) { // eslint-disable-line no-restricted-syntax
      const d = readData(zip, prefix);
      const key = sourceKey(d); const s = isSame(d, ctx, inst); same = same || s;
      const m = await matchPatient(knex, ctx, d, key, s); // eslint-disable-line no-await-in-loop
      if (m) existing += 1;
      files += d.files.length; visits += d.appointments.length;
      if (sample.length < 8) sample.push({ name: d.patient.full_name, existing: Boolean(m) });
      for (const doc of d.doctors) { // eslint-disable-line no-restricted-syntax
        const k = `${key}:${doc.id}`;
        if (!doctors.has(k)) doctors.set(k, { key: k, name: doc.full_name, name_en: doc.full_name_en || null, match: await matchDoctor(ctx, doc, s) }); // eslint-disable-line no-await-in-loop
      }
    }
    const meta = {
      state: 'ready', at: new Date().toISOString(), by: ctx.userId, patients: prefixes.length, existing, files, visits, same, sample,
      doctors: [...doctors.values()], size: fs.statSync(dest).size,
    };
    writeMeta(ctx.businessId, token, meta);
    return { token, ...meta };
  } catch (e) {
    unlink(dest);
    if (e.code === 'ZIP_INVALID') throw fail('IMPORT_BAD_FILE', 'The file is damaged.');
    throw e;
  } finally { if (zip) zip.close(); }
}

function get(businessId, token) {
  if (!TOKEN.test(String(token))) throw E.notFound('Import');
  const m = readMeta(businessId, token);
  if (!m) throw E.notFound('Import');
  return { token, ...m };
}

/** Imports one patient's folder of the archive (in one transaction) and adds to the report. */
async function importOne(ctx, zip, prefix, plan, rep, inst, t) {
  const d = readData(zip, prefix);
  const key = sourceKey(d); const same = isSame(d, ctx, inst);
  const today = ctx.today || new Date().toISOString().slice(0, 10);
  const docOf = (srcId) => (srcId ? (Object.prototype.hasOwnProperty.call(plan.doctors, `${key}:${srcId}`) ? plan.doctors[`${key}:${srcId}`] : null) : null);
  const files = []; // read before the transaction (storage check needs the sizes)
  for (const f of d.files) { const buf = f.path ? zip.read(prefix + f.path) : null; files.push(buf); } // eslint-disable-line no-restricted-syntax
  const papers = d.papers.filter((p) => ['invoice', 'certificate'].includes(p.kind) && /-(\d+)\.pdf$/.test(p.path || ''))
    .map((p) => ({ ...p, src: Number(p.path.match(/-(\d+)\.pdf$/)[1]), buf: zip.read(prefix + p.path) })).filter((p) => p.buf);

  await knex.transaction(async (trx) => {
    const maps = {}; Object.keys(TABLES).forEach((k) => { maps[k] = new Map(); });
    const existing = async (kind, srcId) => {
      const l = await linked(trx, ctx, key, kind, srcId);
      if (l) return l;
      if (same && !kind.startsWith('paper_')) {
        const r = await trx(TABLES[kind]).where({ id: Number(srcId) || 0, business_id: ctx.businessId }).first('id');
        if (r) return r.id;
      }
      return null;
    };
    const insert = async (kind, row, over) => {
      const table = TABLES[kind];
      const cols = await columnsOf(table);
      const obj = {};
      Object.keys(row).forEach((k) => { if (cols.has(k) && k !== 'id' && k !== 'business_id') obj[k] = norm(row[k]); });
      if (!same) Object.keys(obj).forEach((k) => { if (/_by$/.test(k)) obj[k] = null; });
      Object.assign(obj, over, { business_id: ctx.businessId });
      Object.keys(obj).forEach((k) => { if (!cols.has(k)) delete obj[k]; });
      // Back in its own clinic, a deleted record gets its old number when nobody uses it.
      if (same && row.id && kind !== 'paper_invoice' && kind !== 'paper_certificate' && !(await trx(table).where({ id: Number(row.id) }).first('id'))) obj.id = Number(row.id);
      const [id] = await trx(table).insert(obj);
      const newId = obj.id || id;
      await link(trx, ctx, key, kind, row.id, newId);
      maps[kind].set(Number(row.id), newId);
      rep[kind] = (rep[kind] || 0) + 1;
      return newId;
    };
    const known = async (kind, srcId) => { const id = await existing(kind, srcId); if (id) { maps[kind].set(Number(srcId), id); rep.kept = (rep.kept || 0) + 1; } return id; };
    const appt = (srcId) => (srcId ? maps.appointment.get(Number(srcId)) || null : null);

    // The patient.
    const p = d.patient;
    let pid = await matchPatient(trx, ctx, d, key, same);
    if (pid) {
      const cur = await trx('patients').where({ id: pid }).first();
      const fill = {};
      PATIENT_FILL.forEach((k) => { if ((cur[k] === null || cur[k] === '') && p[k] !== null && p[k] !== undefined && p[k] !== '') fill[k] = norm(p[k]); });
      if (Object.keys(fill).length) await trx('patients').where({ id: pid }).update({ ...fill, updated_at: new Date() });
      await link(trx, ctx, key, 'patient', p.id, pid);
      rep.patients_merged = (rep.patients_merged || 0) + 1;
    } else {
      const ins = p.insurance_name ? await trx('insurance_providers').where({ business_id: ctx.businessId, name: p.insurance_name }).first('id') : null;
      pid = await insert('patient', p, { insurance_provider_id: ins ? ins.id : null });
      rep.patients_new = (rep.patients_new || 0) + 1;
    }

    // Visits: past ones and anything with records; upcoming bookings are left out.
    for (const a of d.appointments) { // eslint-disable-line no-restricted-syntax
      if (await known('appointment', a.id)) continue; // eslint-disable-line no-await-in-loop, no-continue
      if (String(a.appointment_date) >= today && ['pending', 'confirmed'].includes(a.status)) { rep.future = (rep.future || 0) + 1; continue; } // eslint-disable-line no-continue
      const svc = a.service_name ? await trx('services').where({ business_id: ctx.businessId, name: a.service_name }).first('id') : null; // eslint-disable-line no-await-in-loop
      const branch = same && a.branch_id ? await trx('clinic_branches').where({ id: a.branch_id, business_id: ctx.businessId }).first('id') : null; // eslint-disable-line no-await-in-loop
      await insert('appointment', a, { // eslint-disable-line no-await-in-loop
        patient_id: pid, doctor_id: same && a.doctor_id && await trx('doctors').where({ id: a.doctor_id, business_id: ctx.businessId }).first('id') ? a.doctor_id : docOf(a.doctor_id), // eslint-disable-line no-await-in-loop
        service_id: svc ? svc.id : null, branch_id: branch ? branch.id : null, parent_appointment_id: null, external_uid: null,
        patient_name: a.patient_name || p.full_name,
      });
    }
    for (const a of d.appointments) { // eslint-disable-line no-restricted-syntax
      const mine = appt(a.id); const parent = appt(a.parent_appointment_id);
      if (mine && parent) await trx('appointments').where({ id: mine, business_id: ctx.businessId }).update({ parent_appointment_id: parent }); // eslint-disable-line no-await-in-loop
    }
    const doctorHere = async (srcId) => (same && srcId && await trx('doctors').where({ id: srcId, business_id: ctx.businessId }).first('id') ? srcId : docOf(srcId));

    for (const c of d.consultations) { // eslint-disable-line no-restricted-syntax
      if (await known('consultation', c.id)) continue; // eslint-disable-line no-await-in-loop, no-continue
      const aid = appt(c.appointment_id);
      if (!aid || await trx('consultations').where({ business_id: ctx.businessId, appointment_id: aid }).first('id')) continue; // eslint-disable-line no-await-in-loop, no-continue
      await insert('consultation', c, { patient_id: pid, appointment_id: aid, doctor_id: await doctorHere(c.doctor_id), patient_name: c.patient_name || p.full_name }); // eslint-disable-line no-await-in-loop
    }
    for (const x of d.diagnoses) { // eslint-disable-line no-restricted-syntax
      if (await known('diagnosis', x.id)) continue; // eslint-disable-line no-await-in-loop, no-continue
      const aid = appt(x.appointment_id);
      if (!aid || await trx('consultation_diagnoses').where({ appointment_id: aid, code: x.code }).first('id')) continue; // eslint-disable-line no-await-in-loop, no-continue
      await insert('diagnosis', x, { patient_id: pid, appointment_id: aid, doctor_id: await doctorHere(x.doctor_id) }); // eslint-disable-line no-await-in-loop
    }
    const simple = async (kind, list, extra = () => ({})) => {
      for (const r of list) { // eslint-disable-line no-restricted-syntax
        if (await known(kind, r.id)) continue; // eslint-disable-line no-await-in-loop, no-continue
        await insert(kind, r, { patient_id: pid, appointment_id: appt(r.appointment_id), doctor_id: await doctorHere(r.doctor_id), ...extra(r) }); // eslint-disable-line no-await-in-loop
      }
    };
    await simple('prescription', d.prescriptions, (r) => ({ patient_name: r.patient_name || p.full_name }));
    await simple('order', d.orders, (r) => ({ partner_id: same ? r.partner_id || null : null, patient_name: r.patient_name || p.full_name }));
    await simple('referral', d.referrals, (r) => ({ patient_name: r.patient_name || p.full_name }));
    await simple('dental', d.dental);
    await simple('dental_plan', d.dental_plan, (r) => ({ service_id: same ? r.service_id || null : null }));
    await simple('growth', d.growth);
    await simple('pregnancy', d.pregnancies);

    // Surgeries: their hospital by name here; a coming one gets its time block back (the doctor's time) when that
    // time is free, otherwise it comes in without the block and the report says to book the time again.
    for (const sx of d.surgeries) { // eslint-disable-line no-restricted-syntax
      if (await known('surgery', sx.id)) continue; // eslint-disable-line no-await-in-loop, no-continue
      const doctorId = await doctorHere(sx.doctor_id); // eslint-disable-line no-await-in-loop
      let hospitalId = null;
      if (sx.hospital_id && same && await trx('clinic_partners').where({ id: sx.hospital_id, business_id: ctx.businessId }).first('id')) hospitalId = sx.hospital_id; // eslint-disable-line no-await-in-loop
      else if (sx.hospital_name) { const h = await trx('clinic_partners').where({ business_id: ctx.businessId, kind: 'hospital', name: sx.hospital_name }).first('id'); hospitalId = h ? h.id : null; } // eslint-disable-line no-await-in-loop
      let blockId = null;
      const coming = sx.status === 'scheduled' && String(sx.surgery_date) >= today;
      if (coming && doctorId) {
        const kept = same && sx.appointment_id ? await trx('appointments').where({ id: sx.appointment_id, business_id: ctx.businessId, appointment_type: 'blocked' }).first('id') : null; // eslint-disable-line no-await-in-loop
        if (kept && !(await trx('surgeries').where({ appointment_id: kept.id }).first('id'))) blockId = kept.id; // eslint-disable-line no-await-in-loop
        else {
          const toMin = (v) => { const [h, m] = String(v).split(':').map(Number); return h * 60 + m; };
          const start = toMin(sx.surgery_time); const end = start + (Number(sx.duration_minutes) || 30);
          const day = await trx('appointments').where({ business_id: ctx.businessId, doctor_id: doctorId, appointment_date: sx.surgery_date }).whereNotIn('status', ['cancelled', 'no_show']).select('appointment_time', 'duration_minutes'); // eslint-disable-line no-await-in-loop
          const clash = day.some((a) => { const s = toMin(a.appointment_time); return s < end && start < s + (Number(a.duration_minutes) || 30); });
          if (!clash) {
            const label = `${sx.procedure_name} — ${sx.patient_name || p.full_name}`.slice(0, 190);
            [blockId] = await trx('appointments').insert({ business_id: ctx.businessId, doctor_id: doctorId, patient_name: label, notes: label, appointment_date: sx.surgery_date, appointment_time: sx.surgery_time, duration_minutes: sx.duration_minutes || null, status: 'confirmed', appointment_type: 'blocked', source: 'staff', created_by: ctx.userId }); // eslint-disable-line no-await-in-loop
          } else rep.surgery_no_time = (rep.surgery_no_time || 0) + 1;
        }
      }
      await insert('surgery', sx, { // eslint-disable-line no-await-in-loop
        patient_id: pid, patient_name: sx.patient_name || p.full_name, appointment_id: blockId, doctor_id: doctorId, hospital_id: hospitalId,
        sent_at: same ? norm(sx.sent_at) : null, sent_to: same ? sx.sent_to : null, sent_channel: same ? sx.sent_channel : null, created_by: same ? sx.created_by || null : ctx.userId,
      });
    }

    // The stored files as they were (storage checked first).
    const adding = [];
    for (const [i, f] of d.files.entries()) { // eslint-disable-line no-restricted-syntax
      if (await known('file', f.id)) continue; // eslint-disable-line no-await-in-loop, no-continue
      if (!files[i]) { rep.missing = (rep.missing || 0) + 1; continue; } // eslint-disable-line no-continue
      adding.push([f, files[i]]);
    }
    const papersToAdd = [];
    for (const pp of papers) { // eslint-disable-line no-restricted-syntax
      const kind = `paper_${pp.kind}`;
      if (same && await trx(pp.kind === 'invoice' ? 'invoices' : 'certificates').where({ id: pp.src, business_id: ctx.businessId }).first('id')) continue; // eslint-disable-line no-await-in-loop, no-continue
      if (await linked(trx, ctx, key, kind, pp.src)) continue; // eslint-disable-line no-await-in-loop, no-continue
      papersToAdd.push(pp);
    }
    const bytes = adding.reduce((n, [, b]) => n + b.length, 0) + papersToAdd.reduce((n, pp) => n + pp.buf.length, 0);
    if (bytes) await storage.assertRoom(ctx.businessId, bytes);
    for (const [f, buf] of adding) { // eslint-disable-line no-restricted-syntax
      await insert('file', f, { // eslint-disable-line no-await-in-loop
        patient_id: pid, appointment_id: appt(f.appointment_id), order_id: f.order_id ? maps.order.get(Number(f.order_id)) || null : null,
        data: buf, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), created_by: same ? f.created_by || null : ctx.userId,
      });
    }
    for (const pp of papersToAdd) { // eslint-disable-line no-restricted-syntax
      await insert(`paper_${pp.kind}`, { id: pp.src }, { // eslint-disable-line no-await-in-loop
        patient_id: pid, appointment_id: null, order_id: null, category: 'report', title: t(`patient_export.import.paper_${pp.kind}`, { date: pp.date || '' }).slice(0, 160),
        name: path.basename(pp.path).slice(0, 160), mime: 'application/pdf', data: pp.buf, size: pp.buf.length, sha256: crypto.createHash('sha256').update(pp.buf).digest('hex'),
        created_by: ctx.userId, created_at: pp.date ? new Date(`${pp.date}T12:00:00Z`) : new Date(),
      });
    }
  });
}

async function run(ctx, token, plan, job) {
  const businessId = ctx.businessId;
  const t = translator(ctx.locale || 'ar');
  const rep = {};
  const failed = [];
  let zip = null; let stop = null;
  try {
    zip = new ZipReader(zipPath(businessId, token));
    const inst = await instanceId();
    const prefixes = prefixesOf(zip);
    job.total = prefixes.length;
    for (const [i, prefix] of prefixes.entries()) { // eslint-disable-line no-restricted-syntax
      try {
        await importOne(ctx, zip, prefix, plan, rep, inst, t); // eslint-disable-line no-await-in-loop
      } catch (e) {
        if (e.code === 'STORAGE_FULL') { stop = 'STORAGE_FULL'; break; }
        failed.push(prefix || 'patient');
      }
      job.done = i + 1;
    }
    const m = readMeta(businessId, token) || {};
    writeMeta(businessId, token, { ...m, state: stop ? 'stopped' : 'done', stop, report: rep, failed: failed.length, done: job.done, total: job.total, finished_at: new Date().toISOString() });
    await audit.record(ctx, 'patients.imported', { entityType: 'patient_import', entityId: null, newValues: { ...rep, failed: failed.length, stop } });
  } catch (e) {
    const m = readMeta(businessId, token) || {};
    writeMeta(businessId, token, { ...m, state: 'failed', error: String((e && e.message) || e).slice(0, 200) });
  } finally {
    if (zip) zip.close();
    unlink(zipPath(businessId, token)); // the uploaded archive is not kept
    running.delete(businessId);
  }
}

/** Starts the import of an analysed file; `input.doctor_<i>` picks a doctor here for each doctor not matched. */
async function start(ctx, token, input = {}) {
  const m = get(ctx.businessId, token);
  if (m.state !== 'ready' || !fs.existsSync(zipPath(ctx.businessId, token))) throw E.notFound('Import');
  if (running.has(ctx.businessId)) throw new AppError('IMPORT_RUNNING', 'An import is already running.', 409);
  const ids = new Set((await knex('doctors').where({ business_id: ctx.businessId }).pluck('id')).map(Number));
  const doctors = {};
  m.doctors.forEach((doc, i) => {
    const pick = Number(input[`doctor_${i}`]);
    doctors[doc.key] = ids.has(pick) ? pick : (doc.match && ids.has(Number(doc.match)) ? Number(doc.match) : null);
  });
  writeMeta(ctx.businessId, token, { ...m, state: 'running', started_at: new Date().toISOString() });
  const job = { token, done: 0, total: m.patients };
  running.set(ctx.businessId, job);
  job.promise = run({ ...ctx, permissions: new Set(ctx.permissions) }, token, { doctors }, job);
  return job;
}

function cancel(ctx, token) {
  const m = get(ctx.businessId, token);
  if (m.state === 'running') throw new AppError('IMPORT_RUNNING', 'An import is already running.', 409);
  unlink(zipPath(ctx.businessId, token)); unlink(metaPath(ctx.businessId, token));
}

/** Recent imports (newest first; uploads never started are removed after a day, reports after a week). */
function list(businessId) {
  let names = [];
  try { names = fs.readdirSync(dirOf(businessId)).filter((f) => /^[a-f0-9]{16}\.json$/.test(f)); } catch { return []; }
  const now = Date.now();
  return names.map((f) => {
    const token = f.slice(0, 16); const m = readMeta(businessId, token) || {};
    const job = running.get(businessId);
    if (job && job.token === token) return { token, ...m, state: 'running', done: job.done, total: job.total };
    return { token, ...m, state: m.state === 'running' ? 'failed' : m.state };
  }).filter((x) => {
    const age = now - new Date(x.at).getTime();
    const old = (x.state === 'ready' && age > 24 * 3600_000) || age > KEEP_MS;
    if (old && x.state !== 'running') { unlink(zipPath(businessId, x.token)); unlink(metaPath(businessId, x.token)); }
    return !old;
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

const settle = (businessId) => (running.get(businessId) ? running.get(businessId).promise : Promise.resolve());

module.exports = { ROOT, dirOf, analyze, get, start, cancel, list, settle };
