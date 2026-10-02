// Support tickets, staff presence, notification e-mail/sound settings, doctor e-mails to patients (worker: teamops)
//   /app/tickets                       internal support tickets (every member; managers see all)
//   /app/teamops/unread|heartbeat|presence   JSON for public/js/teamops.js (bell count + chime, presence)
//   /app/settings/notifications        e-mail per event (settings.manage) + personal sound / presence
//   /app/teamops/patient-email         compose context (JSON) and send an e-mail to a patient
const express = require('express');
const { wrap, form, flash, back } = require('../../routes/helpers');
const { can, canAny } = require('../../middleware/context');
const { AppError } = require('../../core/errors');
const { render: settingsRender } = require('../settings/common');
const notifications = require('../notifications/notification.service');
const rbac = require('../rbac/rbac.service');
const tickets = require('./tickets.service');
const presence = require('./presence.service');
const notifyMail = require('./notify-mail');
const patientMail = require('./patient-mail.service');

const router = express.Router();
router.use(presence.middleware); // page loads that reach this router; the tab's heartbeat covers the rest

const ASSETS = { pageStyles: ['/css/teamops.css'] }; // teamops.js is loaded on every page by layouts/app.ejs

/** Error text for this module's own codes (errors_teamops.*), else the shared table, else the message. */
function errText(req, err) {
  const own = req.t(`errors_teamops.${err.code}`);
  if (own !== `errors_teamops.${err.code}`) return own;
  const shared = req.t(`errors.${err.code}`);
  return shared !== `errors.${err.code}` ? shared : err.message;
}
function withOwnErrors(req, extra) {
  if (extra && extra.formError) extra.formError.message = errText(req, extra.formError);
  return extra;
}
/** Runs an action that redirects; expected errors become a flash message on the way back. */
const act = (fn, fallback) => wrap(async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (!(err instanceof AppError) || err.status >= 500 && err.status !== 502 || err.status === 401) throw err;
    if (err.status === 404) throw err;
    const details = err.code === 'VALIDATION_FAILED' && err.details ? Object.values(err.details).map((m) => require('../../core/i18n').translateMessage(req.locale, m)).join(' ') : ''; // eslint-disable-line global-require
    flash(req, 'error', details || errText(req, err));
    back(req, res, typeof fallback === 'function' ? fallback(req) : fallback);
  }
});

// ---------------------------------------------------------------- presence & bell (JSON)
router.post('/teamops/heartbeat', wrap(async (req, res) => {
  await presence.touch(req.ctx, { force: false });
  res.json({ ok: true });
}));

router.get('/teamops/unread', wrap(async (req, res) => {
  const [count, latest, prefs, chat] = await Promise.all([
    notifications.unreadCount(req.ctx), notifications.list(req.ctx, { limit: 1, unreadOnly: true }), presence.prefs(req.ctx.userId),
    require('../chat/chat.service').unreadTotal(req.ctx).catch(() => 0), // eslint-disable-line global-require
  ]);
  // The newest unread "the doctor called a patient in" (reception rings and shows it, whatever the sound setting).
  const callRow = req.ctx.permissions.has('frontdesk.use') ? await notifications.list(req.ctx, { limit: 1, unreadOnly: true, type: 'patient.called_in' }) : [];
  const call = callRow.length ? require('../notifications/web').readable(req, callRow)[0] : null; // eslint-disable-line global-require
  res.set('Cache-Control', 'no-store');
  res.json({ count, chat, latestId: latest.length ? Number(latest[0].id) : 0, sound: prefs.sound_enabled,
    call: call ? { id: Number(call.id), title: call.title, body: call.body, link: call.link } : null });
}));

/** Presence of this clinic's members, keyed by membership id (the Team page) and user id. */
router.get('/teamops/presence', wrap(async (req, res) => {
  const map = await presence.forClinic(req.ctx);
  const byMembership = {}; const byUser = {};
  Object.entries(map).forEach(([uid, p]) => {
    const v = { online: p.online, hidden: p.hidden, label: presence.label(p, req.t, req.locale) };
    byMembership[p.membershipId] = v; byUser[uid] = v;
  });
  res.set('Cache-Control', 'no-store');
  res.json({ byMembership, byUser });
}));

// ---------------------------------------------------------------- tickets
async function listPage(req, res, extra = {}) {
  const q = { status: 'active', scope: 'all', ...req.query };
  const [{ rows, meta }, counts, members] = await Promise.all([tickets.list(req.ctx, q), tickets.counts(req.ctx), tickets.members(req.ctx.businessId)]);
  const pres = await presence.forClinic(req.ctx, [...new Set(rows.flatMap((r) => [r.author_id, r.assignee_id]).filter(Boolean))]);
  res.page('pages/teamops/tickets', {
    title: req.t('tickets.title'), rows, meta, counts, members, q, manager: tickets.isManager(req.ctx),
    presenceOf: (uid) => (pres[uid] ? { ...pres[uid], label: presence.label(pres[uid], req.t, req.locale) } : null),
    CATEGORIES: tickets.CATEGORIES, PRIORITIES: tickets.PRIORITIES, STATUSES: tickets.STATUSES,
    platform: tickets.platformAvailable(), filtered: ['q', 'priority', 'category'].some((k) => req.query[k]) || (req.query.scope && req.query.scope !== 'all'),
    ...ASSETS, ...extra,
  });
}

router.get('/tickets', wrap((req, res) => listPage(req, res)));

router.post('/tickets', form(async (req, res) => {
  const tk = await tickets.create(req.ctx, req.body);
  let note = req.t('tickets.created', { n: tk.number });
  if (req.body.platform === '1' && tickets.platformAvailable()) {
    try {
      await tickets.sendToPlatform(req.ctx, tk.id, req.business);
      note = req.t('tickets.created_and_sent', { n: tk.number });
    } catch (err) {
      console.error('[teamops] platform support e-mail:', err.message); // eslint-disable-line no-console
      flash(req, 'error', req.t('tickets.platform_failed'));
    }
  }
  flash(req, 'success', note);
  res.redirect(`/app/tickets/${tk.id}`);
}, (req, res, extra) => listPage(req, res, { ...withOwnErrors(req, extra), openDialog: 'ticket-dialog' })));

router.get('/tickets/:id(\\d+)', wrap(async (req, res) => {
  const tk = await tickets.load(req.ctx, req.params.id);
  const [thread, members] = await Promise.all([tickets.thread(req.ctx, tk), tickets.members(req.ctx.businessId)]);
  await tickets.markRead(req.ctx, tk.id);
  const ids = [...new Set([tk.author_id, tk.assignee_id, ...thread.map((r) => r.user_id)].filter(Boolean))];
  const pres = await presence.forClinic(req.ctx, ids);
  res.page('pages/teamops/ticket', {
    title: `#${tk.number} · ${tk.subject}`, tk, thread, members, rights: tickets.rights(req.ctx, tk),
    presenceOf: (uid) => (pres[uid] ? { ...pres[uid], label: presence.label(pres[uid], req.t, req.locale) } : null),
    platform: tickets.platformAvailable(), ...ASSETS,
  });
}));

const ticketHref = (req) => `/app/tickets/${Number(req.params.id)}`;
router.post('/tickets/:id(\\d+)/reply', act(async (req, res) => {
  const r = await tickets.reply(req.ctx, req.params.id, req.body);
  flash(req, 'success', r.reopened ? req.t('tickets.reply_reopened') : req.t('tickets.reply_sent'));
  res.redirect(`${ticketHref(req)}#latest`);
}, ticketHref));
router.post('/tickets/:id(\\d+)/status', act(async (req, res) => {
  const to = await tickets.setStatus(req.ctx, req.params.id, String(req.body.status || ''));
  flash(req, 'success', req.t('tickets.status_changed', { status: req.t(`tickets.statuses.${to}`) }));
  res.redirect(ticketHref(req));
}, ticketHref));
router.post('/tickets/:id(\\d+)/assign', act(async (req, res) => {
  await tickets.assign(req.ctx, req.params.id, req.body.assignee_id || null);
  flash(req, 'success', req.t('tickets.assigned_saved'));
  res.redirect(ticketHref(req));
}, ticketHref));
router.post('/tickets/:id(\\d+)/platform', act(async (req, res) => {
  await tickets.sendToPlatform(req.ctx, req.params.id, req.business);
  flash(req, 'success', req.t('tickets.platform_sent'));
  res.redirect(ticketHref(req));
}, ticketHref));

// ---------------------------------------------------------------- Settings → Notifications
async function settingsPage(req, res, extra = {}) {
  const manage = req.ctx.permissions.has('settings.manage');
  const [prefs, rules, members, roles] = await Promise.all([
    presence.prefs(req.ctx.userId),
    manage ? notifyMail.rules(req.ctx.businessId) : null,
    manage ? tickets.members(req.ctx.businessId) : [],
    manage ? rbac.listRoles(req.ctx.businessId) : [],
  ]);
  settingsRender(req, res, 'notifications', 'notifications', {
    title: req.t('settings.nav_notifications'), manage, prefs, rules, members, roles, EVENTS: notifyMail.EVENTS,
    mailConfigured: require('../../core/mailer').configured(), // eslint-disable-line global-require
    pageStyles: ['/css/admin.css', '/css/teamops.css'], pageScripts: ['/js/admin.js'], ...extra,
  });
}

router.get('/settings/notifications', wrap((req, res) => settingsPage(req, res)));

router.post('/settings/notifications', can('settings.manage'), wrap(async (req, res) => {
  const [members, roles] = await Promise.all([tickets.members(req.ctx.businessId), rbac.listRoles(req.ctx.businessId)]);
  const out = await notifyMail.saveRules(req.ctx, req.body, { roleKeys: roles.map((r) => r.key).filter(Boolean), memberIds: members.map((m) => m.id) });
  if (out.invalid) {
    res.status(422);
    return settingsPage(req, res, { invalid: out.invalid, old: req.body, formError: { code: 'VALIDATION_FAILED', message: req.t('notify_settings.invalid_emails') } });
  }
  flash(req, 'success', req.t('notify_settings.saved'));
  return res.redirect('/app/settings/notifications');
}));

router.post('/settings/notifications/personal', wrap(async (req, res) => {
  await presence.savePrefs(req.ctx, req.body);
  flash(req, 'success', req.t('notify_settings.personal_saved'));
  res.redirect('/app/settings/notifications#personal');
}));

// ---------------------------------------------------------------- doctor → patient e-mail
const mailPerms = canAny('clinical.view', 'patients.view');
const target = (src) => ({ patientId: Number(src.patient) || null, apptId: Number(src.visit) || null });

router.get('/teamops/patient-email', mailPerms, wrap(async (req, res) => {
  const tg = target(req.query);
  if (!tg.patientId && !tg.apptId) return res.status(404).json({ error: 'NOT_FOUND' });
  const c = await patientMail.context(req.ctx, tg);
  res.set('Cache-Control', 'no-store');
  return res.json({
    name: c.name, hasEmail: Boolean(c.email), mailConfigured: c.mailConfigured,
    docs: c.docs.map((d) => ({ id: d.id, label: d.label, date: d.date })),
    history: c.history.map((h) => ({ subject: h.subject, body: h.body, status: h.status, sender: h.sender, at: new Date(h.created_at).toISOString(), files: h.attachments.length })),
  });
}));

router.post('/teamops/patient-email', mailPerms, wrap(async (req, res) => {
  const tg = target(req.body);
  const ret = String(req.body._return || '');
  const fallback = tg.apptId ? `/app/visits/${tg.apptId}` : `/app/patients/${tg.patientId}`;
  const go = /^\/app\/(visits|patients)\/\d+$/.test(ret) ? ret : fallback;
  try {
    const r = await patientMail.send(req.ctx, req.business, tg, req.body);
    flash(req, 'success', r.attachments ? req.t('doctor_mail.sent_with', { n: r.attachments }) : req.t('doctor_mail.sent'));
  } catch (err) {
    if (!(err instanceof AppError) || err.status === 403) throw err;
    const details = err.code === 'VALIDATION_FAILED' && err.details
      ? Object.entries(err.details).map(([k, m]) => `${req.t(`doctor_mail.f_${k}`)}: ${require('../../core/i18n').translateMessage(req.locale, m)}`).join(' · ') : ''; // eslint-disable-line global-require
    flash(req, 'error', details || errText(req, err));
  }
  res.redirect(go);
}));

module.exports = router;
