// Landing page pricing: a plan can be marked "most popular" (subscription_plans.is_featured, one highlighted card on
// the platform's home page). A fresh install also gets three starting packages so the pricing section has something to
// show; they are ordinary plans — the platform admin edits, hides or deletes them in Admin → Plans. Nothing is added
// when plans already exist, and features are stored by entitlement key (never checked by plan name).
const ALL_CLINIC = { online_consultations: true, online_payments: true, reminders: true, ai_assistant: true, specialty_modules: true, data_sync: true };
const WEBSITE = (on) => ({
  'website.builder': on, 'website.custom_domain': on, 'website.clinic_email': on, 'website.analytics': on, 'website.advanced_seo': on,
});

const DEFAULTS = [
  {
    name: 'البداية', name_en: 'Starter', sort_order: 1, is_featured: false, price_monthly: 15, price_yearly: 150,
    description: 'لعيادة بطبيب واحد تبدأ الحجز الإلكتروني وتنظيم يومها.',
    description_en: 'For a one-doctor clinic starting online booking and an organised day.',
    max_doctors: 1, max_staff: 3, max_appointments_month: null,
    features: {
      online_consultations: false, online_payments: false, reminders: true, ai_assistant: false, specialty_modules: false, data_sync: false,
      'clinic.max_branches': 1, ...WEBSITE(false), 'website.templates': ['general'], 'website.max_pages': 0, 'website.white_label': false,
      'media.storage_mb': 500, 'limits.max_patients': null,
    },
    branch_prices: { tiers: {}, extra: null },
  },
  {
    name: 'النمو', name_en: 'Growth', sort_order: 2, is_featured: true, price_monthly: 35, price_yearly: 350,
    description: 'لعيادة نشطة بعدة أطباء: موقع كامل، تذكيرات، دفع إلكتروني واستشارات عن بعد.',
    description_en: 'For a busy clinic with several doctors: a full website, reminders, online payments and video visits.',
    max_doctors: 5, max_staff: 15, max_appointments_month: null,
    features: {
      ...ALL_CLINIC, data_sync: false, 'clinic.max_branches': 2, ...WEBSITE(true), 'website.templates': '*', 'website.max_pages': 10,
      'website.white_label': false, 'media.storage_mb': 2048, 'limits.max_patients': null,
    },
    branch_prices: { tiers: { 2: { m: 55, y: 550 } }, extra: null },
  },
  {
    name: 'الشبكة', name_en: 'Network', sort_order: 3, is_featured: false, price_monthly: 69, price_yearly: 690,
    description: 'للمراكز الطبية والعيادات متعددة الفروع، بكل المزايا وبدون حدود للأطباء.',
    description_en: 'For medical centres and multi-branch clinics: every feature, no limit on doctors.',
    max_doctors: null, max_staff: null, max_appointments_month: null,
    features: {
      ...ALL_CLINIC, 'clinic.max_branches': 5, ...WEBSITE(true), 'website.templates': '*', 'website.max_pages': null,
      'website.white_label': true, 'media.storage_mb': 10240, 'limits.max_patients': null,
    },
    branch_prices: { tiers: {}, extra: { m: 20, y: 200 } },
  },
];

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('subscription_plans', 'is_featured'))) {
    await knex.schema.alterTable('subscription_plans', (t) => { t.boolean('is_featured').notNullable().defaultTo(false); });
  }
  const [{ n }] = await knex('subscription_plans').count({ n: '*' });
  if (Number(n)) return;
  await knex('subscription_plans').insert(DEFAULTS.map((p) => ({
    ...p, currency: 'JOD', is_active: true, is_public: true, features: JSON.stringify(p.features), branch_prices: JSON.stringify(p.branch_prices),
  })));
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('subscription_plans', 'is_featured')) await knex.schema.alterTable('subscription_plans', (t) => { t.dropColumn('is_featured'); });
};
