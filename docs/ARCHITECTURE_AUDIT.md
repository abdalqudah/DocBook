# MedWorks — Architecture Audit

Audit date: 2026-10-12. Base: commit `9de863a` (2.9.51) plus the VPS-readiness changes of 2.9.52. Everything below was
read from the code; where a statement was checked by running something, the evidence is in `docs/TEST_RESULTS.md`.

## 1. What the system is

A multi-tenant clinic-management SaaS: clinics sign up, each gets its own workspace (appointments, patients, clinical
records, billing, pharmacy/stock, HR, reports, patient portal, online booking pages, WhatsApp/e-mail messaging), and a
platform admin runs the SaaS (subscriptions, CRM, marketing site, support).

| Layer | Technology | Where |
|---|---|---|
| Runtime | Node.js 22 LTS in the image (`package.json` `engines` allows ≥ 20) | `Dockerfile`, `package.json` |
| Web framework | Express 4, server-rendered EJS views (509 templates), no SPA | `src/app.js`, `src/views/` |
| Database | MySQL 8 / MariaDB 10.6+ through knex (`mysql2`); `pg` is only used to read external databases | `src/db/` |
| Schema | 132 knex migrations, applied at start under a database lock (`GET_LOCK`) | `src/db/migrations/`, `src/db/lock.js`, `src/server.js` |
| Sessions | `express-session` stored in the `sessions` table of the main database | `src/app.js:79-90` |
| Security middleware | helmet (CSP, HSTS), own CSRF tokens, `express-rate-limit`, bcrypt passwords, optional TOTP for platform admins | `src/app.js`, `src/middleware/` |
| Files | Mostly database BLOBs (logos, attachments, documents). On disk only under `storage/` (clinic backups, patient exports/imports, legacy-import files, legacy attachments) | `src/modules/platformops/clinic-backup.js`, `src/modules/patientexport/` |
| E-mail | nodemailer (SMTP), imapflow (mailbox) | `src/core/mailer.js`, `src/modules/mailbox/`, `src/modules/clinicmail/` |
| PDFs / images | pdfkit, own WebP/JPEG compression via wasm (`@jsquash`) | `src/core/imageopt.js` and the PDF builders of each module |
| Background jobs | ~20 `setInterval` jobs inside the web process (messaging, campaigns, subscriptions, nightly clinic backups, sync…) | `src/server.js:90-130` |
| Build | `npm run build` bundles everything into `dist/medworks/app.js` (+ views, locales, migrations, public) | `scripts/build-dist.js` |
| Tests | `node:test`, 123 test files against a real MariaDB test database | `test/` |

Size: 67 modules under `src/modules/`. Feature-by-feature inventory: `docs/FEATURE_INVENTORY.md`.

## 2. Request flow

```
internet ──► Caddy (80/443, TLS, HSTS) ──► app:3000 (Express)
                                             ├─ helmet / compression / static (/public, 7-day cache)
                                             ├─ raw-body routes before sessions: /hub/v1, /hub-in/v1, /hooks, /pay
                                             ├─ session (DB store) → CSRF → locale → context (user, clinic)
                                             ├─ /healthz  (SELECT 1 on the main DB)
                                             ├─ maintenance gate
                                             └─ routes/web.js: public site, /app (clinic), /admin (platform), portal…
                                                  └─ /app: requireAuth → resolveBusiness → subscription gate
                                                           → module on/off gate → per-member page access → can(perm)
```

## 3. Multi-tenancy

Two modes, chosen by `TENANT_DB_DRIVER`:

- **`off`**: every clinic's rows in the main database, separated by `business_id`. Every tenant query goes through
  `req.ctx.businessId`; `test/tenant-isolation.test.js` checks it over HTTP (9 cross-clinic probes, all refused).
- **`mysql` / `cpanel`**: each clinic gets its own database `<DB_NAME>_<slug>` (`businesses.db_name`). Tenant tables
  (`src/db/tables.js`) live there; platform tables (users, sessions, businesses, subscriptions…) stay in the main
  database. Clinic databases have foreign keys and views that point at the main database, so **the main database must
  be restored before clinic databases and dropped after them** (the restore script does this).

Rows still carry `business_id` in per-clinic databases, so both protections apply.

## 4. State that a deployment must keep

| State | Where | Kept by |
|---|---|---|
| Main database (users, sessions, clinics, subscriptions, platform settings, CRM) | MariaDB `DB_NAME` | volume `db_data`, `deploy/backup.sh` |
| Clinic databases | MariaDB `DB_NAME_*` | same |
| Files on disk | `/app/storage` | volume `app_storage`, `deploy/backup.sh` |
| TLS certificates | Caddy | volume `caddy_data` (re-obtainable) |
| Secrets | `.env` on the server only | operator (copy kept off the server) |

`APP_KEY` (or `SESSION_SECRET` when no `APP_KEY` was ever set) encrypts stored third-party credentials
(`src/core/secrets.js`). Changing it makes those credentials unreadable; `node app.js check-secrets` detects that.

## 5. Findings that shape the deployment

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| A-1 | Background jobs run in the web process with no inter-process lock | `src/server.js:90-130` | Run **exactly one** app container. Horizontal scaling needs a job lock or a separate worker first (not needed today). |
| A-2 | Migrations run at start under `GET_LOCK` | `src/db/lock.js`, `src/server.js` | Safe with one process; `AUTO_MIGRATE=false` + `node app.js migrate` for manual control. |
| A-3 | The in-app updater replaces application files on disk | `src/modules/platformops/updates.web.js` | In a container the image is read-only and replaced on deploy: the updater is now refused with a clear message when `MEDWORKS_CONTAINER=1`. Updates go through `deploy/deploy.sh`. |
| A-4 | Most uploads are BLOBs in the database | migrations, `patient_attachments` etc. | Database backups carry almost all patient files; the `storage` volume is small. |
| A-5 | `trust proxy` default trusts private ranges | `src/app.js` | Correct behind Caddy on the Docker network; the container sets `TRUST_PROXY=true`. |
| A-6 | Sessions in the database | `src/app.js:85` | Restarts and redeploys do not sign users out. |
| A-7 | Secrets fell back to development values when not in production | `src/config/index.js` | 2.9.52 adds `productionProblems()`; with `STRICT_CONFIG=true` (set in the image) the app refuses to start on a missing/weak secret, non-https `APP_URL`, missing DB credentials. |
| A-8 | No Redis/queue/search engine is used or needed | dependency list | None added. Caching is in-process (`src/core/cache.js`). |

## 6. Deployment architecture chosen

Docker Compose on one Ubuntu 24.04 VPS (details and the reasons in `docs/DEPLOYMENT_PLAN.md`):

```
                 ┌──────────────────────── VPS (ufw: 22, 80, 443) ────────────────────────┐
 internet ──► :80/:443 ─► proxy (caddy:2.8-alpine) ──web net──► app (medworks-app, node 22,  │
                 │          automatic HTTPS, on-demand TLS     non-root, read-only fs)       │
                 │          for clinic custom domains            │ internal net (no internet) │
                 │                                               ▼                            │
                 │                                       db (mariadb:11.4, no published port)│
                 │  volumes: db_data, app_storage, caddy_data, caddy_config                   │
                 │  /var/backups/medworks ← deploy/backup.sh (systemd timer, daily 02:30)      │
                 └────────────────────────────────────────────────────────────────────────────┘
```
