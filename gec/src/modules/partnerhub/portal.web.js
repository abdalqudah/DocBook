// /partner — the university's own portal: dashboard, programs, scholarships, university profile, submissions,
// applications GEC sends them, and their team. Everything they change is submitted for GEC review.
const express = require('express');
const knex = require('../../db/knex');
const uploads = require('../../core/uploads');
const { allowMultipart, flash } = require('../../middleware/web');
const { ah, idParam } = require('../../core/http');
const { E } = require('../../core/errors');
const { z, validate } = require('../../core/validate');
const ref = require('../catalog/reference');
const money = require('../catalog/money');
const svc = require('./service');

const router = express.Router();
const NAV = [
  { key: 'dashboard', href: '/partner', icon: 'layout-dashboard', exact: true },
  { key: 'programs', href: '/partner/programs', icon: 'graduation-cap' },
  { key: 'scholarships', href: '/partner/scholarships', icon: 'award' },
  { key: 'profile', href: '/partner/profile', icon: 'building-2' },
  { key: 'submissions', href: '/partner/submissions', icon: 'inbox' },
  { key: 'applications', href: '/partner/applications', icon: 'file-check' },
  { key: 'team', href: '/partner/team', icon: 'users' },
];
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// Signed-in partner users only, bound to their own university.
router.use(ah(async (req, res, next) => {
  if (!req.user || req.user.kind !== 'partner') {
    if (req.method === 'GET') req.session.returnTo = req.originalUrl;
    return res.redirect('/partner/login');
  }
  const m = await svc.membership(req.user.id);
  if (!m) throw E.forbidden('partner');
  req.partner = m;
  const pending = Number((await knex('partner_submissions').where({ university_id: m.university_id }).whereIn('status', ['pending', 'changes_requested']).count({ n: '*' }))[0].n);
  const path = req.originalUrl.split('?')[0];
  res.locals.partnerNav = NAV.map((i) => ({ ...i, current: i.exact ? path === i.href : path === i.href || path.startsWith(`${i.href}/`), count: i.key === 'submissions' ? pending : 0 }));
  res.locals.uni = { id: m.university_id, slug: m.slug, name_en: m.name_en, name_ar: m.name_ar, logo: m.logo };
  return next();
}));
const page = (res, view, data) => res.page(`pages/partner/${view}`, { layout: 'partner', ...data });
const uniId = (req) => req.partner.university_id;

router.get('/', ah(async (req, res) => {
  const id = uniId(req);
  const [programs, scholarships, subs, apps, agreement] = await Promise.all([
    knex('programs').where({ university_id: id, is_active: true }).count({ n: '*' }),
    knex('scholarships').where({ university_id: id, is_active: true }).count({ n: '*' }),
    knex('partner_submissions').where({ university_id: id }).orderBy('id', 'desc').limit(6),
    knex('applications as a').join('application_stages as s', 's.id', 'a.stage_id').where('a.university_id', id).groupBy('s.key', 's.name_en', 's.name_ar', 's.position').orderBy('s.position').select('s.key', 's.name_en', 's.name_ar').count({ n: '*' }),
    knex('partners').where({ university_id: id }).whereIn('status', ['active', 'pending']).orderBy('id', 'desc').first('commission_type', 'commission_rate', 'currency', 'status'),
  ]);
  page(res, 'dashboard', { title: req.t('partnerp.nav.dashboard'), stats: { programs: Number(programs[0].n), scholarships: Number(scholarships[0].n), pending: subs.filter((s) => s.status === 'pending').length }, subs: subs.map((s) => ({ ...s, data: parseJson(s.data) })), apps, agreement });
}));

// ------------------------------------------------------------------ programs & scholarships
for (const [entity, plural] of [['program', 'programs'], ['scholarship', 'scholarships']]) {
  const table = svc.TABLE[entity];
  router.get(`/${plural}`, ah(async (req, res) => {
    const rows = await knex(table).where({ university_id: uniId(req) }).orderBy('name_en');
    const subs = await knex('partner_submissions').where({ university_id: uniId(req), entity }).whereIn('status', ['pending', 'changes_requested']);
    const fresh = subs.filter((s) => !s.entity_id).map((s) => ({ ...s, data: parseJson(s.data) }));
    page(res, 'list', { title: req.t(`partnerp.nav.${plural}`), entity, plural, rows, pendingFor: Object.fromEntries(subs.filter((s) => s.entity_id).map((s) => [s.entity_id, s.status])), fresh });
  }));
  const formData = async (req, id) => {
    const open = await knex('partner_submissions').where({ university_id: uniId(req), entity }).whereIn('status', ['pending', 'changes_requested']).modify((q) => (id ? q.where('entity_id', id) : q.whereNull('entity_id'))).orderBy('id', 'desc').first();
    if (id) {
      const row = await svc.ownedRow(uniId(req), entity, id);
      const base = { ...row }; svc.JSON_FIELDS.forEach((f) => { if (typeof base[f] === 'string') { try { base[f] = JSON.parse(base[f]); } catch { base[f] = []; } } });
      return { row: open ? { ...base, ...parseJson(open.data) } : base, open };
    }
    return { row: { is_active: true, currency: req.partner.uni_currency || 'USD' }, open: null };
  };
  const renderForm = async (req, res, id, extra = {}) => {
    const { row, open } = await formData(req, id);
    page(res, 'form', { title: id ? (row.name_en || '') : req.t(`partnerp.new_${entity}`), narrow: true, entity, plural, id, row, open, currencies: await money.codes(), refs: { DEGREES: ref.DEGREES, FIELDS: ref.FIELDS, STUDY_MODES: ref.STUDY_MODES }, errors: {}, old: {}, ...extra });
  };
  router.get(`/${plural}/new`, ah((req, res) => renderForm(req, res, null)));
  router.get(`/${plural}/:id`, ah((req, res) => renderForm(req, res, idParam(req.params.id))));
  const save = (id) => ah(async (req, res) => {
    try {
      await svc.submit({ userId: req.user.id, ip: req.ip }, uniId(req), entity, id ? id(req) : null, req.body);
      flash(req, 'ok', req.t('partnerp.submitted'));
      return res.redirect(`/partner/${plural}`);
    } catch (e) {
      if (e.code !== 'VALIDATION_FAILED') throw e;
      res.status(422);
      return renderForm(req, res, id ? id(req) : null, { errors: e.details, old: req.body });
    }
  });
  router.post(`/${plural}`, save(null));
  router.post(`/${plural}/:id`, save((req) => idParam(req.params.id)));
}

// ------------------------------------------------------------------ university profile (+ logo / cover upload)
router.get('/profile', ah(async (req, res) => {
  const u = await knex('universities').where({ id: uniId(req) }).first();
  const open = await knex('partner_submissions').where({ university_id: uniId(req), entity: 'university' }).whereIn('status', ['pending', 'changes_requested']).orderBy('id', 'desc').first();
  const row = { ...u, intakes: (() => { try { return JSON.parse(u.intakes || '[]'); } catch { return []; } })(), ...(open ? parseJson(open.data) : {}) };
  page(res, 'profile', { title: req.t('partnerp.nav.profile'), narrow: true, row, open, errors: {}, old: {} });
}));
router.post('/profile', ah(async (req, res) => {
  try {
    await mergeSubmit(req, req.body);
    flash(req, 'ok', req.t('partnerp.submitted'));
    return res.redirect('/partner/profile');
  } catch (e) {
    if (e.code !== 'VALIDATION_FAILED') throw e;
    res.status(422);
    const u = await knex('universities').where({ id: uniId(req) }).first();
    return page(res, 'profile', { title: req.t('partnerp.nav.profile'), narrow: true, row: u, open: null, errors: e.details, old: req.body });
  }
}));
/** Profile changes accumulate in one open submission (text edits and new images together). */
async function mergeSubmit(req, body) {
  const open = await knex('partner_submissions').where({ university_id: uniId(req), entity: 'university' }).whereIn('status', ['pending', 'changes_requested']).orderBy('id', 'desc').first();
  const merged = { ...(open ? parseJson(open.data) : {}), ...Object.fromEntries(Object.entries(body).filter(([k]) => k !== '_csrf')) };
  return svc.submit({ userId: req.user.id, ip: req.ip }, uniId(req), 'university', null, merged);
}
allowMultipart(/^\/partner\/profile\/image\/?$/);
router.post('/profile/image', uploads.single('file', { maxMb: 8 }), ah(async (req, res) => {
  const kind = req.body.kind === 'cover' ? 'cover_image' : 'logo';
  const media = require('../cms/media.service'); // eslint-disable-line global-require
  const id = await media.upload({ userId: req.user.id, ip: req.ip }, req.file, { alt_en: `${req.partner.name_en} ${kind === 'logo' ? 'logo' : 'campus'}` });
  await mergeSubmit(req, { [kind]: `/media/${id}` });
  flash(req, 'ok', req.t('partnerp.image_submitted'));
  res.redirect('/partner/profile');
}));

// ------------------------------------------------------------------ submissions, applications, team
router.get('/submissions', ah(async (req, res) => {
  const rows = (await knex('partner_submissions').where({ university_id: uniId(req) }).orderBy('id', 'desc').limit(200)).map((s) => ({ ...s, data: parseJson(s.data) }));
  page(res, 'submissions', { title: req.t('partnerp.nav.submissions'), rows });
}));

router.get('/applications', ah(async (req, res) => {
  const rows = await knex('applications as a').join('students as s', 's.id', 'a.student_id').join('application_stages as st', 'st.id', 'a.stage_id')
    .where('a.university_id', uniId(req)).orderBy('a.updated_at', 'desc').limit(300)
    .select('a.id', 'a.ref', 'a.program_name', 'a.intake', 'a.university_ref', 'a.updated_at', 's.first_name', 's.last_name', 's.nationality', 'st.key as stage_key', 'st.name_en as stage_en', 'st.name_ar as stage_ar');
  page(res, 'applications', { title: req.t('partnerp.nav.applications'), rows });
}));

router.get('/team', ah(async (req, res) => {
  const rows = await knex('partner_members as m').join('users as u', 'u.id', 'm.user_id').where('m.university_id', uniId(req)).orderBy('u.name').select('m.id', 'm.role', 'm.job_title', 'u.name', 'u.email', 'u.last_login_at', 'u.status');
  page(res, 'team', { title: req.t('partnerp.nav.team'), rows, isOwner: req.partner.role === 'owner' });
}));
router.post('/team', ah(async (req, res) => {
  if (req.partner.role !== 'owner') throw E.forbidden('owner');
  const d = validate(z.object({ name: z.string().trim().min(2).max(160), email: z.string().trim().email().max(190), job_title: z.string().trim().max(120).optional() }), req.body);
  const { link } = await svc.invite({ userId: req.user.id, ip: req.ip }, { universityId: uniId(req), name: d.name, email: d.email, role: 'editor', jobTitle: d.job_title || null });
  if (link) await require('./mail').sendInvite(d.email, d.name, link, req.partner.name_en); // eslint-disable-line global-require
  flash(req, 'ok', req.t('partnerp.invited'));
  res.redirect('/partner/team');
}));

module.exports = router;
