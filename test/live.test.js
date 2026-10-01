// Live agenda + calendar import (worker: live).
//  • iCal parser: TZID / UTC / floating / all-day, folded lines, escaped text, cancelled events, weekly recurrence
//    with EXDATE and a moved occurrence, unsupported monthly repeats.
//  • Import rules (against docbook_test): never double-book, outside-hours only with the override, past skipped,
//    one import per event UID, patients recognised by phone, imported rows audited with source 'import'.
//  • Change feed: the clinic version changes when an appointment is booked, checked in or cancelled, and new
//    arrivals are reported for the doctor's notice.
//  • Doctor calendar feed: only time + "Appointment" + initial; rotating the token kills the old address.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const knex = require('../src/db/knex');
const auth = require('../src/modules/auth/auth.service');
const businesses = require('../src/modules/businesses/business.service');
const rbac = require('../src/modules/rbac/rbac.service');
const doctors = require('../src/modules/clinic/doctors.service');
const appts = require('../src/modules/clinic/appointments.service');
const scheduling = require('../src/modules/clinic/scheduling');
const ical = require('../src/modules/live/ical');
const importer = require('../src/modules/live/import.service');
const feed = require('../src/modules/live/feed');
const feeds = require('../src/modules/live/feeds');

const TZ = 'Asia/Amman';
const cal = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');
const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');

// ---------------------------------------------------------------- parser (pure)
test('ics: TZID, UTC and floating times are converted to the clinic time zone', () => {
  const text = cal('X-WR-TIMEZONE:Asia/Amman',
    ev('UID:tz1', 'DTSTART;TZID=Europe/London:20261005T090000', 'DTEND;TZID=Europe/London:20261005T093000', 'SUMMARY:London'),
    ev('UID:tz2', 'DTSTART:20261006T060000Z', 'DURATION:PT45M', 'SUMMARY:Utc'),
    ev('UID:tz3', 'DTSTART:20261007T100000', 'DTEND:20261007T102000', 'SUMMARY:Floating'),
    ev('UID:tz4', 'DTSTART;TZID="Jordan Standard Time":20261008T110000', 'DTEND;TZID="Jordan Standard Time":20261008T113000', 'SUMMARY:Outlook'));
  const out = ical.expand(ical.parse(text), { from: '2026-10-01', to: '2026-10-31', timezone: TZ });
  const by = Object.fromEntries(out.map((o) => [o.key, o]));
  assert.deepEqual([by.tz1.date, by.tz1.time, by.tz1.minutes], ['2026-10-05', '11:00', 30]); // BST +1 → Amman +3
  assert.deepEqual([by.tz2.time, by.tz2.minutes], ['09:00', 45]);
  assert.deepEqual([by.tz3.time, by.tz3.minutes], ['10:00', 20], 'floating = calendar zone');
  assert.equal(by.tz4.time, '11:00', 'Windows zone names are understood');
});

test('ics: all-day events, folded lines, escaped text and cancelled events', () => {
  const text = cal(
    ev('UID:ad', 'DTSTART;VALUE=DATE:20261007', 'DTEND;VALUE=DATE:20261008', 'SUMMARY:Conference'),
    ev('UID:fold', 'DTSTART:20261009T070000Z', 'SUMMARY:Ahmad\\, Khaled\\; follow-up', 'DESCRIPTION:first line\\nsecond li', ' ne continues here', 'LOCATION:Room 2\\\\B'),
    ev('UID:cx', 'DTSTART:20261010T070000Z', 'STATUS:CANCELLED', 'SUMMARY:Cancelled one'));
  const out = ical.expand(ical.parse(text), { from: '2026-10-01', to: '2026-10-31', timezone: TZ });
  const by = Object.fromEntries(out.map((o) => [o.key, o]));
  assert.equal(by.ad.allDay, true); assert.equal(by.ad.time, null); assert.equal(by.ad.date, '2026-10-07');
  assert.equal(by.fold.summary, 'Ahmad, Khaled; follow-up');
  assert.equal(by.fold.description, 'first line\nsecond line continues here');
  assert.equal(by.fold.location, 'Room 2\\B');
  assert.equal(by.cx.cancelled, true);
});

test('ics: weekly recurrence with COUNT, EXDATE and a moved occurrence; monthly repeats are only listed', () => {
  const text = cal(
    ev('UID:w1', 'DTSTART;TZID=Asia/Amman:20261004T100000', 'DTEND;TZID=Asia/Amman:20261004T102000', 'RRULE:FREQ=WEEKLY;BYDAY=SU,TU;COUNT=5', 'EXDATE;TZID=Asia/Amman:20261006T100000', 'SUMMARY:Weekly'),
    ev('UID:w1', 'RECURRENCE-ID;TZID=Asia/Amman:20261011T100000', 'DTSTART;TZID=Asia/Amman:20261011T120000', 'DTEND;TZID=Asia/Amman:20261011T123000', 'SUMMARY:Weekly (moved)'),
    ev('UID:m1', 'DTSTART:20261010T080000Z', 'RRULE:FREQ=MONTHLY', 'SUMMARY:Monthly'));
  const out = ical.expand(ical.parse(text), { from: '2026-10-01', to: '2026-12-31', timezone: TZ });
  const weekly = out.filter((o) => o.uid === 'w1');
  assert.deepEqual(weekly.map((o) => `${o.date} ${o.time}`), ['2026-10-04 10:00', '2026-10-11 12:00', '2026-10-13 10:00', '2026-10-18 10:00']);
  assert.equal(new Set(weekly.map((o) => o.key)).size, 4, 'each occurrence has its own key');
  const monthly = out.filter((o) => o.uid === 'm1');
  assert.equal(monthly.length, 1); assert.equal(monthly[0].unsupported, 'monthly');
});

test('ics: phones and patient names are read from the event title', () => {
  const phones = importer.extractPhones('Omar Saleh - 079 123 4567 (follow-up 2026-10-05)');
  assert.deepEqual(phones.map((p) => p.phone), ['0791234567']);
  assert.equal(importer.nameFromTitle('Omar Saleh - 079 123 4567', phones), 'Omar Saleh');
  assert.equal(importer.phoneKey('+962 79 123 4567'), importer.phoneKey('0791234567'));
});

test('ics: the doctor feed is valid iCalendar that the parser reads back', () => {
  const body = ical.build({ name: 'Clinic · Dr, A', events: [{ uid: 'appt-1@docbook', startUtc: Date.UTC(2026, 9, 5, 6, 0), endUtc: Date.UTC(2026, 9, 5, 6, 30), summary: 'Appointment O.' }] });
  assert.match(body, /\r\nDTSTART:20261005T060000Z\r\n/);
  const back = ical.expand(ical.parse(body), { from: '2026-10-01', to: '2026-10-31', timezone: TZ });
  assert.equal(back[0].summary, 'Appointment O.'); assert.equal(back[0].time, '09:00');
});

test('checkSlot: past, overlap, outside hours', () => {
  const wh = scheduling.defaultWorkingHours();
  for (const d of Object.values(wh)) if (d.enabled) d.breaks = [{ start: '13:00', end: '14:00' }];
  const o = { workingHours: wh, busy: [[600, 630]], today: '2026-10-01', nowMinutes: 600 };
  assert.equal(importer.checkSlot({ date: '2026-09-30', time: '10:00', minutes: 30 }, o), 'past');
  assert.equal(importer.checkSlot({ date: '2026-10-01', time: '09:00', minutes: 30 }, o), 'past');
  assert.equal(importer.checkSlot({ date: '2026-10-04', time: '09:45', minutes: 30 }, o), 'conflict');
  assert.equal(importer.checkSlot({ date: '2026-10-04', time: '13:15', minutes: 30 }, o), 'outside_hours', 'break');
  assert.equal(importer.checkSlot({ date: '2026-10-09', time: '10:00', minutes: 30 }, { ...o, busy: [] }), 'outside_hours', 'Friday off');
  assert.equal(importer.checkSlot({ date: '2026-10-04', time: '10:00', minutes: 30 }, { ...o, busy: [], dayOff: true }), 'outside_hours', 'day off');
  assert.equal(importer.checkSlot({ date: '2026-10-04', time: '10:30', minutes: 30 }, o), null);
});

// ---------------------------------------------------------------- database
let ctx; let doctorId; let doctor2Id; let day;

async function clinic(email, name) {
  const userId = await knex.transaction(async (trx) => {
    const id = await auth.createUser(trx, { name: 'Owner', email, password: 'Passw0rd!x' });
    await businesses.create(id, { name, currency: 'JOD', timezone: TZ }, trx);
    return id;
  });
  const { last_business_id: businessId } = await knex('users').where({ id: userId }).first('last_business_id');
  return { businessId, userId, permissions: await rbac.getUserPermissions(businessId, userId), currency: 'JOD', timezone: TZ, ownDoctorId: null };
}
function nextSunday(min = 3) {
  const d = new Date(`${scheduling.clinicNow(TZ).date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + min);
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const compact = (d) => d.replace(/-/g, '');

test.before(async () => {
  await knex.migrate.rollback(undefined, true);
  await knex.migrate.latest();
  ctx = await clinic('owner@live-a.test', 'Live Clinic');
  doctorId = await doctors.saveDoctor(ctx, null, { full_name: 'Dr. Sami', full_name_en: 'Sami', slot_duration_minutes: '30', consultation_fee: '20', base_salary: '0', is_active: '1', show_consultation_fee: '1' });
  doctor2Id = await doctors.saveDoctor(ctx, null, { full_name: 'Dr. Layla', full_name_en: 'Layla', slot_duration_minutes: '20', consultation_fee: '35', base_salary: '0', is_active: '1', show_consultation_fee: '1' });
  day = nextSunday();
});
test.after(() => knex.destroy());

test('import: preview marks conflicts, outside hours and file clashes; import never double-books', async () => {
  await appts.book(ctx, { doctor_id: doctorId, patient_name: 'Existing', patient_phone: '0795550001', appointment_date: day, appointment_time: '10:00' });
  const pid = await appts.savePatient(ctx, null, { full_name: 'Huda Nasser', phone: '0795550099' });
  const D = compact(day);
  const text = cal('X-WR-TIMEZONE:Asia/Amman',
    ev('UID:ok-1', `DTSTART:${D}T110000`, `DTEND:${D}T113000`, 'SUMMARY:Huda N. +962 79 555 0099 Sami'),
    ev('UID:clash-1', `DTSTART:${D}T101500`, `DTEND:${D}T104500`, 'SUMMARY:Clash with existing'),
    ev('UID:late-1', `DTSTART:${D}T190000`, `DTEND:${D}T193000`, 'SUMMARY:Evening visit 0795550123'),
    ev('UID:file-1', `DTSTART:${D}T111500`, `DTEND:${D}T114500`, 'SUMMARY:Overlaps ok-1'),
    ev('UID:layla-1', `DTSTART:${D}T110000`, `DTEND:${D}T112000`, 'SUMMARY:Rana for Layla'));
  const occ = ical.expand(ical.parse(text), { from: day, to: day, timezone: TZ });
  const p = await importer.plan(ctx, occ, { from: day, to: day, doctorMode: 'keyword', keywords: { [doctorId]: 'Sami', [doctor2Id]: 'Layla' }, fallbackDoctorId: doctorId });
  const by = Object.fromEntries(p.rows.map((r) => [r.key, r]));
  assert.equal(by['ok-1'].state, 'ok'); assert.equal(by['ok-1'].patientId, pid, 'recognised by phone'); assert.equal(by['ok-1'].doctorId, doctorId);
  assert.equal(by['clash-1'].state, 'conflict'); assert.equal(by['clash-1'].selectable, false);
  assert.equal(by['late-1'].state, 'outside_hours'); assert.equal(by['late-1'].selected, false);
  assert.equal(by['file-1'].state, 'conflict_file');
  assert.equal(by['layla-1'].doctorId, doctor2Id); assert.equal(by['layla-1'].state, 'ok');

  const pick = (r) => ({ key: r.key, date: r.date, time: r.time, minutes: r.minutes, name: r.name, phone: r.phone, patientId: r.patientId, notes: r.notes, doctorId: r.doctorId });
  // A forged confirm (clash + outside hours without the override) is still refused server-side.
  const res = await importer.commit(ctx, [by['ok-1'], by['clash-1'], by['late-1'], by['file-1'], by['layla-1']].map(pick), { allowOutsideHours: false });
  assert.equal(res.imported, 2);
  assert.deepEqual(res.skipped.map((s) => `${s.row.key}:${s.reason}`).sort(), ['clash-1:conflict', 'file-1:conflict', 'late-1:outside_hours']);
  const a = await knex('appointments').where({ business_id: ctx.businessId, external_uid: 'ok-1' }).first();
  assert.equal(a.source, 'import'); assert.equal(a.patient_id, pid); assert.equal(a.duration_minutes, 30); assert.equal(Number(a.amount_due), 20);
  assert.ok(await knex('audit_logs').where({ business_id: ctx.businessId, action: 'appointment.created', entity_id: String(a.id) }).first());
  assert.ok(await knex('audit_logs').where({ business_id: ctx.businessId, action: 'appointments.imported' }).first());

  // With the override the evening visit is imported (a new patient is created from the phone in the title).
  const res2 = await importer.commit(ctx, [pick(by['late-1'])], { allowOutsideHours: true });
  assert.equal(res2.imported, 1);
  const late = await knex('appointments').where({ business_id: ctx.businessId, external_uid: 'late-1' }).first();
  assert.equal(late.patient_phone, '0795550123'); assert.ok(late.patient_id);
});

test('import: the same event is imported once; past events are skipped', async () => {
  const D = compact(day);
  const text = cal(ev('UID:dup-1', `DTSTART;TZID=Asia/Amman:${D}T150000`, `DTEND;TZID=Asia/Amman:${D}T152000`, 'SUMMARY:Once only'));
  const run = async () => {
    const p = await importer.plan(ctx, ical.expand(ical.parse(text), { from: day, to: day, timezone: TZ }), { from: day, to: day, doctorMode: 'one', doctorId: doctor2Id });
    return p.rows[0];
  };
  const r1 = await run();
  assert.equal(r1.state, 'ok'); assert.equal(r1.name, 'Once only'); assert.equal(r1.phone, '');
  const row = { key: r1.key, date: r1.date, time: r1.time, minutes: r1.minutes, name: r1.name, phone: '', patientId: null, notes: '', doctorId: doctor2Id };
  assert.equal((await importer.commit(ctx, [row])).imported, 1);
  const created = await knex('appointments').where({ business_id: ctx.businessId, external_uid: 'dup-1' }).first();
  assert.equal(created.patient_id, null, 'no phone → name snapshot only, no empty patient record');
  assert.equal((await run()).state, 'duplicate');
  const again = await importer.commit(ctx, [row]);
  assert.equal(again.imported, 0); assert.equal(again.skipped[0].reason, 'duplicate');
  const past = await importer.commit(ctx, [{ ...row, key: 'past-1', date: '2020-01-05' }]);
  assert.equal(past.skipped[0].reason, 'past');
});

test('change feed: the version changes when an appointment changes, and arrivals are reported', async () => {
  const today = scheduling.clinicNow(TZ).date;
  const s0 = await feed.snapshot(ctx.businessId, today);
  const same = await feed.snapshot(ctx.businessId, today);
  assert.deepEqual(feed.diff(s0, same), { dates: [], doctorIds: [] });

  // Direct insert (a booking late today would be refused by the "past time" rule near midnight).
  const [id] = await knex('appointments').insert({ business_id: ctx.businessId, doctor_id: doctor2Id, patient_name: 'Walk-in Nour', appointment_date: today, appointment_time: '23:50', status: 'confirmed', appointment_type: 'in_person', source: 'staff' });
  const s1 = await feed.snapshot(ctx.businessId, today);
  assert.deepEqual(feed.diff(s0, s1), { dates: [today], doctorIds: [doctor2Id] });

  const a0 = await feed.arrivals(ctx.businessId, today);
  await appts.checkIn(ctx, id, true);
  const s2 = await feed.snapshot(ctx.businessId, today);
  assert.deepEqual(feed.diff(s1, s2).dates, [today], 'check-in changes the version');
  const a1 = await feed.arrivals(ctx.businessId, today);
  assert.deepEqual(feed.newArrivals(a0, a1).map((x) => [x.id, x.kind, x.doctorId]), [[id, 'checked_in', doctor2Id]]);
  await appts.callIn(ctx, id, true);
  const a2 = await feed.arrivals(ctx.businessId, today);
  assert.deepEqual(feed.newArrivals(a1, a2).map((x) => x.kind), ['with_doctor']);

  // A change that does not touch updated_at is still seen (fingerprint of the row).
  await knex('appointments').where({ id }).update({ status: 'cancelled' });
  const s3 = await feed.snapshot(ctx.businessId, today);
  assert.deepEqual(feed.diff(s2, s3).doctorIds, [doctor2Id]);
  // Deleting a row is seen too.
  await knex('appointments').where({ id }).del();
  const s4 = await feed.snapshot(ctx.businessId, today);
  assert.deepEqual(feed.diff(s3, s4).dates, [today]);
});

test('doctor calendar feed: minimal details only, rotation kills the old address', async () => {
  await appts.book(ctx, { doctor_id: doctorId, patient_name: 'Zaid Haddad', patient_phone: '0795550777', appointment_date: day, appointment_time: '14:00', notes: 'diabetes follow-up' });
  const token = await feeds.enable(ctx, doctorId, 'en');
  const body = await feeds.render(token);
  assert.match(body, /SUMMARY:Appointment Z\./);
  assert.doesNotMatch(body, /Zaid|Haddad|0795550777|diabetes/);
  const back = ical.expand(ical.parse(body), { from: day, to: day, timezone: TZ });
  assert.ok(back.some((e) => e.time === '14:00'));
  const token2 = await feeds.enable(ctx, doctorId, 'ar');
  assert.equal(await feeds.render(token), null, 'old address stops working');
  assert.match(await feeds.render(token2), /SUMMARY:موعد Z\./);
  await feeds.disable(ctx, doctorId);
  assert.equal(await feeds.render(token2), null);
});
