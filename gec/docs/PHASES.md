# GEC Platform — phase plans and reports

Each phase: **plan** (what exists · reuse · change · database · API · security) → implementation → **report**
(files · migrations · routes · pages · tests · known limitations).

---

## Phase 1 — Foundation: architecture, database, authentication, security, design system, admin shell

### Plan
* **Exists:** GEC SPA (no backend); DocBook core patterns (see `01-AUDIT-AND-ARCHITECTURE.md`).
* **Reuse:** DocBook's config loader, `AppError`, zod `validate`, i18n dictionaries, audit diff/record, tokens,
  AES-GCM secrets, CSRF + locals middleware, error handler, session store, CSP set-up, mailer layout idea.
* **Change:** single-organisation (no tenancy); two account kinds (staff / student) on one `users` table; RBAC with a
  **data scope** per role (own / branch / all); upload validation by magic bytes into private storage; branding from
  the database, not a config file.
* **Database:** `settings`, `roles`, `role_permissions`, `users`, `branches`, `employees`, `password_resets`,
  `login_attempts`, `media`, `audit_logs`, `sessions` (store-managed).
* **Routes:** `/login`, `/forgot`, `/reset/:token`, `/staff/login|logout|forgot|reset|password`, `/staff`,
  `/staff/account`, `/staff/settings/*`, `/staff/roles`, `/staff/audit`, `/staff/api/palette`, `/theme.css`,
  `/media/:id`, `/privacy`, `/go/whatsapp`, `/healthz`.
* **Security:** bcrypt; session regeneration; httpOnly SameSite cookies (Secure in production); CSRF on all writes,
  multipart only on registered routes; account lockout (5 failures → 15 min) + IP rate limits; strict CSP without
  inline scripts; permission check on every staff route; secrets redacted in the audit log; reset tokens hashed,
  single-use, 60 minutes; unknown e-mails get the same answer.

### Report
* **Files:** `gec/` app skeleton — `src/{config,core,db,middleware}`, `src/modules/{auth,rbac,settings,branding,staff,audit,site,comms/email}`,
  views (layouts `public`, `staff`, `auth`; partials), `public/css/{app,staff,site}.css`, `public/js/{app,staff,site,theme-init}.js`,
  `public/icons.svg` (lucide, ISC), self-hosted fonts, brand files from the supplied logos.
* **Migration:** `20261005000100_phase1_core.js`.
* **Built-in roles:** Super Admin, Admin, Branch Manager, Admissions Manager, Counsellor, Visa Officer, Sales,
  Marketing, Finance, Instructor, Reception (+ custom roles).
* **Tests:** `test/phase1.test.js` — 13 integration tests (CSP, auth guard, lockout, portal separation, CSRF incl.
  multipart, session fixation, RBAC, branding → theme, roles, password reset, disabled accounts, audit).
  `npm run check` — dictionary parity, no hard-coded brand colours, no inline scripts.
* **Known limitations:** rate limits are in-memory (one process); Google / Microsoft sign-in columns and adapters are
  prepared but not connected (need OAuth client credentials).

---

## Phase 2 — CRM: leads, students, activities, tasks, employees

### Plan
* **Exists:** accounts, roles with data scopes, staff shell (phase 1). In the GEC SPA: a 3-step consultation modal
  and a contact form that stored nothing.
* **Reuse:** the consultation modal's steps and fields (now `/book`), the contact page, DocBook's idea of one
  record timeline and its CSV export.
* **Change:** every website conversion becomes a lead; one chronological activity timeline for leads and students;
  configurable lead pipeline with Kanban; automatic assignment (round-robin / destination rules / manual);
  duplicate detection by e-mail, phone (last 9 digits) and passport (keyed hash); safe merge.
* **Database:** `lead_stages`, `lead_sources`, `leads`, `students`, `notes`, `activities`, `tasks`.
* **Routes:** `/book`, `/contact` (public); `/staff/leads[/:id]`, `/staff/students[/:id]`, `/staff/tasks`,
  `/staff/employees`, `/staff/branches`; API `GET/POST /api/leads`, `PATCH /api/leads/:id/stage|assign`.
* **Security:** all lists, pages, palette results and API calls filtered by data scope (own / branch / all) on the
  server; passport numbers encrypted (AES-GCM) with an audited "reveal"; only Super Admins can grant Super Admin;
  disabling an employee ends their sessions; CSV exports audited and protected against formula injection; honeypot
  + rate limit on public forms; explicit contact consent, optional marketing consent with timestamp.

### Report
* **Files:** `src/modules/crm/*` (leads, students, stages, assignment, people, activity, notes, tasks, merge, forms,
  web, api), `src/modules/team/*` (employees, branches), `src/modules/site/{capture,leads.web}.js`,
  `src/modules/catalog/reference.js`, views under `views/pages/staff/{leads,students,tasks,team}` and
  `views/pages/site/{book,contact,thanks}`, partials (timeline, task list/dialog, contact log, duplicates),
  `public/js/kanban.js`, `src/db/seeds/demo-crm.js`, `scripts/seed.js`.
* **Migration:** `20261005000200_phase2_crm.js`.
* **Tests:** `test/phase2.test.js` (13): lead capture + attribution, returning enquiry de-duplication, round-robin,
  consent + honeypot, data-scope isolation (page, list, palette, API), Kanban API + CSRF + lost reason,
  conversion + profile completion + journey + encrypted passport, duplicate warning + merge, recurring tasks,
  @mentions, employee privilege escalation + disable, CSV export. Total suite: 26 passing.
* **Known limitations:** Kanban drag-and-drop uses the HTML5 API (desktop); on phones the stage is changed from the
  lead page. @mention notifications are emitted as events and delivered by the notification centre (phase 8).

---

## Phase 3 — Universities, programs, scholarships, Study Finder, matching, compare, shortlist

### Plan
* **Exists:** GEC SPA pages (Universities, Programs, Scholarships, Destinations, Study in USA) over 6 hard-coded
  universities / 6 subject "programs" / 6 scholarships; a client-side compare (max 3, broken initial ids), an
  in-memory shortlist, a USA-only cost calculator.
* **Reuse:** all that content (seeded as clearly-flagged demo data), the US-states overview (now regions of the USA
  destination), compare / shortlist / calculator concepts, the Cmd+K-style search box.
* **Change:** programs become real rows linked to universities; server-side search with filters, facets and
  pagination; natural-language query parsing in English and Arabic; explainable matching; durable shortlist
  (session → student); shareable comparisons; multi-country, multi-currency calculator with saved estimates.
* **Database:** `currency_rates`, `destinations`, `universities`, `programs`, `scholarships`, `shortlist_items`,
  `comparisons`, `cost_estimates` (+ FULLTEXT indexes).
* **Routes (public):** `/programs[/:slug]`, `/universities[/:slug]`, `/scholarships[/:slug]` (eligibility check),
  `/study[/:slug]`, `/search`, `/compare[/:token]`, `/shortlist`, `/cost-calculator`, `/estimate/:token`,
  `/api/suggest`. **Staff:** `/staff/{destinations,universities,programs,scholarships}` (CRUD, CSV import/export),
  `/staff/currencies`, student tabs *Matches* and *Shortlist*, personal estimates.
* **Security:** commission and internal notes are `internal` fields (permission `catalog.internal`), stripped from
  public queries and CSV exports for other roles; all filter values whitelisted; Markdown rendered after escaping
  (no HTML, safe link protocols); share links use unguessable tokens; imports validated row by row.

### Report
* **Files:** `src/core/{resource,markdown}.js` (declarative admin CRUD), `src/modules/catalog/*` (finder, matching,
  shortlist, compare, calculator, money, admin, site.web, staff.web, reference), views under `pages/site/*` and
  `pages/staff/{resource,catalog}/*`, partials (program / scholarship cards, toggles, match chip + reasons, compare
  bar), `public/js/catalog.js`, `src/db/seeds/{demo-catalog.js,data/gec-original.json}`.
* **Migration:** `20261005000300_phase3_catalog.js`.
* **Tests:** `test/phase3.test.js` (6) — query parsing (EN/AR) and filters incl. injection attempts, structured data
  and no internal data on public pages/APIs, anonymous shortlist/compare + share link + adoption on sign-in,
  matching categories (excellent / not eligible / missing / unpublished requirements), admin RBAC + tuition
  normalisation + CSV export column hiding + CSV upsert with bad rows, calculator + e-mailed estimate. Suite: 32.
* **Known limitations:** demo catalogue figures are samples (flagged); exchange rates are maintained by hand;
  "Save as PDF" uses the browser's print dialog (print stylesheet) rather than server-side PDF generation.

---

## Phase 4 — Admissions ATS, documents, offers, visa

### Plan
* **Exists:** students, leads pipeline, catalogue, shortlist (phases 2–3). Nothing in the GEC SPA (visa page was
  static guidance).
* **Reuse:** the timeline, tasks, notes, data scopes, the Kanban component, upload validation, the student page tab
  registry.
* **Change:** applications with 22 configurable stages (rename / reorder / colour / "stuck after N days" / custom),
  stage history with time-in-stage, offer / deposit / CAS fields; the student journey and the originating lead move
  forward automatically; document centre with checklist, requests, uploads (staff on behalf, students in phase 8),
  review with reasons, versions and expiry; visa cases with their own stages that drive the application stage.
* **Database:** `application_stages`, `applications`, `application_stage_history`, `document_types`, `documents`,
  `visa_cases` (+ FKs from notes / activities / tasks to applications).
* **Routes:** `/staff/applications[/:id|/new]`, `/staff/documents`, `/staff/documents/:id/{file,review,delete}`,
  `/staff/students/:id/documents/{request,upload}`, `/staff/visa[/:id]`, `/staff/students/:id/visa`,
  `/staff/settings/pipeline/{leads,applications}`; API `GET /api/applications`, `PATCH /api/applications/:id/stage`.
* **Security:** applications and documents inherit the student's data scope (owner / branch); files served only
  after a scope check, as attachments, `nosniff`, every view audited; uploads checked by magic bytes (a disguised
  HTML file is refused); verification limited to `documents.verify`; refusal / closure reasons required.

### Report
* **Files:** `src/modules/admissions/*` (stages, applications, documents, visa, handlers, web, api),
  `src/modules/settings/pipelines.web.js`, views under `pages/staff/admissions/*` and `settings/pipeline.ejs`.
* **Migration:** `20261005000400_phase4_admissions.js`.
* **Tests:** `test/phase4.test.js` (6): application → checklist → journey → lead sync, duplicate prevention,
  scope isolation; uploads (content check, CSRF, versions), reviewer permissions, scoped file access, rejection
  reason, auto "Documents Complete"; stage history + offer event + Kanban API; visa workflow syncing application
  and journey, permission denial; expiry job; pipeline settings. Suite: 38.
* **Known limitations:** document previews open the original file (no in-browser PDF annotation); the lead pipeline
  follows applications forward only (never backwards) by design.

---

## Phase 5 — Appointments, courses, events

### Plan
* **Exists:** the original site's "Book a consultation" form (phase 2 turned it into lead capture) and three static
  events in the SPA data. No scheduling, courses or tickets.
* **Reuse:** lead capture (`site/capture`) so every booking / registration creates or updates a lead with source and
  consent; the timeline; e-mail templates + outbox; resource CRUD; data scopes; the attention queue and KPI registries.
* **Change:** Calendly-style scheduler (types, counsellors per type, weekly hours in the branch time zone, time off,
  buffers, minimum notice, booking window), public booking with a private manage link (reschedule / cancel / .ics),
  staff agenda and booking for a lead or student, reminders job; courses with sessions, seats, waiting list,
  payment status, attendance and verifiable certificates; events with registration, waiting list, QR tickets and
  door check-in; follow-up e-mails.
* **Database:** `appointment_types`, `appointment_type_staff`, `availability`, `availability_exceptions`,
  `appointments`, `courses`, `course_sessions`, `course_registrations`, `course_attendance`, `events`,
  `event_registrations`.
* **Routes (public):** `/book/schedule[/:slug[/confirm]]`, `/appointments/:token[/calendar.ics|/cancel|/reschedule]`,
  `/courses[/:slug]`, `/courses/registration/:token[/cancel]`, `/events[/:slug]`, `/tickets/:token[/cancel]`,
  `/certificates/:no`. **Staff:** `/staff/appointments[/new|/availability|/:id[/status|/reschedule]]`,
  `/staff/appointment-types`, `/staff/courses[/:id/registrations|/:id/sessions|/registrations/:rid|/sessions/:sid/attendance]`,
  `/staff/events[/:id/registrations|/checkin[/:token]]`.
* **Security:** no double booking — each booking re-checks the slot inside a transaction holding a per-counsellor
  MySQL named lock; website bookings must match published availability (a crafted time is refused); manage links
  are 32-character random tokens, rate-limited, and rotate on reschedule; the online meeting link is never on public
  event pages (ticket holders only); check-in requires `events.manage`; appointments follow the owner / branch scope.

### Report
* **Files:** `src/modules/booking/*` (scheduling, appointments / courses / events services, handlers + jobs, admin
  resources, staff web, public web), `src/modules/comms/{templates,notify,comms.service}.js`, views
  `pages/staff/booking/*`, `pages/site/{schedule*,appointment,course*,event*,ticket,certificate}.ejs`,
  `src/locales/*/engagement.json`, seed `src/db/seeds/demo-engagement.js` (GEC's three original events, two demo
  consultation types with hours for the demo counsellors, two sample courses — all flagged demo).
* **Migration:** `20261005000500_phase5_engagement.js`.
* **Tests:** `test/phase5.test.js` (6): slot engine (notice, time off, buffer), concurrent booking (exactly one
  wins), public booking → lead + appointment + stage `counselling_booked` + confirmation e-mail + 409 without a
  stray lead + .ics + reschedule (old link dies) + cancel; staff scope and status; course capacity / waiting list
  promotion / attendance / certificate verification / CSV; event QR ticket, private meeting link, check-in
  permission and idempotency. Suite: 44.
* **Known limitations:** meeting links are entered by staff (Google Meet / Teams auto-creation arrives with the
  calendar integrations in Settings → Integrations); course payment status is recorded manually until the finance
  module (phase 6) issues invoices; the scheduler offers 30-minute steps for types of 30 minutes or longer.

---

## Phase 6 — Communication centre and finance

### Plan
* **Exists:** e-mail adapters (SMTP / Google / Microsoft) and built-in bilingual templates (phase 5), timeline
  entries for messages, "log a contact" for calls made outside the system. Nothing for SMS, WhatsApp, invoices or
  partners (the original site only had a WhatsApp click-to-chat button).
* **Reuse:** settings with encrypted secrets, the `/hooks` raw-body router (CSRF-exempt, signature-verified), data
  scopes, resource CRUD, the attention queue / KPI / student-tab registries, notify + templates.
* **Change:** one message service for every channel (provider adapters: SMTP, Twilio SMS, WhatsApp Cloud API)
  that logs every message and puts it on the timeline; inbound webhooks matched to the person (unknown senders become
  leads); communication centre (inbox / sent / filters / unread badge); composer on lead and student pages with
  templates; WhatsApp click-to-chat logged as "sent from phone"; template editor (EN/AR, per channel, preview,
  reset, custom templates); Settings → E-mail / SMS / WhatsApp with "connected / not connected" status and a test
  e-mail. Finance: invoices (draft → issued → partly paid → paid, void), payments with receipts and refunds,
  printable bilingual invoice with a private payer link, finance overview per currency, overdue invoices in the
  attention queue, student Finance tab, university partner agreements and commissions created when an application
  at a partner university reaches "Enrolled".
* **Database:** `message_templates`, `messages`, `counters`, `invoices`, `invoice_items`, `payments`, `partners`,
  `commissions`.
* **Routes:** `/staff/messages[/:id|/send|/render|/whatsapp-link]`, `/staff/templates[/:key[/reset|/preview]]`,
  `/staff/settings/{email[/test],sms,whatsapp}`, `/hooks/whatsapp`, `/hooks/sms/twilio[/status]`,
  `/staff/finance`, `/staff/invoices[/new|/:id[/issue|/void|/send|/payments]]`, `/staff/payments[/:id/refund]`,
  `/staff/partners`, `/staff/commissions[/:id]`, `/staff/applications/:id/commission`, public `/invoices/:token`.
* **Security:** credentials encrypted (AES-256-GCM), never rendered back and redacted from the audit log; webhooks
  rejected without a valid Meta `X-Hub-Signature-256` / Twilio signature, retries de-duplicated; messages follow the
  person's data scope; finance requires `finance.*`, partners and commissions `partners.*` (counsellors see neither);
  totals computed server-side in cents; gap-free numbering under a row lock; overpayments, payments on drafts and
  voiding paid invoices are refused; the e-mail preview is served with its own restrictive CSP.

### Report
* **Files:** `src/modules/comms/{phone,sms,whatsapp,channels,comms.service,hooks,web}.js` (templates / notify
  extended), `src/modules/finance/{money,counters,invoices.service,partners,handlers,doc,web,site.web}.js`, views
  `pages/staff/comms/*`, `pages/staff/finance/*`, `pages/staff/settings/{email,sms,whatsapp}.ejs`,
  `partials/{compose-dialog,invoice-doc}.ejs`, `pages/finance-document.ejs`, `src/locales/*/finance.json`.
* **Migration:** `20261005000600_phase6_comms_finance.js`.
* **Tests:** `test/phase6.test.js` (6): not-connected channels send nothing and say so; e-mail logged + timeline;
  composer template variables; scope isolation; SMS credentials encrypted (settings + audit) and number
  normalisation; WhatsApp click-to-chat logging; webhook verification (GET challenge, forged signature refused,
  unknown sender → lead, retry de-dup, read marking, Twilio signature); template override/reset; invoice totals,
  numbering, issue/pay/overpay/refund/void rules, receipt e-mail, public link (not for drafts), CSV; partner
  agreement → commission on enrolment, permissions. Suite: 50.
* **Known limitations:** WhatsApp messages outside Meta's 24-hour window need an approved Meta template (the API
  error is shown; click-to-chat always works); online card payments are not collected in-app (payments are recorded
  by staff; a payment-gateway adapter can post to `/hooks` later); invoice PDFs come from the browser's
  print-to-PDF; e-mail replies are not fetched from the mailbox (inbound e-mail needs an IMAP / Graph adapter).

---

## Phase 7 — Website tracking, lead scoring, analytics, campaigns, automations

### Plan
* **Exists:** cookie banner storing the visitor's choice (`gec_consent`) and posting to `/t/consent` (route missing
  until now); leads with first/latest-touch UTM columns, `visitor_id`, `score`, `temperature`; server-side
  `site.view` / `site.search` / `site.calculator` / `site.lead_captured` events; the message service (phase 6).
* **Reuse:** domain events, lead capture (`originOf` already reads `req.visitor`), the message service for campaign
  sends, templates, tasks, assignment, the jobs runner, settings, data scopes.
* **Change:** first-party, consent-based tracking (server-side page views, no script required; a small beacon for
  clicks); visitor → lead merge on enquiry; transparent, editable lead scoring with reasons and manual override;
  analytics (traffic, funnel, first/latest-touch attribution, UTM campaigns, landing pages, programs viewed, daily
  leads) and team performance; campaigns with segments, consent enforcement, batching, open/click tracking and
  unsubscribe; automation rules engine (event and time-based triggers, conditions, six action types).
* **Database:** `visitors`, `tracking_events`, `leads.score_reasons / temperature_manual / score_updated_at`,
  `campaigns`, `campaign_recipients`, `automations`, `automation_runs`.
* **Routes:** `/t/e`, `/t/consent`, `/c/o/:token.gif`, `/c/c/:token`, `/u/:token` (GET/POST, RFC 8058 one-click);
  staff `/staff/analytics[/team]`, `/staff/settings/scoring`, `/staff/leads/:id/temperature`,
  `/staff/campaigns[/new|/:id[/launch|/cancel]]`, `/staff/automations[/new|/:id[/toggle|/delete]]`.
* **Security / privacy:** tracking only with "Accept all", never with Global Privacy Control / Do Not Track, never
  for bots; one random first-party cookie, no IP stored, user agent reduced to a device class, no fingerprinting;
  withdrawing consent deletes the visitor's history; campaigns can only reach people with marketing consent who have
  not unsubscribed (re-checked at send time); the tracked button redirects only to the campaign's own URL (no open
  redirect); unsubscribe applies to every record with that address; rules start disabled, cannot loop (depth guard)
  and time-based rules run once per record (unique key); permissions: `analytics.view`, `reports.team`,
  `campaigns.manage`, `automations.manage`, `settings.manage`.

### Report
* **Files:** `src/modules/growth/{tracking,scoring,analytics.service,campaigns.service,automations.service,web,site.web}.js`,
  views `pages/staff/growth/*`, `partials/lead-score.ejs`, `pages/site/unsubscribe.ejs`, `src/locales/*/growth.json`;
  e-mail adapter accepts headers (List-Unsubscribe); beacon in `public/js/site.js`; rule builder in `staff.js`.
* **Migration:** `20261005000700_phase7_growth.js`.
* **Tests:** `test/phase7.test.js` (5): no tracking without consent / with GPC / for bots; visitor, page views and
  program views recorded; enquiry linked to the visit with first-touch UTM; beacon allow-list; website activity on
  the lead; consent withdrawal deletes history; scoring reasons, settings-driven recalculation, manual override;
  campaign audience (consent + segment), send, open pixel, safe click redirect with UTM, one-click unsubscribe
  without CSRF, permanent exclusion, permissions; automations off by default, conditions, task / note / e-mail
  actions, run log, once-per-record timed rules, permissions; analytics funnel, sources, CSV, team permissions.
  Suite: 55.
* **Known limitations:** country of visitors is not recorded (no IP geolocation by design); session duration is
  approximated by first / last seen; SMS / WhatsApp campaign delivery receipts depend on the provider webhooks; Meta
  Pixel / Google Analytics are not embedded (adapters can be added in Integrations, gated by the same consent).

---

## Phase 8 — Student portal, notifications, AI study advisor

### Plan
* **Exists:** student sign-in / reset (phase 1), the student record and profile sections, matching, shortlist (with
  anonymous adoption), applications, documents (student upload supported in the service), appointments, invoices,
  the message log, bilingual templates (including `portal_invite`). No portal pages, no notifications, no advisor.
* **Reuse:** students / documents / applications / matching / shortlist / booking / finance services, the message
  service (new "portal" channel), templates, the staff shell CSS (sidebar + bottom navigation), activity timeline
  (`is_shareable` entries are what students see).
* **Change:** `/portal` with Home (journey timeline, journey score, one next step, appointment, counsellor, documents,
  applications, messages, recommendations), step-by-step profile with autosave, matches, shortlist, applications
  with stage timeline, documents (upload / replace), appointments, messages, payments, notifications, settings
  (notification preferences per category and channel, language, password, data export). Self sign-up with e-mail
  confirmation, staff invitations, notification centre for students and staff, AI study advisor.
* **Database:** `email_verifications`, `notifications`, `users.notification_prefs`, `messages.channel` + `portal`,
  `advisor_logs`.
* **Routes:** `/register`, `/verify/:token`, `/advisor`, `/advisor/ask`, `/portal/*` (14 pages),
  `/staff/students/:id/invite`, `/staff/notifications[/read]`, `/staff/settings/ai[/test]`.
* **Security:** unconfirmed student accounts cannot sign in, and are linked to existing CRM records only after the
  address is confirmed (no takeover by registering someone else's e-mail); sign-up never reveals whether an address
  exists; every portal query is bound to the signed-in student's id (other students' applications and files are
  404); the sign-in e-mail can't be changed from the portal; internal notes never reach the portal; uploads checked
  by content; the AI provider key is encrypted; the advisor only has read-only database tools, its output is
  rendered through the escaping Markdown renderer, refusals are handled, questions are rate-limited and logged.

### Report
* **Files:** `src/modules/portal/{account,web,public.web,staff.web}.js`, `src/modules/notifications/{service,handlers}.js`,
  `src/modules/ai/{tools,provider,advisor.service}.js` (official `@anthropic-ai/sdk`, default model
  `claude-opus-5-5`, server-side refusal fallback on supported models), `layouts/portal.ejs`, `pages/portal/*`,
  `pages/auth/{register,register-sent,verify-failed}.ejs`, `pages/site/advisor.ejs`, `partials/advisor-chat.ejs`,
  `pages/staff/{notifications,settings/ai}.ejs`, `public/js/advisor.js`, `src/locales/*/portal.json`.
  Auth: unverified students blocked; the visitor's shortlist key survives sign-in. Booking: a signed-in student's
  booking lands on their record (`booked_via = portal`).
* **Migration:** `20261005000800_phase8_portal.js`.
* **Tests:** `test/phase8.test.js` (7): sign-up confirmation, lead → student conversion without duplicates,
  shortlist adoption, one-time link, no account enumeration; privacy between students, profile save, e-mail lock,
  data export without secrets; upload → counsellor notification, rejection e-mail + in-app, preferences respected;
  portal messages both ways with notifications; staff invitation flow; advisor search mode (over-budget flagged)
  and tool-using AI mode with a scripted provider (tool use, escaping, logging, refusal); staff task notifications.
  Suite: 62.
* **Known limitations:** Google / Microsoft sign-in remain prepared (columns, adapters) but not enabled; in-app
  notifications refresh on page load (no push / websockets); the advisor keeps the last few turns of text per
  session (tool results are not replayed across turns); "Ask to delete my data" opens a message to GEC — the staff
  deletion workflow comes in phase 9.

## Phase 9 — Website CMS, SEO, resources, privacy

### Plan
* **Exists / reused:** the public site layout, `resource()` CRUD (now with a `validateRow` hook), the escaping
  Markdown renderer, settings store, audit log, notifications, lead/student records, the original site's content.
* **Changes:** Website group in the staff menu (pages, articles, services, FAQ, testimonials, navigation, home-page
  texts); public `/resources`, `/resources/:slug`, `/services`, `/services/:slug`, `/faq`, editable pages at their
  own address (`/about`, `/visa`, …); `sitemap.xml` with hreflang alternates, `robots.txt`; structured data (Article,
  Service, FAQPage); privacy request form, staff privacy queue, data export, anonymisation, retention job.
* **Database:** `pages`, `articles`, `faqs`, `testimonials`, `services`, `nav_items`, `privacy_requests`,
  `students/leads.anonymized_at`.
* **Security / honesty:** content is Markdown rendered with everything escaped (no raw HTML, only http(s)/mailto/tel/
  site links); page addresses that belong to the application are reserved; custom navigation links must be site
  paths or https URLs; a testimonial can only be published with consent on file; unverifiable claims from the
  original site (approval rates, amounts "secured", "guaranteed" outcomes) were not imported; the Visa page and
  articles say they are general guidance and to confirm with official sources; privacy actions need verified
  identity and a typed confirmation, and are audited; `privacy.manage` is not part of the Admin role.

### Report
* **Files:** `src/modules/cms/{admin,nav,site.web,web}.js`, `src/modules/privacy/{service,web,site.web}.js`,
  `pages/site/{resources,article,services,service,faq,page}.ejs`, `partials/article-card.ejs`,
  `pages/staff/cms/home.ejs`, `pages/staff/privacy/{index,request,stale}.ejs`, `src/locales/*/cms.json`;
  home page shows published services, consented testimonials and the latest articles, with editable hero / CTA
  texts (empty fields fall back to the built-in text in that language); the header keeps the main links and moves
  AI advisor, Events and Contact under "More" on desktop (all links remain in the mobile menu).
* **Seed:** `src/db/seeds/demo-cms.js` (`npm run seed`): the original GEC services (12), guides (5), FAQs (7),
  testimonials (4, unpublished — no consent record) and About / Visa pages; all `is_demo`, removed by
  `npm run seed -- --remove`.
* **Migration:** `20261005000900_phase9_cms.js`.
* **Routes:** public — `/resources[/:slug]`, `/services[/:slug]`, `/faq`, `/:slug` (CMS pages, mounted last),
  `/sitemap.xml`, `/robots.txt`, `POST /privacy/request`; portal — `POST /portal/settings/delete-request`; staff —
  `/staff/{pages,articles,services,faqs,testimonials,navigation}`, `/staff/website/home`,
  `/staff/privacy[/:id[/export|/anonymize]]`, `/staff/privacy/stale`.
* **Privacy:** a request from the website is unverified until staff confirm the requester; a signed-in student's
  request is verified. Export = complete JSON of the student and their leads, applications, documents (metadata),
  appointments, messages, shortlist, invoices and payments (no passport secrets, no internal notes). Anonymise =
  identity removed everywhere (profile, leads, messages, notes, files, registrations, website history, portal
  account disabled and signed out); invoices and payments keep amounts with the payer name removed. The daily
  retention job deletes website history older than the retention period; inactive leads past it can be
  anonymised in bulk.
* **Fix:** an empty "position" field no longer fails saving (resource ints default to 0 for position).
* **Tests:** `test/phase9.test.js` (5): public pages and JSON-LD, unpublished / scheduled content hidden, no
  imported claims; sitemap / robots; staff page creation, reserved slugs, XSS escaping, testimonial consent rule,
  navigation override and unsafe links, home texts with per-language fallback, permissions, audit; privacy request
  → verification → export → typed-confirmation anonymisation (sign-in disabled, invoice amounts kept), retention,
  bulk stale leads; portal deletion request. Suite: 67.
* **Known limitations:** no WYSIWYG editor (Markdown with a hint); images are referenced by URL or uploaded per
  field — there is no shared media library; scheduled articles appear at their date without a notification; legal
  retention periods for financial records are a business decision and are not enforced automatically.

## Phase 10 — Security audit, end-to-end journey, accessibility, production packaging

### Plan
* **Exists / reused:** the whole platform; the test helpers; the dev server for browser checks.
* **Changes:** an end-to-end journey test; an independent authorization review of every route, with fixes and
  regression tests; automated WCAG 2.1 A/AA checks (axe-core) of the public site, the portal and the workspace in
  English, Arabic, light and dark; a phone-width overflow check; production packaging and a README.
* **Database:** no schema change.

### Report
* **End-to-end journey** (`test/journey.test.js`): an anonymous visitor (with analytics consent) searches for a
  Master's in Data Science → opens the program and the university → uses the cost calculator → books a free
  consultation (lead created, linked to the browsing history, confirmation e-mail, stage "counselling booked") →
  a branch manager assigns the counsellor → the call is logged → the lead becomes a student → portal invitation and
  password → profile steps completed → recommendations (with reasons and the "guidance, not a guarantee" note) →
  shortlist → application with a document checklist → the student uploads every document → admissions verifies
  them (application moves to "Documents complete") → submitted → unconditional offer (student notified, sees it in
  the portal) → visa case opened, submitted, approved (journey "pre-departure") → invoice issued and paid (shown in
  the portal) → pre-departure task created and completed → enrolled. It ends by checking one connected timeline,
  the audit trail and that another counsellor cannot open the student.
* **Security review — fixed:**
  1. *High:* an Admin could create a password-reset link for a Super Admin (or another Admin) and use it. Reset
     links for Admin / Super Admin accounts now require a Super Admin, nobody resets their own account there, and
     the link is e-mailed to the employee — shown on screen only when e-mail is not connected.
  2. *High:* applications and visa cases stayed visible to the previous counsellor after a student was reassigned.
     Access now follows the student's current counsellor / branch, and reassignment moves the student's
     applications, visa cases and converted leads.
  3. *Medium:* the previous owner of a converted lead could read the student's timeline and portal messages.
     The lead page shows the student's history only to people who may see the student, and messages belong to the
     student's owner when there is a student.
  4. *Medium:* duplicate checks listed matching people company-wide (including by passport number). Matches outside
     the user's data scope now read "a matching record exists in another team" without any personal details.
  5. *Medium:* instructors could read and change registrations of courses they don't teach. Course registrations,
     sessions, attendance, payment status and certificates are limited to the instructor's own courses.
  6. *Low:* staff with only "view notes" could publish a note to the student portal — now internal only; note
     moderation is limited to records in the moderator's scope.
  7. *Low:* a document request or task could point at another student's application — refused / dropped.
  8. *Low:* back-redirects could produce `//host` paths — now fall back to a safe page.
* **Checked and clean** (review notes): finance, comms composer, appointments, documents, CRM records, palette,
  dashboards, analytics, portal routes (all bound to the signed-in student), token routes, mass assignment, unescaped
  output, webhooks, uploads, sign-in redirects; SQL is parameterised and sort columns are whitelisted.
* **Accessibility:** fixed muted-text contrast (now ≥ 5:1 on every surface), dark-mode call-to-action band contrast,
  links in running text underlined, icon-only language and search links labelled, progress bars named, account
  menu label matching its visible text, link-based tab bars no longer claim `role=tablist`, scrollable tables and
  the journey bar keyboard-focusable. Result: no axe WCAG 2.1 A/AA violations on the checked pages (public site,
  portal, workspace; EN/AR; light/dark). On phones (360 px) no page scrolls sideways; the header's booking button
  moves into the menu below 400 px.
* **Packaging:** `README.md` (setup, configuration, integrations, jobs, deployment, backups, security),
  `Dockerfile` (non-root, health check), `docker-compose.yml` (app + MariaDB with volumes), `.dockerignore`,
  graceful shutdown on SIGTERM, `RUN_JOBS=false` for additional instances.
* **Tests:** `test/journey.test.js` (1), `test/security.test.js` (7). Suite: 75, all passing; `npm run check` clean.
* **Known limitations:** event registrations are visible to everyone with "events.manage" (events are run
  company-wide; there is no per-branch event owner yet); external images (e.g. the original site's Unsplash photos)
  are referenced by URL and should be replaced with GEC's own images through the CMS; Google / Microsoft sign-in,
  calendar sync and online card payments remain prepared but not enabled; the AI advisor needs an Anthropic API
  key to answer in conversation (without it, it runs as an honest database search).

## Phase 11 — Closing the remaining gaps

### Plan
* **Exists / reused:** resource CRUD, uploads (content-checked storage), settings with encrypted secrets, the
  provider-webhook router, invoices and payments, notifications, audit log.
* **Changes:** ownership for events and courses so registrants follow data scope; a media library with alt texts and
  an image picker; an importer for images still loaded from other sites; card payments through Stripe Checkout.
* **Database:** `events.branch_id`, `events.organizer_id`, `courses.branch_id`, `media.alt_en/alt_ar/source_url/
  width/height`, `payment_sessions` (migration `20261006001100_phase11_gaps.js`).
* **Security:** registrant lists and CSVs limited by role; media uploads accept images only (checked by content),
  usage-checked before deletion; Stripe keys encrypted and checked with Stripe when saved; webhooks verified
  (HMAC-SHA256, 5-minute tolerance); payments recorded only from the webhook and claimed atomically, so retries
  cannot double-record; CSP `form-action` allows only Stripe's checkout as an extra destination.

### Report
* **Event / course registrants:** visible to company-wide roles, to the event's organiser or course's instructor,
  and to branch staff for events / courses of their branch. Company-wide events (no branch) are no longer visible to
  every branch manager. Forms gain "Organiser" and "Branch".
* **Media library** (Website → Media library): upload PNG / JPG / WebP / GIF up to 8 MB with English and Arabic
  descriptions; dimensions read from the file; search; "used in" list; deleting is refused while an image is used;
  every image field in the workspace has "Choose from library".
* **Image import:** finds every content image still loaded from another site (destinations, universities, events,
  courses, articles, pages, services, testimonials), downloads each address once over https (8 MB cap, image types
  only), stores it in the library and repoints the content; failures are listed and leave content unchanged. From the
  library page or `npm run images:import`. (It could not run in this development sandbox, which has no access to the
  image host; it is covered by tests with a simulated image server.)
* **Card payments:** Settings → Online payments (secret key, webhook signing secret, live / test mode shown). Issued
  invoices get "Pay by card" on their private page and in the student portal → Stripe Checkout for the open balance
  (zero- and three-decimal currencies such as JPY and JOD converted correctly). Returning from Stripe only shows a
  message; the payment is recorded (method "online", reference = Stripe payment id, receipt e-mailed as usual) when the
  signed `checkout.session.completed` webhook arrives. A retried webhook is ignored; a checkout paid after the
  balance was already settled is not recorded but flagged to finance (notification + audit) to reconcile or refund.
* **Files:** `src/modules/cms/media.service.js`, `src/modules/finance/{online,hooks}.js`, `scripts/import-images.js`,
  `pages/staff/cms/{media,media-item}.ejs`, `pages/staff/settings/payments.ejs`; updates to booking admin / web,
  CMS web, finance web / site, invoice page, portal payments, resource form, staff JS / CSS, app CSP.
* **Tests:** `test/phase11.test.js` (4): registrant ownership; media upload / picker / usage / permissions;
  import (deduplication, repointing, failures); Stripe (not connected, encrypted keys, checkout parameters, redirect
  does not mark paid, bad / stale signatures refused, recorded once, overpayment flagged, currency units).
  Suite: 79, all passing. No accessibility violations on the new pages (EN / AR).
* **Known limitations:** Stripe refunds are still recorded manually in the workspace (the refund itself is made in
  Stripe); Google / Microsoft sign-in and calendar sync remain prepared but not enabled; the image importer needs
  internet access on the server.

## Phase 12 — Sign in with Google and Microsoft

### Plan
* **Exists / reused:** sessions (`startSession`, regeneration), the student sign-up / linking logic, settings with
  encrypted secrets, audit log, rate limits.
* **Changes:** OpenID Connect sign-in for both portals; a settings page; "Continue with …" buttons on the sign-in
  and sign-up pages; "Sign-in accounts" (connect / disconnect) in staff "My account" and portal settings.
* **Database:** `user_identities` (user, provider, subject, e-mail; unique per provider account and per user /
  provider) — migration `20261006001200_phase12_sso.js`.
* **Security:** authorization-code flow with PKCE (S256), `state` bound to the browser session (10-minute
  expiry, constant-time compare) and `nonce`; the ID token comes straight from the provider's token endpoint with
  the client secret, and its issuer, audience, expiry and nonce are checked. Account matching:
  a linked provider account always signs in its owner; otherwise an e-mail address is used only when the provider
  vouches for it — Google `email_verified`, Microsoft `xms_edov` (verified domain) or a single-tenant setup — so
  an unverified Microsoft address can't take over an account. New accounts only for students; staff are never
  created by sign-in; student and staff accounts stay on their own sign-in pages; disabled accounts are refused.
  Connecting needs a signed-in user and a CSRF-protected POST; the last sign-in method can't be removed. Every
  sign-in, link, unlink and failure is audited.

### Report
* **Files:** `src/modules/auth/{sso,settings.web}.js`, routes in `src/modules/auth/web.js`
  (`/auth/:provider/start|callback|connect|disconnect`), `partials/{sso-buttons,sso-connections}.ejs`,
  `pages/staff/settings/sign-in.ejs`, provider marks in `public/brand/`, texts in `locales/*/auth.json`.
* **Fix:** stored credentials can now be encrypted when neither `APP_KEY` nor `SESSION_SECRET` is set (the
  generated session secret is used), instead of failing when integration settings were saved.
* **Tests:** `test/phase12.test.js` (8): not configured; settings (encrypted, per-portal); new student with PKCE
  and sign-in by account id; tampered state / nonce / audience / issuer / expiry and forged callbacks refused;
  linking only with provider-verified addresses (unverified Google and Microsoft refused, Microsoft verified-domain
  accepted); staff rules (existing only, never created, portals kept apart, disabled refused); connect /
  disconnect and last-method protection; Microsoft single tenant (other directories refused). Suite: 87.
* **To switch on:** create an OAuth client in Google Cloud and an app registration in Microsoft Entra, add the
  redirect URIs shown in the settings page, and paste the client ID and secret.
* **Known limitations:** calendar sync is not built; staff who sign in only with Google / Microsoft still need an
  administrator to create their account first (by design).

## Phase 13 — Website redesign, flags and university artwork

* Home page rebuilt: hero slider (managed in **Website → Home slider**), search dock, destination bento,
  journey steps, featured-program rail, scholarship band, services, events, testimonials, articles.
* Illustrated covers (`public/img/covers/*.svg`, `scripts/build-covers.js`) sit under every photo, so a missing or
  blocked photo never leaves an empty box.
* Country flags as SVG images (`public/flags/`, from the MIT-licensed `flag-icons` package via
  `scripts/build-flags.js`): emoji flags do not render on Windows.
* Every university gets a generated campus picture and crest (`/art/uni/<slug>.svg`, `/art/crest/<slug>.svg`,
  tinted by country) until real photos and logos are uploaded. Replace them any time from the university record or
  the media library.
* **Tests:** `test/phase13.test.js`.

## Phase 14 — University partner portal

University staff can sign in to their own portal and publish for their university; GEC keeps editorial control and
sets its margin.

* **Two ways in.** (1) A university asks to join from the public **For universities** page
  (`/for-universities`, honeypot + rate limit); partnerships staff see it in **Finance → Partnership requests**,
  link it to an existing university or create one (hidden until published), set GEC's commission (percent of
  first-year tuition or a fixed amount per enrolled student) and approve — the contact receives an e-mail to set a
  password. (2) Staff invite university users directly from **Finance → Partner accounts**.
* **Partner portal** (`/partner`, separate sign-in and password reset, accounts of kind `partner`): dashboard
  (live programs/scholarships, items in review, agreement rate, applications by stage), programs and scholarships
  (add / edit), university profile (texts, intakes, fees, logo and campus photo upload), submissions with GEC's
  notes, applications GEC has submitted (name initial only), team (owners invite editors).
* **Review before publishing.** Nothing a partner writes reaches the site directly: each change is a submission
  in **Admissions → Partner submissions** with a field-by-field before/after table. Reviewers approve and publish,
  ask for changes, or decline (a note is required and e-mailed to the university). Only fields the form sent are
  changed. Partners can only touch their own university's records.
* **GEC margin per program.** Programs carry `commission_type` (inherit / percent / fixed) and `commission_rate`,
  editable in the program's internal section or while approving a submission; the expected commission on
  enrolment uses the program rate before the university agreement.
* **Permissions:** `partners.manage` (requests, accounts), `catalog.manage` (submissions).
* **Files:** `src/modules/partnerhub/{service,portal.web,staff.web,public.web,mail}.js`, `layouts/partner.ejs`,
  `pages/partner/*`, `pages/staff/partners/*`, `pages/site/for-universities.ejs`, `locales/*/partners.json`,
  migration `20261006001400_phase14_partners_portal.js`.
* **Tests:** `test/phase14.test.js` (4): request → approval → invitation → sign-in; submission held until approved,
  program margin overrides the agreement; diff, change requests (note required), isolation between universities
  and portals; partial profile edits, team invites, disabling accounts.

## Phase 15 — SEO, GEO and AEO (search engines and AI assistants)

* **Settings → SEO & AI search:** default description (AR/EN), sharing image, Google / Bing / Yandex verification
  codes (paste the code or the whole meta tag), AI crawler policy, `/llms.txt` on/off with its introduction, and
  extra robots.txt rules (only valid directives are kept).
* **robots.txt** is generated: private areas (staff, portal, partner, tokens) closed for every crawler; AI answer
  engines (OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-SearchBot, …) allowed by default so they can cite
  GEC; model-training crawlers (GPTBot, ClaudeBot, Google-Extended, CCBot, …) blocked by default — both switchable.
* **/llms.txt** (and `?lang=ar`): a Markdown summary — who GEC is, contact, key pages, destinations, services,
  universities, programs with fees, scholarships with deadlines, guides and FAQs — built from live content only.
* **Structured data:** EducationalOrganization (with social profiles) + WebSite with site search on the home page;
  BreadcrumbList on every detail page; existing Course/University/Event/Article/Service/FAQPage kept. Every page
  gets `og:url`, an absolute sharing image, `x-default` hreflang and a robots directive allowing large previews.
* **Website → SEO audit:** a visibility score; site checks (description, sharing image, verification, AI access,
  llms.txt, number of FAQs, HTTPS); content checks per type (missing Arabic titles, missing descriptions, long or
  duplicate titles, universities still on generated pictures, images without alt text) with links to fix each;
  a GEO checklist and links to Search Console, Bing Webmaster Tools, Rich Results Test and PageSpeed Insights.
* **Files:** `src/modules/seo/{service,web,site.web}.js`, `pages/staff/settings/seo.ejs`, `pages/staff/seo/audit.ejs`,
  `locales/*/seo.json`. **Tests:** `test/phase15.test.js` (4).

## Phase 16 — Marketing: newsletter, subscriber campaigns, UTM link builder

* **Newsletter with double opt-in.** Sign-up in the website footer and at `/newsletter` (interests by country and
  degree, consent text and IP stored, honeypot + rate limit). A confirmation e-mail is sent; the subscription
  starts only when the person presses the button on the confirmation page (opening the link alone — as mail
  scanners do — confirms nothing). Links expire after 14 days and work once; a private manage link unsubscribes.
  Signing up again never reveals whether an address is already on the list.
* **Campaigns to subscribers.** Campaigns gain a third audience, *Newsletter subscribers* (confirmed only, e-mail
  only, filter by country interest and degree). Consent is re-checked when each e-mail is sent; the one-click
  unsubscribe in every campaign e-mail removes the address from the newsletter and from leads/students alike.
* **Communication → Newsletter subscribers:** counts by status, search, CSV export (audited), delete.
* **Communication → Link builder (UTM):** quick-fill presets (Instagram, TikTok, WhatsApp, Google Ads, flyers …),
  normalised values, copy button, and results per link — visitors, leads and students with the same UTM source,
  medium and campaign.
* **Files:** `src/modules/marketing/{newsletter,site.web,web}.js`, `pages/site/newsletter.ejs`,
  `pages/staff/marketing/*`, footer form, `locales/*/marketing.json`, migration `20261006001500_phase16_marketing.js`.
* **Tests:** `test/phase16.test.js` (4).

## Phase 17 — Website editor: home sections and page builder

* **Website → Home page → Sections and order:** every home section (search and numbers, destinations, how it works,
  student portal, featured programs, scholarships, services, events, testimonials, articles, final call to action)
  can be shown or hidden, moved up or down, and given its own title and introduction in Arabic and English (empty
  fields keep the default text). Sections made of a page's blocks can be added anywhere on the home page.
* **Page builder** (Website → Pages → a page → *Page builder*): pages are built from blocks — hero banner, text
  (Markdown), image and text, feature cards, numbers, call to action, questions and answers, live program list
  (by country, degree, field), gallery and YouTube/Vimeo video. Each block is bilingual, can be moved, duplicated,
  hidden or removed, and images come from the media library. It is plain HTML forms (works without JavaScript;
  pressing Enter saves and never moves a block). Every value is validated: links must be site paths or https
  addresses, images https or the library, videos YouTube/Vimeo (embedded privacy-enhanced, allowed in the CSP).
* **Preview** before publishing (staff only, marked as a preview). Question blocks are published as FAQPage
  structured data for Google and AI answers; a hero block's image becomes the sharing image.
* The demo About page shows example blocks.
* **Files:** `src/modules/cms/{blocks,blocks.data,builder.web,home.layout}.js`, `partials/blocks.ejs`,
  `pages/site/home/*.ejs` (one file per home section), `pages/staff/cms/{builder,home}.ejs`, `locales/*/editor.json`,
  migration `20261006001600_phase17_page_blocks.js`. **Tests:** `test/phase17.test.js` (3).

## Phase 18 — System update button

* **System → System update** (new permission `system.update`, Super Admin only): running version (package version +
  Git commit), updater status, updates waiting on the branch (commit messages), **Update the system now** and
  **Check for updates**, and the live log of the last run (polls while running, survives the restart).
* The web app never runs commands on the server: the button writes `runtime/request.json` (audited). The server-side
  updater `deploy/updater.py` (installed with `deploy/install-updater.sh` as a systemd timer + path unit) writes a
  heartbeat and pending commits to `runtime/updater.json`, and on request: refuses local changes, runs
  `deploy/backup.sh`, fast-forwards to `origin/<branch>`, rebuilds (`docker compose up -d --build` with the commit
  baked in as `APP_COMMIT`) or restarts the systemd service, waits for `/healthz` (and the new commit in Docker),
  and resets + redeploys the previous commit if the new version does not come up. Without a recent heartbeat the
  page shows "not connected" and the button is refused.
* **Files:** `src/modules/system/{version,updates,web}.js`, `pages/staff/system/update.ejs`, `public/js/updates.js`,
  `deploy/{updater.py,install-updater.sh,gec-updater.service,gec-updater.timer,gec-updater.path}`, Dockerfile build
  arg, compose volume `./runtime`. **Tests:** `test/phase18.test.js` (2) plus updater runs against a scratch Git repo.
