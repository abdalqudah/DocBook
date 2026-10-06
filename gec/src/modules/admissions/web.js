// Admissions pages: applications (board + list + detail), the document centre, visa cases; student-page tabs.
const express = require('express');
const knex = require('../../db/knex');
const fmt = require('../../core/format');
const { can } = require('../../middleware/auth');
const { flash, allowMultipart } = require('../../middleware/web');
const { safeBack } = require('../../middleware/errors');
const { ah, idParam } = require('../../core/http');
const { validate, z, str, date, oneOf, num, reqStr } = require('../../core/validate');
const { E } = require('../../core/errors');
const uploads = require('../../core/uploads');
const audit = require('../../core/audit');
const nav = require('../staff/nav');
const registry = require('../staff/registry');
const dashboard = require('../staff/dashboard');
const tabs = require('../crm/tabs');
const students = require('../crm/students.service');
const tasks = require('../crm/tasks.service');
const notes = require('../crm/notes.service');
const activity = require('../crm/activity.service');
const employees = require('../team/employees.service');
const people = require('../crm/people');
const ref = require('../catalog/reference');
const apps = require('./applications.service');
const stages = require('./stages');
const documents = require('./documents.service');
const visa = require('./visa.service');
require('./handlers');

require('../jobs').register('documents.expire', 6 * 3600_000, () => documents.expireDue());

nav.add('crm', { key: 'applications', href: '/staff/applications', icon: 'kanban', perms: ['applications.view'] });
nav.add('admissions', { key: 'documents', href: '/staff/documents', icon: 'file-check', perms: ['documents.verify'] }, { before: 'universities' });
nav.add('admissions', { key: 'visa', href: '/staff/visa', icon: 'plane', perms: ['visa.view'] }, { before: 'universities' });
registry.addAction({ key: 'application', icon: 'kanban', href: '/staff/applications/new', perms: ['applications.manage'] });

registry.addSearch(async (req, q) => {
  if (!req.can('applications.view')) return null;
  const rows = await apps.filtered(req.staff, { q, status: 'all' }).select(apps.COLS).limit(5);
  return { key: 'applications', label: req.t('nav.applications'), items: rows.map((a) => ({ title: `${people.fullName(a)} — ${a.program_name || ''}`, sub: `${a.ref} · ${req.locale === 'ar' ? a.stage_ar : a.stage_en}`, href: `/staff/applications/${a.id}`, icon: 'kanban' })) };
});

// ---- Needs attention: deadlines, stuck applications, documents to review / expiring, visa appointments
registry.addAttention(async (req) => {
  const out = [];
  if (req.can('applications.view')) {
    const own = req.staff.employee.dataScope === 'own' ? 'me' : undefined;
    const soon = await apps.filtered(req.staff, { deadline: 'soon', owner: own }).select(apps.COLS).limit(10);
    soon.forEach((a) => out.push({ kind: 'deadline', icon: 'calendar-clock', tone: new Date(a.deadline) < new Date() ? 'bad' : 'warn', title: req.t('attention.deadline', { name: people.fullName(a), program: a.program_name }), sub: fmt.formatDate(a.deadline, req.locale), href: `/staff/applications/${a.id}`, due: a.deadline }));
    const stuck = await apps.filtered(req.staff, { stuck: '1', owner: own }).select(apps.COLS).limit(10);
    stuck.forEach((a) => out.push({ kind: 'stuck', icon: 'hourglass', tone: 'warn', title: req.t('attention.stuck', { name: people.fullName(a), stage: req.locale === 'ar' ? a.stage_ar : a.stage_en }), sub: req.t('attention.days_in_stage', { n: fmt.daysBetween(a.stage_entered_at) }), href: `/staff/applications/${a.id}`, due: a.stage_entered_at }));
  }
  if (req.can('documents.verify')) {
    const q = knex('documents as d').join('students as s', 's.id', 'd.student_id').join('document_types as t', 't.key', 'd.type_key').whereIn('d.status', ['uploaded', 'under_review']);
    require('../rbac/rbac.service').scope(q, req.staff, { owner: 's.counsellor_id', branch: 's.branch_id' }); // eslint-disable-line global-require
    const rows = await q.select('d.id', 'd.uploaded_at', 's.id as sid', 's.first_name', 's.last_name', 't.name_en', 't.name_ar').orderBy('d.uploaded_at').limit(10);
    rows.forEach((d) => out.push({ kind: 'doc_review', icon: 'file-check', tone: 'brand', title: req.t('attention.doc_review', { name: people.fullName(d), doc: req.locale === 'ar' ? d.name_ar : d.name_en }), sub: fmt.relative(d.uploaded_at, req.locale), href: `/staff/students/${d.sid}?tab=documents`, due: d.uploaded_at }));
  }
  if (req.can('visa.view')) {
    const cases = (await visa.list(req.staff, {})).filter((v) => (v.interview_at && new Date(v.interview_at) < new Date(Date.now() + 7 * 86400000) && new Date(v.interview_at) > new Date()) || (v.biometrics_at && new Date(v.biometrics_at) < new Date(Date.now() + 7 * 86400000) && new Date(v.biometrics_at) > new Date()));
    cases.slice(0, 8).forEach((v) => out.push({ kind: 'visa', icon: 'plane', tone: 'info', title: req.t('attention.visa_appointment', { name: people.fullName(v) }), sub: fmt.formatDateTime(v.interview_at || v.biometrics_at, req.locale), href: `/staff/visa/${v.id}`, due: v.interview_at || v.biometrics_at }));
  }
  return out;
});

dashboard.page.kpis.push(async (req) => {
  if (!req.can('applications.view')) return [];
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [{ n: submitted }] = await apps.filtered(req.staff, { status: 'all' }).where('a.submitted_at', '>=', monthStart).count({ n: '*' });
  const [{ n: offers }] = await apps.filtered(req.staff, { status: 'all' }).where('a.offer_received_at', '>=', monthStart).count({ n: '*' });
  return [{ key: 'submitted', label: req.t('kpi.applications_submitted'), value: Number(submitted), href: '/staff/applications?view=list' }, { key: 'offers', label: req.t('kpi.offers'), value: Number(offers), href: '/staff/applications?view=list' }];
});

// ---- Student page tabs
tabs.add({ key: 'applications', icon: 'kanban', perms: ['applications.view'], order: 10, view: 'pages/staff/admissions/tab-applications',
  load: async (req, s) => ({ s, list: await apps.forStudent(req.staff, s.id), visaCases: req.can('visa.view') ? await visa.forStudent(req.staff, s.id) : [] }) });
tabs.add({ key: 'documents', icon: 'files', perms: ['documents.view'], order: 11, view: 'pages/staff/admissions/tab-documents',
  load: async (req, s) => { const list = await documents.checklist(s.id); return { s, list, summary: documents.summary(list), types: await stages.docTypes(), studentApps: await apps.forStudent(req.staff, s.id) }; } });

const router = express.Router();

// ================================================================== Applications
router.get('/applications', can('applications.view'), ah(async (req, res) => {
  const view = req.query.view === 'list' ? 'list' : 'board';
  const data = view === 'board' ? { board: await apps.board(req.staff, req.query) } : await apps.list(req.staff, req.query);
  res.page('pages/staff/admissions/applications', {
    layout: 'staff', title: req.t('nav.applications'), view, ...data, stageList: await stages.all(), counsellors: await employees.options(),
    universities: await knex('universities').orderBy('name_en').select('id', 'name_en', 'name_ar'), pageScripts: view === 'board' ? ['/js/kanban.js'] : [],
  });
}));

router.get('/applications/new', can('applications.manage'), ah(async (req, res) => {
  const student = req.query.student_id ? await students.get(req.staff, idParam(req.query.student_id)) : null;
  const program = req.query.program_id ? await knex('programs as p').join('universities as u', 'u.id', 'p.university_id').where('p.id', Number(req.query.program_id)).first('p.id', 'p.name_en', 'p.name_ar', 'u.name_en as uni_en', 'p.intakes', 'p.next_deadline') : null;
  const shortlisted = student ? await require('../catalog/shortlist.service').items({ studentId: student.id }) : { programs: [] }; // eslint-disable-line global-require
  res.page('pages/staff/admissions/application-new', { layout: 'staff', narrow: true, title: req.t('applications.new'), student, program, shortlisted: shortlisted.programs, stageList: (await stages.all()).filter((s) => s.is_active && !s.is_terminal), old: { stage_key: 'documents_pending', ...req.query } });
}));

const newSchema = z.object({
  student_id: z.coerce.number().int().positive('Required.'), program_id: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
  program_name: str(190), university_name: str(190), intake: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}$/).optional()), deadline: date(), stage_key: str(40),
});
router.post('/applications', can('applications.manage'), ah(async (req, res) => {
  const d = validate(newSchema, req.body);
  try {
    const app = await apps.create(req.ctx, req.staff, { studentId: d.student_id, programId: d.program_id || null, programName: d.program_name, universityName: d.university_name, intake: d.intake || null, deadline: d.deadline || null, stageKey: d.stage_key || 'shortlisting' });
    flash(req, 'ok', req.t('applications.created'));
    return res.redirect(`/staff/applications/${app.id}`);
  } catch (e) {
    if (e.code === 'APPLICATION_EXISTS') { flash(req, 'error', req.t('errors.APPLICATION_EXISTS')); return res.redirect(`/staff/applications/${e.details.id}`); }
    throw e;
  }
}));

async function appPage(req, res, a, extra = {}) {
  const [allStages, hist, docList, taskList, timeline, visaCases] = await Promise.all([
    stages.all(), apps.history(a.id), documents.checklist(a.student_id), tasks.forRecord({ applicationId: a.id }),
    activity.timeline({ studentId: a.student_id }, { limit: 300 }).then((rows) => rows.filter((r) => r.application_id === a.id)), visa.forStudent(req.staff, a.student_id),
  ]);
  const program = a.program_id ? await knex('programs').where({ id: a.program_id }).first('documents_required', 'min_ielts', 'min_gpa_pct', 'degree_level') : null;
  const student = await knex('students').where({ id: a.student_id }).first();
  // requirements still open: checklist documents not approved + profile gaps that the program checks
  const missing = docList.filter((d) => d.status !== 'approved').map((d) => ({ kind: 'doc', label: req.locale === 'ar' ? d.type_ar : d.type_en, status: d.status }));
  if (program && program.min_ielts && !student.ielts_overall && !student.toefl && !student.pte && !student.duolingo) missing.push({ kind: 'profile', label: req.t('applications.need_english') });
  if (program && program.min_gpa_pct && !student.gpa) missing.push({ kind: 'profile', label: req.t('applications.need_gpa') });
  res.page('pages/staff/admissions/application', {
    layout: 'staff', title: `${a.ref} · ${people.fullName(a)}`, a, allStages, hist, docSummary: documents.summary(docList), missing, taskList, timeline: activity.byDay(timeline), visaCases,
    assignees: await employees.options(), daysInStage: fmt.daysBetween(a.stage_entered_at), ...extra,
  });
}

router.get('/applications/:id', can('applications.view'), ah(async (req, res) => appPage(req, res, await apps.get(req.staff, idParam(req.params.id)))));

router.post('/applications/:id/stage', can('applications.manage'), ah(async (req, res) => {
  await apps.moveStage(req.ctx, req.staff, idParam(req.params.id), req.body.stage_id, { note: req.body.note, reason: req.body.reason });
  flash(req, 'ok', req.t('applications.stage_changed'));
  res.redirect(safeBack(req, `/staff/applications/${req.params.id}`));
}));

const updSchema = z.object({
  intake: z.preprocess((v) => (v === '' ? null : v), z.string().regex(/^\d{4}-\d{2}$/, 'Enter a valid date.').nullable().optional()), deadline: z.preprocess((v) => (v === '' ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()),
  next_action: z.preprocess((v) => (v === '' ? null : v), z.string().max(255).nullable().optional()), next_action_due: z.preprocess((v) => (v === '' ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()),
  university_ref: z.preprocess((v) => (v === '' ? null : v), z.string().max(80).nullable().optional()), portal_url: z.preprocess((v) => (v === '' ? null : v), z.string().url().max(500).nullable().optional()),
  priority: oneOf(['normal', 'high']), offer_type: oneOf(['none', 'conditional', 'unconditional', 'rejected']), offer_conditions: z.preprocess((v) => (v === '' ? null : v), z.string().max(4000).nullable().optional()),
  deposit_amount: z.preprocess((v) => (v === '' ? null : Number(v)), z.number().int().min(0).nullable().optional()), deposit_currency: z.preprocess((v) => (v === '' ? null : v), z.string().regex(/^[A-Z]{3}$/).nullable().optional()),
  deposit_due: z.preprocess((v) => (v === '' ? null : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()), cas_number: z.preprocess((v) => (v === '' ? null : v), z.string().max(80).nullable().optional()),
});
router.post('/applications/:id', can('applications.manage'), ah(async (req, res) => {
  const id = idParam(req.params.id);
  try {
    const d = validate(updSchema, req.body);
    await apps.update(req.ctx, req.staff, id, d);
    flash(req, 'ok', req.t('common.saved'));
    return res.redirect(`/staff/applications/${id}`);
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return appPage(req, res, await apps.get(req.staff, id), { errors: e.details, old: req.body });
  }
}));

router.post('/applications/:id/notes', can('applications.manage', 'notes.view'), ah(async (req, res) => {
  const a = await apps.get(req.staff, idParam(req.params.id));
  await notes.add(req.ctx, { studentId: a.student_id, applicationId: a.id }, { body: req.body.body, shareable: req.body.shareable === '1' && req.can('applications.manage') });
  flash(req, 'ok', req.t('notes.added'));
  res.redirect(`/staff/applications/${a.id}#timeline`);
}));

router.post('/applications/:id/tasks', can('applications.manage'), ah(async (req, res) => {
  const a = await apps.get(req.staff, idParam(req.params.id));
  const d = validate(require('../crm/forms').taskSchema, req.body); // eslint-disable-line global-require
  await tasks.create(req.ctx, { ...d, student_id: a.student_id, application_id: a.id, assignee_id: d.assignee_id || a.counsellor_id || req.staff.employee.id, due_at: d.due_at ? fmt.zonedToUtc(d.due_at.length === 10 ? `${d.due_at}T09:00` : d.due_at, res.locals.fmt.tz) : null });
  flash(req, 'ok', req.t('tasks.created'));
  res.redirect(`/staff/applications/${a.id}`);
}));

router.post('/applications/:id/delete', can('applications.manage'), ah(async (req, res) => {
  const a = await apps.get(req.staff, idParam(req.params.id));
  if (!req.can('students.delete')) throw E.forbidden('students.delete');
  await apps.remove(req.ctx, req.staff, a.id);
  flash(req, 'ok', req.t('common.deleted'));
  res.redirect(`/staff/students/${a.student_id}?tab=applications`);
}));

// ================================================================== Documents
async function studentFor(req, studentId) { return students.get(req.staff, studentId); } // scope check

router.get('/documents', can('documents.verify'), ah(async (req, res) => {
  const status = ['uploaded', 'under_review', 'rejected', 'missing', 'expired', 'approved'].includes(req.query.status) ? req.query.status : 'review';
  const q = knex('documents as d').join('students as s', 's.id', 'd.student_id').join('document_types as t', 't.key', 'd.type_key').leftJoin('applications as a', 'a.id', 'd.application_id');
  require('../rbac/rbac.service').scope(q, req.staff, { owner: 's.counsellor_id', branch: 's.branch_id' }); // eslint-disable-line global-require
  if (status === 'review') q.whereIn('d.status', ['uploaded', 'under_review']); else q.where('d.status', status);
  if (req.query.expiring === '1') q.where('d.status', 'approved').whereNotNull('d.expiry_date').whereRaw('d.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)');
  const rows = await q.select('d.*', 's.first_name', 's.last_name', 's.ref as student_ref', 't.name_en as type_en', 't.name_ar as type_ar', 'a.ref as application_ref').orderBy('d.uploaded_at').limit(200);
  res.page('pages/staff/admissions/documents', { layout: 'staff', title: req.t('nav.documents'), rows, status });
}));

router.post('/students/:id/documents/request', can('applications.manage', 'documents.verify', 'students.manage'), ah(async (req, res) => {
  const s = await studentFor(req, idParam(req.params.id));
  const d = validate(z.object({ type_key: reqStr(40), title: str(190), due_date: date(), application_id: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()), note: str(1000) }), req.body);
  await documents.request(req.ctx, s.id, { typeKey: d.type_key, title: d.title, dueDate: d.due_date, applicationId: d.application_id, note: d.note });
  flash(req, 'ok', req.t('documents.requested'));
  res.redirect(safeBack(req, `/staff/students/${s.id}?tab=documents`));
}));

allowMultipart(/^\/staff\/students\/\d+\/documents\/upload\/?$/);
router.post('/students/:id/documents/upload', can('applications.manage', 'documents.verify', 'students.manage'), uploads.single('file', { maxMb: 10 }), ah(async (req, res) => {
  const s = await studentFor(req, idParam(req.params.id));
  await documents.upload(req.ctx, s.id, req.file, { documentId: req.body.document_id ? Number(req.body.document_id) : null, typeKey: req.body.type_key || null, expiryDate: /^\d{4}-\d{2}-\d{2}$/.test(req.body.expiry_date || '') ? req.body.expiry_date : null });
  flash(req, 'ok', req.t('documents.uploaded'));
  res.redirect(safeBack(req, `/staff/students/${s.id}?tab=documents`));
}));

router.post('/documents/:id/review', can('documents.verify'), ah(async (req, res) => {
  const d = await documents.get(idParam(req.params.id));
  await studentFor(req, d.student_id);
  await documents.review(req.ctx, d.id, { decision: req.body.decision, reason: req.body.reason, expiryDate: /^\d{4}-\d{2}-\d{2}$/.test(req.body.expiry_date || '') ? req.body.expiry_date : null });
  flash(req, 'ok', req.t('documents.reviewed'));
  res.redirect(safeBack(req, `/staff/students/${d.student_id}?tab=documents`));
}));

router.post('/documents/:id/delete', can('documents.verify'), ah(async (req, res) => {
  const d = await documents.get(idParam(req.params.id));
  await studentFor(req, d.student_id);
  await documents.remove(req.ctx, d.id);
  flash(req, 'ok', req.t('common.deleted'));
  res.redirect(safeBack(req, `/staff/students/${d.student_id}?tab=documents`));
}));

// Files are served only to staff who may see the student; every download is audited.
router.get('/documents/:id/file', can('documents.view'), ah(async (req, res) => {
  const d = await documents.get(idParam(req.params.id));
  await studentFor(req, d.student_id);
  if (!d.media_id) throw E.notFound('File');
  await audit.record(req.ctx, 'document.viewed', { entityType: 'document', entityId: d.id });
  return uploads.send(res, d.media_id, { download: req.query.download === '1' });
}));

// ================================================================== Visa
router.get('/visa', can('visa.view'), ah(async (req, res) => {
  res.page('pages/staff/admissions/visa-list', { layout: 'staff', title: req.t('nav.visa'), rows: await visa.list(req.staff, req.query), stagesList: visa.STAGES });
}));

const visaSchema = z.object({
  visa_type: str(120), application_number: str(80), submitted_on: date(), biometrics_at: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional()),
  interview_at: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional()), medical: oneOf(['not_required', 'required', 'done']), medical_on: date(),
  travel_date: date(), visa_expiry: date(), officer_id: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()), notes: str(4000),
});

router.post('/students/:id/visa', can('visa.manage'), ah(async (req, res) => {
  const s = await studentFor(req, idParam(req.params.id));
  const d = validate(z.object({ country_code: z.enum(ref.ISO), visa_type: str(120), application_id: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()) }), req.body);
  const id = await visa.create(req.ctx, req.staff, { studentId: s.id, applicationId: d.application_id || null, countryCode: d.country_code, visaType: d.visa_type || null, officerId: req.staff.employee.roleKey === 'visa_officer' ? req.staff.employee.id : null });
  flash(req, 'ok', req.t('visa.created'));
  res.redirect(`/staff/visa/${id}`);
}));

router.get('/visa/:id', can('visa.view'), ah(async (req, res) => {
  const v = await visa.get(req.staff, idParam(req.params.id));
  const docList = (await documents.checklist(v.student_id)).filter((d) => d.visa_case_id === v.id || d.category === 'visa' || d.category === 'financial' || d.type_key === 'passport');
  const timeline = (await activity.timeline({ studentId: v.student_id }, { limit: 300, types: ['visa'] }));
  res.page('pages/staff/admissions/visa', { layout: 'staff', title: `${v.ref} · ${people.fullName(v)}`, v, docList, types: await stages.docTypes(), timeline: activity.byDay(timeline), officers: await employees.options(), stagesList: visa.STAGES });
}));

router.post('/visa/:id', can('visa.manage'), ah(async (req, res) => {
  const id = idParam(req.params.id);
  const d = validate(visaSchema, req.body);
  const tz = res.locals.fmt.tz;
  const row = { ...d, biometrics_at: d.biometrics_at ? fmt.zonedToUtc(d.biometrics_at, tz) : null, interview_at: d.interview_at ? fmt.zonedToUtc(d.interview_at, tz) : null };
  for (const k of ['visa_type', 'application_number', 'submitted_on', 'medical_on', 'travel_date', 'visa_expiry', 'notes', 'officer_id']) if (row[k] === undefined) row[k] = null;
  await visa.update(req.ctx, req.staff, id, row);
  flash(req, 'ok', req.t('common.saved'));
  res.redirect(`/staff/visa/${id}`);
}));

router.post('/visa/:id/stage', can('visa.manage'), ah(async (req, res) => {
  await visa.moveStage(req.ctx, req.staff, idParam(req.params.id), String(req.body.stage), { reason: req.body.refusal_reason });
  flash(req, 'ok', req.t('visa.stage_changed'));
  res.redirect(`/staff/visa/${req.params.id}`);
}));

module.exports = router;
