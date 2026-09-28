// Budget alerts: turns engine.budgetStatus() into in-app notifications (once per budget, month and level).
const notifications = require('../notifications/notification.service');
const { translator } = require('../../core/i18n');
const { has } = require('../../core/i18n');

const label = (t, locale, key) => (has(locale, `categories.${key}`) ? t(`categories.${key}`) : key);

async function sync(businessId, budgetLines, month, locale = 'en') {
  const t = translator(locale);
  for (const b of budgetLines) {
    if (!b.isWarning && !b.isExceeded) continue; // eslint-disable-line no-continue
    const level = b.isExceeded ? 'exceeded' : 'warning';
    const name = label(t, locale, b.category);
    await notifications.notify(businessId, { // eslint-disable-line no-await-in-loop
      permission: 'budgets.view',
      type: `budget.${level}`,
      severity: b.isExceeded ? 'danger' : 'warning',
      dedupeKey: `budget:${b.id}:${month}:${level}`,
      title: t(`budgets.alert_${level}_title`, { category: name }),
      body: t('budgets.alert_body', { pct: Math.round(b.usagePercent), month }),
      link: `/app/budgets?month=${month}`,
    });
  }
}

module.exports = { sync };
