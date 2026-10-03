// Every DocBook feature for the public "All features" page (/features), grouped by what a clinic does, each group
// with a real screenshot of the platform. Titles and texts come from the landing translations (site.d.showcase /
// site.d.features), so the page and the home page tell the same story. Pictures: public/img/landing/<lang>/.
const SCREENS = ['today', 'calendar', 'patient', 'surgeries', 'cash', 'frontdesk', 'builder'];
const FLOWS = ['flow-visit', 'flow-surgery'];

// [source ('s' showcase | 'f' features), key, icon]
const CATEGORIES = [
  { key: 'appointments', screen: 'calendar', items: [['s', 'booking', 'calendar-check'], ['f', 'calendar', 'calendar-days'], ['f', 'frontdesk', 'armchair'], ['s', 'queue', 'monitor'], ['s', 'voice', 'volume-2'], ['s', 'call', 'bell'], ['s', 'timer', 'timer'], ['s', 'messages', 'message-square'], ['s', 'intake', 'clipboard-list'], ['s', 'branches', 'building-2']] },
  { key: 'records', screen: 'patient', items: [['f', 'records', 'notebook-pen'], ['s', 'specialty', 'stethoscope'], ['s', 'orders', 'activity'], ['s', 'referrals', 'send'], ['s', 'files', 'paperclip'], ['s', 'letterhead', 'stamp'], ['s', 'share', 'file-check'], ['s', 'telehealth', 'video']] },
  { key: 'surgeries', screen: 'surgeries', items: [['s', 'surgeries', 'scissors'], ['s', 'hospital', 'hospital']] },
  { key: 'money', screen: 'cash', items: [['s', 'cash', 'banknote'], ['s', 'invoice', 'receipt'], ['f', 'billing', 'receipt'], ['f', 'payroll', 'hand-coins'], ['s', 'prices', 'tag'], ['s', 'ai', 'bot']] },
  { key: 'team', screen: 'today', items: [['f', 'staff', 'user-cog'], ['s', 'chat', 'message-circle'], ['s', 'mailbox', 'mail'], ['f', 'supplies', 'package'], ['f', 'languages', 'languages'], ['s', 'dark', 'moon']] },
  { key: 'partners', screen: 'frontdesk', items: [['s', 'centres', 'pill-bottle'], ['s', 'texts', 'pen-line'], ['s', 'review', 'star']] },
  { key: 'website', screen: 'builder', items: [['s', 'website', 'layout-template'], ['s', 'carousel', 'layout-grid'], ['s', 'icons', 'dt-tooth']] },
  { key: 'data', screen: null, items: [['f', 'security', 'shield-check'], ['s', 'backup', 'database'], ['s', 'export', 'package'], ['s', 'import', 'upload'], ['s', 'storage', 'database']] },
];

/** The page's groups with their cards in `t`'s language. */
function groups(t) {
  return CATEGORIES.map((c) => ({
    key: c.key, screen: c.screen,
    items: c.items.map(([src, k, icon]) => {
      const base = `site.d.${src === 's' ? 'showcase' : 'features'}.items.${k}`;
      return { key: k, icon, title: t(`${base}.title`), text: t(`${base}.text`) };
    }),
  }));
}

module.exports = { SCREENS, FLOWS, CATEGORIES, groups };
