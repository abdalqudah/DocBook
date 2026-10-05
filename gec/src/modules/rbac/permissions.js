// Permission catalog and the built-in roles. Checked on the server for every staff route (middleware/auth.can);
// the UI only hides what the server would refuse anyway. "manage" implies "view" (see IMPLIES).
const GROUPS = [
  { key: 'overview', perms: ['dashboard.view', 'reports.team'] },
  { key: 'crm', perms: ['leads.view', 'leads.manage', 'leads.assign', 'leads.delete', 'students.view', 'students.manage', 'students.delete', 'records.merge', 'notes.view'] },
  { key: 'admissions', perms: ['applications.view', 'applications.manage', 'documents.view', 'documents.verify', 'visa.view', 'visa.manage'] },
  { key: 'catalog', perms: ['catalog.view', 'catalog.manage', 'catalog.import', 'catalog.internal'] },
  { key: 'engagement', perms: ['appointments.view', 'appointments.manage', 'courses.manage', 'events.manage', 'tasks.view_all'] },
  { key: 'communication', perms: ['comms.view', 'comms.send', 'templates.manage', 'campaigns.manage'] },
  { key: 'finance', perms: ['finance.view', 'finance.manage', 'partners.view', 'partners.manage'] },
  { key: 'team', perms: ['employees.view', 'employees.manage', 'roles.manage'] },
  { key: 'website', perms: ['cms.manage', 'analytics.view'] },
  { key: 'system', perms: ['automations.manage', 'integrations.manage', 'settings.manage', 'audit.view', 'privacy.manage'] },
];

const ALL = GROUPS.flatMap((g) => g.perms);

const IMPLIES = {
  'leads.manage': 'leads.view', 'leads.assign': 'leads.view', 'leads.delete': 'leads.manage',
  'students.manage': 'students.view', 'students.delete': 'students.manage',
  'applications.manage': 'applications.view', 'documents.verify': 'documents.view', 'visa.manage': 'visa.view',
  'catalog.manage': 'catalog.view', 'catalog.import': 'catalog.manage', 'catalog.internal': 'catalog.view',
  'appointments.manage': 'appointments.view', 'comms.send': 'comms.view', 'campaigns.manage': 'comms.view',
  'finance.manage': 'finance.view', 'partners.manage': 'partners.view', 'employees.manage': 'employees.view',
  'roles.manage': 'employees.view', 'reports.team': 'dashboard.view',
};

/** Adds implied permissions (manage → view), transitively. */
function normalise(perms) {
  const set = new Set(perms);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of [...set]) if (IMPLIES[p] && !set.has(IMPLIES[p])) { set.add(IMPLIES[p]); grew = true; }
  }
  return [...set].filter((p) => ALL.includes(p));
}

const without = (...remove) => ALL.filter((p) => !remove.includes(p));
const CRM_CORE = ['dashboard.view', 'leads.manage', 'students.manage', 'notes.view', 'applications.manage', 'documents.view', 'catalog.view', 'appointments.manage', 'comms.send'];

// key, English / Arabic names, data scope (own = assigned to me; branch = my branch; all), permissions.
const SYSTEM_ROLES = [
  { key: 'super_admin', name_en: 'Super Admin', name_ar: 'مدير النظام الأعلى', scope: 'all', permissions: ALL },
  { key: 'admin', name_en: 'Admin', name_ar: 'مسؤول', scope: 'all', permissions: without('roles.manage', 'privacy.manage') },
  { key: 'branch_manager', name_en: 'Branch Manager', name_ar: 'مدير فرع', scope: 'branch',
    permissions: [...CRM_CORE, 'reports.team', 'leads.assign', 'records.merge', 'documents.verify', 'visa.manage', 'tasks.view_all', 'employees.view', 'finance.view', 'analytics.view', 'courses.manage', 'events.manage'] },
  { key: 'admissions_manager', name_en: 'Admissions Manager', name_ar: 'مدير القبولات', scope: 'all',
    permissions: [...CRM_CORE, 'reports.team', 'leads.assign', 'documents.verify', 'visa.manage', 'catalog.manage', 'catalog.import', 'catalog.internal', 'tasks.view_all', 'templates.manage', 'partners.view'] },
  { key: 'counsellor', name_en: 'Counsellor', name_ar: 'مستشار أكاديمي', scope: 'own', permissions: [...CRM_CORE] },
  { key: 'visa_officer', name_en: 'Visa Officer', name_ar: 'مسؤول التأشيرات', scope: 'all',
    permissions: ['dashboard.view', 'students.view', 'notes.view', 'applications.view', 'documents.verify', 'visa.manage', 'catalog.view', 'appointments.manage', 'comms.send'] },
  { key: 'sales', name_en: 'Sales', name_ar: 'مبيعات', scope: 'own', permissions: ['dashboard.view', 'leads.manage', 'students.view', 'notes.view', 'catalog.view', 'appointments.manage', 'comms.send'] },
  { key: 'marketing', name_en: 'Marketing', name_ar: 'تسويق', scope: 'all',
    permissions: ['dashboard.view', 'leads.view', 'catalog.view', 'events.manage', 'comms.view', 'templates.manage', 'campaigns.manage', 'cms.manage', 'analytics.view'] },
  { key: 'finance', name_en: 'Finance', name_ar: 'مالية', scope: 'all',
    permissions: ['dashboard.view', 'students.view', 'applications.view', 'catalog.view', 'catalog.internal', 'finance.manage', 'partners.manage'] },
  { key: 'instructor', name_en: 'Instructor', name_ar: 'مدرّب', scope: 'own', permissions: ['dashboard.view', 'courses.manage', 'appointments.view'] },
  { key: 'reception', name_en: 'Reception', name_ar: 'استقبال', scope: 'branch',
    permissions: ['dashboard.view', 'leads.manage', 'students.view', 'catalog.view', 'appointments.manage', 'comms.send'] },
];

module.exports = { GROUPS, ALL, IMPLIES, SYSTEM_ROLES, normalise };
