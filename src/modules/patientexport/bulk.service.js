// Every patient's file in one ZIP — built in the background, straight to disk (core/zipstream.js), so a clinic with
// thousands of patients and gigabytes of X-rays never has it in memory. The ZIP:
//   index.xlsx / index.csv          — one row per patient with the folder of their file
//   patients/00001_<id>_<name>/…    — each patient exactly as the single export (summary, papers, files, data.json)
//   README.txt
// One export runs at a time per clinic; finished ones stay 24 hours (at most 3), then are removed. Only members with
// data.export and patients.view start or download one, each patient holds only what that member may see, and the
// start, every patient (record access log) and every download are logged.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError, E } = require('../../core/errors');
const { translator } = require('../../core/i18n');
const xlsx = require('../../core/xlsx');
const { ZipFile } = require('../../core/zipstream');
const lib = require('../clinic/records.lib');
const one = require('./export.service');

const ROOT = process.env.PATIENT_EXPORT_DIR || path.join(__dirname, '..', '..', '..', 'storage', 'patient-exports');
const KEEP_MS = 24 * 3600_000;
const KEEP_N = 3;
const NAME = /^patients-\d{8}-\d{6}-[a-f0-9]{6}\.zip$/;
const running = new Map(); // businessId → { name, done, total, startedAt }

const dirOf = (businessId) => path.join(ROOT, String(Number(businessId)));
const metaPath = (businessId, name) => path.join(dirOf(businessId), name.replace(/\.zip$/, '.json'));
const readMeta = (businessId, name) => { try { return JSON.parse(fs.readFileSync(metaPath(businessId, name), 'utf8')); } catch { return null; } };
const writeMeta = (businessId, name, m) => fs.writeFileSync(metaPath(businessId, name), JSON.stringify(m), { mode: 0o600 });
function remove(businessId, name) {
  for (const f of [path.join(dirOf(businessId), name), metaPath(businessId, name)]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
}

/** The clinic's exports, newest first (old and extra ones removed): [{ name, state, done, total, size, at, by_name, patients, skipped }]. */
function list(businessId) {
  let names = [];
  try { names = fs.readdirSync(dirOf(businessId)).filter((f) => NAME.test(f)); } catch { return running.has(businessId) ? [{ ...running.get(businessId), state: 'running' }] : []; }
  const out = names.map((name) => {
    const m = readMeta(businessId, name) || {};
    const job = running.get(businessId);
    if (job && job.name === name) return { ...m, ...job, name, state: 'running' };
    return { ...m, name, state: m.state === 'running' ? 'failed' : (m.state || 'failed') }; // a restart stopped it
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const now = Date.now();
  return out.filter((x, i) => {
    if (x.state === 'running') return true;
    const old = now - new Date(x.at).getTime() > KEEP_MS || i >= KEEP_N;
    if (old) remove(businessId, x.name);
    return !old;
  });
}

async function patients(ctx) {
  const q = knex('patients').where('patients.business_id', ctx.businessId).orderBy('patients.id')
    .select('patients.id', 'patients.full_name', 'patients.phone', 'patients.date_of_birth', 'patients.national_id');
  lib.scopePatientsToDoctor(q, ctx.ownDoctorId);
  return require('../clinic/branches.service').scopePatients(q, ctx, 'patients.id'); // eslint-disable-line global-require -- the branch's patients
}

async function run(ctx, locale, name, job) {
  const businessId = ctx.businessId;
  const file = path.join(dirOf(businessId), name);
  const t = translator(locale);
  const privacy = require('../clinicalplus/privacy.service'); // eslint-disable-line global-require
  let zip = null;
  try {
    zip = await ZipFile.create(file);
    const list0 = await patients(ctx);
    job.total = list0.length;
    const rows = []; let skipped = 0;
    for (const [i, p] of list0.entries()) { // eslint-disable-line no-restricted-syntax
      const folder = `patients/${String(i + 1).padStart(5, '0')}_${p.id}_${one.ascii(p.full_name, 'patient')}/`;
      try {
        const r = await one.collect(ctx, p.id, locale, (n, buf) => zip.add(folder + n, buf)); // eslint-disable-line no-await-in-loop
        await privacy.log(ctx, { patientId: p.id, what: 'export', access: privacy.levelOf(r.access) }); // eslint-disable-line no-await-in-loop
        rows.push([p.id, p.full_name, p.phone || '', p.date_of_birth ? String(p.date_of_birth).slice(0, 10) : '', p.national_id || '', r.counts.visits, r.counts.papers, r.counts.files, folder]);
      } catch (e) {
        skipped += 1;
        rows.push([p.id, p.full_name, p.phone || '', '', '', '', '', '', t('patient_export.bulk.skipped_row')]);
      }
      job.done = i + 1;
    }
    const header = ['#', t('patient_export.name'), t('patient_export.phone'), t('patient_export.dob'), t('patient_export.national_id'),
      t('patient_export.bulk.col_visits'), t('patient_export.bulk.col_papers'), t('patient_export.bulk.col_files'), t('patient_export.bulk.col_folder')];
    await zip.add('index.xlsx', xlsx.build([{ name: t('patient_export.bulk.sheet'), header, rows }], { rtl: locale === 'ar' }));
    const csvCell = (v) => { const x = String(v === null || v === undefined ? '' : v); return /[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    await zip.add('index.csv', Buffer.from(`﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}`, 'utf8'));
    await zip.add('README.txt', Buffer.from(`﻿${t('patient_export.bulk.readme', { n: list0.length, date: new Date().toISOString().slice(0, 10) })}`, 'utf8'));
    const { size } = await zip.close();
    const meta = { at: job.startedAt, by: ctx.userId, by_name: job.by_name, state: 'ready', patients: list0.length, skipped, size, finished_at: new Date().toISOString() };
    writeMeta(businessId, name, meta);
    await audit.record(ctx, 'patients.exported_all', { entityType: 'patient_export', entityId: null, newValues: { file: name, patients: list0.length, skipped, size } });
  } catch (e) {
    if (zip) zip.abort();
    try { fs.unlinkSync(file); } catch { /* not written */ }
    writeMeta(businessId, name, { at: job.startedAt, by: ctx.userId, by_name: job.by_name, state: 'failed', error: String((e && e.message) || e).slice(0, 200) });
  } finally {
    running.delete(businessId);
  }
}

/** Starts the clinic's export in the background → its name; one at a time per clinic. */
async function start(ctx, locale = 'ar') {
  if (!ctx.permissions.has('data.export') || !ctx.permissions.has('patients.view')) throw E.forbidden('data.export');
  const businessId = ctx.businessId;
  if (running.has(businessId)) throw new AppError('EXPORT_RUNNING', 'An export is already running.', 409);
  list(businessId); // clear old ones
  fs.mkdirSync(dirOf(businessId), { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const name = `patients-${stamp.slice(0, 8)}-${stamp.slice(8)}-${crypto.randomBytes(3).toString('hex')}.zip`;
  const user = await knex('users').where({ id: ctx.userId }).first('name');
  const job = { name, done: 0, total: 0, startedAt: new Date().toISOString(), by_name: user ? user.name : '' };
  running.set(businessId, job);
  writeMeta(businessId, name, { at: job.startedAt, by: ctx.userId, by_name: job.by_name, state: 'running' });
  const jobCtx = { ...ctx, permissions: new Set(ctx.permissions) };
  job.promise = run(jobCtx, locale, name, job);
  return name;
}

/** A finished export's file path (name checked), for download. */
function fileOf(businessId, name) {
  if (!NAME.test(String(name))) throw E.notFound('Export');
  const m = readMeta(businessId, name);
  const file = path.join(dirOf(businessId), name);
  if (!m || m.state !== 'ready' || !fs.existsSync(file)) throw E.notFound('Export');
  return { file, meta: m };
}

async function removeOne(ctx, name) {
  if (!NAME.test(String(name))) throw E.notFound('Export');
  const job = running.get(ctx.businessId);
  if (job && job.name === name) throw new AppError('EXPORT_RUNNING', 'An export is already running.', 409);
  remove(ctx.businessId, name);
  await audit.record(ctx, 'patients.export_deleted', { entityType: 'patient_export', entityId: null, newValues: { file: name } });
}

/** Waits for the clinic's running export (tests). */
const settle = (businessId) => (running.get(businessId) ? running.get(businessId).promise : Promise.resolve());

module.exports = { ROOT, NAME, list, start, fileOf, removeOne, settle };
