// Declarative admin CRUD ("resources"): one definition gives a searchable, filterable, paginated list, a sectioned
// bilingual form with validation, delete, CSV export and CSV import — with permissions and the audit log.
// Used for the catalogue (universities, programs, scholarships, destinations) and website content.
//
//   resource({ key, table, entity, perms: { view, manage, import? }, nameField, sections: [{ key, fields: [...] }],
//              list: { columns, search, filters, defaultSort }, slugFrom, beforeSave, afterSave, publicUrl, csv })
//   field: { name, type, label?, required?, bilingual?, options?, min?, max?, step?, hint?, internal?, span?, rows? }
//   types: text, textarea, markdown, number, money, int, select, checks, bool, date, list (one per line), url, slug, image, json
const express = require('express');
const knex = require('../db/knex');
const audit = require('./audit');
const { E } = require('./errors');
const { z, validate, blank } = require('./validate');
const { toCsv, parseCsv } = require('./csv');
const { ah, idParam } = require('./http');
const { can } = require('../middleware/auth');
const { flash, allowMultipart } = require('../middleware/web');
const uploads = require('./uploads');

const slugify = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);

/** Expands bilingual fields (name → name_en + name_ar). */
function expand(fields) {
  return fields.flatMap((f) => (f.bilingual ? [
    { ...f, name: `${f.name}_en`, base: f.name, lang: 'en', bilingual: false },
    { ...f, name: `${f.name}_ar`, base: f.name, lang: 'ar', bilingual: false, required: false },
  ] : [f]));
}

function zodFor(f) {
  const max = f.max;
  switch (f.type) {
    case 'number': case 'money': return z.preprocess((v) => (blank(v) === undefined ? null : Number(String(v).replace(/,/g, ''))), z.number({ invalid_type_error: 'Enter a number.' }).finite().min(f.min ?? 0, 'Too small.').max(max ?? 1e12, 'Too large.').nullable());
    case 'int': return z.preprocess((v) => (blank(v) === undefined ? null : Number(v)), z.number({ invalid_type_error: 'Enter a number.' }).int('Enter a whole number.').min(f.min ?? 0, 'Too small.').max(max ?? 2147483647, 'Too large.').nullable());
    case 'bool': return z.preprocess((raw) => { const v = Array.isArray(raw) ? raw[raw.length - 1] : raw; return v === true || v === '1' || v === 'on' || v === 1 || v === 'true' || v === 'yes'; }, z.boolean());
    case 'date': return z.preprocess((v) => (blank(v) === undefined ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.').nullable());
    case 'datetime': return z.preprocess((v) => (blank(v) === undefined ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Enter a valid date and time.').nullable());
    case 'select': return z.preprocess((v) => (blank(v) === undefined ? null : v), z.string().max(120).nullable());
    case 'checks': return z.preprocess((v) => (v === undefined || v === null || v === '' ? [] : [].concat(v).map(String).filter(Boolean)), z.array(z.string().max(120)).max(200));
    case 'list': return z.preprocess((v) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map((s) => String(s).trim()).filter(Boolean), z.array(z.string().max(500)).max(100));
    case 'url': case 'image': return z.preprocess((v) => (blank(v) === undefined ? null : String(v).trim()), z.string().max(500).refine((v) => /^(https?:\/\/|\/)/.test(v), 'Enter a full address starting with https://').nullable());
    case 'json': return z.preprocess((v) => { if (blank(v) === undefined) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return '__invalid__'; } }, z.any().refine((v) => v !== '__invalid__', 'Invalid JSON.'));
    case 'slug': return z.preprocess((v) => (blank(v) === undefined ? null : slugify(v)), z.string().max(140).nullable());
    case 'markdown': case 'textarea': return z.preprocess((v) => (blank(v) === undefined ? null : String(v)), z.string().max(max || 60000, 'Too long.').nullable());
    default: return z.preprocess((v) => (blank(v) === undefined ? null : String(v).trim()), z.string().max(max || 255, 'Too long.').nullable());
  }
}

function resource(def) {
  const fields = expand(def.sections.flatMap((s) => s.fields));
  const listDef = def.list || {};
  const perms = { view: 'catalog.view', manage: 'catalog.manage', import: 'catalog.import', ...(def.perms || {}) };
  const JSON_TYPES = new Set(['checks', 'list', 'json']);
  const parseRow = (row) => {
    if (!row) return row;
    const out = { ...row };
    fields.filter((f) => JSON_TYPES.has(f.type)).forEach((f) => {
      const v = out[f.name];
      if (typeof v === 'string') { try { out[f.name] = JSON.parse(v); } catch { out[f.name] = f.type === 'json' ? null : []; } }
      else if (v === null || v === undefined) out[f.name] = f.type === 'json' ? null : [];
    });
    return out;
  };

  function schema(canInternal) {
    const shape = {};
    fields.filter((f) => !f.readOnly && (canInternal || !f.internal)).forEach((f) => {
      let s = zodFor(f);
      if (f.required) s = s.refine((v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length), 'Required.');
      shape[f.name] = s;
    });
    return z.object(shape);
  }

  /** Form values → database row (JSON columns stringified, slug filled). */
  async function toRow(data, existing, tz = 'UTC') {
    const row = { ...data };
    fields.filter((f) => f.type === 'datetime' && row[f.name]).forEach((f) => { row[f.name] = require('./format').zonedToUtc(row[f.name], tz); }); // eslint-disable-line global-require
    fields.filter((f) => f.virtual).forEach((f) => { delete row[f.name]; });
    fields.filter((f) => JSON_TYPES.has(f.type) && f.name in row).forEach((f) => { row[f.name] = row[f.name] === null ? null : JSON.stringify(row[f.name]); });
    if (def.slugFrom && fields.some((f) => f.name === 'slug')) {
      let base = row.slug || (existing && existing.slug) || slugify(row[def.slugFrom]) || `${def.key}-${Date.now().toString(36)}`;
      base = slugify(base);
      let slug = base;
      for (let i = 2; await knex(def.table).where({ slug }).modify((q) => { if (existing) q.whereNot('id', existing.id); }).first('id'); i += 1) slug = `${base}-${i}`; // eslint-disable-line no-await-in-loop
      row.slug = slug;
    }
    return def.beforeSave ? def.beforeSave(row, existing) : row;
  }

  async function options(req) {
    const out = {};
    for (const f of fields) {
      if (typeof f.options === 'function') out[f.name] = await f.options(req); // eslint-disable-line no-await-in-loop
      else if (Array.isArray(f.options)) out[f.name] = f.options.map((o) => (typeof o === 'string' ? { value: o, label: f.optionLabel ? req.t(`${f.optionLabel}.${o}`) : o } : o));
    }
    for (const fl of (listDef.filters || [])) {
      if (!out[fl.key] && typeof fl.options === 'function') out[fl.key] = await fl.options(req); // eslint-disable-line no-await-in-loop
      else if (!out[fl.key] && Array.isArray(fl.options)) out[fl.key] = fl.options.map((o) => (typeof o === 'string' ? { value: o, label: fl.optionLabel ? req.t(`${fl.optionLabel}.${o}`) : o } : { ...o, label: fl.translate ? req.t(o.label) : o.label }));
    }
    return out;
  }

  function filtered(params) {
    const q = knex(def.table);
    if (def.baseQuery) def.baseQuery(q);
    if (params.q && (listDef.search || []).length) {
      const term = `%${String(params.q).trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      q.where((w) => listDef.search.forEach((c) => w.orWhere(`${def.table}.${c}`, 'like', term)));
    }
    for (const fl of (listDef.filters || [])) {
      const v = params[fl.key];
      if (v === undefined || v === '') continue; // eslint-disable-line no-continue
      if (fl.apply) fl.apply(q, v); else q.where(`${def.table}.${fl.column || fl.key}`, v);
    }
    if (params.demo === '1') q.where(`${def.table}.is_demo`, true);
    return q;
  }

  const router = express.Router();
  const base = `/staff/${def.key}`;
  const PER = listDef.perPage || 30;
  const canInternal = (req) => req.can('catalog.internal') || (def.internalPerm && req.can(def.internalPerm));
  const title = (req) => req.t(`resources.${def.key}.plural`);

  router.get('/', can(perms.view), ah(async (req, res) => {
    const q = filtered(req.query);
    const [{ n }] = await q.clone().count({ n: '*' });
    const page = Math.max(1, Number(req.query.page) || 1);
    const [col, dir] = listDef.defaultSort || ['id', 'desc'];
    const sel = listDef.select ? listDef.select(q.clone()) : q.clone().select(`${def.table}.*`);
    const rows = (await sel.orderBy(col, dir).orderBy(`${def.table}.id`, 'desc').limit(PER).offset((page - 1) * PER)).map(parseRow);
    const fmt = res.locals.fmt;
    const columns = (listDef.columns || [{ key: def.nameField || 'id', label: 'common.name', link: true }]);
    rows.forEach((r) => {
      r.cells = columns.map((c) => {
        if (c.render) return c.render(r, req);
        const v = r[c.key];
        if (c.type === 'bool') return v ? req.t('common.enabled') : req.t('common.disabled');
        if (c.type === 'date') return v ? fmt.date(v) : '—';
        return v === null || v === undefined || v === '' ? '—' : String(v);
      });
    });
    const importResult = req.session.importResult || null;
    delete req.session.importResult;
    res.page('pages/staff/resource/list', {
      columns, importResult,
      layout: 'staff', title: title(req), def, rows, opts: await options(req), base,
      meta: { total: Number(n), page, pages: Math.max(1, Math.ceil(Number(n) / PER)) }, canManage: req.can(perms.manage), canImport: Boolean(def.csv) && req.can(perms.import),
    });
  }));

  async function form(req, res, row, extra = {}) {
    res.page('pages/staff/resource/form', {
      layout: 'staff', narrow: true, title: row.id ? (row[def.nameField] || row.name_en || `#${row.id}`) : req.t(`resources.${def.key}.new`),
      def, row, fields, opts: await options(req), base, canManage: req.can(perms.manage), canInternal: canInternal(req),
      publicUrl: row.id && def.publicUrl ? def.publicUrl(row) : null, related: row.id && def.related ? await def.related(row, req) : [], ...extra,
    });
  }

  router.get('/new', can(perms.manage), ah(async (req, res) => form(req, res, { ...(def.defaults || {}), ...Object.fromEntries(Object.entries(req.query).filter(([k]) => fields.some((f) => f.name === k))) })));

  if (def.csv) {
    router.get('/export.csv', can(perms.view), ah(async (req, res) => {
      const rows = (await (listDef.select ? listDef.select(filtered(req.query)) : filtered(req.query).select(`${def.table}.*`)).orderBy(`${def.table}.id`).limit(50000)).map(parseRow);
      const cols = def.csv.columns.filter((c) => canInternal(req) || !fields.find((f) => f.name === c && f.internal)).map((c) => ({ key: c, value: def.csv.exportValue ? (r) => def.csv.exportValue(c, r) : undefined }));
      await audit.record(req.ctx, `${def.entity}.exported`, { entityType: def.entity, newValues: { count: rows.length } });
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${def.key}.csv"` });
      res.send(toCsv(cols, rows));
    }));
    allowMultipart(new RegExp(`^${base}/import/?$`));
    router.post('/import', can(perms.import), uploads.single('file', { maxMb: 10 }), ah(async (req, res) => {
      if (!req.file || !/\.csv$/i.test(req.file.originalname || '')) { flash(req, 'error', req.t('resources.import_csv_only')); return res.redirect(base); }
      const records = parseCsv(req.file.buffer.toString('utf8'));
      const sch = schema(canInternal(req));
      const result = { created: 0, updated: 0, errors: [] };
      for (let i = 0; i < records.length && i < 5000; i += 1) {
        const rec = await def.csv.importValue(records[i]); // eslint-disable-line no-await-in-loop
        try {
          const data = validate(sch.partial(), rec);
          const key = def.csv.key || 'slug';
          const existing = rec[key] ? await knex(def.table).where({ [key]: rec[key] }).first() : null; // eslint-disable-line no-await-in-loop
          const row = await toRow(Object.fromEntries(Object.entries(data).filter(([k]) => k in rec)), existing); // eslint-disable-line no-await-in-loop
          if (existing) { await knex(def.table).where({ id: existing.id }).update({ ...row, updated_at: new Date() }); result.updated += 1; } // eslint-disable-line no-await-in-loop
          else {
            const missing = fields.filter((f) => f.required && (row[f.name] === undefined || row[f.name] === null));
            if (missing.length) throw E.validation(Object.fromEntries(missing.map((f) => [f.name, 'Required.'])));
            await knex(def.table).insert(row); result.created += 1; // eslint-disable-line no-await-in-loop
          }
        } catch (e) {
          result.errors.push({ line: i + 2, message: e.details ? Object.entries(e.details).map(([k, v]) => `${k}: ${v}`).join('; ') : e.message });
        }
      }
      if (def.afterImport) await def.afterImport();
      await audit.record(req.ctx, `${def.entity}.imported`, { entityType: def.entity, newValues: { created: result.created, updated: result.updated, errors: result.errors.length } });
      req.session.importResult = result;
      return res.redirect(`${base}?imported=1`);
    }));
  }

  router.get('/:id', can(perms.view), ah(async (req, res) => {
    const row = parseRow(await knex(def.table).where({ id: idParam(req.params.id) }).first());
    if (!row) throw E.notFound();
    if (def.loadVirtual) Object.assign(row, await def.loadVirtual(row));
    return form(req, res, row);
  }));

  const save = (isNew) => ah(async (req, res) => {
    const existing = isNew ? null : await knex(def.table).where({ id: idParam(req.params.id) }).first();
    if (!isNew && !existing) throw E.notFound();
    try {
      const data = validate(schema(canInternal(req)), req.body);
      const row = await toRow(data, existing, res.locals.fmt.tz);
      let id;
      if (isNew) {
        [id] = await knex(def.table).insert(row);
        await audit.record(req.ctx, `${def.entity}.created`, { entityType: def.entity, entityId: id, newValues: row });
      } else {
        id = existing.id;
        const d = audit.diff(existing, row);
        if (d.changed) {
          await knex(def.table).where({ id }).update({ ...row, updated_at: new Date() });
          await audit.record(req.ctx, `${def.entity}.updated`, { entityType: def.entity, entityId: id, oldValues: d.oldValues, newValues: d.newValues });
        }
      }
      if (def.afterSave) await def.afterSave(id, req, data);
      flash(req, 'ok', req.t('common.saved'));
      return res.redirect(`${base}/${id}`);
    } catch (e) {
      if (e.code !== 'VALIDATION_FAILED') throw e;
      res.status(422);
      return form(req, res, existing ? parseRow(existing) : {}, { errors: e.details, old: req.body });
    }
  });
  router.post('/', can(perms.manage), save(true));
  router.post('/:id', can(perms.manage), save(false));

  router.post('/:id/delete', can(perms.manage), ah(async (req, res) => {
    const id = idParam(req.params.id);
    const row = await knex(def.table).where({ id }).first();
    if (!row) throw E.notFound();
    if (def.beforeDelete) await def.beforeDelete(row);
    await knex(def.table).where({ id }).del();
    await audit.record(req.ctx, `${def.entity}.deleted`, { entityType: def.entity, entityId: id, oldValues: { [def.nameField || 'id']: row[def.nameField || 'id'] } });
    if (def.afterSave) await def.afterSave(id, req);
    flash(req, 'ok', req.t('common.deleted'));
    return res.redirect(base);
  }));

  return { router, def, fields, parseRow, filtered, slugify };
}

module.exports = { resource, slugify };
