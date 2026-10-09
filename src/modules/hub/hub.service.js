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
}).orderBy('name').limit(200).select('id', 'name', 'name_en', 'specialty', 'city', 'phone', 'whatsapp', 'site_url', 'last_seen_at');

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
  let x; try { x = new URL(String(u || '').trim()); } catch { throw E.validation({ hub_url: 'Enter the platform address, e.g. https://docbook.app' }); }
  if (x.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && x.protocol === 'http:')) throw E.validation({ hub_url: 'The address must start with https://' });
  return x.origin;
};

async function call(c, path, { method = 'GET', body = null, binary = false } = {}) {
  const key = keyOf(c);
  if (!c.hub_url || !key) throw new AppError('HUB_NOT_LINKED', 'Not linked to the platform.', 409);
  const res = await fetch(`${c.hub_url}/hub/v1${path}`, {
    method, headers: { authorization: `Bearer ${key}`, accept: binary ? '*/*' : 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) throw new AppError('HUB_KEY_REFUSED', 'The platform refused the key.', 409);
  if (!res.ok) throw new AppError('HUB_ERROR', `The platform answered ${res.status}.`, 502);
  return binary ? { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') || '' } : res.json();
}

/** What the installation tells the platform about its clinic (the installation's clinic: its first active one). */
async function clinicCard() {
  const b = await knex('businesses').where({ status: 'active' }).orderBy('id').first('id', 'name', 'name_en', 'specialty', 'city', 'phone', 'whatsapp', 'slug');
  if (!b) return {};
  const site = process.env.APP_URL ? String(process.env.APP_URL).replace(/\/+$/, '') : null;
  return { name: b.name, name_en: b.name_en, specialty: b.specialty, city: b.city, phone: b.phone, whatsapp: b.whatsapp, site_url: site, version: require('../../../package.json').version }; // eslint-disable-line global-require
}

/** Settings: saves the platform's address and key after a successful hello. */
async function saveClient(ctx, { hubUrl, key, enabled = true }) {
  const cur = await client();
  const row = { id: 1, hub_url: hubBase(hubUrl), key_enc: String(key || '').trim() ? secrets.encrypt(String(key).trim()) : cur.key_enc, enabled: Boolean(enabled), updated_at: now() };
  if (!row.key_enc) throw E.validation({ key: 'Enter the link key the platform gave you.' });
  await call(row, '/hello', { method: 'POST', body: await clinicCard() }).catch((e) => { throw E.validation({ key: e.message }); });
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

/** The cached offers / ads, for the Marketplace and the dashboard. */
async function cached(kind) {
  const c = await client();
  if (!c.enabled) return [];
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

module.exports = {
  createLink, revokeLink, links, linkedClinics, linkOf, hello, offersFor, adsFor, imageOf,
  client, keyOf, saveClient, unlink, sync, cached, cachedOne, cachedImage, adClick, clinicCard,
};
