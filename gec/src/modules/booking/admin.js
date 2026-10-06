// Staff: appointment types, courses and events (resource CRUD), plus their operational pages.
const knex = require('../../db/knex');
const { resource } = require('../../core/resource');
const ref = require('../catalog/reference');
const money = require('../catalog/money');

const employeesOptions = async () => (await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('u.status', 'active').orderBy('u.name').select('e.id', 'u.name')).map((e) => ({ value: String(e.id), label: e.name }));
const branchOptions = async () => (await knex('branches').where({ is_active: true }).orderBy('name').select('id', 'name')).map((b) => ({ value: String(b.id), label: b.name }));
const currencyOptions = async () => (await money.codes()).map((c) => ({ value: c, label: c }));
const L = (req, row, f) => (req.locale === 'ar' && row[`${f}_ar`]) || row[`${f}_en`];
const seoFields = [{ name: 'seo_title', type: 'text', bilingual: true, max: 160 }, { name: 'seo_description', type: 'textarea', bilingual: true, max: 300, rows: 2 }];

const appointmentTypes = resource({
  key: 'appointment-types', table: 'appointment_types', entity: 'appointment_type', nameField: 'name_en', slugFrom: 'name_en',
  perms: { view: 'appointments.manage', manage: 'settings.manage' }, defaults: { duration_min: 30, buffer_min: 10, location_mode: 'both', capacity: 1, min_notice_hours: 12, max_days_ahead: 45, is_public: true, is_active: true },
  list: { search: ['name_en', 'name_ar'], defaultSort: ['position', 'asc'], columns: [
    { key: 'name', label: 'common.name', render: (r, req) => L(req, r, 'name') }, { key: 'duration_min', label: 'resources.fields.duration_min' },
    { key: 'location_mode', label: 'resources.fields.location_mode', render: (r, req) => req.t(`booking.mode_${r.location_mode}`) }, { key: 'is_public', label: 'resources.fields.is_public', type: 'bool' }, { key: 'is_active', label: 'common.status', type: 'bool' }] },
  sections: [
    { key: 'basics', fields: [{ name: 'name', type: 'text', bilingual: true, required: true }, { name: 'slug', type: 'slug', hint: 'catalog.slug_hint' }, { name: 'description', type: 'textarea', bilingual: true, rows: 3 }, { name: 'position', type: 'int' }] },
    { key: 'timing', fields: [{ name: 'duration_min', type: 'int', required: true, max: 480 }, { name: 'buffer_min', type: 'int', max: 240 }, { name: 'min_notice_hours', type: 'int', max: 720 }, { name: 'max_days_ahead', type: 'int', max: 365 }, { name: 'capacity', type: 'int', max: 500 }] },
    { key: 'place', fields: [{ name: 'location_mode', type: 'select', required: true, options: ['online', 'in_person', 'both'], optionLabel: 'booking.modes' }, { name: 'location_text', type: 'text' }] },
    { key: 'staff', fields: [{ name: 'staff_ids', type: 'checks', virtual: true, options: employeesOptions, hint: 'booking.staff_hint' }] },
    { key: 'price', fields: [{ name: 'price', type: 'int' }, { name: 'currency', type: 'select', options: currencyOptions }] },
    { key: 'visibility', fields: [{ name: 'is_public', type: 'bool' }, { name: 'is_active', type: 'bool' }] },
  ],
  loadVirtual: async (row) => ({ staff_ids: (await knex('appointment_type_staff').where({ type_id: row.id }).pluck('employee_id')).map(String) }),
  afterSave: async (id, req, data) => {
    if (!data || !data.staff_ids || !(await knex('appointment_types').where({ id }).first('id'))) return;
    await knex.transaction(async (trx) => {
      await trx('appointment_type_staff').where({ type_id: id }).del();
      const ids = data.staff_ids.map(Number).filter(Boolean);
      if (ids.length) await trx('appointment_type_staff').insert(ids.map((e) => ({ type_id: id, employee_id: e })));
    });
  },
});

const courses = resource({
  key: 'courses', table: 'courses', entity: 'course', nameField: 'name_en', slugFrom: 'name_en', perms: { view: 'courses.manage', manage: 'courses.manage' },
  publicUrl: (r) => `/courses/${r.slug}`, defaults: { mode: 'in_person', currency: 'USD', registration_open: true, is_active: true, cancellable: true, certificate: true },
  list: { search: ['name_en', 'name_ar'], defaultSort: ['start_date', 'desc'],
    select: (q) => q.select('courses.*', knex.raw("(SELECT COUNT(*) FROM course_registrations r WHERE r.course_id = courses.id AND r.status IN ('pending','confirmed','completed')) AS seats")),
    columns: [{ key: 'name', label: 'common.name', render: (r, req) => L(req, r, 'name') }, { key: 'start_date', label: 'resources.fields.start_date', type: 'date' },
      { key: 'seats', label: 'booking.seats', render: (r) => `${r.seats}${r.capacity ? ` / ${r.capacity}` : ''}` }, { key: 'price', label: 'resources.fields.price', render: (r) => (r.price ? `${r.price} ${r.currency}` : '—') }, { key: 'is_active', label: 'common.status', type: 'bool' }] },
  sections: [
    { key: 'basics', fields: [{ name: 'name', type: 'text', bilingual: true, required: true, max: 190 }, { name: 'slug', type: 'slug', hint: 'catalog.slug_hint' }, { name: 'description', type: 'markdown', bilingual: true, rows: 5 }, { name: 'image', type: 'image' }] },
    { key: 'delivery', fields: [{ name: 'instructor_id', type: 'select', options: employeesOptions }, { name: 'branch_id', type: 'select', options: branchOptions, hint: 'booking.branch_hint' }, { name: 'instructor_name', type: 'text' }, { name: 'mode', type: 'select', required: true, options: ['online', 'in_person', 'blended'], optionLabel: 'booking.course_mode' }, { name: 'location', type: 'text' }] },
    { key: 'dates', fields: [{ name: 'start_date', type: 'date' }, { name: 'end_date', type: 'date' }, { name: 'schedule', type: 'text', bilingual: true }] },
    { key: 'seats', fields: [{ name: 'capacity', type: 'int' }, { name: 'price', type: 'int' }, { name: 'currency', type: 'select', required: true, options: currencyOptions }, { name: 'cancellable', type: 'bool' }, { name: 'certificate', type: 'bool' }] },
    { key: 'visibility', fields: [{ name: 'registration_open', type: 'bool' }, { name: 'is_active', type: 'bool' }] },
    { key: 'seo', fields: seoFields },
  ],
  related: async (row) => [{ href: `/staff/courses/${row.id}/registrations`, title: 'registrations', sub: null }],
});

const events = resource({
  key: 'events', table: 'events', entity: 'event', nameField: 'title_en', slugFrom: 'title_en', perms: { view: 'events.manage', manage: 'events.manage' },
  publicUrl: (r) => `/events/${r.slug}`, defaults: { type: 'info_session', registration_open: true, is_active: true },
  list: { search: ['title_en', 'title_ar'], defaultSort: ['starts_at', 'desc'],
    select: (q) => q.select('events.*', knex.raw("(SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = events.id AND r.status IN ('registered','attended')) AS seats"), knex.raw("(SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = events.id AND r.status = 'attended') AS attended")),
    columns: [{ key: 'title', label: 'common.name', render: (r, req) => L(req, r, 'title') }, { key: 'starts_at', label: 'resources.fields.starts_at', type: 'date' },
      { key: 'type', label: 'resources.fields.type', render: (r, req) => req.t(`booking.event_type.${r.type}`) }, { key: 'seats', label: 'booking.registered', render: (r) => `${r.seats}${r.capacity ? ` / ${r.capacity}` : ''} · ${r.attended} ✓` }, { key: 'is_active', label: 'common.status', type: 'bool' }] },
  sections: [
    { key: 'basics', fields: [{ name: 'title', type: 'text', bilingual: true, required: true, max: 190 }, { name: 'slug', type: 'slug', hint: 'catalog.slug_hint' }, { name: 'type', type: 'select', required: true, options: ['fair', 'webinar', 'open_day', 'info_session', 'workshop', 'other'], optionLabel: 'booking.event_type' },
      { name: 'description', type: 'markdown', bilingual: true, rows: 5 }, { name: 'image', type: 'image' }, { name: 'speakers', type: 'list', bilingual: true, hint: 'catalog.one_per_line' }] },
    { key: 'when', fields: [{ name: 'starts_at', type: 'datetime', required: true }, { name: 'ends_at', type: 'datetime' }] },
    { key: 'where', fields: [{ name: 'is_virtual', type: 'bool' }, { name: 'location', type: 'text', bilingual: true }, { name: 'meeting_url', type: 'url', hint: 'booking.meeting_hint' }] },
    { key: 'seats', fields: [{ name: 'capacity', type: 'int' }, { name: 'registration_open', type: 'bool' }, { name: 'is_active', type: 'bool' }] },
    { key: 'ownership', fields: [{ name: 'organizer_id', type: 'select', options: employeesOptions, hint: 'booking.organizer_hint' }, { name: 'branch_id', type: 'select', options: branchOptions, hint: 'booking.branch_hint' }] },
    { key: 'seo', fields: seoFields },
  ],
  related: async (row) => [{ href: `/staff/events/${row.id}/registrations`, title: 'registrations', sub: null }],
});

/**
 * May this staff member see the registrants of a course / event? Everyone with "all" data scope; the course's
 * instructor or the event's organiser; and branch-scoped staff for courses / events of their own branch.
 */
function canSeeRegistrants(staff, row, ownerField) {
  const e = staff && staff.employee;
  if (!e || !row) return false;
  if (e.dataScope === 'all') return true;
  if (row[ownerField] && row[ownerField] === e.id) return true;
  return e.dataScope === 'branch' && !!row.branch_id && row.branch_id === e.branchId;
}

module.exports = { appointmentTypes, courses, events, employeesOptions, branchOptions, canSeeRegistrants, ref };
