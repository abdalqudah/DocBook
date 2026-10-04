// Entry point of the bundled build: `node app.js` starts the server, `node app.js migrate` only runs migrations,
// `node app.js check-images` checks that uploaded photos can be compressed to WebP on this host.
if (process.argv[2] === 'migrate') require('./migrate');
else if (process.argv[2] === 'check-images') require('../src/core/imageopt').selfCheck().then((r) => { console.log(r.ok ? `images: OK — ${r.detail}` : `images: FAILED — ${r.detail}`); process.exit(r.ok ? 0 : 1); });
else require('../src/server').run();
