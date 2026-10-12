# MedWorks / DocBook — Security Audit

| | |
|---|---|
| Date | 2026-10-12 |
| Code audited | `HEAD` 9de863a (v2.9.51) plus the uncommitted working tree present at audit time (changes to `src/app.js`, `src/config/index.js`, `src/server.js`, `src/modules/platformops/updates.web.js`; untracked `deploy/`, `Dockerfile`, `compose.yaml`). Line numbers refer to that working tree. |
| Method | Manual code review of the areas listed in the brief, targeted greps across `src/` (≈68k lines), runtime checks against a local MariaDB (`docbook_test_sec`), `npm audit --omit=dev`, existing tests, and a new HTTP-level cross-tenant test (`test/tenant-isolation.test.js`). |
| Out of scope | Infrastructure (hosting, TLS termination, OS, MariaDB config), the browser JS in `public/`, third-party services, penetration testing from the internet. |

**Bottom line.** No Critical or High issues were found. Tenant scoping is applied consistently, and every cross-clinic probe in the new HTTP test was refused with a 404. The most important issues are: a gap in the clinic's "record privacy" rule (SEC-01, reproduced at runtime), two-step sign-in that is optional and only offered to platform admins (SEC-02), unsigned in-app code updates (SEC-03) and 14-day rolling sessions (SEC-04). An item is listed as a finding only where there is code evidence for it. Items marked **Needs verification** were not confirmed.

---

## 0. Remediation status (2.9.52)

Each status below was checked by running the named test or command (`docs/TEST_RESULTS.md`).

| ID | Status | Change | Verification |
|---|---|---|---|
| SEC-01 | **Fixed** | `/patients/:pid/records` added to the privacy guard list (`src/modules/clinicalplus/web.js`) | `test/privacy-records.test.js` fails before the change, passes after |
| SEC-03 | **Mitigated for Docker** | The in-app updater refuses to install or restore when `MEDWORKS_CONTAINER=1` (`UPDATE_CONTAINER`, HTTP 409); the image filesystem is read-only. Code reaches the VPS only through `deploy/deploy.sh` from a git commit. Signing of update ZIPs for shared-host installs is still open | Local stack: app root filesystem is read-only |
| SEC-05 | **Mitigated** | `STRICT_CONFIG=true` (set in the image) refuses to start without `APP_KEY` ≥ 32 and a real `SESSION_SECRET`, so the fallbacks are never used in Docker | Local stack: start without `APP_KEY` → refused with `MISSING_ENV` |
| SEC-07 | **Fixed** | `src/core/exporter.js` writes `data.list_exported` (list, path, row count, format — no contents) for every CSV/Excel list export | `test/export-audit.test.js` fails before, passes after |
| SEC-10 | **Mitigated for Docker** | The image sets `NODE_ENV=production`; strict config refuses an insecure start | `Dockerfile`, `compose.yaml` |
| SEC-13 | **Fixed** | Bank CSV cells starting with `=`, `+`, `@`, tab, CR, or `-` followed by a non-number are prefixed with `'` (`src/modules/payouts/bank.service.js`) | `test/bank-csv-formula.test.js` |
| SEC-17 | **Mitigated for Docker** | The app's DB user has rights only on `DB_NAME` and `DB_NAME_*` (`deploy/mariadb/init/01-tenant-grants.sh`), not global | init script |
| SEC-20 (backup part) | **Fixed** | `deploy/backup.sh` uses GnuPG AES-256 with integrity protection; a changed file or wrong passphrase fails to decrypt | Local stack: wrong passphrase → `Bad session key`; edited manifest → refused |
| SEC-02, 04, 06, 08, 09, 11, 12, 14, 15, 16, 18, 19 | Open | Listed in `docs/KNOWN_ISSUES.md` with the recommended fix | — |

## 1. Findings summary

| ID | Title | Severity |
|---|---|---|
| SEC-01 | Clinical-record privacy rule is bypassed by the specialty records pages (`/app/patients/:id/records…`) | Medium |
| SEC-02 | Two-step sign-in is optional, only for platform admins; no MFA for clinic staff handling PHI | Medium |
| SEC-03 | In-app system update installs an unsigned ZIP of application code (platform admin account compromise = code execution) | Medium |
| SEC-04 | Sessions last 14 days and are rolling, with no idle or absolute timeout | Medium |
| SEC-05 | One secret drives session signing, credential encryption, TOTP secrets and clinic backups; the fallbacks are inconsistent | Low |
| SEC-06 | Legacy "Clinica" remote import: URL check has no DNS resolution, so internal hosts are reachable by name (SSRF, HTTPS only) | Low |
| SEC-07 | List exports of PHI (patients / appointments / billing CSV/XLSX) are not written to the audit log | Low |
| SEC-08 | Patient-portal sign-in does not regenerate the session ID, and shares the staff session cookie | Low |
| SEC-09 | Every anonymous page view creates a stored session row, and session listing scans the whole table | Low |
| SEC-10 | Stack traces are shown on error pages whenever `NODE_ENV` is not `production` (the default is `development`) | Low |
| SEC-11 | Logs and admin error e-mails can carry secret URL tokens and SQL values | Low |
| SEC-12 | Weak password policy (8 characters, no breach check); per-account lock-out can be triggered by anyone | Low |
| SEC-13 | Bank-transfer CSV export has no spreadsheet formula-injection guard | Low |
| SEC-14 | E-mail HTML viewer response has no CSP `sandbox` directive when opened directly | Low |
| SEC-15 | Multipart CSRF depends on each handler calling `verifyCsrfAfterUpload`; the allow-list has stale entries | Info |
| SEC-16 | Platform sales links (quote / invoice / document) store their tokens in plaintext | Info |
| SEC-17 | One database account with global privileges serves every clinic database | Info |
| SEC-18 | Public token links are looked up in every clinic database before any rate limit | Info |
| SEC-19 | Data sent to third parties (IP geolocation, AI provider, calendar feeds) | Info |
| SEC-20 | Backup restore trusts the business_id inside the file; the deploy backup script uses AES-CBC without a MAC | Info |

---

## 2. Findings

### SEC-01 — Clinical-record privacy rule bypassed by specialty records
- **Severity:** Medium. This is within one clinic, not cross-tenant.
- **Affected:** `src/modules/specialty/web.js:314, 354, 364` (and `:334` / POST `:347` for writes); the guard list in `src/modules/clinicalplus/web.js:62-64`.
- **Evidence:** When a clinic turns on "Only the treating doctor can open clinical notes" (`businesses.clinical_privacy`), `privacy.access()` must be checked before clinical pages open. `clinicalplus/web.js` applies that guard only to `/patients/:pid/dental`, `/pregnancy`, `/growth`, `/specialty/panel/:pid`, `/patient-docs/:aid` and `/visits/:aid/ai`. The specialty records routes check `can('clinical.view')` only, and `context()` (`specialty/web.js:47-55`) does not call `privacy.access`.
  Runtime check (scratch probe, not committed): with privacy ON, a **nurse** (role has `clinical.view`, no doctor link) was redirected away from `/app/patients/P/dental` (302, restricted). The same nurse got **200 and the record contents** from `/app/patients/P/records/spirometry/R` and from `/app/patients/P/records/spirometry`.
- **Fix:** Add `'/patients/:pid(\\d+)/records'` to the `guardPatient(false)` list in `clinicalplus/web.js`, or call `privacy.access` in `specialty/web.js` `recContext()`. Also call `privacy.log(...)` there.
- **Verify:** Add a case to `test/clinicalplus.test.js` "privacy rule…": nurse / non-treating doctor gets a redirect or 403 on the records URLs; the treating doctor and the owner get 200.

### SEC-02 — Two-step sign-in optional, platform admins only
- **Severity:** Medium
- **Affected:** `src/modules/auth/twofactor.service.js:1-4` (offered to platform admins); `src/modules/admin/web.js:20-21` (admin guard checks only `is_platform_admin`); no 2FA code path for clinic users.
- **Evidence:** TOTP is only set up from Admin → Settings. Nothing requires it for `is_platform_admin` accounts, even though those accounts can see every clinic, restore backups and install code (SEC-03). Clinic staff who read medical records have password-only sign-in, or Google.
- **Fix:** Require TOTP for every `is_platform_admin` account: block `/admin` until it is enrolled. Offer TOTP (or WebAuthn) to clinic members, with a per-clinic "require 2FA" setting for roles that hold `clinical.view`.
- **Verify:** A test that a platform admin without `totp_enabled_at` is sent to enrolment by `/admin/*`; a test for the per-clinic requirement.

### SEC-03 — Unsigned in-app code updates
- **Severity:** Medium
- **Affected:** `src/modules/platformops/updater.js:80-112` (validation), `src/modules/platformops/updates.web.js` (`/admin/updates/install`), `src/modules/platformops/system.web.js:7` (`/app/settings/system-update` for `is_platform_admin`).
- **Evidence:** The ZIP is checked for structure only: allowed top-level folders, no symlinks, no `node_modules`/`.env`, a "dist banner" in `app.js`, and the `package.json` name. There is no signature or checksum against a trusted publisher key, so any ZIP that passes these checks replaces the running application code.
- **Fix:** Sign release ZIPs (for example Ed25519 over the archive hash) and verify against a public key built into the app before staging. Require a fresh TOTP code (SEC-02) for the install action. Allow the feature to be turned off (`DISABLE_WEB_UPDATES=true`) on Docker deployments, which update by image.
- **Verify:** A unit test where a tampered or unsigned ZIP is refused with `UPDATE_SIGNATURE`.

### SEC-04 — Long rolling sessions
- **Severity:** Medium for a medical-records system.
- **Affected:** `src/app.js:84` (`rolling: true`), `src/app.js:89` (`maxAge: 14 * 86_400_000`).
- **Evidence:** Each request extends the cookie and the stored session by 14 days. There is no idle timeout and no absolute lifetime, so an unattended reception PC stays signed in indefinitely.
- **Fix:** Add an idle timeout (for example 30–60 minutes for staff, stored as `session.lastSeen` and checked in `loadUser`) and an absolute lifetime (for example 12 hours, from `session.since`, which `src/modules/auth/session.js` already sets). Keep a longer "remember this device" only by explicit choice.
- **Verify:** A test that a session older than the idle limit is sent to `/login`.

### SEC-05 — Key coupling and inconsistent fallbacks
- **Severity:** Low
- **Affected:** `src/core/secrets.js:9`, `src/modules/platformops/clinic-backup.js:36`, `src/config/index.js` (`sessionSecretOf`), `src/modules/telehealth/telehealth.service.js:131`.
- **Evidence:**
  - Without `APP_KEY`, credential encryption (SMTP/WhatsApp/gateway secrets, **TOTP secrets**) and clinic backups use `SESSION_SECRET`. Rotating the session secret after a compromise then makes stored TOTP secrets unreadable: `twofactor.check` gets `secret = null`, so admins are locked out except through recovery codes. It also makes every `.dbk` backup unreadable.
  - With neither variable set, `secrets.js` throws, so credentials and TOTP cannot be stored. `clinic-backup.js` instead uses the generated `.session-secret`. The two behave differently.
  - The uncommitted `productionProblems()` (`src/config/index.js`) warns about a missing `APP_KEY`, but only refuses to start with `STRICT_CONFIG=true`.
- **Fix:** Require `APP_KEY` in production, and refuse to start without it whenever stored credentials, TOTP or backups exist. Never derive the encryption key from `SESSION_SECRET`. Add key versioning (`v2:` prefix plus a key ID) so keys can be rotated.
- **Verify:** Boot with `NODE_ENV=production` and no `APP_KEY`: the app must refuse to start. A unit test where rotating `SESSION_SECRET` leaves `secrets.decrypt` working.

### SEC-06 — SSRF in legacy remote import (by host name)
- **Severity:** Low. It needs the `data.manage` permission and HTTPS, so `http://169.254.169.254` is not reachable.
- **Affected:** `src/modules/legacy/remote.service.js:35-45` (`baseOf`), with the `fetch` at `:64`.
- **Evidence:** Only literal private IPs, `localhost` and dot-less names are refused. A name that resolves to a private address (for example `127.0.0.1.nip.io`, or an internal DNS name) passes. `fetch` follows same-origin redirects with no lookup check. Every other outbound path (`core/http.js` `safeLookup`, `datasync.resolveHost`, `clinicmail.resolvePublic`) checks the resolved address.
- **Fix:** Resolve and pin the address the same way `datasync.service.js:198-210` does, or route requests through an undici `Agent` whose `connect.lookup` uses `core/http.isPrivateIp`.
- **Verify:** A unit test where `baseOf`/connect with a host resolving to `127.0.0.1` is refused (mock `dns.lookup`).

### SEC-07 — PHI list exports not audited
- **Severity:** Low
- **Affected:** `src/modules/clinic/patients.web.js:221` (patients CSV/XLSX with national ID, allergies and chronic conditions), `src/modules/clinic/appointments.web.js:269`, `src/modules/clinic/billing.web.js:88`, and the other `GET …/export` routes (`expenses`, `payroll`, `supplies`, `purchasing`, `attendance`). `src/core/exporter.js` writes no audit row.
- **Evidence:** These routes contain no `audit.record`. By contrast, the bulk ZIP download (`patients.web.js:156`), single-patient export (`patientexport/export.service.js:172`) and PDF downloads (`patientdocs/web.js:25`) are audited.
- **Fix:** Call `audit.record(req.ctx, '<area>.exported', { newValues: { rows, filters } })` in `exporter.send`, which every export uses.
- **Verify:** A test that `GET /app/patients/export` adds a `patients.exported` row.

### SEC-08 — Patient portal session fixation
- **Severity:** Low
- **Affected:** `src/modules/patientportal/web.js:89, 142, 164`.
- **Evidence:** Patient sign-in only sets `req.session.pp[clinicId]` on the existing session. There is no `req.session.regenerate`, unlike staff sign-in (`src/modules/auth/session.js:11`). The patient and staff identities share the `db.sid` cookie.
- **Fix:** Regenerate the session on patient login, and keep `pp` and the CSRF token as `signIn` does. Consider a separate cookie name and path for the portal.
- **Verify:** A test that the `db.sid` value changes after a successful `/<slug>/account/login`.

### SEC-09 — Anonymous sessions persisted; full-table session scans
- **Severity:** Low (resource exhaustion).
- **Affected:** `src/middleware/web.js:76` (sets `req.session.csrf` on every request), `src/app.js:79-90` (DB store, 14 days), `src/modules/auth/security.service.js:54-66` (`listSessions` / `endOtherSessions` load and parse **all** live sessions).
- **Evidence:** Runtime: an anonymous `GET /login` returns `Set-Cookie: db.sid=…; Expires=+14 days`, so a session row is stored for every cookie-less visit (bots included). Each password change or reset then reads and parses every row.
- **Fix:** Create the CSRF token only when a form is rendered for an anonymous visitor, or use a short `maxAge` until sign-in. Add a `user_id` column (or a side table) to `sessions` and filter on it in `listSessions`.
- **Verify:** Load test: N anonymous GETs give 0 new `sessions` rows; `listSessions` uses an index.

### SEC-10 — Stack traces outside production
- **Severity:** Low
- **Affected:** `src/middleware/errors.js:43`, `src/views/pages/error.ejs:7`, `src/config/index.js` (`env` defaults to `development`).
- **Evidence:** `stack: !config.isProd && !known ? err.stack : null`. A server started without `NODE_ENV` shows full stack traces. With `NODE_ENV=development` it also uses the public dev session secret, so sessions can be forged. The Docker files (uncommitted) set `NODE_ENV=production`, but shared-host installs may not.
- **Fix:** Show stacks only when `NODE_ENV==='development'` **and** the request comes from localhost. Default `env` to `production` when it is unset.
- **Verify:** Start without `NODE_ENV` and trigger a 500: no stack in the HTML.

### SEC-11 — Secrets and PHI in logs / alert e-mails
- **Severity:** Low
- **Affected:** `src/middleware/errors.js:21` (logs `req.originalUrl` and the whole error object), `src/core/error-alerts.js:18-19`.
- **Evidence:** Tokens sit in URL paths (`/reset/<token>`, `/d/<token>`, `/c/<token>`, `/invite/<token>`, `/calendar/<token>.ics`). The log line keeps them, and `mysql2` errors carry `.sql` with bound values (patient data) into stdout. The alert e-mail masks only digit runs of 4 or more, so base64url tokens pass through.
- **Fix:** Redact path segments longer than 16 characters of `[A-Za-z0-9_-]` and log `err.code`/`err.message` without `err.sql`.
- **Verify:** A unit test of the redaction helper; grep the logs after forcing an error on `/reset/<token>`.

### SEC-12 — Password policy and targeted lock-out
- **Severity:** Low
- **Affected:** `src/core/validate.js:21` (min 8, max 128), `src/modules/auth/auth.service.js:50-59` (10 failures per e-mail in 15 minutes → 429).
- **Evidence:** There is no check against breached or common passwords. Anyone who knows a staff e-mail can lock that account for 15 minutes, repeatedly; the only alternative is a password reset.
- **Fix:** Add a common/breached-password list (offline k-anonymity or a bundled top-100k list). Combine the per-account limit with per-IP limits and a progressive delay, or a CAPTCHA after N failures, instead of a hard lock.
- **Verify:** Unit tests on the validator; a lock-out test that a different IP with the correct password still succeeds after a CAPTCHA or delay.

### SEC-13 — Bank CSV formula injection
- **Severity:** Low
- **Affected:** `src/modules/payouts/bank.service.js:184` (`csvCell`).
- **Evidence:** Unlike `src/core/csv.js:5` and `src/core/xlsx.js:19`, `csvCell` does not neutralise leading `= + - @`. Employee names and references are typed by staff and the file is opened in Excel.
- **Fix:** Prefix `'` for text cells starting with `= + - @ \t \r`, but not for the amount and IBAN columns that banks parse.
- **Verify:** A unit test with a name `=HYPERLINK(...)`.

### SEC-14 — E-mail body viewer CSP
- **Severity:** Low
- **Affected:** `src/modules/mailbox/web.js:82-94`.
- **Evidence:** Raw HTML from received mail is served same-origin. Scripts are blocked (`default-src 'none'`) and the page embeds it in a sandboxed iframe (`views/pages/mailbox/message.ejs:23`). Opened directly (top-level), however, the response has no CSP `sandbox`, so `<meta http-equiv=refresh>` and phishing forms (`form-action 'none'` blocks submission, but not the display) render on the app's origin.
- **Fix:** Add `sandbox allow-popups allow-popups-to-escape-sandbox` to that CSP header. Require `Sec-Fetch-Dest: iframe`, or strip `<meta http-equiv>`.
- **Verify:** Request the URL directly; the CSP header contains `sandbox`.

### SEC-15 — Multipart CSRF pattern (Info)
- **Affected:** `src/middleware/web.js:139-158` (`MULTIPART_ROUTES`), `:162-177`.
- **Evidence:** For allow-listed paths the CSRF check is deferred to the handler. All current handlers were checked and call `verifyCsrfAfterUpload`; see §3. Two entries, `/app/settings/data/(restore|import)`, have no route. A future handler on a broad pattern (`/^\/app\/[a-z-]+\/import\/?$/`) that forgets the check would accept cross-site multipart POSTs.
- **Fix:** Remove the stale entries. Move CSRF verification into the shared `uploads.memory()` wrapper so it cannot be forgotten.

### SEC-16 — Plaintext sales-link tokens (Info)
- **Affected:** `src/modules/sales/sales.service.js:185, 222, 277`, `src/modules/sales/templates.service.js:134, 171`.
- **Evidence:** `quotes.token`, `platform_invoices.share_token` and document tokens are stored as issued (24 random bytes). Patient-facing links (share, telehealth, queue, kiosk, calendar, reset) store SHA-256 only.
- **Fix:** Store `sha256(token)`; keep an encrypted copy if the link must be shown again.

### SEC-17 — Shared all-privilege DB account (Info)
- **Evidence:** The test environment's `docbook@localhost` has `ALL PRIVILEGES ON *.*`. `src/db/tenant.js` reaches every clinic database (and the main database through views) with the same credentials. The `mysql` provisioning driver needs `CREATE DATABASE`. Clinic separation is therefore enforced only in application code. A SQL injection anywhere, if one existed, would reach all clinics.
- **Fix:** Use least-privilege grants (the app user gets DML only on `docbook%` databases; a separate provisioning user does DDL). For high-assurance tenants, use per-tenant DB users.

### SEC-18 — Token lookups fan out over every database (Info)
- **Affected:** `src/db/tenant.js:105-125` (`resolveBy` / `byParam`), used by `/verify/:code`, `/hooks/*/:key`, `/pay/*/:pid`, `/calendar/:token`.
- **Evidence:** An unknown token is looked up in each clinic database in turn, before the route's own rate limiter (for example `/verify` counts failures only inside `lookup`). With many clinic databases, random tokens multiply DB load.
- **Fix:** Keep a token-prefix → database index in the main database, or apply a per-IP limiter before `router.param`.

### SEC-19 — Third-party data flows (Info)
- `src/modules/platformcomms/activity.service.js:99`: when turned on, visitor IPs are sent to `ipwho.is`.
- `src/modules/ai/ai.service.js`: visit data goes to Anthropic, with names pseudonymised (`namePhrases`) and a clinic acknowledgement required.
- Calendar feeds (`/calendar/<token>.ics`) carry patient names into third-party calendar apps.
- These flows need DPAs/BAAs and patient notices. This is not a code defect.

### SEC-20 — Backup integrity notes (Info)
- `src/modules/platformops/clinic-backup.js:133-160`: `restore()` inserts table rows as they are in the file, without forcing `business_id = id`. This is safe today because files are AES-256-GCM authenticated and server-made (`seal`/`open`, `:39-53`) and restore is platform-admin only. Forcing `business_id` would be cheap defence-in-depth.
- `deploy/backup.sh:28` (uncommitted): `openssl enc -aes-256-cbc -pbkdf2` has no authentication tag; tampering is detected only by the separate `FILES.sha256`. Consider `age` or an HMAC over the archive.

---

## 3. Controls verified as present

| Area | Control | Evidence |
|---|---|---|
| Password hashing | bcrypt cost 12 (4 in tests); a dummy hash gives equal timing for unknown e-mails; legacy scrypt hashes are upgraded on login | `src/config/index.js:74`, `src/modules/auth/auth.service.js:9-29` |
| Login throttling | Per-IP limiter (30 per 15 min) on login/2FA/signup/forgot/reset/invite; per-e-mail lock-out after 10 failures, the same answer whether the account exists or not | `src/modules/auth/web.js:22`, `auth.service.js:38-65` |
| Password reset | 32-byte token stored as SHA-256, 60-minute expiry, every outstanding token used up on success, other sessions ended, 5 per hour, link built from `APP_URL` (no Host-header poisoning) | `src/modules/auth/security.service.js:11-52` |
| E-mail verification | 32-byte hashed token, 48 h, single use, e-mail must still match | `src/modules/auth/verify.service.js` |
| Admin-made reset links | Never shown on screen for platform admins, vendors, owners, accounts in other clinics, or accounts with more permissions than the requester (e-mailed instead) | `src/modules/businesses/business.service.js:331-372`; `test/security.test.js` |
| TOTP | RFC 6238, ±1 step, replay blocked by an atomic `totp_last_step` update, secret encrypted, 10 one-time hashed recovery codes, 5 wrong codes destroy the session; enforced on every sign-in path (`req.pending2fa` in `loadUser`) | `src/core/totp.js`, `src/modules/auth/twofactor.service.js:41`, `src/middleware/context.js:19`, `auth/web.js:44-57` |
| Google sign-in | `state`, `nonce`, PKCE S256, RS256 with JWKS, `iss`/`aud`/`exp`, `email_verified` required, one-time pending state, platform admins excluded | `src/modules/auth/google.service.js:84-196` (start/verify), platform admins refused at `:219`, `:241` |
| Session fixation (staff) | `req.session.regenerate` on every staff sign-in; new CSRF token | `src/modules/auth/session.js:11-21` |
| Logout / revocation | POST `/logout` (CSRF-protected) destroys the session; password change or reset ends other sessions; users can list and end sessions; disabled users are dropped on the next request | `auth/web.js:231`, `security.service.js:54-72`, `context.js:16-21` |
| Cookies | `httpOnly`, `SameSite=Lax`, `Secure: 'auto'` in production, named `db.sid` | `src/app.js:89`; runtime header check |
| CSRF | Per-session token, constant-time compare, on every non-GET; multipart verified after parsing | `src/middleware/web.js:160-177`; all upload routes reviewed |
| Security headers | CSP `script-src 'self'` (no inline scripts), `frame-ancestors 'none'`, `object-src 'none'`; HSTS `max-age=31536000; includeSubDomains`; nosniff; Referrer-Policy `no-referrer`; COOP/CORP | Runtime headers of `GET /login`; `src/app.js:39-55` |
| Trust proxy | Only loopback/link-local/private proxies by default; X-Forwarded-Host only from a local proxy | `src/config/index.js:64`, `src/middleware/web.js` `requestHost` |
| CORS | No `Access-Control-Allow-Origin` except `*` on the public booking widget script | `src/modules/discover/public.web.js:29` |
| Admin area | `/admin` gives 404 unless `is_platform_admin`; `is_platform_admin` is set only by the `SUPER_ADMIN_*` bootstrap (an existing account must prove the configured password) and forced to `false` on backup restore; no request-body path writes it | `src/modules/admin/web.js:20-21`, `auth.service.js:100-126`, `clinic-backup.js:154`, grep of `is_platform_admin` writes |
| Vendor portal | Requires sign-in plus a `vendor_users` row; suspended vendors refused | `src/middleware/vendor.js` |
| Clinic context | Clinic comes from the session but is re-checked against an **active membership** and an active clinic on every request; switching is checked with `isMember`; the request then runs in that clinic's database (ALS) | `src/middleware/context.js:45-70`, `auth/web.js:292-298`; new test (tampered session row) |
| Tenant scoping | `crud.repo` adds `business_id` to every read and write; id lookups in services and routes join on `business_id` (sampled: patients, appointments, visits, invoices, patient files, legacy attachments, patient docs, exports, reports, chat, orders, purchasing, supplies, telehealth, leave, chronic, insurance, website builder, media, articles, specialty, surgeries, expenses) | `src/core/crud.js:9-75`; e.g. `orders/orders.service.js:257-262`, `patients.web.js:243-251`, `billing.web.js:160-167`, `legacy/download.web.js:19-25`; greps found no request-id lookup without `business_id` outside `/admin` |
| SQL injection | All `raw`/`whereRaw` interpolations are code constants or `knex.raw(...).toString()` with bound values; no concatenated user input found | grep of `raw(\`…${` (29 hits reviewed) |
| XSS | EJS escapes by default; `<%-` used for helpers, includes and sanitised HTML (article renderer escapes first, `articles.service.js:41-89`; the website builder stores structured, cleaned values, `website/sections.js:336-416`); uploaded files served with `default-src 'none'`/`sandbox` CSP and nosniff | grep of `<%-`; download handlers |
| SSRF | `core/http.js` — HTTPS only, private/reserved ranges blocked, check inside the socket `lookup` (no DNS rebinding), redirects re-validated; datasync, mailbox and clinic SMTP resolve and pin public addresses; Sheets webhook limited to `script.google.com` | `src/core/http.js`, `datasync.service.js:198-225`, `clinicmail.service.js:141`, `sheets.service.js:273-280`, `test/security.test.js` |
| Uploads | multer size and count limits; magic-byte sniffing (`telehealth.sniff`, `legacy/files.typeOf`, `media.sniff`, `images.sniff`); no SVG accepted; storage quota | `src/core/uploads.js`, `orders/orders.service.js:219`, `legacy/files.js:45-58` |
| ZIP handling | `zipread` drops `..` and `.` segments, entry count and size caps, `inflateRawSync` `maxOutputLength`; legacy files stored by SHA-256 under a fixed root with a `startsWith(ROOT)` check; updater rejects symlinks, `node_modules`, `.env` and unknown top-level folders | `src/core/zipread.js:51-85`, `legacy/files.js:60-75`, `updater.js:88-96` |
| Path traversal | Backups: `basename` plus a strict name regex; bulk exports: name regex plus a per-clinic folder; legacy: `startsWith(ROOT + sep)` | `clinic-backup.js:121-125`, `patientexport/bulk.service.js:122-128` |
| CSV/XLSX injection | Leading `= + - @ \t \r` neutralised | `src/core/csv.js:5`, `src/core/xlsx.js:19` |
| Open redirects | `returnTo` must start with `/` and not `//`; `_return`/`return_to` limited to `/app…` or `/vendor/…` patterns; Referer-based "back" checks the host (`routes/helpers.js` `back`) | `auth/session.js:46`, `expenses/web.js:13`, `notifications/web.js:32` |
| Webhooks | WhatsApp: HMAC-SHA256 of the raw body with the clinic's app secret, constant-time; verify-token compare constant-time. PayTabs: signature check plus `tran_ref` match plus server-side `verify()`. `/hub-in`: Bearer secret, constant-time; `/hub/v1`: per-link key. SMS inbound: 32-byte random path key (no provider signature exists) | `messaging/hooks.web.js:28,37`, `messaging.service.js:633-638`, `payments.service.js:293-307`, `hub/inbound.web.js:19-26` |
| Public token links | Share `/d/` 24 bytes, hashed, 30-day expiry, revocable; telehealth `/c/` and message `/r/` 32 bytes hashed; queue and kiosk screens 24 bytes hashed; calendar 24 bytes hashed and active doctor/clinic only; `/verify` 16-character code (80 bits) and per-IP failure limit, patient name masked; invitations and centre invites 32 bytes hashed with expiry; public media needs `is_public` and a SHA prefix | files listed in §2 SEC-16 / SEC-18 and above |
| Secrets at rest | AES-256-GCM with an HKDF-derived key for stored credentials and TOTP; secrets masked in settings views; `.env`, `.session-secret` and `/storage/` git-ignored; no secrets tracked in git | `src/core/secrets.js`, `.gitignore`, `git ls-files` |
| Backups | Per-clinic `.dbk` = AES-256-GCM(gzip(JSON)), files `0600` in a `0700` folder, restore only by the platform admin and only to the matching clinic | `clinic-backup.js:11-53, 94-125` |
| Audit | `audit_logs` for create/update/delete through `crud.repo`, auth events, exports of a single patient, PDF downloads, file opens, privacy break-glass; sensitive keys scrubbed; per-view `record_access_log` for patient, visit, file and export | `src/core/audit.js`, `clinicalplus/privacy.service.js:66-75`, `orders/web.js:127-128` |
| Dependencies | `npm audit --omit=dev` → **found 0 vulnerabilities** (2026-10-12) | command output |
| Background jobs | Clinic jobs run through `tenant.eachDb` (main database, then each clinic database in its own ALS context); backups use `tenant.inClinic` | `src/server.js` `start()`; `src/db/tenant.js:93-97` |

---

## 4. Tenant isolation status

### Already proven by existing tests (all passed on `docbook_test_sec`: security, access, tenant-tables, tenant-db — 23/23)
- `test/tenant-db.test.js` (with separate databases): each clinic signs up into its own database; **concurrent requests of two clinics never mix** reads or writes; uploads and public pages use the clinic's database; a centre and its practices share one; a clinic moved out of the main database keeps all its rows; the databases admin page is admin-only.
- `test/tenant-tables.test.js`: every table is either shared or a clinic's own, never both.
- `test/security.test.js`: another clinic's service, doctor or insurance ids are refused when booking or saving a patient; an existing account is never attached by another clinic; backup restore touches one clinic only.
- `test/clinic-flow.test.js`, `appointments-move`, `leave`, `purchasing`, `orders`, `partners`, `insurance-claims`, `engage`, `frontdesk-intake`, `articles`, `integrations`, `attendance`, `payouts`, `owner`, `patient-profile`, `legacy-import`: service-level checks that another clinic's ids return `NOT_FOUND` or are ignored (about 45 test files mention cross-clinic cases).
- `test/access.test.js`: per-member page access inside one clinic. It is **not** a cross-tenant test.

### New: `test/tenant-isolation.test.js` (HTTP level, real app)
Two clinics. Clinic B's rows carry a unique marker. Clinic A's **owner** (all permissions in A) is signed in. A positive control confirms that B's own owner sees the marker, so a leak would be detected.

| Probe (A → B's id) | Result |
|---|---|
| `GET /app/patients/:id`, `/edit`, `/summary`, `/photo` | 404 |
| `GET /app/appointments/:id`, `/peek`; `GET /app/visits/:id`; `GET /app/visits/:id/prescriptions/:rx` | 404 |
| `GET /app/billing/:invoiceId` | 404 |
| `GET /app/patient-docs/:aid/prescription/:rx.pdf` | 404, no PDF |
| `GET /app/patients/:B/files/:fid` and `/app/patients/:A/files/:B_fid` | 404 |
| `GET /api/patients/:id/attachments/:aid/download` (legacy) | 404 |
| `GET /app/patients/:id/records`, `/app/orders/:id`, `/app/surgeries/:id`, `/app/supplies/orders/:id`, `/app/media/:id`, `/app/chat/:id/messages`, `/app/insurance-claims/:pid/export` | 404 |
| `POST /app/patients/:id/export` (whole-file ZIP) | 404, no archive |
| `POST` edit patient, appointment status and note, visit note, void invoice, edit expense, delete patient file, delete patient | 404 (delete patient: a refusal redirect to a page that is itself 404); **B's rows unchanged** |
| A's own lists, searches and exports (patients, appointments, billing, expenses, search, patient lookup, reports, media API) with a query matching B's rows | 200, **no B data** |
| `POST /workspaces/switch` to B | 403 |
| A's stored session row edited to `businessId = B` | Still clinic A only (resolveBusiness falls back to a membership) |

Run: `DB_NAME_TEST=docbook_test_sec NODE_ENV=test node --test test/tenant-isolation.test.js` → **9 tests, 9 pass, 0 fail.** No cross-tenant leak was found.

### Not proven by tests
- The new test runs with all clinics in the main database. The separate-database mode (`TENANT_DB_DRIVER`) is covered for patients only by `tenant-db.test.js`; the new probes were not repeated in that mode.
- Background jobs (`messaging`, `payments`, `telehealth`, `sheets`, `datasync`, legacy/transfer `resumeAll`) are not tested for running one clinic's work in another clinic's context — **Needs verification**.
- Medical-centre cross-practice access (`centerAdmin` / `actAs`, `center/shared.service.js`) beyond the existing centre tests.
- Public token routes are not tested for isolation against a guessed token from another clinic. Entropy makes guessing infeasible, but there is no test.
- Patient-portal cross-patient access (`fileOf` is scoped by `patient_id` in code; no dedicated test seen) — **Needs verification**.

---

## 5. Not assessed / requires formal review

- **HIPAA / GDPR / local health-data law compliance cannot be claimed on the basis of this review.** Compliance needs a formal risk assessment, policies, BAAs/DPAs with processors (hosting, e-mail, WhatsApp/SMS providers, PayTabs, Google, the AI provider, `ipwho.is`), breach procedures, data-subject rights processes and an independent audit.
- Encryption at rest: patient files (`patient_files.data` blobs, `storage/patient-attachments`) and the database are stored unencrypted by the application. Disk or database encryption depends on the deployment and was not assessed.
- Audit-log integrity and retention: `audit_logs` / `record_access_log` are ordinary tables that the app's DB user can modify. Tamper-evidence, retention and archive policy were not assessed.
- Infrastructure: TLS configuration, reverse proxy (`deploy/caddy`, `deploy/nginx` — uncommitted at audit time), firewalling of `/internal/tls-ask`, MariaDB hardening, OS patching, secrets management, backup storage location and restore testing.
- Client-side JavaScript in `public/js` (DOM XSS), the WebRTC telehealth call (signalling auth, TURN), and the Jitsi or external video links.
- Business-logic abuse (billing manipulation, payroll four-eyes rule beyond tests), denial of service and load limits, e-mail spoofing (SPF/DKIM of clinic domains).
- Penetration testing, fuzzing and authenticated dynamic scanning were not performed. GET routes with side effects were not exhaustively enumerated — **Needs verification**.

---

## 6. Recommended order of work
1. SEC-01 — add the privacy guard for `/patients/:pid/records` (`src/modules/clinicalplus/web.js:62`) plus a test.
2. SEC-02 — make TOTP mandatory for platform admins (`src/modules/admin/web.js:20`, `src/modules/platformops/system.web.js:7`); offer it to clinic staff.
3. SEC-03 — verify signatures on update ZIPs (`src/modules/platformops/updater.js`) and require a fresh TOTP code to install.
4. SEC-04 — idle and absolute session timeouts (`src/app.js:79-90`, `src/middleware/context.js` `loadUser`).
5. SEC-05 / SEC-10 — require `APP_KEY` and `NODE_ENV=production` at boot (`src/config/index.js`, `src/core/secrets.js`, `src/modules/platformops/clinic-backup.js:36`, `src/middleware/errors.js:43`).
