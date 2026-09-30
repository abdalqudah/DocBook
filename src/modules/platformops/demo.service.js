// Sample ("demo") data for a new clinic (worker: platformops).
//
// "Add sample data" creates a small, clearly labelled set — two doctors, a few services in two categories, three
// patients with obviously fake names and 07900000xx numbers, appointments over the next days and one paid invoice —
// and registers every row it creates in demo_records. "Remove sample data" deletes exactly the registered rows plus
// everything that hangs off them (visits notes, prescriptions, invoices, payments … found through the database's
// foreign keys and the <name>_id convention), in one transaction. A sample doctor / service / patient / category
// that a real record now uses (a real appointment with the sample doctor, say) is kept rather than touching that
// real record; the result says how many were kept.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { AppError } = require('../../core/errors');
const businesses = require('../businesses/business.service');
const scheduling = require('../clinic/scheduling');

// Tables whose sample rows are registered, in the order they are removed (children first).
const TRACKED = ['invoices', 'appointments', 'patients', 'services', 'service_categories', 'doctors'];
// Never deleted from, whatever points where: accounts, the clinic itself, the audit trail, the registry.
const PROTECTED = new Set(['businesses', 'users', 'memberships', 'roles', 'role_permissions', 'audit_logs', 'demo_records', 'invitations', 'sessions',
  'knex_migrations', 'knex_migrations_lock', 'platform_settings', 'clinic_ops_settings']);
// Links that are cleared (set to NULL) instead of deleting the row, e.g. a staff login linked to a sample doctor.
const NULLIFY = { memberships: ['doctor_id'], invitations: ['doctor_id'] };
// Doctors, services and categories are set-up records: besides sample rows, only their own settings go with them.
// Any other row that still points at one (a real patient's record with the sample doctor, say) keeps it.
const SETUP = new Set(['doctors', 'services', 'service_categories']);
const SETUP_DEPENDENTS = new Set(['doctor_signatures', 'doctor_days_off', 'commission_rules', 'calendar_feeds', 'doctor_online_slots', 'rep_visit_slots', 'doctor_emails']);

const TEXT = {
  ar: {
    mark: ' (تجريبي)',
    doctors: [{ name: 'د. سارة الأحمد', spec: 'طب عام', fee: 15 }, { name: 'د. خالد المصري', spec: 'طب أسنان', fee: 20 }],
    categories: ['استشارات', 'إجراءات'],
    services: [{ name: 'كشفية عامة', price: 15, min: 20, cat: 0, doc: null }, { name: 'استشارة متابعة', price: 10, min: 15, cat: 0, doc: null }, { name: 'تنظيف أسنان', price: 25, min: 30, cat: 1, doc: 1 }],
    patients: ['أحمد يوسف', 'ليان خالد', 'محمد سالم'],
  },
  en: {
    mark: ' (demo)',
    doctors: [{ name: 'Dr. Sara Ahmad', spec: 'General practice', fee: 15 }, { name: 'Dr. Khaled Masri', spec: 'Dentistry', fee: 20 }],
    categories: ['Consultations', 'Procedures'],
    services: [{ name: 'General consultation', price: 15, min: 20, cat: 0, doc: null }, { name: 'Follow-up visit', price: 10, min: 15, cat: 0, doc: null }, { name: 'Dental cleaning', price: 25, min: 30, cat: 1, doc: 1 }],
    patients: ['Ahmad Yousef', 'Layan Khaled', 'Mohammad Salem'],
  },
};

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayKey = (iso) => scheduling.DAY_KEYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];

/** How many sample rows the clinic has, per table → { total, byTable }. */
async function status(businessId) {
  const rows = await knex('demo_records').where({ business_id: businessId }).groupBy('table_name').select('table_name').count({ n: '*' });
  const byTable = Object.fromEntries(rows.map((r) => [r.table_name, Number(r.n)]));
  return { total: Object.values(byTable).reduce((a, b) => a + b, 0), byTable };
}

/** Creates the sample set. `locale` picks the language of the names. Refuses when sample data already exists. */
async function add(ctx, { locale = 'ar' } = {}) {
  const b = ctx.businessId;
  if ((await status(b)).total) throw new AppError('DEMO_EXISTS', 'Sample data is already there.', 409);
  const L = TEXT[locale === 'en' ? 'en' : 'ar'];
  const other = TEXT[locale === 'en' ? 'ar' : 'en'];
  const today = ctx.today || scheduling.clinicNow(ctx.timezone || 'Asia/Amman').date;
  const created = {};
  await knex.transaction(async (trx) => {
    const reg = async (table, id) => { (created[table] = created[table] || []).push(id); await trx('demo_records').insert({ business_id: b, table_name: table, record_id: id }); };
    const wh = JSON.stringify(scheduling.defaultWorkingHours());
    const doctors = [];
    for (let i = 0; i < L.doctors.length; i += 1) {
      const d = L.doctors[i]; const o = other.doctors[i];
      const ar = locale === 'en' ? o : d; const en = locale === 'en' ? d : o;
      const [id] = await trx('doctors').insert({
        business_id: b, full_name: ar.name + TEXT.ar.mark, full_name_en: en.name + TEXT.en.mark, specialization: ar.spec, specialization_en: en.spec,
        consultation_fee: d.fee, show_consultation_fee: true, base_salary: 0, is_active: true, sort_order: 900 + i, working_hours: wh, slot_duration_minutes: 20,
      });
      await reg('doctors', id); doctors.push({ id, name: (locale === 'en' ? en.name + TEXT.en.mark : ar.name + TEXT.ar.mark) });
    }
    const cats = [];
    for (let i = 0; i < L.categories.length; i += 1) {
      const ar = (locale === 'en' ? other : L).categories[i]; const en = (locale === 'en' ? L : other).categories[i];
      const [id] = await trx('service_categories').insert({ business_id: b, name: ar + TEXT.ar.mark, name_en: en + TEXT.en.mark, sort_order: 900 + i, is_active: true });
      await reg('service_categories', id); cats.push(id);
    }
    const services = [];
    for (let i = 0; i < L.services.length; i += 1) {
      const s = L.services[i];
      const ar = (locale === 'en' ? other : L).services[i]; const en = (locale === 'en' ? L : other).services[i];
      const [id] = await trx('services').insert({
        business_id: b, doctor_id: s.doc === null ? null : doctors[s.doc].id, category_id: cats[s.cat], name: ar.name + TEXT.ar.mark, name_en: en.name + TEXT.en.mark,
        price: s.price, show_price: true, duration_minutes: s.min, is_active: true, sort_order: 900 + i,
      });
      await reg('services', id); services.push({ id, name: (locale === 'en' ? en.name + TEXT.en.mark : ar.name + TEXT.ar.mark), price: s.price, min: s.min, doc: s.doc });
    }
    // Clearly fake numbers: 07900000xx, skipping any number a real patient of this clinic already uses.
    const used = new Set((await trx('patients').where({ business_id: b }).where('phone', 'like', '07900000%').select('phone')).map((r) => r.phone));
    let n = 0;
    const nextPhone = () => { do { n += 1; } while (used.has(`07900000${String(n).padStart(2, '0')}`)); return `07900000${String(n).padStart(2, '0')}`; };
    const patients = [];
    for (const name of L.patients) {
      const full = name + L.mark; const phone = nextPhone();
      const [id] = await trx('patients').insert({ business_id: b, full_name: full, phone, notes: locale === 'en' ? 'Sample record — remove it from Settings → Data.' : 'سجل تجريبي — يمكن حذفه من الإعدادات ← البيانات.' });
      await reg('patients', id); patients.push({ id, name: full, phone });
    }
    // Appointments: one finished and paid today, the rest over the next working days (clinic hours are 09:00–17:00, Friday off).
    const plan = [];
    let date = today; let day = 0;
    while (plan.length < 5 && day < 14) {
      date = addDays(today, day); day += 1;
      if (dayKey(date) === 'fri') continue; // eslint-disable-line no-continue
      const k = plan.length;
      plan.push({ date, time: ['10:00', '11:30', '09:20', '12:00', '15:00'][k], p: patients[k % patients.length], s: services[k % services.length], status: k === 0 ? 'completed' : k === 1 ? 'confirmed' : 'pending' });
    }
    let first = null;
    for (const a of plan) {
      const doctor = a.s.doc === null ? doctors[0] : doctors[a.s.doc];
      const [id] = await trx('appointments').insert({
        business_id: b, doctor_id: doctor.id, service_id: a.s.id, patient_id: a.p.id, patient_name: a.p.name, patient_phone: a.p.phone,
        appointment_date: a.date, appointment_time: a.time, duration_minutes: a.s.min, status: a.status, appointment_type: 'in_person', source: 'staff',
        amount_due: a.s.price, payment_status: 'unpaid', created_by: ctx.userId || null,
      });
      await reg('appointments', id);
      if (!first) first = { id, a, doctor };
    }
    // One paid invoice for the finished visit.
    if (first) {
      const number = await businesses.claimInvoiceNumber(b, trx);
      const [id] = await trx('invoices').insert({
        business_id: b, invoice_number: number, appointment_id: first.id, doctor_id: first.doctor.id, patient_id: first.a.p.id, doctor_name: first.doctor.name,
        service_name: first.a.s.name, patient_name: first.a.p.name, patient_phone: first.a.p.phone, amount: first.a.s.price, payment_method: 'cash',
        discount_percent: 0, discount_amount: 0, created_by: ctx.userId || null,
      });
      await reg('invoices', id);
      await trx('appointments').where({ id: first.id, business_id: b }).update({ payment_status: 'paid', paid_at: new Date(), checked_in: true, arrived_at: new Date() });
    }
    const counts = Object.fromEntries(Object.entries(created).map(([k, v]) => [k, v.length]));
    await audit.record(ctx, 'clinic.demo_added', { entityType: 'clinic', entityId: b, newValues: counts }, trx);
  });
  businesses.forget(b);
  return Object.fromEntries(Object.entries(created).map(([k, v]) => [k, v.length]));
}

// ---------------------------------------------------------------- removal
/** Every (table, column) in this database that refers to `table`: declared foreign keys + the <singular>_id convention. */
async function referencesTo(trx, table, schema) {
  const fk = await trx('information_schema.KEY_COLUMN_USAGE').where({ TABLE_SCHEMA: schema, REFERENCED_TABLE_NAME: table }).select('TABLE_NAME as t', 'COLUMN_NAME as c');
  const conv = `${table.replace(/ies$/, 'y').replace(/s$/, '')}_id`;
  const named = await trx('information_schema.COLUMNS').where({ TABLE_SCHEMA: schema, COLUMN_NAME: conv }).select('TABLE_NAME as t', 'COLUMN_NAME as c');
  const seen = new Set();
  return [...fk, ...named].filter((r) => { const k = `${r.t}.${r.c}`; if (seen.has(k) || r.t === table) return false; seen.add(k); return true; });
}

async function columnsOf(trx, table, schema, memo) {
  if (!memo[table]) memo[table] = new Set((await trx('information_schema.COLUMNS').where({ TABLE_SCHEMA: schema, TABLE_NAME: table }).select('COLUMN_NAME as c')).map((r) => r.c));
  return memo[table];
}

/**
 * Removes the sample data (and what depends on it) in one transaction. Real records are never deleted or changed,
 * except that a staff login linked to a sample doctor is unlinked. → { removed: {table: n}, kept: n }.
 */
async function remove(ctx) {
  const b = ctx.businessId;
  const result = await knex.transaction(async (trx) => {
    const [[{ db }]] = await trx.raw('SELECT DATABASE() AS db');
    const reg = await trx('demo_records').where({ business_id: b }).select('table_name', 'record_id');
    if (!reg.length) return { removed: {}, kept: 0 };
    const ids = Object.fromEntries(TRACKED.map((t) => [t, new Set()]));
    for (const r of reg) if (ids[r.table_name]) ids[r.table_name].add(Number(r.record_id));
    const arr = (t) => [...ids[t]];
    const keep = (t, v) => { if (v !== null && v !== undefined && ids[t].has(Number(v))) { ids[t].delete(Number(v)); kept.add(`${t}:${v}`); } };
    const kept = new Set();

    // 1. A sample parent that a real row uses stays (so the real row is not changed).
    if (ids.doctors.size || ids.services.size || ids.patients.size) {
      const realAppts = await trx('appointments').where({ business_id: b }).whereNotIn('id', arr('appointments').length ? arr('appointments') : [0])
        .andWhere((q) => q.whereIn('doctor_id', arr('doctors').concat(0)).orWhereIn('service_id', arr('services').concat(0)).orWhereIn('patient_id', arr('patients').concat(0)))
        .select('doctor_id', 'service_id', 'patient_id');
      for (const a of realAppts) { keep('doctors', a.doctor_id); keep('services', a.service_id); keep('patients', a.patient_id); }
    }
    const realInv = await trx('invoices').where({ business_id: b }).whereNotIn('id', arr('invoices').concat(0))
      .andWhere((q) => q.whereNull('appointment_id').orWhereNotIn('appointment_id', arr('appointments').concat(0)))
      .andWhere((q) => q.whereIn('doctor_id', arr('doctors').concat(0)).orWhereIn('patient_id', arr('patients').concat(0)))
      .select('doctor_id', 'patient_id');
    for (const i of realInv) { keep('doctors', i.doctor_id); keep('patients', i.patient_id); }
    const realSvc = await trx('services').where({ business_id: b }).whereNotIn('id', arr('services').concat(0))
      .andWhere((q) => q.whereIn('doctor_id', arr('doctors').concat(0)).orWhereIn('category_id', arr('service_categories').concat(0)))
      .select('doctor_id', 'category_id');
    for (const s of realSvc) { keep('doctors', s.doctor_id); keep('service_categories', s.category_id); }

    // 2. Delete dependents, then the rows themselves.
    const memo = {};
    const removed = {};
    const done = new Set();
    const count = (t, n) => { if (n) removed[t] = (removed[t] || 0) + n; };
    async function drop(table, list, depth) {
      const todo = list.filter((id) => !done.has(`${table}:${id}`));
      if (!todo.length) return;
      todo.forEach((id) => done.add(`${table}:${id}`));
      if (depth < 5) {
        for (const ref of await referencesTo(trx, table, db)) {
          const cols = await columnsOf(trx, ref.t, db, memo);
          const scope = (q) => (cols.has('business_id') ? q.where('business_id', b) : q);
          if (NULLIFY[ref.t] && NULLIFY[ref.t].includes(ref.c)) { await scope(trx(ref.t).whereIn(ref.c, todo)).update({ [ref.c]: null }); continue; } // eslint-disable-line no-continue
          if (PROTECTED.has(ref.t) || ref.t.startsWith('knex_')) continue; // eslint-disable-line no-continue
          if (ids[ref.t]) {
            // Another tracked table (an appointment of a sample doctor…): only its sample rows go; real ones were kept above.
            const childIds = (await scope(trx(ref.t).whereIn(ref.c, todo)).select('id')).map((r) => r.id).filter((id) => ids[ref.t].has(Number(id)));
            await drop(ref.t, childIds, depth + 1);
            continue; // eslint-disable-line no-continue
          }
          if (cols.has('id')) {
            const childIds = (await scope(trx(ref.t).whereIn(ref.c, todo)).select('id')).map((r) => r.id);
            await drop(ref.t, childIds, depth + 1);
          } else {
            count(ref.t, await scope(trx(ref.t).whereIn(ref.c, todo)).del());
          }
        }
      }
      const cols = await columnsOf(trx, table, db, memo);
      const q = trx(table).whereIn('id', todo);
      if (cols.has('business_id')) q.where('business_id', b);
      count(table, await q.del());
    }
    // Appointment parents first so that follow-ups pointing at a sample visit do not block it.
    await trx('appointments').where({ business_id: b }).whereIn('id', arr('appointments').concat(0)).update({ parent_appointment_id: null });
    const invoiceNumbers = arr('invoices').length ? (await trx('invoices').where({ business_id: b }).whereIn('id', arr('invoices')).select('invoice_number')).map((r) => Number(r.invoice_number)) : [];
    // Fake patients' records first (visits, invoices and everything under them) …
    for (const t of ['invoices', 'appointments', 'patients']) await drop(t, arr(t), 0);
    // … then the set-up records nothing real points at any more.
    for (const t of ['services', 'service_categories', 'doctors']) {
      for (const ref of await referencesTo(trx, t, db)) {
        if (!ids[t].size) break;
        if (ids[ref.t] || PROTECTED.has(ref.t) || NULLIFY[ref.t] || SETUP_DEPENDENTS.has(ref.t) || ref.t.startsWith('knex_')) continue; // eslint-disable-line no-continue
        const cols = await columnsOf(trx, ref.t, db, memo);
        const q = trx(ref.t).whereIn(ref.c, arr(t)).distinct(ref.c);
        if (cols.has('business_id')) q.where('business_id', b);
        for (const r of await q) keep(t, r[ref.c]);
      }
      // A kept sample service keeps its sample category and doctor.
      const keptSvc = [...kept].filter((k) => k.startsWith('services:')).map((k) => Number(k.split(':')[1]));
      if (t !== 'services' && keptSvc.length) {
        for (const sv of await trx('services').where({ business_id: b }).whereIn('id', keptSvc).select('doctor_id', 'category_id')) keep(t, t === 'doctors' ? sv.doctor_id : sv.category_id);
      }
      await drop(t, arr(t), 0);
    }

    // 3. Give the sample invoice's number back when nothing was issued after it.
    if (invoiceNumbers.length) {
      const row = await trx('businesses').where({ id: b }).forUpdate().first('invoice_next_number');
      const top = Math.max(...invoiceNumbers);
      const [{ max }] = await trx('invoices').where({ business_id: b }).max({ max: 'invoice_number' });
      if (Number(row.invoice_next_number) === top + 1 && Number(max || 0) < Math.min(...invoiceNumbers)) {
        await trx('businesses').where({ id: b }).update({ invoice_next_number: Math.min(...invoiceNumbers) });
      }
    }
    // 4. Unregister what is gone; kept rows stay registered (they can be removed later).
    for (const t of TRACKED) {
      const gone = [...done].filter((k) => k.startsWith(`${t}:`)).map((k) => Number(k.split(':')[1]));
      if (gone.length) await trx('demo_records').where({ business_id: b, table_name: t }).whereIn('record_id', gone).del();
    }
    await audit.record(ctx, 'clinic.demo_removed', { entityType: 'clinic', entityId: b, oldValues: removed, newValues: { kept: kept.size } }, trx);
    return { removed, kept: kept.size };
  });
  businesses.forget(b);
  return result;
}

module.exports = { status, add, remove, TRACKED };
