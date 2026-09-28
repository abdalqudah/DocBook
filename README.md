# DocBook

Clinic booking and management — appointments, online booking, front desk, patient records, prescriptions,
invoices, doctor payroll, supplies and staff logins by role. Arabic (RTL, default) and English (LTR), light/dark
theme, mobile first.

## Features

| Area | What it does |
| --- | --- |
| Appointments | Day calendar per doctor, booking with live free-slot picker, time blocks, follow-ups, rescheduling with conflict checks (MySQL named lock, no double booking) |
| Online booking | Public clinic page `/<clinic-address>` with doctors, services and a booking flow using the same availability engine; bookings arrive as *pending* with a staff notification |
| Front desk | Today's board: expected → waiting room → with doctor → paid; check-in, call-in, checkout with discount, insurance and payment method; numbered invoices |
| Clinical | Visit page with vital signs (nurse), SOAP note and diagnosis (doctor), prescriptions with printable Rx |
| Patients | Records with allergies/chronic conditions, insurance, full timeline |
| Billing & reports | Invoices, voiding with audit trail, revenue by doctor/service/method, no-show rate, expenses and net |
| Doctor payroll | Commission rules (percentage / per visit / per patient, per-service overrides), bonuses/deductions/advances with four-eyes approval, payslips |
| Supplies | Items, suppliers, stock movements, low-stock alerts (and supplier e-mail when SMTP is configured) |
| Staff & logins | Doctor, nurse, receptionist, accountant, clinic manager and custom roles; invite by e-mail or create with a temporary password (forced change at first login); admin-generated reset links; staff sign-in from the clinic page by role |
| Platform | Editable landing page (section editor for the platform super admin), multi-clinic accounts, audit log, data export |

## Requirements

- Node.js ≥ 20
- MySQL 8 or MariaDB 10.6+

## Setup

```bash
cp .env.example .env        # fill in DB_* and SESSION_SECRET
npm install
npm run migrate             # or AUTO_MIGRATE=true
npm start                   # http://localhost:3000
```

To manage the public landing page, set `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` before the first start; the
account is created at boot (an existing account is only flagged, its password is never changed). Then open `/admin`.

## Brand & theme

Everything visual comes from `src/config/brand.js` (name, tagline, logo, favicon, fonts, light/dark palettes) and is
served as CSS custom properties at `/theme.css`. Views and stylesheets use tokens only — `npm run brand:check`
fails on hard-coded colours or foreign product names. Each clinic can set its own accent colour and logo in
Settings → Appearance.

## Tests

```bash
npm test                    # unit tests + integration tests against DB_NAME_TEST (docbook_test)
npm run brand:check
```

## Project layout

```
src/
  config/          environment + brand
  core/            errors, validation, i18n, audit, CRUD repo, exports (CSV/XLSX), charts, mailer
  middleware/      locals/CSRF, auth + clinic context, errors
  modules/
    clinic/        scheduling engine, money rules, doctors, appointments, clinical, payroll, supplies (+ web routers)
    auth/ businesses/ rbac/ settings/ onboarding/ notifications/ expenses/ support/ site/ admin/
  locales/{ar,en}/ one JSON file per area
  views/           EJS layouts, partials and pages
public/            css, js (no inline scripts — strict CSP), icon sprite
test/              node:test suites
```
