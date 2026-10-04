// Website content import on a medical centre's website: the pages go into the centre's draft, each doctor of the
// package is updated in the clinic they work at (with the photo in that clinic's library), no doctor or service is
// created in the centre's administration account.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const tenant = require('../src/db/tenant');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const centers = require('../src/modules/center/center.service');
const rbac = require('../src/modules/rbac/rbac.service');
const scheduling = require('../src/modules/clinic/scheduling');
const site = require('../src/modules/website/site.service');
const importer = require('../src/modules/website/import.service');
const { ZipFile } = require('../src/core/zipstream');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');
let ctx; let adminBiz; let practice; let docId; let zipPath;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const uid = await knex.transaction((trx) => auth.createUser(trx, { name: 'Centre owner', email: `ci-${tag}@t.test`, password: 'Passw0rd!x' }));
  const adminId = await knex.transaction(async (trx) => {
    const id = await businesses.create(uid, { name: 'مركز التجربة', currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    await centers.create({ businessId: id, userId: uid }, { name: 'مركز التجربة' }, trx);
    await trx('businesses').where({ id }).update({ kind: 'center_admin', onboarding_completed_at: new Date(), status: 'active', slug: `ci-c-${tag}`.slice(0, 40) });
    return id;
  });
  const center = await knex('businesses').where({ id: adminId }).first('center_id');
  const pid = await knex.transaction((trx) => businesses.create(uid, { name: 'عيادة د. منصور', currency: 'JOD', timezone: 'Asia/Amman' }, trx));
  await knex('businesses').where({ id: pid }).update({ center_id: center.center_id, center_joined_at: new Date(), status: 'active', slug: `ci-p-${tag}`.slice(0, 40), onboarding_completed_at: new Date() });
  practice = pid;
  await tenant.runFor(pid, async () => {
    [docId] = await knex('doctors').insert({ business_id: pid, full_name: 'Dr.Mansour Alqudah', is_active: true, working_hours: JSON.stringify(scheduling.defaultWorkingHours()) });
  });
  adminBiz = await knex('businesses').where({ id: adminId }).first();
  ctx = { businessId: adminId, userId: uid, roleKey: 'owner', permissions: await rbac.getUserPermissions(adminId, uid), locale: 'ar', ip: '127.0.0.1' };
  zipPath = path.join(os.tmpdir(), `ci-${tag}.zip`);
  const z = await ZipFile.create(zipPath);
  await z.add('content.json', Buffer.from(JSON.stringify({
    format: 'clinic-site-content', version: 1, media: { 'dr-m': { file: 'images/dr-m.png' } },
    doctors: [{ names: ['Mansour AlQudah'], full_name: 'د. منصور القضاة', full_name_en: 'Dr. Mansour AlQudah', bio: 'نبذة', photo: 'dr-m' }, { names: ['Nobody Here'], full_name: 'د. غير موجود', create: true }],
    services: [{ name: 'زراعة', items: [{ name: 'زراعة سن' }] }],
    site: { pages: [{ key: 'home', sections: [{ id: 'a0c0000099', type: 'text', variant: 'plain', content: { ar: { text: `المركز ${tag}` }, en: {} }, settings: {} }] }] },
  })));
  await z.add('images/dr-m.png', PNG);
  await z.close();
});
test.after(async () => { try { fs.unlinkSync(zipPath); } catch { /* gone */ } await knex.destroy(); });

test('centre import: doctors updated in their own clinic, nothing created in the centre account', async () => {
  const r = await importer.run(ctx, adminBiz, zipPath, {});
  assert.deepEqual(r.updated, ['Dr. Mansour AlQudah']);
  assert.deepEqual(r.created, []);
  assert.equal(r.services, 0);
  assert.equal(await knex('doctors').where({ business_id: ctx.businessId }).count({ n: '*' }).then((x) => Number(x[0].n)), 0, 'no doctor in the centre account');
  assert.equal(await knex('services').where({ business_id: ctx.businessId }).count({ n: '*' }).then((x) => Number(x[0].n)), 0);
  await tenant.runFor(practice, async () => {
    const d = await knex('doctors').where({ business_id: practice, id: docId }).first();
    assert.equal(d.full_name, 'د. منصور القضاة');
    assert.equal(d.bio, 'نبذة');
    assert.ok(d.photo_media_id);
    const m = await knex('clinic_media').where({ id: d.photo_media_id }).first('business_id', 'is_public');
    assert.equal(m.business_id, practice, 'the photo is in the clinic\'s own library');
  });
  const { doc } = await site.draft(ctx, adminBiz);
  assert.match(JSON.stringify(doc.pages[0].sections), new RegExp(`المركز ${tag}`));
});
