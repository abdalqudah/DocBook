// Navigation model — one definition feeds the sidebar, the section tabs, the ⌘K palette and the mobile bottom bar.
// An item appears only when the staff member holds one of its permissions (and, for "my day", has a doctor profile).
//
// Layout of the menu (client, round 8: "daily pages stand alone and are always visible; only occasional things are grouped"):
//   • `daily` — the pages people open all day, always visible as plain links, ordered per role (DAILY_ORDER);
//   • a few collapsible GROUPS for occasional work (finance, clinic management, stock, reports) — collapsed unless the
//     current page is inside, open state remembered by public/js/nav.js; the section tabs strip shows only inside them;
//   • `more` — settings and help at the bottom.
// Item `key`/`href`/`perms` identify pages (per-employee page access, src/modules/access, relies on them) — never
// change them for an existing item; new items/fields are fine.
//   group    — section key (label: navx.sec_<group>)
//   flat     — render the items as direct links (no accordion, no section tabs)
//   follows  — the item is hidden whenever that other item is hidden (clinic module off / page denied to the member)
//   sidebar  — false: listed in ⌘K and the page-access screen, but not as its own sidebar line
//   parent   — the sidebar line that lights up while on this page
const NAV = [
  { group: 'daily', icon: 'house', flat: true, items: [
    { key: 'dashboard', href: '/app', icon: 'layout-dashboard', perms: ['dashboard.view'], exact: true },
    { key: 'my_day', href: '/app/my-day', icon: 'stethoscope', perms: ['clinical.view'], needsDoctor: true },
    { key: 'appointments', href: '/app/appointments', icon: 'calendar-days', perms: ['appointments.view'] },
    { key: 'front_desk', href: '/app/front-desk', icon: 'armchair', perms: ['frontdesk.use'], badge: 'waiting' },
    { key: 'patients', href: '/app/patients', icon: 'users', perms: ['patients.view'] },
    { key: 'cashier', href: '/app/cashier', icon: 'banknote', perms: ['billing.manage'], badge: 'toPay' },
    { key: 'billing', href: '/app/billing', icon: 'receipt', perms: ['billing.view'] },
    { key: 'certificates', href: '/app/certificates', icon: 'badge-check', perms: ['certificates.view'] },
  ] },
  { group: 'finance', icon: 'wallet', items: [
    { key: 'expenses', href: '/app/expenses', icon: 'receipt-text', perms: ['expenses.view'] },
    { key: 'payroll', href: '/app/payroll', icon: 'wallet', perms: ['payroll.view'], badge: 'pendingAdjustments' },
    { key: 'staff_payroll', href: '/app/staff-payroll', icon: 'users', perms: ['payroll.view'] },
    { key: 'budgets', href: '/app/budgets', icon: 'target', perms: ['expenses.view'] },
    { key: 'profit_loss', href: '/app/finance', icon: 'trending-up', perms: ['finance.view'] },
    { key: 'partners', href: '/app/partners', icon: 'handshake', perms: ['finance.view'] },
    { key: 'cash_closings', href: '/app/cashier/closings', icon: 'lock', perms: ['billing.view'], follows: 'cashier', viewAll: true },
  ] },
  { group: 'management', icon: 'building-2', items: [
    { key: 'doctors', href: '/app/doctors', icon: 'stethoscope', perms: ['doctors.manage', 'appointments.view_all'] },
    { key: 'services', href: '/app/services', icon: 'clipboard-list', perms: ['services.manage'] },
    { key: 'team', href: '/app/settings/team', icon: 'user-cog', perms: ['users.manage'] },
    { key: 'attendance', href: '/app/attendance', icon: 'clock', perms: [] }, // every member clocks in/out here
  ] },
  { group: 'stock', icon: 'package', items: [
    { key: 'supplies', href: '/app/supplies', icon: 'package', perms: ['supplies.view'], badge: 'lowStock' },
    { key: 'purchase_orders', href: '/app/supplies/orders', icon: 'clipboard-list', perms: ['supplies.view'], follows: 'supplies' },
    { key: 'marketplace', href: '/app/marketplace', icon: 'package-search', perms: ['vendors.view'], badge: 'newOffers' },
    { key: 'rep_visits', href: '/app/rep-visits', icon: 'briefcase-business', perms: ['vendors.view'], badge: 'repRequests' },
  ] },
  { group: 'reports', icon: 'chart-pie', items: [
    { key: 'reports', href: '/app/reports', icon: 'chart-pie', perms: ['reports.view'] },
    { key: 'reviews', href: '/app/reviews', icon: 'star', perms: ['reviews.view'] },
  ] },
  { group: 'more', icon: 'settings', flat: true, items: [
    { key: 'settings', href: '/app/settings', icon: 'settings', perms: [], exactSettings: true },
    { key: 'support', href: '/app/help', icon: 'life-buoy', perms: [] },
    { key: 'tickets', href: '/app/tickets', icon: 'message-square', perms: [], sidebar: false, parent: 'support' }, // reached from Help & support
  ] },
];
NAV.forEach((g) => { g.label = `navx.sec_${g.group}`; g.items.forEach((i) => { i.section = g.group; }); });

// Order of the daily pages per role: reception works from the waiting list, a doctor from their own day.
const DAILY_ORDER = {
  default: ['dashboard', 'my_day', 'appointments', 'front_desk', 'patients', 'cashier', 'billing', 'certificates'],
  doctor: ['my_day', 'appointments', 'patients', 'dashboard', 'front_desk', 'cashier', 'billing', 'certificates'],
  receptionist: ['dashboard', 'front_desk', 'appointments', 'patients', 'cashier', 'billing', 'certificates', 'my_day'],
  nurse: ['dashboard', 'front_desk', 'appointments', 'patients', 'certificates', 'cashier', 'billing', 'my_day'],
  accountant: ['dashboard', 'cashier', 'billing', 'appointments', 'patients', 'front_desk', 'certificates', 'my_day'],
};
// Mobile bottom bar: four daily pages for the role (the fifth button opens the full menu).
const BOTTOM_ORDER = {
  default: ['dashboard', 'appointments', 'patients', 'cashier', 'front_desk', 'my_day'],
  doctor: ['my_day', 'appointments', 'patients', 'dashboard'],
  receptionist: ['front_desk', 'appointments', 'patients', 'cashier'],
  nurse: ['front_desk', 'appointments', 'patients', 'dashboard'],
  accountant: ['dashboard', 'cashier', 'billing', 'appointments'],
};

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

// ctx.modulesOff: nav/action keys of the optional areas the clinic turned off (Settings → Modules, see platformops/gate.js)
// plus, for a member with page restrictions, the pages denied to them (access/gate.js).
const hidden = (ctx, key) => Boolean(ctx && ctx.modulesOff && ctx.modulesOff.has(key));
const byKey = new Map(NAV.flatMap((g) => g.items).map((i) => [i.key, i]));

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

/** Section tabs for `path`: only inside a collapsible group (occasional work) with 2+ visible pages; null otherwise. */
function tabsFor(groups, fullPath) {
  const path = String(fullPath || '').split('?')[0];
  if (NO_TABS.some((p) => path === p || path.indexOf(`${p}/`) === 0)) return null;
  const { item, group } = locate(groups, path);
  if (!item || !group || group.flat) return null;
  const items = group.items.filter((i) => i.sidebar !== false);
  if (items.length < 2) return null;
  return { group: { ...group, items }, item };
}

/** Sum of the section's item badges. */
function sectionCount(group, badges) {
  if (!badges) return 0;
  return group.items.reduce((n, i) => n + (i.badge ? Number(badges[i.badge]) || 0 : 0), 0);
}

const orderOf = (table, roleKey) => table[roleKey] || table.default;
function sortDaily(items, roleKey) {
  const order = orderOf(DAILY_ORDER, roleKey);
  const rank = (i) => { const n = order.indexOf(i.key); return n === -1 ? order.length : n; };
  return items.slice().sort((a, b) => rank(a) - rank(b));
}

function forUser(permissions, ctx = {}) {
  const has = (p) => permissions.has(p);
  const visible = (item) => (!item.perms.length || item.perms.some(has)) && (!item.needsDoctor || ctx.doctorId) && !hidden(ctx, item.key)
    // Whole-clinic pages (the cash drawer) stay out of the menu of a login limited to one doctor's visits.
    && (!item.viewAll || !ctx.ownDoctorId);
  const ok = (item) => visible(item) && (!item.follows || (byKey.has(item.follows) ? !hidden(ctx, item.follows) : true));
  const groups = NAV.map((g) => {
    let items = g.items.filter(ok);
    if (g.group === 'daily') items = sortDaily(items, ctx.roleKey);
    return { group: g.group, label: g.label, icon: g.icon, flat: Boolean(g.flat), items };
  }).filter((g) => g.items.length);
  // Helpers for the views (non-enumerable, so the array still looks like a plain list of groups).
  Object.defineProperty(groups, 'locate', { value: (path) => locate(groups, path) });
  Object.defineProperty(groups, 'tabsFor', { value: (path) => tabsFor(groups, path) });
  Object.defineProperty(groups, 'sectionCount', { value: (g, badges) => sectionCount(g, badges) });
  Object.defineProperty(groups, 'bottom', { value: () => bottomFor(groups, ctx.roleKey) });
  return groups;
}

/** The mobile bottom bar: up to four daily pages in the role's order. */
function bottomFor(groups, roleKey) {
  const daily = (groups.find((g) => g.group === 'daily') || { items: [] }).items;
  const order = orderOf(BOTTOM_ORDER, roleKey);
  const picked = order.map((k) => daily.find((i) => i.key === k)).filter(Boolean);
  for (const i of daily) if (picked.length < 4 && !picked.includes(i)) picked.push(i);
  return picked.slice(0, 4);
}

const actionsFor = (permissions, ctx = {}) => ACTIONS.filter((a) => a.perms.some((p) => permissions.has(p)) && !hidden(ctx, a.key));

module.exports = { NAV, SECTIONS: NAV, ACTIONS, DAILY_ORDER, forUser, actionsFor, locate, tabsFor, sectionCount, matches };
