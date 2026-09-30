// Website workspace permissions (DocBook 2.0 redesign 4.1). Built-in roles follow the permission catalog at boot
// (rbac.syncSystemRoles). Custom roles keep their stored permissions, so a custom role that could manage the clinic
// page through settings.manage gets the website permissions too — nobody loses access they had.
const WEBSITE = ['website.view', 'website.edit', 'website.publish', 'website.seo', 'website.domain', 'website.email', 'website.analytics'];
const parse = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v || '[]'); } catch { return []; } };

exports.up = async (knex) => {
  const roles = await knex('roles').where({ is_system: false }).select('id', 'permissions');
  for (const r of roles) {
    const perms = parse(r.permissions);
    if (!perms.includes('settings.manage') || WEBSITE.every((p) => perms.includes(p))) continue;
    await knex('roles').where({ id: r.id }).update({ permissions: JSON.stringify([...new Set([...perms, ...WEBSITE])]) }); // eslint-disable-line no-await-in-loop
  }
};

exports.down = async (knex) => {
  const roles = await knex('roles').where({ is_system: false }).select('id', 'permissions');
  for (const r of roles) {
    const perms = parse(r.permissions);
    if (!perms.some((p) => WEBSITE.includes(p))) continue;
    await knex('roles').where({ id: r.id }).update({ permissions: JSON.stringify(perms.filter((p) => !WEBSITE.includes(p))) }); // eslint-disable-line no-await-in-loop
  }
};
