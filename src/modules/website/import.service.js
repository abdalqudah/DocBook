// Website content import (Website → Import content): one ZIP prepared for the clinic — content.json plus its pictures —
// fills the clinic's website draft and its doctors' profiles in one go. Nothing goes live: the clinic reviews the
// draft in the builder and publishes when ready. Everything stays editable afterwards.
//
// content.json (format "clinic-site-content", version 1):
//   media:   { <ref>: { file: "images/x.jpg", alt: { ar, en }, folder } }       pictures, added to the media library
//   doctors: [{ names: [...], full_name, full_name_en, specialization(_en), bio(_en), education(_en), profile, social,
//               photo: <ref>, phone, sort_order, create }]                         matched to the clinic's doctors by name
//   site:    { theme, pages, header, footer, seo, brand: { logo, logoDark, favicon } } website document; any string
//            "@media:<ref>" is replaced by the picture's id in the clinic's library.
// Safety: the clinic comes from the session (ctx), never from the file; text is plain (the site sanitiser runs on the
// result); pictures are checked like any upload; the previous draft is kept as a version that can be restored.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError } = require('../../core/errors');
const { ZipReader } = require('../../core/zipread');
const imageopt = require('../../core/imageopt');
const media = require('../integrations/media.service');
const site = require('./site.service');
const social = require('../clinic/doctor-social');
const profile = require('../clinic/doctor-profile');
const scheduling = require('../clinic/scheduling');

const MAX_ZIP = 80 * 1024 * 1024;
const MAX_MEDIA = 80;
const MAX_DOCTORS = 40;
const fail = (code, msg) => new AppError(code, msg, 422);

/** A name for matching: no title (Dr./د.), no spaces or marks, one form of the Arabic letters that are spelt both ways. */
function nameKey(v) {
  return String(v || '').toLowerCase().normalize('NFKD').replace(/[ً-ٰٟ]/g, '')
    .replace(/^\s*(dr\.?|doctor|د\.?|دكتور|الدكتور|الدكتورة|دكتورة)\s*/i, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^a-z0-9ء-ي]/g, '');
}

const text = (v, max) => (v === undefined || v === null ? undefined : String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max));

/** Reads and checks the package: { data, zip } (the caller closes the zip). */
function open(file) {
  const zip = new ZipReader(file);
  const buf = zip.read('content.json');
  if (!buf) { zip.close(); throw fail('IMPORT_NO_CONTENT', 'The file has no content.json.'); }
  let data;
  try { data = JSON.parse(buf.toString('utf8')); } catch { zip.close(); throw fail('IMPORT_BAD_FILE', 'The file is damaged.'); }
  if (!data || data.format !== 'clinic-site-content' || Number(data.version) !== 1) { zip.close(); throw fail('IMPORT_BAD_FILE', 'This is not a website content file.'); }
  return { data, zip };
}

/** What the package holds, for the confirmation step. */
function summary(data) {
  const pages = (data.site && Array.isArray(data.site.pages)) ? data.site.pages : [];
  return {
    media: Object.keys(data.media || {}).length,
    doctors: (Array.isArray(data.doctors) ? data.doctors : []).map((d) => d.full_name_en || d.full_name).filter(Boolean),
    services: (Array.isArray(data.services) ? data.services : []).reduce((n, g) => n + ((g && Array.isArray(g.items)) ? g.items.length : 0), 0),
    pages: pages.map((p) => (p.key === 'home' ? 'home' : (p.title && (p.title.ar || p.title.en)) || p.slug)).filter(Boolean),
  };
}

/** Adds the package's pictures to the library (a picture already there — same bytes — is reused). { ref: id } */
async function importMedia(ctx, data, zip) {
  const out = {};
  const entries = Object.entries(data.media || {}).slice(0, MAX_MEDIA);
  for (const [ref, m] of entries) { // eslint-disable-line no-restricted-syntax
    if (!/^[a-z0-9_-]{1,40}$/i.test(ref) || !m || typeof m.file !== 'string') continue; // eslint-disable-line no-continue
    let buf = zip.read(m.file);
    if (!buf) continue; // eslint-disable-line no-continue
    const small = await imageopt.optimize(buf, { maxSide: 2200, quality: 82 }); // eslint-disable-line no-await-in-loop
    if (small) buf = small.buffer;
    const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const have = await knex('clinic_media').where({ business_id: ctx.businessId, sha }).first('id'); // eslint-disable-line no-await-in-loop
    if (have) { out[ref] = have.id; continue; } // eslint-disable-line no-continue
    const alt = m.alt || {};
    const row = await media.upload(ctx, { buffer: buf, originalname: path.basename(m.file).replace(/\.[a-z0-9]+$/i, '') }, { folder: m.folder || 'website', is_public: '1', alt_ar: alt.ar, alt_en: alt.en }); // eslint-disable-line no-await-in-loop
    if (!row.isImage) { await media.remove(ctx, row.id, { force: true }).catch(() => {}); continue; } // eslint-disable-line no-await-in-loop, no-continue
    out[ref] = row.id;
  }
  return out;
}

/** Updates the clinic's doctors from the package (matched by name); creates the missing ones when asked. */
async function importDoctors(ctx, data, mediaIds, { create = true, photos = true } = {}) {
  const list = (Array.isArray(data.doctors) ? data.doctors : []).slice(0, MAX_DOCTORS);
  const mine = await knex('doctors').where({ business_id: ctx.businessId }).select('id', 'full_name', 'full_name_en', 'photo_media_id', 'phone', 'is_active');
  const byKey = new Map();
  mine.forEach((d) => [d.full_name, d.full_name_en].forEach((n) => { const k = nameKey(n); if (k && !byKey.has(k)) byKey.set(k, d); }));
  const updated = []; const created = [];
  for (const d of list) { // eslint-disable-line no-restricted-syntax
    if (!d || !(d.full_name || d.full_name_en)) continue; // eslint-disable-line no-continue
    const keys = [d.full_name, d.full_name_en, ...(Array.isArray(d.names) ? d.names : [])].map(nameKey).filter(Boolean);
    let doc = keys.map((k) => byKey.get(k)).find(Boolean);
    const patch = {};
    const put = (k, v, max) => { const x = text(v, max); if (x) patch[k] = x; };
    put('full_name_en', d.full_name_en, 190); put('specialization', d.specialization, 190); put('specialization_en', d.specialization_en, 190);
    put('bio', d.bio, 5000); put('bio_en', d.bio_en, 5000); put('education', d.education, 3000); put('education_en', d.education_en, 3000);
    if (d.profile) { const p = profile.toStore(profile.clean(d.profile)); if (p) patch.profile = p; }
    if (d.social) { const links = social.read(d.social); if (Object.keys(links).length) patch.social_links = JSON.stringify(links); }
    if (!doc) {
      if (!create || d.create === false) continue; // eslint-disable-line no-continue
      const [id] = await knex('doctors').insert({ // eslint-disable-line no-await-in-loop
        business_id: ctx.businessId, full_name: text(d.full_name || d.full_name_en, 190), is_active: true, sort_order: Number(d.sort_order) || 0,
        phone: text(d.phone, 40) || null, working_hours: JSON.stringify(scheduling.defaultWorkingHours()), ...patch,
      });
      doc = { id, photo_media_id: null }; created.push(d.full_name_en || d.full_name);
      await audit.record(ctx, 'doctor.created', { entityType: 'doctor', entityId: id, newValues: { full_name: d.full_name, source: 'website_import' } }); // eslint-disable-line no-await-in-loop
    } else {
      // A name kept in Latin letters only gets the package's Arabic name (the English one goes to full_name_en).
      const arName = text(d.full_name, 190);
      if (arName && /[\u0600-\u06FF]/.test(arName) && !/[\u0600-\u06FF]/.test(doc.full_name || '')) patch.full_name = arName;
      if (!doc.phone && text(d.phone, 40)) patch.phone = text(d.phone, 40); // the clinic's own number for the doctor (never shown on the website)
      if (d.sort_order !== undefined && Number.isFinite(Number(d.sort_order))) patch.sort_order = Number(d.sort_order);
      if (Object.keys(patch).length) {
        await knex('doctors').where({ business_id: ctx.businessId, id: doc.id }).update({ ...patch, updated_at: new Date() }); // eslint-disable-line no-await-in-loop
        await audit.record(ctx, 'doctor.updated', { entityType: 'doctor', entityId: doc.id, newValues: { fields: Object.keys(patch).join(','), source: 'website_import' } }); // eslint-disable-line no-await-in-loop
      }
      updated.push(d.full_name_en || d.full_name);
    }
    const photo = d.photo && mediaIds[d.photo];
    if (photo && (photos || !doc.photo_media_id)) await media.setDoctorPhoto(ctx, doc.id, photo); // eslint-disable-line no-await-in-loop
  }
  return { updated, created };
}

/**
 * A medical centre's website: its doctors belong to the centre's clinics. Each doctor of the package is matched in the
 * clinic they work at (in that clinic's own database) and updated there; the photo goes into that clinic's library.
 * No doctor is ever created in the centre's administration account.
 */
async function importDoctorsCenter(ctx, business, data, zip, { photos = true } = {}) {
  const tenant = require('../../db/tenant'); // eslint-disable-line global-require
  const portal = require('../site/portal.web'); // eslint-disable-line global-require
  const practices = (await portal.centerPractices(business)) || [];
  const list = (Array.isArray(data.doctors) ? data.doctors : []).slice(0, MAX_DOCTORS);
  const out = { updated: [], created: [] };
  for (const p of practices) { // eslint-disable-line no-restricted-syntax
    await tenant.runFor(p.id, async () => { // eslint-disable-line no-await-in-loop
      const pctx = { ...ctx, businessId: p.id };
      const mine = await knex('doctors').where({ business_id: p.id }).select('full_name', 'full_name_en');
      const here = new Set(); mine.forEach((d) => [d.full_name, d.full_name_en].forEach((n) => { const k = nameKey(n); if (k) here.add(k); }));
      const matched = list.filter((d) => d && [d.full_name, d.full_name_en, ...(Array.isArray(d.names) ? d.names : [])].map(nameKey).some((k) => k && here.has(k)));
      if (!matched.length) return;
      const refs = new Set(matched.map((d) => d.photo).filter(Boolean));
      const ids = await importMedia(pctx, { media: Object.fromEntries(Object.entries(data.media || {}).filter(([k]) => refs.has(k))) }, zip);
      const r = await importDoctors(pctx, { doctors: matched }, ids, { create: false, photos });
      out.updated.push(...r.updated);
    });
  }
  return out;
}

/**
 * Main services (categories) and their sub-services, matched by name (no duplicates on a second import). A new
 * service has no price shown (the clinic sets prices); an existing one keeps its price and only gets what it lacks.
 */
async function importServices(ctx, data) {
  const groups = (Array.isArray(data.services) ? data.services : []).slice(0, 30);
  if (!groups.length) return { categories: 0, services: 0 };
  const cats = await knex('service_categories').where({ business_id: ctx.businessId }).select('id', 'name', 'name_en');
  const svcs = await knex('services').where({ business_id: ctx.businessId }).select('id', 'name', 'name_en', 'description', 'description_en', 'category_id');
  const find = (list, x) => { const ks = [x.name, x.name_en].map(nameKey).filter(Boolean); return list.find((r) => ks.includes(nameKey(r.name)) || (r.name_en && ks.includes(nameKey(r.name_en)))); };
  let nc = 0; let ns = 0;
  for (const [gi, g] of groups.entries()) { // eslint-disable-line no-restricted-syntax
    if (!g || !(g.name || g.name_en)) continue; // eslint-disable-line no-continue
    let cat = find(cats, g);
    if (!cat) {
      const row = { business_id: ctx.businessId, name: text(g.name || g.name_en, 120), name_en: text(g.name_en, 120) || null, sort_order: (gi + 1) * 10, is_active: true };
      const [id] = await knex('service_categories').insert(row); // eslint-disable-line no-await-in-loop
      cat = { id, ...row }; cats.push(cat); nc += 1;
      await audit.record(ctx, 'service_category.created', { entityType: 'service_category', entityId: id, newValues: { name: row.name, source: 'website_import' } }); // eslint-disable-line no-await-in-loop
    }
    for (const [si, x] of (Array.isArray(g.items) ? g.items : []).slice(0, 40).entries()) { // eslint-disable-line no-restricted-syntax
      if (!x || !(x.name || x.name_en)) continue; // eslint-disable-line no-continue
      const have = find(svcs, x);
      const dur = Math.min(480, Math.max(5, Math.round(Number(x.duration) || 30)));
      if (have) {
        const patch = {};
        if (!have.category_id) patch.category_id = cat.id;
        if (!have.name_en && text(x.name_en, 190)) patch.name_en = text(x.name_en, 190);
        if (!have.description && text(x.description, 3000)) patch.description = text(x.description, 3000);
        if (!have.description_en && text(x.description_en, 3000)) patch.description_en = text(x.description_en, 3000);
        if (Object.keys(patch).length) await knex('services').where({ business_id: ctx.businessId, id: have.id }).update({ ...patch, updated_at: new Date() }); // eslint-disable-line no-await-in-loop
        continue; // eslint-disable-line no-continue
      }
      const row = { business_id: ctx.businessId, category_id: cat.id, name: text(x.name || x.name_en, 190), name_en: text(x.name_en, 190) || null,
        description: text(x.description, 3000) || null, description_en: text(x.description_en, 3000) || null, price: 0, show_price: false, duration_minutes: dur, is_active: true, sort_order: (gi + 1) * 100 + si };
      const [id] = await knex('services').insert(row); // eslint-disable-line no-await-in-loop
      svcs.push({ id, ...row }); ns += 1;
      await audit.record(ctx, 'service.created', { entityType: 'service', entityId: id, newValues: { name: row.name, source: 'website_import' } }); // eslint-disable-line no-await-in-loop
    }
  }
  return { categories: nc, services: ns };
}

/** Replaces "@media:<ref>" strings (anywhere in the document) by the pictures' ids. */
function resolveRefs(v, mediaIds) {
  if (typeof v === 'string') { const m = /^@media:([a-z0-9_-]{1,40})$/i.exec(v); return m ? (mediaIds[m[1]] || null) : v; }
  if (Array.isArray(v)) return v.map((x) => resolveRefs(x, mediaIds)).filter((x) => x !== null || !Array.isArray(v));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRefs(x, mediaIds)]));
  return v;
}

/** Fills the draft from the package (the previous draft is kept as a version to restore). */
async function importSite(ctx, business, data, mediaIds) {
  if (!data.site || !Array.isArray(data.site.pages)) return 0;
  const { doc: current } = await site.draft(ctx, business);
  // Keep the draft as it was, as a version the clinic can restore (Website → Settings → Versions).
  await knex('clinic_site_versions').insert({ business_id: ctx.businessId, kind: 'archived', doc: JSON.stringify(current), created_by: ctx.userId || null });
  const s = resolveRefs(data.site, mediaIds);
  const brand = { ...(current.brand || {}) };
  const b = s.brand || {};
  if (b.logo && !brand.logoMediaId) brand.logoMediaId = b.logo;
  if (b.logoDark && !brand.logoDarkMediaId) brand.logoDarkMediaId = b.logoDark;
  if (b.favicon && !brand.faviconMediaId) brand.faviconMediaId = b.favicon;
  if (b.motion && (!current.brand || current.brand.motion === 'none')) brand.motion = b.motion;
  const next = {
    ...current, brand, theme: s.theme || current.theme, pages: s.pages,
    header: { ...(current.header || {}), ...(s.header || {}), dark_mode: current.header ? current.header.dark_mode : true },
    footer: { ...(current.footer || {}), ...(s.footer || {}) },
    seo: { ...(current.seo || {}), ...(s.seo || {}) },
  };
  const clean = await site.saveDraft(ctx, business, next, { note: 'website.content_imported', details: { pages: s.pages.length } });
  return clean.pages.length;
}

/**
 * Imports a package from a file on disk. opts: { doctors, createDoctors, replacePhotos, site } (booleans).
 * Returns { media, updated, created, pages }.
 */
async function run(ctx, business, file, opts = {}) {
  const { data, zip } = open(file);
  try {
    const mediaIds = await importMedia(ctx, data, zip);
    const centre = business && business.kind === 'center_admin';
    let docs = { updated: [], created: [] };
    if (opts.doctors !== false) {
      docs = centre ? await importDoctorsCenter(ctx, business, data, zip, { photos: opts.replacePhotos !== false })
        : await importDoctors(ctx, data, mediaIds, { create: opts.createDoctors !== false, photos: opts.replacePhotos !== false });
    }
    // A centre's services belong to its clinics (each clinic imports its own).
    const svc = opts.services === false || centre ? { categories: 0, services: 0 } : await importServices(ctx, data);
    const pages = opts.site === false ? 0 : await importSite(ctx, business, data, mediaIds);
    await audit.record(ctx, 'website.import', { entityType: 'clinic_site', entityId: ctx.businessId, newValues: { media: Object.keys(mediaIds).length, doctors_updated: docs.updated.length, doctors_created: docs.created.length, pages, ...svc } });
    require('../../core/cache').forgetPrefix(`media:docs:${ctx.businessId}`); // eslint-disable-line global-require
    return { media: Object.keys(mediaIds).length, ...docs, pages, ...svc };
  } finally { zip.close(); }
}

/** Saves an uploaded package to a private temporary file (removed by the caller). */
function toTemp(buffer) {
  if (!buffer || buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw fail('IMPORT_BAD_FILE', 'Choose the .zip content file.');
  if (buffer.length > MAX_ZIP) throw fail('IMPORT_TOO_BIG', 'The file is too large.');
  const f = path.join(os.tmpdir(), `site-import-${crypto.randomBytes(8).toString('hex')}.zip`);
  fs.writeFileSync(f, buffer, { mode: 0o600 });
  return f;
}

module.exports = { run, open, summary, toTemp, nameKey, resolveRefs, MAX_ZIP };
