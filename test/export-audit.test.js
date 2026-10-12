// Exporting a list (patients CSV / Excel) writes a "data.list_exported" row to the clinic's audit log: which list, how
// many rows and the format, never the contents.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const cache = require('../src/core/cache');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const { serve } = require('./_http');

const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const mail = `expaudit-${tag}@t.test`;
let app; let businessId;

test.before(async () => {
  await knex.migrate.latest();
  cache.forgetPrefix('');
  const ownerId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Export Owner', email: mail, password: 'Passw0rd!x' });
    await businesses.create(id, { name: `Export ${tag}`, currency: 'JOD', timezone: 'Asia/Amman' }, trx);
    return id;
  });
  ({ last_business_id: businessId } = await knex('users').where({ id: ownerId }).first('last_business_id'));
  await knex('users').where({ id: ownerId }).update({ email_verified_at: new Date() });
  await knex('businesses').where({ id: businessId }).update({ onboarding_completed_at: new Date() });
  await knex('patients').insert({ business_id: businessId, full_name: `Patient ${tag}`, phone: '0794444444' });
  app = await serve();
});
test.after(async () => { if (app) await app.close(); await knex.destroy(); });

test('a patients list export is audited (rows and format, no contents)', async () => {
  const owner = app.agent(); await owner.login(mail);
  const r = await owner.get('/app/patients/export?lang=en');
  assert.equal(r.status, 200);
  let row;
  for (let i = 0; i < 20 && !row; i += 1) { // the audit row is written without holding up the download
    row = await knex('audit_logs').where({ business_id: businessId, action: 'data.list_exported' }).first(); // eslint-disable-line no-await-in-loop
    if (!row) await new Promise((ok) => { setTimeout(ok, 50); }); // eslint-disable-line no-await-in-loop
  }
  assert.ok(row, 'audit row written');
  const v = typeof row.new_values === 'string' ? JSON.parse(row.new_values) : row.new_values;
  assert.equal(v.rows, 1);
  assert.equal(v.format, 'csv');
  assert.equal(v.path, '/app/patients/export');
  assert.ok(!JSON.stringify(v).includes(`Patient ${tag}`), 'no patient data in the audit row');
});
