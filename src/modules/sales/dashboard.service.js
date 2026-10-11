// Admin → Sales → Dashboard: the platform's business at a glance — monthly recurring revenue (each paying clinic's
// last paid invoice spread over its months), subscriptions by status, sign-ups and money collected per month, how
// many recent sign-ups became paying, cancellations in the last 30 days, and by country, by CRM source and the
// quotations pipeline. Amounts are kept per currency (never added across currencies).
const knex = require('../../db/knex');

const DAY = 86_400_000;
const n = (v) => Number(v || 0);
const monthKey = (d) => new Date(d).toISOString().slice(0, 7);

function lastMonths(count, now) {
  const out = [];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = count - 1; i >= 0; i -= 1) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return out;
}
const addTo = (map, cur, v) => { map[cur] = Math.round(((map[cur] || 0) + v) * 1000) / 1000; };

async function overview(now = new Date()) {
  const clinics = () => knex('businesses').whereNot('kind', 'center_admin');
  const subs = await knex('clinic_subscriptions as s').join('businesses as b', 'b.id', 's.business_id').whereNot('b.kind', 'center_admin').select('s.business_id', 's.status', 's.updated_at', 'b.country');
  const byStatus = {}; subs.forEach((s) => { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });

  // MRR: active subscriptions, from their latest paid invoice
  const active = subs.filter((s) => s.status === 'active').map((s) => s.business_id);
  const lastPaid = active.length ? await knex('platform_invoices').whereIn('business_id', active).where({ status: 'paid' }).orderBy('paid_at', 'desc').select('business_id', 'amount', 'currency', 'billing_cycle') : [];
  const seen = new Set(); const mrr = {};
  lastPaid.forEach((i) => { if (seen.has(i.business_id)) return; seen.add(i.business_id); addTo(mrr, i.currency, n(i.amount) / (i.billing_cycle === 'yearly' ? 12 : 1)); });

  const months = lastMonths(6, now);
  const from = `${months[0]}-01`;
  const signups = await clinics().where('created_at', '>=', from).select('id', 'created_at', 'country');
  const signupsByMonth = Object.fromEntries(months.map((m) => [m, 0])); signups.forEach((b) => { const k = monthKey(b.created_at); if (k in signupsByMonth) signupsByMonth[k] += 1; });
  const paidRows = await knex('platform_invoices').where({ status: 'paid' }).where('paid_at', '>=', from).select('amount', 'currency', 'paid_at');
  const collected = Object.fromEntries(months.map((m) => [m, {}])); paidRows.forEach((i) => { const k = monthKey(i.paid_at); if (collected[k]) addTo(collected[k], i.currency, n(i.amount)); });

  // Conversion: clinics that signed up 30–120 days ago and have paid at least once
  const cohort = await clinics().whereBetween('created_at', [new Date(now - 120 * DAY), new Date(now - 30 * DAY)]).pluck('id');
  const converted = cohort.length ? n((await knex('platform_invoices').whereIn('business_id', cohort).where({ status: 'paid' }).countDistinct({ c: 'business_id' }))[0].c) : 0;
  const churned = subs.filter((s) => ['expired', 'cancelled'].includes(s.status) && new Date(s.updated_at) >= new Date(now - 30 * DAY)).length;

  const countries = {};
  (await clinics().select('id', 'country')).forEach((b) => { const k = b.country || '—'; countries[k] = countries[k] || { clinics: 0, paying: 0 }; countries[k].clinics += 1; });
  subs.filter((s) => s.status === 'active').forEach((s) => { const k = s.country || '—'; if (countries[k]) countries[k].paying += 1; });

  const sources = await knex('crm_contacts').groupBy('source').select('source').count({ contacts: '*' }).select(knex.raw("SUM(stage = 'customer') as customers"));
  const quotes = await knex('quotes').select('status', 'total', 'currency', 'responded_at', 'valid_until');
  const today = now.toISOString().slice(0, 10);
  const q = { open: {}, openN: 0, won: {}, wonN: 0, lostN: 0 };
  quotes.forEach((x) => {
    const valid = new Date(x.valid_until).toISOString().slice(0, 10) >= today;
    if (['sent', 'negotiating'].includes(x.status) && valid) { q.openN += 1; addTo(q.open, x.currency, n(x.total)); }
    if (x.status === 'accepted' && x.responded_at && new Date(x.responded_at).getUTCFullYear() === now.getUTCFullYear()) { q.wonN += 1; addTo(q.won, x.currency, n(x.total)); }
    if (x.status === 'declined') q.lostN += 1;
  });
  q.winRate = q.wonN + q.lostN ? Math.round((q.wonN / (q.wonN + q.lostN)) * 100) : null;

  return {
    mrr, byStatus, paying: active.length, months, signupsByMonth, collected,
    conversion: { cohort: cohort.length, converted, pct: cohort.length ? Math.round((converted / cohort.length) * 100) : null },
    churned, countries: Object.entries(countries).map(([code, v]) => ({ code, ...v })).sort((a, b) => b.clinics - a.clinics),
    sources: sources.map((r) => ({ source: r.source || 'other', contacts: n(r.contacts), customers: n(r.customers) })).sort((a, b) => b.contacts - a.contacts),
    quotes: q,
  };
}

module.exports = { overview, lastMonths };
