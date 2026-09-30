// Google Sheets export (one-way: DocBook → Google Sheets). Two ways to connect a clinic:
//  a) Google account (OAuth 2.0, authorization code + PKCE) with the platform's Google client from /admin/google.
//     Scope https://www.googleapis.com/auth/drive.file only — the app can reach the files it creates and nothing
//     else in the clinic's Drive. access_type=offline + prompt=consent give a refresh token, stored encrypted per
//     clinic. The app creates "DocBook – <clinic>" (spreadsheets.create) and rewrites one tab per dataset
//     (values.batchClear + values.batchUpdate, RAW so no cell is ever read as a formula).
//  b) Apps Script web app (no Google Cloud set-up): the clinic pastes our script into its spreadsheet, deploys it
//     as a web app and gives us its URL; we POST each tab as JSON with a shared secret (https only, through the
//     SSRF-guarded helper, size-limited and chunked).
// What goes out: clinic data only, one tab per dataset, header row in the chosen language. Patient demographics
// only after an explicit acknowledgement, and never clinical fields (notes, allergies, conditions, IDs).
// All HTTP goes through `transport` so tests replace Google with a stub; nothing is faked when Google is
// unreachable — the run is logged as failed with the reason.
const crypto = require('crypto');
const knex = require('../../db/knex');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const http = require('../../core/http');
const { translator, has } = require('../../core/i18n');
const { AppError, E } = require('../../core/errors');
const { clinicNow } = require('../clinic/scheduling');
const google = require('../auth/google.service');

const GOOGLE = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  sheets: 'https://sheets.googleapis.com/v4/spreadsheets',
  about: 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
};
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const PENDING_TTL_MS = 10 * 60_000;
const STALE_LOCK_MS = 30 * 60_000;
const MAX_ROWS = 50_000; // per tab
const API_CHUNK_ROWS = 5_000; // rows per Sheets API write
const HOOK_CHUNK_ROWS = 2_000; // rows per web-app request
const HOOK_CHUNK_BYTES = 900_000; // body size per web-app request
const MONTHS = [3, 6, 12, 24, 36, 0];
const TABS = ['summary', 'appointments', 'patients', 'invoices', 'expenses', 'doctor_payroll', 'staff_salaries', 'supplies'];
const DEFAULT_TABS = TABS.filter((k) => k !== 'patients');
// Salaries of non-doctor staff live in the finance module's table (it may not exist on this installation yet).
const STAFF_SALARY_TABLES = ['staff_salary_payments', 'staff_payroll_payments', 'staff_salaries', 'salary_payments'];

const fail = (code, message, status = 422, details) => new AppError(code, message, status, details);

// ---------------------------------------------------------------- transport (replaced in tests)
const defaultTransport = () => ({ fetch: (...a) => globalThis.fetch(...a), request: http.request });
let transport = defaultTransport();
/** Tests: setTransport({ fetch, request }); call with no argument to restore the real network. */
function setTransport(t) { transport = t ? { ...defaultTransport(), ...t } : defaultTransport(); cache.forgetPrefix('gsheets:'); }

// ---------------------------------------------------------------- settings row
const parseTabs = (v) => { try { const a = JSON.parse(v || 'null'); return Array.isArray(a) ? a.filter((k) => TABS.includes(k)) : null; } catch { return null; } };

async function get(businessId) {
  const row = await knex('sheet_sync_settings').where({ business_id: businessId }).first();
  if (!row) {
    return { business_id: businessId, method: null, tabs: DEFAULT_TABS.slice(), sheet_locale: 'ar', months_back: 12, include_patients: false, auto_daily: false, exists: false };
  }
  const refresh = row.oauth_refresh_enc ? secrets.decrypt(row.oauth_refresh_enc) : null;
  const hookUrl = row.webhook_url_enc ? secrets.decrypt(row.webhook_url_enc) : null;
  const hookSecret = row.webhook_secret_enc ? secrets.decrypt(row.webhook_secret_enc) : null;
  return {
    ...row, exists: true,
    tabs: parseTabs(row.tabs) || DEFAULT_TABS.slice(),
    include_patients: Boolean(row.include_patients), auto_daily: Boolean(row.auto_daily),
    hasRefresh: Boolean(refresh), refreshToken: refresh, webhookUrl: hookUrl, webhookSecret: hookSecret,
    spreadsheetUrl: row.spreadsheet_id ? `https://docs.google.com/spreadsheets/d/${row.spreadsheet_id}/edit` : null,
    connected: (row.method === 'oauth' && Boolean(refresh)) || (row.method === 'webhook' && Boolean(hookUrl && hookSecret)),
    needsReconnect: row.method === 'oauth' && !refresh,
  };
}

async function upsert(businessId, values) {
  const exists = await knex('sheet_sync_settings').where({ business_id: businessId }).first('business_id');
  if (exists) await knex('sheet_sync_settings').where({ business_id: businessId }).update({ ...values, updated_at: new Date() });
  else await knex('sheet_sync_settings').insert({ business_id: businessId, tabs: JSON.stringify(DEFAULT_TABS), ...values });
}

const encrypt = (v) => {
  try { return secrets.encrypt(v); } catch { throw fail('SECRETS_KEY', 'Set APP_KEY (or SESSION_SECRET) in the server environment to store credentials.', 409); }
};

/** Saves what is exported. Including patients needs the acknowledgement once (who and when is kept). */
async function saveOptions(ctx, body = {}) {
  const cur = await get(ctx.businessId);
  const tabs = [].concat(body.tabs || []).map(String).filter((k) => TABS.includes(k));
  const wantPatients = tabs.includes('patients') || body.include_patients === '1';
  const errors = {};
  if (!tabs.length) errors.tabs = 'Choose a valid value.';
  const months = Number(body.months_back);
  if (!MONTHS.includes(months)) errors.months_back = 'Choose a valid value.';
  const locale = ['ar', 'en'].includes(body.sheet_locale) ? body.sheet_locale : null;
  if (!locale) errors.sheet_locale = 'Choose a valid value.';
  const alreadyAck = cur.include_patients && cur.patients_ack_at;
  if (wantPatients && !alreadyAck && body.patients_ack !== '1') errors.patients_ack = 'Please accept the terms to continue.';
  if (Object.keys(errors).length) throw E.validation(errors);
  const finalTabs = TABS.filter((k) => tabs.includes(k) || (k === 'patients' && wantPatients));
  const values = {
    tabs: JSON.stringify(finalTabs), months_back: months, sheet_locale: locale, auto_daily: body.auto_daily === '1',
    include_patients: wantPatients,
    patients_ack_by: wantPatients ? (alreadyAck ? cur.patients_ack_by : ctx.userId) : null,
    patients_ack_at: wantPatients ? (alreadyAck ? cur.patients_ack_at : new Date()) : null,
  };
  await upsert(ctx.businessId, values);
  await audit.record(ctx, 'integrations.sheets_options', {
    entityType: 'sheet_sync', entityId: ctx.businessId,
    oldValues: { tabs: cur.tabs, months_back: cur.months_back, sheet_locale: cur.sheet_locale, auto_daily: cur.auto_daily, include_patients: cur.include_patients },
    newValues: { tabs: finalTabs, months_back: months, sheet_locale: locale, auto_daily: values.auto_daily, include_patients: wantPatients, patients_acknowledged: wantPatients && !alreadyAck ? 'now' : undefined },
  });
}

// ---------------------------------------------------------------- Google OAuth
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const safeEq = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); };
const redirectUri = () => `${google.appBase()}/app/settings/google-sheets/callback`;

/** The platform's Google OAuth client (from /admin/google), or null when it is not set up. */
async function oauthClient() {
  const s = await google.settings();
  const secret = s.client_id && s.secret_enc ? secrets.decrypt(s.secret_enc) : null;
  return s.client_id && secret ? { clientId: s.client_id, clientSecret: secret } : null;
}

async function fetchJson(url, init = {}) {
  let res;
  try {
    res = await transport.fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs || 20_000), redirect: 'error' });
  } catch (e) {
    throw fail('GSHEETS_NETWORK', `Could not reach Google (${String(e && e.message || e).slice(0, 80)}).`, 502);
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body };
}
const googleWhy = (r) => String((r.body && (r.body.error_description || (r.body.error && (r.body.error.message || r.body.error)))) || `HTTP ${r.status}`).slice(0, 160);

async function startOAuth() {
  const client = await oauthClient();
  if (!client) throw fail('GSHEETS_NO_CLIENT', 'Google is not set up on this platform yet.', 409);
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const u = new URL(GOOGLE.authorize);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: client.clientId, redirect_uri: redirectUri(), scope: SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false',
    state, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  return { url: u.toString(), pending: { state, verifier, createdAt: Date.now() } };
}

/** Callback: checks state, exchanges the code, stores the refresh token (encrypted). */
async function finishOAuth(ctx, pending, query = {}) {
  if (!pending || !safeEq(query.state, pending.state) || !(Date.now() - Number(pending.createdAt) <= PENDING_TTL_MS)) {
    throw fail('GSHEETS_STATE', 'This link has expired or was opened in another browser. Please start again.');
  }
  if (query.error) throw fail('GSHEETS_CANCELLED', 'Google access was not granted.');
  if (!query.code || typeof query.code !== 'string' || query.code.length > 2048) throw fail('GSHEETS_CANCELLED', 'Google access was not granted.');
  const client = await oauthClient();
  if (!client) throw fail('GSHEETS_NO_CLIENT', 'Google is not set up on this platform yet.', 409);
  const form = new URLSearchParams({
    grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri(), code_verifier: pending.verifier,
    client_id: client.clientId, client_secret: client.clientSecret,
  });
  const r = await fetchJson(GOOGLE.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() });
  if (r.status !== 200 || !r.body || !r.body.access_token) throw fail('GSHEETS_GOOGLE', `Google refused the request (${googleWhy(r)}).`, 502);
  const granted = String(r.body.scope || '').split(/\s+/);
  if (!granted.includes(SCOPE)) throw fail('GSHEETS_SCOPE', 'Allow DocBook to create its spreadsheet in your Google Drive.', 422);
  if (!r.body.refresh_token) throw fail('GSHEETS_NO_REFRESH', 'Google did not return a long-lived token. Remove DocBook from your Google account’s third-party access and connect again.', 422);
  let email = null;
  const about = await fetchJson(GOOGLE.about, { method: 'GET', headers: { authorization: `Bearer ${r.body.access_token}`, accept: 'application/json' } }).catch(() => null);
  if (about && about.status === 200 && about.body && about.body.user) email = String(about.body.user.emailAddress || '').slice(0, 190) || null;
  const cur = await get(ctx.businessId);
  await upsert(ctx.businessId, {
    method: 'oauth', oauth_refresh_enc: encrypt(r.body.refresh_token), oauth_email: email,
    // a different Google account cannot open the previous account's file (drive.file): start a new one
    spreadsheet_id: cur.method === 'oauth' && cur.oauth_email && email && cur.oauth_email === email ? cur.spreadsheet_id : null,
    webhook_url_enc: null, webhook_secret_enc: null,
  });
  cache.set(`gsheets:at:${ctx.businessId}`, { token: r.body.access_token }, Math.max(60, (Number(r.body.expires_in) || 3600) - 120) * 1000);
  await audit.record(ctx, 'integrations.sheets_connected', { entityType: 'sheet_sync', entityId: ctx.businessId, newValues: { method: 'oauth', google_email: email } });
  return { email };
}

/** A valid access token for the clinic (refreshed with the stored refresh token when needed). */
async function accessToken(businessId, { force = false } = {}) {
  const key = `gsheets:at:${businessId}`;
  if (!force) { const c = cache.get(key); if (c && c.token) return c.token; }
  const cfg = await get(businessId);
  if (cfg.method !== 'oauth' || !cfg.refreshToken) throw fail('GSHEETS_RECONNECT', 'Connect the Google account again.', 409);
  const client = await oauthClient();
  if (!client) throw fail('GSHEETS_NO_CLIENT', 'Google is not set up on this platform yet.', 409);
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken, client_id: client.clientId, client_secret: client.clientSecret });
  const r = await fetchJson(GOOGLE.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() });
  if (r.status === 400 && r.body && r.body.error === 'invalid_grant') {
    // Access was removed in the Google account (or the token expired): forget it, the clinic reconnects.
    await knex('sheet_sync_settings').where({ business_id: businessId }).update({ oauth_refresh_enc: null, updated_at: new Date() });
    await audit.record({ businessId }, 'integrations.sheets_access_revoked', { entityType: 'sheet_sync', entityId: businessId });
    throw fail('GSHEETS_RECONNECT', 'Google access was removed. Connect the Google account again.', 409);
  }
  if (r.status !== 200 || !r.body || !r.body.access_token) throw fail('GSHEETS_GOOGLE', `Google refused the request (${googleWhy(r)}).`, 502);
  cache.set(key, { token: r.body.access_token }, Math.max(60, (Number(r.body.expires_in) || 3600) - 120) * 1000);
  return r.body.access_token;
}

// ---------------------------------------------------------------- Sheets API
const quoteTab = (title) => `'${String(title).replace(/'/g, "''")}'`;

async function sheetsCall(businessId, method, path, body) {
  const call = async (token) => fetchJson(`${GOOGLE.sheets}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined, timeoutMs: 60_000,
  });
  let r = await call(await accessToken(businessId));
  if (r.status === 401) r = await call(await accessToken(businessId, { force: true }));
  return r;
}

async function createSpreadsheet(businessId, clinicName, tabs, rtl) {
  const r = await sheetsCall(businessId, 'POST', '', {
    properties: { title: `DocBook – ${clinicName}`.slice(0, 200) },
    sheets: tabs.map((t) => ({ properties: { title: t.title, rightToLeft: rtl, gridProperties: { frozenRowCount: 1 } } })),
  });
  if (r.status !== 200 || !r.body || !r.body.spreadsheetId) throw fail('GSHEETS_GOOGLE', `Google refused the request (${googleWhy(r)}).`, 502);
  await knex('sheet_sync_settings').where({ business_id: businessId }).update({ spreadsheet_id: String(r.body.spreadsheetId).slice(0, 120), updated_at: new Date() });
  return r.body.spreadsheetId;
}

/** Makes sure the clinic's spreadsheet exists and has every tab; returns its id and whether it was just created. */
async function ensureSpreadsheet(businessId, cfg, clinicName, tabs, rtl) {
  if (cfg.spreadsheet_id) {
    const r = await sheetsCall(businessId, 'GET', `/${encodeURIComponent(cfg.spreadsheet_id)}?fields=sheets.properties.title`);
    if (r.status === 200 && r.body) {
      const have = new Set((r.body.sheets || []).map((s) => s.properties && s.properties.title));
      const missing = tabs.filter((t) => !have.has(t.title));
      if (missing.length) {
        const add = await sheetsCall(businessId, 'POST', `/${encodeURIComponent(cfg.spreadsheet_id)}:batchUpdate`, {
          requests: missing.map((t) => ({ addSheet: { properties: { title: t.title, rightToLeft: rtl, gridProperties: { frozenRowCount: 1 } } } })),
        });
        if (add.status !== 200) throw fail('GSHEETS_GOOGLE', `Google refused the request (${googleWhy(add)}).`, 502);
      }
      return { id: cfg.spreadsheet_id, created: false };
    }
    // Deleted or no longer reachable with drive.file (it is not ours any more): make a new one.
    if (r.status !== 404 && r.status !== 403) throw fail('GSHEETS_GOOGLE', `Google refused the request (${googleWhy(r)}).`, 502);
  }
  return { id: await createSpreadsheet(businessId, clinicName, tabs, rtl), created: true };
}

/** Rewrites one tab: clear it, then header + rows in chunks. */
async function writeTabApi(businessId, spreadsheetId, tab) {
  const sid = encodeURIComponent(spreadsheetId);
  const clear = await sheetsCall(businessId, 'POST', `/${sid}/values:batchClear`, { ranges: [quoteTab(tab.title)] });
  if (clear.status !== 200) throw fail('GSHEETS_GOOGLE', `Google refused the request (${googleWhy(clear)}).`, 502);
  const all = [tab.header, ...tab.rows];
  let requests = 0;
  for (let offset = 0; offset < all.length; offset += API_CHUNK_ROWS) {
    const values = all.slice(offset, offset + API_CHUNK_ROWS);
    const r = await sheetsCall(businessId, 'POST', `/${sid}/values:batchUpdate`, { // eslint-disable-line no-await-in-loop
      valueInputOption: 'RAW', data: [{ range: `${quoteTab(tab.title)}!A${offset + 1}`, majorDimension: 'ROWS', values }],
    });
    if (r.status !== 200) throw fail('GSHEETS_GOOGLE', `Google refused the request (${googleWhy(r)}).`, 502);
    requests += 1;
  }
  return requests;
}

// ---------------------------------------------------------------- Apps Script web app
/** Checks the pasted web-app address (https; a script.google.com web app unless private addresses are allowed for tests). */
function checkWebhookUrl(raw) {
  const v = http.validateUrl(raw);
  if (v.error) throw E.validation({ webhook_url: v.error });
  const u = v.url;
  const open = process.env.INTEGRATIONS_ALLOW_PRIVATE === 'true';
  if (!open && !(u.protocol === 'https:' && u.hostname === 'script.google.com' && /^\/(a\/[^/]+\/)?macros\/s\/[\w-]{10,}\/exec$/.test(u.pathname))) {
    throw E.validation({ webhook_url: 'Paste the web app URL from Apps Script (https://script.google.com/macros/s/…/exec).' });
  }
  u.hash = '';
  return u.toString();
}

/** Splits rows into pieces that respect both a row count and a body size. */
function chunkRows(rows, { maxRows = HOOK_CHUNK_ROWS, maxBytes = HOOK_CHUNK_BYTES } = {}) {
  const chunks = [];
  let cur = []; let size = 0;
  for (const row of rows) {
    const n = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (cur.length && (cur.length >= maxRows || size + n > maxBytes)) { chunks.push(cur); cur = []; size = 0; }
    cur.push(row); size += n;
  }
  if (cur.length || !chunks.length) chunks.push(cur);
  return chunks;
}

/** One POST to the web app; resolves with its JSON answer, throws AppError with a clear code otherwise. */
async function hookPost(url, payload) {
  const body = JSON.stringify(payload);
  let res;
  try {
    // Apps Script answers a POST with a redirect to script.googleusercontent.com carrying the result.
    res = await transport.request(url, {
      method: 'POST', body, redirects: 3, timeoutMs: 90_000, maxBytes: 65_536,
      headers: { 'content-type': 'application/json', accept: 'application/json' }, // no content-length: the redirect is followed as a GET with these headers
    });
  } catch (e) {
    if (e instanceof http.BlockedError) throw fail('GSHEETS_WEBHOOK_BLOCKED', 'This address is not reachable from this server.', 422);
    throw fail('GSHEETS_WEBHOOK_NETWORK', `Could not reach the web app (${String(e && e.message || e).slice(0, 80)}).`, 502);
  }
  let json = null;
  try { json = JSON.parse(res.body); } catch { json = null; }
  if (json && json.ok === true) return json;
  if ((json && json.error === 'unauthorized') || res.status === 401) throw fail('GSHEETS_WEBHOOK_SECRET', 'The web app refused the secret. Paste the latest script and deploy it again.', 422);
  if (!json && /<html|<!doctype/i.test(String(res.body || ''))) throw fail('GSHEETS_WEBHOOK_ACCESS', 'The web app asked for a Google sign-in. Deploy it with “Who has access: Anyone”.', 422);
  const why = json && json.error ? String(json.error).slice(0, 120) : `HTTP ${res.status}`;
  throw fail('GSHEETS_WEBHOOK_FAILED', `The web app did not accept the data (${why}).`, 502);
}

/** Sends one tab to the web app: the first request replaces the tab, the next ones append. */
async function writeTabHook(url, secret, tab, rtl) {
  const chunks = chunkRows(tab.rows);
  let written = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const r = await hookPost(url, { // eslint-disable-line no-await-in-loop
      secret, action: 'write', tab: tab.title, key: tab.key, header: tab.header, rows: chunks[i],
      mode: i === 0 ? 'replace' : 'append', rtl, part: i + 1, parts: chunks.length,
    });
    written += Number(r.written) || 0;
  }
  if (written !== tab.rows.length) throw fail('GSHEETS_WEBHOOK_FAILED', `The web app wrote ${written} of ${tab.rows.length} rows.`, 502);
  return chunks.length;
}

async function pingHook(url, secret) {
  return hookPost(url, { secret, action: 'ping' });
}

/** Starts the Apps Script method: a new shared secret (the clinic pastes the script that contains it). */
async function startWebhook(ctx) {
  const cur = await get(ctx.businessId);
  const secret = b64url(crypto.randomBytes(24));
  await upsert(ctx.businessId, { webhook_secret_enc: encrypt(secret), ...(cur.method === 'webhook' ? {} : { webhook_url_enc: null }) });
  await audit.record(ctx, cur.webhookSecret ? 'integrations.sheets_secret_rotated' : 'integrations.sheets_webhook_started', { entityType: 'sheet_sync', entityId: ctx.businessId });
  return secret;
}

/** Saves the web-app address and tests it straight away. Returns { ok, error? } for the test. */
async function saveWebhook(ctx, raw) {
  const cur = await get(ctx.businessId);
  if (!cur.webhookSecret) throw fail('GSHEETS_NO_SECRET', 'Start the Apps Script set-up first.', 409);
  const url = checkWebhookUrl(raw);
  await upsert(ctx.businessId, {
    method: 'webhook', webhook_url_enc: encrypt(url), oauth_refresh_enc: null, oauth_email: null, spreadsheet_id: null,
  });
  cache.forgetPrefix(`gsheets:at:${ctx.businessId}`);
  await audit.record(ctx, 'integrations.sheets_connected', { entityType: 'sheet_sync', entityId: ctx.businessId, oldValues: { method: cur.method }, newValues: { method: 'webhook', host: new URL(url).host } });
  return test(ctx.businessId);
}

/** Checks the connection without sending clinic data. */
async function test(businessId) {
  const cfg = await get(businessId);
  try {
    if (cfg.method === 'webhook' && cfg.webhookUrl) { const r = await pingHook(cfg.webhookUrl, cfg.webhookSecret); return { ok: true, spreadsheet: r.spreadsheet ? String(r.spreadsheet).slice(0, 120) : null }; }
    if (cfg.method === 'oauth') { await accessToken(businessId, { force: true }); return { ok: true }; }
    return { ok: false, code: 'GSHEETS_NOT_CONNECTED' };
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { ok: false, code: e.code, message: e.message };
  }
}

/** Disconnects: the Google token is revoked (best effort) and every stored credential is removed. */
async function disconnect(ctx) {
  const cur = await get(ctx.businessId);
  if (cur.refreshToken) {
    await fetchJson(GOOGLE.revoke, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: cur.refreshToken }).toString() }).catch(() => null);
  }
  await upsert(ctx.businessId, {
    method: null, oauth_refresh_enc: null, oauth_email: null, spreadsheet_id: null, webhook_url_enc: null, webhook_secret_enc: null, auto_daily: false,
  });
  cache.forgetPrefix(`gsheets:at:${ctx.businessId}`);
  await audit.record(ctx, 'integrations.sheets_disconnected', { entityType: 'sheet_sync', entityId: ctx.businessId, oldValues: { method: cur.method, google_email: cur.oauth_email || undefined } });
}

// ---------------------------------------------------------------- what is exported
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const dayOf = (v, tz) => (v instanceof Date ? clinicNow(tz, v).date : v ? String(v).slice(0, 10) : '');
function monthsAgo(today, months) {
  const [y, m] = today.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - months, 1));
  return d.toISOString().slice(0, 10);
}
const monthKey = (d) => String(d).slice(0, 7);

/** The first salary table of the finance module that exists here (null when none). */
async function staffSalaryTable() {
  for (const name of STAFF_SALARY_TABLES) {
    if (await knex.schema.hasTable(name)) return name; // eslint-disable-line no-await-in-loop
  }
  return null;
}

/**
 * Builds the tabs (pure data, nothing is sent). Returns [{ key, title, header, rows, truncated }].
 * @param {object} o { businessId, tabs, locale, monthsBack, includePatients, timezone, today, currency }
 */
async function buildTabs(o) {
  const t = translator(o.locale || 'ar');
  const L = (group, key) => (key === null || key === undefined || key === '' ? '' : has(o.locale, `${group}.${key}`) ? t(`${group}.${key}`) : String(key));
  const h = (keys) => keys.map((k) => t(`gsheets.col.${k}`));
  const tz = o.timezone || 'Asia/Amman';
  const today = o.today || clinicNow(tz).date;
  const since = o.monthsBack ? monthsAgo(today, o.monthsBack) : null;
  const pat = Boolean(o.includePatients);
  const want = TABS.filter((k) => (o.tabs || DEFAULT_TABS).includes(k) && (k !== 'patients' || pat));
  const b = o.businessId;
  const out = [];
  const push = (key, header, rows) => {
    const truncated = rows.length > MAX_ROWS;
    out.push({ key, title: t(`gsheets.tab.${key}`), header, rows: (truncated ? rows.slice(0, MAX_ROWS) : rows).map((r) => r.map((v) => (v === null || v === undefined ? '' : v))), truncated });
  };
  const doctorNames = Object.fromEntries((await knex('doctors').where({ business_id: b }).select('id', 'full_name', 'full_name_en'))
    .map((d) => [d.id, (o.locale === 'en' && d.full_name_en) || d.full_name]));

  // Monthly figures shared by the summary tab.
  const salaryTable = want.includes('staff_salaries') || want.includes('summary') ? await staffSalaryTable() : null;

  for (const key of want) {
    /* eslint-disable no-await-in-loop */
    if (key === 'appointments') {
      const q = knex('appointments as a').leftJoin('services as s', 's.id', 'a.service_id').where('a.business_id', b).whereNot('a.appointment_type', 'blocked')
        .orderBy([{ column: 'a.appointment_date' }, { column: 'a.appointment_time' }])
        .select('a.id', 'a.appointment_date', 'a.appointment_time', 'a.duration_minutes', 'a.doctor_id', 'a.patient_name', 'a.patient_phone', 'a.appointment_type', 'a.status', 'a.booking_channel', 'a.source', 'a.amount_due', 'a.payment_status', 's.name as service_name', 's.name_en as service_name_en')
        .limit(MAX_ROWS + 1);
      if (since) q.where('a.appointment_date', '>=', since);
      const rows = await q;
      const cols = ['id', 'date', 'time', 'minutes', 'doctor', 'service', ...(pat ? ['patient', 'phone'] : []), 'type', 'status', 'channel', 'amount_due', 'payment_status'];
      push(key, h(cols), rows.map((a) => [
        a.id, a.appointment_date, String(a.appointment_time || '').slice(0, 5), a.duration_minutes, doctorNames[a.doctor_id] || '',
        (o.locale === 'en' && a.service_name_en) || a.service_name || '', ...(pat ? [a.patient_name, a.patient_phone] : []),
        L('appointments.types', a.appointment_type), L('appointments.statuses', a.status), L('channels.names', a.booking_channel || a.source),
        n2(a.amount_due), L('appointments.payment_statuses', a.payment_status),
      ]));
    } else if (key === 'patients') {
      // Demographics only: never notes, allergies, chronic conditions, national or insurance numbers.
      const rows = await knex('patients as p').leftJoin('insurance_providers as i', 'i.id', 'p.insurance_provider_id').where('p.business_id', b).orderBy('p.id')
        .select('p.id', 'p.full_name', 'p.phone', 'p.email', 'p.gender', 'p.date_of_birth', 'i.name as insurer', 'p.created_at').limit(MAX_ROWS + 1);
      push(key, h(['file_no', 'patient', 'phone', 'email', 'gender', 'date_of_birth', 'insurer', 'registered']), rows.map((p) => [
        p.id, p.full_name, p.phone, p.email, L('visits.gender', p.gender), p.date_of_birth || '', p.insurer || '', dayOf(p.created_at, tz),
      ]));
    } else if (key === 'invoices') {
      const q = knex('invoices').where({ business_id: b }).orderBy('id')
        .select('invoice_number', 'created_at', 'patient_name', 'doctor_id', 'doctor_name', 'service_name', 'subtotal', 'discount_amount', 'amount', 'payment_method', 'insurance_provider_name', 'insurance_coverage_percent')
        .limit(MAX_ROWS + 1);
      if (since) q.where('created_at', '>=', `${since} 00:00:00`);
      const rows = await q;
      const cols = ['invoice_no', 'date', ...(pat ? ['patient'] : []), 'doctor', 'service', 'subtotal', 'discount', 'amount', 'payment_method', 'insurer', 'coverage'];
      push(key, h(cols), rows.map((i) => [
        i.invoice_number, dayOf(i.created_at, tz), ...(pat ? [i.patient_name] : []), doctorNames[i.doctor_id] || i.doctor_name || '', i.service_name || '',
        n2(i.subtotal !== null && i.subtotal !== undefined ? i.subtotal : Number(i.amount) + Number(i.discount_amount || 0)), n2(i.discount_amount), n2(i.amount),
        L('payment_methods', i.payment_method), i.insurance_provider_name || '', i.insurance_coverage_percent === null || i.insurance_coverage_percent === undefined ? '' : Number(i.insurance_coverage_percent),
      ]));
    } else if (key === 'expenses') {
      const q = knex('expenses').where({ business_id: b }).orderBy([{ column: 'date' }, { column: 'id' }])
        .select('date', 'category', 'title', 'amount', 'payment_method', 'invoice_number').limit(MAX_ROWS + 1);
      if (since) q.where('date', '>=', since);
      const rows = await q;
      push(key, h(['date', 'category', 'title', 'amount', 'payment_method', 'reference']), rows.map((e) => [
        e.date, L('categories', e.category), e.title, n2(e.amount), L('payment_methods', e.payment_method), e.invoice_number || '',
      ]));
    } else if (key === 'doctor_payroll') {
      const q = knex('payroll_payments').where({ business_id: b }).orderBy([{ column: 'period' }, { column: 'id' }])
        .select('period', 'doctor_id', 'base_salary', 'commission', 'bonuses', 'deductions', 'advances', 'net_pay', 'payment_method', 'reference', 'paid_at').limit(MAX_ROWS + 1);
      if (since) q.where('period', '>=', monthKey(since));
      const rows = await q;
      push(key, h(['month', 'doctor', 'base_salary', 'commission', 'bonuses', 'deductions', 'advances', 'net_pay', 'payment_method', 'reference', 'paid_on']), rows.map((p) => [
        p.period, doctorNames[p.doctor_id] || '', n2(p.base_salary), n2(p.commission), n2(p.bonuses), n2(p.deductions), n2(p.advances), n2(p.net_pay),
        L('payment_methods', p.payment_method), p.reference || '', dayOf(p.paid_at, tz),
      ]));
    } else if (key === 'staff_salaries') {
      if (!salaryTable) continue; // eslint-disable-line no-continue -- the finance module is not installed here
      const rows = await staffSalaryRows(salaryTable, b, since, tz);
      push(key, h(['month', 'staff', 'amount', 'payment_method', 'paid_on']), rows.map((r) => [r.month, r.name, n2(r.amount), L('payment_methods', r.method), r.paidOn]));
    } else if (key === 'supplies') {
      const rows = await knex('supply_items as i').leftJoin('suppliers as s', 's.id', 'i.supplier_id').where('i.business_id', b).orderBy('i.name')
        .select('i.name', 'i.unit', 's.name as supplier', 'i.current_stock', 'i.reorder_level', 'i.unit_cost').limit(MAX_ROWS + 1);
      push(key, h(['item', 'unit', 'supplier', 'stock', 'reorder_level', 'unit_cost', 'stock_value', 'stock_status']), rows.map((s) => [
        s.name, s.unit || '', s.supplier || '', Number(s.current_stock) || 0, Number(s.reorder_level) || 0, n2(s.unit_cost), n2((Number(s.current_stock) || 0) * (Number(s.unit_cost) || 0)),
        Number(s.current_stock) <= Number(s.reorder_level) ? t('gsheets.low_stock') : t('gsheets.stock_ok'),
      ]));
    } else if (key === 'summary') {
      const rows = await summaryRows(b, since, today, tz, salaryTable);
      push(key, h(['month', 'revenue', 'expenses', 'doctor_payroll', ...(salaryTable ? ['staff_salaries'] : []), 'net']), rows.map((r) => [
        r.month, n2(r.revenue), n2(r.expenses), n2(r.payroll), ...(salaryTable ? [n2(r.staff)] : []), n2(r.revenue - r.expenses - r.payroll - (salaryTable ? r.staff : 0)),
      ]));
    }
    /* eslint-enable no-await-in-loop */
  }
  return out;
}

/** Rows of the finance module's salary table, read defensively (column names differ between versions). */
async function staffSalaryRows(table, businessId, since, tz) {
  const cols = await knex(table).columnInfo();
  if (!cols.business_id) return [];
  const pick = (...names) => names.find((c) => cols[c]);
  const period = pick('period', 'month');
  const amount = pick('net_pay', 'net', 'amount', 'total');
  const paid = pick('paid_at', 'paid_on', 'created_at');
  const method = pick('payment_method', 'method');
  const user = pick('user_id', 'staff_user_id');
  const staffName = pick('staff_name', 'employee_name', 'name');
  if (!amount) return [];
  const q = knex(`${table} as x`).where('x.business_id', businessId).limit(MAX_ROWS + 1).orderBy('x.id');
  const sel = [`x.${amount} as amount`];
  if (period) sel.push(`x.${period} as period`);
  if (paid) sel.push(`x.${paid} as paid`);
  if (method) sel.push(`x.${method} as method`);
  if (staffName) sel.push(`x.${staffName} as staff_name`);
  if (user) { q.leftJoin('users as u', 'u.id', `x.${user}`); sel.push('u.name as user_name'); }
  q.select(sel);
  if (since && period) q.where(`x.${period}`, '>=', monthKey(since));
  else if (since && paid) q.where(`x.${paid}`, '>=', since);
  return (await q).map((r) => ({
    month: r.period ? String(r.period).slice(0, 7) : (r.paid ? monthKey(dayOf(r.paid, tz)) : ''),
    name: r.staff_name || r.user_name || '', amount: Number(r.amount) || 0, method: r.method || '', paidOn: r.paid ? dayOf(r.paid, tz) : '',
  }));
}

async function summaryRows(businessId, since, today, tz, salaryTable) {
  const months = new Map();
  const add = (m, k, v) => {
    if (!m || (since && m < monthKey(since)) || m > monthKey(today)) return;
    if (!months.has(m)) months.set(m, { month: m, revenue: 0, expenses: 0, payroll: 0, staff: 0 });
    months.get(m)[k] += Number(v) || 0;
  };
  const inv = await knex('invoices').where({ business_id: businessId }).modify((q) => { if (since) q.where('created_at', '>=', `${since} 00:00:00`); }).select('created_at', 'amount');
  inv.forEach((i) => add(monthKey(dayOf(i.created_at, tz)), 'revenue', i.amount));
  const exp = await knex('expenses').where({ business_id: businessId }).modify((q) => { if (since) q.where('date', '>=', since); })
    .select(knex.raw("DATE_FORMAT(`date`, '%Y-%m') as m")).sum({ total: 'amount' }).groupBy('m');
  exp.forEach((e) => add(e.m, 'expenses', e.total));
  const pay = await knex('payroll_payments').where({ business_id: businessId }).select('period').sum({ total: 'net_pay' }).groupBy('period');
  pay.forEach((p) => add(String(p.period).slice(0, 7), 'payroll', p.total));
  if (salaryTable) (await staffSalaryRows(salaryTable, businessId, since, tz)).forEach((r) => add(r.month, 'staff', r.amount));
  return [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

// ---------------------------------------------------------------- runs
const REASONS = new Set(['GSHEETS_NETWORK', 'GSHEETS_GOOGLE', 'GSHEETS_RECONNECT', 'GSHEETS_NO_CLIENT', 'GSHEETS_WEBHOOK_BLOCKED', 'GSHEETS_WEBHOOK_NETWORK', 'GSHEETS_WEBHOOK_SECRET', 'GSHEETS_WEBHOOK_ACCESS', 'GSHEETS_WEBHOOK_FAILED']);
const reasonOf = (e) => (e instanceof AppError && REASONS.has(e.code) ? `${e.code}:${String(e.message).slice(0, 300)}` : `OTHER:${String(e && e.message || e).slice(0, 300)}`);

/**
 * Exports the clinic's data now. Returns the run { id, status, tabs, rows_total, error, spreadsheetUrl }.
 * Throws GSHEETS_NOT_CONNECTED / GSHEETS_RUNNING before anything is sent.
 */
async function run(businessId, { trigger = 'manual', userId = null, ip = null } = {}) {
  const cfg = await get(businessId);
  if (!cfg.connected) throw fail(cfg.needsReconnect ? 'GSHEETS_RECONNECT' : 'GSHEETS_NOT_CONNECTED', 'Connect Google Sheets first.', 409);
  const got = await knex('sheet_sync_settings').where({ business_id: businessId })
    .where((q) => q.whereNull('running_since').orWhere('running_since', '<', new Date(Date.now() - STALE_LOCK_MS))).update({ running_since: new Date() });
  if (!got) throw fail('GSHEETS_RUNNING', 'An export is already running.', 409);
  const [runId] = await knex('sheet_sync_runs').insert({ business_id: businessId, trigger, method: cfg.method, status: 'running', started_by: userId });
  const results = [];
  let error = null;
  let spreadsheetId = cfg.spreadsheet_id || null;
  try {
    const b = await knex('businesses').where({ id: businessId }).first('name', 'name_en', 'timezone', 'currency');
    const tabs = await buildTabs({
      businessId, tabs: cfg.tabs, locale: cfg.sheet_locale, monthsBack: cfg.months_back,
      includePatients: cfg.include_patients && Boolean(cfg.patients_ack_at), timezone: b.timezone, currency: b.currency,
    });
    const rtl = cfg.sheet_locale === 'ar';
    // Chosen tabs with nothing to build here (staff salaries without the finance module): listed as skipped.
    cfg.tabs.filter((k) => k !== 'patients' && !tabs.some((x) => x.key === k)).forEach((k) => results.push({ key: k, rows: 0, ok: true, skipped: true }));
    if (cfg.method === 'oauth') {
      const name = (cfg.sheet_locale === 'en' && b.name_en) || b.name;
      const s = await ensureSpreadsheet(businessId, cfg, name, tabs, rtl);
      spreadsheetId = s.id;
    }
    for (const tab of tabs) {
      try {
        if (cfg.method === 'oauth') await writeTabApi(businessId, spreadsheetId, tab); // eslint-disable-line no-await-in-loop
        else await writeTabHook(cfg.webhookUrl, cfg.webhookSecret, tab, rtl); // eslint-disable-line no-await-in-loop
        results.push({ key: tab.key, rows: tab.rows.length, ok: true, truncated: tab.truncated || undefined });
      } catch (e) {
        results.push({ key: tab.key, rows: tab.rows.length, ok: false, error: reasonOf(e) });
        // A broken connection fails every tab the same way: stop instead of repeating it.
        if (e instanceof AppError && ['GSHEETS_RECONNECT', 'GSHEETS_NO_CLIENT', 'GSHEETS_WEBHOOK_SECRET', 'GSHEETS_WEBHOOK_ACCESS', 'GSHEETS_WEBHOOK_BLOCKED', 'GSHEETS_NETWORK', 'GSHEETS_WEBHOOK_NETWORK'].includes(e.code)) { error = reasonOf(e); break; }
      }
    }
  } catch (e) {
    error = reasonOf(e);
  }
  const real = results.filter((r) => !r.skipped);
  const okTabs = real.filter((r) => r.ok);
  const status = !error && real.length && okTabs.length === real.length ? 'ok' : okTabs.length ? 'partial' : 'failed';
  if (!error && status !== 'ok') error = (results.find((r) => !r.ok) || {}).error || 'OTHER:';
  const rowsTotal = okTabs.reduce((a, r) => a + r.rows, 0);
  await knex('sheet_sync_runs').where({ id: runId }).update({ status, tabs: JSON.stringify(results), rows_total: rowsTotal, error: error ? error.slice(0, 400) : null, finished_at: new Date() });
  await knex('sheet_sync_settings').where({ business_id: businessId }).update({ running_since: null, last_run_at: new Date(), last_status: status });
  await audit.record({ businessId, userId, ip }, 'integrations.sheets_exported', {
    entityType: 'sheet_sync', entityId: runId,
    newValues: { trigger, method: cfg.method, status, rows: rowsTotal, tabs: okTabs.map((r) => r.key), patients: okTabs.some((r) => r.key === 'patients') },
  });
  return { id: runId, status, tabs: results, rows_total: rowsTotal, error, spreadsheetUrl: spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` : null };
}

async function runs(businessId, limit = 15) {
  const rows = await knex('sheet_sync_runs as r').leftJoin('users as u', 'u.id', 'r.started_by').where('r.business_id', businessId)
    .orderBy('r.id', 'desc').limit(limit).select('r.*', 'u.name as started_by_name');
  return rows.map((r) => ({ ...r, tabs: (() => { try { return JSON.parse(r.tabs || '[]'); } catch { return []; } })() }));
}

/** Automatic daily export: clinics that switched it on and have not been exported in the last ~day. */
async function runDue() {
  const due = await knex('sheet_sync_settings').where({ auto_daily: true }).whereNotNull('method')
    .where((q) => q.whereNull('last_run_at').orWhere('last_run_at', '<', new Date(Date.now() - 23 * 3_600_000)))
    .where((q) => q.whereNull('running_since').orWhere('running_since', '<', new Date(Date.now() - STALE_LOCK_MS)))
    .limit(10).pluck('business_id');
  for (const id of due) await run(id, { trigger: 'auto' }).catch(() => {}); // eslint-disable-line no-await-in-loop
  return due.length;
}

// ---------------------------------------------------------------- Apps Script template
/** The script the clinic pastes into Extensions → Apps Script of its spreadsheet (contains the shared secret). */
function appsScript(secret) {
  return `/**
 * DocBook → Google Sheets (one-way export).
 * Paste this into Extensions → Apps Script of the spreadsheet that should receive the data,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone) and copy the web app URL.
 * DocBook sends each tab as JSON with the secret below; requests without it are ignored.
 */
var SECRET = '${String(secret).replace(/[^A-Za-z0-9_-]/g, '')}';

function doPost(e) {
  try {
    var body = JSON.parse(e && e.postData && e.postData.contents || '{}');
    if (!body || body.secret !== SECRET) return reply({ ok: false, error: 'unauthorized' });
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (body.action === 'ping') return reply({ ok: true, spreadsheet: ss.getName() });
    if (body.action !== 'write' || !body.tab || !body.header || !body.rows) return reply({ ok: false, error: 'bad_request' });
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var name = String(body.tab).slice(0, 90);
      var width = body.header.length;
      var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
      if (body.mode === 'replace') {
        sheet.clearContents();
        sheet.setRightToLeft(body.rtl === true);
        sheet.getRange(1, 1, 1, width).setValues([body.header.map(cell)]).setFontWeight('bold');
        sheet.setFrozenRows(1);
      }
      if (body.rows.length) {
        var rows = body.rows.map(function (r) { var out = []; for (var i = 0; i < width; i++) out.push(cell(r[i])); return out; });
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, width).setValues(rows);
      }
      return reply({ ok: true, written: body.rows.length });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) });
  }
}

// Text that starts like a formula is written as plain text, never evaluated.
function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && /^[=+\\-@]/.test(v)) return "'" + v;
  return v;
}

function reply(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
`;
}

module.exports = {
  GOOGLE, SCOPE, TABS, DEFAULT_TABS, MONTHS, MAX_ROWS, HOOK_CHUNK_ROWS, HOOK_CHUNK_BYTES, STAFF_SALARY_TABLES,
  setTransport, get, saveOptions, redirectUri, oauthClient, startOAuth, finishOAuth, accessToken,
  checkWebhookUrl, chunkRows, hookPost, writeTabHook, startWebhook, saveWebhook, test, disconnect,
  buildTabs, run, runs, runDue, appsScript, ensureSpreadsheet, writeTabApi,
};
