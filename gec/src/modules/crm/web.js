// CRM pages: leads (list + Kanban), students (profile, timeline, notes, tasks), task list.
const express = require('express');
const knex = require('../../db/knex');
const { can } = require('../../middleware/auth');
const { flash } = require('../../middleware/web');
const { safeBack } = require('../../middleware/errors');
const { E } = require('../../core/errors');
const { ah, idParam } = require('../../core/http');
const { validate } = require('../../core/validate');
const { toCsv } = require('../../core/csv');
const fmt = require('../../core/format');
const nav = require('../staff/nav');
const registry = require('../staff/registry');
const dashboard = require('../staff/dashboard');
const settings = require('../settings/settings.service');
const ref = require('../catalog/reference');
const leads = require('./leads.service');
const students = require('./students.service');
const stages = require('./stages');
const activity = require('./activity.service');
const notes = require('./notes.service');
const tasks = require('./tasks.service');
const merge = require('./merge.service');
const people = require('./people');
const tabs = require('./tabs');
const employees = require('../team/employees.service');
const forms = require('./forms');

nav.add('crm', { key: 'leads', href: '/staff/leads', icon: 'user-plus', perms: ['leads.view'] });
nav.add('crm', { key: 'students', href: '/staff/students', icon: 'graduation-cap', perms: ['students.view'] });
nav.add('engagement', { key: 'tasks', href: '/staff/tasks', icon: 'list-checks', perms: ['dashboard.view'] });
registry.addAction({ key: 'lead', icon: 'user-plus', href: '/staff/leads/new', perms: ['leads.manage'] });
registry.addAction({ key: 'student', icon: 'graduation-cap', href: '/staff/students/new', perms: ['students.manage'] });
registry.addAction({ key: 'task', icon: 'list-checks', href: '/staff/tasks?new=1', perms: ['dashboard.view'] });

// ---- Palette search: leads and students within the employee's scope
registry.addSearch(async (req, q) => {
  if (!req.can('leads.view')) return null;
  const rows = await leads.filtered(req.staff, { q, status: 'all' }).whereNot('leads.status', 'merged').select('leads.id', 'leads.ref', 'leads.first_name', 'leads.last_name', 'leads.email', 'leads.status').limit(6);
  return { key: 'leads', label: req.t('nav.leads'), items: rows.map((r) => ({ title: people.fullName(r), sub: [r.ref, r.email, req.t(`leads.status_${r.status}`)].filter(Boolean).join(' · '), href: `/staff/leads/${r.id}`, icon: 'user-plus' })) };
});
registry.addSearch(async (req, q) => {
  if (!req.can('students.view')) return null;
  const rows = await students.filtered(req.staff, { q, status: 'all' }).select('students.id', 'students.ref', 'students.first_name', 'students.last_name', 'students.email').limit(6);
  return { key: 'students', label: req.t('nav.students'), items: rows.map((r) => ({ title: people.fullName(r), sub: [r.ref, r.email].filter(Boolean).join(' · '), href: `/staff/students/${r.id}`, icon: 'graduation-cap' })) };
});

// ---- Needs attention: uncontacted leads past the response target, overdue follow-ups, overdue / due-today tasks
registry.addAttention(async (req) => {
  if (!req.can('leads.view')) return [];
  const hours = (await settings.get('leads')).first_response_hours || 24;
  const out = [];
  const fresh = await leads.filtered(req.staff, { status: 'open', owner: req.staff.employee.dataScope === 'own' ? 'me' : undefined }).whereNull('leads.first_contacted_at')
    .select('leads.id', 'leads.first_name', 'leads.last_name', 'leads.created_at', 'leads.source', 'leads.temperature').orderBy('leads.created_at').limit(15);
  fresh.forEach((l) => {
    const late = Date.now() - new Date(l.created_at).getTime() > hours * 3600_000;
    out.push({ kind: 'lead_new', icon: 'user-plus', tone: late ? 'bad' : 'brand', title: req.t(late ? 'attention.lead_not_contacted' : 'attention.lead_new', { name: people.fullName(l) }), sub: `${req.t(`sources.${l.source}`)} · ${fmt.relative(l.created_at, req.locale)}`, href: `/staff/leads/${l.id}`, chip: l.temperature === 'hot' ? req.t('leads.temp_hot') : null, due: l.created_at });
  });
  const follow = await leads.filtered(req.staff, { status: 'open', followup: 'overdue', owner: req.staff.employee.dataScope === 'own' ? 'me' : undefined })
    .select('leads.id', 'leads.first_name', 'leads.last_name', 'leads.next_follow_up_at').orderBy('leads.next_follow_up_at').limit(10);
  follow.forEach((l) => out.push({ kind: 'lead_followup', icon: 'phone', tone: 'warn', title: req.t('attention.follow_up', { name: people.fullName(l) }), sub: fmt.relative(l.next_follow_up_at, req.locale), href: `/staff/leads/${l.id}`, due: l.next_follow_up_at }));
  return out;
});
registry.addAttention(async (req) => {
  const end = new Date(); end.setUTCHours(23, 59, 59, 999);
  const rows = await tasks.visible(req.staff).where('tasks.assignee_id', req.staff.employee.id).whereNot('tasks.status', 'completed').where('tasks.due_at', '<=', end)
    .select('tasks.id', 'tasks.title', 'tasks.due_at', 'tasks.priority').orderBy('tasks.due_at').limit(15);
  return rows.map((t) => {
    const overdue = new Date(t.due_at) < new Date();
    return { kind: 'task', icon: 'list-checks', tone: overdue ? 'bad' : 'warn', title: t.title, sub: `${overdue ? req.t('common.overdue') : req.t('common.today')} · ${fmt.formatDateTime(t.due_at, req.locale, res_tz(req))}`, href: '/staff/tasks', chip: ['urgent', 'high'].includes(t.priority) ? req.t(`tasks.priority_${t.priority}`) : null, due: t.due_at };
  });
});
const res_tz = (req) => (req.res && req.res.locals.fmt ? req.res.locals.fmt.tz : 'UTC'); // eslint-disable-line camelcase

dashboard.page.kpis.push(async (req) => {
  if (!req.can('leads.view')) return [];
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [{ n: newLeads }] = await leads.filtered(req.staff, { status: 'all' }).whereNot('leads.status', 'merged').where('leads.created_at', '>=', monthStart).count({ n: '*' });
  const [{ n: hot }] = await leads.filtered(req.staff, { status: 'open', temp: 'hot' }).count({ n: '*' });
  const out = [
    { key: 'new_leads', label: req.t('kpi.new_leads'), value: Number(newLeads), href: '/staff/leads?sort=created' },
    { key: 'hot_leads', label: req.t('kpi.hot_leads'), value: Number(hot), href: '/staff/leads?temp=hot' },
  ];
  if (req.can('students.view')) {
    const [{ n: st }] = await students.filtered(req.staff, {}).count({ n: '*' });
    out.push({ key: 'students', label: req.t('kpi.active_students'), value: Number(st), href: '/staff/students' });
  }
  return out;
});

const router = express.Router();

// ============================================================ Leads
async function pickers(req) {
  return {
    stageList: await stages.all(),
    counsellors: await employees.options({ counsellorsOnly: false }),
    sourceList: await stages.sources(),
    destinations: await ref.destinationOptions(req.locale),
    branches: await knex('branches').where({ is_active: true }).orderBy('name'),
  };
}

router.get('/leads', can('leads.view'), ah(async (req, res) => {
  const view = req.query.view === 'board' ? 'board' : 'list';
  const p = await pickers(req);
  const data = view === 'board' ? { board: await leads.board(req.staff, req.query) } : await leads.list(req.staff, req.query);
  const destLabel = Object.fromEntries(p.destinations.map((d) => [d.value, d.label]));
  res.page('pages/staff/leads/index', { layout: 'staff', title: req.t('nav.leads'), view, ...p, ...data, destLabel, pageScripts: view === 'board' ? ['/js/kanban.js'] : [] });
}));

router.get('/leads/export.csv', can('leads.view'), ah(async (req, res) => {
  const rows = await leads.filtered(req.staff, req.query).leftJoin('lead_stages as s', 's.id', 'leads.stage_id').leftJoin('employees as e', 'e.id', 'leads.counsellor_id').leftJoin('users as u', 'u.id', 'e.user_id')
    .select('leads.*', 's.name_en as stage', 'u.name as counsellor').orderBy('leads.created_at', 'desc').limit(10000);
  const cols = ['ref', 'first_name', 'last_name', 'email', 'phone', 'whatsapp', 'nationality', 'residence_country', 'stage', 'status', 'temperature', 'score', 'counsellor', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'interest_degree', 'interest_field', 'interest_intake', 'created_at'].map((k) => ({ key: k }));
  cols.push({ key: 'interest_countries', value: (r) => leads.parseJson(r.interest_countries) });
  await require('../../core/audit').record(req.ctx, 'lead.exported', { entityType: 'lead', newValues: { count: rows.length, filters: req.query } }); // eslint-disable-line global-require
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="leads-${fmt.today()}.csv"` });
  res.send(toCsv(cols, rows));
}));

router.get('/leads/new', can('leads.manage'), ah(async (req, res) => {
  res.page('pages/staff/leads/new', { layout: 'staff', narrow: true, title: req.t('leads.new'), ...(await pickers(req)), old: { source: 'manual', counsellor_id: req.staff.employee.isCounsellor ? req.staff.employee.id : '' } });
}));

router.post('/leads', can('leads.manage'), ah(async (req, res) => {
  try {
    const auto = req.body.counsellor_id === 'auto';
    const data = validate(forms.leadSchema, auto ? { ...req.body, counsellor_id: '' } : req.body);
    const dupes = people.visibleDuplicates(req.staff, await people.findDuplicates({ email: data.email, phone: data.phone || data.whatsapp }));
    if (dupes.length && req.body.confirm_duplicate !== '1') {
      res.status(409);
      return res.page('pages/staff/leads/new', { layout: 'staff', narrow: true, title: req.t('leads.new'), ...(await pickers(req)), old: req.body, dupes });
    }
    let counsellor = auto ? undefined : (data.counsellor_id || null);
    if (!req.can('leads.assign') && counsellor !== req.staff.employee.id) counsellor = req.staff.employee.id; // only assigners choose someone else
    const { lead } = await leads.capture(req.ctx, { ...data, counsellor_id: counsellor }, { source: data.source || 'manual', consent: { contact: true } }, { staff: req.staff });
    // A lead created by an employee who cannot see everything must stay visible to them.
    if (!lead.counsellor_id && req.staff.employee.dataScope === 'own') await knex('leads').where({ id: lead.id }).update({ counsellor_id: req.staff.employee.id });
    flash(req, 'ok', req.t('leads.created'));
    return res.redirect(`/staff/leads/${lead.id}`);
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return res.page('pages/staff/leads/new', { layout: 'staff', narrow: true, title: req.t('leads.new'), ...(await pickers(req)), old: req.body, errors: e.details });
  }
}));

async function leadPage(req, res, lead, extra = {}) {
  // The student's own history (notes, documents, messages…) is shown only to people who may see that student.
  const studentVisible = lead.student_id ? await students.get(req.staff, lead.student_id).then(() => true, () => false) : false;
  const [timeline, taskList, dupes, p, stageRow] = await Promise.all([
    activity.timeline({ leadId: lead.id, studentId: studentVisible ? lead.student_id : null, withoutStudent: !!lead.student_id && !studentVisible }),
    tasks.forRecord({ leadId: lead.id }),
    people.findDuplicates({ email: lead.email, phone: lead.phone || lead.whatsapp }, { leadId: lead.id, studentId: lead.student_id }).then((d) => people.visibleDuplicates(req.staff, d)),
    pickers(req),
    knex('lead_stages').where({ id: lead.stage_id }).first(),
  ]);
  const counsellor = lead.counsellor_id ? await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('e.id', lead.counsellor_id).first('u.name', 'e.id') : null;
  const student = lead.student_id ? await knex('students').where({ id: lead.student_id }).first('id', 'ref', 'first_name', 'last_name') : null;
  res.page('pages/staff/leads/show', {
    layout: 'staff', title: people.fullName(lead), lead, stage: stageRow, timeline: activity.byDay(timeline), taskList, dupes, counsellor, student,
    countries: leads.parseJson(lead.interest_countries), tab: req.query.tab || 'timeline', ...p, ...extra,
  });
}

router.get('/leads/:id', can('leads.view'), ah(async (req, res) => {
  const lead = await leads.get(req.staff, idParam(req.params.id));
  if (lead.status === 'merged' && lead.merged_into_id) return res.redirect(`/staff/leads/${lead.merged_into_id}`);
  return leadPage(req, res, lead);
}));

router.post('/leads/:id', can('leads.manage'), ah(async (req, res) => {
  const id = idParam(req.params.id);
  const lead = await leads.get(req.staff, id);
  try {
    const data = validate(forms.leadSchema, req.body);
    delete data.counsellor_id; delete data.source;
    await leads.update(req.ctx, req.staff, id, data);
    flash(req, 'ok', req.t('common.saved'));
    return res.redirect(`/staff/leads/${id}?tab=details`);
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return leadPage(req, res, lead, { tab: 'details', errors: e.details, old: req.body });
  }
}));

router.post('/leads/:id/stage', can('leads.manage'), ah(async (req, res) => {
  await leads.moveStage(req.ctx, req.staff, idParam(req.params.id), req.body.stage_id, { reason: req.body.reason });
  flash(req, 'ok', req.t('leads.stage_changed'));
  res.redirect(safeBack(req, `/staff/leads/${req.params.id}`));
}));

router.post('/leads/:id/assign', can('leads.assign'), ah(async (req, res) => {
  await leads.assign(req.ctx, req.staff, idParam(req.params.id), req.body.counsellor_id ? Number(req.body.counsellor_id) : null);
  flash(req, 'ok', req.t('leads.assigned'));
  res.redirect(`/staff/leads/${req.params.id}`);
}));

router.post('/leads/:id/contact', can('leads.manage'), ah(async (req, res) => {
  const data = validate(forms.contactSchema, req.body);
  await leads.logContact(req.ctx, req.staff, idParam(req.params.id), { channel: data.channel, outcome: data.outcome, body: data.body, followUpAt: data.follow_up_at ? fmt.zonedToUtc(data.follow_up_at, res.locals.fmt.tz) : undefined });
  flash(req, 'ok', req.t('leads.contact_logged'));
  res.redirect(`/staff/leads/${req.params.id}`);
}));

router.post('/leads/:id/notes', can('leads.manage', 'notes.view'), ah(async (req, res) => {
  const lead = await leads.get(req.staff, idParam(req.params.id));
  await notes.add(req.ctx, { leadId: lead.id, studentId: lead.student_id }, { body: req.body.body, shareable: false });
  flash(req, 'ok', req.t('notes.added'));
  res.redirect(`/staff/leads/${lead.id}`);
}));

router.post('/leads/:id/tasks', can('leads.manage'), ah(async (req, res) => {
  const lead = await leads.get(req.staff, idParam(req.params.id));
  const data = validate(forms.taskSchema, req.body);
  await tasks.create(req.ctx, { ...data, lead_id: lead.id, student_id: lead.student_id, assignee_id: data.assignee_id || lead.counsellor_id || req.staff.employee.id, due_at: data.due_at ? fmt.zonedToUtc(data.due_at.length === 10 ? `${data.due_at}T09:00` : data.due_at, res.locals.fmt.tz) : null });
  flash(req, 'ok', req.t('tasks.created'));
  res.redirect(`/staff/leads/${lead.id}?tab=tasks`);
}));

router.post('/leads/:id/convert', can('students.manage'), ah(async (req, res) => {
  const student = await students.convertLead(req.ctx, req.staff, idParam(req.params.id), { existingStudentId: req.body.student_id ? Number(req.body.student_id) : null });
  flash(req, 'ok', req.t('leads.converted'));
  res.redirect(`/staff/students/${student.id}`);
}));

router.post('/leads/:id/merge', can('records.merge'), ah(async (req, res) => {
  const lead = await leads.get(req.staff, idParam(req.params.id));
  const otherId = Number(req.body.other_id);
  if (req.body.other_kind === 'student') {
    await students.get(req.staff, otherId);
    await merge.mergeLeadIntoStudent(req.ctx, otherId, lead.id);
    flash(req, 'ok', req.t('merge.done'));
    return res.redirect(`/staff/students/${otherId}`);
  }
  await leads.get(req.staff, otherId);
  const keep = req.body.keep === 'other' ? otherId : lead.id;
  const drop = keep === lead.id ? otherId : lead.id;
  await merge.mergeLeads(req.ctx, keep, drop);
  flash(req, 'ok', req.t('merge.done'));
  return res.redirect(`/staff/leads/${keep}`);
}));

router.post('/leads/:id/delete', can('leads.delete'), ah(async (req, res) => {
  await leads.remove(req.ctx, req.staff, idParam(req.params.id));
  flash(req, 'ok', req.t('common.deleted'));
  res.redirect('/staff/leads');
}));

// ============================================================ Students
router.get('/students', can('students.view'), ah(async (req, res) => {
  const data = await students.list(req.staff, req.query);
  res.page('pages/staff/students/index', { layout: 'staff', title: req.t('nav.students'), ...data, counsellors: await employees.options(), destinations: await ref.destinationOptions(req.locale), journey: students.JOURNEY });
}));

router.get('/students/export.csv', can('students.view'), ah(async (req, res) => {
  const rows = await students.filtered(req.staff, req.query).leftJoin('employees as e', 'e.id', 'students.counsellor_id').leftJoin('users as u', 'u.id', 'e.user_id').select('students.*', 'u.name as counsellor').limit(10000);
  const cols = ['ref', 'first_name', 'last_name', 'email', 'phone', 'nationality', 'residence_country', 'journey_stage', 'status', 'counsellor', 'education_level', 'major', 'gpa', 'ielts_overall', 'toefl', 'pte', 'pref_degree', 'budget_usd', 'pref_intake', 'source', 'created_at'].map((k) => ({ key: k }));
  cols.push({ key: 'pref_countries', value: (r) => students.parseJson(r.pref_countries) });
  await require('../../core/audit').record(req.ctx, 'student.exported', { entityType: 'student', newValues: { count: rows.length } }); // eslint-disable-line global-require
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="students-${fmt.today()}.csv"` });
  res.send(toCsv(cols, rows));
}));

router.get('/students/new', can('students.manage'), ah(async (req, res) => {
  res.page('pages/staff/students/new', { layout: 'staff', narrow: true, title: req.t('students.new'), counsellors: await employees.options(), old: { counsellor_id: req.staff.employee.isCounsellor ? req.staff.employee.id : '' } });
}));

router.post('/students', can('students.manage'), ah(async (req, res) => {
  try {
    const data = validate(forms.studentSections.personal, req.body);
    if (!data.email && !data.phone) throw Object.assign(new Error('x'), { code: 'VALIDATION_FAILED', details: { email: 'Enter an email or a phone number.' } });
    const dupes = people.visibleDuplicates(req.staff, await people.findDuplicates({ email: data.email, phone: data.phone || data.whatsapp, passport: data.passport }));
    if (dupes.length && req.body.confirm_duplicate !== '1') {
      res.status(409);
      return res.page('pages/staff/students/new', { layout: 'staff', narrow: true, title: req.t('students.new'), counsellors: await employees.options(), old: req.body, dupes });
    }
    let counsellorId = req.body.counsellor_id ? Number(req.body.counsellor_id) : null;
    if (req.staff.employee.dataScope === 'own' || !req.can('leads.assign')) counsellorId = counsellorId || req.staff.employee.id;
    const emp = counsellorId ? await knex('employees').where({ id: counsellorId }).first('branch_id') : null;
    const s = await students.create(req.ctx, data, { counsellorId, branchId: emp ? emp.branch_id : req.staff.employee.branchId });
    flash(req, 'ok', req.t('students.created'));
    return res.redirect(`/staff/students/${s.id}?tab=profile`);
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return res.page('pages/staff/students/new', { layout: 'staff', narrow: true, title: req.t('students.new'), counsellors: await employees.options(), old: req.body, errors: e.details });
  }
}));

async function studentPage(req, res, s, extra = {}) {
  const tabList = [
    { key: 'overview', icon: 'layout-dashboard' }, { key: 'profile', icon: 'user' }, { key: 'timeline', icon: 'history' }, { key: 'tasks', icon: 'list-checks' },
    ...tabs.forStaff(req),
  ];
  const tab = tabList.some((t) => t.key === (extra.tab || req.query.tab)) ? (extra.tab || req.query.tab) : 'overview';
  const [timeline, taskList, dupes] = await Promise.all([
    activity.timeline({ studentId: s.id }, { limit: tab === 'timeline' ? 300 : 8 }),
    tasks.forRecord({ studentId: s.id }),
    people.findDuplicates({ email: s.email, phone: s.phone || s.whatsapp }, { studentId: s.id }).then((d) => people.visibleDuplicates(req.staff, d)),
  ]);
  const counsellor = s.counsellor_id ? await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('e.id', s.counsellor_id).first('u.name', 'e.id', 'u.email') : null;
  const custom = tabList.find((t) => t.key === tab && t.load);
  const tabData = custom ? await custom.load(req, s) : {};
  res.page('pages/staff/students/show', {
    layout: 'staff', title: people.fullName(s), s, tab, tabList, customTab: custom || null, tabData,
    timeline: activity.byDay(timeline), taskList, dupes, counsellor, counsellors: await employees.options(),
    completion: students.completion(s), journey: students.JOURNEY, destinations: await ref.destinationOptions(req.locale),
    prefCountries: students.parseJson(s.pref_countries), prefFields: students.parseJson(s.pref_fields), ...extra,
  });
}

router.get('/students/:id', can('students.view'), ah(async (req, res) => {
  const s = await students.get(req.staff, idParam(req.params.id));
  if (s.merged_into_id) return res.redirect(`/staff/students/${s.merged_into_id}`);
  return studentPage(req, res, s);
}));

router.post('/students/:id/profile/:section', can('students.manage'), ah(async (req, res) => {
  const id = idParam(req.params.id);
  const section = req.params.section;
  if (!forms.studentSections[section]) return res.redirect(`/staff/students/${id}?tab=profile`);
  const s = await students.get(req.staff, id);
  try {
    const parsed = validate(forms.studentSections[section], req.body);
    await students.update(req.ctx, req.staff, id, forms.blanksToNull(section, req.body, parsed), { section });
    flash(req, 'ok', req.t('common.saved'));
    return res.redirect(`/staff/students/${id}?tab=profile#${section}`);
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return studentPage(req, res, s, { tab: 'profile', errors: e.details, old: req.body, openSection: section });
  }
}));

router.post('/students/:id/journey', can('students.manage'), ah(async (req, res) => {
  const s = await students.get(req.staff, idParam(req.params.id));
  await students.setJourney(req.ctx, s.id, String(req.body.journey_stage));
  flash(req, 'ok', req.t('common.saved'));
  res.redirect(`/staff/students/${s.id}`);
}));

router.post('/students/:id/status', can('students.manage'), ah(async (req, res) => {
  const s = await students.get(req.staff, idParam(req.params.id));
  const status = ['active', 'on_hold', 'enrolled', 'closed'].includes(req.body.status) ? req.body.status : s.status;
  await knex('students').where({ id: s.id }).update({ status, updated_at: new Date() });
  await require('../../core/audit').record(req.ctx, 'student.status_changed', { entityType: 'student', entityId: s.id, oldValues: { status: s.status }, newValues: { status } }); // eslint-disable-line global-require
  res.redirect(`/staff/students/${s.id}`);
}));

router.post('/students/:id/assign', can('leads.assign'), ah(async (req, res) => {
  await students.assign(req.ctx, req.staff, idParam(req.params.id), req.body.counsellor_id ? Number(req.body.counsellor_id) : null);
  flash(req, 'ok', req.t('leads.assigned'));
  res.redirect(`/staff/students/${req.params.id}`);
}));

router.post('/students/:id/contact', can('students.manage'), ah(async (req, res) => {
  const s = await students.get(req.staff, idParam(req.params.id));
  const data = validate(forms.contactSchema, req.body);
  await activity.log({ studentId: s.id }, { type: data.channel, title: `contact:${data.channel}`, body: data.body || null, meta: { outcome: data.outcome }, actorId: req.user.id });
  flash(req, 'ok', req.t('leads.contact_logged'));
  res.redirect(`/staff/students/${s.id}?tab=timeline`);
}));

router.post('/students/:id/notes', can('students.manage', 'notes.view'), ah(async (req, res) => {
  const s = await students.get(req.staff, idParam(req.params.id));
  // Only people who manage the student may publish a note to the student's portal; others add internal notes.
  await notes.add(req.ctx, { studentId: s.id }, { body: req.body.body, shareable: req.body.shareable === '1' && req.can('students.manage') });
  flash(req, 'ok', req.t('notes.added'));
  res.redirect(safeBack(req, `/staff/students/${s.id}?tab=timeline`));
}));

router.post('/students/:id/tasks', can('students.manage', 'applications.manage', 'visa.manage'), ah(async (req, res) => {
  const s = await students.get(req.staff, idParam(req.params.id));
  const data = validate(forms.taskSchema, req.body);
  await tasks.create(req.ctx, { ...data, student_id: s.id, assignee_id: data.assignee_id || s.counsellor_id || req.staff.employee.id, due_at: data.due_at ? fmt.zonedToUtc(data.due_at.length === 10 ? `${data.due_at}T09:00` : data.due_at, res.locals.fmt.tz) : null });
  flash(req, 'ok', req.t('tasks.created'));
  res.redirect(safeBack(req, `/staff/students/${s.id}?tab=tasks`));
}));

router.post('/students/:id/passport', can('students.manage'), ah(async (req, res) => {
  const value = await students.revealPassport(req.ctx, req.staff, idParam(req.params.id));
  res.json({ ok: true, passport: value });
}));

router.post('/students/:id/merge', can('records.merge'), ah(async (req, res) => {
  const s = await students.get(req.staff, idParam(req.params.id));
  const other = await students.get(req.staff, Number(req.body.other_id));
  const keep = req.body.keep === 'other' ? other.id : s.id;
  await merge.mergeStudents(req.ctx, keep, keep === s.id ? other.id : s.id);
  flash(req, 'ok', req.t('merge.done'));
  res.redirect(`/staff/students/${keep}`);
}));

router.post('/students/:id/delete', can('students.delete'), ah(async (req, res) => {
  await students.remove(req.ctx, req.staff, idParam(req.params.id));
  flash(req, 'ok', req.t('common.deleted'));
  res.redirect('/staff/students');
}));

router.post('/notes/:id/delete', can('notes.view', 'leads.manage', 'students.manage'), ah(async (req, res) => {
  // Moderators may delete others' notes, but only on records within their own data scope.
  const n = await knex('notes').where({ id: idParam(req.params.id) }).first();
  if (!n) throw E.notFound('Note');
  if (n.student_id) await students.get(req.staff, n.student_id); else if (n.lead_id) await leads.get(req.staff, n.lead_id);
  await notes.remove(req.ctx, n.id, { canModerate: req.can('records.merge') });
  flash(req, 'ok', req.t('common.deleted'));
  res.redirect(safeBack(req, '/staff'));
}));

// ============================================================ Tasks
router.get('/tasks', ah(async (req, res) => {
  const view = ['open', 'overdue', 'today', 'completed'].includes(req.query.view) ? req.query.view : 'open';
  const rows = await tasks.list(req.staff, { ...req.query, view });
  res.page('pages/staff/tasks/index', { layout: 'staff', title: req.t('nav.tasks'), rows, view, assignees: await employees.options(), showNew: req.query.new === '1' });
}));

router.post('/tasks', ah(async (req, res) => {
  const data = validate(forms.taskSchema, req.body);
  if (data.lead_id) await leads.get(req.staff, data.lead_id);
  if (data.student_id) await students.get(req.staff, data.student_id);
  if (data.application_id) await require('../admissions/applications.service').get(req.staff, data.application_id); // eslint-disable-line global-require
  if (data.assignee_id && data.assignee_id !== req.staff.employee.id && !req.can('tasks.view_all') && !req.can('leads.assign')) data.assignee_id = req.staff.employee.id;
  await tasks.create(req.ctx, { ...data, assignee_id: data.assignee_id || req.staff.employee.id, due_at: data.due_at ? fmt.zonedToUtc(data.due_at.length === 10 ? `${data.due_at}T09:00` : data.due_at, res.locals.fmt.tz) : null });
  flash(req, 'ok', req.t('tasks.created'));
  res.redirect(safeBack(req, '/staff/tasks'));
}));

router.post('/tasks/:id/status', ah(async (req, res) => {
  await tasks.setStatus(req.ctx, req.staff, idParam(req.params.id), String(req.body.status));
  if (String(req.get('accept') || '').includes('application/json')) return res.json({ ok: true });
  flash(req, 'ok', req.body.status === 'completed' ? req.t('tasks.completed') : req.t('common.saved'));
  return res.redirect(safeBack(req, '/staff/tasks'));
}));

router.post('/tasks/:id/delete', ah(async (req, res) => {
  await tasks.remove(req.ctx, req.staff, idParam(req.params.id));
  flash(req, 'ok', req.t('common.deleted'));
  res.redirect(safeBack(req, '/staff/tasks'));
}));

module.exports = router;
