// Bookings & no-shows report: no-show rate per doctor, bookings by channel (count, share, attendance,
// no-shows), weekly online-vs-staff trend. Blocked times are never counted.
//   no-show rate = no_show ÷ (completed + no_show)   (only visits that were due; null when none)
const knex = require('../../db/knex');
const lib = require('../clinic/records.lib');
const { CHANNELS } = require('./channels');

const num = (v) => Number(v) || 0;
/** No-show rate in % (null when nothing was due). */
const noShowRate = ({ completed, noShow }) => (num(completed) + num(noShow) ? (num(noShow) * 100) / (num(completed) + num(noShow)) : null);
const share = (n, total) => (total ? (num(n) * 100) / total : 0);

/** SQL for an appointment's channel (rows booked before channels existed fall back to their source). */
const CHANNEL_SQL = "COALESCE(a.booking_channel, CASE WHEN a.source = 'website' THEN 'website' ELSE 'staff' END)";

/** Sunday that starts the week of a YYYY-MM-DD date. */
function weekStart(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

const counts = (q) => q.count({ n: '*' })
  .select(knex.raw("SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as completed"))
  .select(knex.raw("SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) as no_show"))
  .select(knex.raw("SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled"));

const row = (r) => {
  const out = { n: num(r.n), completed: num(r.completed), noShow: num(r.no_show), cancelled: num(r.cancelled) };
  out.due = out.completed + out.noShow;
  out.rate = noShowRate(out);
  out.attendance = out.due ? (out.completed * 100) / out.due : null;
  return out;
};

/** @returns {{ totals, doctors, channels, weeks, online, staff }} */
async function build(ctx, range, { locale = 'ar' } = {}) {
  const base = () => {
    const q = knex('appointments as a').where('a.business_id', ctx.businessId).whereNot('a.appointment_type', 'blocked').whereBetween('a.appointment_date', [range.from, range.to]);
    if (ctx.ownDoctorId) q.where('a.doctor_id', ctx.ownDoctorId);
    return require('../clinic/branches.service').scope(q, ctx, 'a.branch_id'); // eslint-disable-line global-require -- the branch chosen in the account menu
  };
  const [totalRow, docRows, chRows, dayRows, docs] = await Promise.all([
    counts(base()).first(),
    counts(base().groupBy('a.doctor_id').select('a.doctor_id')),
    counts(base().groupByRaw(CHANNEL_SQL).select(knex.raw(`${CHANNEL_SQL} as ch`))),
    base().groupBy('a.appointment_date').groupByRaw(`(${CHANNEL_SQL} = 'staff')`)
      .select('a.appointment_date as d', knex.raw(`(${CHANNEL_SQL} = 'staff') as is_staff`)).count({ n: '*' }),
    knex('doctors').where({ business_id: ctx.businessId }).select('id', 'full_name', 'full_name_en', 'color'),
  ]);
  const totals = row(totalRow || {});
  const docName = Object.fromEntries(docs.map((d) => [d.id, (locale === 'en' && d.full_name_en) || d.full_name]));
  const docColor = Object.fromEntries(docs.map((d) => [d.id, d.color]));
  const doctors = docRows.map((r) => ({ id: r.doctor_id, name: docName[r.doctor_id] || null, color: docColor[r.doctor_id] || null, ...row(r) }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.n - a.n);

  const byCh = new Map(chRows.map((r) => [r.ch, row(r)]));
  const known = CHANNELS.filter((k) => byCh.has(k));
  const extra = [...byCh.keys()].filter((k) => !CHANNELS.includes(k)); // stored values from elsewhere, shown as-is
  const channels = [...known, ...extra].map((k) => ({ key: k, ...byCh.get(k), share: share(byCh.get(k).n, totals.n) }))
    .sort((a, b) => b.n - a.n);

  const weeks = new Map();
  for (let w = weekStart(range.from); w <= range.to; w = lib.addDays(w, 7)) weeks.set(w, { week: w, online: 0, staff: 0 });
  dayRows.forEach((r) => {
    const w = weeks.get(weekStart(String(r.d).slice(0, 10)));
    if (w) w[num(r.is_staff) ? 'staff' : 'online'] += num(r.n);
  });
  const staff = byCh.has('staff') ? byCh.get('staff').n : 0;
  return { totals, doctors, channels, weeks: [...weeks.values()], online: totals.n - staff, staff };
}

module.exports = { build, noShowRate, share, weekStart, CHANNEL_SQL };
