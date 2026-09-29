// Copy of a clinic's data to its own database (Settings → Your database).
// The clinic enters its MySQL/MariaDB or PostgreSQL connection; DocBook creates tables with a prefix
// (db_patients, db_appointments, …) and refreshes them on a schedule or on demand. DocBook stays the source of
// truth: the copy is one-way, each table is replaced inside a transaction, nothing is read back, and tables with
// other names in the clinic's database are never touched.
const dns = require('dns').promises;
const net = require('net');
const knexFactory = require('knex');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { isPrivateIp } = require('../../core/http');
const { E, AppError } = require('../../core/errors');

// Column types: i int, s string(255), t text, d date, dt datetime (UTC), n decimal(15,3), b boolean
const T = (source, cols, extra = {}) => ({ source, cols, ...extra });
const vitals = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v) || {}; } catch { return {}; } };

// `permission`: only someone holding it may choose the dataset. `sensitive`: health or salary data — off by
// default and needs an explicit acknowledgement that the clinic protects its copy.
const DATASETS = {
  clinic: {
    tables: {
      doctors: T('doctors', { id: 'i', full_name: 's', full_name_en: 's', specialization: 's', specialization_en: 's', phone: 's', email: 's', license_number: 's', is_active: 'b', slot_duration_minutes: 'i', consultation_fee: 'n', working_hours: 't', created_at: 'dt', updated_at: 'dt' }),
      services: T('services', { id: 'i', doctor_id: 'i', name: 's', name_en: 's', price: 'n', duration_minutes: 'i', is_active: 'b', created_at: 'dt', updated_at: 'dt' }),
    },
  },
  patients: {
    tables: {
      patients: T('patients', { id: 'i', full_name: 's', phone: 's', email: 's', date_of_birth: 'd', gender: 's', insurance_provider_id: 'i', insurance_number: 's', created_at: 'dt', updated_at: 'dt' }),
      insurance_providers: T('insurance_providers', { id: 'i', name: 's', coverage_percent: 'n', is_active: 'b', created_at: 'dt', updated_at: 'dt' }),
    },
  },
  appointments: {
    tables: {
      appointments: T('appointments', { id: 'i', doctor_id: 'i', service_id: 'i', patient_id: 'i', patient_name: 's', patient_phone: 's', appointment_date: 'd', appointment_time: 's', duration_minutes: 'i', status: 's', appointment_type: 's', source: 's', amount_due: 'n', payment_status: 's', paid_at: 'dt', checked_in: 'b', arrived_at: 'dt', called_at: 'dt', parent_appointment_id: 'i', created_at: 'dt', updated_at: 'dt' }),
    },
  },
  billing: {
    tables: {
      invoices: T('invoices', { id: 'i', invoice_number: 'i', appointment_id: 'i', doctor_id: 'i', patient_id: 'i', doctor_name: 's', service_name: 's', patient_name: 's', patient_phone: 's', subtotal: 'n', discount_percent: 'n', discount_amount: 'n', amount: 'n', amount_received: 'n', change_due: 'n', payment_method: 's', insurance_provider_id: 'i', insurance_provider_name: 's', insurance_coverage_percent: 'n', created_at: 'dt' }),
      // One row per bill line (the lines live as JSON on the invoice; older invoices have one line).
      invoice_items: T('invoices', { id: 'i', invoice_id: 'i', invoice_number: 'i', line_no: 'i', name: 's', service_id: 'i', qty: 'n', unit_price: 'n', total: 'n', created_at: 'dt' }, {
        select: ['id', 'invoice_number', 'items', 'service_name', 'subtotal', 'amount', 'created_at'],
        expand: (inv) => {
          let lines = [];
          try { lines = inv.items ? (typeof inv.items === 'string' ? JSON.parse(inv.items) : inv.items) : []; } catch { lines = []; }
          if (!Array.isArray(lines) || !lines.length) {
            const total = inv.subtotal !== null && inv.subtotal !== undefined ? inv.subtotal : inv.amount;
            lines = [{ name: inv.service_name, qty: 1, unitPrice: total, total }];
          }
          return lines.map((l, i) => ({ invoice_id: inv.id, invoice_number: inv.invoice_number, line_no: i + 1, name: l.name, service_id: l.serviceId || null, qty: l.qty, unit_price: l.unitPrice, total: l.total, created_at: inv.created_at }));
        },
      }),
      cash_closings: T('cash_closings', { id: 'i', period_start: 'dt', period_end: 'dt', expected_cash: 'n', counted_cash: 'n', variance: 'n', invoice_count: 'i', closed_by: 'i', created_at: 'dt' }),
    },
  },
  expenses: {
    tables: {
      expenses: T('expenses', { id: 'i', date: 'd', category: 's', title: 's', amount: 'n', payment_method: 's', invoice_number: 's', recorded_by: 's', created_at: 'dt', updated_at: 'dt' }),
      expense_categories: T('expense_categories', { id: 'i', key: 's', name: 's' }),
    },
  },
  supplies: {
    tables: {
      suppliers: T('suppliers', { id: 'i', name: 's', email: 's', phone: 's', is_active: 'b', created_at: 'dt', updated_at: 'dt' }),
      supply_items: T('supply_items', { id: 'i', supplier_id: 'i', name: 's', unit: 's', current_stock: 'n', reorder_level: 'n', unit_cost: 'n', created_at: 'dt', updated_at: 'dt' }),
      stock_movements: T('stock_movements', { id: 'i', item_id: 'i', type: 's', quantity: 'n', stock_after: 'n', note: 's', created_by: 'i', created_at: 'dt' }),
    },
  },
  attendance: {
    permission: 'attendance.view',
    tables: {
      // Clock-in/out times only; the IP address and browser kept for audit stay in DocBook.
      staff_attendance: T('attendance_records', { id: 'i', user_id: 'i', work_date: 'd', clock_in: 'dt', clock_out: 'dt', in_method: 's', out_method: 's', correction_reason: 's', corrected_by: 'i', corrected_at: 'dt', created_at: 'dt', updated_at: 'dt' }),
    },
  },
  payroll: {
    permission: 'payroll.view',
    sensitive: true,
    tables: {
      payroll_payments: T('payroll_payments', { id: 'i', doctor_id: 'i', period: 's', base_salary: 'n', commission: 'n', bonuses: 'n', deductions: 'n', advances: 'n', net_pay: 'n', payment_method: 's', reference: 's', paid_by: 'i', paid_at: 'dt' }),
      payroll_adjustments: T('payroll_adjustments', { id: 'i', doctor_id: 'i', type: 's', amount: 'n', reason: 's', period: 's', approval_status: 's', created_by: 'i', approved_by: 'i', created_at: 'dt' }),
      doctor_salaries: T('doctors', { id: 'i', full_name: 's', base_salary: 'n', updated_at: 'dt' }),
      commission_rules: T('commission_rules', { id: 'i', doctor_id: 'i', basis: 's', rate: 'n', service_overrides: 't', updated_at: 'dt' }),
    },
  },
  clinical: {
    permission: 'clinical.view',
    sensitive: true,
    tables: {
      consultations: T('consultations', { id: 'i', appointment_id: 'i', doctor_id: 'i', patient_id: 'i', patient_name: 's', subjective: 't', objective: 't', assessment: 't', plan_text: 't', diagnosis: 't', created_at: 'dt', updated_at: 'dt' }),
      vital_signs: T('consultations', { id: 'i', consultation_id: 'i', appointment_id: 'i', patient_id: 'i', doctor_id: 'i', weight_kg: 'n', height_cm: 'n', temperature_c: 'n', pulse_bpm: 'i', spo2: 'i', blood_pressure: 's', respiratory_rate: 'i', blood_sugar: 'n', recorded_at: 'dt' }, {
        select: ['id', 'appointment_id', 'patient_id', 'doctor_id', 'vital_signs', 'updated_at'],
        expand: (c) => {
          const v = vitals(c.vital_signs);
          if (!Object.keys(v).length) return [];
          return [{ consultation_id: c.id, appointment_id: c.appointment_id, patient_id: c.patient_id, doctor_id: c.doctor_id, weight_kg: v.weightKg, height_cm: v.heightCm, temperature_c: v.temperatureC, pulse_bpm: v.pulseBpm, spo2: v.spo2, blood_pressure: v.bloodPressure, respiratory_rate: v.respiratoryRate, blood_sugar: v.bloodSugar, recorded_at: c.updated_at }];
        },
      }),
      prescriptions: T('prescriptions', { id: 'i', appointment_id: 'i', doctor_id: 'i', patient_id: 'i', patient_name: 's', diagnosis: 't', items: 't', notes: 't', created_by: 'i', created_at: 'dt' }),
      patient_health: T('patients', { id: 'i', allergies: 't', chronic_conditions: 't', notes: 't', updated_at: 'dt' }),
    },
  },
};
const DEFAULT_DATASETS = ['clinic', 'patients', 'appointments', 'billing', 'expenses', 'supplies'];
const DRIVERS = { mysql: { client: 'mysql2', port: 3306 }, postgres: { client: 'pg', port: 5432 } };
const FREQUENCIES = { manual: null, hourly: 3_600_000, daily: 86_400_000 };
const CHUNK = 500;
// knex would print connection errors to the server log; failures are reported through reason() instead.
const QUIET = { warn() {}, error() {}, debug() {}, deprecate() {}, inspectionDepth: 0 };
const RUN_TIMEOUT = 20 * 60_000;
const STALE_LOCK = 30 * 60_000;
// Internal addresses are refused. Only tests / local development may lift that, with an explicit flag.
const allowPrivate = () => process.env.DATASYNC_ALLOW_PRIVATE === 'true' && process.env.NODE_ENV !== 'production';

// ---------- Settings ----------
const parseList = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v || '[]') || []; } catch { return []; } };

async function get(businessId) {
  const r = await knex('clinic_data_sync').where({ business_id: businessId }).first();
  if (!r) return null;
  const { password_enc: enc, ...rest } = r;
  return { ...rest, datasets: parseList(r.datasets).filter((d) => DATASETS[d]), hasPassword: Boolean(enc) };
}

/** Datasets this person may choose (their own permissions decide the clinical and payroll ones). */
function available(ctx) {
  return Object.keys(DATASETS).filter((k) => !DATASETS[k].permission || ctx.permissions.has(DATASETS[k].permission));
}

function clean(body, cur) {
  const errors = {};
  const driver = DRIVERS[body.driver] ? body.driver : 'mysql';
  const host = String(body.host || '').trim().toLowerCase();
  const port = Number(body.port || DRIVERS[driver].port);
  const database = String(body.database_name || '').trim();
  const username = String(body.username || '').trim();
  const prefix = String(body.table_prefix ?? 'db_').trim().toLowerCase();
  if (!/^(?=.{1,190}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) && !net.isIP(host)) errors.host = 'Enter the database server name or IP address.';
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'Enter a port between 1 and 65535.';
  if (!/^[A-Za-z0-9_$-]{1,64}$/.test(database)) errors.database_name = 'Enter the database name (letters, numbers, _ and -).';
  if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(username)) errors.username = 'Enter the database username.';
  if (!/^[a-z][a-z0-9_]{0,15}$/.test(prefix)) errors.table_prefix = 'Use a short prefix like db_ (lowercase letters, numbers and _).';
  if (!body.password && !(cur && cur.hasPassword)) errors.password = 'Enter the database password.';
  if (body.password && String(body.password).length > 256) errors.password = 'The password is too long.';
  return { errors, values: { driver, host, port, database, username, prefix } };
}

/** Encrypted with the server key; a server without APP_KEY/SESSION_SECRET cannot store the password. */
function encryptPassword(value) {
  try { return secrets.encrypt(value); } catch { throw new AppError('DATASYNC_NO_KEY', 'This server has no encryption key (APP_KEY), so the password cannot be stored safely.', 409); }
}

async function save(ctx, body) {
  const cur = await get(ctx.businessId);
  const { errors, values: c } = clean(body, cur);
  const allowed = available(ctx);
  const picked = [].concat(body.datasets || []).filter((d) => allowed.includes(d));
  // Choices the editor may not change (e.g. clinical data without clinical.view) are kept as they were.
  const kept = cur ? cur.datasets.filter((d) => !allowed.includes(d)) : [];
  const datasets = [...new Set([...picked, ...kept])].filter((d) => DATASETS[d]);
  if (!datasets.length) errors.datasets = 'Choose at least one kind of data to copy.';
  // Health and salary data: the person turning it on confirms the clinic protects its copy.
  const newlySensitive = picked.filter((d) => DATASETS[d].sensitive && !(cur && cur.datasets.includes(d)));
  if (newlySensitive.length && body.accept_responsibility !== '1') errors.accept_responsibility = 'Confirm that your clinic protects this copy.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const frequency = Object.prototype.hasOwnProperty.call(FREQUENCIES, body.frequency) ? body.frequency : 'daily';
  const ssl = body.ssl === '1';
  const connChanged = !cur || cur.driver !== c.driver || cur.host !== c.host || Number(cur.port) !== c.port || cur.database_name !== c.database
    || cur.username !== c.username || Boolean(cur.ssl) !== ssl || Boolean(body.password);
  const row = {
    driver: c.driver, host: c.host, port: c.port, database_name: c.database, username: c.username, ssl, table_prefix: c.prefix,
    datasets: JSON.stringify(datasets), frequency, enabled: body.enabled === '1', updated_by: ctx.userId || null, updated_at: new Date(),
    next_run_at: FREQUENCIES[frequency] ? new Date(Date.now() + 60_000) : null,
    ...(body.password ? { password_enc: encryptPassword(String(body.password)) } : {}),
    ...(connChanged ? { verified_at: null } : {}),
  };
  await knex('clinic_data_sync').insert({ business_id: ctx.businessId, ...row }).onConflict('business_id').merge(row);
  const before = cur ? { driver: cur.driver, host: cur.host, port: cur.port, database: cur.database_name, username: cur.username, ssl: Boolean(cur.ssl), prefix: cur.table_prefix, datasets: cur.datasets.join(','), frequency: cur.frequency, enabled: Boolean(cur.enabled) } : {};
  const after = { driver: c.driver, host: c.host, port: c.port, database: c.database, username: c.username, ssl, prefix: c.prefix, datasets: datasets.join(','), frequency, enabled: body.enabled === '1' };
  const d = audit.diff(before, after);
  await audit.record(ctx, cur ? 'datasync.updated' : 'datasync.created', {
    entityType: 'clinic', entityId: ctx.businessId, oldValues: cur ? d.oldValues : null,
    newValues: { ...(cur ? d.newValues : after), ...(body.password ? { password_changed: true } : {}), ...(newlySensitive.length ? { sensitive_accepted: newlySensitive.join(',') } : {}) },
  });
}

async function remove(ctx) {
  const cur = await get(ctx.businessId);
  if (!cur) return;
  await knex('clinic_data_sync').where({ business_id: ctx.businessId }).del();
  await audit.record(ctx, 'datasync.removed', { entityType: 'clinic', entityId: ctx.businessId, oldValues: { driver: cur.driver, host: cur.host, database: cur.database_name } });
}

// ---------- Connection ----------
/** The server must be public (no internal addresses of this server's network). Returns the address to use. */
async function resolveHost(host) {
  let list;
  if (net.isIP(host)) list = [{ address: host }];
  else {
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host) && !allowPrivate()) throw new AppError('DATASYNC_PRIVATE', 'This database address is not reachable from DocBook. Use a public server name or IP.', 400);
    list = await dns.lookup(host, { all: true }).catch(() => { throw new AppError('DATASYNC_DNS', 'The server name could not be found.', 400); });
  }
  if (!list.length) throw new AppError('DATASYNC_DNS', 'The server name could not be found.', 400);
  if (!allowPrivate() && list.some((a) => isPrivateIp(a.address))) throw new AppError('DATASYNC_PRIVATE', 'This database address is not reachable from DocBook. Use a public server name or IP.', 400);
  return list[0].address;
}

/** knex connection settings. Always connects to the address that passed the check (no second DNS lookup). */
function connectionFor(cfg, address, password) {
  const isName = !net.isIP(cfg.host);
  if (cfg.driver === 'postgres') {
    return {
      host: address, port: cfg.port, user: cfg.username, password, database: cfg.database_name,
      ssl: cfg.ssl ? { rejectUnauthorized: true, ...(isName ? { servername: cfg.host } : {}) } : false,
      connectionTimeoutMillis: 15_000, statement_timeout: 300_000, query_timeout: 300_000, application_name: 'docbook-copy',
    };
  }
  return {
    // The name stays in `host` for the certificate check; the socket goes to the checked address.
    host: cfg.host, port: cfg.port, user: cfg.username, password, database: cfg.database_name,
    stream: () => net.connect({ host: address, port: cfg.port }),
    ssl: cfg.ssl ? { rejectUnauthorized: true, verifyIdentity: isName } : undefined,
    connectTimeout: 15_000, timezone: 'Z', charset: 'utf8mb4',
  };
}

async function connect(cfg, passwordEnc) {
  const address = await resolveHost(cfg.host);
  const password = passwordEnc ? secrets.decrypt(passwordEnc) : null;
  if (password === null) throw new AppError('DATASYNC_PASSWORD', 'The saved password cannot be read. Enter it again.', 400);
  return knexFactory({ client: DRIVERS[cfg.driver].client, connection: connectionFor(cfg, address, password), pool: { min: 0, max: 1 }, acquireConnectionTimeout: 20_000, log: QUIET });
}

/**
 * A reason code for a failure (translated on screen), never the password. OTHER keeps a short driver message.
 * @returns {string} e.g. "AUTH" or "OTHER:…"
 */
function reason(e, password) {
  if (e instanceof AppError) return String(e.code || 'OTHER').replace(/^DATASYNC_/, '');
  const code = String(e.code || '');
  const msg = String(e.message || e);
  if (/ECONNREFUSED/.test(code)) return 'REFUSED';
  if (/ETIMEDOUT|ETIMEOUT|ESOCKETTIMEDOUT/.test(code) || /timeout|timed out/i.test(msg)) return 'TIMEOUT';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'DNS';
  if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR' || code === '28P01' || code === '28000') return 'AUTH';
  if (code === 'ER_BAD_DB_ERROR' || code === '3D000') return 'NO_DB';
  if (code === 'ER_TABLEACCESS_DENIED_ERROR' || code === 'ER_SPECIFIC_ACCESS_DENIED_ERROR' || code === '42501') return 'NO_CREATE';
  if (/SSL|TLS|certificate|self.signed|does not support/i.test(msg) || /CERT|SSL/.test(code)) return 'SSL';
  let text = msg.replace(/password[^,;]*/gi, 'password ***');
  if (password) text = text.split(password).join('***');
  return `OTHER:${text.replace(/\s+/g, ' ').slice(0, 200)}`;
}

async function passwordOf(businessId) {
  const r = await knex('clinic_data_sync').where({ business_id: businessId }).first('password_enc');
  return r ? r.password_enc : null;
}

/** Checks the connection and that tables can be created and dropped. */
async function test(ctx) {
  const cfg = await get(ctx.businessId);
  if (!cfg) throw E.notFound('Database connection');
  const enc = await passwordOf(ctx.businessId);
  let db; let result;
  try {
    db = await connect(cfg, enc);
    const probe = `${cfg.table_prefix}probe`;
    await db.schema.dropTableIfExists(probe);
    await db.schema.createTable(probe, (t) => { t.integer('id'); });
    await db.schema.dropTable(probe);
    await knex('clinic_data_sync').where({ business_id: ctx.businessId }).update({ verified_at: new Date() });
    result = { ok: true };
  } catch (e) {
    result = { ok: false, error: reason(e, secrets.decrypt(enc)) };
  } finally {
    if (db) await db.destroy().catch(() => {});
  }
  await audit.record(ctx, 'datasync.tested', { entityType: 'clinic', entityId: ctx.businessId, newValues: { result: result.ok ? 'ok' : result.error } });
  return result;
}

// ---------- Copying ----------
const pad = (n) => String(n).padStart(2, '0');
function convert(v, type) {
  if (v === null || v === undefined || v === '') return type === 's' || type === 't' ? (v === '' ? '' : null) : null;
  if (type === 'd') return v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : String(v).slice(0, 10);
  if (type === 'dt') {
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  if (type === 'b') return Boolean(Number(v)) || v === true;
  if (type === 'n') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (type === 'i') { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; }
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return type === 's' ? s.slice(0, 255) : s;
}

function column(t, name, type) {
  if (name === 'id') return t.integer('id').primary();
  if (type === 'i') return t.integer(name).nullable();
  if (type === 's') return t.string(name, 255).nullable();
  if (type === 't') return t.text(name).nullable();
  if (type === 'd') return t.date(name).nullable();
  if (type === 'dt') return t.datetime(name, { useTz: false }).nullable();
  if (type === 'n') return t.decimal(name, 15, 3).nullable();
  return t.boolean(name).nullable();
}

const createBuilder = (db, name, cols) => db.schema.createTable(name, (t) => { for (const [c, type] of Object.entries(cols)) column(t, c, type); });
const alterBuilder = (db, name, cols, missing) => db.schema.alterTable(name, (t) => { for (const c of missing) column(t, c, cols[c]); });

/** Creates the table, or adds the columns a newer DocBook version sends. */
async function ensureTable(db, name, cols) {
  if (!(await db.schema.hasTable(name))) { await createBuilder(db, name, cols); return; }
  const missing = [];
  for (const c of Object.keys(cols)) if (!(await db.schema.hasColumn(name, c))) missing.push(c); // eslint-disable-line no-await-in-loop
  if (missing.length) await alterBuilder(db, name, cols, missing);
}

/** This clinic's rows for one target table, already converted to the column types. */
async function sourceRows(businessId, spec) {
  const rows = await knex(spec.source).where({ business_id: businessId }).select(spec.select || Object.keys(spec.cols)).orderBy('id');
  const list = spec.expand ? rows.flatMap(spec.expand).map((r, i) => ({ id: i + 1, ...r })) : rows;
  return list.map((r) => Object.fromEntries(Object.entries(spec.cols).map(([c, type]) => [c, convert(r[c], type)])));
}

async function copyTable(db, businessId, target, spec) {
  const rows = await sourceRows(businessId, spec);
  await ensureTable(db, target, spec.cols);
  await db.transaction(async (trx) => {
    await trx(target).del();
    for (let i = 0; i < rows.length; i += CHUNK) await trx(target).insert(rows.slice(i, i + CHUNK)); // eslint-disable-line no-await-in-loop
  });
  return rows.length;
}

const withTimeout = (p, ms, onTimeout) => {
  let timer;
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => { onTimeout(); rej(new AppError('DATASYNC_RUN_TIMEOUT', 'The copy took too long and was stopped.', 504)); }, ms); timer.unref(); })])
    .finally(() => clearTimeout(timer));
};

/** Runs one copy now. Only one at a time per clinic. */
async function run(businessId, { trigger = 'manual', userId = null, ip = null } = {}) {
  const cfg = await get(businessId);
  if (!cfg) throw E.notFound('Database connection');
  const locked = await knex('clinic_data_sync').where({ business_id: businessId })
    .where((q) => q.whereNull('running_since').orWhere('running_since', '<', new Date(Date.now() - STALE_LOCK))).update({ running_since: new Date() });
  if (!locked) throw new AppError('DATASYNC_BUSY', 'A copy is already running. Try again in a few minutes.', 409);
  const started = Date.now();
  const [runId] = await knex('data_sync_runs').insert({ business_id: businessId, trigger, status: 'running', started_by: userId, started_at: new Date() });
  const counts = {};
  let db; let error = null; let enc = null;
  try {
    enc = await passwordOf(businessId);
    db = await connect(cfg, enc);
    const work = async () => {
      for (const key of Object.keys(DATASETS)) {
        if (!cfg.datasets.includes(key)) continue;
        for (const [name, spec] of Object.entries(DATASETS[key].tables)) counts[name] = await copyTable(db, businessId, `${cfg.table_prefix}${name}`, spec); // eslint-disable-line no-await-in-loop
      }
      // A small table telling people reading the copy when it was refreshed.
      const info = `${cfg.table_prefix}sync_info`;
      await ensureTable(db, info, { id: 'i', clinic: 's', synced_at: 'dt', tables: 't' });
      const b = await knex('businesses').where({ id: businessId }).first('name', 'currency', 'timezone');
      await db.transaction(async (trx) => {
        await trx(info).del();
        await trx(info).insert({ id: 1, clinic: b && b.name, synced_at: convert(new Date(), 'dt'), tables: JSON.stringify({ currency: b && b.currency, timezone: b && b.timezone, rows: counts }) });
      });
    };
    await withTimeout(work(), RUN_TIMEOUT, () => { if (db) db.destroy().catch(() => {}); });
  } catch (err) {
    error = reason(err, enc ? secrets.decrypt(enc) : null);
  } finally {
    if (db) await db.destroy().catch(() => {});
  }
  const now = new Date();
  const every = FREQUENCIES[cfg.frequency];
  await knex('data_sync_runs').where({ id: runId }).update({ status: error ? 'failed' : 'ok', counts: JSON.stringify(counts), error, duration_ms: Date.now() - started, finished_at: now });
  await knex('clinic_data_sync').where({ business_id: businessId }).update({
    running_since: null, last_run_at: now, last_status: error ? 'failed' : 'ok', last_error: error,
    // A failing scheduled copy waits at least an hour before trying again.
    next_run_at: every ? new Date(now.getTime() + (error ? Math.max(every, 3_600_000) : every)) : null,
    ...(error ? {} : { verified_at: cfg.verified_at || now }),
  });
  // Keep the last 50 runs per clinic.
  const old = await knex('data_sync_runs').where({ business_id: businessId }).orderBy('id', 'desc').offset(50).limit(1000).pluck('id');
  if (old.length) await knex('data_sync_runs').whereIn('id', old).del();
  await audit.record({ businessId, userId, ip }, error ? 'datasync.failed' : 'datasync.completed', { entityType: 'clinic', entityId: businessId, newValues: { trigger, datasets: cfg.datasets.join(','), rows: Object.values(counts).reduce((a, n) => a + n, 0), ...(error ? { error } : {}) } });
  return { ok: !error, error, counts, runId };
}

async function runs(businessId, limit = 10) {
  const rows = await knex('data_sync_runs').where({ business_id: businessId }).orderBy('id', 'desc').limit(limit);
  return rows.map((r) => ({ ...r, counts: typeof r.counts === 'string' ? JSON.parse(r.counts || '{}') : (r.counts || {}) }));
}

/** Background tick: runs the scheduled copies that are due, one after another. */
async function runDue() {
  const due = await knex('clinic_data_sync').where({ enabled: true }).whereNotNull('next_run_at').where('next_run_at', '<=', new Date())
    .where((q) => q.whereNull('running_since').orWhere('running_since', '<', new Date(Date.now() - STALE_LOCK))).limit(5).pluck('business_id');
  for (const id of due) await run(id, { trigger: 'schedule' }).catch(() => {}); // eslint-disable-line no-await-in-loop
  return due.length;
}

module.exports = {
  DATASETS, DEFAULT_DATASETS, DRIVERS, FREQUENCIES,
  get, available, save, remove, test, run, runs, runDue,
  // exported for tests
  convert, reason, resolveHost, connectionFor, createBuilder, alterBuilder, sourceRows,
};
