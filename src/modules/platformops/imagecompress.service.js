// Platform admin → Compress old images: pictures stored before uploads were compressed (PNG / JPEG, and WebP that is
// still large) are rewritten as small, sharp WebP (core/imageopt — the same rules as a new upload). One job at a time,
// in the background, one picture after another; the admin page follows its progress. Every row tried is logged in
// image_compress_log (so a picture that cannot be made smaller is not tried again), and the run is audited.
// Never touched: the platform's own logo (Branding compresses it on upload), favicons, signatures and stamps (they go into PDFs as PNG/JPEG), fonts, PDFs and other files.
const crypto = require('crypto');
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const imageopt = require('../../core/imageopt');
const tenant = require('../../db/tenant');
const { isTenant } = require('../../db/tables');

const OLD = ['image/png', 'image/jpeg', 'image/jpg'];
const BIG_WEBP = 400 * 1024; // a WebP larger than this is worth another pass (scaled down)
const sha16 = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const sha64 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const now = () => new Date();

// Where pictures live: the table, its picture/type columns, and what else changes with the picture.
const TARGETS = [
  { key: 'logos', table: 'businesses', data: 'logo', mime: 'logo_mime', maxSide: 1200, patch: () => ({ logo_version: knex.raw('logo_version + 1') }), after: (r) => require('../businesses/business.service').forget(r.id) }, // eslint-disable-line global-require
  { key: 'square_logos', table: 'businesses', data: 'logo_square', mime: 'logo_square_mime', maxSide: 1200, patch: () => ({ logo_square_version: knex.raw('logo_square_version + 1') }), after: (r) => require('../businesses/business.service').forget(r.id) }, // eslint-disable-line global-require
  { key: 'site_media', table: 'site_media', data: 'data', mime: 'mime', patch: (r, o) => ({ size: o.buffer.length, width: o.width, height: o.height, sha: sha16(o.buffer) }), after: () => cache.forgetPrefix('site:') },
  { key: 'clinic_media', table: 'clinic_media', data: 'data', mime: 'mime', patch: (r, o) => ({ size: o.buffer.length, width: o.width, height: o.height, sha: sha16(o.buffer) }), after: (r) => { cache.forgetPrefix(`media:page:${r.business_id}`); cache.forgetPrefix(`media:docs:${r.business_id}`); }, cols: ['business_id'] },
  { key: 'patient_files', table: 'patient_files', data: 'data', mime: 'mime', patch: (r, o) => ({ size: o.buffer.length, sha256: sha64(o.buffer), name: webpName(r.name) }), cols: ['name'] },
  { key: 'online_files', table: 'online_consultation_files', data: 'data', mime: 'mime', patch: (r, o) => ({ size: o.buffer.length, sha256: sha64(o.buffer), name: webpName(r.name) }), cols: ['name'] },
  { key: 'chat_files', table: 'staff_chat_files', data: 'data', mime: 'mime', patch: (r, o) => ({ size: o.buffer.length, name: webpName(r.name) }), cols: ['name'] },
  { key: 'vendor_logos', table: 'vendors', data: 'logo', mime: 'logo_mime', maxSide: 1600, patch: () => ({ updated_at: now() }) },
  { key: 'vendor_products', table: 'vendor_products', data: 'image', mime: 'image_mime', maxSide: 1600, patch: () => ({ updated_at: now() }) },
  { key: 'vendor_offers', table: 'vendor_offers', data: 'image', mime: 'image_mime', maxSide: 1600, patch: () => ({ updated_at: now() }) },
  { key: 'vendor_ads', table: 'vendor_ads', data: 'image', mime: 'image_mime', maxSide: 1600, patch: () => ({ updated_at: now() }) },
];
const webpName = (n) => `${String(n || 'image').replace(/\.[A-Za-z0-9]{1,5}$/, '')}.webp`.slice(0, 160);

/** Rows of a target worth trying: old formats, or a large WebP — minus the rows already tried. */
function candidates(t) {
  const q = knex(t.table).whereNotNull(t.data)
    .where((w) => w.whereIn(t.mime, OLD).orWhere((x) => x.where(t.mime, 'image/webp').where(knex.raw(`LENGTH(??) > ${BIG_WEBP}`, [t.data]))))
    .whereNotExists(function tried() { this.select(knex.raw('1')).from('image_compress_log as l').where('l.target', t.key).whereRaw('l.row_id = ??', [`${t.table}.id`]); });
  return t.where ? t.where(q) : q;
}

const available = async (t) => knex.schema.hasTable(t.table).then((ok) => ok && knex.schema.hasColumn(t.table, t.data)).catch(() => false);

/** What can be compressed: per target, the number of pictures and their size now. */
// A clinic's pictures are in its own database (src/db/tenant.js): those places are gone through in every database.
const inEach = (t, fn) => (isTenant(t.table) ? tenant.eachDb(fn) : tenant.run(null, fn).then((r) => [r]));

async function scan() {
  const out = [];
  for (const t of TARGETS) { // eslint-disable-line no-restricted-syntax
    if (!(await available(t))) continue; // eslint-disable-line no-await-in-loop, no-continue
    const parts = await inEach(t, async () => (await candidates(t).count({ n: '*' }).select(knex.raw('COALESCE(SUM(LENGTH(??)), 0) as bytes', [t.data])))[0]); // eslint-disable-line no-await-in-loop
    out.push({ key: t.key, count: parts.reduce((a, r) => a + (Number(r.n) || 0), 0), bytes: parts.reduce((a, r) => a + (Number(r.bytes) || 0), 0) });
  }
  return out;
}

/** The totals of every run so far. */
async function history() {
  const [r] = await knex('image_compress_log').where({ status: 'done' }).count({ n: '*' }).sum({ before: 'bytes_before' }).sum({ after: 'bytes_after' });
  return { count: Number(r.n) || 0, before: Number(r.before) || 0, after: Number(r.after) || 0 };
}

// ---------------------------------------------------------------- the background job
let job = null; // { running, total, done, kept, failed, before, after, startedAt, finishedAt, current }
const status = () => (job ? { ...job } : { running: false });

async function compressRow(t, id) {
  const row = await knex(t.table).where({ id }).first(['id', t.data, t.mime, ...(t.cols || [])]);
  const buf = row && row[t.data];
  if (!Buffer.isBuffer(buf)) return { status: 'kept', before: 0, after: 0 };
  const o = await imageopt.optimize(buf, { maxSide: t.maxSide });
  if (!o || o.buffer.length >= buf.length) return { status: 'kept', before: buf.length, after: buf.length };
  // Only when the picture is still the one read (someone may have replaced it meanwhile).
  const n = await knex(t.table).where({ id }).where(t.mime, row[t.mime]).whereRaw('LENGTH(??) = ?', [t.data, buf.length])
    .update({ [t.data]: o.buffer, [t.mime]: o.mime, ...t.patch(row, o) });
  if (!n) return { status: 'kept', before: buf.length, after: buf.length };
  if (t.after) t.after(row);
  return { status: 'done', before: buf.length, after: o.buffer.length };
}

async function runAll(ctx) {
  try {
    for (const t of TARGETS) { // eslint-disable-line no-restricted-syntax
      if (!(await available(t))) continue; // eslint-disable-line no-await-in-loop, no-continue
      job.current = t.key;
      await inEach(t, async () => { // eslint-disable-line no-await-in-loop
      for (;;) {
        const ids = await candidates(t).orderBy('id').limit(25).pluck('id'); // eslint-disable-line no-await-in-loop
        if (!ids.length) break;
        for (const id of ids) { // eslint-disable-line no-restricted-syntax
          let r;
          try { r = await compressRow(t, id); } catch { r = { status: 'failed', before: 0, after: 0 }; } // eslint-disable-line no-await-in-loop
          await knex('image_compress_log').insert({ target: t.key, row_id: id, status: r.status, bytes_before: r.before, bytes_after: r.after }).catch(() => {}); // eslint-disable-line no-await-in-loop
          job.done += 1;
          if (r.status === 'done') { job.before += r.before; job.after += r.after; } else if (r.status === 'failed') job.failed += 1; else job.kept += 1;
          if (job.stop) break;
        }
        if (job.stop) break;
      }
      });
      if (job.stop) break;
    }
  } finally {
    job.running = false; job.current = null; job.finishedAt = now();
    await audit.record(ctx, 'platform.images_compressed', { entityType: 'platform', newValues: { done: job.done - job.kept - job.failed, kept: job.kept, failed: job.failed, saved_bytes: job.before - job.after, stopped: Boolean(job.stop) } }).catch(() => {});
  }
}

/** Starts the job (one at a time). Returns false when one is already running or there is nothing to do. */
async function start(ctx) {
  if (job && job.running) return false;
  const total = (await scan()).reduce((s, x) => s + x.count, 0);
  if (!total) return false;
  job = { running: true, total, done: 0, kept: 0, failed: 0, before: 0, after: 0, startedAt: now(), finishedAt: null, current: null, stop: false };
  await audit.record(ctx, 'platform.images_compress_started', { entityType: 'platform', newValues: { pictures: total } });
  runAll(ctx).catch(() => {});
  return true;
}
function stop() { if (job && job.running) job.stop = true; }
const wait = async () => { while (job && job.running) await new Promise((r) => { setTimeout(r, 50); }); }; // eslint-disable-line no-await-in-loop

module.exports = { TARGETS, scan, history, start, stop, status, wait };
