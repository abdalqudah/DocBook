// `node app.js check-secrets`: can this server read the credentials stored in the databases? Every encrypted value
// (columns named *_enc, and "v1:…" values inside platform_settings) in the main database and in each clinic's own
// database is decrypted with the current APP_KEY (or SESSION_SECRET). Run it after moving to a new server, before
// opening it to clinics: a failure means APP_KEY differs from the old server's, and those credentials (SMTP, WhatsApp,
// payment gateways, Google, external databases) would have to be entered again. Prints counts only, never values.
const { connect } = require('./connection');
const config = require('../config');
const secrets = require('../core/secrets');

const TOKEN = /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

async function scanDatabase(db, name) {
  const tally = { db: name, found: 0, ok: 0, failed: [] };
  const cols = await db('information_schema.columns').where('table_schema', name).andWhere('column_name', 'like', '%\\_enc')
    .select('table_name as t', 'column_name as c');
  for (const { t, c } of cols) { // eslint-disable-line no-restricted-syntax
    const rows = await db(t).whereNotNull(c).where(c, '<>', '').select(c).limit(100000); // eslint-disable-line no-await-in-loop
    rows.forEach((r) => {
      const v = String(r[c]);
      if (!TOKEN.test(v)) return;
      tally.found += 1;
      if (secrets.decrypt(v) !== null) tally.ok += 1; else tally.failed.push(`${t}.${c}`);
    });
  }
  if (await db.schema.hasTable('platform_settings')) {
    const rows = await db('platform_settings').select('key', 'value');
    rows.forEach((r) => {
      (String(r.value || '').match(/"v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+"/g) || []).forEach((q) => {
        tally.found += 1;
        if (secrets.decrypt(q.slice(1, -1)) !== null) tally.ok += 1; else tally.failed.push(`platform_settings[${r.key}]`);
      });
    });
  }
  return tally;
}

async function run() {
  const main = connect(config.db.database, { migrations: false });
  const results = [];
  try {
    results.push(await scanDatabase(main, config.db.database));
    const names = (await main('businesses').whereNotNull('db_name').where('db_name', '<>', '').distinct('db_name')).map((r) => r.db_name);
    for (const name of names) { // eslint-disable-line no-restricted-syntax
      const db = connect(name, { migrations: false });
      try { results.push(await scanDatabase(db, name)); } finally { await db.destroy(); } // eslint-disable-line no-await-in-loop
    }
  } finally { await main.destroy(); }
  let bad = 0;
  results.forEach((r) => {
    const where = [...new Set(r.failed)].slice(0, 8).join(', ');
    console.log(`${r.db}: ${r.found} encrypted value(s), ${r.ok} readable${r.failed.length ? `, ${r.failed.length} NOT readable (${where})` : ''}`); // eslint-disable-line no-console
    bad += r.failed.length;
  });
  console.log(bad ? 'FAILED: APP_KEY does not match the key these credentials were saved with.' : 'OK: every stored credential is readable with this APP_KEY.'); // eslint-disable-line no-console
  return bad ? 1 : 0;
}

module.exports = { run, scanDatabase };

if (require.main === module) run().then((code) => process.exit(code)).catch((e) => { console.error(e.message); process.exit(2); }); // eslint-disable-line no-console
