// Entry point of the bundled build: `node app.js` starts the server, `node app.js migrate` only runs migrations.
if (process.argv[2] === 'migrate') require('./migrate');
else require('../src/server').run();
