# MedWorks — Environment Variables

Source of truth: `src/config/index.js` and the `process.env.*` reads in `src/`. Template for the Docker deployment:
`deploy/.env.production.example`; for a shared host / plain Node install: `.env.example`.

**Never commit a filled `.env`.** It lives only on the server (`chmod 600`), with a copy in the operator's password
manager. The image contains no `.env` (removed at build, excluded by `.dockerignore`).

Legend — **Req**: required in production (with `STRICT_CONFIG=true` the app refuses to start without it).
**Set by compose**: `compose.yaml` sets it for the app container; do not put it in `.env`.

## Core

| Variable | Req | Default | Meaning |
|---|---|---|---|
| `NODE_ENV` | set by compose | `development` | `production` enables secure cookies, hides error details, enables the production checks. |
| `STRICT_CONFIG` | set by compose | off | `true`: refuse to start when a production problem is found (missing/weak secrets, non-https `APP_URL`, missing DB credentials, `TRUST_PROXY=false`, short super-admin password). Without it the problems are only logged. |
| `PORT` | | `3000` | Port the app listens on (inside the container). |
| `APP_URL` | **Req** | `http://localhost:3000` | Public https address; used in e-mails, QR codes, payment and Google callbacks. |
| `SESSION_SECRET` | **Req** | dev value / generated file | Signs session cookies. ≥ 32 random characters. |
| `APP_KEY` | **Req** | falls back to `SESSION_SECRET` | Encrypts stored third-party credentials. Set once, never change. When moving servers: the old `APP_KEY`, or the old `SESSION_SECRET` if `APP_KEY` was never set. Check with `node app.js check-secrets`. |
| `TRUST_PROXY` | set by compose | private ranges | Which proxy's `X-Forwarded-*` to trust. `true` = loopback + private ranges (Caddy on the Docker network). |
| `AUTO_MIGRATE` | | `true` | Apply migrations at start (under a DB lock). `false` → `node app.js migrate` by hand. |
| `DEFAULT_LOCALE` | | `ar` | `ar` or `en` for new visitors. |
| `ALLOW_SIGNUP` | | `true` | `false` = invite-only. |
| `MAINTENANCE` | | off | Closes the site for maintenance (the platform admin still gets in); also switchable in the admin. |
| `MEDWORKS_CONTAINER` | set by compose / image | off | `1` = running in Docker: the in-app code updater is disabled (updates via `deploy/deploy.sh`). |

## Database

| Variable | Req | Default | Meaning |
|---|---|---|---|
| `DB_HOST` | set by compose | `localhost` | `db` in compose. |
| `DB_PORT` | set by compose | `3306` | |
| `DB_SOCKET` | | — | Unix socket instead of host/port (shared hosts). |
| `DB_NAME` | **Req** | — | Main database (`medworks`). A different name from the old server is fine: the import adjusts the clinic databases. |
| `DB_USER` / `DB_PASSWORD` | **Req** | — | App's database user. |
| `DB_ROOT_PASSWORD` | **Req (compose)** | — | MariaDB root; used by the `db` container and the backup/restore scripts only. Blanked for the app container. |
| `DB_BUFFER_POOL` | | `512M` | InnoDB buffer pool (≈ 25–40 % of the VPS RAM). |
| `DB_POOL_MAX` | | `10` | Connections from the app to the main database. |
| `DB_NAME_TEST` | tests only | `docbook_test` | Database used by `npm test`. |

## Per-clinic databases

| Variable | Default | Meaning |
|---|---|---|
| `TENANT_DB_DRIVER` | `off` | `off` (all clinics in `DB_NAME`), `mysql` (VPS: `CREATE DATABASE`), `cpanel` (cPanel API). |
| `TENANT_DB_PREFIX` | `<DB_NAME>_` | Prefix of clinic database names. |
| `TENANT_POOL_MAX` | `3` | Connections per clinic database. |
| `CPANEL_URL`, `CPANEL_USER`, `CPANEL_TOKEN` | — | Only for `cpanel`. |
| `TENANT_MOVE_SETTLE_MS` | `12000` | Pause while moving a clinic between databases. |

## Platform admin

| Variable | Default | Meaning |
|---|---|---|
| `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` / `SUPER_ADMIN_NAME` | — | Created at start when missing; an existing password is never overwritten. Password ≥ 12 characters. |

## E-mail and integrations

| Variable | Meaning |
|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | Platform e-mail (or set in Platform admin → settings, stored encrypted). |
| `SUPPORT_EMAIL` | Shown to users as the support address. |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | Microsoft 365 mailbox sign-in for clinics' e-mail. |
| `ICE_SERVERS`, `JITSI_URL` | Video consultations (STUN/TURN JSON; optional self-hosted Jitsi). |
| `WHATSAPP_GRAPH_VERSION` | WhatsApp Cloud API version (`v21.0`). |
| `SERVER_IP` | Public IPv4 shown to clinics connecting a custom domain; checked by `deploy/preflight.sh` against DNS. |
| `INTEGRATIONS_ALLOW_PRIVATE`, `DATASYNC_ALLOW_PRIVATE` | `true` only for on-premise installs that must reach private addresses. Keep off on the VPS (SSRF protection). |
| `PAYTABS_BASE_URL`, `HYPERPAY_BASE_URL` | Test simulators only; ignored when `NODE_ENV=production`. |

## Files and limits

| Variable | Default | Meaning |
|---|---|---|
| `CLINIC_BACKUP_DIR` | `/app/storage/clinic-backups` | Clinics' own nightly backups. |
| `PATIENT_EXPORT_DIR`, `PATIENT_IMPORT_DIR` | under `/app/storage` | Patient file export / import working folders. |
| `LEGACY_IMPORT_DIR`, `LEGACY_FILES_DIR` | under `/app/storage` | Import from other systems; legacy attachments. |
| `PATIENT_IMPORT_MAX_MB` | `4096` | Patient import upload limit. |
| `LEGACY_IMPORT_MAX_MB` | `8192` | Legacy import upload limit. |
| `LEGACY_REMOTE_DELAY_MS` | `300` | Pause between requests when pulling from a remote legacy system. |
| `CLINIC_STORAGE_MB` | per plan | Override of each clinic's storage quota. |
| `CACHE_TTL_MS` | `60000` | In-process cache lifetime. |
| `LIVE_POLL_MS` | `3000` | Live screens polling interval. |

In Docker, keep the folder variables unset: the defaults are inside the `app_storage` volume.

## Single-clinic editions (not used by the SaaS deployment)

`APP_EDITION` (`platform` default, `clinic`, `center`), `CLINIC_NAME`, `CLINIC_NAME_EN`, `CLINIC_SLUG`,
`CLINIC_SPECIALTY`, `CLINIC_CITY`, `CLINIC_CURRENCY`, `CLINIC_TIMEZONE`, `BRAND_NAME`.

## Deployment scripts only (read from `.env` by `deploy/*.sh`, never by the app)

| Variable | Meaning |
|---|---|
| `DOMAIN` | Apex domain for Caddy (`medworks.app`); must match `APP_URL`. |
| `ACME_EMAIL` | Let's Encrypt account e-mail. |
| `APP_IMAGE_TAG` | Image tag (default `latest`). |
| `BACKUP_DIR` | Backup folder (`/var/backups/medworks`). |
| `BACKUP_KEEP_DAYS` | Retention in days (`14`). |
| `BACKUP_PASSPHRASE` | Encrypts backups (≥ 16 characters). Blanked for the app container. Keep a copy off the server. |
| `OFFSITE_TARGET` | Off-server copy destination for `deploy/offsite.sh`: `rclone:<remote>:<path>` or `rsync:<user@host>:<path>`. Empty = none. |
| `COMPOSE_FILE` | Do not set in `.env`. The scripts set it to `compose.yaml:deploy/compose.preview.yaml` in pre-DNS mode (`--no-proxy`). |
| `EXPORT_PASSPHRASE` | Given on the command line for `export-old-server.sh` / `import-migration.sh`; not stored. |

## Build / test only

`BUILD_NO_ZIP` (skip the update ZIP in `npm run build`), `SPECIALTIES`, `TENANT_TEST_DB`, `TENANT_LOST_LOG`,
`IMAGEOPT_DEBUG`, `DOCBOOK_UPDATE_ROOT` (tests only).
