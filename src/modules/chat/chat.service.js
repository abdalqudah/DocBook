// Staff chat inside one clinic: the clinic room (everyone on the team) and one-to-one conversations between two
// active members. Messages stay in the clinic (business_id on every row); a member reads only the room of the clinic
// they are signed in to and the conversations they are part of. Unread = messages after the member's last_read_id
// that someone else wrote.
const knex = require('../../db/knex');
const { E, AppError } = require('../../core/errors');

const MAX_LEN = 2000;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Accepted attachments, recognised from their first bytes (never from the name alone).
const OFFICE = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
function kindOf(buf, name) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  const h = (n) => buf.subarray(0, n).toString('latin1');
  if (h(5) === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg', image: true };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png', image: true };
  if (h(6) === 'GIF87a' || h(6) === 'GIF89a') return { ext: 'gif', mime: 'image/gif', image: true };
  if (h(4) === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', mime: 'image/webp', image: true };
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (h(4) === 'PK\u0003\u0004' && OFFICE[ext]) return { ext, mime: OFFICE[ext] };
  return null;
}

/** Checks multer memory files → rows to store, or a 422 with a code. */
function checkFiles(files) {
  const list = (files || []).filter((f) => f && f.buffer && f.buffer.length);
  if (list.length > MAX_FILES) throw new AppError('CHAT_TOO_MANY', 'Too many files.', 422, { files: 'CHAT_TOO_MANY' });
  return list.map((f) => {
    if (f.buffer.length > MAX_FILE_BYTES) throw new AppError('CHAT_FILE_BIG', 'File too large.', 422, { files: 'CHAT_FILE_BIG' });
    const k = kindOf(f.buffer, f.originalname);
    if (!k) throw new AppError('CHAT_FILE_TYPE', 'Unsupported file type.', 422, { files: 'CHAT_FILE_TYPE' });
    const base = String(f.originalname || 'file').replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\.[A-Za-z0-9]{1,5}$/, '').trim().slice(0, 100) || 'file';
    return { name: `${base}.${k.ext}`, mime: k.mime, size: f.buffer.length, data: f.buffer };
  });
}
const PAGE = 80;

/** Active members of the clinic (for "new conversation"), without the signed-in member. */
function members(ctx) {
  return knex('memberships as m').join('users as u', 'u.id', 'm.user_id').leftJoin('roles as r', 'r.id', 'm.role_id')
    .where({ 'm.business_id': ctx.businessId, 'm.status': 'active' }).whereNot('m.user_id', ctx.userId)
    // the branch chosen in the account menu: its team (and the owner)
    .modify((q) => { if (ctx.workBranch) q.where((w) => w.where('r.key', 'owner').orWhere((x) => require('../clinic/branches.service').scopeMembers(x, ctx, 'm'))); }) // eslint-disable-line global-require
    .orderBy('u.name').select('u.id', 'u.name', 'm.job_title', 'r.name as role_name', 'r.key as role_key');
}

const isMember = async (businessId, userId) => Boolean(await knex('memberships').where({ business_id: businessId, user_id: userId, status: 'active' }).first('id'));

/** The room of the branch chosen in the account menu ('all' = the whole clinic), created on first use. */
const roomKey = (ctx) => (ctx && ctx.workBranch ? `branch:${ctx.workBranch}` : 'all');
async function room(ctx) {
  const key = roomKey(ctx);
  let r = await knex('staff_chats').where({ business_id: ctx.businessId, kind: 'room', pair_key: key }).first();
  if (!r) {
    await knex('staff_chats').insert({ business_id: ctx.businessId, kind: 'room', pair_key: key }).onConflict(['business_id', 'kind', 'pair_key']).ignore();
    r = await knex('staff_chats').where({ business_id: ctx.businessId, kind: 'room', pair_key: key }).first();
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
  if (c.kind === 'room' && c.pair_key !== roomKey(ctx)) throw E.notFound('Conversation'); // another branch's room
  if (c.kind === 'direct') {
    const [a, b] = String(c.pair_key).split(':').map(Number);
    if (ctx.userId !== a && ctx.userId !== b) throw E.notFound('Conversation');
  }
  return c;
}

/** The other person of a direct conversation. */
const otherOf = (c, userId) => { const [a, b] = String(c.pair_key).split(':').map(Number); return a === userId ? b : a; };

/** Conversations of the signed-in member, newest first, with the last message and the unread count. */
async function list(ctx, { include = null } = {}) {
  const r = await room(ctx);
  const like = `%:${ctx.userId}`;
  // Conversations with messages, plus the one just opened (a new conversation shows before its first message).
  const directs = await knex('staff_chats').where({ business_id: ctx.businessId, kind: 'direct' })
    .andWhere((w) => w.where('pair_key', 'like', `${ctx.userId}:%`).orWhere('pair_key', 'like', like))
    .andWhere((w) => w.whereNotNull('last_message_id').orWhere('id', Number(include) || 0));
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
  const withFiles = new Set(lastIds.length ? await knex('staff_chat_files').whereIn('message_id', lastIds).distinct('message_id').pluck('message_id') : []);
  lasts.forEach((m) => { m.hasFile = withFiles.has(m.id); });
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
  const rows = Number(after) > 0 ? await q.where('m.id', '>', Number(after)).orderBy('m.id').limit(200) : (await q.orderBy('m.id', 'desc').limit(PAGE)).reverse();
  const files = rows.length ? await knex('staff_chat_files').whereIn('message_id', rows.map((m) => m.id)).orderBy('id').select('id', 'message_id', 'name', 'mime', 'size') : [];
  rows.forEach((m) => { m.files = files.filter((f) => f.message_id === m.id).map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, image: f.mime.startsWith('image/') })); });
  return rows;
}

/** An attachment the signed-in member may open (via its conversation), or 404. */
async function fileOf(ctx, fileId) {
  const f = await knex('staff_chat_files').where({ id: Number(fileId) || 0, business_id: ctx.businessId }).first();
  if (!f) throw E.notFound('File');
  await access(ctx, f.chat_id);
  return f;
}

async function send(ctx, chatId, body, files = []) {
  const c = await access(ctx, chatId);
  const text = String(body || '').replace(/\r/g, '').trim();
  const rows = checkFiles(files);
  if (!text && !rows.length) throw E.validation({ body: 'Required.' });
  if (text.length > MAX_LEN) throw new AppError('CHAT_TOO_LONG', 'The message is too long.', 422, { body: 'Too large.' });
  if (!(await isMember(ctx.businessId, ctx.userId))) throw E.forbidden('chat');
  if (rows.length) await require('../storage/storage.service').assertRoom(ctx.businessId, rows.reduce((n, r) => n + r.size, 0)); // eslint-disable-line global-require
  const id = await knex.transaction(async (trx) => {
    const [mid] = await trx('staff_chat_messages').insert({ chat_id: c.id, business_id: ctx.businessId, user_id: ctx.userId, body: text });
    if (rows.length) await trx('staff_chat_files').insert(rows.map((f) => ({ ...f, message_id: mid, chat_id: c.id, business_id: ctx.businessId })));
    return mid;
  });
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
    .andWhere((w) => w.where((x) => x.where('c.kind', 'room').where('c.pair_key', roomKey(ctx))).orWhere('c.pair_key', 'like', `${ctx.userId}:%`).orWhere('c.pair_key', 'like', `%:${ctx.userId}`))
    .andWhere((w) => w.whereNull('r.last_read_id').orWhereRaw('m.id > r.last_read_id'))
    .count({ n: '*' });
  return Number(n);
}

module.exports = { MAX_LEN, MAX_FILES, MAX_FILE_BYTES, kindOf, checkFiles, fileOf, members, room, direct, access, list, messages, send, markRead, unreadTotal, otherOf };
