# MedWorks — Production Readiness

**Verdict: the deployment package is ready to install on the VPS; MedWorks is not live on the VPS and is not
declared production-ready there until it has been deployed, checked and backed up on the real server.**

Status of each acceptance item, with where the evidence is. PASS = run and verified; BLOCKED = needs access or approval;
NOT TESTED = not run.

| Area | Item | Status | Evidence |
|---|---|---|---|
| Features | Every existing module, route and screen kept | PASS | No feature removed; full test suite (`docs/TEST_RESULTS.md`); inventory `docs/FEATURE_INVENTORY.md` |
| Build | Image builds from a clean checkout | PASS | Local Docker build, 361 MB |
| Build | Unit/integration tests | PASS | `npm test` (see TEST_RESULTS) |
| Config | Refuses to start with missing/weak secrets | PASS | Start without `APP_KEY` → refused |
| Runtime | Non-root, read-only root fs, no capabilities, DB not published | PASS | `docker inspect`, `id` in the container |
| Runtime | Health check, restart after crash, sessions survive restarts | PASS | Kill of node → restarted, healthy |
| Runtime | Graceful shutdown | PASS | `SIGTERM: shutting down` in the log on restart |
| HTTPS | HTTP→HTTPS, www→apex, HSTS, CSP, secure cookies | PASS (local CA) | Local Caddy with internal certificates |
| HTTPS | Let's Encrypt certificates for medworks.app | BLOCKED | Needs the VPS and DNS |
| Tenancy | Cross-clinic access refused | PASS | `test/tenant-isolation.test.js` 9/9 |
| Security | Privacy-rule bypass fixed; exports audited; CSV injection fixed | PASS | Tests fail before / pass after |
| Security | Medium items SEC-02/SEC-04 | OPEN | Owner decision (`docs/KNOWN_ISSUES.md`) |
| Backup | Encrypted backup + verified restore + production restore | PASS (local) | TEST_RESULTS |
| Backup | Scheduled on the VPS; off-server copy | BLOCKED | Needs the VPS and a destination |
| Migration | Old-server export → import, row counts and files identical, credentials readable | PASS (synthetic data) | TEST_RESULTS |
| Migration | Real production data | BLOCKED | Needs approval, old-server access and a maintenance window |
| Rollback | Automatic rollback on unhealthy deploy; manual image and data rollback | PASS (script paths tested: unhealthy start, restore) | `deploy/deploy.sh`, ROLLBACK_GUIDE |
| Capacity | Concurrent users | NOT TESTED | No load test; no figure is claimed |
| Monitoring | External uptime / alerts | NOT TESTED | Not configured |
| Compliance | HIPAA / GDPR | NOT ASSESSED | No claim made |

## Go-live checklist (on the VPS)

1. `docs/VPS_DEPLOYMENT_GUIDE.md` sections 1–8 → `docker compose ps` all healthy.
2. Migration rehearsal (`docs/DATABASE_MIGRATION_PLAN.md`) → counts/files/credentials OK.
3. Backup timer enabled; `deploy/backup.sh` + `deploy/restore.sh --verify` OK; off-server copy configured.
4. DNS switch → certificates issued → checks in guide §9.
5. Uptime monitor on `/healthz`.
6. 24–48 h observation (errors in `docker compose logs app`, memory, disk) before announcing.
