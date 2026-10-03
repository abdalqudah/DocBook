// Each staff member's own e-mail inside DocBook (/app/mail): connect the account (IMAP to read, SMTP to send), read the
// folders and messages, reply, write new e-mails and attach the clinic's papers (prescription, report, invoice,
// requests, referral, certificate, the patient's scanned files / X-ray images) — sent from the member's own address.
// Personal: only the member who connected it sees it (not even the clinic owner). Automatic patient messages keep
// going out from the clinic's address. Passwords are stored encrypted; servers on private networks are refused.
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const secrets = require('../../core/secrets');
const { AppError, E } = require('../../core/errors');
const { z, validate, email } = require('../../core/validate');
const { resolvePublic } = require('../clinicmail/clinicmail.service');

const PAGE = 30;
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
// Known providers by e-mail domain (Gmail / Outlook / Yahoo / iCloud need an "app password").
const PRESETS = [
  { re: /^(gmail|googlemail)\.com$/, imap: 'imap.gmail.com', smtp: 'smtp.gmail.com', smtpPort: 465, sec: 'ssl', name: 'gmail', savesSent: true },
  { re: /^(outlook|hotmail|live|msn)\.[a-z.]+$|^office365\.com$/, imap: 'outlook.office365.com', smtp: 'smtp.office365.com', smtpPort: 587, sec: 'starttls', name: 'outlook', savesSent: true },
  { re: /^(yahoo|ymail)\.[a-z.]+$/, imap: 'imap.mail.yahoo.com', smtp: 'smtp.mail.yahoo.com', smtpPort: 465, sec: 'ssl', name: 'yahoo' },
  { re: /^(icloud|me|mac)\.com$/, imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com', smtpPort: 587, sec: 'starttls', name: 'icloud' },
];
/** Server guesses for an address: a known provider, else the domain's own mail server (cPanel and most hosts). */
function guess(address) {
  const domain = String(address || '').split('@')[1] || '';
  const p = PRESETS.find((x) => x.re.test(domain.toLowerCase()));
  if (p) return { imap_host: p.imap, imap_port: 993, smtp_host: p.smtp, smtp_port: p.smtpPort, smtp_security: p.sec, provider: p.name };
  return { imap_host: domain ? `mail.${domain}` : '', imap_port: 993, smtp_host: domain ? `mail.${domain}` : '', smtp_port: 465, smtp_security: 'ssl', provider: null };
}
const savesSentItself = (row) => PRESETS.some((p) => p.savesSent && p.imap === row.imap_host);

const host = () => z.string().trim().toLowerCase().min(3).max(190).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter a server name like mail.example.com.');
const port = (def) => z.preprocess((v) => (v === '' || v === undefined ? def : Number(v)), z.number().int().min(1).max(65535));
const schema = z.object({
  email: email(), display_name: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(120).optional()),
  username: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(190).optional()),
  password: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(300).optional()),
  imap_host: host(), imap_port: port(993), smtp_host: host(), smtp_port: port(465),
  smtp_security: z.enum(['ssl', 'starttls']).default('ssl'),
  signature: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(1000).optional()),
});

// ---------------------------------------------------------------- connections (tests replace them)
let deps = {
  imap: (opts) => new (require('imapflow').ImapFlow)(opts), // eslint-disable-line global-require
  smtp: (opts) => nodemailer.createTransport(opts),
  resolve: (h) => resolvePublic(h),
};
const setDeps = (d) => { deps = { ...deps, ...d }; };

const mine = (ctx) => knex('staff_mailboxes').where({ business_id: ctx.businessId, user_id: ctx.userId }).first();
const view = (r) => r && ({ id: r.id, email: r.email, display_name: r.display_name, username: r.username, imap_host: r.imap_host, imap_port: r.imap_port,
  smtp_host: r.smtp_host, smtp_port: r.smtp_port, smtp_security: r.smtp_security, signature: r.signature || '', verified_at: r.verified_at, last_error: r.last_error });

async function imapClient(r, secret) {
  const ip = await deps.resolve(r.imap_host);
  return deps.imap({
    host: ip, port: r.imap_port, secure: r.imap_port !== 143, auth: { user: r.username, pass: secret },
    tls: { servername: r.imap_host, minVersion: 'TLSv1.2' }, servername: r.imap_host, logger: false,
    connectionTimeout: 12_000, greetingTimeout: 12_000, socketTimeout: 60_000, emitLogs: false,
  });
}
async function smtpTransport(r, secret) {
  const ip = await deps.resolve(r.smtp_host);
  return deps.smtp({
    host: ip, port: r.smtp_port, secure: r.smtp_security === 'ssl', requireTLS: r.smtp_security === 'starttls',
    auth: { user: r.username, pass: secret }, tls: { servername: r.smtp_host, minVersion: 'TLSv1.2' },
    connectionTimeout: 12_000, greetingTimeout: 12_000, socketTimeout: 30_000,
  });
}
const secretOf = (r) => {
  const s = secrets.decrypt(r.secret_enc);
  if (!s) throw new AppError('MAILBOX_SECRET', 'The saved password cannot be read any more. Connect the account again.', 409);
  return s;
};

/** Runs fn with a logged-in IMAP client, always logging out. */
async function withImap(r, fn) {
  const client = await imapClient(r, secretOf(r));
  try {
    await client.connect();
  } catch (e) {
    await knex('staff_mailboxes').where({ id: r.id }).update({ last_error: String(e.responseText || e.message || 'IMAP').slice(0, 255) });
    throw new AppError('MAILBOX_IMAP', 'Could not open the mailbox. Check the password or the server.', 502);
  }
  try { return await fn(client); } finally { try { await client.logout(); } catch { /* closed */ } }
}

// ---------------------------------------------------------------- connect / disconnect
/** Saves the account after checking that both reading (IMAP) and sending (SMTP) log in. */
async function connect(ctx, input) {
  const before = await mine(ctx);
  const d = validate(schema, { ...guess(input.email), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== '' && v !== undefined)) });
  const password = d.password || (before && before.email === d.email ? secrets.decrypt(before.secret_enc) : null);
  if (!password) throw E.validation({ password: 'Required.' });
  const row = { email: d.email, display_name: d.display_name || null, username: d.username || d.email, imap_host: d.imap_host, imap_port: d.imap_port,
    smtp_host: d.smtp_host, smtp_port: d.smtp_port, smtp_security: d.smtp_security, signature: d.signature || null };
  // Reading
  const client = await imapClient(row, password);
  try { await client.connect(); } catch (e) { throw new AppError('MAILBOX_IMAP_LOGIN', String(e.responseText || e.message || 'IMAP login failed').slice(0, 200), 422); }
  try { await client.logout(); } catch { /* closed */ }
  // Sending
  const t = await smtpTransport(row, password);
  try { await t.verify(); } catch (e) { throw new AppError('MAILBOX_SMTP_LOGIN', String(e.response || e.message || 'SMTP login failed').slice(0, 200), 422); } finally { if (t.close) t.close(); }
  const now = new Date();
  const patch = { ...row, secret_enc: secrets.encrypt(password), verified_at: now, last_error: null, updated_at: now };
  if (before) await knex('staff_mailboxes').where({ id: before.id }).update(patch);
  else await knex('staff_mailboxes').insert({ business_id: ctx.businessId, user_id: ctx.userId, ...patch, created_at: now });
  await audit.record(ctx, 'mailbox.connected', { entityType: 'staff_mailbox', entityId: ctx.userId, newValues: { email: row.email, imap: row.imap_host, smtp: row.smtp_host } });
  return mine(ctx);
}

async function disconnect(ctx) {
  const r = await mine(ctx);
  if (!r) return;
  await knex('staff_mailboxes').where({ id: r.id }).del();
  await audit.record(ctx, 'mailbox.disconnected', { entityType: 'staff_mailbox', entityId: ctx.userId, oldValues: { email: r.email } });
}

// ---------------------------------------------------------------- reading
const SPECIAL_ORDER = ['\\Inbox', '\\Sent', '\\Drafts', '\\Junk', '\\Trash', '\\Archive'];
const kindOf = (f) => (f.path.toUpperCase() === 'INBOX' ? 'inbox' : ({ '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Junk': 'junk', '\\Trash': 'trash', '\\Archive': 'archive' })[f.specialUse] || null);

/** The folders (inbox first, then sent, drafts…, then the others) with the inbox's unread count. */
async function folders(r) {
  return withImap(r, async (c) => {
    const list = await c.list();
    const out = list.filter((f) => !(f.flags && f.flags.has('\\Noselect'))).map((f) => ({ path: f.path, name: f.name, kind: kindOf(f), special: f.specialUse || null }));
    const rank = (f) => { if (f.path.toUpperCase() === 'INBOX') return 0; const i = SPECIAL_ORDER.indexOf(f.special); return i === -1 ? 99 : i + 1; };
    out.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
    try { const st = await c.status('INBOX', { unseen: true }); const inbox = out.find((f) => f.path.toUpperCase() === 'INBOX'); if (inbox) inbox.unseen = st.unseen; } catch { /* no status */ }
    return out;
  });
}

const addr = (list) => (list || []).map((a) => ({ name: a.name || '', address: a.address || '' }));

/** One page of a folder, newest first. */
async function list(r, folder = 'INBOX', page = 1, q = '') {
  return withImap(r, async (c) => {
    const box = await c.mailboxOpen(folder, { readOnly: true });
    const total = box.exists || 0;
    let seqs;
    if (q) {
      const found = await c.search({ or: [{ subject: q }, { from: q }, { to: q }, { body: q }] }, { uid: false });
      seqs = (found || []).sort((a, b) => b - a);
    }
    const all = seqs ? seqs.length : total;
    const pages = Math.max(1, Math.ceil(all / PAGE));
    const p = Math.min(Math.max(1, Number(page) || 1), pages);
    let range;
    if (seqs) range = seqs.slice((p - 1) * PAGE, p * PAGE);
    else { const hi = total - (p - 1) * PAGE; const lo = Math.max(1, hi - PAGE + 1); range = hi >= 1 ? `${lo}:${hi}` : null; }
    const items = [];
    if (range && (!Array.isArray(range) || range.length)) {
      for await (const m of c.fetch(range, { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true })) { // eslint-disable-line no-restricted-syntax
        const e = m.envelope || {};
        const hasFiles = JSON.stringify(m.bodyStructure || {}).includes('"disposition":"attachment"');
        items.push({ uid: m.uid, subject: e.subject || '', from: addr(e.from)[0] || null, to: addr(e.to), date: e.date || m.internalDate, seen: m.flags && m.flags.has('\\Seen'), flagged: m.flags && m.flags.has('\\Flagged'), hasFiles, size: m.size });
      }
    }
    items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return { folder, total: all, page: p, pages, items };
  });
}

/** One message (parsed), marked as read. */
async function read(r, folder, uid) {
  const { simpleParser } = require('mailparser'); // eslint-disable-line global-require
  return withImap(r, async (c) => {
    await c.mailboxOpen(folder);
    const m = await c.fetchOne(String(uid), { source: true, flags: true, uid: true }, { uid: true });
    if (!m || !m.source) throw E.notFound('Message');
    const parsed = await simpleParser(m.source);
    if (!(m.flags && m.flags.has('\\Seen'))) { try { await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); } catch { /* read-only */ } }
    return {
      uid: Number(uid), folder, subject: parsed.subject || '', from: addr(parsed.from && parsed.from.value)[0] || null, to: addr(parsed.to && parsed.to.value), cc: addr(parsed.cc && parsed.cc.value),
      date: parsed.date, messageId: parsed.messageId || null, references: [].concat(parsed.references || []), text: parsed.text || '', html: parsed.html || '',
      attachments: (parsed.attachments || []).map((a, i) => ({ i, filename: a.filename || `file-${i + 1}`, contentType: a.contentType, size: a.size, cid: a.contentId ? String(a.contentId).replace(/[<>]/g, '') : null, inline: a.contentDisposition === 'inline', content: a.content })),
    };
  });
}

/** Moves a message to the trash (or flags it deleted when the server has no trash folder). */
async function trash(r, folder, uid) {
  return withImap(r, async (c) => {
    const list = await c.list();
    const bin = list.find((f) => f.specialUse === '\\Trash');
    await c.mailboxOpen(folder);
    if (bin && bin.path !== folder) await c.messageMove(String(uid), bin.path, { uid: true });
    else await c.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true });
  });
}

// ---------------------------------------------------------------- the clinic's papers as attachments
const DOC_KINDS = ['prescription', 'report', 'invoice', 'order', 'referral', 'certificate', 'file'];
/** One clinic paper as an attachment {filename, content, contentType}, after the same checks as sending it to a patient. */
async function paper(ctx, kind, id, locale) {
  if (!DOC_KINDS.includes(kind)) throw E.notFound('Document');
  const share = require('../share/share.service'); // eslint-disable-line global-require
  if (!(share.PERMS[kind] || []).some((p) => ctx.permissions.has(p))) throw E.forbidden(share.PERMS[kind][0]);
  const doc = await share.target(ctx, kind, id);
  if (doc.patient_id && kind !== 'invoice') {
    const acc = await require('../clinicalplus/privacy.service').access(ctx, { patientId: doc.patient_id }); // eslint-disable-line global-require
    if (!acc.clinical) throw new AppError('RECORD_RESTRICTED', 'Restricted.', 403);
  }
  if (kind === 'file') {
    const f = await knex('patient_files').where({ business_id: ctx.businessId, id: Number(id) }).first('name', 'title', 'mime', 'data');
    if (!f) throw E.notFound('File');
    return { filename: f.name || `${f.title || 'file'}`, content: f.data, contentType: f.mime, label: f.title || f.name };
  }
  const clinic = await require('../businesses/business.service').get(ctx.businessId); // eslint-disable-line global-require
  const { pdfOf } = require('../share/web'); // eslint-disable-line global-require
  const out = await pdfOf({ clinic, ctx }, { kind, ref_id: Number(id), appointment_id: doc.appointment_id, options: {}, locale, business_id: ctx.businessId });
  if (!out) throw E.notFound('Document');
  return { filename: out.filename, content: out.pdf, contentType: 'application/pdf', label: out.filename };
}

// ---------------------------------------------------------------- sending
const emails = (v) => [...new Set(String(v || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))];
const sendSchema = z.object({
  to: z.array(email()).min(1, 'Add at least one address.').max(30), cc: z.array(email()).max(30),
  subject: z.string().trim().max(250), text: z.string().max(100_000),
});

/** Sends from the member's own address (attachments: uploaded files + the clinic's papers), and keeps a copy in Sent. */
async function send(ctx, r, input, { files = [], papers = [], locale = 'ar' } = {}) {
  const d = validate(sendSchema, { to: emails(input.to), cc: emails(input.cc), subject: input.subject || '', text: input.text || '' });
  const attachments = [];
  for (const p of papers) { // eslint-disable-line no-restricted-syntax
    const [kind, id] = String(p).split(':');
    const a = await paper(ctx, kind, id, locale); // eslint-disable-line no-await-in-loop
    attachments.push({ filename: a.filename, content: a.content, contentType: a.contentType });
  }
  for (const f of files) attachments.push({ filename: f.originalname, content: f.buffer, contentType: f.mimetype });
  const bytes = attachments.reduce((n, a) => n + (a.content ? a.content.length : 0), 0);
  if (bytes > MAX_ATTACH_BYTES) throw new AppError('MAILBOX_TOO_BIG', 'The attachments are too big (20 MB at most).', 422);
  const text = r.signature ? `${d.text}\n\n-- \n${r.signature}` : d.text;
  const msg = {
    from: r.display_name ? { name: r.display_name, address: r.email } : r.email, to: d.to, cc: d.cc.length ? d.cc : undefined, subject: d.subject, text, attachments,
    ...(input.in_reply_to ? { inReplyTo: String(input.in_reply_to).slice(0, 500), references: String(input.references || input.in_reply_to).slice(0, 2000) } : {}),
  };
  const secret = secretOf(r);
  const t = await smtpTransport(r, secret);
  try { await t.sendMail(msg); } catch (e) { throw new AppError('MAILBOX_SEND', String(e.response || e.message || 'Sending failed').slice(0, 200), 502); } finally { if (t.close) t.close(); }
  // A copy in the Sent folder (Gmail and Outlook keep one themselves).
  if (!savesSentItself(r)) {
    try {
      const raw = await new MailComposer({ ...msg, date: new Date() }).compile().build();
      await withImap(r, async (c) => { const sent = (await c.list()).find((f) => f.specialUse === '\\Sent'); if (sent) await c.append(sent.path, raw, ['\\Seen']); });
    } catch { /* the e-mail went out; the copy is a convenience */ }
  }
  await audit.record(ctx, 'mailbox.sent', { entityType: 'staff_mailbox', entityId: ctx.userId, newValues: { to: d.to.length + d.cc.length, attachments: attachments.length, papers: papers.map(String) } });
  return { to: d.to };
}

module.exports = { PAGE, PRESETS, DOC_KINDS, guess, mine, view, connect, disconnect, folders, list, read, trash, paper, send, setDeps, emails };
