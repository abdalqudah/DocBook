// Navigation model — one definition feeds the sidebar, the ⌘K palette and the mobile bottom bar.
// An item appears only when the member holds one of its permissions.
const NAV = [
  { group: 'overview', items: [
    { key: 'dashboard', href: '/app', icon: 'layout-dashboard', perms: ['dashboard.view'], exact: true, bottom: 1 },
  ] },
  { group: 'finance', items: [
    { key: 'partners', href: '/app/partners', icon: 'handshake', perms: ['partners.view'] },
    { key: 'expenses', href: '/app/expenses', icon: 'receipt', perms: ['expenses.view'], bottom: 3 },
    { key: 'payroll', href: '/app/payroll', icon: 'wallet', perms: ['payroll.view'] },
    { key: 'budgets', href: '/app/budgets', icon: 'piggy-bank', perms: ['budgets.view'], badge: 'budgetAlerts' },
  ] },
  { group: 'operations', items: [
    { key: 'sales', href: '/app/sales', icon: 'shopping-cart', perms: ['sales.view'], bottom: 2 },
    { key: 'customers', href: '/app/customers', icon: 'users', perms: ['customers.view'] },
    { key: 'purchases', href: '/app/purchases', icon: 'package', perms: ['purchases.view'] },
    { key: 'delivery', href: '/app/delivery', icon: 'truck', perms: ['delivery.view'], badge: 'pendingDeliveries' },
  ] },
  { group: 'growth', items: [
    { key: 'marketing', href: '/app/marketing', icon: 'megaphone', perms: ['marketing.view'] },
  ] },
  { group: 'intelligence', items: [
    { key: 'reports', href: '/app/reports', icon: 'file-text', perms: ['reports.view'], bottom: 4 },
    { key: 'advisor', href: '/app/advisor', icon: 'sparkles', perms: ['ai.use'] },
  ] },
  { group: 'workspace', items: [
    { key: 'sheets', href: '/app/integrations/sheets', icon: 'sheet', perms: ['integrations.manage'] },
    { key: 'support', href: '/app/support', icon: 'life-buoy', perms: ['support.use'] },
    { key: 'settings', href: '/app/settings', icon: 'settings', perms: [] },
  ] },
];

// Quick actions offered in ⌘K.
const ACTIONS = [
  { key: 'new_expense', href: '/app/expenses?new=1', icon: 'plus', perms: ['expenses.manage'] },
  { key: 'new_order', href: '/app/sales/new', icon: 'plus', perms: ['sales.manage'] },
  { key: 'new_purchase', href: '/app/purchases?new=1', icon: 'plus', perms: ['purchases.manage'] },
  { key: 'new_employee', href: '/app/payroll/employees/new', icon: 'user-plus', perms: ['payroll.manage'] },
  { key: 'new_partner', href: '/app/partners/new', icon: 'handshake', perms: ['partners.manage'] },
  { key: 'new_campaign', href: '/app/marketing?new=1', icon: 'megaphone', perms: ['marketing.manage'] },
  { key: 'new_shipment', href: '/app/delivery?new=1', icon: 'truck', perms: ['delivery.manage'] },
  { key: 'pnl', href: '/app/reports/pnl', icon: 'file-text', perms: ['reports.view'] },
  { key: 'ask_ai', href: '/app/advisor/chat', icon: 'bot', perms: ['ai.use'] },
];

function forUser(permissions) {
  const ok = (item) => !item.perms.length || item.perms.some((p) => permissions.has(p));
  return NAV.map((g) => ({ group: g.group, items: g.items.filter(ok) })).filter((g) => g.items.length);
}

const actionsFor = (permissions) => ACTIONS.filter((a) => a.perms.some((p) => permissions.has(p)));

module.exports = { NAV, forUser, actionsFor };
