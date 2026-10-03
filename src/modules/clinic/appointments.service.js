// Patients, appointments, front desk (check-in / call-in / checkout) and invoices — DocBook's clinic flow.
const knex = require('../../db/knex');
const audit = require('../../core/audit');
const { repo } = require('../../core/crud');
const { z, validate, money, isoDate, optionalString, emptyToUndefined } = require('../../core/validate');
const { AppError, E } = require('../../core/errors');
const scheduling = require('./scheduling');
const branches = require('./branches.service');
const rules = require('./money-rules');
const businesses = require('../businesses/business.service');
const notifications = require('../notifications/notification.service');

const STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'insurance', 'digital_wallet'];

const id = () => z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional());
const email = () => z.preprocess(emptyToUndefined, z.string().trim().email('Enter a valid email address.').max(190).optional());
const time = () => z.string().trim().refine(scheduling.isTime, 'Enter a valid time.');

// ---------------------------------------------------------------- patients
const patients = repo({
  table: 'patients', entity: 'patient', searchable: ['full_name', 'phone', 'email', 'national_id', 'insurance_number'],
  filters: { insurance: 'insurance_provider_id' }, sortable: { name: 'full_name', created: 'created_at' }, defaultSort: ['created_at', 'desc'],
});

const patientSchema = z.object({
  full_name: z.string().trim().min(1, 'Required.').max(190), phone: optionalString(40), email: email(),
  date_of_birth: z.preprocess(emptyToUndefined, isoDate().optional()), gender: z.preprocess(emptyToUndefined, z.enum(['male', 'female']).optional()),
  national_id: optionalString(40), insurance_provider_id: id(), insurance_number: optionalString(60),
  allergies: optionalString(3000), chronic_conditions: optionalString(3000), notes: optionalString(5000),
});

async function savePatient(ctx, pid, input) {
  const d = validate(patientSchema, input);
  await checkRefs(ctx, { insurance_provider_id: d.insurance_provider_id });
  if (d.phone) {
    const clash = await knex('patients').where({ business_id: ctx.businessId, phone: d.phone }).modify((q) => { if (pid) q.whereNot({ id: pid }); }).first('id');
    if (clash) throw new AppError('PATIENT_PHONE_TAKEN', 'Another patient already uses this phone number.', 409, { phone: 'Another patient already uses this phone number.' });
  }
  const row = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === undefined ? null : v]));
  if (pid) { await patients.update(ctx, pid, row); return pid; }
  return patients.create(ctx, row);
}

/** DocBook rule: exact phone match within the clinic only; a blank phone always creates a new patient. */
async function resolveOrCreatePatient(ctx, { name, phone, email: mail }, trx = knex) {
  const p = String(phone || '').trim();
  if (p) {
    const hit = await trx('patients').where({ business_id: ctx.businessId, phone: p }).first('id');
    if (hit) return hit.id;
  }
  const [pid] = await trx('patients').insert({ business_id: ctx.businessId, full_name: String(name || '').trim() || '—', phone: p || null, email: mail || null });
  return pid;
}

async function timeline(ctx, patientId) {
  const w = { business_id: ctx.businessId, patient_id: patientId };
  const [appointments, consultations, prescriptions, invoices] = await Promise.all([
    knex('appointments as a').leftJoin('doctors as d', function j() { this.on('d.id', 'a.doctor_id').andOn('d.business_id', 'a.business_id'); }).leftJoin('services as s', function j() { this.on('s.id', 'a.service_id').andOn('s.business_id', 'a.business_id'); }).where({ 'a.business_id': ctx.businessId, 'a.patient_id': patientId })
      .whereNot('a.appointment_type', 'blocked').orderBy([{ column: 'a.appointment_date', order: 'desc' }, { column: 'a.appointment_time', order: 'desc' }])
      .select('a.*', 'd.full_name as doctor_name', 's.name as service_name'),
    knex('consultations as c').leftJoin('doctors as d', 'd.id', 'c.doctor_id').where({ 'c.business_id': ctx.businessId, 'c.patient_id': patientId }).orderBy('c.created_at', 'desc').select('c.*', 'd.full_name as doctor_name'),
    knex('prescriptions as p').leftJoin('doctors as d', 'd.id', 'p.doctor_id').where({ 'p.business_id': ctx.businessId, 'p.patient_id': patientId }).orderBy('p.created_at', 'desc').select('p.*', 'd.full_name as doctor_name'),
    knex('invoices').where(w).orderBy('created_at', 'desc'),
  ]);
  return { appointments, consultations, prescriptions, invoices, latestDiagnosis: (consultations.find((c) => c.diagnosis) || {}).diagnosis || null };
}

// ---------------------------------------------------------------- appointments
const APPT_SELECT = ['a.*', 'br.name as branch_name', 'br.name_en as branch_name_en', 'd.full_name as doctor_name', 'd.full_name_en as doctor_name_en', 'd.color as doctor_color', 's.name as service_name', 's.name_en as service_name_en', 's.price as service_price', 'd.consultation_fee'];

function baseQuery(ctx) {
  const q = knex('appointments as a').leftJoin('doctors as d', function j() { this.on('d.id', 'a.doctor_id').andOn('d.business_id', 'a.business_id'); }).leftJoin('services as s', function j() { this.on('s.id', 'a.service_id').andOn('s.business_id', 'a.business_id'); })
    .leftJoin('clinic_branches as br', function j() { this.on('br.id', 'a.branch_id').andOn('br.business_id', 'a.business_id'); }).where('a.business_id', ctx.businessId);
  if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId); // a doctor sees only their own schedule
  return q;
}

async function list(ctx, { from, to, doctor, status, q: search, includeBlocked = false, patient, type, branch } = {}) {
  const q = baseQuery(ctx).select(APPT_SELECT).orderBy([{ column: 'a.appointment_date' }, { column: 'a.appointment_time' }]);
  if (branch === 'main') q.whereNull('a.branch_id'); else if (branch) q.where('a.branch_id', branch);
  if (from) q.where('a.appointment_date', '>=', from);
  if (to) q.where('a.appointment_date', '<=', to);
  if (doctor && doctor !== 'all') q.where('a.doctor_id', doctor);
  if (status && status !== 'all') q.where('a.status', status);
  if (patient) q.where('a.patient_id', patient);
  if (type) q.where((w) => { w.where('a.appointment_type', type); if (includeBlocked) w.orWhere('a.appointment_type', 'blocked'); }); // Online / in-clinic filter
  if (!includeBlocked) q.whereNot('a.appointment_type', 'blocked');
  if (search) { const s = `%${String(search).replace(/[%_]/g, (m) => `\\${m}`)}%`; q.andWhere((w) => { w.where('a.patient_name', 'like', s).orWhere('a.patient_phone', 'like', s); require('./records.lib').nameMatch(w, 'a.patient_name', search); }); } // eslint-disable-line global-require
  return q.limit(1000);
}

async function get(ctx, apptId) {
  const row = await baseQuery(ctx).where('a.id', apptId).first(APPT_SELECT);
  if (!row) throw E.notFound('Appointment');
  return row;
}

const bookingSchema = z.object({
  doctor_id: id(), service_id: id(), patient_id: id(),
  patient_name: z.string().trim().min(1, 'Required.').max(190), patient_phone: z.string().trim().min(5, 'Required.').max(40), patient_email: email(),
  appointment_date: isoDate(), appointment_time: time(),
  duration_minutes: z.preprocess(emptyToUndefined, z.coerce.number().int().min(scheduling.MIN_BLOCK_MINUTES).max(scheduling.MAX_BLOCK_MINUTES).optional()),
  appointment_type: z.preprocess(emptyToUndefined, z.enum(['in_person', 'online']).optional()),
  status: z.preprocess(emptyToUndefined, z.enum(['pending', 'confirmed']).optional()),
  notes: optionalString(3000),
  parent_appointment_id: id(),
  // Only used without a doctor (online "any doctor" booking): with a doctor the visit is at the doctor's branch.
  branch_id: z.preprocess((v) => (v === '' || v === undefined || v === null || v === 'main' ? undefined : v), z.coerce.number().int().positive().optional()),
});

/** Expected fee: service price, else the doctor's consultation fee. */
async function expectedFee(trx, businessId, doctorId, serviceId) {
  if (serviceId) { const s = await trx('services').where({ id: serviceId, business_id: businessId }).first('price'); if (s && Number(s.price) > 0) return Number(s.price); }
  if (doctorId) { const d = await trx('doctors').where({ id: doctorId, business_id: businessId }).first('consultation_fee'); if (d) return Number(d.consultation_fee) || 0; }
  return 0;
}

/** Ids typed in a booking must be this clinic's own (service, doctor, the visit followed up, insurance company). */
async function checkRefs(ctx, d, trx = knex) {
  const own = async (table, id, field) => {
    if (!id) return;
    if (!(await trx(table).where({ id, business_id: ctx.businessId }).first('id'))) throw E.validation({ [field]: 'Choose a valid value.' });
  };
  await own('services', d.service_id, 'service_id');
  await own('doctors', d.doctor_id, 'doctor_id');
  await own('appointments', d.parent_appointment_id, 'parent_appointment_id');
  await own('insurance_providers', d.insurance_provider_id, 'insurance_provider_id');
}

async function insertAppointment(ctx, d, { source, trx }) {
  await checkRefs(ctx, d, trx);
  let patientId = d.patient_id || null;
  if (patientId) {
    const p = await trx('patients').where({ id: patientId, business_id: ctx.businessId }).first('id');
    if (!p) throw E.validation({ patient_id: 'Choose a valid value.' });
  } else patientId = await resolveOrCreatePatient(ctx, { name: d.patient_name, phone: d.patient_phone, email: d.patient_email }, trx);
  const branchId = d.doctor_id ? await branches.ofDoctor(ctx.businessId, d.doctor_id, trx) : await branches.check(ctx.businessId, d.branch_id, trx);
  const [apptId] = await trx('appointments').insert({
    business_id: ctx.businessId, branch_id: branchId, doctor_id: d.doctor_id || null, service_id: d.service_id || null, patient_id: patientId,
    patient_name: d.patient_name, patient_phone: d.patient_phone, patient_email: d.patient_email || null,
    appointment_date: d.appointment_date, appointment_time: d.appointment_time, duration_minutes: d.service_id ? null : (d.duration_minutes || null),
    status: d.status || (source === 'website' ? 'pending' : 'confirmed'), appointment_type: d.appointment_type || 'in_person', source,
    amount_due: await expectedFee(trx, ctx.businessId, d.doctor_id, d.service_id), notes: d.notes || null, created_by: ctx.userId || null,
    parent_appointment_id: d.parent_appointment_id || null,
    // Booking channel (reports): public bookings pass ctx.channel (instagram, widget, directory…); staff bookings are 'staff'.
    booking_channel: (/^[a-z]{1,20}$/.test(ctx.channel || '') && ctx.channel) || (source === 'website' ? 'website' : 'staff'),
  });
  await audit.record(ctx, 'appointment.created', { entityType: 'appointment', entityId: apptId, newValues: { date: d.appointment_date, time: d.appointment_time, doctor_id: d.doctor_id, source } }, trx);
  return apptId;
}

/** Staff or public booking. With a doctor, the slot is validated and locked (DocBook's slot lock). */
async function book(ctx, input, { source = 'staff' } = {}) {
  const d = validate(bookingSchema, input);
  if (ctx.ownDoctorId && d.doctor_id && d.doctor_id !== ctx.ownDoctorId) throw E.forbidden('appointments.view_all');
  if (ctx.ownDoctorId && !d.doctor_id) d.doctor_id = ctx.ownDoctorId; // a doctor books on their own schedule
  const run = (trx) => insertAppointment(ctx, d, { source, trx });
  const apptId = d.doctor_id
    ? await scheduling.withSlot({ businessId: ctx.businessId, timezone: ctx.timezone, doctorId: d.doctor_id, serviceId: d.service_id, durationOverride: d.duration_minutes, date: d.appointment_date, time: d.appointment_time }, run)
    : await knex.transaction(run);
  if (source === 'website') {
    await notifications.notify(ctx.businessId, { permission: 'appointments.manage', type: 'appointment.booked_online', severity: 'info', title: `${d.patient_name} · ${d.appointment_date} ${d.appointment_time}`, body: 'online', link: `/app/appointments/${apptId}` });
  }
  return apptId;
}

/** Reschedule / edit: re-validates the new slot against everyone else's bookings. */
async function update(ctx, apptId, input) {
  const before = await get(ctx, apptId);
  const d = validate(bookingSchema, input);
  if (ctx.ownDoctorId && d.doctor_id !== ctx.ownDoctorId) throw E.forbidden('appointments.view_all');
  const moved = before.doctor_id !== (d.doctor_id || null) || before.appointment_date !== d.appointment_date || before.appointment_time !== d.appointment_time
    || (before.service_id || null) !== (d.service_id || null) || (before.duration_minutes || null) !== (d.duration_minutes || null);
  const patch = {
    doctor_id: d.doctor_id || null, service_id: d.service_id || null, patient_name: d.patient_name, patient_phone: d.patient_phone, patient_email: d.patient_email || null,
    appointment_date: d.appointment_date, appointment_time: d.appointment_time, duration_minutes: d.service_id ? null : (d.duration_minutes || null),
    appointment_type: d.appointment_type || before.appointment_type, notes: d.notes || null, updated_at: new Date(),
  };
  const run = async (trx) => {
    await checkRefs(ctx, d, trx);
    // Online consultations keep the online fee set when booking.
    if (before.payment_status !== 'paid' && !(before.appointment_type === 'online' && patch.appointment_type === 'online')) patch.amount_due = await expectedFee(trx, ctx.businessId, patch.doctor_id, patch.service_id);
    await trx('appointments').where({ id: apptId, business_id: ctx.businessId }).update(patch);
    const { oldValues, newValues } = audit.diff(before, patch);
    await audit.record(ctx, 'appointment.updated', { entityType: 'appointment', entityId: apptId, oldValues, newValues }, trx);
  };
  if (moved && d.doctor_id) {
    return scheduling.withSlot({ businessId: ctx.businessId, timezone: ctx.timezone, doctorId: d.doctor_id, serviceId: d.service_id, durationOverride: d.duration_minutes, date: d.appointment_date, time: d.appointment_time, excludeAppointmentId: apptId }, run);
  }
  return knex.transaction(run);
}

async function setStatus(ctx, apptId, status) {
  if (!STATUSES.includes(status)) throw E.validation({ status: 'Choose a valid value.' });
  const a = await get(ctx, apptId);
  await knex('appointments').where({ id: a.id }).update({ status, updated_at: new Date(), ...(status === 'cancelled' ? { checked_in: false, with_doctor: false } : {}) });
  await audit.record(ctx, 'appointment.status', { entityType: 'appointment', entityId: a.id, oldValues: { status: a.status }, newValues: { status } });
  // Online consultations: confirmation e-mails the link, cancellation notifies the patient (only when e-mail is set up).
  if (a.appointment_type === 'online') await require('../telehealth/telehealth.service').statusChanged(ctx, a, status); // eslint-disable-line global-require
  // The clinic cancelled an upcoming appointment: the patient gets a message (WhatsApp / SMS / e-mail as set up).
  if (status === 'cancelled' && a.status !== 'cancelled' && ctx.userId) await require('../messaging/messaging.service').notifyCancelled(ctx, a.id); // eslint-disable-line global-require
}

async function checkIn(ctx, apptId, on = true) {
  const a = await get(ctx, apptId);
  if (a.status === 'cancelled') throw E.conflict('APPOINTMENT_CANCELLED', 'This appointment is cancelled.');
  await knex('appointments').where({ id: a.id }).update({ checked_in: on, arrived_at: on ? new Date() : null, with_doctor: on ? a.with_doctor : false, status: on && a.status === 'pending' ? 'confirmed' : a.status, updated_at: new Date() });
  await audit.record(ctx, on ? 'appointment.checked_in' : 'appointment.check_in_undone', { entityType: 'appointment', entityId: a.id });
}

/** Waiting room → doctor's room. */
async function callIn(ctx, apptId, on = true) {
  const a = await get(ctx, apptId);
  if (on && !a.checked_in) throw E.conflict('NOT_CHECKED_IN', 'Check the patient in first.');
  await knex('appointments').where({ id: a.id }).update({ with_doctor: on, called_at: on ? new Date() : null, updated_at: new Date() });
  await audit.record(ctx, on ? 'appointment.called_in' : 'appointment.call_undone', { entityType: 'appointment', entityId: a.id });
  // The consultation timer runs from the moment the patient goes in (the doctor can pause it; finishing the visit
  // stops it). Sent back to the waiting room: the timer pauses. A timer problem never blocks the front desk.
  if (['pending', 'confirmed'].includes(a.status)) {
    try {
      const timer = require('../clinicalplus/timer.service'); // eslint-disable-line global-require
      if (!on) await timer.pause(ctx, a);
      else if ((await timer.start(ctx, a)).paused_at) await timer.resume(ctx, a); // back in after a pause
    } catch (e) { /* keep the call-in */ }
  }
}

async function assignDoctor(ctx, apptId, doctorId) {
  const a = await get(ctx, apptId);
  return scheduling.withSlot({ businessId: ctx.businessId, timezone: ctx.timezone, doctorId: Number(doctorId), serviceId: a.service_id, durationOverride: a.duration_minutes, date: a.appointment_date, time: a.appointment_time, excludeAppointmentId: a.id }, async (trx) => {
    await trx('appointments').where({ id: a.id }).update({ doctor_id: Number(doctorId), branch_id: await branches.ofDoctor(ctx.businessId, Number(doctorId), trx), updated_at: new Date() });
    await audit.record(ctx, 'appointment.doctor_assigned', { entityType: 'appointment', entityId: a.id, oldValues: { doctor_id: a.doctor_id }, newValues: { doctor_id: Number(doctorId) } }, trx);
  });
}

/**
 * A calendar reservation without a patient (DocBook "time block"). With kind = 'surgery' the block is an operation:
 * patient, procedure and hospital are kept in surgeries (Patients → Surgeries) and the block is labelled with them.
 */
async function block(ctx, input) {
  const d = validate(z.object({ doctor_id: z.coerce.number().int().positive(), appointment_date: isoDate(), appointment_time: time(),
    duration_minutes: z.preprocess(emptyToUndefined, z.coerce.number().int().min(scheduling.MIN_BLOCK_MINUTES).max(scheduling.MAX_BLOCK_MINUTES).optional()), label: optionalString(190) }), input);
  const surgeries = require('../surgeries/surgeries.service'); // eslint-disable-line global-require
  const surgery = input.kind === 'surgery' ? await surgeries.check(ctx, input) : null;
  const label = surgery ? surgeries.labelOf(surgery) : d.label;
  return scheduling.withSlot({ businessId: ctx.businessId, timezone: ctx.timezone, doctorId: d.doctor_id, durationOverride: d.duration_minutes, date: d.appointment_date, time: d.appointment_time }, async (trx) => {
    const [bid] = await trx('appointments').insert({ business_id: ctx.businessId, branch_id: await branches.ofDoctor(ctx.businessId, d.doctor_id, trx), doctor_id: d.doctor_id, patient_name: label || '—', appointment_date: d.appointment_date, appointment_time: d.appointment_time,
      duration_minutes: d.duration_minutes || null, status: 'confirmed', appointment_type: 'blocked', source: 'staff', notes: label || null, created_by: ctx.userId });
    await audit.record(ctx, 'appointment.blocked', { entityType: 'appointment', entityId: bid, newValues: { ...d, label, surgery: Boolean(surgery) } }, trx);
    if (surgery) await surgeries.fromBlock(trx, ctx, { id: bid, doctor_id: d.doctor_id, appointment_date: d.appointment_date, appointment_time: d.appointment_time, duration_minutes: d.duration_minutes }, input);
    return bid;
  });
}

/**
 * Calendar drag-and-drop: moves an appointment or time block to another time, date and/or doctor.
 * Keeps the service and the length (a booking without a service keeps its current length even when the
 * new doctor's slot is different); the new slot is re-validated and locked with scheduling.withSlot.
 * Paid visits and cancelled appointments cannot be moved.
 */
async function move(ctx, apptId, input) {
  const a = await get(ctx, apptId);
  const d = validate(z.object({ doctor_id: z.coerce.number().int().positive(), appointment_date: isoDate(), appointment_time: time() }), input);
  if (ctx.ownDoctorId && d.doctor_id !== ctx.ownDoctorId) throw E.forbidden('appointments.view_all');
  if (a.status === 'cancelled') throw E.conflict('APPOINTMENT_CANCELLED', 'This appointment is cancelled.');
  if (a.payment_status === 'paid') throw E.conflict('ALREADY_PAID', 'This visit is already paid.');
  if (a.doctor_id === d.doctor_id && a.appointment_date === d.appointment_date && a.appointment_time === d.appointment_time) return a.id;
  let duration = a.service_id ? null : (a.duration_minutes || null);
  if (!a.service_id && !duration && a.doctor_id && a.doctor_id !== d.doctor_id) {
    const cur = await knex('doctors').where({ id: a.doctor_id, business_id: ctx.businessId }).first('slot_duration_minutes');
    duration = (cur && cur.slot_duration_minutes) || null;
  }
  await scheduling.withSlot({ businessId: ctx.businessId, timezone: ctx.timezone, doctorId: d.doctor_id, serviceId: a.service_id, durationOverride: duration,
    date: d.appointment_date, time: d.appointment_time, excludeAppointmentId: a.id }, async (trx) => {
    const patch = { doctor_id: d.doctor_id, appointment_date: d.appointment_date, appointment_time: d.appointment_time, duration_minutes: a.service_id ? a.duration_minutes : duration, updated_at: new Date() };
    if (a.appointment_type === 'in_person' && a.doctor_id !== d.doctor_id) patch.amount_due = await expectedFee(trx, ctx.businessId, d.doctor_id, a.service_id);
    if (a.doctor_id !== d.doctor_id) patch.branch_id = await branches.ofDoctor(ctx.businessId, d.doctor_id, trx); // the visit goes where the doctor works
    await trx('appointments').where({ id: a.id, business_id: ctx.businessId }).update(patch);
    if (a.appointment_type === 'blocked') await require('../surgeries/surgeries.service').followBlock(trx, ctx, a.id, d); // eslint-disable-line global-require
    await audit.record(ctx, 'appointment.moved', { entityType: 'appointment', entityId: a.id,
      oldValues: { doctor_id: a.doctor_id, date: a.appointment_date, time: a.appointment_time }, newValues: { doctor_id: d.doctor_id, date: d.appointment_date, time: d.appointment_time } }, trx);
  });
  return a.id;
}

/**
 * Reception confirms a pending booking — typically an online one — after choosing the doctor (a booking made with
 * "any doctor" has none) and, when needed, another day or time. The new doctor/time is checked like any move; the
 * patient's confirmation message follows from the status (messaging job).
 */
async function confirm(ctx, apptId, input = {}) {
  const a = await get(ctx, apptId);
  if (a.status !== 'pending') throw E.conflict('NOT_PENDING', 'Only a booking waiting for confirmation can be confirmed here.');
  const doctorId = Number(input.doctor_id) || a.doctor_id;
  if (!doctorId) throw E.validation({ doctor_id: 'Choose the doctor.' });
  const date = input.appointment_date || a.appointment_date;
  const time = input.appointment_time || a.appointment_time;
  if (doctorId !== a.doctor_id || date !== a.appointment_date || time !== a.appointment_time) {
    await move(ctx, a.id, { doctor_id: doctorId, appointment_date: date, appointment_time: time });
  }
  await setStatus(ctx, a.id, 'confirmed');
  return a.id;
}

async function followUp(ctx, parentId, input) {
  const parent = await get(ctx, parentId);
  return book(ctx, { ...input, doctor_id: parent.doctor_id, service_id: input.service_id || parent.service_id, patient_id: parent.patient_id, patient_name: parent.patient_name,
    patient_phone: parent.patient_phone, patient_email: parent.patient_email, status: 'confirmed', notes: input.notes || 'follow-up', parent_appointment_id: parent.id });
}

async function remove(ctx, apptId) {
  const a = await get(ctx, apptId);
  const inv = await knex('invoices').where({ business_id: ctx.businessId, appointment_id: a.id }).first('id');
  if (inv) throw E.conflict('APPOINTMENT_INVOICED', 'This visit has an invoice. Void the invoice first.');
  if (a.appointment_type === 'blocked') await require('../surgeries/surgeries.service').blockRemoved(knex, ctx, a.id); // eslint-disable-line global-require
  await knex('appointments').where({ id: a.id }).del();
  await audit.record(ctx, 'appointment.deleted', { entityType: 'appointment', entityId: a.id, oldValues: { patient: a.patient_name, date: a.appointment_date, time: a.appointment_time } });
}

// ---------------------------------------------------------------- checkout & invoices
const checkoutSchema = z.object({
  amount_paid: money(), payment_method: z.enum(PAYMENT_METHODS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  discount_percent: z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(v)), z.number().min(0, 'Must be between 0 and 100.').max(100, 'Must be between 0 and 100.')),
  insurance_provider_id: id(),
});

/** Front-desk checkout: issues a numbered invoice (DocBook snapshots), marks the visit paid and completed. */
async function checkout(ctx, apptId, input) {
  const a = await get(ctx, apptId);
  if (a.appointment_type === 'blocked') throw E.validation({ _: 'Choose a valid value.' });
  if (a.payment_status === 'paid') throw E.conflict('ALREADY_PAID', 'This visit is already paid.');
  const d = validate(checkoutSchema, input);
  const amounts = rules.checkoutAmounts(d.amount_paid, d.discount_percent);
  return knex.transaction(async (trx) => {
    let insuranceName = null;
    if (d.insurance_provider_id) {
      const ins = await trx('insurance_providers').where({ id: d.insurance_provider_id, business_id: ctx.businessId }).first('name');
      if (!ins) throw E.validation({ insurance_provider_id: 'Choose a valid value.' });
      insuranceName = ins.name;
    }
    const number = await businesses.claimInvoiceNumber(ctx.businessId, trx);
    const [invId] = await trx('invoices').insert({
      business_id: ctx.businessId, invoice_number: number, appointment_id: a.id, doctor_id: a.doctor_id, patient_id: a.patient_id,
      doctor_name: a.doctor_name, service_name: a.service_name, patient_name: a.patient_name, patient_phone: a.patient_phone,
      amount: amounts.amount, payment_method: d.payment_method, insurance_provider_id: d.insurance_provider_id || null, insurance_provider_name: insuranceName,
      discount_percent: amounts.discountPercent, discount_amount: amounts.discountAmount, created_by: ctx.userId,
    });
    await trx('appointments').where({ id: a.id }).update({ payment_status: 'paid', paid_at: new Date(), amount_due: amounts.amount, status: a.status === 'cancelled' ? a.status : 'completed', with_doctor: false, updated_at: new Date() });
    await audit.record(ctx, 'invoice.created', { entityType: 'invoice', entityId: invId, newValues: { number, amount: amounts.amount, method: d.payment_method, discount_percent: amounts.discountPercent } }, trx);
    return invId;
  });
}

const invoices = repo({
  table: 'invoices', entity: 'invoice', searchable: ['patient_name', 'patient_phone', 'doctor_name', 'service_name'],
  filters: { doctor: 'doctor_id', method: 'payment_method', insurance: 'insurance_provider_id',
    from: (q, v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && q.where('invoices.created_at', '>=', v), to: (q, v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && q.whereRaw('DATE(invoices.created_at) <= ?', [v]) },
  sortable: { date: 'created_at', number: 'invoice_number', amount: 'amount' }, defaultSort: ['invoice_number', 'desc'], sums: ['amount', 'discount_amount'],
});

/** Voiding an invoice (DocBook: delete + visit back to unpaid) — recorded in the audit log with the full invoice. */
async function voidInvoice(ctx, invId) {
  return knex.transaction(async (trx) => {
    const inv = await invoices.remove(ctx, invId, trx);
    if (inv.appointment_id) await trx('appointments').where({ id: inv.appointment_id, business_id: ctx.businessId }).update({ payment_status: 'unpaid', paid_at: null, updated_at: new Date() });
    return inv;
  });
}

module.exports = {
  confirm,
  STATUSES, PAYMENT_METHODS, patients, savePatient, resolveOrCreatePatient, timeline,
  list, get, book, update, setStatus, checkIn, callIn, assignDoctor, block, move, followUp, remove, checkout, invoices, voidInvoice, expectedFee,
};
