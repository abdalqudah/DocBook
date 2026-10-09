// Where each table lives once a clinic has its own database (see tenant.js).
//   PLATFORM  the main database only — shared by everyone (accounts, the list of clinics, subscriptions, the reps'
//             marketplace, things shown across clinics on the main site). A clinic database has a view of each.
//   TENANT    every clinic's (or centre's) own data — a real table in each clinic database.
// Every table is in exactly one list (a test checks it): a new table must be added here with its migration.
const PLATFORM = [
  // accounts and sign-in
  'users', 'sessions', 'email_verifications', 'password_resets', 'team_user_prefs',
  // a DocBook on a clinic's own server ↔ the platform (hub.service): the platform's links; the installation's link and cache
  'hub_links', 'hub_client', 'hub_cache',
  // the clinics, their members, roles and invitations; medical centres
  'businesses', 'memberships', 'roles', 'member_page_access', 'invitations', 'clinic_domains', 'centers', 'center_invites',
  // the platform: settings, billing, subscriptions, notices, media of the main site, support
  'platform_assets', 'platform_settings', 'platform_notifications', 'platform_payments', 'platform_invoices',
  'subscription_plans', 'clinic_subscriptions', 'site_media', 'image_compress_log', 'tenant_dbs', 'support_tickets', 'support_ticket_replies', 'support_ticket_reads',
  // reps & warehouses, their offers, visits to clinics and purchase orders
  'vendors', 'vendor_users', 'vendor_specialties', 'vendor_products', 'vendor_product_specialties', 'vendor_offers', 'vendor_offer_cities',
  'vendor_offer_products', 'vendor_offer_specialties', 'vendor_offer_targets', 'vendor_offer_views', 'vendor_plans', 'vendor_subscriptions',
  'vendor_invoices', 'vendor_ads', 'rep_visits', 'rep_visit_slots', 'purchase_orders', 'purchase_order_items', 'purchase_receipts',
  // shown on the main site across clinics
  'reviews', 'articles',
  // patients moved or shared between the clinics of one owner (each clinic may have its own database)
  'patient_transfers', 'patient_transfer_items', 'patient_links',
  // migrations
  'knex_migrations', 'knex_migrations_lock',
];

const TENANT = [
  'ai_clinic_settings', 'ai_finance_actions', 'ai_finance_messages', 'ai_finance_runs', 'ai_finance_settings', 'ai_requests',
  'antenatal_visits', 'appointments', 'appointment_links', 'attendance_kiosks', 'attendance_records', 'attendance_schedules', 'attendance_settings',
  'audit_logs', 'bank_templates', 'bank_transfers', 'budgets', 'calendar_feeds', 'cash_closings',
  'center_expenses', 'center_expense_shares', 'center_staff',
  'certificates', 'certificate_sequences', 'clinic_branches', 'clinic_data_sync', 'clinic_fonts', 'clinic_mail_accounts', 'clinic_mail_log',
  'clinic_media', 'clinic_messages', 'clinic_messaging', 'clinic_ops_settings', 'clinic_partners', 'clinic_sites', 'clinic_site_stats',
  'clinic_site_versions', 'clinic_stamps', 'commission_rules', 'consultations', 'consultation_diagnoses', 'consultation_timers',
  'data_sync_runs', 'demo_records', 'dental_entries', 'dental_plan_items', 'doctors', 'doctor_days_off', 'doctor_emails', 'doctor_online_slots',
  'doctor_signatures', 'expenses', 'expense_categories', 'growth_measurements', 'icd_custom_codes', 'import_batches', 'import_errors', 'import_items', 'import_jobs', 'import_links', 'insurance_providers',
  'insurance_statements', 'invoices', 'legacy_clinical_records', 'legacy_clinical_values', 'legacy_branch_map', 'legacy_doctor_map', 'legacy_field_values', 'legacy_patient_links', 'legacy_patients', 'legacy_treatments', 'invoice_payments', 'media_usages', 'medical_orders', 'medications', 'message_dispatches', 'message_log',
  'notifications', 'notification_email_rules', 'notification_reads', 'online_consultations', 'online_consultation_files', 'order_catalog',
  'partners', 'partner_sends', 'partner_transactions', 'patients', 'patient_accounts', 'patient_account_codes', 'patient_portal_settings', 'patient_documents', 'patient_files', 'patient_attachments', 'patient_groups', 'patient_group_members', 'patient_photos', 'payments', 'payment_gateways',
  'payroll_adjustments', 'payroll_payments', 'pregnancies', 'pregnancy_checks', 'prescriptions', 'profit_distributions', 'queue_screens',
  'record_access_grants', 'record_access_log', 'recurring_expenses', 'referrals', 'services', 'service_categories', 'share_links',
  'sheet_sync_runs', 'sheet_sync_settings', 'specialty_records', 'specialty_settings', 'staff_chats', 'staff_chat_files', 'staff_chat_members', 'staff_chat_messages',
  'staff_employees', 'staff_mailboxes', 'staff_payroll_adjustments', 'staff_payroll_lines', 'stock_movements', 'suppliers', 'supply_items',
  'surgeries', 'telehealth_signals', 'user_presence',
];

const PLATFORM_SET = new Set(PLATFORM);
const TENANT_SET = new Set(TENANT);
const isPlatform = (t) => PLATFORM_SET.has(t);
const isTenant = (t) => TENANT_SET.has(t);

module.exports = { PLATFORM, TENANT, isPlatform, isTenant };
