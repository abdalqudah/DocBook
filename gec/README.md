# GEC Platform

Study-abroad website, student portal, admissions ATS, CRM, booking, communications, finance and website CMS for
**Global Education Consultants** — one application, one database, Arabic and English (RTL / LTR).

| Area | Where |
| --- | --- |
| Public website (study finder, universities, programs, scholarships, cost calculator, booking, events, courses, resources, AI advisor) | `/` |
| Student portal (journey, profile, recommendations, shortlist, applications, documents, appointments, messages, payments) | `/portal` (sign-in at `/login`) |
| Staff workspace (dashboard, leads, students, applications, documents, visa, appointments, messages, finance, analytics, website, settings) | `/staff` (sign-in at `/staff/login`) |
| JSON API (same permissions as the workspace) | `/api/*` |

How it was built, phase by phase, with the plan and report for each: [`docs/PHASES.md`](docs/PHASES.md).
The original-site audit and architecture: [`docs/01-AUDIT-AND-ARCHITECTURE.md`](docs/01-AUDIT-AND-ARCHITECTURE.md).

---

## Requirements

* Node.js 20 or newer (22 recommended)
* MySQL 8 or MariaDB 10.6+ (utf8mb4)
* An SMTP account for e-mail (optional at first — the workspace shows "not connected" until it is set up)

## Quick start (development)

```bash
cp .env.example .env            # then set NODE_ENV=development, DB_*, ADMIN_EMAIL, ADMIN_PASSWORD
npm install
npm run migrate                 # creates / updates the tables (also runs automatically on start when AUTO_MIGRATE=true)
npm run seed                    # optional demo data (see below)
npm run dev                     # http://localhost:3000
```

The first administrator is created at start-up from `ADMIN_EMAIL` / `ADMIN_PASSWORD` if that account does not
exist yet (an existing account is never changed). Sign in at `/staff/login`.

### Demo data

`npm run seed` adds clearly marked demo records (a "Demo" chip in the workspace): demo staff and leads, a catalogue
of destinations, universities, programs and scholarships, consultation types, the events from the original site,
sample courses, and the original site's services, guides, FAQs and About / Visa pages. Testimonials are imported
**unpublished** because there is no consent record for them. Remove every demo row with:

```bash
npm run seed -- --remove
```

Never seed a production database you care about.

## Configuration

All settings are environment variables (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `production` in production (secure cookies, no stack traces, caching). |
| `APP_URL` | Public `https://` address — used in e-mails, links, sitemap, canonical URLs. |
| `SESSION_SECRET` | Long random string signing session cookies. Required in production. |
| `APP_KEY` | Encrypts stored credentials (SMTP, SMS, WhatsApp, payments, sign-in, AI keys) with AES-256-GCM. Falls back to the session secret when unset. Set once; changing it makes saved credentials unreadable (re-enter them). |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` / `DB_SOCKET` | Database connection. Tests use `DB_NAME_TEST` (default `gec_test`) and **drop all its tables**. |
| `AUTO_MIGRATE` | Run migrations at start-up (default `true`). |
| `TRUST_PROXY` | Set when behind a reverse proxy / load balancer so client IPs and HTTPS are detected. |
| `STORAGE_DIR` | Uploaded files (documents, images). Outside the web root; back it up. Default `./storage`. |
| `RUN_JOBS` | Background jobs run in the app process. With several instances set `false` on all but one. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | First administrator. |
| `SMTP_*`, `MAIL_FROM` | Optional e-mail fallback; normally configured in **Settings → Email**. |

Everything else — branding, company details, pipelines, scoring, email / SMS / WhatsApp providers, the AI advisor,
privacy and retention, website content — is configured in the workspace under **Settings** and **Website**.

## Integrations

Nothing is faked: a channel that is not configured is shown as **not connected**, and its send buttons are disabled
with an explanation.

| Integration | Set up in | Notes |
| --- | --- | --- |
| E-mail (SMTP) | Settings → Email | Test button sends a real message. Templates (EN/AR) in Communication → Templates. |
| SMS (Twilio) | Settings → SMS | Delivery status via `/hooks/sms/twilio/status`, replies via `/hooks/sms/twilio`. |
| WhatsApp (Meta Cloud API) | Settings → WhatsApp | Webhook `/hooks/whatsapp` (verify token + app-secret signature). Without it, staff can still open a `wa.me` link, logged as a manual message. |
| AI advisor (Anthropic) | Settings → AI | Uses the official SDK; answers only from the platform's own catalogue through read-only tools. Without a key the advisor runs as a database search and says so. |
| Card payments (Stripe Checkout) | Settings → Online payments | Secret key + webhook signing secret; webhook `/hooks/stripe`. Invoices then show "Pay by card"; payments are recorded only from Stripe's signed webhook, once per checkout. Card details never reach this server. |
| Sign in with Google / Microsoft | Settings → Sign-in with Google / Microsoft | Client ID + secret per provider; redirect URIs `/auth/google/callback`, `/auth/microsoft/callback`. Choose students, staff or both; for staff with Microsoft, set your own tenant. New accounts are created only for students; staff must already exist. |
| Calendar sync | — | Not enabled. |

## Website images

Images are managed in **Website → Media library** (uploaded once, checked by content, with English/Arabic
descriptions; every image field in the workspace has "Choose from library"). The demo content still points at the
original site's stock photos on another host. On a server with internet access, copy them into the library once —
from the library page ("Copy into the library") or with:

```bash
npm run images:import
```

Each address is downloaded once, the content is repointed to the copy, and anything that fails (not reachable, not an
image, over 8 MB) is listed and left unchanged. Check you have the right to use each image.

## University partners

Universities can publish their own programs, scholarships and profile through the partner portal at `/partner`.
They apply on `/for-universities` (or staff invite them from **Finance → Partner accounts**); GEC approves each
request, sets its commission, and reviews every change in **Admissions → Partner submissions** before it goes live.

## Background jobs

Run inside the app process (one minute to one day intervals): appointment and event reminders, campaign sending,
timed automations, daily lead scoring, privacy retention. Each job is idempotent, so a restart or a second runner
does not send duplicates.

## Deployment

### Docker

```bash
cp .env.example .env     # fill in APP_URL, SESSION_SECRET, APP_KEY, DB_PASSWORD, ADMIN_*
docker compose up -d --build
```

`docker-compose.yml` runs the app and MariaDB with volumes for the database and uploaded files. Put a
TLS-terminating reverse proxy (Caddy, nginx, a cloud load balancer) in front of port 3000 and set
`TRUST_PROXY=true`.

### Without Docker

```bash
npm ci --omit=dev
NODE_ENV=production node app.js     # or under systemd / PM2
```

* Health check: `GET /healthz` (checks the database).
* The process shuts down gracefully on `SIGTERM`.
* Static files are cached for 7 days in production; CSS / JS / icon URLs carry a version so a deploy is picked up at once.

### Backups

Back up the database **and** `STORAGE_DIR` together, and keep `APP_KEY` / `SESSION_SECRET` in your secret store —
without `APP_KEY` the stored provider credentials cannot be decrypted.

## Security

* Separate sign-in for students and staff; bcrypt passwords, lockout after repeated failures, session regeneration
  at sign-in, rate limits on sign-in, reset, registration, public forms, tracking and the AI advisor.
* Permissions checked on the server for every route, plus data scope (own / branch / all) per role. Counsellors
  see only their students; university commissions are visible only to finance and administrators.
* CSRF tokens on every form and API write; strict Content-Security-Policy (no inline scripts); `frame-ancestors
  'none'`; secure, http-only, same-site cookies in production.
* Uploads are checked by content (not by extension), stored outside the web root and served as attachments after a
  permission check. Passport numbers are encrypted; credentials are encrypted with `APP_KEY`.
* An audit log records sign-ins, changes, exports, reveals and privacy actions, with secrets redacted.
* Privacy: cookie consent before any analytics (Global Privacy Control and Do-Not-Track respected, no
  fingerprinting, no IP addresses stored), marketing consent and one-click unsubscribe, data export, privacy
  requests with identity verification, audited anonymisation and a retention job.

## Development

```bash
npm test          # full test suite (uses DB_NAME_TEST — its tables are dropped and recreated)
npm run check     # locale parity (EN/AR), no hard-coded colours, no inline scripts
node scripts/build-icons.js   # after adding an icon name to scripts/build-icons.js
```

`test/journey.test.js` walks one student from an anonymous search to enrolment across every module.

### Layout

```
app.js                    entry point
src/server.js             boot: database check, migrations, bootstrap, jobs
src/app.js                Express app: security headers, sessions, CSRF, static files, routes
src/routes.js             route order (public site, portal, staff, API, hooks)
src/core/                 shared building blocks (resource CRUD, validation, errors, i18n, markdown, uploads, audit, …)
src/modules/<area>/       one folder per area: *.service.js (logic), web.js (pages), api.js (JSON), handlers.js (events)
src/db/migrations/        schema, one migration per phase
src/db/seeds/             demo data (is_demo = 1)
src/locales/{en,ar}/      dictionaries (merged by top-level key)
src/views/                EJS layouts, pages and partials
public/                   CSS, JS, fonts, brand assets, icon sprite
test/                     node:test + supertest
```
