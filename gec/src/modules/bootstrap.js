// Start-up tasks: built-in roles, the first administrator (from ADMIN_EMAIL / ADMIN_PASSWORD) and a first branch.
const knex = require('../db/knex');
const config = require('../config');
const { syncSystemRoles } = require('./rbac/rbac.service');
const { hashPassword } = require('./auth/auth.service');

async function ensureAdmin() {
  const { email, password, name } = config.bootstrapAdmin;
  if (!email) return;
  const existing = await knex('users').where({ kind: 'staff', email }).first();
  if (existing) return; // never overwrite an existing account's password
  if (password.length < 10) { console.warn('[bootstrap] ADMIN_PASSWORD must be at least 10 characters; no admin created'); return; } // eslint-disable-line no-console
  const role = await knex('roles').where({ key: 'super_admin' }).first();
  await knex.transaction(async (trx) => {
    const [userId] = await trx('users').insert({ kind: 'staff', email, name, password_hash: await hashPassword(password), status: 'active', must_change_password: false });
    const branch = await trx('branches').orderBy('id').first();
    await trx('employees').insert({ user_id: userId, role_id: role.id, branch_id: branch ? branch.id : null, job_title: 'Administrator', is_counsellor: false });
  });
  console.log(`[bootstrap] super admin ${email} created`); // eslint-disable-line no-console
}

async function ensureBranch() {
  const any = await knex('branches').first('id');
  if (!any) await knex('branches').insert({ name: 'Headquarters', name_ar: 'المقر الرئيسي', country: 'United States', city: 'Chicago', timezone: 'America/Chicago' });
}

async function run() {
  await syncSystemRoles();
  await ensureBranch();
  await ensureAdmin();
  await require('./system/github').markLive().catch(() => {}); // eslint-disable-line global-require
  for (const mod of ['./crm/stages', './admissions/stages']) { // configurable pipelines get their defaults
    try { await require(mod).ensureDefaults(); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; } // eslint-disable-line global-require
  }
}

module.exports = { run };
