# DocBook 2.0 — Redesign Phase 1 Audit

Scope: audit only. No code was changed for this document.

Inputs checked:

- **Current DocBook 2.0 dist** (`docbook-2.0.0-dist_14.zip`). Its `app.js` md5 (`6ec8b803…`) is identical to the repository build, so the repository HEAD *is* the running 2.0 system.
- **Previous DocBook** (React/TypeScript prototype): the dist plus source (`dist-DocBook-payroll_1.zip`, `DocBook-source-payroll_1.zip`). These are the same files uploaded earlier.

Evidence for route counts: the Express router stack of the running app was walked. The full list is in `docs/redesign-routes.txt` (590 routes: 262 GET, 328 POST).

---

## A. Current system map

| Layer | What it is |
|---|---|
| Runtime | Node 22, Express 4, server-rendered EJS through `res.page` (no SPA). The dist is one esbuild bundle, `app.js`, plus views, locales, migrations and public files. |
| Data | MariaDB/MySQL through knex. 34 migration files, ~120 tables. Migrations are resumable and `AUTO_MIGRATE` is on by default. |
| Tenancy | One database shared by all clinics. Every clinic row in `businesses` is keyed by `business_id`. `req.ctx.businessId` comes **from the session only** and is checked against `memberships`. |
| Auth | Email + password, Google sign-in, invitations, email verification, password reset, session revoke. Members can switch workspaces. |
| RBAC | 13 permission groups and 41 permissions. System roles: owner, clinic_manager, doctor, nurse, receptionist, accountant. Custom roles are supported, and there is per-member page access (`member_page_access`). |
| Gates on `/app` | 1. subscription enforce (read-only / limits)<br>2. modules gate (`modulesOff`, plan features)<br>3. presence<br>4. page-access gate<br>5. `can()` / `canAny()` per route |
| Surfaces | `/app` (clinic staff, ~420 routes)<br>`/admin` (platform admin only, 404 for everyone else)<br>`/vendor` (reps/warehouses)<br>public: landing `/`, clinic page `/:slug`, booking, `/clinics` directory, `/c/:token` telehealth, `/r/:token` reminders, `/review/:token`, `/kiosk/:token` door screen, `/verify/:code` document check, `/widget.js`, `/m/...` media |
| Realtime | SSE `/app/live/events` (a DB change feed). |
| Security infrastructure | helmet with a strict CSP, CSRF synchronizer token (multipart only on whitelisted routes), rate limiters on login, AES-256-GCM secret storage (`core/secrets`), audit log (`audit_logs`), a privacy access log, and verification codes on documents. |
| Ops | Platform updater (RemoteWay flow: upload zip + password → backup → install → restart, restore). Healthz, demo data service. |

## B. Feature inventory (current 2.0)

**Daily clinic work**
- Dashboard and doctor "My day"
- Appointments: list/calendar, new/edit, patient lookup, export, iCal import, calendar feed
- Front desk: waiting room, check-in, send in
- Patients: profile, edit, export, documents, dental/growth/pregnancy charts
- Visits: consultation, vitals, diagnoses (ICD plus custom codes), prescriptions, doctor lines + price + finish
- Cash screen: full-screen POS per doctor, split payments, discounts, insurance, receipts (single and batch), cash closings
- Invoices and payments, certificates, signed documents (PDF with signature, stamp and verify code)

**Finance**
- Expenses and budgets
- Doctor payroll and commissions with payslips
- Staff payroll with payslips
- Profit & loss (`/app/finance`) with an AI finance assistant
- Partners and profit distribution with vouchers

**Management**
- Doctors (with a photo from the media library) and services (with categories)
- Team, invitations, roles, per-member page access
- Attendance: QR kiosk screens, rotating HMAC QR, schedules, export

**Stock**
- Supplies with stock movements, purchase orders
- Vendor marketplace (offers/products), medical rep visits

**Engagement**
- Messaging: WhatsApp/SMS channels with encrypted credentials, reminders, stop links
- Reviews (verified via token), notifications, patient email composed by the doctor
- Telehealth: online consultations, signalling, files, payment gateways (PayTabs/HyperPay)

**Platform services**
- Subscriptions (off by default): plans, trials, manual payments, platform invoices
- Modules on/off per clinic, AI settings, Google Sheets sync, database settings, data export
- Support tickets with unread tracking, and presence

**Public**
- Clinic page `/:slug`: hero, about, doctors, services, reviews, media gallery, staff sign-in links
- Booking (in-clinic and online)
- Directory `/clinics` and `/clinics/:specialty`
- Embeddable widget
- Custom domain (TXT + CNAME/A verification)
- SEO: meta, JSON-LD, sitemap, robots, llms.txt

**Platform admin**
- Clinics, users, plans, subscriptions, domains, Google, vendors, reviews, AI, updates
- Landing-page CMS (`/admin/site`: header, sections, footer, SEO, preview, media)
- SEO and growth pages

## C. Route inventory (by area; full list in `docs/redesign-routes.txt`)

| Area | Routes | Main paths |
|---|---|---|
| Settings | 110 | `/app/settings/*`: clinic, portal (slug, domain, booking), appearance, account, security, roles, team, access, insurance, medications, diagnosis-codes, privacy, ai, messaging, payments, booking-links, subscription, modules, invoice, notifications, media, signatures, google-sheets, database, data |
| Patients | 25 | `/app/patients*`, dental/growth/pregnancy, `/app/patient-docs/*` PDFs |
| Supplies | 24 | `/app/supplies*`, `/app/supplies/orders*` |
| Attendance | 22 | `/app/attendance*` (screens, kiosk, scan, settings, export), public `/kiosk/:token*` |
| Appointments | 20 | `/app/appointments*` (+ import-calendar, calendar-feed) |
| Admin site | 19 | `/admin/site*` |
| Onboarding | 16 | `/app/onboarding*`, `/app/setup-checklist` |
| Visits | 15 | `/app/visits/:id*` (prescriptions, finish) |
| Cashier | 14 | `/app/cashier*` (screen, receipts, closings) |
| Staff payroll | 13 | `/app/staff-payroll*` |
| Vendor portal | 32 | `/vendor/*`, `/vendors/*` |
| Doctor payroll | 9 | `/app/payroll*` |
| Partners | 9 | `/app/partners*` |
| Doctors | 9 | `/app/doctors*` |
| Marketplace | 8 | `/app/marketplace*` |
| Telehealth | 8 | `/app/telehealth*`, public `/c/:token*` |
| Plans / subscriptions (admin) | 8 + 8 | `/admin/plans*`, `/admin/subscriptions*` |
| Public booking | ~12 | `/:slug`, `/:slug/book*`, `/:slug/login`, `/r/:token*`, `/review/:token` |
| Other clinic pages | ~60 | front-desk, services, expenses, budgets, finance, billing, payments, certificates, reports, reviews, tickets, teamops, signatures, specialty, media, live, search, notifications, help, my-day |
| Auth | ~25 | login, signup, forgot/reset, verify-email, invite, Google, workspaces |
| Public misc | ~15 | `/`, `/clinics*`, `/widget.js`, `/m/*`, `/verify*`, `/calendar/:token.ics`, hooks, pay callbacks, robots/sitemap/llms |

## D. Current navigation problems

1. **Settings is a second application.** It holds 110 routes and ~25 pages under one "Settings" entry. It mixes four different jobs:
   - personal (account, security, appearance);
   - clinic setup (clinic, services data, insurance, medications);
   - public presence (portal, booking links, domain, media, appearance of the public page);
   - platform/billing (subscription, modules, database, sheets).
2. **The public website has no home.** Everything about "my clinic online" is scattered:
   - slug, domain and booking toggle: `/app/settings/portal`
   - QR and links: `/app/settings/booking-links`
   - logo and colours: `/app/settings/appearance`
   - photos: `/app/settings/media`
   - reviews: `/app/reviews` (under Reports)
   - online consultations: telehealth settings
   - payments: `/app/settings/payments`

   An owner cannot answer "what does my website look like and is it live?" from one place.
3. **Team is in two places:** Management → Team and Settings → Team / Roles / Access.
4. **Finance vs daily split is unclear.** Billing/invoices and the cash screen are in Daily, cash closings belong to Finance (`follows: cashier`), and payments (`/app/payments`) have no menu entry.
5. **Clinical reference data is buried.** Medications, diagnosis codes and signatures sit in Settings, yet doctors need them while working.
6. **"More"** mixes Settings and Support. Tickets are reachable only through Help.
7. **The Reports group** holds only Reports + Reviews. Reviews are a public-reputation item, not a report.
8. **Some pages have no sidebar entry** and are reachable only from inside other pages:
   - `/app/payments`
   - `/app/certificates/new`
   - `/app/setup-checklist`
   - `/app/attendance/screens`
   - `/app/specialty/settings`
   - `/app/settings/privacy/log`

   Acceptable for sub-pages, but there is no breadcrumb/tab back on every one.

## E. Role / permission map (current, from `rbac/permissions.js`)

| Role | Entry | Can reach |
|---|---|---|
| owner | `/app` | everything (all 41 permissions) |
| clinic_manager | `/app` | everything except `data.manage`, `finance.manage` |
| doctor | `/app/my-day` | own appointments, patients view/edit, clinical edit, vitals, prescriptions, certificates issue, reviews view, vendors view |
| nurse | `/app/front-desk` | all appointments (view), front desk, patients view/edit, vitals, supplies manage, certificates view |
| receptionist | `/app/front-desk` | appointments manage/all, front desk, billing manage, patients create/edit, certificates view |
| accountant | `/app/billing` | finance view, billing manage, payroll manage, attendance view, supplies/expenses, reports, export |
| platform admin | `/admin` | a flag on the user (`is_platform_admin`), separate from clinic roles |
| vendor user | `/vendor` | a separate `vendor_users` login |

Per-member page switches (`member_page_access`) can take pages away on top of the role. Attendance is open to every member (clocking in).

**Gap:** there is no website/marketing permission. The public site, domain and SEO all sit behind `settings.manage`, so a marketing person needs full settings rights.

## F. User journey problems

1. **Owner — "put my clinic online".** The clinic page is live as soon as the clinic is active and has a slug. There is no preview, draft or "publish" moment, and no checklist item that says "your site is live at …". The domain setup (TXT + CNAME) is technically sound but shown as a raw record table with no step-by-step states (waiting for DNS, SSL, live).
2. **Owner — first day.** Onboarding + setup checklist exist and work. The website, email and domain are not part of the checklist journey.
3. **Receptionist.** Book → check-in → send in → collect is complete (front desk + cash screen). Printing receipts/prescriptions is reachable. Keep as is.
4. **Doctor.** My day → visit → lines + price + finish + prescription exists (dflow). Keep it; only entry points and naming need polishing.
5. **Patient (public).** Clinic page → book → confirmation → reminder link → reschedule/cancel → review works. However:
   - the clinic page cannot be customised beyond logo/colours/about/gallery (fixed layout, no sections, no pages such as "services detail" or "contact");
   - the staff sign-in cards appear on the patient-facing page.
6. **Clinic email.** Every email (invites, reminders, doctor → patient email) goes out through the **one platform SMTP account** in env (`MAIL_FROM`). Doctor emails only change the display name. A clinic cannot send from its own address, so replies and branding go to the platform address.
7. **Accountant.** Lands on invoices. P&L, payroll and partners are one group away. Acceptable.

## G. Old vs new comparison

The "old" system here is the previous React/TypeScript DocBook prototype.

| Area | Old prototype | Current 2.0 | Verdict |
|---|---|---|---|
| Tenancy | a separate database per tenant (`tenantProvisioning`, control plane) | shared database + `business_id`, server-side context | keep 2.0 (simpler ops, isolation tested) |
| Plans | `enabledModules[]`, maxUsers, maxPatients, maxAppointments, **storageLimitMb**, one_time cycle, no seeded plans | features map (6 keys), max doctors/staff/appointments, monthly/yearly, no seeded plans | keep 2.0; the old **storage limit** and **patient limit** ideas are worth adding as entitlements |
| Website | "Storefront manager": block builder (heading, text, image, button, columns, video, form, divider, spacer, carousel, trust bar, FAQ…), `theme` (classic…), `custom_domain` **free-text, never verified** | fixed clinic page + verified custom domain; a block-section editor exists **only for the platform landing** (`/admin/site`) | combine: reuse 2.0's section editor + domain verification for a clinic Website Builder; take the old block list as the section catalogue (healthcare-relevant blocks only) |
| POS / checkout | AppointmentCheckoutView | ported as the cash screen | done |
| Doctor dashboard | DoctorDashboardView | My day + dflow | done |
| Payroll / commissions | yes | yes (doctors + staff) | done |
| Updates | UpdateManagerView | RemoteWay updater | done |
| Marketing hub / ROI, delivery, orders, products, live visitors | e-commerce heritage | not present | do not port (out of scope for a clinic, per the no-Value-Marka rule) |
| Tenant export | yes | `/app/settings/data/export` | done |

## H. Subscription architecture findings

- **Settings:** `platform_settings.subscriptions`, **off by default**. While off, everything is allowed and no rows are created.
- **Tables:** `subscription_plans` (price, cycle, `max_*`, `features` JSON), `clinic_subscriptions`, `platform_invoices`.
- **Lifecycle:** trialing → active → past_due → expired. Expired means read-only, and medical data stays readable and exportable. Payments are manual and confirmed by the platform admin.
- **Enforcement:**
  - `enforce.js` (read-only + limits on create routes);
  - plan features reach the UI through the **modules gate** (`ops.service.planFeatures` → `modulesOff`);
  - `hasFeature()` exists but is not called outside the service. The gate is the single path, which is good.
- **No hard-coded plan names:** grep for premium/pro/basic/starter/enterprise found nothing.
- **Gap for the redesign:** the feature keys are a code constant (`FEATURES`, 6 keys). There are no keys for the public website, custom domain, clinic email, website pages/sections, storage or analytics. The Website Builder would need new entitlement keys (plus optional numeric limits) in the same `features` JSON, still with no plan names in code.

## I. Website Builder / public website findings

- **Clinic page:** `/:slug` → `pages/portal/home.ejs`. The layout is fixed (hero, doctors, services, about/contact, staff card). Data comes from clinic settings, doctors (with photos), services (with categories), verified reviews and the media library (cover + gallery). There is also a theme CSS per clinic (`/:slug/theme.css`, from brand colours).
- **No builder:** no themes, no section ordering/visibility, no extra pages, no draft/preview/publish, no version history.
- **SEO:** good. It covers meta, schema.org MedicalClinic/Physician JSON-LD, sitemap, robots and llms.txt. No tracking pixels on clinic pages; this is intentional and must stay the default.
- **Analytics:** none per clinic, only internal booking reports (`/app/reports/bookings`).
- **Reusable pieces:**
  - `site/content.service.js`: typed sections, AR+EN fields, media fields, icons, validation;
  - the `/admin/site` editor with preview;
  - `integrations/media.service` (clinic media library, public `/m/:slug/:id`).

  These are the right base for a clinic builder.

## J. Domain / email findings

**Domain** (`branding/domain.service.js`, `clinic_domains`):
- One domain per clinic. Ownership is proven by TXT `_docbook.<host>`; pointing by CNAME to the APP_URL host or by A records matching `SERVER_IP`.
- Statuses: pending / verified / suspended. The platform admin can approve, suspend or resume, and every step is audited.
- A live domain serves only the public page and booking. The platform host comes from `APP_URL`, not hard-coded (no `docbook.app` string in code). IDN, blocked TLDs and a single-verified-owner rule are handled.
- **Gaps:**
  - no SSL/certificate state (issued / pending / failed);
  - no www ↔ apex redirect choice;
  - no periodic re-check that takes a domain offline when DNS is removed;
  - the UI is a raw record table.

  SSL issuance itself happens on the hosting side (cPanel AutoSSL / proxy). The app can only *observe* it, for example with a TLS probe.

**Email** (`core/mailer.js`):
- A single global SMTP from env (`SMTP_HOST/PORT/USER/PASSWORD`, `MAIL_FROM`). With no SMTP configured, the app shows links on screen instead.
- No per-clinic sender, no SMTP / Google / Microsoft connection per clinic, no SPF/DKIM guidance, no test-send, no delivery log apart from `doctor_emails` and `message_log` for WhatsApp/SMS.
- Secure storage for per-clinic credentials already exists (`core/secrets.js`, AES-256-GCM keyed by APP_KEY), and Google OAuth is already used for Sheets. Both can be reused.

## K. Multi-tenant findings

- **Tenant from the session:** `req.ctx.businessId` comes from `req.session.businessId`. Switching workspace checks `businesses.isMember`.
- **No tenant id from the browser:** no route takes the tenant from the request body/query. The two uses of `business_id` in request data were checked:
  - the workspace switch verifies membership;
  - the vendor rep-visit form only picks a clinic that opted in (`rep_visits_enabled`, active).
- **Public surfaces** resolve the tenant server-side: slug → business, host → verified domain, token → row, and kiosk HMAC token.
- **Media:** public media is served by slug + id and only for items marked public.
- **Caches:** keyed by business, e.g. `domains:live` maps host → business.
- **Tests:** the test suite (276 tests) includes cross-tenant checks.

No isolation defect was found in this audit.

## L. Security findings relevant to the redesign (document only; no changes now)

1. **Global SMTP.** Adding clinic email needs per-tenant encrypted credentials through `core/secrets`, never sent back to the browser (write-only fields), plus a test-send and audit. For OAuth: store refresh tokens encrypted and use minimal scopes (send only).
2. **Duplicated crypto helpers.** `messaging.service` and `telehealth.service` have their own `keyOf()` alongside `core/secrets`. Consolidate in a later security phase; do not change this during the UX phase.
3. **Domain.** Once verified, a domain stays live even if DNS later changes. A scheduled re-check is recommended. Admin approval without the pointing check relies on the admin's judgement (it is audited).
4. **Website builder input.** Any rich text or custom HTML block must be sanitised server-side. Keep the strict CSP: no inline scripts, and no third-party analytics without explicit consent (cookie preferences already exist).
5. **Staff sign-in on the public page.** The staff login links are on the patient page. This is not a vulnerability (login is rate-limited), but it widens the visible attack surface. The Phase 2 IA should move it to a discreet link.
6. **Permissions.** No `website.manage` permission exists. Add one rather than widening `settings.manage`.
7. **Updater.** Platform admin only, with CSRF + password re-check, backup, restore and audit. OK.

## M. Proposed high-level direction (only)

1. **Keep the engine, reorganise the doors.** No module rewrites. The work is in navigation, entry points, naming and page grouping.
2. **Sidebar by the job of the day:**
   - **Daily** (flat): Today/My day, Appointments, Front desk, Patients, Cash screen, Invoices.
   - **Finance**: expenses, budgets, doctor payroll, staff payroll, P&L, partners, cash closings, payments.
   - **Clinic**: doctors, services, team & roles & access, attendance.
   - **Stock**: supplies, orders, marketplace, rep visits.
   - **Website** (new home): website builder, booking & links, domain, email, reviews, SEO, media.
   - **Reports.**
   - **Settings**: slimmed down to clinic profile, clinical lists, invoices/documents, integrations, subscription, data.
3. **Clinic Website Builder** on the existing section engine. Planned pieces:
   - themes as token sets (no hex in views);
   - ordered sections with show/hide;
   - draft → preview → publish with the last published version kept;
   - media library, SEO per page;
   - domain wizard with states (DNS → verified → SSL → live);
   - clinic email connection (SMTP / Google / Microsoft) with encrypted secrets.
4. **Entitlements:** new feature keys in the plan `features` JSON (`website`, `custom_domain`, `clinic_email`, `website_pages`, limits such as `storage_mb`), checked through the existing gate. No plan names in code.
5. **Phases:** IA (2) → core UX (3) → Website Builder (4) → journey QA (5), each with tests and without breaking routes. Old URLs stay as redirects if anything moves.

## N. Must NOT be touched (works correctly)

- **Auth/session/CSRF/CSP**, tenant context, RBAC + page access, and the audit log.
- **Clinical flow and documents:** the doctor flow (dflow, finish, prescriptions), and PDFs with signatures, stamps and verify codes.
- **Money:** the cash screen (`planSale`/`payMany`), payment parts (no "mixed"), invoice letterhead, cash closings.
- **Payroll and partners:** doctor and staff payroll, commissions, partners.
- **Attendance** kiosk and HMAC QR.
- **Subscription lifecycle and enforcement** (read-only never hides medical data).
- **Domain verification logic**, the public booking, reminder and review token flows, and SEO/JSON-LD.
- **Dist build, updater, resumable migrations, and the early-listen startup.**

---

## Route / feature → future location matrix

| Existing feature | Route | Permission | Roles | Entry today | Business purpose | New nav location | New entry point | Status |
|---|---|---|---|---|---|---|---|---|
| Dashboard | `/app` | dashboard.view | all | Daily | overview | Daily › Today | same | keep |
| My day | `/app/my-day` | clinical.view + doctor | doctor | Daily | doctor queue | Daily › My day | doctor landing | keep |
| Appointments | `/app/appointments*` | appointments.* | all but accountant (manage: reception) | Daily | scheduling | Daily | same | keep |
| Front desk | `/app/front-desk` | frontdesk.use | nurse, reception | Daily | waiting room | Daily | same | keep |
| Patients + charts | `/app/patients*` | patients.* | clinical + reception | Daily | records | Daily | same | keep |
| Visits / prescriptions | `/app/visits/:id*` | clinical.* | doctor | from appointment / My day | consultation | (contextual) | My day → visit | keep |
| Cash screen | `/app/cashier*` | billing.manage | reception, accountant | Daily | collect | Daily › Cash screen | same | keep |
| Invoices | `/app/billing*` | billing.view | reception, accountant | Daily | invoices | Daily › Invoices | same | keep |
| Payments list | `/app/payments*` | billing.view | reception, accountant | none | payment records | Finance › Payments | sidebar | add entry |
| Certificates | `/app/certificates*` | certificates.* | clinical | Daily | sick notes etc. | Daily (or patient tab) | patient page | review |
| Expenses / budgets | `/app/expenses`, `/app/budgets` | expenses.* | accountant | Finance | costs | Finance | same | keep |
| Doctor payroll | `/app/payroll*` | payroll.* | accountant | Finance | commissions | Finance | same | keep |
| Staff payroll | `/app/staff-payroll*` | payroll.* | accountant | Finance | salaries | Finance | same | keep |
| P&L + AI | `/app/finance*` | finance.* | owner, accountant | Finance | results | Finance | same | keep |
| Partners | `/app/partners*` | finance.* | owner | Finance | shareholders | Finance | same | keep |
| Cash closings | `/app/cashier/closings*` | billing.view | reception, accountant | Finance (follows) | end of day | Finance | same | keep |
| Doctors / services | `/app/doctors*`, `/app/services*` | doctors/services.manage | owner, manager | Management | catalogue | Clinic | same | keep |
| Team / roles / access | `/app/settings/team*`, `/roles`, `/team/:id/access` | users/roles.manage | owner, manager | Management + Settings | people | Clinic › Team (tabs: members, roles, access) | one place | merge |
| Attendance | `/app/attendance*`, `/kiosk/*` | attendance.* / all | all | Management | time clock | Clinic | same | keep |
| Supplies / orders | `/app/supplies*` | supplies.* | nurse, accountant | Stock | inventory | Stock | same | keep |
| Marketplace / rep visits | `/app/marketplace*`, `/app/rep-visits` | vendors.* | all | Stock | buying | Stock | same | keep |
| Reports | `/app/reports*` | reports.view | accountant, owner | Reports | analytics | Reports | same | keep |
| Reviews | `/app/reviews` | reviews.* | owner, doctor | Reports | reputation | Website › Reviews | website hub | move |
| Public page settings | `/app/settings/portal` | settings.manage | owner | Settings | go online | Website › Overview / Publish | website hub | move |
| Booking links / QR | `/app/settings/booking-links` | settings.manage | owner | Settings | share booking | Website › Booking | website hub | move |
| Custom domain | `/app/settings/portal#domain` | settings.manage | owner | Settings | branded address | Website › Domain (wizard) | website hub | move + redesign |
| Clinic email | none | none | none | none | send as clinic | Website › Email | website hub | **new (Phase 4)** |
| Website builder | none | none | none | none | pages/sections/themes | Website › Builder | website hub | **new (Phase 4)** |
| Media library | `/app/settings/media`, `/app/media/*` | settings.manage | owner | Settings | images | Website › Media | website hub + pickers | move |
| Appearance (clinic brand) | `/app/settings/appearance` | none / settings.manage | all (personal) + owner | Settings | colours/logo | personal part → Account; clinic brand → Website › Theme | split | split |
| Messaging (WhatsApp/SMS) | `/app/settings/messaging` | settings.manage | owner | Settings | reminders | Settings › Communication | same | keep |
| Online payments | `/app/settings/payments` | settings.manage | owner | Settings | gateways | Settings › Payments | same | keep |
| Telehealth | `/app/telehealth*` | clinical | doctor | from appointments | online consults | contextual | same | keep |
| Insurance / medications / diagnosis codes / signatures | `/app/settings/...` | settings.manage / clinical | owner, doctor | Settings | clinical lists | Settings › Clinical lists | same | keep (group) |
| Invoice template | `/app/settings/invoice` | settings.manage | owner | Settings | letterhead | Settings › Documents | same | keep |
| Modules | `/app/settings/modules` | settings.manage | owner | Settings | turn features on/off | Settings | same | keep |
| Subscription | `/app/settings/subscription*` | settings.manage | owner | Settings | pay platform | Settings › Subscription | same | keep |
| Data / database / sheets | `/app/settings/data*`, `/database`, `/google-sheets*` | data.* | owner | Settings | export/sync | Settings › Data | same | keep |
| Privacy / access log | `/app/settings/privacy*` | settings.manage/audit.view | owner | Settings | compliance | Settings › Privacy | same | keep |
| Onboarding / checklist | `/app/onboarding*`, `/app/setup-checklist` | owner | owner | first login | setup | same + website/email steps | dashboard card | extend |
| Help / tickets | `/app/help`, `/app/tickets*` | none | all | More | support | More | same | keep |
| Platform admin | `/admin/*` | is_platform_admin | platform | `/admin` | run SaaS | unchanged (+ entitlement keys on plans) | same | keep |
| Vendor portal | `/vendor/*` | vendor user | vendors | `/vendor` | reps | unchanged | same | keep |

---

## The 20-item checklist

| # | Item | Answer |
|---|---|---|
| 1 | Current architecture | §A |
| 2 | Feature inventory | §B |
| 3 | Routes | §C and `docs/redesign-routes.txt` |
| 4 | Sidebar map | Daily (dashboard, my day, appointments, front desk, patients, cash screen, invoices, certificates) · Finance (expenses, doctor payroll, staff payroll, budgets, P&L, partners, closings) · Management (doctors, services, team, attendance) · Stock (supplies, orders, marketplace, rep visits) · Reports (reports, reviews) · More (settings, help) |
| 5 | Role map | §E |
| 6 | Subscription architecture | §H |
| 7 | Tenant architecture | §K |
| 8 | Public website | §I |
| 9 | Domains | §J |
| 10 | Email | §J |
| 11 | Booking | Complete: in-clinic + online slots, confirmation, ICS, reminder/reschedule/stop tokens, reviews, widget, directory. Keep. |
| 12 | Theme/CMS | Per-clinic brand colours + logo only. The CMS exists only for the platform landing. |
| 13 | Duplicates | Team (Management + Settings); Appearance (personal + clinic brand on one page); crypto key helpers (3 copies); "booking page" quick action + portal + booking-links |
| 14 | UX problems | §D |
| 15 | Journey problems | §F |
| 16 | RTL / mobile | ar/en with `dir` everywhere, logical CSS, bottom nav on mobile, full-screen cash screen, PDF shaping for Arabic. To verify in Phase 5 on real devices: wide tables in finance/payroll on phones, and the settings sub-nav on narrow screens. |
| 17 | Security | §L |
| 18 | Old features worth preserving | block/section catalogue and theme concept from the storefront builder; plan storage/patient limits; `enabledModules` idea (already mapped to modules gate) |
| 19 | 2.0 features worth preserving | everything in §N plus the section editor, media library, verified domain flow, and SEO/JSON-LD |
| 20 | Route → future-location matrix | table above |

**Stop here. Phase 2 (information architecture) starts only after approval.**
