// Key/value settings with defaults, cached in memory. Secrets inside settings are stored encrypted (core/secrets)
// by the module that owns them; this service never returns them to views.
const knex = require('../../db/knex');
const audit = require('../../core/audit');

const DEFAULTS = {
  branding: {
    name: 'GEC',
    legal_name: 'Global Education Consultants',
    tagline_en: 'Your gateway to global education',
    tagline_ar: 'بوابتك إلى التعليم العالمي',
    primary: '#0B4D2C',
    secondary: '#0A0F0C',
    accent: '#84CC16',
    logo_media_id: null, // uploaded logo; otherwise /brand/logo-horizontal.webp
    logo_white_media_id: null,
    favicon_media_id: null,
    email_logo_media_id: null,
    email_footer_en: 'Global Education Consultants · You receive this e-mail because you contacted GEC.',
    email_footer_ar: 'جلوبال للاستشارات التعليمية · تصلك هذه الرسالة لأنك تواصلت مع GEC.',
  },
  company: {
    email: 'info@geccolleges.com',
    phone: '+1 (773) 943-9360',
    whatsapp: '17739439360',
    address_en: 'Chicago, Illinois, USA',
    address_ar: 'شيكاغو، إلينوي، الولايات المتحدة',
    website: '',
    social: { facebook: '', instagram: '', linkedin: '', tiktok: '', youtube: '', x: '' },
  },
  general: { default_currency: 'USD', timezone: 'America/Chicago', week_starts: 'sunday' },
  privacy: { cookie_banner: true, analytics_requires_consent: true, retention_months: 36, policy_url: '/privacy' },
  leads: { assignment: 'round_robin', first_response_hours: 24 }, // round_robin | rules | manual
  appointments: { min_notice_hours: 12, max_days_ahead: 60, reminder_hours: 24 },
};

const cache = new Map();

async function get(key) {
  if (cache.has(key)) return cache.get(key);
  const row = await knex('settings').where({ key }).first();
  let value = row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : null;
  if (DEFAULTS[key] && value && typeof value === 'object' && !Array.isArray(value)) value = { ...DEFAULTS[key], ...value };
  if (value === null && DEFAULTS[key] !== undefined) value = DEFAULTS[key];
  cache.set(key, value);
  return value;
}

async function set(ctx, key, value) {
  const before = await get(key);
  const json = JSON.stringify(value);
  await knex.raw('INSERT INTO settings (`key`, `value`, updated_at, updated_by) VALUES (?, ?, NOW(), ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = NOW(), updated_by = VALUES(updated_by)', [key, json, ctx?.userId || null]);
  cache.delete(key);
  if (ctx) {
    const { oldValues, newValues, changed } = audit.diff(before && typeof before === 'object' ? before : { value: before }, typeof value === 'object' && value ? value : { value });
    if (changed) await audit.record(ctx, 'settings.updated', { entityType: 'settings', entityId: key, oldValues, newValues });
  }
  return value;
}

/** Merges `patch` into an object setting. */
async function patch(ctx, key, values) {
  const current = (await get(key)) || {};
  return set(ctx, key, { ...current, ...values });
}

const clearCache = () => cache.clear();

module.exports = { get, set, patch, DEFAULTS, clearCache };
