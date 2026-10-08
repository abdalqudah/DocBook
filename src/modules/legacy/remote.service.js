// Direct pull from Clinica: the clinic's owner gives the Clinica address and the clinic's own Clinica sign-in; this
// server signs in like a browser (the sign-in form of the page, its hidden fields kept), then for each Clinica patient
// already imported here reads the patient's pages (/dental/<id>, /edit_patient/<id>), collects every attachment link
// (/system/files/…) and downloads the files it does not have yet straight into the patient's file (patient_attachments,
// private store, one stored copy per SHA-256). Read-only towards Clinica.
//   • The password is never written anywhere: it stays in this process's memory while the job runs (to sign in again
//     when Clinica's session ends) and is dropped when the job ends. After a server restart the job waits for it.
//   • A saved job (import_jobs type legacy_remote, cursor = legacy_patients.id, heartbeat): stopped, it carries on.
//   • Gentle: one request at a time with a pause, retries with back-off; only the Clinica address's own links.
//   • Counts: total/processed = patients, src_links = attachments found in Clinica, success = downloaded now,
//     skipped = already here, failed (with an import_errors row each).
const crypto = require('crypto');
const net = require('net');
const knex = require('../../db/knex');
const tenant = require('../../db/tenant');
const audit = require('../../core/audit');
const { E } = require('../../core/errors');
const files = require('./files');

const SOURCE = 'clinica';
const TYPE = 'legacy_remote';
const STALE_MS = 2 * 60_000;
const DELAY_MS = Number(process.env.LEGACY_REMOTE_DELAY_MS || 300);
const MAX_FILE = 200 * 1024 * 1024;
const RUNNER = `${require('os').hostname().slice(0, 20)}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`; // eslint-disable-line global-require
const now = () => new Date();
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ================================================================= the address
/** The Clinica address: https (http only in tests), a host name — never this machine or a private network. */
function baseOf(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw E.validation({ base_url: 'Enter the Clinica address, e.g. https://name.clinicame.net' }); }
  const test = process.env.NODE_ENV === 'test';
  if (u.protocol !== 'https:' && !(test && u.protocol === 'http:')) throw E.validation({ base_url: 'The address must start with https://' });
  const h = u.hostname.replace(/^\[|\]$/g, '');
  const privateIp = net.isIP(h) && (/^(10\.|127\.|169\.254\.|192\.168\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '::1' || /^f[cd]/i.test(h));
  if (!test && (privateIp || h === 'localhost' || !h.includes('.'))) throw E.validation({ base_url: 'Enter the Clinica address on the internet.' });
  return u.origin;
}

// ================================================================= a browser-like session
class Session {
  constructor(base, user, pass) { Object.assign(this, { base, user, pass, jar: new Map() }); }

  cookie() { return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }

  keep(res) {
    (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((h) => {
      const [kv] = h.split(';'); const i = kv.indexOf('=');
      if (i > 0) { const k = kv.slice(0, i).trim(); const v = kv.slice(i + 1).trim(); if (/max-age=0|expires=thu, 01 jan 1970/i.test(h) || v === 'deleted') this.jar.delete(k); else this.jar.set(k, v); }
    });
  }

  /** A request with the session's cookies, redirects followed by hand (cookies kept on each step); same origin only. */
  async request(url, { method = 'GET', body = null, binary = false } = {}) {
    let target = new URL(url, this.base).href; let m = method; let b = body;
    for (let hop = 0; hop < 8; hop += 1) {
      if (new URL(target).origin !== this.base) throw Object.assign(new Error('Left the Clinica address'), { code: 'OFF_SITE' });
      const res = await fetch(target, { // eslint-disable-line no-await-in-loop
        method: m, redirect: 'manual', body: b,
        headers: { cookie: this.cookie(), 'user-agent': 'Mozilla/5.0 (DocBook data transfer)', accept: binary ? '*/*' : 'text/html,application/xhtml+xml', ...(b ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        signal: AbortSignal.timeout(60_000),
      });
      this.keep(res);
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
        target = new URL(res.headers.get('location'), target).href;
        if (res.status !== 307 && res.status !== 308) { m = 'GET'; b = null; }
        continue; // eslint-disable-line no-continue
      }
      const type = res.headers.get('content-type') || '';
      const size = Number(res.headers.get('content-length') || 0);
      if (binary && size > MAX_FILE) throw Object.assign(new Error('File too large'), { code: 'FILE_TOO_LARGE' });
      const buf = Buffer.from(await res.arrayBuffer()); // eslint-disable-line no-await-in-loop
      return { status: res.status, url: target, type, buf, text: binary && !/text\/html/.test(type) ? '' : buf.toString('utf8') };
    }
    throw Object.assign(new Error('Too many redirects'), { code: 'REDIRECTS' });
  }

  /** The sign-in page and its form (the first of /user/login, /login, / that has one). */
  async signInPage() {
    for (const p of ['/user/login', '/login', '/']) { // eslint-disable-line no-restricted-syntax
      const page = await this.request(p).catch(() => null); // eslint-disable-line no-await-in-loop
      const form = page && page.status === 200 ? loginForm(page.text) : null;
      if (form) return { page, form };
    }
    throw Object.assign(new Error('No sign-in form found at this address.'), { code: 'LOGIN_FORM_NOT_FOUND' });
  }

  /**
   * Signs in with the page's own sign-in form (hidden fields kept). A form with a CAPTCHA question needs the answer a
   * person typed (`answer`, for the form fetched with signInPage and kept in `this.pending`); it is never worked out
   * here — without one the sign-in stops with CAPTCHA_REQUIRED and the question, for the owner to answer.
   */
  async login(answer = null) {
    const { page, form } = this.pending || await this.signInPage();
    this.pending = null;
    if (form.captchaInput && !String(answer || '').trim()) {
      this.pending = { page, form };
      throw Object.assign(new Error('Clinica asks a question at sign-in.'), { code: 'CAPTCHA_REQUIRED', question: form.question });
    }
    const fields = new URLSearchParams();
    form.inputs.forEach((i) => { if (i.name && i.type !== 'password' && i !== form.userInput && i !== form.captchaInput && !['submit', 'button', 'image', 'checkbox', 'radio'].includes(i.type)) fields.append(i.name, i.value || ''); });
    const submit = form.inputs.find((i) => i.type === 'submit' && i.name);
    if (submit) fields.append(submit.name, submit.value || '');
    fields.append(form.userInput.name, this.user);
    fields.append(form.passInput.name, this.pass);
    if (form.captchaInput) fields.append(form.captchaInput.name, String(answer).trim());
    const res = await this.request(new URL(form.action || page.url, page.url).href, { method: 'POST', body: fields.toString() });
    if (res.status < 400 && !loginForm(res.text)) return true;
    throw Object.assign(new Error('Clinica did not accept the sign-in (user name, password or the answer to its question).'), { code: 'LOGIN_FAILED' });
  }

  /** A page / file; signed in again once when Clinica shows its sign-in form (session ended). */
  async get(url, opts = {}) {
    let r = await this.request(url, opts);
    if (r.text && loginForm(r.text)) {
      try { await this.login(); } catch (e) { throw Object.assign(e, { code: e.code === 'CAPTCHA_REQUIRED' ? 'LOGIN_FAILED' : e.code }); } // a question: the owner signs in again
      r = await this.request(url, opts);
    }
    if (r.text && loginForm(r.text)) throw Object.assign(new Error('Signed out of Clinica'), { code: 'LOGIN_FAILED' });
    return r;
  }
}

const attr = (tag, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag); return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null; };
const unent = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
/** The page's sign-in form: the form with a password field → { action, inputs, userInput, passInput } or null. */
function loginForm(html) {
  const forms = String(html || '').match(/<form\b[\s\S]*?<\/form>/gi) || [];
  for (const f of forms) { // eslint-disable-line no-restricted-syntax
    const inputs = (f.match(/<input\b[^>]*>/gi) || []).map((t) => ({ name: attr(t, 'name'), type: (attr(t, 'type') || 'text').toLowerCase(), value: unent(attr(t, 'value')) }));
    const passInput = inputs.find((i) => i.type === 'password' && i.name);
    if (!passInput) continue; // eslint-disable-line no-continue
    const texts = inputs.filter((i) => ['text', 'email', 'tel'].includes(i.type) && i.name);
    // a CAPTCHA answer field (e.g. Drupal's captcha_response) is not the user name
    const captchaInput = texts.find((i) => /captcha/i.test(i.name)) || null;
    const userInput = texts.find((i) => i !== captchaInput && /user|name|mail|login|phone/i.test(i.name)) || texts.find((i) => i !== captchaInput);
    if (!userInput) continue; // eslint-disable-line no-continue
    return { action: unent(attr(f.slice(0, f.indexOf('>') + 1), 'action')), inputs, userInput, passInput, captchaInput, question: captchaInput ? captchaQuestion(f) : null };
  }
  return null;
}

/** The text of the form's CAPTCHA question as the page shows it ("20 + 0 =") — shown to the owner, who answers it. */
function captchaQuestion(formHtml) {
  const i = formHtml.search(/<input\b[^>]*name\s*=\s*["'][^"']*captcha_response/i);
  const before = (i >= 0 ? formHtml.slice(0, i) : formHtml).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
  const text = unent(before.replace(/<[^>]+>/g, '\n')).split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const eq = [...text].reverse().find((x) => /=\s*$/.test(x) || /\d\s*[-+×x*÷/]\s*\d/.test(x));
  return (eq || text.slice(-2).join(' ') || '').slice(0, 200);
}

/** Every attachment link of a page (/system/files/…), same address only → [{ url, path, name }]. */
function attachmentLinks(html, pageUrl, base) {
  const out = new Map();
  const found = [];
  String(html || '').replace(/(?:href|src|data-href|data-url|data)\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, q, a, b2) => { found.push(unent(a ?? b2)); return m; });
  // links written inside scripts / handlers: a quoted address (relative or absolute) that holds /system/files/
  String(html || '').replace(/["']((?:https?:\/\/[^"'\s<>]+)?\/system\/files\/[^"'<>]+)["']/g, (m, x) => { found.push(unent(x)); return m; });
  found.filter((x) => x && x.includes('/system/files/')).forEach((raw) => {
    let u;
    try { u = new URL(raw, pageUrl); } catch { return; }
    if (u.origin !== base) return;
    const path = pathKey(u.href);
    if (!path || out.has(path)) return;
    let name = u.pathname.split('/').pop() || 'file';
    try { name = decodeURIComponent(name); } catch { /* as written */ }
    out.set(path, { url: u.href, path, name });
  });
  return [...out.values()];
}
/** A link's key: its path, decoded the same way whichever form it was written in. */
function pathKey(url) { try { const u = new URL(url); let p = u.pathname; try { p = decodeURI(p); } catch { /* as is */ } return p; } catch { return null; } }

// ================================================================= the job
const sessions = new Map(); // businessId → Session (memory only)
const openJob = (businessId) => knex('import_jobs').where({ business_id: businessId, type: TYPE }).whereIn('status', ['processing', 'waiting']).orderBy('id', 'desc').first();

const pending = new Map(); // businessId → { s, at }: a sign-in page fetched, waiting for the owner's answer
const PENDING_MS = 10 * 60_000;

/** Opens Clinica's sign-in page for the owner: its question when it asks one ({ question } or { question: null }). */
async function prepare(ctx, { baseUrl }) {
  const base = baseOf(baseUrl);
  const s = new Session(base, '', '');
  const { page, form } = await s.signInPage().catch((e) => { throw E.validation({ base_url: e.message }); });
  s.pending = { page, form };
  pending.set(ctx.businessId, { s, at: Date.now() });
  return { base, question: form.captchaInput ? form.question || '?' : null };
}
/** The sign-in page fetched for the owner (same address, recent), if any. */
function pendingFor(businessId, base) {
  const p = pending.get(businessId);
  return p && p.s.base === base && Date.now() - p.at < PENDING_MS ? p : null;
}
const pendingQuestion = (businessId) => { const p = pending.get(businessId); return p && Date.now() - p.at < PENDING_MS && p.s.pending ? { base: p.s.base, question: p.s.pending.form.captchaInput ? p.s.pending.form.question || '?' : null } : null; };

/** The owner's sign-in (with the answer to Clinica's question, on the page fetched for it) → a signed-in session. */
async function signIn(ctx, { baseUrl, username, password, captcha = null }) {
  const base = baseOf(baseUrl);
  if (!String(username || '').trim() || !String(password || '')) throw E.validation({ username: 'Enter the Clinica user name and password.' });
  const p = pendingFor(ctx.businessId, base);
  const s = p ? p.s : new Session(base, '', '');
  Object.assign(s, { user: String(username).trim(), pass: String(password) });
  pending.delete(ctx.businessId);
  try { await s.login(captcha); } catch (e) {
    if (e.code === 'CAPTCHA_REQUIRED' || (e.code === 'LOGIN_FAILED' && s.pending)) pending.set(ctx.businessId, { s, at: Date.now() });
    // a refused sign-in: the next try needs a fresh question
    if (e.code === 'LOGIN_FAILED') await prepare(ctx, { baseUrl: base }).catch(() => null);
    throw E.validation({ password: e.message });
  }
  return s;
}

/** Signs in now (so a wrong password is said at once), then starts or carries on the clinic's pull. */
async function start(ctx, creds) {
  const s = await signIn(ctx, creds);
  const { base } = s;
  sessions.set(ctx.businessId, s);
  const total = Number((await knex('legacy_patients').where({ business_id: ctx.businessId, legacy_source: SOURCE }).whereNotNull('patient_id').count({ n: '*' }))[0].n);
  const cur = await openJob(ctx.businessId);
  if (cur) await knex('import_jobs').where({ id: cur.id }).update({ status: 'processing', total, error: null, runner: null, heartbeat_at: null });
  else await knex('import_jobs').insert({ business_id: ctx.businessId, type: TYPE, status: 'processing', stage: 'cursor:0', total, processed: 0, created_by: ctx.userId || null, started_at: now() });
  await audit.record(ctx, 'legacy.remote_started', { entityType: 'business', entityId: ctx.businessId, newValues: { address: base, patients: total } });
  kick(ctx.businessId);
}

/** Stops the pull (the password is dropped; Start carries on where it was). */
async function stop(ctx) {
  sessions.delete(ctx.businessId);
  const job = await openJob(ctx.businessId);
  if (job) await knex('import_jobs').where({ id: job.id }).update({ status: 'waiting', error: 'STOPPED', runner: null, heartbeat_at: null });
  await audit.record(ctx, 'legacy.remote_stopped', { entityType: 'business', entityId: ctx.businessId });
}

const busy = new Map();
function kick(businessId) {
  if (busy.has(businessId)) return busy.get(businessId);
  const p = tenant.runFor(businessId, () => run(businessId)).catch((e) => console.error('[legacy-remote]', e.message)).finally(() => busy.delete(businessId)); // eslint-disable-line no-console
  busy.set(businessId, p);
  return p;
}
const settle = (businessId) => busy.get(businessId) || Promise.resolve();

async function fail(job, legacyPatientId, file, code, message) {
  await knex('import_errors').insert({ business_id: job.business_id, job_id: job.id, legacy_patient_id: legacyPatientId, file: file ? String(file).slice(0, 500) : null, stage: 'remote', error_code: code, message: String(message || '').slice(0, 500) });
}

async function run(businessId) {
  for (;;) {
    const job = await openJob(businessId); // eslint-disable-line no-await-in-loop
    if (!job || job.status !== 'processing') return;
    const s = sessions.get(businessId);
    if (!s) { await knex('import_jobs').where({ id: job.id }).update({ status: 'waiting', error: 'NEEDS_SIGN_IN', runner: null, heartbeat_at: null }); return; } // eslint-disable-line no-await-in-loop
    const stale = new Date(Date.now() - STALE_MS);
    const claimed = await knex('import_jobs').where({ id: job.id }).where((w) => w.whereNull('runner').orWhere('runner', RUNNER).orWhereNull('heartbeat_at').orWhere('heartbeat_at', '<', stale)).update({ runner: RUNNER, heartbeat_at: now() }); // eslint-disable-line no-await-in-loop
    if (!claimed) return;
    const cursor = Number(String(job.stage || '').replace('cursor:', '')) || 0;
    const batch = await knex('legacy_patients').where({ business_id: businessId, legacy_source: SOURCE }).whereNotNull('patient_id').where('id', '>', cursor).orderBy('id').limit(20) // eslint-disable-line no-await-in-loop
      .select('id', 'patient_id', 'legacy_patient_id', 'legacy_patient_number');
    if (!batch.length) {
      sessions.delete(businessId);
      const [errs] = await knex('import_errors').where({ job_id: job.id }).count({ n: '*' }); // eslint-disable-line no-await-in-loop
      await knex('import_jobs').where({ id: job.id }).update({ status: Number(errs.n) ? 'completed_with_issues' : 'completed', completed_at: now(), runner: null, heartbeat_at: null, error: null }); // eslint-disable-line no-await-in-loop
      await audit.record({ businessId, userId: job.created_by }, 'legacy.remote_completed', { entityType: 'import_job', entityId: job.id, newValues: { found: job.src_links, downloaded: job.success, skipped: job.skipped, failed: job.failed } }); // eslint-disable-line no-await-in-loop
      return;
    }
    for (const lp of batch) { // eslint-disable-line no-restricted-syntax
      if (!sessions.has(businessId)) return; // stopped
      try {
        await patient(job, s, lp); // eslint-disable-line no-await-in-loop
      } catch (e) {
        if (e.code === 'LOGIN_FAILED' || e.code === 'STORAGE_FULL' || e.code === 'STORAGE_QUOTA') {
          sessions.delete(businessId);
          await knex('import_jobs').where({ id: job.id }).update({ status: 'waiting', error: String(e.code || 'STOPPED').slice(0, 255), runner: null, heartbeat_at: null }); // eslint-disable-line no-await-in-loop
          return;
        }
        await fail(job, lp.legacy_patient_id, null, e.code || 'PAGE_FAILED', e.message); // eslint-disable-line no-await-in-loop
      }
      await knex('import_jobs').where({ id: job.id }).update({ stage: `cursor:${lp.id}`, processed: knex.raw('processed + 1'), heartbeat_at: now() }); // eslint-disable-line no-await-in-loop
    }
  }
}

async function withRetry(fn) {
  for (let i = 1; ; i += 1) { // eslint-disable-line no-restricted-syntax
    try { return await fn(); } catch (e) { // eslint-disable-line no-await-in-loop
      if (i >= 3 || ['LOGIN_FAILED', 'OFF_SITE', 'FILE_TOO_LARGE'].includes(e.code)) throw e;
      await sleep(1000 * 2 ** i); // eslint-disable-line no-await-in-loop
    }
  }
}

/** One Clinica patient: its pages → its attachment links → the files not here yet. */
async function patient(job, s, lp) {
  const businessId = job.business_id;
  const links = new Map();
  for (const p of [`/dental/${encodeURIComponent(lp.legacy_patient_id)}`, `/edit_patient/${encodeURIComponent(lp.legacy_patient_id)}`]) { // eslint-disable-line no-restricted-syntax
    const r = await withRetry(() => s.get(p)); // eslint-disable-line no-await-in-loop
    if (r.status === 200) attachmentLinks(r.text, r.url, s.base).forEach((l) => { if (!links.has(l.path)) links.set(l.path, l); });
    await sleep(DELAY_MS); // eslint-disable-line no-await-in-loop
  }
  if (!links.size) return;
  await knex('import_jobs').where({ id: job.id }).update({ src_links: knex.raw('src_links + ?', [links.size]) });
  const have = new Set((await knex('patient_attachments').where({ business_id: businessId, legacy_patient_id: lp.legacy_patient_id }).whereNotNull('source_url').pluck('source_url')).map(pathKey));
  for (const l of links.values()) { // eslint-disable-line no-restricted-syntax
    if (have.has(l.path)) { await knex('import_jobs').where({ id: job.id }).update({ skipped: knex.raw('skipped + 1') }); continue; } // eslint-disable-line no-await-in-loop, no-continue
    try {
      const r = await withRetry(() => s.get(l.url, { binary: true })); // eslint-disable-line no-await-in-loop
      if (r.status !== 200 || !r.buf.length) throw Object.assign(new Error(`HTTP ${r.status}`), { code: r.status === 404 ? 'SOURCE_NOT_FOUND' : 'DOWNLOAD_FAILED' });
      const added = await store(job, lp, l, r); // eslint-disable-line no-await-in-loop
      await knex('import_jobs').where({ id: job.id }).update(added ? { success: knex.raw('success + 1') } : { skipped: knex.raw('skipped + 1') }); // eslint-disable-line no-await-in-loop
    } catch (e) {
      if (e.code === 'LOGIN_FAILED' || /STORAGE/.test(e.code || '')) throw e;
      await fail(job, lp.legacy_patient_id, l.url, e.code || 'DOWNLOAD_FAILED', e.message); // eslint-disable-line no-await-in-loop
      await knex('import_jobs').where({ id: job.id }).update({ failed: knex.raw('failed + 1') }); // eslint-disable-line no-await-in-loop
    }
    await sleep(DELAY_MS); // eslint-disable-line no-await-in-loop
  }
}

/** A downloaded file → the patient's file (once per patient and content); false when it was there already. */
async function store(job, lp, link, r) {
  const businessId = job.business_id;
  const sha = files.sha256(r.buf);
  if (await knex('patient_attachments').where({ business_id: businessId, legacy_patient_id: lp.legacy_patient_id, checksum: sha }).first('id')) return false;
  const copy = await knex('patient_attachments').where({ business_id: businessId, checksum: sha }).whereNull('duplicate_of').first('id', 'storage_path');
  const shared = copy && files.exists(copy.storage_path);
  if (!shared) await require('../storage/storage.service').assertRoom(businessId, r.buf.length); // eslint-disable-line global-require
  const storagePath = shared ? copy.storage_path : files.put(businessId, sha, r.buf);
  const name = link.name || 'file';
  const cat = files.categoryOf(name);
  await knex('patient_attachments').insert({
    business_id: businessId, patient_id: lp.patient_id, legacy_patient_ref: lp.id, legacy_source: SOURCE, legacy_patient_id: lp.legacy_patient_id,
    legacy_patient_number: lp.legacy_patient_number || null, original_filename: name.slice(0, 255), stored_filename: name.slice(0, 255),
    mime_type: files.typeOf(name, r.buf) || (r.type || '').split(';')[0] || 'application/octet-stream', category: cat, file_size: r.buf.length,
    stored_bytes: shared ? 0 : r.buf.length, storage_path: storagePath, checksum: sha, duplicate_of: shared ? copy.id : null,
    source_url: link.url.slice(0, 1000), import_job_id: job.id,
  }).onConflict(['business_id', 'legacy_patient_id', 'checksum']).ignore();
  return true;
}

/** Where the clinic's pull is (for the page). */
async function progress(businessId) {
  const job = await knex('import_jobs').where({ business_id: businessId, type: TYPE }).orderBy('id', 'desc').first();
  if (!job) return null;
  const running = job.status === 'processing' && sessions.has(businessId);
  if (running && (!job.heartbeat_at || new Date(job.heartbeat_at) < new Date(Date.now() - STALE_MS))) kick(businessId);
  const errors = await knex('import_errors').where({ job_id: job.id }).orderBy('id', 'desc').limit(50).select('legacy_patient_id', 'file', 'error_code', 'message');
  return {
    id: job.id, status: running ? 'processing' : job.status, waitingFor: job.status === 'processing' && !running ? 'NEEDS_SIGN_IN' : job.error,
    patients: { done: job.processed, total: job.total }, found: job.src_links, downloaded: job.success, skipped: job.skipped, failed: job.failed,
    remaining: Math.max(0, job.src_links - job.success - job.skipped - job.failed), errors, startedAt: job.started_at, completedAt: job.completed_at,
  };
}

/** A pull whose process stopped (its heartbeat went quiet, the password with it) waits for the password again. */
async function resumeAll() {
  await tenant.eachDb(async () => {
    const stale = new Date(Date.now() - STALE_MS);
    const jobs = await knex('import_jobs').where({ type: TYPE, status: 'processing' }).where((w) => w.whereNull('heartbeat_at').orWhere('heartbeat_at', '<', stale)).select('id', 'business_id').catch(() => []);
    for (const j of jobs) { // eslint-disable-line no-restricted-syntax
      if (sessions.has(j.business_id)) kick(j.business_id);
      else await knex('import_jobs').where({ id: j.id }).update({ status: 'waiting', error: 'NEEDS_SIGN_IN', runner: null, heartbeat_at: null }); // eslint-disable-line no-await-in-loop
    }
  });
}

// ================================================================= the structure of Clinica's pages
// What the pull of patients, calendar and treatments needs to know about Clinica's pages, without any patient data:
// for each page — its address with numbers as {n} and query values dropped, its forms (action, input names and types,
// select names and how many options), its tables (header labels, how many rows), the form labels, the addresses it
// links to (as patterns, counted) and the addresses its scripts ask for (calendar feeds…). No text, value, title or
// heading of a page is kept. The session is dropped after (the password is not kept).
const PATTERN = (u) => {
  try {
    const x = new URL(u);
    const path = x.pathname.split('/').map((seg) => (/\d/.test(seg) ? '{n}' : seg)).join('/');
    const keys = [...new Set([...x.searchParams.keys()])].sort();
    return `${path}${keys.length ? `?${keys.map((k) => `${k}=`).join('&')}` : ''}`;
  } catch { return null; }
};
const textOf = (h) => unent(String(h || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 80);
function pageShape(html, url, base) {
  const h = String(html || '');
  const forms = (h.match(/<form\b[\s\S]*?<\/form>/gi) || []).map((f) => ({
    action: PATTERN(new URL(unent(attr(f.slice(0, f.indexOf('>') + 1), 'action')) || url, url).href),
    method: (attr(f.slice(0, f.indexOf('>') + 1), 'method') || 'get').toLowerCase(),
    inputs: (f.match(/<input\b[^>]*>/gi) || []).map((t) => `${attr(t, 'name') || '?'}:${(attr(t, 'type') || 'text').toLowerCase()}`).filter((x) => !x.startsWith('?:hidden')),
    selects: (f.match(/<select\b[\s\S]*?<\/select>/gi) || []).map((x) => `${attr(x.slice(0, x.indexOf('>') + 1), 'name') || '?'}(${(x.match(/<option\b/gi) || []).length})`),
    textareas: (f.match(/<textarea\b[^>]*>/gi) || []).map((t) => attr(t, 'name') || '?'),
  }));
  const tables = (h.match(/<table\b[\s\S]*?<\/table>/gi) || []).map((t) => ({
    headers: (t.match(/<th\b[\s\S]*?<\/th>/gi) || []).map(textOf).slice(0, 30),
    rows: (t.match(/<tr\b/gi) || []).length,
  }));
  const labels = [...new Set((h.match(/<(label|legend)\b[\s\S]*?<\/\1>/gi) || []).map(textOf).filter(Boolean))].slice(0, 80);
  const links = new Map();
  const examples = new Map(); // pattern → one real address (to visit; never in the report)
  h.replace(/href\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, q, a, b2) => {
    try { const u = new URL(unent(a ?? b2), url); if (u.origin === base) { const k = PATTERN(u.href); if (!examples.has(k)) examples.set(k, u.href); links.set(k, (links.get(k) || 0) + 1); } } catch { /* not an address */ }
    return m;
  });
  const scripts = new Set();
  (h.match(/<script\b[^>]*src\s*=\s*["'][^"']+["']/gi) || []).forEach((t) => { try { scripts.add(PATTERN(new URL(unent(attr(t, 'src')), url).href)); } catch { /* skip */ } });
  const feeds = new Set();
  (h.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || []).forEach((sc) => {
    (sc.match(/["'](\/[a-z0-9_\-/.]+(?:\?[^"'\s]*)?)["']/gi) || []).forEach((q) => { try { const k = PATTERN(new URL(q.slice(1, -1), url).href); if (k && k.length > 1) feeds.add(k); } catch { /* skip */ } });
    (sc.match(/\b(fullCalendar|FullCalendar|eventSources?|events\s*:|\$\.ajax|\$\.get|\$\.post|fetch\(|XMLHttpRequest)\b/g) || []).forEach((w) => feeds.add(`js:${w.replace(/\s*:$/, '')}`));
  });
  const shape = { page: PATTERN(url), forms, tables, labels, links: [...links.entries()].sort((a, b) => b[1] - a[1]).slice(0, 150), scripts: [...scripts], feeds: [...feeds].slice(0, 80) };
  Object.defineProperty(shape, 'examples', { value: examples, enumerable: false });
  return shape;
}

const probes = new Map(); // businessId → the last report (memory only)
/** Signs in, reads Clinica's pages (its menu, a patient's pages) and keeps their structure for the owner to download. */
async function probe(ctx, creds) {
  const s = await signIn(ctx, creds);
  const report = { generated_at: now().toISOString(), address: s.base, pages: [] };
  const seen = new Set();
  const visit = async (path) => {
    const url = new URL(path, s.base).href;
    const key = PATTERN(url);
    if (!key || seen.has(key) || report.pages.length >= 40) return null;
    seen.add(key);
    try {
      const r = await s.get(url);
      await sleep(DELAY_MS);
      const ps = /html/.test(r.type || '') || !r.type ? pageShape(r.text, r.url, s.base) : { page: PATTERN(r.url) };
      report.pages.push({ status: r.status, type: (r.type || '').split(';')[0], ...ps });
      return ps;
    } catch (e) { report.pages.push({ page: key, error: e.code || e.message }); return null; }
  };
  const home = await visit('/');
  const lp = await knex('legacy_patients').where({ business_id: ctx.businessId, legacy_source: SOURCE }).whereNotNull('legacy_patient_id').orderBy('id').first('legacy_patient_id');
  if (lp) { await visit(`/dental/${encodeURIComponent(lp.legacy_patient_id)}`); await visit(`/edit_patient/${encodeURIComponent(lp.legacy_patient_id)}`); }
  // the menu: the pages the home page links to (one of each pattern, no sign-out / delete / file links)
  // only addresses that read: nothing that could sign out, change, send or delete
  const UNSAFE = /log-?out|sign-?out|delete|remove|cancel|archive|approve|confirm|send|sms|whatsapp|status|toggle|block|clear|reset|pay|refund|void|add|new|create|save|update|edit|backup|export|import|\/system\/files\//i;
  for (const [k] of (home && home.links) || []) { // eslint-disable-line no-restricted-syntax
    if (report.pages.length >= 40) break;
    if (UNSAFE.test(k)) continue; // eslint-disable-line no-continue
    if (home.examples && home.examples.get(k)) await visit(home.examples.get(k)); // eslint-disable-line no-await-in-loop
  }
  probes.set(ctx.businessId, report);
  await audit.record(ctx, 'legacy.remote_probed', { entityType: 'business', entityId: ctx.businessId, newValues: { address: s.base, pages: report.pages.length } });
  return report;
}
const probeReport = (businessId) => probes.get(businessId) || null;

module.exports = { TYPE, prepare, pendingQuestion, start, stop, probe, probeReport, pageShape, kick, settle, progress, resumeAll, baseOf, loginForm, captchaQuestion, attachmentLinks, pathKey, Session };
