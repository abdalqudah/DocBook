// Copies images that content still loads from other websites into the media library and points the content at the
// copies (same as Website → Media library → "Copy into the library"). Run on a server with internet access:
//   npm run images:import
const knex = require('../src/db/knex');
const media = require('../src/modules/cms/media.service');

(async () => {
  const before = await media.externalImages();
  console.log(`${before.length} external image references found.`); // eslint-disable-line no-console
  const r = await media.importExternal({ userId: null, ip: null, actor: 'cli' });
  console.log(`Copied ${r.imported} images, updated ${r.rows} records, ${r.failed.length} failed.`); // eslint-disable-line no-console
  r.failed.forEach((f) => console.log(`  failed: ${f.url} — ${f.error}`)); // eslint-disable-line no-console
  await knex.destroy();
  process.exit(r.failed.length ? 2 : 0);
})().catch(async (e) => { console.error(e); await knex.destroy(); process.exit(1); }); // eslint-disable-line no-console
