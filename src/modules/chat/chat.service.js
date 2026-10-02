// Staff chat inside one clinic: the clinic room (everyone on the team) and one-to-one conversations between two
// active members. Messages stay in the clinic (business_id on every row); a member reads only the room of the clinic
// they are signed in to and the conversations they are part of. Unread = messages after the member's last_read_id
// that someone else wrote.
const knex = require('../../db/knex');
const { E, AppError } = require('../../core/errors');

const MAX_LEN = 2000;
const PAGE = 80;

/** Active members of the clinic (for "new conversation"), without the signed-in member. */
function members(ctx) {
  return knex('memberships as m').join('users as u', 'u.id', 'm.user_id').leftJoin('roles as r', 'r.id', 'm.role_id')
    .where({ 'm.business_id': ctx.businessId, 'm.status': 'active' }).whereNot('m.user_id', ctx.userId)
    .orderBy('u.name').select('u.id', 'u.name', 'm.job_title', 'r.name as role_name', 'r.key as role_key');
}

const isMember = async (businessId, userId) => Boolean(await knex('memberships').where({ business_id: businessId, user_id: userId, status: 'active' }).first('id'));

/** The clinic room (created on first use). */
async function room(ctx) {
  let r = await knex('staff_chats').where({ business_id: ctx.businessId, kind: 'room', pair_key: 'all' }).first();
  if (!r) {
    await knex('staff_chats').insert({ business_id: ctx.businessId, kind: 'room', pair_key: 'all' }).onConflict(['business_id', 'kind', 'pair_key']).ignore();
    r = await knex('staff_chats').where({ business_id: ctx.businessId, kind: 'room', pair_key: 'all' }).first();
  }
  return r;
}

/** The one-to-one conversation with another active member (created on first use). */
async function direct(ctx, otherUserId) {
  const other = Number(otherUserId) || 0;
  if (!other || other === ctx.userId || !(await isMember(ctx.businessId, other))) throw E.notFound('Member');
  const key = `${Math.min(ctx.userId, other)}:${Math.max(ctx.userId, other)}`;
  let c = await knex('staff_chats').where({ business_id: ctx.businessId, kind: 'direct', pair_key: key }).first();
  if (!c) {
    await knex('staff_chats').insert({ business_id: ctx.businessId, kind: 'direct', pair_key: key }).onConflict(['business_id', 'kind', 'pair_key']).ignore();
    c = await knex('staff_chats').where({ business_id: ctx.businessId, kind: 'direct', pair_key: key }).first();
    await knex('staff_chat_members').insert([{ chat_id: c.id, user_id: ctx.userId }, { chat_id: c.id, user_id: other }]).onConflict(['chat_id', 'user_id']).ignore();
  }
  return c;
}

/** A conversation the signed-in member may read, or 404. */
async function access(ctx, chatId) {
  const c = await knex('staff_chats').where({ id: Number(chatId) || 0, business_id: ctx.businessId }).first();
  if (!c) throw E.notFound('Conversation');
  if (c.kind === 'direct') {
    const [a, b] = String(c.pair_key).split(':').map(Number);
    if (ctx.userId !== a && ctx.userId !== b) throw E.notFound('Conversation');
  }
  return c;
}

/** The other person of a direct conversation. */
const otherOf = (c, userId) => { const [a, b] = String(c.pair_key).split(':').map(Number); return a === userId ? b : a; };

/** Conversations of the signed-in member, newest first, with the last message and the unread count. */
async function list(ctx) {
  const r = await room(ctx);
  const like = `%:${ctx.userId}`;
  const directs = await knex('staff_chats').where({ business_id: ctx.businessId, kind: 'direct' })
    .andWhere((w) => w.where('pair_key', 'like', `${ctx.userId}:%`).orWhere('pair_key', 'like', like)).whereNotNull('last_message_id');
  const chats = [r, ...directs];
  // A member who never opened the room starts at the messages written after they joined.
  if (!(await knex('staff_chat_members').where({ chat_id: r.id, user_id: ctx.userId }).first('chat_id'))) {
    const mem = await knex('memberships').where({ business_id: ctx.businessId, user_id: ctx.userId }).first('created_at');
    const before = mem ? await knex('staff_chat_messages').where({ chat_id: r.id }).where('created_at', '<', mem.created_at).max({ id: 'id' }).first() : null;
    await markRead(ctx, r.id, (before && before.id) || 0);
  }
  const reads = await knex('staff_chat_members').where({ user_id: ctx.userId }).whereIn('chat_id', chats.map((c) => c.id)).select('chat_id', 'last_read_id');
  const readOf = new Map(reads.map((x) => [x.chat_id, x.last_read_id]));
  const lastIds = chats.map((c) => c.last_message_id).filter(Boolean);
  const [lasts, unread, others] = await Promise.all([
    lastIds.length ? knex('staff_chat_messages as m').leftJoin('users as u', 'u.id', 'm.user_id').whereIn('m.id', lastIds).select('m.id', 'm.body', 'm.user_id', 'u.name as user_name') : [],
    Promise.all(chats.map((c) => knex('staff_chat_messages').where('chat_id', c.id).where('id', '>', readOf.get(c.id) || 0).whereNot('user_id', ctx.userId).count({ n: '*' }).then(([x]) => Number(x.n)))),
    knex('users').whereIn('id', directs.map((c) => otherOf(c, ctx.userId))).select('id', 'name'),
  ]);
  const lastBy = new Map(lasts.map((m) => [m.id, m]));
  const nameOf = new Map(others.map((u) => [u.id, u.name]));
  return chats.map((c, i) => ({
    id: c.id, kind: c.kind, otherId: c.kind === 'direct' ? otherOf(c, ctx.userId) : null,
    title: c.kind === 'room' ? null : nameOf.get(otherOf(c, ctx.userId)) || '—',
    last: c.last_message_id ? lastBy.get(c.last_message_id) || null : null, lastAt: c.last_message_at, unread: unread[i],
  })).sort((a, b) => (a.kind === 'room' ? -1 : b.kind === 'room' ? 1 : new Date(b.lastAt) - new Date(a.lastAt)));
}

/** Messages of a conversation: the latest PAGE, or only those after `after` (polling). */
async function messages(ctx, chatId, { after = 0 } = {}) {
  const c = await access(ctx, chatId);
  const q = knex('staff_chat_messages as m').leftJoin('users as u', 'u.id', 'm.user_id').where({ 'm.chat_id': c.id, 'm.business_id': ctx.businessId })
    .select('m.id', 'm.body', 'm.user_id', 'm.created_at', 'u.name as user_name');
  if (Number(after) > 0) return q.where('m.id', '>', Number(after)).orderBy('m.id').limit(200);
  return (await q.orderBy('m.id', 'desc').limit(PAGE)).reverse();
}

async function send(ctx, chatId, body) {
  const c = await access(ctx, chatId);
  const text = String(body || '').replace(/\r/g, '').trim();
  if (!text) throw E.validation({ body: 'Required.' });
  if (text.length > MAX_LEN) throw new AppError('CHAT_TOO_LONG', 'The message is too long.', 422, { body: 'Too large.' });
  if (!(await isMember(ctx.businessId, ctx.userId))) throw E.forbidden('chat');
  const [id] = await knex('staff_chat_messages').insert({ chat_id: c.id, business_id: ctx.businessId, user_id: ctx.userId, body: text });
  await knex('staff_chats').where({ id: c.id }).update({ last_message_id: id, last_message_at: new Date(), updated_at: new Date() });
  await markRead(ctx, c.id, id);
  return id;
}

async function markRead(ctx, chatId, lastId) {
  const id = Number(lastId) || 0;
  await knex('staff_chat_members').insert({ chat_id: chatId, user_id: ctx.userId, last_read_id: id })
    .onConflict(['chat_id', 'user_id']).merge({ last_read_id: knex.raw('GREATEST(last_read_id, ?)', [id]) });
}

/** Unread messages for the top bar badge (room + own conversations). */
async function unreadTotal(ctx) {
  if (!ctx || !ctx.businessId || !ctx.userId) return 0;
  const [{ n }] = await knex('staff_chat_messages as m').join('staff_chats as c', 'c.id', 'm.chat_id')
    .leftJoin('staff_chat_members as r', function j() { this.on('r.chat_id', 'm.chat_id').andOn('r.user_id', knex.raw('?', [ctx.userId])); })
    .join('memberships as mem', function j() { this.on('mem.business_id', 'm.business_id').andOn('mem.user_id', knex.raw('?', [ctx.userId])); })
    .where('m.business_id', ctx.businessId).whereNot('m.user_id', ctx.userId).whereRaw('m.created_at >= mem.created_at')
    .andWhere((w) => w.where('c.kind', 'room').orWhere('c.pair_key', 'like', `${ctx.userId}:%`).orWhere('c.pair_key', 'like', `%:${ctx.userId}`))
    .andWhere((w) => w.whereNull('r.last_read_id').orWhereRaw('m.id > r.last_read_id'))
    .count({ n: '*' });
  return Number(n);
}

module.exports = { MAX_LEN, members, room, direct, access, list, messages, send, markRead, unreadTotal, otherOf };
