// Marketing campaigns — DocBook's campaign metrics (engine.campaignMetrics): ROAS, ROI, CPC, CPA, CTR, profit.
const { repo } = require('../../core/crud');
const { z, validate, money, isoDate, optionalString, emptyToUndefined } = require('../../core/validate');
const { E } = require('../../core/errors');
const engine = require('../finance/engine');

const PLATFORMS = ['facebook', 'instagram', 'tiktok', 'google_ads', 'snapchat', 'youtube', 'influencer', 'other'];
const STATUSES = ['active', 'paused', 'completed'];

const campaigns = repo({
  table: 'campaigns', entity: 'campaign', searchable: ['campaign_name', 'target_product', 'notes'], dateColumn: 'start_date',
  filters: { platform: 'platform', status: 'status' }, sortable: { start: 'start_date', cost: 'cost', revenue: 'revenue_generated' }, defaultSort: ['start_date', 'desc'],
  sums: ['cost', 'revenue_generated', 'impressions', 'clicks', 'conversions'],
});

const count = () => z.preprocess((v) => (v === '' || v === undefined ? 0 : Number(String(v).replace(/,/g, ''))), z.number({ invalid_type_error: 'Enter a number.' }).int('Enter a number.').min(0, 'Must be zero or more.'));

const schema = z.object({
  campaign_name: z.string().trim().min(1, 'Required.').max(190),
  platform: z.enum(PLATFORMS, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  start_date: isoDate(),
  end_date: z.preprocess(emptyToUndefined, isoDate().optional()),
  cost: money(), impressions: count(), clicks: count(), conversions: count(), revenue_generated: money(),
  status: z.enum(STATUSES, { errorMap: () => ({ message: 'Choose a valid value.' }) }),
  target_product: optionalString(190),
  notes: optionalString(5000),
});

async function save(ctx, id, input) {
  const d = validate(schema, input);
  if (d.end_date && d.end_date < d.start_date) throw E.validation({ end_date: 'Enter a valid date.' });
  if (d.clicks > d.impressions && d.impressions > 0) throw E.validation({ clicks: 'Too large.' });
  const row = { ...d, end_date: d.end_date || null, target_product: d.target_product || null, notes: d.notes || null };
  if (id) { await campaigns.update(ctx, id, row); return id; }
  return campaigns.create(ctx, row);
}

/** Aggregates campaigns per platform with the same metric formulas (applied to the platform totals). */
function byPlatform(list) {
  const map = {};
  for (const c of list) {
    const p = map[c.platform] || (map[c.platform] = { platform: c.platform, campaigns: 0, cost: 0, revenueGenerated: 0, impressions: 0, clicks: 0, conversions: 0 });
    p.campaigns += 1; p.cost += c.cost; p.revenueGenerated += c.revenueGenerated; p.impressions += c.impressions; p.clicks += c.clicks; p.conversions += c.conversions;
  }
  return Object.values(map).map((p) => ({ ...p, m: engine.campaignMetrics(p) })).sort((a, b) => b.m.roas - a.m.roas);
}

module.exports = { campaigns, save, byPlatform, PLATFORMS, STATUSES };
