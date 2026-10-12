# MedWorks (formerly DocBook): Feature Inventory

Audit date: 2026-10-12. Codebase at HEAD `9de863a` ("2.9.51: staff leave, chronic disease tracking…"), plus the uncommitted edits to `src/server.js` and `src/config/index.js` (production config checks and graceful shutdown; these add no feature).
This inventory comes from the code itself: router mounts, permission guards, migrations, `src/db/tables.js` and the tests. README and docs claims were not used.

**Scale:** 67 module directories under `src/modules/`, 132 migrations under `src/db/migrations/`, 119 `test/*.test.js` files. Tests use `node:test` and mostly call services directly; some send HTTP requests.

**Legend**
- **Data:** `(P)` = PLATFORM table (main DB only). `(T)` = TENANT table (each clinic DB when per-clinic databases are on). Source: `src/db/tables.js`.
- **Access:** permission keys from `src/modules/rbac/permissions.js`, enforced with `can()` / `canAny()` (`src/middleware/context.js`) in the routers and by `perms` in `src/routes/nav.js`. Other values:
  - "platform admin" = `users.is_platform_admin` (`src/modules/admin/web.js`; anyone else gets a 404).
  - "vendor" = `requireVendor` (`src/middleware/vendor.js`).
  - "token" = a public link that carries a secret token.
  - "any member" = signed in to the clinic, with no permission key required.
- **Clinic pages also pass these gates:**
  - every `/app` page: `requireAuth`, then `resolveBusiness`, then the subscription gate (`subscriptions/enforce.js`), then the module on/off gate (`platformops/gate.js`), then per-member page access (`access/gate.js`);
  - `/app` only: the onboarding redirect.
- **Status:**
  - COMPLETE = implemented and tested.
  - IMPLEMENTED-UNTESTED = implemented, but no test exercises it.
  - PARTIAL = something is missing (the row says what).
  - NOT PRESENT = no code for it.

**Main mounts**
- `src/routes/web.js`: public pages, `/app`, `/admin`, `/vendors`, `/vendor`, `/verify`, `/kiosk`, `/queue`, `/calendar`, `/m`, `/c`, `/pay`, `/d`, `/r`, `/<slug>/…`.
- `src/routes/app.js`: the clinic app under `/app`.
- `src/modules/admin/web.js`: the platform admin under `/admin`.
- `src/app.js`, raw-body routes mounted before the session middleware: `/hub/v1`, `/hub-in/v1`, `/hooks` (WhatsApp/SMS webhooks), `/pay` (PayTabs callback).

---

## 1. Module inventory by area

### 1.1 Platform core, identity and tenancy

| Module | What it does | Main routes | Data | Access | Jobs | Tests | Status |
|---|---|---|---|---|---|---|---|
| `auth` | Sign-in, sign-up, 2FA, password reset, email verification, invitations, workspace/branch switch, Google sign-in | `GET/POST /login`, `/login/2fa`, `/signup`, `/forgot`, `/reset/:token`, `/verify-email/:token`, `/invite/:token`, `/workspaces/new`, `/workspaces/switch`, `/auth/google[/callback]` | users, sessions, password_resets, email_verifications, memberships, roles (P) | public / token | none | identity, security, owner, most tests (fixtures) | COMPLETE |
| `businesses` | Clinic records, slugs, `RESERVED` paths, members, logos and favicons | service only | businesses, memberships, invitations (P) | used by others | none | used by almost every test | COMPLETE |
| `rbac` | Permission catalog, system roles, custom roles, `syncSystemRoles` at boot | service only (roles UI is in `settings`) | roles, memberships (P) | n/a | runs at boot | security-roles, access | COMPLETE |
| `access` | Per-member page allow/deny on top of the role | `/app/clinic/team/:id/access` | member_page_access (P) | `users.manage` | none | access | COMPLETE |
| `edition` | Single-clinic or single-centre install (`APP_EDITION=clinic\|center`) created from `.env` at boot | none (`middleware/edition.js` routes it) | businesses, users (P) | n/a | runs at boot | edition, edition-center, edition-clean-urls, edition-mailbox | COMPLETE |
| `onboarding` | New-clinic setup wizard: clinic, hours, doctors, services, team, booking | `/app/onboarding`, `/app/onboarding/:step` | businesses, invitations (P); doctors, services (T) | `settings.manage`, `doctors.manage`, `services.manage`, `users.manage` | none | owner, redesign, booking-any, website | COMPLETE |
| `settings` | Clinic profile, appearance, account, security/sessions, insurance companies, medications, team, roles, data export/delete, audit log | `/app/settings/{clinic,appearance,account,security,insurance,medications,portal,data}`, `/app/clinic/team`, `/app/clinic/roles` | roles, memberships, invitations, users (P); audit_logs, insurance_providers, medications (T) | `settings.manage`, `users.manage`, `roles.manage`, `data.export`, `data.manage`, `audit.view` | none | owner, team-details, team-login-send, security-roles, branding | COMPLETE |
| `branding` | Clinic theme CSS; custom domains and their checks | `/app/theme/:id.css` (domain UI is in `website` and `admin/identity`) | clinic_domains (P) | members / platform admin | `domain.service.recheckDue`, every 6 h | branding, identity, clean-urls | COMPLETE |
| `storage` | Per-clinic file-storage usage and quota | service only | businesses (P) | n/a | none | media-quota, edition | COMPLETE |
| `feedback` | In-app NPS question to clinic owners | `POST /app/feedback` | nps_responses, crm_contacts (P) | any member | none | platform-reach | COMPLETE |
| Tenancy (`src/db/tenant.js`, `tables.js`) | Optional per-clinic MySQL database (`businesses.db_name`), routed with AsyncLocalStorage, views onto the shared tables, moving clinics between databases | `/admin/databases` (in `platformops`) | tenant_dbs (P) | platform admin | jobs run per database through `tenant.eachDb` | tenant-db, tenant-tables | COMPLETE |

### 1.2 Clinic operations (front office and staff)

The `clinic` module (`src/modules/clinic/`, 36 files, about 6.7k lines) holds most of the core clinic features. Its parts are listed separately.

| Feature (module) | What it does | Main routes (`/app…`) | Data | Access | Jobs | Tests | Status |
|---|---|---|---|---|---|---|---|
| Clinic dashboard (`clinic/dashboard.web.js`) | Today overview, setup checklist, doctor's "My day" | `GET /app`, `GET /app/my-day` | appointments, invoices (T) | `dashboard.view`; `clinical.view` and a doctor profile for my-day | none | redesign, clinic-flow | COMPLETE |
| Appointments / calendar (`clinic/appointments.web.js`, `scheduling.js`) | Calendar views; book, edit, move, transfer; time blocks; follow-ups; call patient in; print/export; slot lock | `/appointments`, `/appointments/new`, `/:id/{edit,status,move,call,confirm,transfer,follow-up}`, `/appointments/blocks`, `/appointments/export` | appointments, patients, doctors, doctor_day_rooms (T) | `appointments.view`, `appointments.manage`, `appointments.view_all`, `frontdesk.use`, `data.export` | none | appointments-move, appointment-call, slot-lock, doctor-order, clinic-flow, clinic-rules | COMPLETE |
| Working hours (`clinic/hours.web.js`) | The clinic's usual week | `GET/POST /clinic/hours` | businesses (P) | `settings.manage` | none | staff-reps | COMPLETE |
| Doctors (`clinic/doctors.web.js`, `my-profile.web.js`) | Doctor profiles, days off, rooms, social links; a doctor edits own profile and services | `/doctors`, `/doctors/new`, `/doctors/:id/{edit,days-off}`, `/my-profile` | doctors, doctor_days_off, doctor_branches (T) | `doctors.manage` (list also with `appointments.view_all`); my-profile needs a doctor login | none | site-people, my-profile, branches, queue | COMPLETE |
| Services (`clinic/services.web.js`) | Service catalogue, categories, prices | `/services`, `/services/categories` | services, service_categories (T) | `services.manage` | none | website, my-profile, branch-switch | COMPLETE |
| Patients (`clinic/patients.web.js`, `patient-profile.js`) | Patient list, profile, edit, photo, groups, branches, summary, delete; export/import (Excel/JSON) | `/patients`, `/patients/:id[/edit\|/summary\|/photo]`, `/patients/import`, `/patients/export-all` | patients, patient_photos, patient_groups, patient_group_members, patient_branches (T) | `patients.view/create/edit/delete`, `clinical.view`, `data.export`, `data.manage`; a doctor login only sees own patients (`scopePatientsToDoctor`) | none | patient-profile, patient-import, patient-export | COMPLETE |
| Front desk / waiting room (`clinic/frontdesk.web.js`) | Expected and arrived lists, check-in, intake vitals, walk-in, no-show, call-in, checkout | `/front-desk`, `/front-desk/:id/{check-in,call-in,no-show,intake,checkout}`, `/front-desk/walk-in` | appointments (T) | `frontdesk.use`, `vitals.edit`, `billing.manage`, `appointments.manage` | none | frontdesk-intake, cash-arrived-rooms, queue | COMPLETE |
| Visits / consultation (`clinic/visits.web.js`, `clinical.service.js`) | Vitals, notes, prescriptions, start/finish visit | `/visits/:id`, `/visits/:id/{vitals,note,prescriptions,start,finish,complete}` | consultations, prescriptions (T) | `clinical.view/edit`, `vitals.edit`, `prescriptions.create` | none | clinic-flow, dflow | COMPLETE |
| Cashier (`clinic/cashier.web.js`, `cashier.service.js`) | Cash screen, checkout with payment parts, receipts, cash expenses, end-of-day cash closings | `/cashier`, `/cashier/screen`, `/cashier/screen/checkout`, `/cashier/receipt/:id`, `/cashier/closings` | invoices, invoice_payments, cash_closings, expenses (T) | `billing.manage`, `billing.view`, `expenses.manage`, `data.export` | none | cashier, cashx, invoice, cash-arrived-rooms | COMPLETE |
| Billing / invoices (`clinic/billing.web.js`) | Invoice list, payments list, void, waive unpaid | `/billing`, `/billing/payments`, `/billing/:id/void`, `/billing/unpaid/:id/waive` | invoices, invoice_payments (T) | `billing.view`, `billing.void`, `data.export` | none | invoice, math-audit | COMPLETE |
| Doctor payroll / commissions (`clinic/payroll.web.js`) | Commission rules, adjustments with approval, pay/unpay, payslip | `/payroll`, `/payroll/doctors/:id[/rule\|/pay\|/payslip]`, `/payroll/adjustments/:adj/review` | payroll_payments, payroll_adjustments, commission_rules (T) | `payroll.view`, `payroll.manage`, `payroll.approve` | none | clinic-rules, payouts, math-audit | COMPLETE |
| Supplies / stock (`clinic/supplies.web.js`) | Items, stock movements, suppliers, low-stock badge | `/supplies`, `/supplies/items/:id[/move]`, `/supplies/suppliers` | supply_items, stock_movements, suppliers (T) | `supplies.view`, `supplies.manage` | none | purchasing, branch-stock-chat | COMPLETE |
| Branches (`clinic/branches.web.js`, `branches.merge.js`) | Branches within one clinic, merge a clinic in as a branch | `/clinic/branches` | clinic_branches, doctor_branches, patient_branches (T) | `settings.manage`; also needs `businesses.branches_allowed` (set by the platform) and the plan's `clinic.max_branches` | none | branches, branches-off, branch-merge, branch-switch | COMPLETE |
| Reports (`clinic/reports.web.js`, plus `discover`, `clinicalplus`, `orders`) | Appointments by status/doctor/service/source, no-shows, new vs returning patients, revenue by method, discounts, expenses/payroll/net; booking-source, diagnosis, consultation-time and clinical-order reports | `/reports`, `/reports/bookings`, `/reports/diagnoses`, `/reports/consultation-time`, `/reports/clinical` | appointments, invoices, expenses, consultation_diagnoses (T) | `reports.view` (finance lines also need `finance.view`) | none | branch-switch, orders, discover, clinicalplus | COMPLETE |
| Search and API (`clinic/search.web.js`, `api.web.js`) | Global search; slots/services JSON for forms | `/search`, `/api/slots`, `/api/services` | patients, appointments (T) | any member / `appointments.view` | none | redesign, branch-switch | COMPLETE |
| Clinical setup hub (`clinic/setup.web.js`) | Hub page linking the clinical lists | `/clinic/setup` | none | `settings.manage`, `prescriptions.create`, `clinical.edit` (nav) | none | redesign | COMPLETE |
| `queue` | Waiting-room TV screens opened by a secret link; called patient, next, waiting, room | staff: `/app/queue-screens`; public: `/queue/:token[/data]` | queue_screens, appointments (T) | `frontdesk.use`, `appointments.manage`; screen by token | none | queue, appointment-call, center | COMPLETE |
| `live` | Live agenda events (polling), import a calendar (ICS) into appointments, private iCal feed per doctor | `/app/live/events`, `/app/appointments/import-calendar`, `/app/appointments/calendar-feed`, public `/calendar/:token.ics` | calendar_feeds, appointments (T) | `appointments.view/manage`, `doctors.manage`; feed by token | none | live, legacy-remote | COMPLETE |
| `surgeries` | Surgery time blocks (patient, procedure, hospital); send date to hospital by email or WhatsApp | `/app/surgeries`, `/app/surgeries/:id[/status\|/send]` | surgeries (T) | `clinical.view`, `clinical.edit`, `appointments.manage` | none | surgeries, center-admin | COMPLETE |
| `center` | Medical centre: practices sharing reception, cash screen, staff, cost split, invites; centre admin account | `/app/center[/doctors\|staff\|expenses\|settings]`, `/app/center/desk`, `/app/center/costs`, `/workspaces/center/:token` | centers, center_invites (P); center_staff, center_expenses, center_expense_shares (T) | `settings.manage`, `frontdesk.use`, `expenses.view/manage` | none | center, center-admin, center-shared, center-import, edition-center | COMPLETE |
| `notifications` | In-app notifications and read state | `/app/notifications[/panel\|/read]` | notifications, notification_reads (T) | any member (targeted by permission) | none | frontdesk-intake, staff-reps, branch-switch | COMPLETE |
| `chat` | Staff chat with file attachments | `/app/chat`, `/app/chat/:id/messages`, `/app/chat/:id/upload` | staff_chats, staff_chat_members, staff_chat_messages, staff_chat_files (T) | any member; module toggle `staff_chat` | none | staff-reps, branch-stock-chat | COMPLETE |
| `teamops` | Internal support tickets, presence ("last seen"), notification email rules, doctor emails to patients | `/app/tickets[/:id/reply\|status\|assign\|platform]`, `/app/teamops/presence`, `/app/settings/notifications`, `/app/teamops/patient-email` | support_tickets, support_ticket_replies, support_ticket_reads, team_user_prefs (P); user_presence, notification_email_rules, doctor_emails (T) | any member (tickets); `settings.manage` (rules); `clinical.view` (patient email) | none | teamops | COMPLETE (the settings page has no HTTP test; the service is tested) |
| `attendance` | Clock in/out, schedules, records, export, kiosk door screen with QR | `/app/attendance[/clock\|/records\|/settings\|/screens\|/export]`; public `/kiosk/:token[/qr]` | attendance_settings, attendance_schedules, attendance_records, attendance_kiosks (T) | anyone clocks in; `attendance.view`, `attendance.manage`, `data.export`; kiosk by token | none | attendance, attendance-topbar, leave | COMPLETE |
| `leave` | Leave requests, approvals, yearly allowance and balances, who is on leave, unpaid leave deducted from payroll | `/app/leave`, `/app/leave/requests[/:id/approve\|reject]`, `/app/leave/record`, `/app/leave/allowances/:id` | staff_leave_settings, staff_leave_allowances, staff_leave_requests (T) | anyone may request; `leave.manage` (`leave.service.js` `MANAGE`); `payroll.manage` for the deduction | none | leave | COMPLETE |

### 1.3 Clinical records and patient documents

| Module | What it does | Main routes (`/app…` unless public) | Data | Access | Jobs | Tests | Status |
|---|---|---|---|---|---|---|---|
| `clinicalplus` | ICD-10 search and custom codes, consultation timer, record privacy with emergency ("break-glass") access and access log | `/icd/search`, `/visits/:id/timer/:action`, `/patients/:id/emergency-access`, `/settings/privacy[/log]`, `/settings/diagnosis-codes` | icd_custom_codes, consultation_diagnoses, consultation_timers, record_access_grants, record_access_log (T) | `clinical.view/edit`, `vitals.edit`, `settings.manage`, `audit.view`, `reports.view` | none | clinicalplus, specialty | COMPLETE |
| `specialty` | Dental chart and treatment plan, child growth (WHO LMS), pregnancy follow-up, specialty forms catalogue | `/patients/:id/{dental,growth,pregnancy,records}`, `/specialty/settings` | dental_entries, dental_plan_items, growth_measurements, pregnancies, antenatal_visits, pregnancy_checks, specialty_records, specialty_settings (T) | `clinical.view/edit`, `vitals.edit`, `settings.manage`; plan feature `specialty_modules` | none | specialty, specialty-forms | COMPLETE |
| `chronic` | Chronic conditions, readings with charts, clinic-wide overdue follow-up list | `/chronic`, `/chronic/settings`, `/patients/:id/chronic/{conditions,readings}` | chronic_settings, patient_conditions, patient_readings (T) | `clinical.view/edit`, `vitals.edit`, `settings.manage` | none | chronic | COMPLETE |
| `orders` | Lab/imaging orders, referrals, patient files, orders catalogue, clinical report | `/visits/:id/orders`, `/visits/:id/referrals`, `/orders/:id`, `/referrals/:id`, `/patients/:id/files`, `/clinic/orders-catalog`, `/reports/clinical` | medical_orders, referrals, order_catalog, patient_files (T) | `clinical.view/edit`, `settings.manage`, `reports.view` | none | orders, patient-export | COMPLETE |
| `certificates` | Sick leaves and medical reports with numbering; public QR verification | `/certificates`, `/certificates/new`; public `/verify/:code` | certificates, certificate_sequences (T) | `certificates.view`, `certificates.issue`, `data.export`; verify is public | none | certificates, signatures | COMPLETE |
| `patientdocs` | PDFs of prescriptions, reports, certificates; send to patient; revoke | `/patient-docs/:id/{prescription,report,certificate,docs}/….pdf`, `/patient-docs/:id/send` | patient_documents (T) | `clinical.view/edit`, `prescriptions.create`, `certificates.*`, `billing.view` | none | signatures, payments, image-optimize | COMPLETE |
| `signatures` | Doctor signatures (upload or draw), clinic stamp and its positions on papers | `/settings/signatures`, `/signatures/…png` | doctor_signatures, clinic_stamps (T) | `settings.manage`; images need `clinical.view`, `certificates.view` or `billing.view` | none | signatures | COMPLETE |
| `share` | Send a document to the patient on WhatsApp or by email through a secure link | staff `/app/share/{pick,wa,email}`; public `/d/:token[/pdf]` | share_links (T) | `billing.view` and others per document; public by token | none | share | COMPLETE |
| `partners` | External pharmacies, imaging centres and labs; send papers to them; in-clinic centre work lists | `/settings/partners`, `/centres/send`, `/centres/:id` | clinic_partners, partner_sends (T) | `settings.manage`; module toggle `centres` | none | partners | COMPLETE |
| `ai` | Clinical assistant (summary, second opinion, Rx check); AI finance assistant (analyze, chat, proposed actions); admin key and model | `/visits/:id/ai/:kind`, `/settings/ai`, `/finance/assistant[/chat\|/analyze\|/actions/:id/:op]`; admin `/admin/ai` | ai_requests, ai_clinic_settings, ai_finance_* (T); platform_settings (P) | `clinical.view/edit`, `finance.view`, `settings.manage`; plan feature `ai_assistant`; platform admin | none | ai, aifinance, access | COMPLETE |
| `legacy` | Recover and import patients from the legacy "Clinica" system: upload jobs, remote pull, dedupe, purge, promote into patient files, recovery linking, protected file download | `/app/import/legacy-clinica[/jobs\|/remote\|/promote\|/recovery\|/dedupe]`, `/api/patients/:id/attachments/:aid/download` | import_jobs, import_batches, import_items, import_errors, legacy_* (T) | `data.manage`, `clinical.view` | `legacyTick` (import, promote, transfer, remote resume) after 10 s, then every 5 min | legacy-import, legacy-remote, legacy-clean, legacy-linkify, legacy-files-compress | COMPLETE |
| `patientexport` | One patient's or all patients' export (JSON/Excel/ZIP); import | through `/app/patients/…export*`, `/import` | patients and clinical tables (T) | `data.export`, `patients.view`, `clinical.view` and others | none | patient-export, patient-import | COMPLETE |
| `patienttransfer` | Move or share patients between clinics of the same owner (different databases), sync, restore, retry | `/app/patients/transfer[/:id\|/sync\|/restore/:pid]` | patient_transfers, patient_transfer_items, patient_links (P) | `data.manage` | in `legacyTick` (`transfer.service.resumeAll`) | patient-transfer | COMPLETE |

### 1.4 Finance and accounting

| Module | What it does | Main routes (`/app…`) | Data | Access | Jobs | Tests | Status |
|---|---|---|---|---|---|---|---|
| `finance` | Profit and loss (cash basis), staff salaries (employees, monthly run, adjustments, payslips), partners and capital (transactions, profit distribution, payment voucher PDF), budgets with alerts | `/finance[/export]`, `/staff-payroll[/prepare\|/pay-all\|/lines/:id/pay\|/employees]`, `/partners[/transactions\|/distribute\|/transactions/:id/voucher]`, `/budgets` | budgets, partners, partner_transactions, profit_distributions, staff_employees, staff_payroll_lines, staff_payroll_adjustments (T) | `finance.view`, `finance.manage`, `payroll.view/manage`, `expenses.view/manage` | `budgets.service.runDue`, daily | finance, math-audit, payouts, invoice, leave | COMPLETE |
| `expenses` | Expenses with categories; recurring expenses (rent, phone) posted on their date | `/expenses[/export]`, `/expenses/categories`, `/expenses/recurring[/:id/post\|skip]` | expenses, expense_categories, recurring_expenses (T) | `expenses.view`, `expenses.manage`, `data.export` | `recurring.service.runDue` 30 s after boot, then hourly | math-audit, payouts, branch-switch | COMPLETE |
| `payouts` | Bank-transfer files for any bank (templates and presets); payslips by email | `/payouts/bank[/make\|/templates]`, `/payouts/slips/{staff,doctor,all}` | bank_templates, bank_transfers (T) | `payroll.view`, `payroll.manage` | none | payouts, math-audit | COMPLETE |
| `insurance` | Insurance companies' claim statements (Excel/PDF), emailed to the insurer | `/insurance-claims`, `/insurance-claims/:pid/{export,send}` | insurance_statements, insurance_providers, invoices (T) | `billing.view`, `billing.manage` | none | insurance-claims | COMPLETE |
| `payments` | Online card payments for clinics (PayTabs, HyperPay): settings, patient pay page, refunds, verify, callbacks; releases unpaid online bookings | `/app/settings/payments`, `/app/payments[/:id/verify\|refund]`; public `/pay/:pid`, `/c/:token/pay`, `/pay/callback/paytabs/:pid`, `/pay/return/hyperpay/:pid` | payments, payment_gateways (T) | `settings.manage`, `billing.view/manage/void`; public by token; plan feature `online_payments` | `payments.service.runDue`, every 5 min, per DB | payments, platform-pay | COMPLETE |

### 1.5 Suppliers, purchasing and the medical-rep marketplace

| Module | What it does | Main routes | Data | Access | Jobs | Tests | Status |
|---|---|---|---|---|---|---|---|
| `purchasing` | Purchase orders to suppliers: create, send, resend, cancel, receive (records the supplier's bill as an expense), low-stock order; vendor side views and acknowledges | `/app/supplies/orders[/new\|/:id/send\|receive\|expense\|low-stock]`; vendor `/vendor/orders[/:id/acknowledge]` | purchase_orders, purchase_order_items, purchase_receipts (P); suppliers, supply_items, expenses (T) | `supplies.view/manage`, `expenses.view/manage`, `finance.view`, `data.export`; vendor | none | purchasing, branch-stock-chat | COMPLETE |
| `marketplace` | Clinic side: reps' and warehouses' offers and products filtered by specialty, add as supplier/supply; rep visit requests, windows, confirm/decline | `/app/marketplace[/offers/:id\|/products/:id\|/vendors/:id]`, `/app/rep-visits[/windows\|/:id/:action]`; vendor `/vendor/visits[/new]` | vendor_offers, vendor_products, rep_visits, rep_visit_slots (P) | `vendors.view`, `vendors.manage`, `supplies.manage`; module toggle `marketplace` | none | market, staff-reps, hub-visits | COMPLETE |
| `vendors` | Rep and warehouse sign-up (types `rep`, `warehouse`, `company`, `events`), vendor portal: profile, products, offers (targeting by city and specialty), account | public `/vendors`, `/vendors/signup`; portal `/vendor`, `/vendor/{profile,products,offers,account}` | vendors, vendor_users, vendor_products, vendor_offers, vendor_offer_* (P) | public sign-up; `requireVendor`; admin approval | none | vendors, platform-world | COMPLETE |
| `vendorbilling` | Vendor subscription plans, trial, invoices, paid ads with approval | vendor `/vendor/billing`, `/vendor/ads`; admin `/admin/vendor-billing[/plans\|/invoices/:id/confirm\|/ads/:id/:action]` | vendor_plans, vendor_subscriptions, vendor_invoices, vendor_ads (P) | vendor; platform admin | none | vendor-billing, platform-notify | COMPLETE |
| `hub` | A self-hosted MedWorks install linked to the platform: offers and ads sync, rep visits across installs | admin `/admin/hub-links`; clinic `/app/settings/hub`, `/app/hub/offers/:id`; API `/hub/v1/*`, `/hub-in/v1/rep/*`; vendor `/vendor/visits/hub/:link` | hub_links, hub_client, hub_cache, hub_visits (P) | platform admin; `data.manage`; API key | `hub.service.sync`, every 1 min | hub, hub-visits | COMPLETE |

### 1.6 Website, booking, patient-facing and communications

| Module | What it does | Main routes | Data | Access | Jobs | Tests | Status |
|---|---|---|---|---|---|---|---|
| `site` | Platform marketing site (home, pricing, features, blog, demo, switch, legal, robots, sitemap, llms.txt); the clinic's public pages (`/:slug`, doctors, articles, custom pages, theme, fonts, staff login portal); public booking | `/`, `/pricing`, `/features`, `/blog`, `/demo`, `/switch`, `/clinic-management-system`; `/:slug`, `/:slug/doctors[/:ref]`, `/:slug/articles`, `/:slug/p/:page`, `/:slug/login`; `GET/POST /:slug/book`, `/:slug/book/slots`, `/:slug/book/done`, `.ics` | platform_settings, site_media, articles (P); services, doctors, appointments (T) | public | none | landing, booking-any, booking-controls, booking-display, clean-urls, site-growth, platform-legal, platform-marketing-pages | COMPLETE |
| `website` | Clinic website builder (sections, pages, header/footer, templates, versions, publish/unpublish), theme/brand/dark/fonts, import from an existing site, booking settings, custom domain with SSL and aliases, SEO, marketing connections (pixels, Google profile), analytics, clinic email (SMTP or Google/Microsoft OAuth) | `/app/website[/builder\|/theme\|/booking\|/media\|/domain\|/seo\|/marketing\|/analytics\|/email\|/settings\|/import\|/preview]` | clinic_sites, clinic_site_versions, clinic_site_stats, clinic_fonts, clinic_media (T); clinic_domains (P) | `website.view/edit/publish/seo/domain/email/analytics`; plan features `website.*` | none | website, site-import, site-people, connections, security | COMPLETE |
| `discover` | Clinic directory by specialty, embeddable booking widget (`/widget.js`), booking links and QR, booking-source report | `/clinics[/:specialty]`, `/widget.js`, `/app/settings/booking-links/*`, `/app/reports/bookings` | businesses, reviews (P) | public; `website.edit`, `reports.view` | none | discover | COMPLETE |
| `articles` | Doctors' articles for the clinic site; optional listing on the main site after admin approval | `/app/articles[/new\|/:id]`; admin `/admin/articles` | articles (P) | `website.edit` or a doctor login; platform admin | none | articles | COMPLETE |
| `reviews` | Verified patient reviews through a token link; reply and report; admin moderation | public `/review/:token`; `/app/website/reviews[/:id/reply\|report]`; admin `/admin/reviews` | reviews (P); appointment_links (T) | token; `reviews.view/manage`; platform admin | none (requests go out through messaging) | engage | COMPLETE (admin moderation page not HTTP-tested) |
| `patientportal` | Patient account at `/:slug/account`: code or password login, activation link, appointments, prescriptions, files, dental plan | `/:slug/account[/login\|/code\|/activate/:token\|/files/…]`; staff `/app/settings/patient-portal`, `/app/patients/:id/portal-invite` | patient_accounts, patient_account_codes, patient_portal_settings (T) | patient session; `settings.manage`, `patients.edit` | none | patient-portal | COMPLETE |
| `telehealth` | Online consultations: per-doctor online windows and fee, online booking, consultation page `/c/:token` with built-in WebRTC video (or Jitsi or an external link), file exchange, payment-before-confirmation | `/:slug/book/online[/slots]`, `/c/:token[/join\|/signal]`, `/app/telehealth/mine`, `/app/telehealth/:id/{send,confirm,paid,join}` | online_consultations, online_consultation_files, doctor_online_slots, telehealth_signals (T) | public / token; `appointments.manage`, `clinical.view/edit`, `billing.manage`, `website.edit`; plan feature `online_consultations` | `telehealth.service.runDue` (reminders about 1 h before, purge old signals), every 5 min | telehealth, booking-display, payments | COMPLETE |
| `messaging` | Appointment messages over WhatsApp Cloud API, SMS (Twilio, Unifonic) and email: confirmations, reminders, review requests; patient links to confirm, cancel, reschedule or stop; custom texts; delivery log; provider webhooks; staff WhatsApp click-to-chat | `/app/settings/messaging[/texts\|/test]`, `/app/messaging/wa/:id`; public `/r/:token[/confirm\|cancel\|reschedule\|stop]`; `/hooks/whatsapp/:key`, `/hooks/sms/:key` | clinic_messaging, clinic_messages, message_log, message_dispatches, appointment_links (T) | `settings.manage`, `appointments.manage`; token; plan feature `reminders` | `messaging.service.runDue`, every 1 min, per DB | engage, message-texts, booking-any, security | COMPLETE |
| `countrypages` | One landing page per country (`/sa`, `/jo`…) with local currency | public `/:cc`, `/in/:cc`; admin `/admin/country-pages` | platform_settings (P) | public; platform admin | none | platform-reach, platform-world | COMPLETE |
| `helpcenter` | Platform help articles | public `/help`, `/help/:slug`; admin `/admin/help` | help_articles (P) | public; platform admin | none | platform-reach | COMPLETE |
| `support` | In-app Help page: FAQ by topic, role summaries, contact shown only when `SUPPORT_EMAIL` is set | `/app/help` | none (locale files) | any member | none | platform-reach | COMPLETE |

### 1.7 Integrations and data

| Module | What it does | Main routes (`/app…`) | Data | Access | Jobs | Tests | Status |
|---|---|---|---|---|---|---|---|
| `integrations` | Google Sheets export (OAuth, `drive.file` scope, webhook mode, daily run); clinic media library (public images at `/m/:slug/:id`) | `/settings/google-sheets[/connect\|/callback\|/run\|/test\|/disconnect\|/webhook]`, `/settings/media/*`, `/media/:id`; public `/m/:slug/:id` | sheet_sync_settings, sheet_sync_runs, clinic_media, media_usages (T) | `data.manage`, `data.export`, `website.edit`, `settings.manage` | `sheets.service.runDue`, hourly, per DB | integrations, media-quota | COMPLETE |
| `datasync` | One-way copy of clinic data to the clinic's own external MySQL/MariaDB or PostgreSQL (prefixed tables, private IPs refused) | `/settings/database[/test\|/run\|/remove]` | clinic_data_sync, data_sync_runs (T) | `data.manage`; plan feature `data_sync` | `datasync.service.runDue`, every 5 min, per DB | datasync | COMPLETE |
| `clinicmail` | The clinic's sending mailbox: SMTP, or Gmail/Microsoft OAuth (`gmail.send`), with a send log | UI in `website` (`/app/website/email…`) | clinic_mail_accounts, clinic_mail_log (T) | `website.email` | none | edition-mailbox, website | COMPLETE |
| `mailbox` | Each staff member's own email inside the app (IMAP read, SMTP send), attaching clinic papers; private to that member | `/app/mail[/m\|/compose\|/send\|/settings]` | staff_mailboxes (T) | any member (own mailbox only); module toggle `staff_mail` | none | mailbox, edition-mailbox | COMPLETE |

### 1.8 Platform admin (super-admin) and SaaS business

All routes under `/admin` require the platform-admin flag.

| Module | What it does | Main routes | Data | Jobs | Tests | Status |
|---|---|---|---|---|---|---|
| `admin` | Overview dashboard (clinics, users, usage, attention items, backups); clinics list and detail (suspend, storage quota, branches, modules, backups and restore); user accounts (disable/enable); landing-page editor; media, SEO/AEO, growth/social; Google sign-in and clinic domains (approve/suspend); vendor moderation; review and article moderation | `/admin`, `/admin/clinics[/:id/{status,storage,branches,modules,backups}]`, `/admin/users`, `/admin/site/*`, `/admin/seo`, `/admin/growth`, `/admin/google`, `/admin/domains`, `/admin/vendors`, `/admin/reviews`, `/admin/articles` | businesses, users, vendors, clinic_domains (P), plus counts across tenant DBs | none | edition, platform-growth, media-quota, platform-substate, landing, site-growth, identity, articles | COMPLETE (`/admin/users` and `/admin/vendors` HTTP routes have no direct test; the vendor service is tested) |
| `subscriptions` | Plans with entitlements (features and limits), trials, grace periods, invoices, manual payments, comp, cancel; clinic-side plan choice and card payment; enforcement gate. **Off by default** (`platform_settings.subscriptions.enabled`) | admin `/admin/plans[/settings]`, `/admin/subscriptions[/:id/{extend-trial,plan,payment,comp,cancel}]`; clinic `/app/settings/subscription[/choose\|/invoices/:id]` | subscription_plans, clinic_subscriptions, platform_invoices (P) | `subscriptions.service.runDue`, hourly | subscriptions, platform-substate, platform-pay, landing, math-audit | COMPLETE |
| `platformpay` | The platform's own payment methods (bank, CliQ, wallet, PayTabs) for clinic and vendor invoices | `/admin/payments[/test]`; `/pay/platform/callback/:pid` | platform_payments, platform_invoices, vendor_invoices (P) | none | platform-pay | COMPLETE |
| `platformops` | Clinic module on/off, invoice template, demo data; clinic types; platform branding; login-page editor; maintenance mode; per-clinic DB management (move, rename, structure sync); image compression; in-app updater; nightly encrypted per-clinic backups | clinic `/app/settings/{modules,invoice,demo/*,system-update,login-page}`; admin `/admin/{clinic-types,branding,databases,images,maintenance,updates,login-page}` | tenant_dbs, platform_assets, image_compress_log (P); clinic_ops_settings, demo_records (T) | `clinic-backup.runNightly`, checked hourly | platformops, tenant-db, maintenance, branding, image-compress-admin, loginpage, security | COMPLETE |
| `platformcomms` | Platform settings (SMTP, WhatsApp), test sends, admin 2FA, activity page (who is active and from which country) | `/admin/settings[/test-email\|/test-whatsapp]`, `/admin/security`, `/admin/activity` | platform_activity, ip_places, platform_settings (P) | `activity.locate`, hourly (only when geo lookup is on) | platform-board-settings, platform-growth, platform-crm, platform-reach | COMPLETE |
| `platformnotify` | Notifications for the admin and for vendors | `/admin/notifications`, `/vendor/notifications` | platform_notifications (P) | none | platform-notify | COMPLETE |
| `crm` | The platform owner's CRM: contacts and pipeline board, notes, follow-ups, email/WhatsApp, AI summary; lead finder (Google Places saved searches); bulk email campaigns with rate limits and unsubscribe; onboarding emails to new clinics | `/admin/crm[/board\|/finder\|/campaigns\|/:id]`; public `/unsubscribe/:token` | crm_contacts, crm_activities, crm_lead_searches, crm_leads, mail_campaigns, mail_campaign_recipients, mail_unsubscribes, lifecycle_emails (P) | `campaigns.tick` every 1 min; `leads.runDue` hourly; `onboarding-mail.runDue` hourly | platform-crm, platform-campaigns, platform-leads, platform-board-settings, platform-growth | COMPLETE |
| `sales` | Quotations (accept, decline, negotiate, signature), sales services, seller profile, platform invoices to clinics, email log, document templates, sales dashboard | `/admin/{quotes,sales-services,sales-profile,sales-invoices,email-log,templates,documents,sales-dashboard}`; public `/quote/:token`, `/invoice/:token[/pay]`, `/document/:token` | quotes, quote_items, quote_events, sales_services, sales_documents, document_templates, document_sends, email_log (P) | `billing-mail.runOverdue`, hourly | platform-sales, platform-growth, platform-kit, platform-templates-ai, platform-docs-pdf | COMPLETE |
| `referrals` | A clinic that refers a paying clinic gets a free month | service only (used by subscriptions and sign-up) | referral_rewards (P) | none | platform-reach | COMPLETE |

---

## 2. Areas requested by the owner

| Area | Status | Evidence |
|---|---|---|
| Public website and appointment booking | COMPLETE | `site/web.js`, `site/portal.web.js`, `site/booking.web.js` (`/:slug/book`), `website/web.js` builder, `discover` widget and directory, `telehealth/booking.web.js` online booking. Tests: booking-*, website, landing, discover |
| Clinic dashboard | COMPLETE | `clinic/dashboard.web.js` (`GET /app`, `/app/my-day`), nav badges in `routes/app.js` |
| Super-admin dashboard | COMPLETE | `admin/web.js` `GET /admin` (stats across tenant DBs, attention list, backups, notifications) |
| Doctors | COMPLETE | `clinic/doctors.web.js`, `my-profile.web.js`, `doctors` (T) |
| Patients | COMPLETE | `clinic/patients.web.js`, `patient-profile.js`, `patientexport`, `patienttransfer` |
| Services | COMPLETE | `clinic/services.web.js`, `services` and `service_categories` (T) |
| Schedules / calendars | COMPLETE | `clinic/appointments.web.js`, `scheduling.js`, `hours.web.js`, `doctor_days_off`, `live` (ICS import and per-doctor iCal feed), `surgeries` |
| Waiting room / queue screen | COMPLETE | `clinic/frontdesk.web.js`; `queue` module (`/queue/:token` TV screen); centre desk `/app/center/desk` |
| Accounting | PARTIAL | Cash-basis P&L (`finance/pnl.service.js`), invoices, payments, cash closings, insurance statements. **No general ledger, chart of accounts, journal entries or balance sheet** (no `ledger`/`journal` code). Tax appears only as the clinic tax number shown on invoices (`show_tax` invoice-template option); no VAT computation or tax report. |
| Expenses | COMPLETE | `expenses` (categories, recurring, export), centre cost shares |
| Salaries / payroll | COMPLETE | Doctor commissions and payroll (`clinic/payroll.web.js`), staff salaries (`finance` `/staff-payroll`), bank files and payslips (`payouts`), leave deductions |
| Capital, partners and profits | COMPLETE | `finance/partners.service.js`: partners, capital transactions, monthly profit distribution, voucher PDF (`/app/partners`) |
| Suppliers and purchasing | COMPLETE | `clinic/supplies.web.js` (suppliers, items, stock), `purchasing` (purchase orders, receive becomes an expense) |
| Reports and analytics | COMPLETE | `/app/reports`, `/reports/bookings`, `/reports/diagnoses`, `/reports/consultation-time`, `/reports/clinical`, website analytics (`/app/website/analytics`, `clinic_site_stats`), AI finance assistant |
| Visitors / activity | COMPLETE | Platform: `platformcomms/activity.service.js` middleware and `/admin/activity` (country lookup). Clinic website visits: `clinic_site_stats`. Staff: `user_presence`. Audit log: `audit_logs` (`/app/settings/data`, `audit.view`) |
| Campaigns (bulk email) | PARTIAL | Platform-to-clinics campaigns only (`crm/campaigns.service.js`, `/admin/crm/campaigns`, unsubscribe). **No clinic-to-patients bulk email/SMS/WhatsApp campaign**; patient messaging is per appointment only (`messaging`) |
| Budgets | COMPLETE | `finance/budgets.service.js`, `/app/budgets`, daily threshold/exceeded alerts |
| Alerts / notifications | COMPLETE | In-app `notifications` (T), per-event email rules (`teamops` `/app/settings/notifications`), `platformnotify` (admin/vendor), budget alerts, low-stock and pending badges, server-error emails to admins (platform-growth test) |
| Vouchers / coupons | **NOT PRESENT** | No coupon, promo-code or discount-code code or table anywhere. The only "voucher" is the partner-transaction payment voucher PDF (`/app/partners/transactions/:id/voucher`). Discounts exist only as manual checkout discounts (`clinic/money-rules.js`) |
| Email | COMPLETE | `core/mailer` (platform SMTP), `clinicmail` (clinic SMTP or Gmail/Microsoft OAuth), `mailbox` (staff IMAP/SMTP), email log (`/admin/email-log`) |
| Customer communications (CRM, WhatsApp) | COMPLETE (platform CRM) / PARTIAL (clinic side) | Platform CRM with WhatsApp and email (`crm`). Clinic: WhatsApp Cloud API and SMS reminders (`messaging/channels.js`), click-to-chat (`/app/messaging/wa/:id`), secure-link sharing. **No patient CRM pipeline or two-way inbox in the clinic** (webhooks act on statuses, STOP/START and "Confirm" only) |
| Support (tickets / help center) | PARTIAL | Clinic-internal tickets (`teamops/tickets.service.js`), help FAQ (`/app/help`), public help center (`/help`). **Escalating a ticket to the platform only emails `SUPPORT_EMAIL`; there is no ticket inbox in `/admin`** (`support_tickets` is not read by any admin router) |
| External integrations | COMPLETE | Google sign-in (`auth/google.service.js`), Google Sheets (`integrations/sheets.service.js`), Gmail send OAuth (`clinicmail/oauth.js`), Google Places lead finder (`crm/leads.service.js`), Google Business/Search Console/GA4 and pixels (`website/marketing.service.js`), WhatsApp Cloud API plus Twilio/Unifonic SMS (`messaging/channels.js`), PayTabs and HyperPay (`payments/providers/`), PayTabs/CliQ/bank for the platform (`platformpay`), external DB sync to MySQL/PostgreSQL (`datasync`), Jitsi for video (`JITSI_URL`), cPanel API for creating per-clinic databases (`CPANEL_*`, `src/db/provision.js`), linked installations (`hub`) |
| Clinic configuration | COMPLETE | `settings`, `onboarding`, `clinic/hours`, `clinic/setup`, `platformops` modules on/off and invoice template, branches |
| Website branding | COMPLETE | `website` theme, brand, dark mode, fonts, domain; `settings` appearance (logo, favicon); `branding/theme.js`; white-label entitlement |
| Tenant management (clinic DBs, provisioning) | COMPLETE | `src/db/tenant.js`, `tables.js`, `platformops/databases.service.js` (`/admin/databases`: move, rename, sync); signup provisioning; per-clinic backup and restore |
| Subscriptions / plans / entitlements | COMPLETE (off by default) | `subscriptions` (`entitlements.js` keys: online_consultations, online_payments, reminders, ai_assistant, specialty_modules, data_sync, clinic.max_branches, website.*, media.storage_mb, limits.max_patients) |
| Patient portal | COMPLETE | `patientportal` (`/:slug/account`) |
| Telehealth | COMPLETE | `telehealth` (WebRTC built-in, Jitsi or link; `ICE_SERVERS`) |
| Leave management | COMPLETE | `leave` (migration `20261120000101_staff_leave.js`) |
| Chronic disease tracking | COMPLETE | `chronic` (migration `20261120000201_chronic_tracking.js`) |
| Attendance | COMPLETE | `attendance` (clock, schedules, kiosk QR) |
| Legacy import | COMPLETE | `legacy` (Clinica: file jobs, remote pull, promote, recovery); generic patient Excel/JSON import in `patientexport` |

---

## 3. Roles

### 3.1 Clinic system roles
Defined in `SYSTEM_ROLES` (`src/modules/rbac/permissions.js`). `seedRoles()` copies them into every clinic, and `syncSystemRoles()` updates them at every boot. All of them are stored in `roles` (P).

| Role key | Permissions (summary) | Entry page |
|---|---|---|
| `owner` | All permissions, always (`rbac.service.loadPermissions`) | `/app` |
| `clinic_manager` | Everything except `data.manage` and `finance.manage` | `/app` |
| `doctor` | dashboard, vendors.view, appointments.view (own schedule), reviews.view, patients.view/edit, clinical.view/edit, vitals.edit, prescriptions.create, certificates.issue | `/app/my-day` |
| `nurse` | dashboard, vendors.view, appointments.view/view_all, frontdesk.use, patients.view/edit, clinical.view, vitals.edit, supplies.view/manage, certificates.view | `/app/front-desk` |
| `receptionist` | dashboard, vendors.view, appointments.view/manage/view_all, frontdesk.use, billing.view/manage, patients.view/create/edit, certificates.view | `/app/front-desk` |
| `accountant` | dashboard, vendors.view, finance.view, appointments.view/view_all, billing.view/manage, payroll.view/manage, attendance.view, supplies.view, expenses.view/manage, reports.view, data.export | `/app/billing` |
| Custom roles | Created per clinic at `/app/clinic/roles` (`roles.manage`); key `custom_<id>`. A manager cannot grant permissions they do not hold (`checkGrantable`) | n/a |

The catalogue has 15 permission groups: overview, appointments, frontdesk, patients, clinical, clinic, payroll, supplies, attendance, leave, vendors, reviews, website, reports, admin.

Two more access layers:
- Per-member page access: `access` module.
- Medical centre admin account (`businesses.kind = 'center_admin'`): its own menu (`CENTER_NAV` in `src/routes/nav.js`).

Roles offered at sign-in (`PORTAL_ROLES`): doctor, nurse, receptionist, accountant, clinic_manager.

### 3.2 Platform roles
- **Platform admin:** one boolean, `users.is_platform_admin`. It is created from the `SUPER_ADMIN_*` env vars (`auth.service.ensureSuperAdmin`), may use 2FA (`/admin/security`), and cannot use Google sign-in.
- **No platform staff roles or sections exist.** Every platform admin has full `/admin` access, with no per-section permissions.

### 3.3 Vendor accounts
- `vendors` (P) with `type` ∈ `rep` (medical representative), `warehouse` (drug/supply warehouse), `company`, `events` (`vendors/vendor.service.js` `TYPES`).
- Users link through `vendor_users` (P). The only role written is `owner`; there are no vendor sub-roles.
- Vendors use the `/vendor` portal and need admin approval (`/admin/vendors`).

### 3.4 Roles the owner requested

| Requested | Exists? | Notes |
|---|---|---|
| Administrators | YES | Clinic: `owner`, `clinic_manager`. Platform: `is_platform_admin` |
| Doctors | YES | `doctor` |
| Receptionists | YES | `receptionist` |
| Nurses | YES | `nurse` |
| Pharmacists | **NO** | No system role. Pharmacies exist only as external partners (`clinic_partners`, `partners` module). A clinic could build a custom role, but there are no pharmacy/dispensing permissions or inventory-dispensing workflow |
| Laboratory staff | **NO** | No system role. Labs are external partners or order targets (`medical_orders`, `/centres/:id` work list). There are no lab-result entry permissions |
| Medical representatives | YES (as vendor accounts, not clinic roles) | `vendors.type = 'rep'` with the `/vendor` portal; warehouses are `type = 'warehouse'` |
| Accountants (extra) | YES | `accountant` |

---

## 4. Scheduled jobs (`src/server.js`)
All jobs below run only when `config.env !== 'test'`. "Per DB" means the job is wrapped in `tenant.eachDb` and runs once in every clinic database.

| # | Job | What it does | Period |
|---|---|---|---|
| 1 | `datasync.service.runDue` (per DB) | Copies clinic data to the clinics' own external databases | 5 min |
| 2 | `telehealth.service.runDue` (per DB) | Online-consultation reminder emails about 1 h before; purges old WebRTC signals | 5 min |
| 3 | `payments.service.runDue` (per DB) | Releases unpaid online bookings past the hold time; settles stuck payments | 5 min |
| 4 | `messaging.service.runDue` (per DB) | WhatsApp/SMS/email confirmations, reminders, review requests | 1 min |
| 5 | `platformcomms/activity.service.locate(60)` | Country lookup for new IP addresses (only when `geo.lookup` is on) | 1 h |
| 6 | `crm/onboarding-mail.service.runDue` | Day-3 and day-7 emails to new clinics | 1 h |
| 7 | `sales/billing-mail.service.runOverdue` | One reminder per overdue platform invoice | 1 h |
| 8 | `crm/campaigns.service.tick` | Sends the next batch of bulk emails within hourly/daily limits | 1 min |
| 9 | `crm/leads.service.runDue` | Saved Google Places searches (each once a day) for new clinics | 1 h |
| 10 | `subscriptions.service.runDue` | Trial/period endings and reminders (no-op while subscriptions are off) | 1 h |
| 11 | `finance/budgets.service.runDue` (per DB) | Budget threshold/exceeded alerts, once per budget per month | 24 h |
| 12 | `expenses/recurring.service.runDue` (per DB) | Posts recurring expenses on their date | `setTimeout` 30 s after boot, then 1 h |
| 13 | `branding/domain.service.recheckDue` | Re-checks connected custom domains (notify only) | 6 h |
| 14 | `platformops/clinic-backup.runNightly` | Encrypted per-clinic backup once a day; keeps the last 7 automatic ones | checked 1 h |
| 15 | `integrations/sheets.service.runDue` (per DB) | Google Sheets daily export | 1 h |
| 16 | `legacyTick` | Resumes legacy import, promote, patient transfer and Clinica remote pull | `setTimeout` 10 s, then 5 min |
| 17 | `hub/hub.service.sync` | Linked installation: pulls the platform's offers and ads | 1 min |

There is one more timer outside `server.js`: `require('./db/auto').watch()` checks for pending migrations every 5 minutes.

There is no external job queue. All jobs are in-process `setInterval`s. In a multi-process deployment, every process runs every job.

---

## 5. Known gaps and observations

1. **Vouchers/coupons are NOT PRESENT.** There are no promo codes, gift vouchers or coupon tables. The only discount is the manual checkout discount.
2. **Pharmacist and laboratory staff roles are missing.** Pharmacies and labs are modelled only as external partners. There is no dispensing workflow, no medication stock tied to prescriptions, and no lab-result entry by lab staff.
3. **Accounting is cash-basis P&L only.** There is no double-entry ledger, chart of accounts, balance sheet or tax/VAT reporting module (`finance/pnl.service.js` says it is cash basis).
4. **No patient-facing bulk campaigns.** Bulk email is platform-to-clinics only (`crm`). Clinics cannot send newsletters or SMS/WhatsApp broadcasts to patient groups, even though `patient_groups` exists.
5. **Support tickets have no platform inbox.** "Send to platform" (`POST /app/tickets/:id/platform`) emails `SUPPORT_EMAIL` once (`teamops/tickets.service.js`). `/admin` has no ticket queue, and the feature is hidden unless `SUPPORT_EMAIL` and SMTP are configured.
6. **The platform admin role is a single flag.** There are no platform staff roles or section permissions. Vendor users only ever get role `owner`.
7. **Features behind flags or plans:**
   - Subscriptions are off by default (`platform_settings.subscriptions.enabled`).
   - Plan entitlements gate online consultations, online payments, reminders, AI, specialty modules, data sync, branches, website builder/domain/email/analytics/SEO/white-label, storage and patient limits (`subscriptions/entitlements.js`; fallback `false` for new clinics).
   - Clinic module toggles: 20 optional areas (`platformops/ops.service.js` `MODULES`).
   - Branches need `businesses.branches_allowed` (platform switch).
   - Email verification is required only when configured (`auth/verify.service.required()`).
   - Install type: `APP_EDITION` (platform / clinic / center).
   - Per-clinic databases: `TENANT_DB_DRIVER`.
   - Self-hosted Jitsi: `JITSI_URL`.
   - Sign-up can be turned off: `ALLOW_SIGNUP`.
   - Production config checks: `STRICT_CONFIG` (uncommitted change).
8. **Routes without a dedicated HTTP test:** `/admin/users` (disable/enable), `/admin/vendors` moderation, `/admin/reviews`, `/admin/hub-links`, `/admin/subscriptions/:id/*`, `/app/settings/{ai,hub,notifications,payments,demo}`. The services behind most of them are tested (e.g. `vendors.test.js`, `hub.test.js`, `subscriptions.test.js`, `teamops.test.js`, `payments.test.js`, `platformops.test.js`).
9. **No real TODO/FIXME markers in `src/`.** The keyword matches are `todo` variable names in `platformops/demo.service.js` and `db/auto.js`. No view is missing: every static `res.page('pages/…')` target exists under `src/views/`.
10. **Clinic CRM / WhatsApp is outbound only.** The WhatsApp/SMS webhooks (`/hooks/whatsapp/:key`, `/hooks/sms/:key`) act only on delivery statuses, STOP/START replies and the "Confirm" quick reply (`messaging/hooks.web.js`); message texts are not stored. There is no two-way conversation inbox for patients.
11. **Background jobs are in-process timers** (section 4), with no distributed lock except boot migrations (`GET_LOCK('docbook_boot')`). Running several app processes would duplicate the jobs.
12. **Naming is still mixed.** Code, comments, the lock name `docbook_boot` and the env var `DOCBOOK_UPDATE_ROOT` still say "DocBook". The product name comes from `src/config/brand.js` / `BRAND_NAME`.

### Status counts (67 module directories)
- COMPLETE: 67. Some have caveats: admin and reviews moderation pages and teamops settings are not HTTP-tested; they are noted in the rows.
- IMPLEMENTED-UNTESTED: 0 at module level.
- PARTIAL: 0 at module level.
- Owner areas (section 2):
  - PARTIAL: accounting, campaigns, clinic-side customer communications, support.
  - NOT PRESENT: vouchers/coupons.
