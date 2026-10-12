# MedWorks — Test Results (2.9.52)

Date: 2026-10-12. Environment: the development container (Node 22, MariaDB on localhost for `npm test`) and a local
Docker Engine running the real `compose.yaml` stack (with a test override that uses Caddy's internal CA for the
hostname `medworks.test`, because public certificates need a real domain). **Nothing below ran on the Hostinger VPS.**

Only synthetic data was used (`docbook_test` and databases created for these tests). No real patient data.

Status: PASS = run and the result checked; FAIL = run and failed; BLOCKED = cannot run here; NOT TESTED = not run.

## 1. Automated test suite

| Check | Status | Evidence |
|---|---|---|
| `npm test` (full suite) | PASS | 684 tests: 683 pass, 0 fail, 1 skipped (pre-existing skip), exit 0 |
| `npm run brand:check` | PASS | no old brand name in `src/` or `public/` |
| `npm run build:editions` | PASS | platform, update, clinic and centre editions built; `update-2.9.52.zip` inspected: version 2.9.52, 981 files, no `.env`. (First run failed: the new deploy files reached the single-clinic source edition with the platform name; they are now excluded from clinic editions.) |
| `npm audit` | PASS | 0 vulnerabilities (earlier in this audit) |
| New: `test/tenant-isolation.test.js` | PASS | 9/9 cross-clinic probes refused (404) |
| New: `test/privacy-records.test.js` | PASS | fails without the SEC-01 fix, passes with it |
| New: `test/export-audit.test.js` | PASS | fails without the SEC-07 change, passes with it |
| New: `test/bank-csv-formula.test.js` | PASS | formula-like cells neutralised, numbers unchanged |
| New: `test/secrets-check.test.js` | PASS | right key → readable; other key → exit 1, values never printed. (First version depended on test order; fixed.) |

## 2. Container build and runtime (local Docker)

| Check | Status | Evidence |
|---|---|---|
| Image builds (`Dockerfile`, final 2.9.52 code) | PASS | 361 MB; version inside `2.9.52` |
| Clean database: all migrations applied at first start | PASS | 132 rows in `knex_migrations` |
| Health check | PASS | `docker compose ps` → healthy; `/healthz` → `{"status":"ok"}` |
| Runs as non-root | PASS | `id -u` → 1000 |
| Root filesystem read-only, storage writable | PASS | `touch /app/x` → Read-only file system; `/app/storage` writable |
| `cap_drop ALL`, `no-new-privileges` | PASS | `docker inspect` |
| Database not published | PASS | `docker compose port db 3306` → nothing bound; app has no published ports |
| Strict config refuses insecure start | PASS | start without `APP_KEY` → `MISSING_ENV`, container not healthy |
| In-app updater refused in container | PASS | `UPDATE_CONTAINER` (409) on install/restore |
| Restart (`docker compose restart app`) | PASS | healthy again; log shows `SIGTERM: shutting down` |
| Crash recovery (node process killed) | PASS | `RestartCount` 0 → 1, healthy again |
| `docker compose down` / `up` keeps data | PASS | patients count and storage files unchanged |
| `docker kill` | INFO | Docker treats it as a manual stop (no auto-restart) — expected Docker behaviour |

## 3. HTTPS and headers (Caddy, local CA)

| Check | Status | Evidence |
|---|---|---|
| HTTP → HTTPS | PASS | `308 → https://medworks.test/` |
| www → apex | PASS | `301 → https://medworks.test/` |
| HSTS | PASS | `max-age=31536000; includeSubDomains` |
| CSP, `X-Content-Type-Options`, `X-Frame-Options` | PASS | present |
| Session cookie | PASS | `HttpOnly; Secure; SameSite=Lax` |
| `/internal/tls-ask` from the internet | PASS | 404 (blocked at the proxy) |
| `/internal/tls-ask` on the private network | PASS | platform domain → 200; unknown domain → 404 |
| Let's Encrypt certificate for medworks.app | BLOCKED | needs the VPS and DNS |
| Caddyfile syntax | PASS | `caddy validate` |
| Nginx alternative (`deploy/nginx/medworks.conf`) | NOT TESTED | provided as a fallback only |

## 4. Backup and restore

| Check | Status | Evidence |
|---|---|---|
| `deploy/backup.sh` (encrypted) | PASS | dumps + files + ROWCOUNTS + MANIFEST; 7 s on the test data |
| `deploy/restore.sh --verify` | PASS | 357 tables' row counts identical; files identical; temporary container removed |
| Tampered backup detected | PASS | edited manifest/file → refused |
| Wrong `BACKUP_PASSPHRASE` | PASS | `gpg: decryption failed: Bad session key` |
| `deploy/restore.sh --production` | PASS | a deleted synthetic patient came back; app healthy afterwards |
| Restore ordering bug (main DB dropped before clinic DBs) | FIXED | first run failed on a cross-database foreign key; fixed (clinic DBs dropped first) and re-run PASS |
| Scheduled backup (systemd timer) | NOT TESTED | needs the VPS (no systemd in this container) |

## 5. Migration from the old server

| Check | Status | Evidence |
|---|---|---|
| `export-old-server.sh` (encrypted) | PASS | single DB: 218 tables, 2 files; with clinic DB: 2 databases |
| `import-migration.sh`: refuses non-empty targets; refuses without the passphrase | PASS | `Database medworks already has 218 tables … never overwrites data`, exit 1; missing `EXPORT_PASSPHRASE` → refused |
| Import, single database | PASS | 218 tables identical, 2 files identical, app healthy |
| Import with a clinic database and a renamed main DB (`mwold` → `medworks`) | PASS | 357 tables identical; 77 views and 181 foreign keys point at `medworks`, none at the old name |
| Clinic owner signs in after import and sees the migrated patients | PASS | `/app/patients` lists both synthetic patients over HTTPS |
| Wrong `APP_KEY` detected | PASS | `check-secrets` → 1 NOT readable → import stops before starting the app |
| Right `APP_KEY` (old `SESSION_SECRET`) | PASS | `OK: every stored credential is readable` |
| Piped confirmation swallowed by docker (bug) | FIXED | operator answers now read from a saved stdin; re-run PASS |
| Real production data | BLOCKED | needs approval and old-server access |

## 6. Deploy and rollback

| Check | Status | Evidence |
|---|---|---|
| `deploy/deploy.sh` with a broken release | PASS (after fix) | first run: `compose up` failed and the script stopped **before** rolling back (bug). Fixed; re-run: backup taken → broken image unhealthy → rolled back to `:previous` → healthy, exit 1 with message |
| `deploy/preflight.sh` on the VPS | BLOCKED | needs the VPS (DNS, ufw) |
| `deploy/deploy.sh --first` on the VPS | BLOCKED | needs the VPS |

## 7. Security

| Check | Status | Evidence |
|---|---|---|
| Tenant isolation over HTTP | PASS | `test/tenant-isolation.test.js` |
| List exports audited (in container) | PASS | `data.list_exported` row in the clinic database: list, path, rows, format — no contents |
| No secrets in the repository | PASS | `.env*` ignored; `.dockerignore`; image has no `.env` |
| Penetration test | NOT TESTED | not in scope of this environment |

## 8. Performance

| Check | Status | Evidence |
|---|---|---|
| Load test / concurrent users | NOT TESTED | no figure is claimed |

## 9. VPS preparation stage (2026-10-12, local Docker copy of the stack; the VPS itself was not reachable)

| Check | Status | Evidence |
|---|---|---|
| SSH to 187.7.75.192 from the build environment | BLOCKED | TCP 22 does not connect; the egress proxy refuses the IP on 80/443 (403). No server state was observed or changed |
| DNS of medworks.app | NOT TESTED | No DNS resolution available in the build environment |
| `update-2.9.52.zip` integrity | PASS | `unzip -t` no errors; SHA-256 `1ca1e323d08b4aa6f6a23946eb1894d2b65bc3ce23923716def5385ad66a8dfa`; `inspectZip` → version 2.9.52, 981 files |
| Zip matches the release commit | PASS | Clean checkout of `351fa00` rebuilt: all 981 files byte-identical to the zip (first attempt differed only because of a symlinked `node_modules` path; repeated with a real copy) |
| `deploy/init-env.sh` | PASS | `.env` mode 600, six distinct 48-character secrets, same keys as the template, no secret in its output, refuses without an IP and refuses to overwrite an existing `.env` |
| `preflight.sh --before-dns` | PASS | 0 problems with an unresolvable domain (information line); without the flag the same domain is a problem |
| Preflight bug: unresolvable domain | FIXED | `getent` exit 2 under `set -e` ended preflight silently with no DNS line or summary; now reported |
| Preflight catches an exposed database | PASS | `ports: ["3306:3306"]` added to `db` → `✗ unexpected published ports: db 0.0.0.0 3306 tcp`; removed → ✓ |
| Preflight catches `.env` mode 644 | PASS | `✗ .env is readable by others (644)` |
| `deploy.sh --first` with an existing database volume | PASS | refused: `--first is only for an empty server …` |
| `deploy.sh --first --no-proxy` on an empty server | PASS | no backup; image built; volumes `medworks_db_data`, `medworks_app_storage` only (no Caddy volumes); `db` and `app` healthy; only host listener `127.0.0.1:8080`; no proxy container; `Healthy. Version: 2.9.52` |
| Sign-up through the loopback port (SSH-tunnel path) | PASS | synthetic clinic created with its own database `medworks_synthetic_test_clinic` (grants script works on a fresh volume) |
| `deploy.sh --no-proxy` update with data | PASS | backup of both databases first, `:previous` kept, healthy, still no Caddy |
| `deploy.sh` (go-live) while the domain does not resolve | PASS | refused by preflight |
| Go-live switch (preflight stubbed locally) | PASS | backup, Caddy started on 80/443, preview port 8080 removed, `/healthz` ok over HTTPS |
| Pre-DNS mode kept by backup / restore | PASS | after `backup.sh` and `restore.sh --production` the app still has only `127.0.0.1:8080`, Caddy not started |
| `import-migration.sh … --no-proxy` | PASS | 357 tables identical; Caddy not started; migrated clinic owner signs in through the loopback port and sees the patients |
| Off-server copy, rsync backend | PASS | `test` OK; 6 encrypted backups sent and checksum-verified; second push sends 0 |
| Off-server copy, rclone backend (local remote) | PASS | `test` OK; push verified; a byte changed at the destination was detected and re-sent |
| Tampered off-server copy fetched back | PASS | `pull` refuses: `The fetched copy does not match its manifest` |
| Lost-server restore from the off-server copy | PASS | local backup deleted → `pull` → `restore.sh --verify`: all 357 tables match, synthetic patients counted |
| Off-server push without `OFFSITE_TARGET` | PASS | warning, exit 0 (nightly backup unit does not fail) |
| Strict environment validation (`APP_KEY` empty) | PASS | `/healthz` and every page 503 `setup_error`, no application served; process exits after 60 s (exit 1) |
| Real provider for off-server storage | BLOCKED | needs an account (STOP C) |
| Commands on the VPS (runbook) | NOT TESTED | to be run by the operator: `docs/VPS_PREPARATION_CHECKLIST.md` |
