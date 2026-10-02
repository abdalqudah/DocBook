// Voiding an invoice (and refunding a payment, which voids it) becomes its own permission, billing.void, held by the
// clinic's admins: the built-in owner and clinic manager roles follow the catalog at boot (rbac.syncSystemRoles);
// a custom role keeps it only when it is an admin role (it could manage the clinic's settings and its billing).
const parse = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v || '[]'); } catch { return []; } };

exports.up = async (knex) => {
  const roles = await knex('roles').where({ is_system: false }).select('id', 'permissions');
  for (const r of roles) {
    const perms = parse(r.permissions);
    if (!perms.includes('settings.manage') || !perms.includes('billing.manage') || perms.includes('billing.void')) continue;
    await knex('roles').where({ id: r.id }).update({ permissions: JSON.stringify([...perms, 'billing.void']) }); // eslint-disable-line no-await-in-loop
  }
};

exports.down = async (knex) => {
  const roles = await knex('roles').where({ is_system: false }).select('id', 'permissions');
  for (const r of roles) {
    const perms = parse(r.permissions);
    if (perms.includes('billing.void')) await knex('roles').where({ id: r.id }).update({ permissions: JSON.stringify(perms.filter((p) => p !== 'billing.void')) }); // eslint-disable-line no-await-in-loop
  }
};
