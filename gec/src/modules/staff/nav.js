// Staff navigation: groups and links, each shown only when the employee holds one of its permissions
// (the routes check the same permissions on the server).
const NAV = [
  { key: 'overview', items: [
    { key: 'dashboard', href: '/staff', icon: 'layout-dashboard', perms: ['dashboard.view'], exact: true },
  ] },
];

/** Adds a link to a group (modules register their own links as they load). */
function add(groupKey, item, { before } = {}) {
  let group = NAV.find((g) => g.key === groupKey);
  if (!group) { group = { key: groupKey, items: [] }; NAV.push(group); }
  if (group.items.some((i) => i.key === item.key)) return;
  const at = before ? group.items.findIndex((i) => i.key === before) : -1;
  if (at >= 0) group.items.splice(at, 0, item); else group.items.push(item);
}

const ORDER = ['overview', 'crm', 'admissions', 'engagement', 'communication', 'finance', 'team', 'website', 'analytics', 'system'];

function forStaff(req, counts = {}) {
  const path = req.originalUrl.split('?')[0];
  return [...NAV].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key)).map((g) => ({
    key: g.key,
    items: g.items.filter((i) => i.perms.some((p) => req.can(p))).map((i) => ({
      ...i,
      current: i.exact ? path === i.href : (path === i.href || path.startsWith(`${i.href}/`)),
      count: counts[i.key] || 0,
    })),
  })).filter((g) => g.items.length);
}

/** Badge numbers for links that declare `badge: async (req) => n` (only links the employee can see). */
async function counts(req) {
  const out = {};
  const items = NAV.flatMap((g) => g.items).filter((i) => i.badge && i.perms.some((p) => req.can(p)));
  await Promise.all(items.map(async (i) => { try { out[i.key] = await i.badge(req); } catch { out[i.key] = 0; } }));
  return out;
}

module.exports = { NAV, add, forStaff, counts };
