// Navigation model — one definition feeds the sidebar, the workspace tabs, the ⌘K palette and the mobile bottom bar.
// An item appears only when the staff member holds one of its permissions (and, for "my day", has a doctor profile).
//
// DocBook 2.0 layout (redesign phase 3): the sidebar lists a few WORKSPACES, one line each — Today, Appointments,
// Front desk, Patients, Finance, Clinic, Stock, Website, Reports — then Settings and Help at the bottom. A workspace
// line opens the first page of that workspace the member can see; the workspace's pages are the tabs in the page
// header (section-tabs.ejs). No accordions, never more than two levels.
// Item `key`/`href`/`perms` identify pages (per-employee page access, src/modules/access, relies on them) — never
// change them for an existing item; new items/fields are fine.
//   group    — workspace key (label: navx.sec_<group>)
//   foot     — the workspace sits at the bottom of the sidebar (settings, help)
//   follows  — the item is hidden whenever that other item is hidden (clinic module off / page denied to the member)
//   tab      — false: not shown as a workspace tab (still in ⌘K and on the page-access screen)
//   tabPerms — the tab shows only with one of these permissions (the page itself stays open to `perms`)
//   cluster  — tabs of one workspace are drawn in clusters with a divider between them (finance)
//   parent   — the tab that lights up while on this page
//   lights   — other addresses where this tab lights up (menu only; their own page-access rules stay)
//   also     — older/other addresses that belong to this page (moved pages keep their page-access rules there)
//   doctorHome — hidden for a doctor login (their "Today" is my day)
// Workspace field: sidebarPerms — the workspace line shows only with one of these (personal settings live in the user menu).
const NAV = [
  { group: 'today', icon: 'house', items: [
    { key: 'dashboard', href: '/app', icon: 'layout-dashboard', perms: ['dashboard.view'], exact: true, doctorHome: true },
    { key: 'my_day', href: '/app/my-day', icon: 'stethoscope', perms: ['clinical.view'], needsDoctor: true },
  ] },
  { group: 'appointments', icon: 'calendar-days', items: [
    { key: 'appointments', href: '/app/appointments', icon: 'calendar-days', perms: ['appointments.view'] },
  ] },
  { group: 'front_desk', icon: 'armchair', items: [
    { key: 'front_desk', href: '/app/front-desk', icon: 'armchair', perms: ['frontdesk.use'], badge: 'waiting' },
  ] },
  { group: 'patients', icon: 'users', items: [
    { key: 'patients', href: '/app/patients', icon: 'users', perms: ['patients.view'] },
    { key: 'certificates', href: '/app/certificates', icon: 'badge-check', perms: ['certificates.view'] },
    { key: 'surgeries', href: '/app/surgeries', icon: 'scissors', perms: ['clinical.view', 'appointments.manage'] },
  ] },
  // Medical reps: their visits first, the offers next to them (moved from Stock).
  { group: 'reps', icon: 'briefcase-business', items: [
    { key: 'rep_visits', href: '/app/rep-visits', icon: 'briefcase-business', perms: ['vendors.view'], badge: 'repRequests' },
    { key: 'marketplace', href: '/app/marketplace', icon: 'package-search', perms: ['vendors.view'], badge: 'newOffers' },
  ] },
  { group: 'finance', icon: 'wallet', items: [
    { key: 'profit_loss', href: '/app/finance', icon: 'trending-up', perms: ['finance.view'], exact: true, cluster: 'overview' },
    { key: 'cashier', href: '/app/cashier', icon: 'banknote', perms: ['billing.manage'], badge: 'toPay', cluster: 'collect' },
    { key: 'billing', href: '/app/billing', icon: 'receipt', perms: ['billing.view'], cluster: 'collect' },
    { key: 'payments_all', href: '/app/billing/payments', icon: 'credit-card', perms: ['billing.view'], cluster: 'collect', lights: ['/app/payments'] },
    { key: 'cash_closings', href: '/app/cashier/closings', icon: 'lock', perms: ['billing.view'], follows: 'cashier', viewAll: true, cluster: 'collect' },
    { key: 'expenses', href: '/app/expenses', icon: 'receipt-text', perms: ['expenses.view'], cluster: 'spend' },
    { key: 'budgets', href: '/app/budgets', icon: 'target', perms: ['expenses.view'], cluster: 'spend' },
    { key: 'payroll', href: '/app/payroll', icon: 'wallet', perms: ['payroll.view'], badge: 'pendingAdjustments', cluster: 'people' },
    { key: 'staff_payroll', href: '/app/staff-payroll', icon: 'users', perms: ['payroll.view'], cluster: 'people' },
    { key: 'partners', href: '/app/partners', icon: 'handshake', perms: ['finance.view'], cluster: 'people' },
  ] },
  { group: 'clinic', icon: 'building-2', items: [
    { key: 'doctors', href: '/app/doctors', icon: 'stethoscope', perms: ['doctors.manage', 'appointments.view_all'] },
    { key: 'services', href: '/app/services', icon: 'clipboard-list', perms: ['services.manage'] },
    { key: 'team', href: '/app/clinic/team', icon: 'user-cog', perms: ['users.manage'], also: ['/app/settings/team', '/app/settings/roles', '/app/clinic/roles'] },
    { key: 'clinic_hours', href: '/app/clinic/hours', icon: 'calendar-clock', perms: ['settings.manage'] },
    { key: 'branches', href: '/app/clinic/branches', icon: 'map-pin', perms: ['settings.manage'] },
    { key: 'attendance', href: '/app/attendance', icon: 'clock', perms: [], tabPerms: ['attendance.view'] }, // everyone clocks in (user menu); the tab is for managers
    { key: 'clinical_setup', href: '/app/clinic/setup', icon: 'pill', perms: ['settings.manage', 'prescriptions.create', 'clinical.edit'],
      lights: ['/app/settings/medications', '/app/settings/diagnosis-codes', '/app/settings/insurance', '/app/settings/signatures', '/app/specialty/settings', '/app/clinic/orders-catalog'] },
  ] },
  { group: 'stock', icon: 'package', items: [
    { key: 'supplies', href: '/app/supplies', icon: 'package', perms: ['supplies.view'], badge: 'lowStock' },
    { key: 'purchase_orders', href: '/app/supplies/orders', icon: 'clipboard-list', perms: ['supplies.view'], follows: 'supplies' },
  ] },
  { group: 'website', icon: 'globe', items: [
    { key: 'website', href: '/app/website', icon: 'globe', perms: ['website.view'], exact: true },
    { key: 'website_builder', href: '/app/website/builder', icon: 'layout-template', perms: ['website.edit'], lights: ['/app/website/preview'] },
    { key: 'website_theme', href: '/app/website/theme', icon: 'palette', perms: ['website.edit'] },
    { key: 'website_booking', href: '/app/website/booking', icon: 'calendar-plus', perms: ['website.edit'] },
    { key: 'website_media', href: '/app/website/media', icon: 'images', perms: ['website.edit'] },
    { key: 'website_domain', href: '/app/website/domain', icon: 'link', perms: ['website.domain'] },
    { key: 'website_email', href: '/app/website/email', icon: 'mail', perms: ['website.email'] },
    { key: 'website_seo', href: '/app/website/seo', icon: 'search', perms: ['website.seo'] },
    { key: 'website_marketing', href: '/app/website/marketing', icon: 'megaphone', perms: ['website.edit'] },
    { key: 'reviews', href: '/app/website/reviews', icon: 'star', perms: ['reviews.view'], also: ['/app/reviews'] },
    { key: 'website_analytics', href: '/app/website/analytics', icon: 'chart-pie', perms: ['website.analytics'] },
    { key: 'website_settings', href: '/app/website/settings', icon: 'settings', perms: ['website.edit'] },
  ] },
  { group: 'reports', icon: 'chart-pie', items: [
    { key: 'reports', href: '/app/reports', icon: 'chart-pie', perms: ['reports.view'] },
  ] },
  { group: 'settings', icon: 'settings', foot: true, sidebarPerms: ['settings.manage', 'data.manage', 'data.export', 'audit.view'], items: [
    { key: 'settings', href: '/app/settings', icon: 'settings', perms: [], exactSettings: true },
  ] },
  { group: 'support', icon: 'life-buoy', foot: true, items: [
    { key: 'support', href: '/app/help', icon: 'life-buoy', perms: [] },
    { key: 'tickets', href: '/app/tickets', icon: 'message-square', perms: [] },
  ] },
];
NAV.forEach((g) => { g.label = `navx.sec_${g.group}`; g.items.forEach((i) => { i.section = g.group; }); });

// Mobile bottom bar: three pages for the role around the central "+ New" button (the fifth button opens the full menu).
const BOTTOM_ORDER = {
  default: ['dashboard', 'appointments', 'patients', 'front_desk', 'my_day', 'cashier'],
  doctor: ['my_day', 'appointments', 'patients'],
  receptionist: ['front_desk', 'appointments', 'cashier', 'patients'],
  nurse: ['front_desk', 'appointments', 'patients'],
  accountant: ['dashboard', 'cashier', 'profit_loss', 'billing'],
};

// Quick actions: `create` ones form the global "+ New" menu (top bar, and the middle of the mobile bar); all of them are
// listed in the ⌘K palette. There is no free-standing sale: an invoice always comes from a visit on the cash screen.
const ACTIONS = [
  { key: 'new_appointment', href: '/app/appointments/new', icon: 'calendar-plus', perms: ['appointments.manage'], create: true },
  { key: 'new_patient', href: '/app/patients?new=1', icon: 'user-plus', perms: ['patients.create'], create: true },
  { key: 'check_in', href: '/app/front-desk#fx-expected', icon: 'door-open', perms: ['frontdesk.use'], create: true },
  { key: 'collect_payment', href: '/app/cashier/screen', icon: 'banknote', perms: ['billing.manage'], create: true },
  { key: 'new_expense', href: '/app/expenses?new=1', icon: 'receipt-text', perms: ['expenses.manage'], create: true },
  { key: 'new_certificate', href: '/app/certificates/new', icon: 'badge-check', perms: ['certificates.issue'], create: true },
  { key: 'add_staff', href: '/app/clinic/team?new=1', icon: 'user-cog', perms: ['users.manage'], create: true },
  { key: 'waiting_room', href: '/app/front-desk', icon: 'armchair', perms: ['frontdesk.use'] },
  { key: 'booking_page', href: '/app/website', icon: 'globe', perms: ['website.view'] },
];

// Pages under these prefixes never show the workspace tabs (settings has its own sub-navigation).
const NO_TABS = ['/app/settings'];

// ctx.modulesOff: nav/action keys of the optional areas the clinic turned off (Settings → Modules, see platformops/gate.js)
// plus, for a member with page restrictions, the pages denied to them (access/gate.js).
const hidden = (ctx, key) => Boolean(ctx && ctx.modulesOff && ctx.modulesOff.has(key));
const byKey = new Map(NAV.flatMap((g) => g.items).map((i) => [i.key, i]));

const under = (href, path) => path === href || path.indexOf(`${href}/`) === 0;
/** Does `path` belong to `item`? Exact items match only themselves; others match their sub-pages (and aliases) too. */
function matches(item, path) {
  if (item.exact) return path === item.href;
  return under(item.href, path) || (item.also || []).some((h) => under(h, path));
}
const matchLength = (item, path) => {
  if (item.exact) return path === item.href ? item.href.length : 0;
  return Math.max(0, ...[item.href, ...(item.also || []), ...(item.lights || [])].filter((h) => under(h, path)).map((h) => h.length));
};

/**
 * The page the user is on: the visible item with the longest match of `path` (so /app/finance/payments is "payments_all",
 * not "profit_loss"), with its workspace. → { item, group } or { item: null, group: null }.
 */
function locate(groups, fullPath) {
  const path = String(fullPath || '').split('?')[0].split('#')[0].replace(/(.)\/+$/, '$1');
  let best = null; let bestGroup = null; let bestLen = 0;
  for (const g of groups) {
    for (const i of g.items) {
      const n = matchLength(i, path);
      if (n > bestLen) { best = i; bestGroup = g; bestLen = n; }
    }
  }
  return { item: best, group: bestGroup };
}

/** Workspace tabs for `path`: the pages of the current workspace when it has 2+ tabs; null otherwise. */
function tabsFor(groups, fullPath) {
  const path = String(fullPath || '').split('?')[0];
  if (NO_TABS.some((p) => under(p, path)) && !(locate(groups, path).item?.also || locate(groups, path).item?.lights)) return null;
  const { item, group } = locate(groups, path);
  if (!item || !group) return null;
  const items = group.tabs;
  if (items.length < 2) return null;
  const active = items.includes(item) ? item : (item.parent && items.find((i) => i.key === item.parent)) || null;
  return { group: { ...group, items }, item: active };
}

/** Sum of the workspace's badges. */
function sectionCount(group, badges) {
  if (!badges) return 0;
  return group.items.reduce((n, i) => n + (i.badge ? Number(badges[i.badge]) || 0 : 0), 0);
}

const orderOf = (table, roleKey) => table[roleKey] || table.default;
// A login whose finance pages are only the cash desk sees the workspace as "Cashier" (redesign: الصندوق).
const CASH_ONLY = new Set(['cashier', 'billing', 'payments_all', 'cash_closings']);

function forUser(permissions, ctx = {}) {
  const has = (p) => permissions.has(p);
  const doctorHome = ctx.roleKey === 'doctor' && ctx.doctorId;
  const visible = (item) => (!item.perms.length || item.perms.some(has)) && (!item.needsDoctor || ctx.doctorId) && !hidden(ctx, item.key)
    && !(item.doctorHome && doctorHome)
    // Whole-clinic pages (the cash drawer) stay out of the menu of a login limited to one doctor's visits.
    && (!item.viewAll || !ctx.ownDoctorId);
  const ok = (item) => visible(item) && (!item.follows || (byKey.has(item.follows) ? !hidden(ctx, item.follows) : true));
  const tabOk = (item) => item.tab !== false && (!item.tabPerms || item.tabPerms.some(has));
  const groups = NAV.map((g) => {
    const items = g.items.filter(ok);
    const tabs = items.filter(tabOk);
    let label = g.label;
    if (g.group === 'finance' && tabs.length && tabs.every((i) => CASH_ONLY.has(i.key))) label = 'navx.sec_cashier';
    const inSidebar = Boolean(tabs.length) && (!g.sidebarPerms || g.sidebarPerms.some(has));
    return { group: g.group, label, icon: g.icon, foot: Boolean(g.foot), items, tabs, home: tabs[0] || null, inSidebar };
  }).filter((g) => g.items.length);
  // Helpers for the views (non-enumerable, so the array still looks like a plain list of groups).
  Object.defineProperty(groups, 'locate', { value: (path) => locate(groups, path) });
  Object.defineProperty(groups, 'tabsFor', { value: (path) => tabsFor(groups, path) });
  Object.defineProperty(groups, 'sectionCount', { value: (g, badges) => sectionCount(g, badges) });
  Object.defineProperty(groups, 'bottom', { value: () => bottomFor(groups, ctx.roleKey) });
  return groups;
}

/** The mobile bottom bar: three pages in the role's order (the "+ New" button and the menu complete it). */
function bottomFor(groups, roleKey) {
  const all = groups.flatMap((g) => g.items);
  const order = orderOf(BOTTOM_ORDER, roleKey);
  const picked = order.map((k) => all.find((i) => i.key === k)).filter(Boolean);
  for (const k of ['appointments', 'patients', 'front_desk', 'dashboard', 'my_day']) {
    const i = all.find((x) => x.key === k);
    if (i && picked.length < 3 && !picked.includes(i)) picked.push(i);
  }
  return picked.slice(0, 3);
}

const actionsFor = (permissions, ctx = {}) => ACTIONS.filter((a) => a.perms.some((p) => permissions.has(p)) && !hidden(ctx, a.key));

module.exports = { NAV, SECTIONS: NAV, ACTIONS, BOTTOM_ORDER, forUser, actionsFor, locate, tabsFor, sectionCount, matches };
