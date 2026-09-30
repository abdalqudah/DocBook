// Website statistics (redesign 4.14): first-party daily counters of the clinic's public pages. No cookies, no
// visitor identifiers, no IP addresses — only "this page kind was opened on this day". Search-engine robots and
// signed-in members (staff previewing) are not counted. Counting never slows or breaks the page.
const knex = require('../../db/knex');
const { clinicNow } = require('../clinic/scheduling');

const KINDS = ['home', 'doctor', 'book'];
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|preview|monitor|curl|wget|python|headless/i;

function hit(req, clinic, kind) {
  if (!clinic || !clinic.id || !KINDS.includes(kind) || req.method !== 'GET') return;
  if (req.user || BOT.test(String(req.get('user-agent') || ''))) return;
  const day = clinicNow(clinic.timezone || 'Asia/Amman').date;
  knex.raw('INSERT INTO clinic_site_stats (business_id, day, kind, views) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE views = views + 1', [clinic.id, day, kind]).catch(() => {});
}

/** Last `days` days: per-day views by kind, totals, and online bookings by channel. */
async function summary(businessId, today, days = 30) {
  const from = new Date(`${today}T00:00:00Z`); from.setUTCDate(from.getUTCDate() - (days - 1));
  const since = from.toISOString().slice(0, 10);
  const [rows, bookings, byDoctor, reviews] = await Promise.all([
    knex('clinic_site_stats').where({ business_id: businessId }).where('day', '>=', since).select('day', 'kind', 'views'),
    knex('appointments').where({ business_id: businessId }).whereNot('appointment_type', 'blocked').where('created_at', '>=', `${since} 00:00:00`)
      .groupByRaw("COALESCE(booking_channel, CASE WHEN source = 'website' THEN 'website' ELSE 'staff' END)")
      .select(knex.raw("COALESCE(booking_channel, CASE WHEN source = 'website' THEN 'website' ELSE 'staff' END) AS channel")).count({ n: '*' }),
    knex('appointments as a').leftJoin('doctors as d', 'd.id', 'a.doctor_id').where('a.business_id', businessId).where('a.source', 'website').where('a.created_at', '>=', `${since} 00:00:00`)
      .groupBy('a.doctor_id', 'd.full_name', 'd.full_name_en').select('a.doctor_id', 'd.full_name', 'd.full_name_en').count({ n: '*' }).orderBy('n', 'desc').limit(5),
    knex('reviews').where({ business_id: businessId, status: 'published' }).where('created_at', '>=', `${since} 00:00:00`).select(knex.raw('COUNT(*) AS n'), knex.raw('AVG(rating) AS avg')).first(),
  ]);
  const perDay = [];
  for (let i = 0; i < days; i += 1) { const d = new Date(from); d.setUTCDate(d.getUTCDate() + i); perDay.push({ day: d.toISOString().slice(0, 10), home: 0, doctor: 0, book: 0 }); }
  const idx = Object.fromEntries(perDay.map((p, i) => [p.day, i]));
  const totals = { home: 0, doctor: 0, book: 0 };
  rows.forEach((r) => { const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10); const i = idx[day]; if (i !== undefined) { perDay[i][r.kind] += Number(r.views); totals[r.kind] += Number(r.views); } });
  const channels = bookings.map((b) => ({ channel: b.channel, n: Number(b.n) })).filter((c) => c.channel !== 'staff').sort((a, b) => b.n - a.n);
  const online = channels.reduce((s, c) => s + c.n, 0);
  return {
    since, perDay, totals, channels, online, conversion: totals.book ? Math.round((online / totals.book) * 1000) / 10 : null,
    byDoctor: byDoctor.map((d) => ({ id: d.doctor_id, name: d.full_name, name_en: d.full_name_en, n: Number(d.n) })),
    reviews: { n: Number(reviews && reviews.n) || 0, avg: reviews && reviews.avg ? Number(reviews.avg) : null },
  };
}

module.exports = { KINDS, hit, summary };
