// A doctor (or the front desk) e-mails a patient from the visit or patient page: subject + message, optionally with
// documents already shared with the patient (prescription / report / certificate PDFs, rebuilt from the record now).
// Sent through the platform mailer with the doctor's name as the display name and Reply-To the doctor's own
// e-mail (doctors.email) or else the clinic's e-mail, so the patient's answer reaches the clinic, not the platform.
// Every send is logged in doctor_emails (the message is kept for the patient's record) and audited (without the text).
// Limits: 20 e-mails per sender per hour, 5 per patient per hour.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const mailer = require('../../core/mailer');
const brand = require('../../config/brand');
const { translator } = require('../../core/i18n');
const { E, AppError } = require('../../core/errors');
const { z, validate } = require('../../core/validate');

const LIMITS = { perUserHour: 20, perPatientHour: 5, maxAttachments: 5 };
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

const trimmed = (max) => z.string({ required_error: 'Required.', invalid_type_error: 'Required.' }).trim().min(1, 'Required.').max(max, 'Too large.');
const schema = z.object({ subject: trimmed(190), body: trimmed(5000) });

/** patientdocs is another team's module — loaded lazily so a missing module never breaks this one. */
function docsService() { try { return require('../patientdocs/docs.service'); } catch { return null; } } // eslint-disable-line global-require

async function patientFor(ctx, patientId, apptId) {
  let appt = null;
  if (apptId) {
    appt = await require('../clinic/appointments.service').get(ctx, Number(apptId)); // eslint-disable-line global-require
    if (patientId && appt.patient_id && Number(appt.patient_id) !== Number(patientId)) throw E.notFound('Patient');
    patientId = patientId || appt.patient_id; // eslint-disable-line no-param-reassign
  }
  let p = null;
  if (patientId) p = await knex('patients').where({ id: Number(patientId), business_id: ctx.businessId }).first('id', 'full_name', 'email');
  if (!p && !appt) throw E.notFound('Patient');
  const email = String((p && p.email) || (appt && appt.patient_email) || '').trim();
  return { patient: p, appt, name: p ? p.full_name : appt.patient_name, email: EMAIL_RE.test(email) ? email : null };
}

/** Documents already shared with this patient (the visit's only, when composing from a visit). */
async function sharedDocs(ctx, target) {
  const ds = docsService();
  if (!ds || !ctx.permissions.has('clinical.view')) return [];
  const q = knex('patient_documents as d').join('appointments as a', 'a.id', 'd.appointment_id')
    .where({ 'd.business_id': ctx.businessId }).whereNull('d.revoked_at')
    .select('d.*', 'a.appointment_date', 'a.doctor_id').orderBy('d.id', 'desc').limit(30);
  if (target.appt) q.where('d.appointment_id', target.appt.id);
  else if (target.patient) q.where('a.patient_id', target.patient.id);
  else return [];
  if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId);
  const rows = await q;
  const certIds = rows.filter((r) => r.kind === 'certificate').map((r) => r.ref_id);
  const certs = certIds.length ? await knex('certificates').whereIn('id', certIds).where({ business_id: ctx.businessId }).select('id', 'doc_type', 'serial', 'revoked_at') : [];
  const t = translator(ctx.locale === 'en' ? 'en' : 'ar');
  return rows.filter((r) => r.kind !== 'certificate' || certs.some((c) => c.id === r.ref_id && !c.revoked_at))
    .map((r) => ({ id: r.id, appointment_id: r.appointment_id, kind: r.kind, ref_id: r.ref_id, options: r.options, locale: r.locale, date: r.appointment_date, label: ds.labelOf(r, t, certs) }));
}

async function history(ctx, target, limit = 5) {
  const q = knex('doctor_emails as e').leftJoin('users as u', 'u.id', 'e.user_id').where('e.business_id', ctx.businessId)
    .select('e.id', 'e.subject', 'e.body', 'e.status', 'e.created_at', 'e.attachments', 'u.name as sender').orderBy('e.id', 'desc').limit(limit);
  if (target.patient) q.where('e.patient_id', target.patient.id); else q.where('e.appointment_id', target.appt.id);
  return (await q).map((r) => ({ ...r, attachments: typeof r.attachments === 'string' ? JSON.parse(r.attachments || '[]') : (r.attachments || []) }));
}

/** Everything the compose dialog needs. */
async function context(ctx, { patientId, apptId }) {
  const target = await patientFor(ctx, patientId, apptId);
  const [docs, sent] = await Promise.all([sharedDocs(ctx, target), history(ctx, target)]);
  return { name: target.name, email: target.email, docs, history: sent, mailConfigured: await mailer.configuredFor(ctx.businessId) };
}

async function sender(ctx, business) {
  const doc = ctx.doctorId ? await knex('doctors').where({ id: ctx.doctorId, business_id: ctx.businessId }).first('full_name', 'full_name_en', 'email', 'specialization', 'specialization_en') : null;
  return doc;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function letter({ locale, clinicName, subject, body, signature, clinic, files }) {
  const c = brand.colors.light;
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const align = locale === 'ar' ? 'right' : 'left';
  const t = translator(locale);
  return `<!doctype html><html dir="${dir}"><body style="margin:0;background:${c.background};font-family:Arial,Tahoma,sans-serif;color:${c.text}">
<div style="max-width:600px;margin:24px auto;background:${c.surface};border:1px solid ${c.border};border-radius:12px;padding:28px;text-align:${align}">
<div style="font-weight:700;font-size:16px;margin-bottom:18px">${esc(clinicName)}</div>
<h1 style="font-size:18px;margin:0 0 14px" dir="auto">${esc(subject)}</h1>
<div style="line-height:1.8;white-space:pre-wrap;margin:0 0 18px" dir="auto">${esc(body)}</div>
${files.length ? `<p style="margin:0 0 6px;font-size:13px;color:${c.textMuted}">${esc(t('doctor_mail.mail_attached'))}</p><ul style="margin:0 0 16px;padding-${align}:18px;font-size:13px">${files.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
<div style="border-top:1px solid ${c.border};padding-top:12px;font-size:13px;line-height:1.7">${signature.map((l) => `<div>${esc(l)}</div>`).join('')}</div>
<p style="font-size:11px;color:${c.textMuted};margin-top:20px">${esc(t('doctor_mail.mail_foot', { clinic: clinicName, phone: clinic.phone || '' }))}</p>
</div></body></html>`;
}

async function recentCount(where, since) {
  const [{ n }] = await knex('doctor_emails').where(where).where('created_at', '>=', since).count({ n: '*' });
  return Number(n);
}

/**
 * Sends the e-mail. input = { subject, body, docs:[patient_documents ids], locale }.
 * deps.mail (tests) replaces the mailer; returns { id, attachments }.
 */
async function send(ctx, business, { patientId, apptId }, input, deps = {}) {
  const mail = deps.mail || mailer;
  const d = validate(schema, input);
  const target = await patientFor(ctx, patientId, apptId);
  if (!target.email) throw new AppError('PATIENT_NO_EMAIL', 'This patient has no e-mail address.', 422);
  if (!(mail.configuredFor ? await mail.configuredFor(ctx.businessId) : mail.configured())) throw new AppError('MAIL_NOT_CONFIGURED', 'E-mail is not set up on this server.', 409);
  const since = new Date(Date.now() - 60 * 60 * 1000);
  if (await recentCount({ business_id: ctx.businessId, user_id: ctx.userId }, since) >= LIMITS.perUserHour) throw new AppError('RATE_LIMITED', 'Too many e-mails. Please try again later.', 429);
  if (target.patient && await recentCount({ business_id: ctx.businessId, patient_id: target.patient.id }, since) >= LIMITS.perPatientHour) throw new AppError('RATE_LIMITED', 'Too many e-mails to this patient. Please try again later.', 429);

  const arr = (x) => (Array.isArray(x) ? x : x === undefined || x === null || x === '' ? [] : [x]);
  const wanted = [...new Set(arr(input.docs).map(Number).filter(Boolean))];
  if (wanted.length > LIMITS.maxAttachments) throw E.validation({ docs: 'Too large.' });
  const available = wanted.length ? await sharedDocs(ctx, target) : [];
  const picks = wanted.map((id) => available.find((x) => x.id === id));
  if (picks.some((p) => !p)) throw E.validation({ docs: 'Choose a valid value.' });

  const locale = input.locale === 'en' ? 'en' : (input.locale === 'ar' ? 'ar' : (ctx.locale === 'en' ? 'en' : 'ar'));
  const attachments = [];
  if (picks.length) {
    const ds = docsService();
    for (const p of picks) {
      const out = await (deps.render || ds.render)(ctx, p.appointment_id, p, p.locale || locale); // eslint-disable-line no-await-in-loop
      attachments.push({ filename: out.filename, content: out.pdf, contentType: 'application/pdf' });
    }
  }
  const doc = await sender(ctx, business);
  const clinicName = (locale === 'en' && business.name_en) || business.name;
  const doctorName = doc ? ((locale === 'en' && doc.full_name_en) || doc.full_name) : null;
  const spec = doc ? ((locale === 'en' && doc.specialization_en) || doc.specialization) : null;
  const signature = [doctorName || ctx.userName, spec, clinicName].filter(Boolean);
  const replyTo = [doc && doc.email, business.email].map((e) => String(e || '').trim()).find((e) => EMAIL_RE.test(e)) || undefined;
  const html = letter({ locale, clinicName, subject: d.subject, body: d.body, signature, clinic: business, files: picks.map((p) => p.label) });

  let status = 'sent'; let error = null;
  try {
    await mail.send({ to: target.email, subject: d.subject, html, replyTo, attachments: attachments.length ? attachments : undefined, fromName: doctorName ? `${doctorName} — ${clinicName}` : clinicName, businessId: ctx.businessId, kind: 'patient_letters' });
  } catch (err) {
    status = 'failed'; error = String(err.message || err).slice(0, 250);
  }
  const [id] = await knex('doctor_emails').insert({
    business_id: ctx.businessId, patient_id: target.patient ? target.patient.id : null, appointment_id: target.appt ? target.appt.id : null,
    user_id: ctx.userId, doctor_id: ctx.doctorId || null, to_email: target.email, subject: d.subject, body: d.body,
    attachments: JSON.stringify(picks.map((p) => ({ id: p.id, label: p.label }))), status, error,
  });
  await audit.record(ctx, 'patient.emailed', { entityType: 'patient', entityId: target.patient ? target.patient.id : null, newValues: { email_id: id, appointment_id: target.appt ? target.appt.id : null, attachments: picks.length, status } });
  if (status === 'failed') throw new AppError('MAIL_FAILED', 'The e-mail could not be sent.', 502);
  return { id, attachments: picks.length };
}

module.exports = { LIMITS, schema, patientFor, sharedDocs, history, context, send };
