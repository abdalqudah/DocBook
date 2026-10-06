// Student portal (/portal): a calm home with the journey and the next action, a step-by-step profile, matched
// programs, shortlist, applications with their timeline, documents (upload / replace), appointments, messages with
// the counsellor, payments, notifications and settings (preferences, password, data export). Every query is
// limited to the signed-in student's own records.
const express = require('express');
const knex = require('../../db/knex');
const config = require('../../config');
const fmt = require('../../core/format');
const audit = require('../../core/audit');
const uploads = require('../../core/uploads');
const { requireStudent } = require('../../middleware/auth');
const { flash, allowMultipart } = require('../../middleware/web');
const { ah, idParam } = require('../../core/http');
const { E } = require('../../core/errors');
const { validate, z, reqStr, password } = require('../../core/validate');
const forms = require('../crm/forms');
const students = require('../crm/students.service');
const shortlist = require('../catalog/shortlist.service');
const matching = require('../catalog/matching.service');
const documents = require('../admissions/documents.service');
const apps = require('../admissions/applications.service');
const comms = require('../comms/comms.service');
const notifications = require('../notifications/service');
const ref = require('../catalog/reference');
const account = require('./account');
require('../notifications/handlers');

const router = express.Router();
const SELF = { employee: { dataScope: 'all', id: null }, permissions: new Set() }; // scope is enforced by the student id below
const STEPS = ['personal', 'academic', 'english', 'goals', 'history'];
const JOURNEY = ['profile', 'counselling', 'program_selection', 'documents', 'application', 'offer', 'visa', 'pre_departure', 'enrolled'];
const NAV = [
  { key: 'home', href: '/portal', icon: 'house', exact: true, bottom: true },
  { key: 'programs', href: '/portal/programs', icon: 'search', bottom: true },
  { key: 'shortlist', href: '/portal/shortlist', icon: 'bookmark' },
  { key: 'applications', href: '/portal/applications', icon: 'kanban', bottom: true },
  { key: 'documents', href: '/portal/documents', icon: 'files', bottom: true },
  { key: 'appointments', href: '/portal/appointments', icon: 'calendar-check' },
  { key: 'messages', href: '/portal/messages', icon: 'message-circle', bottom: true },
];

router.use(requireStudent);
router.use(ah(async (req, res, next) => {
  const s = await account.studentOf(req);
  if (!s) throw E.notFound('Student record'); // an account without a CRM record (should not happen after verification)
  req.student = s;
  const path = req.originalUrl.split('?')[0];
  const unreadMsgs = Number((await knex('messages').where({ student_id: s.id, direction: 'out' }).where('channel', 'portal').whereNull('read_at').count({ n: '*' }))[0].n);
  res.locals.portalNav = NAV.map((i) => ({ ...i, current: i.exact ? path === i.href : path === i.href || path.startsWith(`${i.href}/`), count: i.key === 'messages' ? unreadMsgs : 0 }));
  res.locals.student = s;
  res.locals.state = { saved: await shortlist.ids({ studentId: s.id }), comparing: require('../catalog/compare.service').current(req) }; // eslint-disable-line global-require
  res.locals.unreadNotifications = await notifications.unread(req.user.id);
  next();
}));

/** Journey score: profile, program choice, documents, application and visa, each weighted. */
async function journeyOf(s) {
  const profile = students.completion(s).percent;
  const docs = documents.summary(await documents.checklist(s.id));
  const myApps = await knex('applications as a').join('application_stages as st', 'st.id', 'a.stage_id').where('a.student_id', s.id).whereNot('a.status', 'withdrawn').select('a.*', 'st.key as stage_key', 'st.position', 'st.name_en as stage_en', 'st.name_ar as stage_ar');
  const stagesAll = await knex('application_stages').orderBy('position');
  const pos = (k) => (stagesAll.find((x) => x.key === k) || {}).position || 0;
  const best = myApps.reduce((m, a) => Math.max(m, a.position), 0);
  const appPct = myApps.length ? Math.min(100, Math.round(((best - pos('application_ready')) / Math.max(1, pos('unconditional_offer') - pos('application_ready'))) * 100)) : 0;
  const visa = await knex('visa_cases').where({ student_id: s.id }).orderBy('id', 'desc').first('stage');
  const visaPct = visa ? ({ preparing: 10, documents_pending: 20, ready: 40, submitted: 60, biometrics: 70, interview: 80, processing: 85, approved: 100, refused: 0, withdrawn: 0 }[visa.stage] || 0) : 0;
  const shortlisted = Number((await knex('shortlist_items').where({ student_id: s.id }).count({ n: '*' }))[0].n);
  const program = myApps.length ? 100 : (shortlisted ? 50 : 0);
  const parts = [['profile', profile, 20], ['program', program, 15], ['documents', docs.total ? docs.percent : 0, 25], ['application', Math.max(0, appPct), 25], ['visa', visaPct, 15]];
  const score = Math.round(parts.reduce((t, [, v, w]) => t + (v * w) / 100, 0));
  return { score, parts: parts.map(([k, v]) => ({ key: k, value: Math.max(0, Math.min(100, v)) })), docs, apps: myApps, visa, profile };
}

/** The single most useful next step for the student. */
function nextAction(s, j, upcoming) {
  if (j.profile < 100) return { key: 'complete_profile', href: `/portal/profile/${STEPS.find((st) => students.SECTIONS[st].some((f) => students.completion(s).missing.includes(f) || (f === 'passport' && students.completion(s).missing.includes('passport_last4')) || (st === 'english' && students.completion(s).missing.includes('english')))) || 'personal'}` };
  if (j.docs.missing) return { key: 'upload_documents', href: '/portal/documents', vars: { n: j.docs.missing } };
  if (!upcoming && ['profile', 'counselling'].includes(s.journey_stage)) return { key: 'book_consultation', href: '/book/schedule' };
  if (!j.apps.length) return { key: 'choose_programs', href: '/portal/programs' };
  return { key: 'track_applications', href: '/portal/applications' };
}

router.get('/', ah(async (req, res) => {
  const s = req.student;
  const j = await journeyOf(s);
  const upcoming = await knex('appointments as a').join('appointment_types as t', 't.id', 'a.type_id').leftJoin('employees as e', 'e.id', 'a.employee_id').leftJoin('users as u', 'u.id', 'e.user_id')
    .where('a.student_id', s.id).whereIn('a.status', ['scheduled', 'confirmed']).where('a.start_at', '>', new Date()).orderBy('a.start_at').first('a.*', 't.name_en', 't.name_ar', 'u.name as counsellor');
  const counsellor = s.counsellor_id ? await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('e.id', s.counsellor_id).first('u.name', 'e.job_title', 'e.photo') : null;
  const recs = j.profile >= 40 ? (await matching.forStudent(s.id, { limit: 3 })) : [];
  const msgs = await knex('messages').where({ student_id: s.id, channel: 'portal' }).orderBy('id', 'desc').limit(2);
  res.page('pages/portal/home', { layout: 'portal', title: req.t('portal.home'), j, next: nextAction(s, j, upcoming), upcoming, counsellor, recs, msgs, journey: JOURNEY });
}));

// ------------------------------------------------------------------ Profile (step by step)
router.get('/profile', ah(async (req, res) => {
  const c = students.completion(req.student);
  res.page('pages/portal/profile', { layout: 'portal', title: req.t('portal.profile'), c, steps: STEPS, s: req.student });
}));
router.get('/profile/:step', ah(async (req, res) => {
  const step = STEPS.includes(req.params.step) ? req.params.step : null;
  if (!step) throw E.notFound();
  const s = req.student;
  const parse = (v) => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v || '[]'); } catch { return []; } })());
  res.page('pages/portal/step', { layout: 'portal', narrow: true, title: req.t(`portal.step_${step}`), step, steps: STEPS, s: { ...s, pref_countries: parse(s.pref_countries), pref_fields: parse(s.pref_fields) }, destinations: await ref.destinationOptions(req.locale), old: {}, errors: {} });
}));
router.post('/profile/:step', ah(async (req, res) => {
  const step = STEPS.includes(req.params.step) ? req.params.step : null;
  if (!step) throw E.notFound();
  try {
    const parsed = validate(forms.studentSections[step], req.body);
    const data = forms.blanksToNull(step, req.body, parsed);
    if (step === 'personal') delete data.email; // the sign-in address is changed by GEC staff, not here
    await students.update({ userId: req.user.id, ip: req.ip }, SELF, req.student.id, data, { section: step });
    const nextStep = STEPS[STEPS.indexOf(step) + 1];
    flash(req, 'ok', req.t('common.saved'));
    return res.redirect(req.body.finish === '1' || !nextStep ? '/portal/programs?welcome=1' : `/portal/profile/${nextStep}`);
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    return res.page('pages/portal/step', { layout: 'portal', narrow: true, title: req.t(`portal.step_${step}`), step, steps: STEPS, s: req.student, destinations: await ref.destinationOptions(req.locale), old: req.body, errors: e.details });
  }
}));

// ------------------------------------------------------------------ Programs & shortlist
router.get('/programs', ah(async (req, res) => {
  const recs = await matching.forStudent(req.student.id, { limit: 12 });
  res.page('pages/portal/programs', { layout: 'portal', title: req.t('portal.nav.programs'), recs, c: students.completion(req.student), welcome: req.query.welcome === '1' });
}));
router.get('/shortlist', ah(async (req, res) => {
  const items = await shortlist.items({ studentId: req.student.id });
  res.page('pages/portal/shortlist', { layout: 'portal', title: req.t('portal.nav.shortlist'), items });
}));

// ------------------------------------------------------------------ Applications
router.get('/applications', ah(async (req, res) => {
  const j = await journeyOf(req.student);
  res.page('pages/portal/applications', { layout: 'portal', title: req.t('portal.nav.applications'), list: j.apps });
}));
router.get('/applications/:id', ah(async (req, res) => {
  const a = await knex('applications as a').join('application_stages as st', 'st.id', 'a.stage_id').where('a.id', idParam(req.params.id)).where('a.student_id', req.student.id).first('a.*', 'st.key as stage_key', 'st.name_en as stage_en', 'st.name_ar as stage_ar', 'st.position');
  if (!a) throw E.notFound('Application');
  const stagesAll = await knex('application_stages').where({ is_active: true }).orderBy('position');
  const hist = await apps.history(a.id);
  const docs = (await documents.checklist(req.student.id)).filter((d) => !d.application_id || d.application_id === a.id);
  const shared = await knex('activities').where({ application_id: a.id, is_shareable: true }).orderBy('occurred_at', 'desc').limit(30);
  res.page('pages/portal/application', { layout: 'portal', title: a.program_name || a.ref, a, stagesAll, hist, docs, shared });
}));

// ------------------------------------------------------------------ Documents
router.get('/documents', ah(async (req, res) => {
  const list = await documents.checklist(req.student.id);
  res.page('pages/portal/documents', { layout: 'portal', title: req.t('portal.nav.documents'), list, sum: documents.summary(list) });
}));
allowMultipart(/^\/portal\/documents\/upload\/?$/);
router.post('/documents/upload', uploads.single('file', { maxMb: 10 }), ah(async (req, res) => {
  const docId = /^\d+$/.test(req.body.document_id || '') ? Number(req.body.document_id) : null;
  if (!docId) throw E.validation({ document_id: 'Choose the document.' });
  const d = await documents.get(docId);
  if (d.student_id !== req.student.id) throw E.notFound('Document');
  if (d.status === 'approved') throw E.validation({ document_id: 'This document is already approved.' });
  await documents.upload({ userId: req.user.id, ip: req.ip }, req.student.id, req.file, { documentId: d.id, expiryDate: /^\d{4}-\d{2}-\d{2}$/.test(req.body.expiry_date || '') ? req.body.expiry_date : null, byStudent: true });
  flash(req, 'ok', req.t('portal.uploaded'));
  res.redirect('/portal/documents');
}));
router.get('/documents/:id/file', ah(async (req, res) => {
  const d = await documents.get(idParam(req.params.id));
  if (d.student_id !== req.student.id || !d.media_id) throw E.notFound('File');
  return uploads.send(res, d.media_id, { download: req.query.download === '1' });
}));

// ------------------------------------------------------------------ Appointments
router.get('/appointments', ah(async (req, res) => {
  const rows = await knex('appointments as a').join('appointment_types as t', 't.id', 'a.type_id').leftJoin('employees as e', 'e.id', 'a.employee_id').leftJoin('users as u', 'u.id', 'e.user_id')
    .where('a.student_id', req.student.id).whereNot('a.status', 'rescheduled').orderBy('a.start_at', 'desc').limit(50).select('a.*', 't.name_en', 't.name_ar', 'u.name as counsellor');
  const now = new Date();
  res.page('pages/portal/appointments', { layout: 'portal', title: req.t('portal.nav.appointments'), upcoming: rows.filter((a) => new Date(a.start_at) > now && ['scheduled', 'confirmed'].includes(a.status)).reverse(), past: rows.filter((a) => !(new Date(a.start_at) > now && ['scheduled', 'confirmed'].includes(a.status))) });
}));

// ------------------------------------------------------------------ Messages
router.get('/messages', ah(async (req, res) => {
  const thread = await knex('messages as m').leftJoin('users as u', 'u.id', 'm.sent_by').where('m.student_id', req.student.id).where('m.channel', 'portal').orderBy('m.id').limit(200).select('m.*', 'u.name as sender_name');
  await knex('messages').where({ student_id: req.student.id, channel: 'portal', direction: 'out' }).whereNull('read_at').update({ read_at: new Date() });
  const counsellor = req.student.counsellor_id ? await knex('employees as e').join('users as u', 'u.id', 'e.user_id').where('e.id', req.student.counsellor_id).first('u.name') : null;
  res.page('pages/portal/messages', { layout: 'portal', title: req.t('portal.nav.messages'), thread, counsellor });
}));
router.post('/messages', ah(async (req, res) => {
  const d = validate(z.object({ body: reqStr(4000) }), req.body);
  await comms.fromStudent(req.student.id, d.body, req.user.id);
  res.redirect('/portal/messages#latest');
}));

// ------------------------------------------------------------------ Payments
router.get('/payments', ah(async (req, res) => {
  const invoices = await knex('invoices').where({ student_id: req.student.id }).whereNot('status', 'draft').orderBy('id', 'desc');
  const payments = await knex('payments').where({ student_id: req.student.id }).orderBy('received_on', 'desc');
  res.page('pages/portal/payments', { layout: 'portal', title: req.t('portal.payments'), invoices, payments });
}));

// ------------------------------------------------------------------ Notifications & settings
router.get('/notifications', ah(async (req, res) => {
  const list = await notifications.list(req.user.id, { page: Math.max(1, Number(req.query.page) || 1) });
  res.page('pages/portal/notifications', { layout: 'portal', title: req.t('nav.notifications'), list });
}));
router.post('/notifications/read', ah(async (req, res) => {
  await notifications.markRead(req.user.id, /^\d+$/.test(req.body.id || '') ? Number(req.body.id) : null);
  const n = /^\d+$/.test(req.body.id || '') ? await knex('notifications').where({ id: Number(req.body.id), user_id: req.user.id }).first('href') : null;
  res.redirect(n && n.href && n.href.startsWith('/') && !n.href.startsWith('//') ? n.href : '/portal/notifications');
}));

router.get('/settings', ah(async (req, res) => {
  const user = await knex('users').where({ id: req.user.id }).first();
  res.page('pages/portal/settings', { layout: 'portal', narrow: true, title: req.t('portal.settings'), prefs: notifications.prefsOf(user), categories: notifications.CATEGORIES, channels: await require('../comms/channels').status(), s: req.student, errors: {} }); // eslint-disable-line global-require
}));
router.post('/settings/notifications', ah(async (req, res) => {
  const user = await knex('users').where({ id: req.user.id }).first();
  const prefs = notifications.prefsOf(user);
  for (const c of notifications.CATEGORIES) for (const ch of notifications.EXTERNAL) prefs.categories[c][ch] = [].concat(req.body[`${c}_${ch}`] || []).includes('1');
  const marketing = [].concat(req.body.marketing || []).includes('1');
  prefs.marketing = marketing;
  await knex('users').where({ id: req.user.id }).update({ notification_prefs: JSON.stringify(prefs) });
  await knex('students').where({ id: req.student.id }).update(marketing ? { consent_marketing: true, consent_marketing_at: new Date(), unsubscribed_at: null } : { consent_marketing: false, unsubscribed_at: req.student.consent_marketing ? new Date() : req.student.unsubscribed_at });
  await audit.record({ userId: req.user.id, ip: req.ip }, 'portal.preferences', { entityType: 'user', entityId: req.user.id, newValues: { marketing } });
  flash(req, 'ok', req.t('common.saved'));
  res.redirect('/portal/settings');
}));
router.post('/settings/language', ah(async (req, res) => {
  const l = req.body.locale === 'ar' ? 'ar' : 'en';
  await knex('users').where({ id: req.user.id }).update({ locale: l });
  await knex('students').where({ id: req.student.id }).update({ preferred_locale: l });
  res.redirect(`/portal/settings?lang=${l}`);
}));
router.post('/settings/password', ah(async (req, res) => {
  const auth = require('../auth/auth.service'); // eslint-disable-line global-require
  try {
    if (req.body.password !== req.body.password_confirm) throw E.validation({ password_confirm: 'Passwords do not match.' });
    const { pw } = validate(z.object({ pw: password() }), { pw: req.body.password });
    await auth.changePassword({ userId: req.user.id, ip: req.ip }, req.user.id, req.body.current_password, pw, req.sessionID);
    flash(req, 'ok', req.t('auth.password_changed'));
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    flash(req, 'error', Object.values(e.details || {}).join(' '));
  }
  res.redirect('/portal/settings');
}));

// GDPR-style export: everything GEC holds about the student, as JSON (internal staff notes excluded).
router.get('/settings/export', ah(async (req, res) => {
  const s = req.student;
  const strip = (row) => { const r = { ...row }; ['passport_enc', 'passport_hash', 'merged_into_id'].forEach((k) => delete r[k]); return r; };
  const data = {
    exported_at: new Date().toISOString(), student: strip(s),
    applications: await knex('applications').where({ student_id: s.id }).select('ref', 'program_name', 'university_name', 'intake', 'status', 'created_at', 'updated_at'),
    documents: await knex('documents as d').join('document_types as t', 't.key', 'd.type_key').where('d.student_id', s.id).select('t.name_en as type', 'd.status', 'd.uploaded_at', 'd.expiry_date', 'd.rejection_reason'),
    appointments: await knex('appointments').where({ student_id: s.id }).select('ref', 'start_at', 'status', 'mode'),
    messages: await knex('messages').where({ student_id: s.id }).select('channel', 'direction', 'subject', 'body', 'created_at'),
    shortlist: await knex('shortlist_items').where({ student_id: s.id }).select('item_type', 'item_id', 'created_at'),
    payments: await knex('payments').where({ student_id: s.id }).select('receipt_no', 'amount', 'currency', 'method', 'received_on', 'status'),
    shared_updates: await knex('activities').where({ student_id: s.id, is_shareable: true }).select('type', 'title', 'occurred_at'),
  };
  await audit.record({ userId: req.user.id, ip: req.ip }, 'privacy.exported', { entityType: 'student', entityId: s.id });
  res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="gec-my-data-${s.ref}.json"` });
  res.send(JSON.stringify(data, null, 2));
}));

router.get('/advisor', ah(async (req, res) => {
  res.page('pages/portal/advisor', { layout: 'portal', pageScripts: ['/js/advisor.js'], title: req.t('advisor.title'), aiConnected: !!(await require('../ai/provider').currentConfig()) }); // eslint-disable-line global-require
}));

module.exports = router;
