// Custom domains for clinic pages (e.g. book.myclinic.com instead of docbook/<slug>).
// A domain goes live only after it is proven in public DNS:
//   1. ownership — a TXT record  _docbook.<host>  =  docbook-verify=<token>
//   2. pointing  — a CNAME to the DocBook host (APP_URL), or A records that match the DocBook server.
// Live domains serve only the clinic's public page and online booking (see src/middleware/domain.js).
// One domain per clinic. Several clinics may claim the same host while pending, but only one can verify it.
const crypto = require('crypto');
const net = require('net');
const url = require('url');
const { Resolver } = require('dns').promises;
const knex = require('../../db/knex');
const config = require('../../config');
const cache = require('../../core/cache');
const audit = require('../../core/audit');
const { E, AppError } = require('../../core/errors');

const TXT_PREFIX = '_docbook';
const txtValue = (token) => `docbook-verify=${token}`;
const newToken = () => crypto.randomBytes(16).toString('hex');
const DNS_TIMEOUT_MS = 5000;

const platformHost = () => { try { return new URL(config.appUrl).hostname.toLowerCase(); } catch { return 'localhost'; } };
const serverIps = () => String(process.env.SERVER_IP || '').split(/[\s,]+/).filter((ip) => net.isIPv4(ip));

// ---------------------------------------------------------------- host names
/** "https://Book.MyClinic.com:443/x" → "book.myclinic.com" (IDN → punycode). Returns '' when unusable. */
function normalizeHost(raw) {
  let h = String(raw || '').trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d*$/, '').replace(/\.$/, '');
  if (!h) return '';
  const ascii = url.domainToASCII(h);
  return ascii || h;
}

const BLOCKED_SUFFIXES = ['localhost', 'local', 'internal', 'invalid', 'onion', 'arpa', 'home', 'lan', 'corp', 'intranet'];
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Validation message (English, translated in the view layer) or null when the host can be used. */
function validateHost(host) {
  if (!host) return 'Enter a domain like book.yourclinic.com.';
  if (host.length > 253 || host.includes('*') || net.isIP(host) || /^\[/.test(host)) return 'Enter a domain like book.yourclinic.com.';
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return 'Enter a domain like book.yourclinic.com.';
  const tld = labels[labels.length - 1];
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return 'Enter a domain like book.yourclinic.com.';
  if (BLOCKED_SUFFIXES.includes(tld)) return 'Use a public domain that your clinic owns.';
  const main = platformHost();
  if (host === main || host.endsWith(`.${main}`)) return 'Use a domain that your clinic owns, not the DocBook address.';
  return null;
}

/** The DNS records a clinic must add (settings page and platform admin). */
function records(row) {
  if (!row || !row.host) return null;
  return {
    host: row.host,
    txt: { name: `${TXT_PREFIX}.${row.host}`, value: txtValue(row.token || '') },
    cname: { name: row.host, value: platformHost() },
    serverIps: serverIps(), // for a bare domain (example.com) that cannot use CNAME
  };
}

const parse = (row) => (row ? { ...row, check: row.last_check ? (() => { try { return JSON.parse(row.last_check); } catch { return null; } })() : null } : null);

async function forClinic(businessId) {
  return parse(await knex('clinic_domains').where({ business_id: businessId }).first());
}

// ---------------------------------------------------------------- live hosts (used on every request)
/** Map host → { businessId, slug } of verified domains of active clinics with a public address. */
function liveHosts() {
  return cache.remember('domains:live', async () => {
    const rows = await knex('clinic_domains as d').join('businesses as b', 'b.id', 'd.business_id')
      .where({ 'd.status': 'verified', 'b.status': 'active' }).whereNotNull('b.slug')
      .select('d.host', 'd.business_id', 'b.slug');
    return new Map(rows.map((r) => [r.host, { businessId: r.business_id, slug: r.slug }]));
  }, 30_000);
}
const forget = () => cache.forgetPrefix('domains:');

/** The clinic whose verified domain this exact host is (null for the DocBook host and anything unknown). */
async function clinicForHost(rawHost) {
  const h = String(rawHost || '').toLowerCase().replace(/\.$/, '');
  if (!h || h === platformHost() || h === 'localhost' || net.isIP(h)) return null;
  return (await liveHosts()).get(h) || null;
}

// ---------------------------------------------------------------- clinic owner
async function save(ctx, raw) {
  const host = normalizeHost(raw);
  const problem = validateHost(host);
  if (problem) throw E.validation({ host: problem });
  const cur = await forClinic(ctx.businessId);
  if (cur && cur.status === 'suspended') throw new AppError('DOMAIN_SUSPENDED', 'The platform team stopped this domain. Contact support.', 409);
  if (cur && cur.host === host) return cur;
  const taken = await knex('clinic_domains').where({ host, status: 'verified' }).whereNot({ business_id: ctx.businessId }).first('id');
  if (taken) throw E.validation({ host: 'This domain is already connected to another clinic.' });
  const values = { host, status: 'pending', token: newToken(), checked_at: null, verified_at: null, last_check: null, created_by: ctx.userId || null, updated_at: new Date() };
  if (cur) await knex('clinic_domains').where({ id: cur.id }).update(values);
  else await knex('clinic_domains').insert({ business_id: ctx.businessId, ...values });
  forget();
  await audit.record(ctx, 'domain.saved', { entityType: 'clinic_domain', entityId: ctx.businessId, oldValues: cur ? { host: cur.host, status: cur.status } : null, newValues: { host, status: 'pending' } });
  return forClinic(ctx.businessId);
}

async function remove(ctx) {
  const cur = await forClinic(ctx.businessId);
  if (!cur) return false;
  if (cur.status === 'suspended') throw new AppError('DOMAIN_SUSPENDED', 'The platform team stopped this domain. Contact support.', 409);
  await knex('clinic_domains').where({ id: cur.id }).del();
  forget();
  await audit.record(ctx, 'domain.removed', { entityType: 'clinic_domain', entityId: ctx.businessId, oldValues: { host: cur.host, status: cur.status } });
  return true;
}

// ---------------------------------------------------------------- DNS
const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' })), ms);
  Promise.resolve(p).then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});
const safe = (p, ms = DNS_TIMEOUT_MS) => withTimeout(p, ms).then((v) => v, (e) => ({ error: e.code || 'ERROR' }));
const defaultResolver = () => new Resolver({ timeout: 3000, tries: 2 });

/** Looks the domain up in public DNS; returns what was found (never throws on DNS errors). */
async function inspect(row, resolver = defaultResolver(), { timeoutMs = DNS_TIMEOUT_MS } = {}) {
  const host = row.host;
  const main = platformHost();
  const ips = serverIps();
  const [txt, cname, a, platformA] = await Promise.all([
    safe(resolver.resolveTxt(`${TXT_PREFIX}.${host}`), timeoutMs), safe(resolver.resolveCname(host), timeoutMs), safe(resolver.resolve4(host), timeoutMs),
    ips.length ? Promise.resolve(ips) : safe(resolver.resolve4(main), timeoutMs),
  ]);
  const txtList = Array.isArray(txt) ? txt.map((parts) => (Array.isArray(parts) ? parts.join('') : String(parts))) : [];
  const cnames = Array.isArray(cname) ? cname.map((c) => String(c).toLowerCase().replace(/\.$/, '')) : [];
  const addrs = Array.isArray(a) ? a : [];
  const ours = Array.isArray(platformA) ? platformA : [];
  const owned = Boolean(row.token) && txtList.includes(txtValue(row.token));
  const pointed = cnames.includes(main) || (addrs.length > 0 && ours.length > 0 && addrs.every((ip) => ours.includes(ip)));
  return {
    owned, pointed, txt: txtList.slice(0, 5).map((v) => v.slice(0, 120)), cname: cnames.slice(0, 3), a: addrs.slice(0, 4),
    errors: { txt: txt && txt.error ? txt.error : null, cname: cname && cname.error ? cname.error : null, a: a && a.error ? a.error : null },
    at: new Date().toISOString(),
  };
}

/** Checks DNS now and turns the domain on when both records are right. */
async function check(ctx, businessId, { resolver, timeoutMs } = {}) {
  const row = await forClinic(businessId);
  if (!row) throw E.notFound('Domain');
  if (row.status === 'suspended') throw new AppError('DOMAIN_SUSPENDED', 'The platform team stopped this domain. Contact support.', 409);
  const result = await inspect(row, resolver, { timeoutMs });
  const values = { last_check: JSON.stringify(result), checked_at: new Date() };
  let live = row.status === 'verified';
  let conflict = false;
  if (!live && result.owned && result.pointed) {
    const other = await knex('clinic_domains').where({ host: row.host, status: 'verified' }).whereNot({ business_id: businessId }).first('id');
    if (other) conflict = true;
    else { Object.assign(values, { status: 'verified', verified_at: new Date() }); live = true; }
  }
  await knex('clinic_domains').where({ id: row.id }).update(values);
  forget();
  if (live && row.status !== 'verified') {
    await audit.record({ ...ctx, businessId }, 'domain.verified', { entityType: 'clinic_domain', entityId: businessId, newValues: { host: row.host } });
  } else {
    await audit.record({ ...ctx, businessId }, 'domain.checked', { entityType: 'clinic_domain', entityId: businessId, newValues: { host: row.host, owned: result.owned, pointed: result.pointed } });
  }
  return { ...result, live, conflict, justVerified: live && row.status !== 'verified' };
}

// ---------------------------------------------------------------- platform admin
async function list() {
  const rows = await knex('clinic_domains as d').join('businesses as b', 'b.id', 'd.business_id')
    .select('d.*', 'b.name as clinic_name', 'b.name_en as clinic_name_en', 'b.slug', 'b.status as clinic_status')
    .orderByRaw("FIELD(d.status, 'pending', 'verified', 'suspended')").orderBy('d.updated_at', 'desc');
  return rows.map((r) => ({ ...parse(r), records: records(r) }));
}

async function byId(id) {
  const row = parse(await knex('clinic_domains').where({ id }).first());
  if (!row) throw E.notFound('Domain');
  return row;
}

/** The platform admin stops a domain (it stops serving at once; the clinic cannot change it until resumed). */
async function suspend(ctx, id) {
  const row = await byId(id);
  await knex('clinic_domains').where({ id }).update({ status: 'suspended', updated_at: new Date() });
  forget();
  await audit.record(ctx, 'platform.domain_suspended', { entityType: 'clinic_domain', entityId: row.business_id, oldValues: { status: row.status }, newValues: { host: row.host, status: 'suspended' } });
}

/** Back to pending, then checked again: it goes live only if DNS still proves it. */
async function resume(ctx, id, opts = {}) {
  const row = await byId(id);
  if (row.status !== 'suspended') return null;
  await knex('clinic_domains').where({ id }).update({ status: 'pending', verified_at: null, updated_at: new Date() });
  forget();
  await audit.record(ctx, 'platform.domain_resumed', { entityType: 'clinic_domain', entityId: row.business_id, newValues: { host: row.host } });
  return check(ctx, row.business_id, opts);
}

/**
 * Turns a pending domain on without the pointing check (e.g. behind a proxy that hides the CNAME).
 * Ownership (the TXT record) must still have been proven by the last check.
 */
async function approve(ctx, id) {
  const row = await byId(id);
  if (row.status !== 'pending') return;
  if (!row.check || !row.check.owned) throw new AppError('DOMAIN_NOT_OWNED', 'The ownership TXT record has not been found yet. Check the domain first.', 409);
  const other = await knex('clinic_domains').where({ host: row.host, status: 'verified' }).whereNot({ id }).first('id');
  if (other) throw new AppError('DOMAIN_TAKEN', 'This domain is already connected to another clinic.', 409);
  await knex('clinic_domains').where({ id }).update({ status: 'verified', verified_at: new Date(), updated_at: new Date() });
  forget();
  await audit.record(ctx, 'platform.domain_approved', { entityType: 'clinic_domain', entityId: row.business_id, newValues: { host: row.host } });
}

module.exports = {
  TXT_PREFIX, txtValue, platformHost, normalizeHost, validateHost, records, forClinic, liveHosts, clinicForHost, forget,
  save, remove, inspect, check, list, byId, suspend, resume, approve,
};
