// CRM → find clinics on Google, against a fake Places API and fake clinic websites: the key is stored encrypted, a
// search brings in places (name, phone, website, the e-mail read from the site), a later run flags a place that was
// not there before as new on Google (and notifies the admin), and places are added to the CRM or ignored.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const leads = require('../src/modules/crm/leads.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = (k) => `plead-${k}-${tag}@t.test`;
const KEY = `AIzaTest${tag}abcdefghijklmnop`;
let app; let saved; let places; const calls = [];

const place = (n, extra = {}) => ({
  id: `place-${tag}-${n}`, displayName: { text: `Smile Clinic ${n} ${tag}` }, formattedAddress: `Street ${n}, Amman`,
  addressComponents: [{ types: ['locality'], longText: 'Amman', shortText: 'Amman' }, { types: ['country'], longText: 'Jordan', shortText: 'JO' }],
  internationalPhoneNumber: `+962 6 555 ${String(1000 + n)}`, websiteUri: `https://smile${n}-${tag}.example.org/`, googleMapsUri: `https://maps.google.com/?cid=${n}`,
  rating: 4.5, userRatingCount: n === 3 ? 0 : 20, businessStatus: 'OPERATIONAL', ...extra,
});

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  saved = await knex('platform_settings').where({ key: 'crm_google' }).first();
  await knex('platform_settings').where({ key: 'crm_google' }).del();
  await knex('crm_lead_searches').del();
  await knex('crm_contacts').where('name', 'like', 'Smile Clinic %').orWhere('name', 'like', 'Known%').del(); // left by an earlier run
  const admin = await knex.transaction((trx) => auth.createUser(trx, { name: 'Lead Admin', email: mail('a'), password: 'Passw0rd!x' }));
  await knex('users').where({ id: admin }).update({ is_platform_admin: true, email_verified_at: new Date() });
  places = [place(1), place(2)];
  leads.setTransport(async (url, opts) => {
    calls.push({ url, opts });
    if (url.startsWith('https://places.googleapis.com/')) {
      if (opts.headers['x-goog-api-key'] !== KEY) return { status: 403, body: JSON.stringify({ error: { message: 'API key not valid.' } }) };
      return { status: 200, body: JSON.stringify({ places }) };
    }
    if (url.startsWith('https://nominatim.openstreetmap.org/')) {
      calls.push({ osm: 'geo', url });
      return { status: 200, body: JSON.stringify(url.includes('Nowhere') ? [] : [{ boundingbox: ['31.85', '32.05', '35.80', '36.00'] }]) };
    }
    if (url.startsWith('https://overpass-api.de/')) {
      const q = decodeURIComponent(String(opts.body).replace(/^data=/, ''));
      calls.push({ osm: 'overpass', q });
      return { status: 200, body: JSON.stringify({ elements: [
        { type: 'node', id: 9001, lat: 31.95, lon: 35.91, tags: { amenity: 'dentist', name: `OSM Dental ${tag}`, 'name:ar': `عيادة أسنان الخريطة ${tag}`, phone: '+962 6 555 9001;+962 79 000 0000', website: 'https://osm-dental.example.org', email: 'Hello@osm-dental.example.org', 'addr:street': 'Rainbow St', 'addr:city': 'Amman' } },
        { type: 'way', id: 9002, center: { lat: 31.96, lon: 35.92 }, tags: { amenity: 'dentist', name: `OSM Smile ${tag}` } },
        { type: 'node', id: 9003, lat: 31.9, lon: 35.9, tags: { amenity: 'dentist' } },
      ] }) };
    }
    if (url.includes('smile1-')) return { status: 200, body: '<a href="mailto:info@smile1-x.test">mail</a> <a href="mailto:hello@' + new URL(url).hostname + '">us</a>' };
    if (url.includes('smile2-') && url.endsWith('/contact')) return { status: 200, body: 'Write to reception [at] ' + new URL(url).hostname };
    if (url.includes('smile2-')) return { status: 200, body: '<a href="/contact">Contact us</a> logo@2x.png' };
    return { status: 404, body: '' };
  });
  app = await serve();
});
test.after(async () => {
  leads.setTransport(null);
  await knex('crm_leads').where('place_id', 'like', `place-${tag}-%`).orWhere('place_id', 'like', 'osm:%900%').orWhere('name', 'like', `%${tag}%`).del();
  await knex('crm_lead_searches').del();
  await knex('platform_settings').where({ key: 'crm_google' }).del();
  if (saved) await knex('platform_settings').insert(saved);
  await app.close(); await knex.destroy();
});

test('e-mails are read from a page: mailto, the site\'s own domain first, "[at]" written out, no image names', () => {
  assert.deepEqual(leads.emailsIn('<a href="mailto:A@x.com">a</a> icon@2x.png'), ['a@x.com']);
  assert.deepEqual(leads.emailsIn('write to b [at] y.org'), ['b@y.org']);
});

test('the key is saved encrypted; a search brings in the places with their e-mails; a second run flags a new clinic', async () => {
  const a = app.agent(); await a.login(mail('a'));
  let page = await a.get('/admin/crm/finder?lang=en');
  assert.equal(page.status, 200);
  assert.match(page.text, /Optional: a Places API key/);
  await a.post('/admin/crm/finder/settings', { _csrf: a.csrf(page.text), api_key: KEY, emails: '1' });
  const row = await knex('platform_settings').where({ key: 'crm_google' }).first();
  assert.ok(!row.value.includes(KEY), 'the key is not stored in clear');
  page = await a.get('/admin/crm/finder?lang=en');
  const r = await a.post('/admin/crm/finder/searches', { _csrf: a.csrf(page.text), query: 'dental clinic', city: 'Amman', country: 'JO', auto: '1' });
  assert.equal(r.status, 302);
  const g = calls.find((c) => c.url.startsWith('https://places'));
  assert.equal(JSON.parse(g.opts.body).textQuery, 'dental clinic Amman');
  assert.equal(JSON.parse(g.opts.body).regionCode, 'JO');
  const one = await knex('crm_leads').where({ place_id: `place-${tag}-1` }).first();
  assert.equal(one.city, 'Amman'); assert.equal(one.country, 'JO'); assert.equal(one.phone, '+962 6 555 1001');
  assert.equal(one.email, `hello@smile1-${tag}.example.org`); // the site's own domain first
  assert.equal((await knex('crm_leads').where({ place_id: `place-${tag}-2` }).first()).email, `reception@smile2-${tag}.example.org`);
  assert.equal(one.is_new_place, 0);

  places = [place(1), place(2), place(3)];
  const s = await knex('crm_lead_searches').first('id');
  page = await a.get('/admin/crm/finder?lang=en');
  await a.post(`/admin/crm/finder/searches/${s.id}/run`, { _csrf: a.csrf(page.text) });
  const three = await knex('crm_leads').where({ place_id: `place-${tag}-3` }).first();
  assert.equal(three.is_new_place, 1);
  assert.ok(await knex('platform_notifications').where({ kind: 'crm_new_places' }).orderBy('id', 'desc').first());
  const fresh = await a.get('/admin/crm/finder?lang=en&fresh=1');
  assert.match(fresh.text, new RegExp(`Smile Clinic 3 ${tag}</span> <span class="badge badge-success">New on Google`));
  assert.doesNotMatch(fresh.text, new RegExp(`Smile Clinic 1 ${tag}`));
});

test('places are added to the CRM as prospects (an existing contact with the same phone is reused) or ignored', async () => {
  const a = app.agent(); await a.login(mail('a'));
  const [cid] = await knex('crm_contacts').insert({ kind: 'prospect', name: `Known ${tag}`, phone: '06 555-1002', stage: 'contacted' });
  const ids = await knex('crm_leads').where('place_id', 'like', `place-${tag}-%`).orderBy('place_id').pluck('id');
  const page = await a.get('/admin/crm/finder?lang=en');
  await a.post('/admin/crm/finder/leads', new URLSearchParams([['_csrf', a.csrf(page.text)], ['do', 'add'], ['lead', String(ids[0])], ['lead', String(ids[1])]]));
  const one = await knex('crm_leads').where({ id: ids[0] }).first();
  assert.equal(one.status, 'added');
  const c = await knex('crm_contacts').where({ id: one.contact_id }).first();
  assert.equal(c.source, 'google'); assert.equal(c.kind, 'prospect'); assert.equal(c.email, `hello@smile1-${tag}.example.org`);
  assert.equal((await knex('crm_leads').where({ id: ids[1] }).first()).contact_id, cid);
  await a.post('/admin/crm/finder/leads', { _csrf: a.csrf(page.text), do: 'ignore', lead: String(ids[2]) });
  assert.equal((await knex('crm_leads').where({ id: ids[2] }).first()).status, 'ignored');
  await knex('crm_contacts').whereIn('id', [cid, one.contact_id]).del();
});

test('a wrong key: the error is shown on the search, nothing breaks', async () => {
  await leads.saveSettings({ userId: null }, { api_key: 'AIzaWrongKey1234567890abc', emails: '1' });
  const s = await knex('crm_lead_searches').first('id');
  await assert.rejects(leads.run({ userId: null }, s.id));
  assert.match((await knex('crm_lead_searches').where({ id: s.id }).first()).last_error, /API key not valid/);
});

test('the finder has its own entry in the admin sidebar', async () => {
  const a = app.agent(); await a.login(mail('a'));
  const page = await a.get('/admin?lang=en');
  assert.match(page.text, /href="\/admin\/crm\/finder"/);
});

test('the free map (OpenStreetMap): no key needed, the city is required, dental searches only dentists', async () => {
  const a = app.agent(); await a.login(mail('a'));
  let page = await a.get('/admin/crm/finder?lang=en');
  assert.match(page.text, /name="source" value="osm"/);
  await a.post('/admin/crm/finder/searches', { _csrf: a.csrf(page.text), source: 'osm', query: 'عيادة أسنان', city: '', country: 'JO' });
  assert.equal(await knex('crm_lead_searches').where({ source: 'osm' }).first(), undefined, 'no city, no search');
  page = await a.get('/admin/crm/finder?lang=en');
  await a.post('/admin/crm/finder/searches', { _csrf: a.csrf(page.text), source: 'osm', query: 'عيادة أسنان', city: 'Amman', country: 'JO', auto: '1' });
  const q = calls.filter((c) => c.osm === 'overpass').pop().q;
  assert.match(q, /"amenity"="dentist"/); assert.doesNotMatch(q, /doctors/);
  assert.match(q, /\(31\.85,35\.8,32\.05,36\)/);
  const one = await knex('crm_leads').where({ place_id: 'osm:node/9001' }).first();
  assert.equal(one.name, `OSM Dental ${tag}`, "the English name on an English page (the Arabic one on an Arabic page)");
  assert.equal(one.phone, '+962 6 555 9001'); assert.equal(one.email, 'hello@osm-dental.example.org');
  assert.equal(one.address, 'Rainbow St، Amman'); assert.equal(one.maps_url, 'https://www.openstreetmap.org/node/9001');
  assert.equal(Number((await knex('crm_leads').where({ place_id: 'osm:way/9002' }).first()).lat), 31.96);
  assert.equal(await knex('crm_leads').where({ place_id: 'osm:node/9003' }).first(), undefined, 'a place without a name is left out');
  // runs daily without a Google key too
  await knex('platform_settings').where({ key: 'crm_google' }).del();
  await knex('crm_lead_searches').where({ source: 'osm' }).update({ last_run_at: new Date(Date.now() - 2 * 86_400_000) });
  const before = calls.length;
  assert.equal((await leads.runDue()).ran, 1);
  assert.ok(calls.slice(before).some((c) => c.osm === 'overpass'));
  // added to the CRM, its source "other"
  const lead = await knex('crm_leads').where({ place_id: 'osm:node/9001' }).first('id');
  page = await a.get('/admin/crm/finder?lang=en');
  await a.post('/admin/crm/finder/leads', new URLSearchParams([['_csrf', a.csrf(page.text)], ['do', 'add'], ['lead', String(lead.id)]]));
  const c = await knex('crm_contacts').where({ email: 'hello@osm-dental.example.org' }).first();
  assert.equal(c.source, 'other');
  await knex('crm_contacts').where({ id: c.id }).del();
});

test('a CSV list (the Google Maps collector\'s file): read with its columns, an address already known is updated', async () => {
  const a = app.agent(); await a.login(mail('a'));
  const csv = `\uFEFFname,phone,website,email,address,category,rating,reviews,maps_url,place_id,query\r\n`
    + `"Collector Clinic, ${tag}",+962 6 555 7001,https://cc-${tag}.example.org/,,"Street 1, Amman",Dentist,4.7,"1,203",https://www.google.com/maps/place/x,ChIJcollector${tag}AAAA,dental Amman\r\n`
    + `Second Clinic ${tag},,,info@second-${tag}.example.org,,,,,,,dental Amman\r\n,,,,,,,,,,\r\n`;
  let page = await a.get('/admin/crm/finder?lang=en');
  assert.match(page.text, /href="\/admin\/crm\/finder\/collector"/);
  const bad = await a.upload('/admin/crm/finder', '/admin/crm/finder/import', {}, { file: { buffer: Buffer.from('phone\n123\n'), name: 'x.csv' } });
  assert.equal(bad.status, 302);
  assert.equal(await knex('crm_lead_searches').where({ source: 'import' }).first(), undefined, 'no name column, nothing kept');
  const r = await a.upload('/admin/crm/finder', '/admin/crm/finder/import', { city: 'Amman', country: 'JO' }, { file: { buffer: Buffer.from(csv), name: 'google-maps.csv' } });
  assert.equal(r.status, 302); assert.match(r.location, /\/admin\/crm\/finder\?search=\d+/);
  const s = await knex('crm_lead_searches').where({ source: 'import' }).first();
  assert.equal(s.query, 'dental Amman'); assert.equal(s.auto, 0);
  const one = await knex('crm_leads').where({ place_id: `ChIJcollector${tag}AAAA` }).first();
  assert.equal(one.name, `Collector Clinic, ${tag}`); assert.equal(one.reviews, 1203); assert.equal(Number(one.rating), 4.7);
  assert.equal(one.city, 'Amman'); assert.equal(one.country, 'JO'); assert.equal(one.category, 'Dentist'); assert.equal(one.address, 'Street 1, Amman');
  const two = await knex('crm_leads').where({ search_id: s.id }).where('name', 'like', 'Second Clinic%').first();
  assert.match(two.place_id, /^imp:[0-9a-f]{40}$/); assert.equal(two.email, `info@second-${tag}.example.org`);
  // the same file again: nothing new, the place updated
  page = await a.get('/admin/crm/finder?lang=en');
  await a.upload('/admin/crm/finder', '/admin/crm/finder/import', {}, { file: { buffer: Buffer.from(csv.replace('4.7', '4.8')), name: 'again.csv' } });
  assert.equal((await knex('crm_leads').where({ place_id: `ChIJcollector${tag}AAAA` })).length, 1);
  assert.equal(Number((await knex('crm_leads').where({ place_id: `ChIJcollector${tag}AAAA` }).first()).rating), 4.8);
  // an uploaded list is not searched again
  page = await a.get(`/admin/crm/finder?search=${s.id}&lang=en`);
  assert.doesNotMatch(page.text, new RegExp(`/admin/crm/finder/searches/${s.id}/run`));
  const col = await a.get('/admin/crm/finder/collector?lang=en');
  assert.equal(col.status, 200); assert.match(col.text, /href="javascript:/); assert.match(col.text, /Collect clinics/);
});
