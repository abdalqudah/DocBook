// Navigation model — one definition feeds the sidebar, the section tabs, the ⌘K palette and the mobile bottom bar.
// An item appears only when the staff member holds one of its permissions (and, for "my day", has a doctor profile).
//
// The menu is organised in SECTIONS (each entry of NAV is one section, `group` is its key). The sidebar shows one line
// per section (an accordion), a section with a single visible page renders as a plain link, and `flat` sections
// (home, and settings/help at the bottom) always render their pages as plain links. Item `key`/`href`/`perms` identify
// pages (per-employee page access relies on them) — never change them here.
//   group  — section key (labels: navx.sec_<group>)
//   label  — i18n key of the section title
//   icon   — the section's icon in the sidebar
//   flat   — render the items as direct links (no accordion, no section tabs)
const NAV = [
  { group: 'home', icon: 'house', flat: true, items: [
    { key: 'dashboard', href: '/app', icon: 'layout-dashboard', perms: ['dashboard.view'], exact: true, bottom: 1 },
    { key: 'my_day', href: '/app/my-day', icon: 'stethoscope', perms: ['clinical.view'], needsDoctor: true, bottom: 2 },
  ] },
  { group: 'clinic', icon: 'hospital', items: [
    { key: 'appointments', href: '/app/appointments', icon: 'calendar-days', perms: ['appointments.view'], bottom: 3 },
    { key: 'front_desk', href: '/app/front-desk', icon: 'armchair', perms: ['frontdesk.use'], badge: 'waiting', bottom: 2 },
    { key: 'patients', href: '/app/patients', icon: 'users', perms: ['patients.view'], bottom: 4 },
    { key: 'certificates', href: '/app/certificates', icon: 'badge-check', perms: ['certificates.view'] },
  ] },
  { group: 'finance', icon: 'wallet', items: [
    { key: 'cashier', href: '/app/cashier', icon: 'banknote', perms: ['billing.manage'], badge: 'toPay' },
    { key: 'billing', href: '/app/billing', icon: 'receipt', perms: ['billing.view'] },
    { key: 'payroll', href: '/app/payroll', icon: 'wallet', perms: ['payroll.view'], badge: 'pendingAdjustments' },
    { key: 'staff_payroll', href: '/app/staff-payroll', icon: 'users', perms: ['payroll.view'] },
    { key: 'expenses', href: '/app/expenses', icon: 'receipt-text', perms: ['expenses.view'] },
    { key: 'budgets', href: '/app/budgets', icon: 'target', perms: ['expenses.view'] },
    { key: 'profit_loss', href: '/app/finance', icon: 'trending-up', perms: ['finance.view'] },
    { key: 'partners', href: '/app/partners', icon: 'handshake', perms: ['finance.view'] },
  ] },
  { group: 'team', icon: 'user-cog', items: [
    { key: 'doctors', href: '/app/doctors', icon: 'stethoscope', perms: ['doctors.manage', 'appointments.view_all'] },
    { key: 'services', href: '/app/services', icon: 'clipboard-list', perms: ['services.manage'] },
    { key: 'attendance', href: '/app/attendance', icon: 'clock', perms: [] }, // every member clocks in/out here
    { key: 'team', href: '/app/settings/team', icon: 'user-cog', perms: ['users.manage'] },
  ] },
  { group: 'operations', icon: 'package', items: [
    { key: 'supplies', href: '/app/supplies', icon: 'package', perms: ['supplies.view'], badge: 'lowStock' },
    { key: 'marketplace', href: '/app/marketplace', icon: 'package-search', perms: ['vendors.view'], badge: 'newOffers' },
    { key: 'rep_visits', href: '/app/rep-visits', icon: 'briefcase-business', perms: ['vendors.view'], badge: 'repRequests' },
  ] },
  { group: 'reports', icon: 'chart-pie', items: [
    { key: 'reports', href: '/app/reports', icon: 'chart-pie', perms: ['reports.view'] },
    { key: 'reviews', href: '/app/reviews', icon: 'star', perms: ['reviews.view'] },
  ] },
  { group: 'more', icon: 'settings', flat: true, items: [
    { key: 'settings', href: '/app/settings', icon: 'settings', perms: [], exactSettings: true },
    { key: 'tickets', href: '/app/tickets', icon: 'message-square', perms: [] },
    { key: 'support', href: '/app/help', icon: 'life-buoy', perms: [] },
  ] },
];
NAV.forEach((g) => { g.label = `navx.sec_${g.group}`; g.items.forEach((i) => { i.section = g.group; }); });

const ACTIONS = [
  { key: 'new_appointment', href: '/app/appointments/new', icon: 'calendar-plus', perms: ['appointments.manage'] },
  { key: 'new_patient', href: '/app/patients?new=1', icon: 'user-plus', perms: ['patients.create'] },
  { key: 'waiting_room', href: '/app/front-desk', icon: 'armchair', perms: ['frontdesk.use'] },
  { key: 'new_expense', href: '/app/expenses?new=1', icon: 'banknote', perms: ['expenses.manage'] },
  { key: 'add_staff', href: '/app/settings/team?new=1', icon: 'user-cog', perms: ['users.manage'] },
  { key: 'booking_page', href: '/app/settings/portal', icon: 'globe', perms: ['settings.manage'] },
];

// Pages under these prefixes never show the section tabs (settings has its own sub-navigation).
const NO_TABS = ['/app/settings'];

// ctx.modulesOff: nav/action keys of the optional areas the clinic turned off (Settings → Modules, see platformops/gate.js).
const hidden = (ctx, key) => Boolean(ctx && ctx.modulesOff && ctx.modulesOff.has(key));

/** Does `path` belong to `item`? Exact items match only themselves; others match their sub-pages too. */
function matches(item, path) {
  if (item.exact) return path === item.href;
  return path === item.href || path.indexOf(`${item.href}/`) === 0;
}

/**
 * The page the user is on: the visible item whose href is the longest match of `path` (so /app/settings/team is
 * "team", not "settings"), with its section. → { item, group } or { item: null, group: null }.
 */
function locate(groups, fullPath) {
  const path = String(fullPath || '').split('?')[0].split('#')[0].replace(/(.)\/+$/, '$1');
  let best = null; let bestGroup = null;
  for (const g of groups) {
    for (const i of g.items) {
      if (matches(i, path) && (!best || i.href.length > best.href.length)) { best = i; bestGroup = g; }
    }
  }
  return { item: best, group: bestGroup };
}

/** Section tabs for `path`: the section's visible pages when it has 2+ of them (null otherwise). */
function tabsFor(groups, fullPath) {
  const path = String(fullPath || '').split('?')[0];
  if (NO_TABS.some((p) => path === p || path.indexOf(`${p}/`) === 0)) return null;
  const { item, group } = locate(groups, path);
  if (!item || !group || group.flat || group.items.length < 2) return null;
  return { group, item };
}

/** Sum of the section's item badges. */
function sectionCount(group, badges) {
  if (!badges) return 0;
  return group.items.reduce((n, i) => n + (i.badge ? Number(badges[i.badge]) || 0 : 0), 0);
}

function forUser(permissions, ctx = {}) {
  const ok = (item) => (!item.perms.length || item.perms.some((p) => permissions.has(p))) && (!item.needsDoctor || ctx.doctorId) && !hidden(ctx, item.key);
  const groups = NAV.map((g) => ({ group: g.group, label: g.label, icon: g.icon, flat: Boolean(g.flat), items: g.items.filter(ok) }))
    .filter((g) => g.items.length);
  // Helpers for the views (non-enumerable, so the array still looks like a plain list of groups).
  Object.defineProperty(groups, 'locate', { value: (path) => locate(groups, path) });
  Object.defineProperty(groups, 'tabsFor', { value: (path) => tabsFor(groups, path) });
  Object.defineProperty(groups, 'sectionCount', { value: (g, badges) => sectionCount(g, badges) });
  return groups;
}

const actionsFor = (permissions, ctx = {}) => ACTIONS.filter((a) => a.perms.some((p) => permissions.has(p)) && !hidden(ctx, a.key));

module.exports = { NAV, SECTIONS: NAV, ACTIONS, forUser, actionsFor, locate, tabsFor, sectionCount, matches };
