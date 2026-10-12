# MedWorks — Known Issues and Open Items

Severity follows `docs/SECURITY_AUDIT.md`. "Owner decision" = needs a product/operations decision before changing,
because the fix changes how people use the system.

## Security (open)

| ID | Severity | Issue | Recommended fix | Why not done now |
|---|---|---|---|---|
| SEC-02 | Medium | Two-step sign-in is optional and only for platform admins; clinic staff have none | Offer TOTP to all users; let a clinic owner require it for their staff | Owner decision (changes sign-in for every clinic) |
| SEC-04 | Medium | Sessions are 14-day rolling, no idle/absolute timeout | Idle timeout (30–60 min) + absolute lifetime (12 h) with an opt-in "remember this device" | Owner decision (reception PCs would be signed out during the day) |
| SEC-03 | Medium (shared hosts) | Update ZIPs are not signed | Sign release ZIPs and verify before install | Disabled in Docker already; affects only non-Docker installs |
| SEC-06 | Low | Legacy remote import resolves host names without a private-address check | Resolve and refuse private addresses before connecting | Scheduled after deployment |
| SEC-08 | Low | Patient-portal sign-in keeps the session ID | `req.session.regenerate()` at portal sign-in | Scheduled after deployment |
| SEC-09 | Low | Anonymous page views create session rows | `saveUninitialized: false` + check the CSRF flow for anonymous forms | Needs a regression pass on every public form |
| SEC-11 | Low | Logs and admin error e-mails may contain URL tokens / SQL values | Redact `token`-like path segments and query values in the logger | Scheduled |
| SEC-12 | Low | Password minimum 8, no breach check; account lock-out can be triggered by others | 10–12 minimum, per-IP + per-account throttling instead of hard lock | Owner decision |
| SEC-14 | Low | Direct opening of the e-mail HTML viewer lacks CSP `sandbox` | Add `sandbox` to that response's CSP | Scheduled |
| SEC-15, 16, 18, 19 | Info | See the audit | — | — |

## Operations

| Item | Detail | Next step |
|---|---|---|
| Not deployed | Nothing runs on the VPS yet; no DNS change, no certificates | Runbook `docs/VPS_PREPARATION_CHECKLIST.md` (gates STOP A–E) |
| One app process only | Background jobs run inside the web process with no inter-process lock (`src/server.js`) | Keep one `app` container. Before scaling out: a DB-lock per job or a separate worker |
| Off-server backups: destination not chosen | `deploy/offsite.sh` (rclone or rsync, verified copies, nightly after the backup) is ready and tested locally; no destination account exists yet | Choose a provider and run `deploy/offsite.sh test` (checklist §10) |
| Setup-error page is public | With a bad configuration the app answers every request with a 503 page naming the missing setting (never its value) until fixed | Info only; it never happens with `preflight.sh` passing |
| No load test | No capacity figure can be stated | Run k6/autocannon against a staging copy with realistic data; size the VPS from it |
| No external monitoring | Health check is local (Docker) | Add an uptime monitor on `https://medworks.app/healthz` and disk/memory alerts |
| Image pull limits | Docker Hub anonymous pulls are rate-limited | `docker login` on the VPS (free account) if builds hit HTTP 429 |
| Main DB rename with clinic DBs | Handled: the import rewrites the clinic databases' schema references to the new main name (tested) | None; keeping the old `DB_NAME` also works |
| MySQL 8 → MariaDB | `utf8mb4_0900_ai_ci` collations do not exist in MariaDB | `import-migration.sh --fix-mysql8-collation` |

## Product gaps found in the inventory (not regressions)

From `docs/FEATURE_INVENTORY.md`: vouchers are not present; accounting, campaigns, customer communications and
support are partial; there are no dedicated pharmacist / lab roles (custom roles can be used). None of these were
changed by the VPS work.

## Compliance

No HIPAA, GDPR or local health-data compliance is claimed. The audit lists controls that exist (access control, audit
log, encryption of stored credentials and backups, TLS); a formal assessment (data-processing agreements, retention
policy, breach procedure, data residency, risk assessment) has not been done.
