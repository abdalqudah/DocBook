// Permission catalog and system roles.
// DocBook's flag permissions map onto these keys:
//   canViewProfits → profits.view        canManagePartners → partners.manage
//   canManageExpenses → expenses.manage  canManagePayroll → payroll.manage
//   canManagePurchases → purchases.manage canManageMarketing → marketing.manage
//   canManageOrders → sales.manage + customers.manage   canManageDeliveries → delivery.manage
//   canSyncSheets → integrations.manage  canManageUsers → users.manage   canManageProjects → settings.manage
// "view" keys were implicit in DocBook (a module was visible whenever it could be managed); they are explicit here
// so read-only roles (partner viewer, auditor) are possible.
const GROUPS = [
  { key: 'overview', perms: ['dashboard.view', 'profits.view'] },
  { key: 'partners', perms: ['partners.view', 'partners.manage'] },
  { key: 'expenses', perms: ['expenses.view', 'expenses.manage'] },
  { key: 'payroll', perms: ['payroll.view', 'payroll.manage'] },
  { key: 'purchases', perms: ['purchases.view', 'purchases.manage'] },
  { key: 'sales', perms: ['sales.view', 'sales.manage', 'customers.view', 'customers.manage'] },
  { key: 'delivery', perms: ['delivery.view', 'delivery.manage'] },
  { key: 'marketing', perms: ['marketing.view', 'marketing.manage'] },
  { key: 'budgets', perms: ['budgets.view', 'budgets.manage'] },
  { key: 'reports', perms: ['reports.view', 'data.export'] },
  { key: 'intelligence', perms: ['ai.use', 'ai.manage'] },
  { key: 'workspace', perms: ['integrations.manage', 'support.use', 'settings.manage', 'users.manage', 'roles.manage', 'data.manage', 'audit.view'] },
];

const ALL = GROUPS.flatMap((g) => g.perms);
const without = (...remove) => ALL.filter((p) => !remove.includes(p));

// Viewing implies nothing else; managing implies viewing (enforced when saving a role).
const IMPLIES = Object.fromEntries(ALL.filter((p) => p.endsWith('.manage')).map((p) => [p, p.replace('.manage', '.view')]).filter(([, v]) => ALL.includes(v)));

const SYSTEM_ROLES = [
  { key: 'owner', permissions: ALL },
  { key: 'admin', permissions: without('data.manage') },
  {
    key: 'accountant', // DocBook "accountant": everything financial, no marketing, no users/projects
    permissions: ['dashboard.view', 'profits.view', 'partners.view', 'partners.manage', 'expenses.view', 'expenses.manage', 'payroll.view', 'payroll.manage',
      'purchases.view', 'purchases.manage', 'sales.view', 'sales.manage', 'customers.view', 'customers.manage', 'delivery.view', 'delivery.manage',
      'marketing.view', 'budgets.view', 'budgets.manage', 'reports.view', 'data.export', 'integrations.manage', 'ai.use', 'support.use'],
  },
  {
    key: 'sales', // DocBook "sales": marketing, orders, deliveries — no profit figures
    permissions: ['dashboard.view', 'sales.view', 'sales.manage', 'customers.view', 'customers.manage', 'delivery.view', 'delivery.manage',
      'marketing.view', 'marketing.manage', 'support.use'],
  },
  {
    key: 'partner_viewer', // DocBook "partner_viewer": sees profits and partner statements only
    permissions: ['dashboard.view', 'profits.view', 'partners.view', 'reports.view', 'support.use'],
  },
  {
    key: 'viewer',
    permissions: ['dashboard.view', 'partners.view', 'expenses.view', 'payroll.view', 'purchases.view', 'sales.view', 'customers.view', 'delivery.view',
      'marketing.view', 'budgets.view', 'reports.view', 'support.use'],
  },
];

function normalise(perms) {
  const set = new Set(perms.filter((p) => ALL.includes(p)));
  for (const p of [...set]) if (IMPLIES[p]) set.add(IMPLIES[p]);
  return ALL.filter((p) => set.has(p));
}

module.exports = { GROUPS, ALL, SYSTEM_ROLES, IMPLIES, normalise };
