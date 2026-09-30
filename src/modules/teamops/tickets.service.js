// Internal support tickets: any member opens one (IT problem, billing question, broken equipment, HR matter…);
// the clinic's managers assign it and move it open → in progress → resolved → closed.
// Who may do what (see `rights`):
//  • managers (owner / clinic manager / anyone with settings.manage): see every ticket, assign, change any status;
//  • the assignee: sees the ticket, replies, moves it to in progress / resolved;
//  • the author: sees their own ticket, replies (a reply on a resolved ticket re-opens it) and may close it.
// Nobody replies on a closed ticket (a manager re-opens it first).
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const { translator } = require('../../core/i18n');
const { E, AppError } = require('../../core/errors');
const { z, validate } = require('../../core/validate');
const brand = require('../../config/brand');
const rbac = require('../rbac/rbac.service');
const notifications = require('../notifications/notification.service');

const CATEGORIES = ['technical', 'billing', 'equipment', 'hr', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const MANAGER_ROLES = ['owner', 'clinic_manager'];
const PER_PAGE = 25;

const isManager = (ctx) => MANAGER_ROLES.includes(ctx.roleKey) || Boolean(ctx.permissions && ctx.permissions.has('settings.manage'));

/** What `ctx` may do with ticket `tk` (a support_tickets row). */
function rights(ctx, tk) {
  const manager = isManager(ctx);
  const author = tk.author_id === ctx.userId;
  const assignee = tk.assignee_id != null && tk.assignee_id === ctx.userId;
  const view = manager || author || assignee;
  const closed = tk.status === 'closed';
  const statuses = new Set();
  if (manager) STATUSES.forEach((s) => statuses.add(s));
  else {
    if (assignee && !closed) ['open', 'in_progress', 'resolved'].forEach((s) => statuses.add(s));
    if (author && !closed) statuses.add('closed');
  }
  statuses.delete(tk.status);
  return { view, manager, author, assignee, reply: view && !closed, assign: manager, statuses: [...statuses], platform: view };
}

/** Moving to `to` is allowed for ctx? */
function canMove(ctx, tk, to) { return STATUSES.includes(to) && rights(ctx, tk).statuses.includes(to); }

const trimmed = (max, msg = 'Required.') => z.string({ required_error: msg, invalid_type_error: msg }).trim().min(1, msg).max(max);
const createSchema = z.object({
  subject: trimmed(190),
  category: z.enum(CATEGORIES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  priority: z.enum(PRIORITIES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  description: trimmed(8000),
});
const replySchema = z.object({ body: trimmed(8000) });

function scoped(ctx) {
  const q = knex('support_tickets as t').where('t.business_id', ctx.businessId);
  if (!isManager(ctx)) q.andWhere((w) => w.where('t.author_id', ctx.userId).orWhere('t.assignee_id', ctx.userId));
  return q;
}

function applyFilters(q, ctx, query = {}) {
  const status = String(query.status || 'active');
  if (status === 'active') q.whereNot('t.status', 'closed');
  else if (STATUSES.includes(status)) q.where('t.status', status);
  if (PRIORITIES.includes(query.priority)) q.where('t.priority', query.priority);
  if (CATEGORIES.includes(query.category)) q.where('t.category', query.category);
  if (query.scope === 'mine') q.where('t.author_id', ctx.userId);
  else if (query.scope === 'assigned') q.where('t.assignee_id', ctx.userId);
  else if (query.scope === 'unassigned') q.whereNull('t.assignee_id');
  const s = String(query.q || '').trim().slice(0, 100);
  if (s) {
    const num = s.replace(/^#/, '');
    q.andWhere((w) => {
      w.where('t.subject', 'like', `%${s}%`).orWhere('t.description', 'like', `%${s}%`);
      if (/^\d+$/.test(num)) w.orWhere('t.number', Number(num));
    });
  }
  return q;
}

/** Unread = somebody else did something after I last opened the ticket. */
const unreadExpr = (ctx) => knex.raw('(t.last_activity_by IS NOT NULL AND t.last_activity_by <> ? AND (rd.read_at IS NULL OR rd.read_at < t.last_activity_at)) as unread', [ctx.userId]);
function withReads(q, ctx) {
  return q.leftJoin('support_ticket_reads as rd', function j() { this.on('rd.ticket_id', 't.id').andOn('rd.user_id', knex.raw('?', [ctx.userId])); });
}

async function list(ctx, query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const base = applyFilters(scoped(ctx), ctx, query);
  const [{ n }] = await base.clone().count({ n: '*' });
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const rows = await withReads(base.clone(), ctx)
    .leftJoin('users as au', 'au.id', 't.author_id').leftJoin('users as su', 'su.id', 't.assignee_id')
    .select('t.*', 'au.name as author_name', 'su.name as assignee_name', unreadExpr(ctx))
    .orderByRaw("FIELD(t.priority, 'urgent', 'high', 'normal', 'low')").orderBy('t.last_activity_at', 'desc')
    .limit(PER_PAGE).offset((Math.min(page, pages) - 1) * PER_PAGE);
  return { rows: rows.map((r) => ({ ...r, unread: Boolean(Number(r.unread)) })), meta: { total, page: Math.min(page, pages), pages, perPage: PER_PAGE } };
}

/** Counters for the tabs / stats (within what ctx may see). */
async function counts(ctx) {
  const rows = await scoped(ctx).select('t.status').count({ n: '*' }).groupBy('t.status');
  const out = { open: 0, in_progress: 0, resolved: 0, closed: 0 };
  rows.forEach((r) => { out[r.status] = Number(r.n); });
  out.active = out.open + out.in_progress + out.resolved;
  const [{ n: mine }] = await scoped(ctx).where('t.assignee_id', ctx.userId).whereNotIn('t.status', ['resolved', 'closed']).count({ n: '*' });
  const [{ n: urgent }] = await scoped(ctx).whereIn('t.priority', ['urgent', 'high']).whereNotIn('t.status', ['resolved', 'closed']).count({ n: '*' });
  const [{ n: unread }] = await withReads(scoped(ctx), ctx).whereNot('t.status', 'closed')
    .whereNotNull('t.last_activity_by').whereNot('t.last_activity_by', ctx.userId)
    .andWhere((w) => w.whereNull('rd.read_at').orWhereRaw('rd.read_at < t.last_activity_at')).count({ n: '*' });
  return { ...out, assignedOpen: Number(mine), urgent: Number(urgent), unread: Number(unread) };
}

async function load(ctx, id) {
  const tk = await knex('support_tickets as t').where({ 't.id': Number(id), 't.business_id': ctx.businessId })
    .leftJoin('users as au', 'au.id', 't.author_id').leftJoin('users as su', 'su.id', 't.assignee_id')
    .first('t.*', 'au.name as author_name', 'au.email as author_email', 'su.name as assignee_name');
  if (!tk || !rights(ctx, tk).view) throw E.notFound('Ticket');
  return tk;
}

async function thread(ctx, tk) {
  const rows = await knex('support_ticket_replies as r').where({ 'r.ticket_id': tk.id, 'r.business_id': ctx.businessId })
    .leftJoin('users as u', 'u.id', 'r.user_id').select('r.*', 'u.name as user_name').orderBy('r.id');
  return rows.map((r) => ({ ...r, meta: typeof r.meta === 'string' ? JSON.parse(r.meta || 'null') : r.meta }));
}

async function markRead(ctx, ticketId) {
  await knex('support_ticket_reads').insert({ ticket_id: ticketId, user_id: ctx.userId, read_at: new Date() })
    .onConflict(['ticket_id', 'user_id']).merge({ read_at: new Date() });
}

/** Active members who can be assigned (and whose names are shown). */
async function members(businessId) {
  return knex('memberships as m').join('users as u', 'u.id', 'm.user_id').join('roles as r', 'r.id', 'm.role_id')
    .where({ 'm.business_id': businessId, 'm.status': 'active' }).where('u.status', 'active')
    .select('u.id', 'u.name', 'u.email', 'u.locale', 'r.key as role_key', 'm.doctor_id').orderBy('u.name');
}

// ---------------------------------------------------------------- notifications
async function tell(businessId, userId, key, tk, vars = {}) {
  if (!userId) return;
  const u = await knex('users').where({ id: userId }).first('locale');
  const t = translator((u && u.locale) || 'ar');
  if (vars.status_key) vars = { ...vars, status: t(`tickets.statuses.${vars.status_key}`) }; // eslint-disable-line no-param-reassign
  await notifications.notify(businessId, {
    userId, type: key === 'new' ? 'ticket.new' : `ticket.${key}`, severity: tk.priority === 'urgent' ? 'warning' : 'info',
    title: t(`tickets.notify.${key}`, { n: tk.number, subject: tk.subject, ...vars }).slice(0, 255),
    body: vars.body ? String(vars.body).slice(0, 300) : null, link: `/app/tickets/${tk.id}`,
  });
}
/** Managers (settings.manage) — in both languages because it targets a permission, not a person. */
async function tellManagers(businessId, tk, key, exceptUserId, vars = {}) {
  const ar = translator('ar'); const en = translator('en');
  const title = `${ar(`tickets.notify.${key}`, { n: tk.number, subject: tk.subject, ...vars })} · ${en(`tickets.notify.${key}`, { n: tk.number, subject: tk.subject, ...vars })}`;
  const all = await knex('memberships as m').join('roles as r', 'r.id', 'm.role_id')
    .where({ 'm.business_id': businessId, 'm.status': 'active' }).select('m.user_id', 'r.key');
  const ids = [];
  for (const m of all) {
    if (m.user_id === exceptUserId) continue; // eslint-disable-line no-continue
    if (MANAGER_ROLES.includes(m.key) || (await rbac.getUserPermissions(businessId, m.user_id)).has('settings.manage')) ids.push(m.user_id); // eslint-disable-line no-await-in-loop
  }
  if (!ids.length) return;
  // One notification per manager so the author (if a manager) is not pinged about their own ticket.
  for (const uid of ids) {
    await notifications.notify(businessId, { // eslint-disable-line no-await-in-loop
      userId: uid, type: key === 'new' ? 'ticket.new' : `ticket.${key}`, severity: tk.priority === 'urgent' ? 'warning' : 'info',
      title: title.slice(0, 255), body: vars.body ? String(vars.body).slice(0, 300) : null, link: `/app/tickets/${tk.id}`,
    });
  }
}

// ---------------------------------------------------------------- writes
async function create(ctx, input) {
  const d = validate(createSchema, input);
  let tk;
  for (let attempt = 0; attempt < 3 && !tk; attempt += 1) {
    try {
      tk = await knex.transaction(async (trx) => { // eslint-disable-line no-await-in-loop, no-loop-func
        const [{ m }] = await trx('support_tickets').where({ business_id: ctx.businessId }).max({ m: 'number' }).forUpdate();
        const number = Number(m || 0) + 1;
        const now = new Date();
        const [id] = await trx('support_tickets').insert({
          business_id: ctx.businessId, number, subject: d.subject, category: d.category, priority: d.priority, description: d.description,
          author_id: ctx.userId, status: 'open', last_activity_at: now, last_activity_by: ctx.userId,
        });
        await trx('support_ticket_reads').insert({ ticket_id: id, user_id: ctx.userId, read_at: now });
        await audit.record(ctx, 'ticket.created', { entityType: 'support_ticket', entityId: id, newValues: { number, subject: d.subject, category: d.category, priority: d.priority } }, trx);
        return { id, number, ...d, business_id: ctx.businessId, author_id: ctx.userId, assignee_id: null, status: 'open' };
      });
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY' || attempt === 2) throw err;
    }
  }
  await tellManagers(ctx.businessId, tk, 'new', ctx.userId, { name: ctx.userName || '' });
  return tk;
}

async function touch(trx, tk, ctx, extra = {}) {
  const now = new Date();
  await trx('support_tickets').where({ id: tk.id }).update({ last_activity_at: now, last_activity_by: ctx.userId, updated_at: now, ...extra });
  await trx('support_ticket_reads').insert({ ticket_id: tk.id, user_id: ctx.userId, read_at: now }).onConflict(['ticket_id', 'user_id']).merge({ read_at: now });
}

async function reply(ctx, id, input) {
  const tk = await load(ctx, id);
  const r = rights(ctx, tk);
  if (!r.view) throw E.notFound('Ticket');
  if (!r.reply) throw new AppError('TICKET_CLOSED', 'This ticket is closed.', 409);
  const d = validate(replySchema, input);
  // The author answering a resolved ticket means it isn't solved after all.
  const reopen = tk.status === 'resolved' && r.author && !r.manager;
  await knex.transaction(async (trx) => {
    await trx('support_ticket_replies').insert({ business_id: ctx.businessId, ticket_id: tk.id, user_id: ctx.userId, kind: 'reply', body: d.body });
    if (reopen) await trx('support_ticket_replies').insert({ business_id: ctx.businessId, ticket_id: tk.id, user_id: ctx.userId, kind: 'event', meta: JSON.stringify({ status: 'open' }) });
    await touch(trx, tk, ctx, { replies_count: knex.raw('replies_count + 1'), ...(reopen ? { status: 'open', resolved_at: null } : {}) });
    await audit.record(ctx, 'ticket.replied', { entityType: 'support_ticket', entityId: tk.id, newValues: { number: tk.number, reopened: reopen || undefined } }, trx);
  });
  const who = new Set([tk.author_id, tk.assignee_id].filter((u) => u && u !== ctx.userId));
  for (const uid of who) await tell(ctx.businessId, uid, 'reply', tk, { name: ctx.userName || '', body: d.body }); // eslint-disable-line no-await-in-loop
  if (!tk.assignee_id && tk.author_id === ctx.userId) await tellManagers(ctx.businessId, tk, 'reply', ctx.userId, { name: ctx.userName || '', body: d.body });
  return { reopened: reopen };
}

async function setStatus(ctx, id, to) {
  const tk = await load(ctx, id);
  if (!STATUSES.includes(to)) throw E.validation({ status: 'Choose a valid value.' });
  if (!canMove(ctx, tk, to)) throw E.forbidden('tickets.status');
  const now = new Date();
  await knex.transaction(async (trx) => {
    await trx('support_ticket_replies').insert({ business_id: ctx.businessId, ticket_id: tk.id, user_id: ctx.userId, kind: 'event', meta: JSON.stringify({ status: to }) });
    await touch(trx, tk, ctx, {
      status: to, resolved_at: to === 'resolved' ? now : (to === 'closed' ? tk.resolved_at : null), closed_at: to === 'closed' ? now : null,
    });
    await audit.record(ctx, 'ticket.status', { entityType: 'support_ticket', entityId: tk.id, oldValues: { status: tk.status }, newValues: { status: to } }, trx);
  });
  const who = new Set([tk.author_id, tk.assignee_id].filter((u) => u && u !== ctx.userId));
  for (const uid of who) await tell(ctx.businessId, uid, 'status', tk, { status_key: to }); // eslint-disable-line no-await-in-loop
  return to;
}

async function assign(ctx, id, userId) {
  const tk = await load(ctx, id);
  if (!rights(ctx, tk).assign) throw E.forbidden('tickets.assign');
  const uid = userId ? Number(userId) : null;
  if (uid) {
    const ok = (await members(ctx.businessId)).some((m) => m.id === uid);
    if (!ok) throw E.validation({ assignee_id: 'Choose a valid value.' });
  }
  if ((tk.assignee_id || null) === uid) return tk;
  let name = null;
  if (uid) ({ name } = await knex('users').where({ id: uid }).first('name'));
  await knex.transaction(async (trx) => {
    await trx('support_ticket_replies').insert({ business_id: ctx.businessId, ticket_id: tk.id, user_id: ctx.userId, kind: 'event', meta: JSON.stringify({ assignee: name }) });
    // Assigning an open ticket starts work on it.
    await touch(trx, tk, ctx, { assignee_id: uid });
    await audit.record(ctx, 'ticket.assigned', { entityType: 'support_ticket', entityId: tk.id, oldValues: { assignee_id: tk.assignee_id }, newValues: { assignee_id: uid } }, trx);
  });
  if (uid && uid !== ctx.userId) await tell(ctx.businessId, uid, 'assigned', tk, { name: ctx.userName || '' });
  return { ...tk, assignee_id: uid };
}

// ---------------------------------------------------------------- platform support (DocBook team)
const SUPPORT_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
function supportAddress() {
  const email = String(process.env.SUPPORT_EMAIL || '').trim();
  return SUPPORT_RE.test(email) ? email : null;
}
const platformAvailable = () => Boolean(supportAddress() && mailer.configured());

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** E-mails the ticket (with its thread) to the platform support address. Once per ticket. */
async function sendToPlatform(ctx, id, business, { mail = mailer } = {}) {
  const tk = await load(ctx, id);
  const to = supportAddress();
  if (!to || !mail.configured()) throw new AppError('SUPPORT_UNAVAILABLE', 'Platform support e-mail is not configured.', 409);
  if (tk.platform_sent_at) throw new AppError('ALREADY_SENT', 'This ticket was already sent to support.', 409);
  const t = translator('en');
  const replies = (await thread(ctx, tk)).filter((r) => r.kind === 'reply');
  const clinic = `${business.name}${business.name_en ? ` / ${business.name_en}` : ''} (#${business.id})`;
  const sender = await knex('users').where({ id: ctx.userId }).first('name', 'email');
  const c = brand.colors.light;
  const block = (who, when, text) => `<div style="border-top:1px solid ${c.border};padding:10px 0"><div style="font-size:12px;color:${c.textMuted}">${esc(who)} · ${esc(new Date(when).toISOString().slice(0, 16).replace('T', ' '))} UTC</div><div style="white-space:pre-wrap;line-height:1.6" dir="auto">${esc(text)}</div></div>`;
  const html = `<!doctype html><html><body style="font-family:Arial,Tahoma,sans-serif;max-width:640px;margin:20px auto">
<h2 style="font-size:16px" dir="auto">[${esc(clinic)}] #${tk.number} — ${esc(tk.subject)}</h2>
<p style="font-size:13px">${esc(t('tickets.category'))}: ${esc(t(`tickets.categories.${tk.category}`))} · ${esc(t('tickets.priority'))}: ${esc(t(`tickets.priorities.${tk.priority}`))} · ${esc(t('common.status'))}: ${esc(t(`tickets.statuses.${tk.status}`))}</p>
${block(tk.author_name || '—', tk.created_at, tk.description)}
${replies.map((r) => block(r.user_name || '—', r.created_at, r.body)).join('')}
<p style="font-size:12px;color:${c.textMuted}">${esc(t('tickets.platform_mail_foot', { name: sender ? sender.name : '', email: sender ? sender.email : '' }))}</p></body></html>`;
  await mail.send({ to, subject: `[DocBook] ${clinic} #${tk.number}: ${tk.subject}`.slice(0, 200), html, replyTo: (sender && sender.email) || business.email || undefined });
  const now = new Date();
  await knex.transaction(async (trx) => {
    await trx('support_tickets').where({ id: tk.id }).update({ platform_sent_at: now, updated_at: now });
    await trx('support_ticket_replies').insert({ business_id: ctx.businessId, ticket_id: tk.id, user_id: ctx.userId, kind: 'event', meta: JSON.stringify({ platform: true }) });
    await audit.record(ctx, 'ticket.sent_to_platform', { entityType: 'support_ticket', entityId: tk.id, newValues: { number: tk.number } }, trx);
  });
  return true;
}

module.exports = {
  CATEGORIES, PRIORITIES, STATUSES, isManager, rights, canMove, list, counts, load, thread, markRead, members,
  create, reply, setStatus, assign, supportAddress, platformAvailable, sendToPlatform,
};
