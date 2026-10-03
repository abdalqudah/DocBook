// The packages shown in the landing page's pricing section: the active, public subscription plans exactly as the
// platform admin set them in Admin → Plans (name, prices, limits, branches, included features). Nothing here is
// hard-coded per plan — what a card lists comes from the plan's limits and entitlement keys.
const subs = require('../subscriptions/subscriptions.service');
const entitlements = require('../subscriptions/entitlements');
const branchPricing = require('../subscriptions/branch-pricing');

// Entitlements listed on a card (included ✓ / not included –), in this order. Labels: site.pricing.f.<key with _>.
const LISTED = ['website.builder', 'reminders', 'online_payments', 'online_consultations', 'ai_assistant', 'specialty_modules',
  'website.custom_domain', 'data_sync', 'website.white_label'];

/** A storage size in MB as { n, unit } for the card (null = no limit). */
const sizeOf = (mb) => (mb === null ? null : mb >= 1024 ? { n: num(Math.round((mb / 1024) * 10) / 10), unit: 'gb' } : { n: num(mb), unit: 'mb' });
const num = (v) => new Intl.NumberFormat('en', { minimumFractionDigits: 0, maximumFractionDigits: 3 }).format(Number(v) || 0);

function card(p) {
  const f = p.features || {};
  const branches = entitlements.valueIn(f, 'clinic.max_branches');
  const m = Number(p.price_monthly) || 0;
  const y = Number(p.price_yearly) || 0;
  const second = branches === null || branches > 1 ? branchPricing.priceFor(p, 2, 'monthly') - m : null;
  return {
    id: p.id,
    name: { ar: p.name, en: p.name_en || p.name },
    description: { ar: p.description || '', en: p.description_en || p.description || '' },
    currency: p.currency,
    monthly: num(m),
    yearly: num(y),
    yearlyPerMonth: num(Math.round((y / 12) * 100) / 100),
    free: m === 0 && y === 0,
    save: m > 0 && y > 0 && y < m * 12 ? Math.round((1 - y / (m * 12)) * 100) : 0,
    featured: Boolean(p.is_featured),
    limits: { doctors: p.max_doctors, staff: p.max_staff, branches, secondBranch: second && second > 0 ? num(second) : null },
    features: LISTED.map((key) => ({ key: key.replace(/\./g, '_'), on: entitlements.valueIn(f, key) === true })),
    all: Object.fromEntries([...LISTED, 'website.clinic_email', 'website.analytics', 'website.advanced_seo'].map((key) => [key.replace(/\./g, '_'), entitlements.valueIn(f, key) === true])),
    pages: entitlements.valueIn(f, 'website.max_pages'),
    storage: sizeOf(entitlements.valueIn(f, 'media.storage_mb')),
  };
}

/** { plans: [card…], trialDays } — trialDays only while subscriptions are on (0 otherwise). */
async function forSite() {
  const [plans, st] = await Promise.all([subs.listPlans({ activeOnly: true, publicOnly: true }), subs.settings()]);
  return { plans: plans.map(card), trialDays: st.enabled ? Number(st.trialDays) || 0 : 0 };
}

// Rows of the comparison table on /pricing (after doctors, staff and branches): every yes/no entitlement worth comparing.
const COMPARE = [...LISTED, 'website.clinic_email', 'website.analytics', 'website.advanced_seo'].map((k) => k.replace(/\./g, '_'));

module.exports = { LISTED, COMPARE, card, forSite };
