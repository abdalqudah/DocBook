// Permission catalog and the built-in clinic staff roles.
// Based on DocBook's clinic RBAC (owner, clinic_manager, doctor, receptionist, accountant) with a nurse role added.
// "view" / "manage" pairs: managing always implies viewing (normalise()).
const GROUPS = [
  { key: 'overview', perms: ['dashboard.view', 'finance.view'] },
  { key: 'appointments', perms: ['appointments.view', 'appointments.manage', 'appointments.view_all'] },
  { key: 'frontdesk', perms: ['frontdesk.use', 'billing.view', 'billing.manage'] },
  { key: 'patients', perms: ['patients.view', 'patients.create', 'patients.edit', 'patients.delete'] },
  { key: 'clinical', perms: ['clinical.view', 'clinical.edit', 'vitals.edit', 'prescriptions.create'] },
  { key: 'clinic', perms: ['doctors.manage', 'services.manage'] },
  { key: 'payroll', perms: ['payroll.view', 'payroll.manage', 'payroll.approve'] },
  { key: 'supplies', perms: ['supplies.view', 'supplies.manage', 'expenses.view', 'expenses.manage'] },
  { key: 'attendance', perms: ['attendance.view', 'attendance.manage'] },
  { key: 'vendors', perms: ['vendors.view', 'vendors.manage'] },
  { key: 'reports', perms: ['reports.view', 'data.export'] },
  { key: 'admin', perms: ['users.manage', 'roles.manage', 'settings.manage', 'data.manage', 'audit.view'] },
];

const ALL = GROUPS.flatMap((g) => g.perms);
const without = (...remove) => ALL.filter((p) => !remove.includes(p));

const IMPLIES = {
  'appointments.manage': 'appointments.view', 'appointments.view_all': 'appointments.view', 'billing.manage': 'billing.view',
  'patients.create': 'patients.view', 'patients.edit': 'patients.view', 'patients.delete': 'patients.view',
  'clinical.edit': 'clinical.view', 'vitals.edit': 'clinical.view', 'prescriptions.create': 'clinical.view',
  'attendance.manage': 'attendance.view', 'vendors.manage': 'vendors.view', 'payroll.manage': 'payroll.view', 'payroll.approve': 'payroll.view', 'supplies.manage': 'supplies.view', 'expenses.manage': 'expenses.view',
};

const SYSTEM_ROLES = [
  { key: 'owner', permissions: ALL, entry: '/app' },
  { key: 'clinic_manager', permissions: without('data.manage'), entry: '/app' },
  {
    key: 'doctor', // sees and treats their own patients; appointments are limited to their own schedule
    permissions: ['dashboard.view', 'vendors.view', 'appointments.view', 'patients.view', 'patients.edit', 'clinical.view', 'clinical.edit', 'vitals.edit', 'prescriptions.create'],
    entry: '/app/my-day',
  },
  {
    key: 'nurse', // prepares patients: waiting room, vital signs, patient records — no diagnoses or prescriptions
    permissions: ['dashboard.view', 'vendors.view', 'appointments.view', 'appointments.view_all', 'frontdesk.use', 'patients.view', 'patients.edit', 'clinical.view', 'vitals.edit', 'supplies.view', 'supplies.manage'],
    entry: '/app/front-desk',
  },
  {
    key: 'receptionist', // bookings, check-in, payment at checkout — no clinical notes (DocBook: "a receptionist schedules and checks in")
    permissions: ['dashboard.view', 'vendors.view', 'appointments.view', 'appointments.manage', 'appointments.view_all', 'frontdesk.use', 'billing.view', 'billing.manage',
      'patients.view', 'patients.create', 'patients.edit'],
    entry: '/app/front-desk',
  },
  {
    key: 'accountant', // billing, payroll, commissions, expenses, reports — no clinical data
    permissions: ['dashboard.view', 'vendors.view', 'finance.view', 'appointments.view', 'appointments.view_all', 'billing.view', 'billing.manage', 'payroll.view', 'payroll.manage', 'attendance.view',
      'supplies.view', 'expenses.view', 'expenses.manage', 'reports.view', 'data.export'],
    entry: '/app/billing',
  },
];

/** Roles offered on the clinic sign-in portal, in display order, with the icon shown there. */
const PORTAL_ROLES = [
  { key: 'doctor', icon: 'stethoscope' },
  { key: 'nurse', icon: 'heart-pulse' },
  { key: 'receptionist', icon: 'clipboard-list' },
  { key: 'accountant', icon: 'wallet' },
  { key: 'clinic_manager', icon: 'building-2' },
];

function normalise(perms) {
  const set = new Set(perms.filter((p) => ALL.includes(p)));
  for (const p of [...set]) if (IMPLIES[p]) set.add(IMPLIES[p]);
  return ALL.filter((p) => set.has(p));
}

const entryFor = (roleKey) => (SYSTEM_ROLES.find((r) => r.key === roleKey) || {}).entry || '/app';

module.exports = { GROUPS, ALL, SYSTEM_ROLES, PORTAL_ROLES, IMPLIES, normalise, entryFor };
