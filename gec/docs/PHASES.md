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
