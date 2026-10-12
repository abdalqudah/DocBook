# MedWorks — Deployment Plan (Hostinger VPS)

Status: **prepared and tested on a local Docker stack; not deployed.** Nothing has been installed on the VPS, no DNS
record was changed and no certificate was requested. Those steps wait for the approvals listed at the end.

## 1. Decision: Docker Compose on one VPS

| Option | Verdict | Why |
|---|---|---|
| **Docker Compose: app + MariaDB + Caddy** | **Chosen** | Pinned, repeatable images; the database is unreachable from the internet; one command to update and roll back; the same stack was built and tested locally. |
| Node + PM2 + Nginx on the host | Kept as a fallback (`deploy/nginx/medworks.conf`) | Works, but more host packages to keep patched and no image to roll back to. |
| Kubernetes, Redis, Elasticsearch, a job queue | Not used | Nothing in the code needs them (see `docs/ARCHITECTURE_AUDIT.md` §5). One app process is required anyway (in-process jobs). |
| Managed database | Not now | Possible later; the stack only needs `DB_HOST` changed. |

Caddy instead of Nginx + Certbot: it obtains and renews Let's Encrypt certificates by itself, redirects HTTP to HTTPS,
and issues certificates on demand for clinics' custom domains — but only for domains the app confirms belong to a
clinic (`GET /internal/tls-ask`, answered only on the private network; `/internal/*` is blocked at the proxy).

## 2. Files

| File | Purpose |
|---|---|
| `Dockerfile` | Two-stage build on `node:22.23.3-bookworm-slim`; runtime holds only the bundle, runs as `node` (uid 1000), health check on `/healthz`. |
| `.dockerignore` | Keeps `.git`, `.env*`, `storage/`, backups, dumps, tests and `node_modules` out of the build context. |
| `compose.yaml` | `db` (mariadb:11.4, internal network only), `app` (read-only root fs, `/tmp` tmpfs, `cap_drop: ALL`, `no-new-privileges`, storage volume), `proxy` (caddy:2.8-alpine, ports 80/443). Log rotation 20 MB × 5. |
| `deploy/caddy/Caddyfile` | `medworks.app` (HTTPS), `www.medworks.app` → 301 to the apex, on-demand TLS for clinic domains. |
| `deploy/mariadb/init/01-tenant-grants.sh` | First start only: lets the app user create and use `<DB_NAME>_*` clinic databases. |
| `deploy/.env.production.example` | Every production setting with comments. Real `.env` lives only on the server (mode 600). |
| `deploy/preflight.sh` | Refuses to deploy on: missing/short secrets, `.env` readable by others or tracked by git, http `APP_URL`, `DOMAIN`≠`APP_URL`, no backup passphrase, < 3 GB free, ufw inactive, DNS not pointing at `SERVER_IP`. |
| `deploy/deploy.sh [--first]` | Preflight → refuses uncommitted changes → backup → keeps the running image as `:previous` → build → start → waits for health → **automatic rollback** to `:previous` if unhealthy after 5 min. |
| `deploy/backup.sh` | Consistent dumps of every database + files volume, row counts, checksums, GPG AES-256 encryption, retention. |
| `deploy/restore.sh --verify|--production` | Test restore into a throw-away container, or full restore with a safety backup and typed confirmation. |
| `deploy/export-old-server.sh`, `deploy/import-migration.sh` | Moving the data from the current server (see `docs/DATABASE_MIGRATION_PLAN.md`). |
| `deploy/systemd/medworks-backup.{service,timer}` | Daily backup at 02:30 server time. |

## 3. Sizing (starting point, not a capacity claim)

No load test has been run, so no number of concurrent users is claimed. Starting point for the first clinics:
**Hostinger KVM 2 (2 vCPU, 8 GB RAM, 100 GB NVMe)** or larger, with `DB_BUFFER_POOL=2G`. Watch `docker stats`, the
database size and response times during the first weeks; a load test (k6 or autocannon against the staging stack) is
listed in `docs/KNOWN_ISSUES.md` before any capacity is promised.

## 4. Stages

| Stage | What | Status |
|---|---|---|
| A. Discovery | Architecture, feature inventory, security audit | Done (`docs/ARCHITECTURE_AUDIT.md`, `FEATURE_INVENTORY.md`, `SECURITY_AUDIT.md`) |
| B. Hardening | Production config validation, graceful shutdown, container-aware updater, TLS ask endpoint, `check-secrets`, privacy-rule fix, CSV-injection fix, export audit | Done in 2.9.52, with tests |
| C. Packaging | Dockerfile, compose, Caddy, scripts, systemd timer | Done, built and run locally |
| D. Verification | Build, health, HTTPS, headers, isolation, backup → restore, old-server export → import, restarts | Done locally (`docs/TEST_RESULTS.md`) |
| E. VPS deployment | Server setup, first deploy on a temporary hostname or IP, test data only | **Waiting for approval and VPS access** |
| F. Cut-over | Final export from the old server, import, DNS switch, monitoring | **Waiting for approval** (`docs/DATABASE_MIGRATION_PLAN.md`) |

## 5. Approvals needed before stages E–F

1. SSH access to the VPS (key-based, a non-root sudo user) — the password is never written into any file.
2. The VPS public IP, to put in `SERVER_IP` and the DNS records.
3. Permission to change DNS for `medworks.app` / `www.medworks.app` (A records → the VPS IP), at cut-over time.
4. Real secrets generated on the server, and where the operator keeps the off-server copy of `.env` and `BACKUP_PASSPHRASE`.
5. The old server's `APP_KEY` (or `SESSION_SECRET` when it never had one) — required so stored credentials keep working.
6. A maintenance window for the final export/import.
7. Off-server backup destination (another provider / object storage) — not configured yet.
