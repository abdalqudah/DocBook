# Changelog

## 2.9.52 — VPS readiness (Docker deployment package)

No feature, route, screen or report was removed or changed in behaviour, except the items marked **Security**.

### Added
- Docker deployment: `Dockerfile` (two stages, Node 22, non-root, health check), `.dockerignore`, `compose.yaml`
  (app + MariaDB 11.4 on an internal network + Caddy with automatic HTTPS and on-demand certificates for clinic
  domains), `deploy/caddy/Caddyfile`, `deploy/nginx/medworks.conf` (alternative), `deploy/mariadb/init/`.
- Operations scripts: `deploy/preflight.sh`, `deploy/deploy.sh` (backup before update, automatic rollback to the
  previous image when unhealthy), `deploy/backup.sh` (every database + files, row counts, checksums, GnuPG AES-256),
  `deploy/restore.sh --verify | --production`, `deploy/export-old-server.sh`, `deploy/import-migration.sh`,
  `deploy/systemd/medworks-backup.{service,timer}`, `deploy/.env.production.example`.
- `node app.js check-secrets` / `npm run check-secrets`: confirms stored credentials decrypt with the current APP_KEY.
- `GET /internal/tls-ask` (private network only) for Caddy's on-demand certificates.
- Production configuration check (`productionProblems`): with `STRICT_CONFIG=true` the app refuses to start on missing
  or weak secrets, a non-https `APP_URL`, missing DB credentials or `TRUST_PROXY=false`; otherwise it warns.
- Graceful shutdown on SIGTERM/SIGINT (stops accepting, closes idle connections, exits within 15 s).
- Documentation: `docs/ARCHITECTURE_AUDIT.md`, `FEATURE_INVENTORY.md`, `SECURITY_AUDIT.md`, `DEPLOYMENT_PLAN.md`,
  `DATABASE_MIGRATION_PLAN.md`, `TEST_RESULTS.md`, `KNOWN_ISSUES.md`, `PRODUCTION_READINESS.md`,
  `VPS_DEPLOYMENT_GUIDE.md`, `ROLLBACK_GUIDE.md`, `BACKUP_AND_RESTORE.md`, `ENVIRONMENT_VARIABLES.md`.
- Tests: `tenant-isolation`, `privacy-records`, `export-audit`, `bank-csv-formula`, `secrets-check`.

### Security
- The clinic's record-privacy rule now also covers the specialty-records list page (`/app/patients/:id/records`).
- CSV/Excel list exports are written to the clinic's audit log (`data.list_exported`: list, row count, format).
- Bank-transfer CSV cells that start like a spreadsheet formula are written as text.
- The in-app system updater is disabled inside the Docker container (updates go through `deploy/deploy.sh`).

### Changed
- `npm run build` accepts `BUILD_NO_ZIP=1` (used by the Docker build).
