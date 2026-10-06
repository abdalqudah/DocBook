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
