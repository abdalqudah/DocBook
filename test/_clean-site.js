// Shared by the short-address tests: a published website with pages "about" and "services", the doctors section on
// the home page and a menu link to it, booking on.
const os = require('os');
const path = require('path');
const fs = require('fs');
const knex = require('../src/db/knex');
const rbac = require('../src/modules/rbac/rbac.service');
const site = require('../src/modules/website/site.service');
const importer = require('../src/modules/website/import.service');
const { ZipFile } = require('../src/core/zipstream');

async function publishSite(businessId, userId, tag) {
  await knex('businesses').where({ id: businessId }).update({ booking_enabled: true, status: 'active' });
  const biz = await knex('businesses').where({ id: businessId }).first();
  const ctx = { businessId, userId, roleKey: 'owner', permissions: await rbac.getUserPermissions(businessId, userId), locale: 'ar', ip: '127.0.0.1' };
  const zipPath = path.join(os.tmpdir(), `clean-${tag}.zip`);
  const sec = (id, type, text) => ({ id, type, variant: type === 'doctors' ? 'cards' : 'plain', visible: true, content: { ar: { title: text, text }, en: { title: text, text } }, settings: {} });
  const z = await ZipFile.create(zipPath);
  await z.add('content.json', Buffer.from(JSON.stringify({
    format: 'clinic-site-content', version: 1,
    site: {
      pages: [
        { key: 'home', sections: [sec('a0c0000101', 'text', `home ${tag}`), sec('a0c0000102', 'doctors', 'الأطباء')] },
        { key: 'b0c0000001', slug: 'about', title: { ar: 'من نحن', en: 'About' }, menu: true, sections: [sec('a0c0000103', 'text', `about ${tag}`)] },
        { key: 'b0c0000002', slug: 'services', title: { ar: 'خدماتنا', en: 'Services' }, menu: true, sections: [sec('a0c0000104', 'text', `services ${tag}`)] },
      ],
      header: { items: [{ kind: 'home', label: { ar: 'الرئيسية', en: 'Home' } }, { kind: 'page', target: 'b0c0000001', label: { ar: 'من نحن', en: 'About' } },
        { kind: 'page', target: 'b0c0000002', label: { ar: 'خدماتنا', en: 'Services' } }, { kind: 'section', target: 'a0c0000102', label: { ar: 'الأطباء', en: 'Doctors' } },
        { kind: 'book', label: { ar: 'احجز', en: 'Book' } }] },
    },
  })));
  await z.close();
  await importer.run(ctx, biz, zipPath, {});
  fs.unlinkSync(zipPath);
  await site.publish(ctx, biz);
  site.forget(businessId);
  return biz;
}

module.exports = { publishSite };
