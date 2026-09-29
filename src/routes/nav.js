// Navigation model — one definition feeds the sidebar, the ⌘K palette and the mobile bottom bar.
// An item appears only when the staff member holds one of its permissions (and, for "my day", has a doctor profile).
const NAV = [
  { group: 'overview', items: [
    { key: 'dashboard', href: '/app', icon: 'layout-dashboard', perms: ['dashboard.view'], exact: true, bottom: 1 },
    { key: 'my_day', href: '/app/my-day', icon: 'stethoscope', perms: ['clinical.view'], needsDoctor: true, bottom: 2 },
  ] },
  { group: 'clinic', items: [
    { key: 'appointments', href: '/app/appointments', icon: 'calendar-days', perms: ['appointments.view'], bottom: 3 },
    { key: 'front_desk', href: '/app/front-desk', icon: 'armchair', perms: ['frontdesk.use'], badge: 'waiting', bottom: 2 },
    { key: 'patients', href: '/app/patients', icon: 'users', perms: ['patients.view'], bottom: 4 },
    { key: 'certificates', href: '/app/certificates', icon: 'badge-check', perms: ['certificates.view'] },
  ] },
  { group: 'finance', items: [
    { key: 'cashier', href: '/app/cashier', icon: 'banknote', perms: ['billing.manage'], badge: 'toPay' },
    { key: 'billing', href: '/app/billing', icon: 'receipt', perms: ['billing.view'] },
    { key: 'payroll', href: '/app/payroll', icon: 'wallet', perms: ['payroll.view'], badge: 'pendingAdjustments' },
    { key: 'expenses', href: '/app/expenses', icon: 'receipt-text', perms: ['expenses.view'] },
  ] },
  { group: 'operations', items: [
    { key: 'doctors', href: '/app/doctors', icon: 'stethoscope', perms: ['doctors.manage', 'appointments.view_all'] },
    { key: 'services', href: '/app/services', icon: 'clipboard-list', perms: ['services.manage'] },
    { key: 'attendance', href: '/app/attendance', icon: 'clock', perms: [] }, // every member clocks in/out here
    { key: 'marketplace', href: '/app/marketplace', icon: 'package-search', perms: ['vendors.view'], badge: 'newOffers' },
    { key: 'rep_visits', href: '/app/rep-visits', icon: 'briefcase-business', perms: ['vendors.view'], badge: 'repRequests' },
    { key: 'supplies', href: '/app/supplies', icon: 'package', perms: ['supplies.view'], badge: 'lowStock' },
  ] },
  { group: 'insights', items: [
    { key: 'reports', href: '/app/reports', icon: 'chart-pie', perms: ['reports.view'] },
    { key: 'reviews', href: '/app/reviews', icon: 'star', perms: ['reviews.view'] },
  ] },
  { group: 'admin', items: [
    { key: 'team', href: '/app/settings/team', icon: 'user-cog', perms: ['users.manage'] },
    { key: 'settings', href: '/app/settings', icon: 'settings', perms: [], exactSettings: true },
    { key: 'support', href: '/app/help', icon: 'life-buoy', perms: [] },
  ] },
];

const ACTIONS = [
  { key: 'new_appointment', href: '/app/appointments/new', icon: 'calendar-plus', perms: ['appointments.manage'] },
  { key: 'new_patient', href: '/app/patients?new=1', icon: 'user-plus', perms: ['patients.create'] },
  { key: 'waiting_room', href: '/app/front-desk', icon: 'armchair', perms: ['frontdesk.use'] },
  { key: 'new_expense', href: '/app/expenses?new=1', icon: 'banknote', perms: ['expenses.manage'] },
  { key: 'add_staff', href: '/app/settings/team?new=1', icon: 'user-cog', perms: ['users.manage'] },
  { key: 'booking_page', href: '/app/settings/portal', icon: 'globe', perms: ['settings.manage'] },
];

function forUser(permissions, ctx = {}) {
  const ok = (item) => (!item.perms.length || item.perms.some((p) => permissions.has(p))) && (!item.needsDoctor || ctx.doctorId);
  return NAV.map((g) => ({ group: g.group, items: g.items.filter(ok) })).filter((g) => g.items.length);
}

const actionsFor = (permissions) => ACTIONS.filter((a) => a.perms.some((p) => permissions.has(p)));

module.exports = { NAV, forUser, actionsFor };
