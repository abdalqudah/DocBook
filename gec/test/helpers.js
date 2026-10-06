// Test helpers: a fresh test database, an app instance, signed-in agents with CSRF tokens.
process.env.NODE_ENV = 'test';
const request = require('supertest');
const knex = require('../src/db/knex');
const { migrateLatest } = require('../src/db/migrate');
const bootstrap = require('../src/modules/bootstrap');
const { hashPassword } = require('../src/modules/auth/auth.service');
const email = require('../src/modules/comms/email');

let app;
const outbox = [];
email.useTestOutbox(outbox);
require('../src/modules/comms/sms').useTestOutbox(outbox);
require('../src/modules/comms/whatsapp').useTestOutbox(outbox);

async function resetDb() {
  await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
  const [tables] = await knex.raw('SHOW TABLES');
  for (const row of tables) await knex.schema.dropTableIfExists(Object.values(row)[0]); // eslint-disable-line no-await-in-loop
  await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
  await migrateLatest();
  require('../src/modules/settings/settings.service').clearCache(); // eslint-disable-line global-require
  await bootstrap.run();
}

async function getApp() {
  if (!app) app = require('../src/app').createApp(); // eslint-disable-line global-require
  return app;
}

/** Creates a staff member with a built-in role; returns { user, employee }. */
async function makeStaff({ email: addr, role = 'counsellor', name = 'Staff Member', password = 'Password123', branchId, isCounsellor } = {}) {
  const r = await knex('roles').where({ key: role }).first();
  const branch = branchId || (await knex('branches').orderBy('id').first()).id;
  const [userId] = await knex('users').insert({ kind: 'staff', email: addr || `${role}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@gec.test`, name, password_hash: await hashPassword(password), status: 'active' });
  const [empId] = await knex('employees').insert({ user_id: userId, role_id: r.id, branch_id: branch, is_counsellor: isCounsellor ?? role === 'counsellor' });
  return { user: await knex('users').where({ id: userId }).first(), employee: await knex('employees').where({ id: empId }).first(), password };
}

/** An agent (cookie jar) with the CSRF token of its session. */
async function agent() {
  const a = request.agent(await getApp());
  a.csrf = async () => {
    const res = await a.get('/staff/login');
    const m = /name="_csrf" value="([^"]+)"/.exec(res.text);
    return m ? m[1] : null;
  };
  return a;
}

async function staffAgent(staff) {
  const a = await agent();
  const token = await a.csrf();
  const res = await a.post('/staff/login').type('form').send({ _csrf: token, email: staff.user.email, password: staff.password });
  if (res.status !== 302) throw new Error(`login failed: ${res.status}`);
  a.token = async () => { const r = await a.get('/staff/account'); return /name="_csrf" value="([^"]+)"/.exec(r.text)[1]; };
  return a;
}

module.exports = { knex, resetDb, getApp, makeStaff, agent, staffAgent, outbox, request };
