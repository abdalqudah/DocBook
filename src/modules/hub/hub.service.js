// Linking a DocBook installed on a clinic's own server to the DocBook platform (the "hub").
//
// On the platform: the platform admin makes a link for each installation (Admin → Linked installations) and gives its
// key to the clinic; only the key's SHA-256 is kept. With that key the installation (api.web.js, /hub/v1):
//   • says hello — its clinic's public details (name, specialty, city, phones, site) — reps see the linked clinics;
//   • reads the reps' live offers and approved ads that reach its specialty and city (the same targeting as for a clinic
//     on the platform) with their images; ad clicks are counted.
// On the installation: Settings → DocBook platform keeps the platform's address and the key (encrypted). A sync (hourly,
// or "Sync now") says hello and caches the offers and ads (hub_cache) — the Marketplace and the dashboard show them.
const crypto = require('crypto');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { E, AppError } = require('../../core/errors');

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const now = () => new Date();
const json = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || d); } catch { return d; } };
const clip = (v, n) => (v === null || v === undefined ? null : String(v).trim().slice(0, n) || null);

// ================================================================= the platform side
async function createLink(ctx, label) {
  const key = `dbh_${crypto.randomBytes(24).toString('base64url')}`;
  const [id] = await knex('hub_links').insert({ label: clip(label, 120) || 'Installation', key_hash: sha(key), key_prefix: key.slice(0, 10), created_by: ctx.userId || null });
  await audit.record({ ...ctx, businessId: null }, 'hub.link_created', { entityType: 'hub_link', entityId: id, newValues: { label } });
  return { id, key };
}
async function revokeLink(ctx, id) {
  await knex('hub_links').where({ id: Number(id) || 0 }).update({ status: 'revoked', updated_at: now() });
  await audit.record({ ...ctx, businessId: null }, 'hub.link_revoked', { entityType: 'hub_link', entityId: Number(id) });
}
const links = () => knex('hub_links').orderBy('created_at', 'desc');
/** Linked clinics reps may see (active, said hello at least once). */
const linkedClinics = ({ specialty, q } = {}) => knex('hub_links').where({ status: 'active' }).whereNotNull('name').modify((x) => {
  if (specialty) x.where('specialty', specialty);
  if (q) x.where((w) => w.where('name', 'like', `%${q}%`).orWhere('name_en', 'like', `%${q}%`).orWhere('city', 'like', `%${q}%`));
}).orderBy('name').limit(200).select('id', 'name', 'name_en', 'specialty', 'city', 'phone', 'whatsapp', 'site_url', 'last_seen_at', knex.raw('callback_url IS NOT NULL AS bookable'));

/** The link of a key (Authorization: Bearer …), when active. */
async function linkOf(key) {
  const k = String(key || '').trim();
  if (!/^dbh_[A-Za-z0-9_-]{20,}$/.test(k)) return null;
  return knex('hub_links').where({ key_hash: sha(k), status: 'active' }).first();
}
async function hello(link, body = {}) {
  const row = {
    name: clip(body.name, 190), name_en: clip(body.name_en, 190), specialty: clip(body.specialty, 60), city: clip(body.city, 120), phone: clip(body.phone, 40),
    whatsapp: clip(body.whatsapp, 40), site_url: /^https?:\/\/[^\s<>"']+$/i.test(String(body.site_url || '')) ? clip(body.site_url, 300) : null, version: clip(body.version, 30),
    last_seen_at: now(), updated_at: now(),
  };
  // where the platform reaches the installation (doctors, free times, bookings of reps) and its secret for that
  const cb = body.callback || {};
  if (cb.url && /^https?:\/\/[^\s<>"']+$/i.test(String(cb.url)) && (String(cb.url).startsWith('https://') || process.env.NODE_ENV === 'test') && String(cb.secret || '').length >= 24) {
    row.callback_url = String(cb.url).replace(/\/+$/, '').slice(0, 300);
    row.callback_enc = secrets.encrypt(String(cb.secret));
  }
  await knex('hub_links').where({ id: link.id }).update(row);
  return { ok: true, link: link.label };
}
/** A virtual clinic of the link (its specialty and city) for the offers' / ads' targeting. */
const asBusiness = (link, q) => ({ id: 0, specialty: clip(q.specialty, 60) || link.specialty || null, city: clip(q.city, 120) || link.city || null, timezone: 'Asia/Amman' });
async function offersFor(link, q = {}) {
  const market = require('../marketplace/market.service'); // eslint-disable-line global-require
  const business = asBusiness(link, q);
  const today = require('../clinic/scheduling').clinicNow('Asia/Amman').date; // eslint-disable-line global-require
  const rows = await market.offers({ today, businessId: 0 }, business, {});
  return Promise.all(rows.slice(0, 100).map(async (o) => {
    const v = await market.vendorPublic(o.vendor_id);
    return {
      id: o.id, title: o.title, title_en: o.title_en, body: o.body, body_en: o.body_en, starts_on: o.starts_on, ends_on: o.ends_on, specialties: o.specialties || [],
      has_image: Boolean(o.image_mime), vendor: v ? { name: v.name, name_en: v.name_en, type: v.type, phone: v.phone, whatsapp: v.whatsapp, email: v.email, city: v.city } : { name: o.vendor_name, name_en: o.vendor_name_en, type: o.vendor_type },
    };
  }));
}
async function adsFor(link, q = {}) {
  const billing = require('../vendorbilling/billing.service'); // eslint-disable-line global-require
  const rows = await billing.adsFor(asBusiness(link, q), { limit: 10 });
  return rows.map((a) => ({ id: a.id, offer_id: a.offer_id, title: a.title, title_en: a.title_en, body: a.body, body_en: a.body_en, has_image: Boolean(a.image_mime), vendor: { name: a.vendor_name, name_en: a.vendor_name_en } }));
}
async function imageOf(kind, id) {
  if (kind === 'offer') return require('../marketplace/market.service').image('offer', id); // eslint-disable-line global-require
  const r = await require('../vendorbilling/billing.service').adImage(id); // eslint-disable-line global-require
  return r && r.image ? { data: r.image, mime: r.image_mime } : null;
}

// ================================================================= the installation side
async function client() {
  const row = await knex('hub_client').where({ id: 1 }).first().catch(() => null);
  return row || { id: 1, hub_url: null, key_enc: null, enabled: false };
}
const keyOf = (c) => { try { return c && c.key_enc ? secrets.decrypt(c.key_enc) : null; } catch { return null; } };
const hubBase = (u) => {
  let x; try { x = new URL(String(u || '').trim()); } catch { throw E.validation({ hub_url: 'Enter the platform address, e.g. https://medworks.app' }); }
  if (x.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && x.protocol === 'http:')) throw E.validation({ hub_url: 'The address must start with https://' });
  return x.origin;
};

/** The addresses a URL's name resolves to here (for the error message): "1.2.3.4, 2a02::1". */
async function addressesOf(url) {
  try { const list = await require('dns').promises.lookup(new URL(url).hostname, { all: true }); return list.map((x) => x.address).join(', '); } catch { return ''; } // eslint-disable-line global-require
}

/**
 * A request between the platform and an installation. It says who it is (hosting firewalls and bot protection often
 * drop requests with the bare "node" user agent, closing the connection without an answer), and is tried once more
 * when the connection was dropped before any answer (a sleeping app waking).
 */
const LINK_UA = `MedWorks-Link/${require('../../../package.json').version} (+https://medworks.app)`; // eslint-disable-line global-require
const DROPPED = /UND_ERR_SOCKET|ECONNRESET|UND_ERR_CLOSED|EPIPE|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/;
async function linkFetch(url, init, timeoutMs) {
  const headers = { 'user-agent': LINK_UA, ...init.headers };
  try { return await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) }); } catch (e) {
    const code = String((e && e.cause && e.cause.code) || '');
    if (!DROPPED.test(code)) throw e;
    await new Promise((r) => { setTimeout(r, 1500); });
    // Again over IPv4 only: a domain with an IPv6 record its server does not answer on fails here although browsers
    // (which fall back by themselves) open it fine.
    try { return await ipv4Fetch(url, { ...init, headers }, timeoutMs); } catch (e2) { e2.first = code; throw e2; }
  }
}

/** A small fetch over IPv4 (node:http / node:https, family 4) answering like fetch: status, ok, headers.get, json, arrayBuffer. */
function ipv4Fetch(url, { method = 'GET', headers = {}, body } = {}, timeoutMs = 15_000) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? require('https') : require('http'); // eslint-disable-line global-require
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) }, family: 4, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: { get: (k) => res.headers[String(k).toLowerCase()] || null },
          json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
        });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => reject(Object.assign(new TypeError('fetch failed'), { cause: err })));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Why the platform could not be reached ("fetch failed" says nothing): the address does not resolve, nothing answers,
 * its HTTPS certificate is not valid yet (e.g. AutoSSL not run), or it took too long.
 */
function unreachable(url, e, addrs = '') {
  const code = String((e && e.cause && (e.cause.code || e.cause.name)) || (e && e.name) || '') + (e && e.first && e.first !== String((e.cause && e.cause.code) || '') ? `, first ${e.first}` : '');
  const host = (() => { try { return new URL(url).host; } catch { return url; } })() + (addrs ? ` (${addrs})` : '');
  let why;
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) why = `${host} was not found (check the address and its DNS).`;
  else if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/.test(code)) why = `${host} refused the connection from this server — its firewall may block this server's address, or the name points to the wrong server [${code}].`;
  else if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) why = `${host} has no valid HTTPS certificate yet (run AutoSSL on the platform's server) [${code}].`;
  else if (/Timeout|Abort|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(code)) why = `${host} took too long to answer.`;
  else if (/UND_ERR_SOCKET|ECONNRESET|UND_ERR_CLOSED|EPIPE/.test(code)) why = `${host} closed the connection without answering — usually the hosting's firewall or bot protection (ask the host to allow this server's address) [${code}].`;
  else why = `${host} could not be reached${code ? ` [${code}]` : ''}.`;
  return new AppError('HUB_UNREACHABLE', `The platform could not be reached: ${why}`, 502);
}

async function call(c, path, { method = 'GET', body = null, binary = false } = {}) {
  const key = keyOf(c);
  if (!c.hub_url || !key) throw new AppError('HUB_NOT_LINKED', 'Not linked to the platform.', 409);
  const res = await linkFetch(`${c.hub_url}/hub/v1${path}`, {
    method, headers: { authorization: `Bearer ${key}`, accept: binary ? '*/*' : 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, 30_000).catch(async (e) => { throw unreachable(c.hub_url, e, await addressesOf(c.hub_url)); });
  if (res.status === 401) throw new AppError('HUB_KEY_REFUSED', 'The platform refused the key.', 409);
  // A web page instead of the platform's answer: the hosting's bot protection checking the "visitor", or a page in front
  // of the app (parking, setup) — never the link itself.
  const type = String(res.headers.get('content-type') || '');
  if (!binary && !/json/i.test(type)) {
    const text = await res.text().catch(() => '');
    const title = ((/<title[^>]*>([^<]{0,120})/i.exec(text) || [])[1] || '').trim();
    const host = (() => { try { return new URL(c.hub_url).host; } catch { return c.hub_url; } })();
    throw new AppError('HUB_NOT_API', `${host} answered with a web page instead of the platform link (HTTP ${res.status}${title ? `, “${title}”` : ''}). This is usually the hosting's bot protection (Imunify360 / LiteSpeed) checking the visitor: ask the host to allow this server's IP address for ${host}.`, 502);
  }
  if (!res.ok) throw new AppError('HUB_ERROR', `The platform answered ${res.status}.`, 502);
  return binary ? { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') || '' } : res.json();
}

/** The installation's clinic (its first active one). */
const ownClinic = () => knex('businesses').where({ status: 'active' }).orderBy('id').first('id', 'name', 'name_en', 'specialty', 'city', 'phone', 'whatsapp', 'slug', 'timezone');
/** What the installation tells the platform about its clinic, and where / how the platform reaches it back. */
async function clinicCard(c = null) {
  const b = await ownClinic();
  if (!b) return {};
  const cl = c || await client();
  const site = cl.callback_url || (process.env.APP_URL ? String(process.env.APP_URL).replace(/\/+$/, '') : null);
  let secret = null; try { secret = cl.callback_enc ? secrets.decrypt(cl.callback_enc) : null; } catch { secret = null; }
  return {
    name: b.name, name_en: b.name_en, specialty: b.specialty, city: b.city, phone: b.phone, whatsapp: b.whatsapp, site_url: site, version: require('../../../package.json').version, // eslint-disable-line global-require
    callback: site && secret ? { url: site, secret } : undefined,
  };
}

/** Settings: saves the platform's address and key after a successful hello. */
async function saveClient(ctx, { hubUrl, key, enabled = true, selfUrl = null }) {
  const cur = await client();
  const row = {
    id: 1, hub_url: hubBase(hubUrl), key_enc: String(key || '').trim() ? secrets.encrypt(String(key).trim()) : cur.key_enc, enabled: Boolean(enabled), updated_at: now(),
    callback_enc: cur.callback_enc || secrets.encrypt(crypto.randomBytes(32).toString('base64url')), // the platform's calls to this installation carry it
    callback_url: (process.env.APP_URL ? String(process.env.APP_URL).replace(/\/+$/, '') : null) || (selfUrl ? String(selfUrl).replace(/\/+$/, '') : null) || cur.callback_url || null,
  };
  if (!row.key_enc) throw E.validation({ key: 'Enter the link key the platform gave you.' });
  // The address and key are kept even when the platform cannot be reached yet (no need to paste them again); the link
  // is on only once the platform answered.
  try { await call(row, '/hello', { method: 'POST', body: await clinicCard(row) }); } catch (e) {
    const keep = { ...row, enabled: false };
    await knex('hub_client').insert(keep).onConflict('id').merge(keep);
    throw E.validation({ key: e.message });
  }
  await knex('hub_client').insert(row).onConflict('id').merge(row);
  await audit.record(ctx, 'hub.client_linked', { entityType: 'hub_client', entityId: 1, newValues: { hub_url: row.hub_url } });
  return sync();
}
async function unlink(ctx) {
  await knex('hub_client').where({ id: 1 }).update({ enabled: false, key_enc: null, updated_at: now() });
  await knex('hub_cache').del();
  await audit.record(ctx, 'hub.client_unlinked', { entityType: 'hub_client', entityId: 1 });
}

/** Hello + the offers and ads (with their images) → hub_cache (what is gone on the platform goes here too). */
async function sync() {
  const c = await client();
  if (!c.enabled || !c.hub_url || !c.key_enc) return null;
  try {
    const card = await clinicCard();
    await call(c, '/hello', { method: 'POST', body: card });
    const q = `?specialty=${encodeURIComponent(card.specialty || '')}&city=${encodeURIComponent(card.city || '')}`;
    const [offers, ads] = await Promise.all([call(c, `/offers${q}`), call(c, `/ads${q}`)]);
    for (const [kind, list] of [['offer', offers.offers || []], ['ad', ads.ads || []]]) { // eslint-disable-line no-restricted-syntax
      const keep = [];
      for (const it of list) { // eslint-disable-line no-restricted-syntax
        const id = Number(it.id) || 0;
        if (!id) continue; // eslint-disable-line no-continue
        keep.push(id);
        const have = await knex('hub_cache').where({ kind, remote_id: id }).first('id', 'image_mime'); // eslint-disable-line no-await-in-loop
        const img = it.has_image && !(have && have.image_mime) ? await call(c, `/${kind}s/${id}/image`, { binary: true }).catch(() => null) : null; // eslint-disable-line no-await-in-loop
        const row = { kind, remote_id: id, data: JSON.stringify(it), fetched_at: now(), ...(img && /^image\/(png|jpe?g|webp|gif)/.test(img.mime) ? { image: img.data, image_mime: img.mime.split(';')[0] } : {}) };
        await knex('hub_cache').insert(row).onConflict(['kind', 'remote_id']).merge(row); // eslint-disable-line no-await-in-loop
      }
      await knex('hub_cache').where({ kind }).modify((x) => { if (keep.length) x.whereNotIn('remote_id', keep); }).del(); // eslint-disable-line no-await-in-loop
    }
    await knex('hub_client').where({ id: 1 }).update({ last_sync_at: now(), last_error: null, offers: (offers.offers || []).length, ads: (ads.ads || []).length });
    return { offers: (offers.offers || []).length, ads: (ads.ads || []).length };
  } catch (e) {
    await knex('hub_client').where({ id: 1 }).update({ last_error: String(e.message || e.code).slice(0, 255) });
    throw e;
  }
}

/**
 * The platform's offers / ads, live: when the last sync is older than a few seconds a sync runs first (waited for up to
 * 4 s; one at a time) — a new offer or ad on the platform shows on the next page view. If the platform does not answer,
 * the last copy is shown.
 */
const FRESH_MS = 15_000;
let syncing = null;
async function fresh(c) {
  if (!c.enabled || !c.key_enc) return;
  if (c.last_sync_at && Date.now() - new Date(c.last_sync_at).getTime() < FRESH_MS) return;
  if (!syncing) syncing = sync().catch(() => null).finally(() => { syncing = null; });
  await Promise.race([syncing, new Promise((r) => { setTimeout(r, 4000).unref(); })]);
}
async function cached(kind, { live = true } = {}) {
  let c = await client();
  if (!c.enabled) return [];
  if (live) { await fresh(c); c = await client(); }
  const rows = await knex('hub_cache').where({ kind }).orderBy('remote_id', 'desc').select('remote_id', 'data', 'image_mime').catch(() => []);
  return rows.map((r) => ({ ...json(r.data, {}), remote_id: r.remote_id, hub: true, image_mime: r.image_mime }));
}
async function cachedOne(kind, remoteId) {
  const r = await knex('hub_cache').where({ kind, remote_id: Number(remoteId) || 0 }).first('remote_id', 'data', 'image_mime');
  return r ? { ...json(r.data, {}), remote_id: r.remote_id, hub: true, image_mime: r.image_mime } : null;
}
const cachedImage = (kind, remoteId) => knex('hub_cache').where({ kind, remote_id: Number(remoteId) || 0 }).whereNotNull('image').first('image as data', 'image_mime as mime');
/** An ad of the platform clicked here: counted on the platform (best effort). */
async function adClick(remoteId) { const c = await client(); return call(c, `/ads/${Number(remoteId) || 0}/click`, { method: 'POST', body: {} }).catch(() => null); }

// ================================================================= reps' visits at a linked clinic (live, both ways)
/** The platform calls the installation (its doctors, free times, a booking) with the secret it gave in its hello. */
async function remote(link, path, { method = 'GET', body = null } = {}) {
  const l = typeof link === 'object' ? link : await knex('hub_links').where({ id: Number(link) || 0, status: 'active' }).first();
  if (!l || !l.callback_url || !l.callback_enc) throw new AppError('HUB_CLINIC_UNREACHABLE', 'This clinic cannot take bookings from the platform yet.', 409);
  const res = await linkFetch(`${l.callback_url}/hub-in/v1${path}`, {
    method, headers: { authorization: `Bearer ${secrets.decrypt(l.callback_enc)}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, 15_000).catch(() => null);
  if (!res) throw new AppError('HUB_CLINIC_UNREACHABLE', 'The clinic\'s system does not answer now. Try again later.', 502);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(out.code || 'HUB_CLINIC_ERROR', out.message || `The clinic answered ${res.status}.`, res.status === 404 ? 404 : 422, out.details);
  return out;
}
const linkFor = (id) => knex('hub_links').where({ id: Number(id) || 0, status: 'active' }).whereNotNull('callback_url').first();
async function repClinic(linkId) { const l = await linkFor(linkId); if (!l) throw E.notFound('Clinic'); return { link: l, clinic: await remote(l, '/rep/clinic') }; }
async function repSlots(linkId, doctorId, date) { const l = await linkFor(linkId); if (!l) throw E.notFound('Clinic'); return (await remote(l, `/rep/slots?doctor_id=${Number(doctorId) || ''}&date=${encodeURIComponent(date || '')}`)).slots || []; }
/** A rep books at a linked clinic: the installation keeps the visit; the platform keeps the rep's copy. */
async function repBook(vctx, vendor, linkId, input) {
  if (!vendor || vendor.status !== 'active') throw new AppError('VENDOR_NOT_ACTIVE', 'Your account is waiting for approval.', 403);
  await require('../vendorbilling/billing.service').assertCan(vendor.id, 'request'); // eslint-disable-line global-require
  const l = await linkFor(linkId);
  if (!l) throw E.notFound('Clinic');
  const v = await knex('vendors').where({ id: vendor.id }).first('id', 'type', 'name', 'name_en', 'phone', 'whatsapp', 'email', 'city');
  const r = await remote(l, '/rep/book', { method: 'POST', body: { vendor: { hub_id: v.id, type: v.type, name: v.name, name_en: v.name_en, phone: v.phone, whatsapp: v.whatsapp, email: v.email, city: v.city }, rep_name: vctx.userName || null, ...input } });
  await knex('hub_visits').insert({ link_id: l.id, vendor_id: vendor.id, user_id: vctx.userId || null, remote_id: Number(r.id), doctor_name: clip(r.doctor_name, 190), visit_date: r.visit_date, visit_time: r.visit_time, purpose: clip(input.purpose, 500), status: r.status || 'requested' })
    .onConflict(['link_id', 'remote_id']).merge();
  await audit.record({ businessId: null, userId: vctx.userId || null }, 'hub.rep_visit_booked', { entityType: 'hub_link', entityId: l.id, newValues: { vendor_id: vendor.id, remote_id: r.id, status: r.status } });
  return r;
}
async function repCancel(vctx, id) {
  const hv = await knex('hub_visits').where({ id: Number(id) || 0, vendor_id: vctx.vendorId }).first();
  if (!hv) throw E.notFound('Visit');
  if (!['requested', 'confirmed'].includes(hv.status)) throw new AppError('REP_VISIT_STATE', 'This visit can no longer be changed.', 409);
  await remote(hv.link_id, '/rep/cancel', { method: 'POST', body: { id: hv.remote_id, hub_vendor_id: hv.vendor_id } });
  await knex('hub_visits').where({ id: hv.id }).update({ status: 'cancelled', updated_at: now() });
}
/** The installation tells the platform its decision on a rep's visit → the rep's copy, and a notice to the rep. */
async function visitStatus(link, body = {}) {
  const status = ['requested', 'confirmed', 'declined', 'cancelled', 'done'].includes(body.status) ? body.status : null;
  const hv = await knex('hub_visits').where({ link_id: link.id, remote_id: Number(body.id) || 0 }).first();
  if (!hv || !status) return { ok: false };
  await knex('hub_visits').where({ id: hv.id }).update({ status, clinic_note: clip(body.note, 500), updated_at: now() });
  if (['confirmed', 'declined', 'cancelled'].includes(status) && status !== hv.status) {
    await require('../platformnotify/notify.service').vendor(hv.vendor_id, `visit_${status}`, { clinic: link.name || link.label, date: hv.visit_date, time: hv.visit_time, note: body.note || '' }, { link: '/vendor/visits', severity: status === 'confirmed' ? 'success' : 'warning' }).catch(() => {}); // eslint-disable-line global-require
  }
  return { ok: true };
}
/** A rep's visits at linked clinics (for their visits list). */
const vendorHubVisits = (vendorId) => knex('hub_visits as h').join('hub_links as l', 'l.id', 'h.link_id').where('h.vendor_id', vendorId)
  .orderBy('h.visit_date', 'desc').limit(200).select('h.*', 'l.name as clinic_name', 'l.name_en as clinic_name_en', 'l.city as clinic_city', 'l.phone as clinic_phone');

/** Installation: a decision on a visit booked from the platform → told to the platform (best effort). */
async function visitChanged(visitId, status, note) {
  const v = await knex('rep_visits as r').join('vendors as v', 'v.id', 'r.vendor_id').where('r.id', Number(visitId) || 0).whereNotNull('v.hub_vendor_id').first('r.id');
  if (!v) return null;
  const c = await client();
  return call(c, '/visits/status', { method: 'POST', body: { id: v.id, status, note: note || null } }).catch(() => null);
}

module.exports = { unreachable, linkFetch, ipv4Fetch,
  ownClinic, remote, repClinic, repSlots, repBook, repCancel, visitStatus, vendorHubVisits, visitChanged, fresh,
  createLink, revokeLink, links, linkedClinics, linkOf, hello, offersFor, adsFor, imageOf,
  client, keyOf, saveClient, unlink, sync, cached, cachedOne, cachedImage, adClick, clinicCard,
};
