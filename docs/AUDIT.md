# Implementation audit — DocBook clinic platform

DocBook is a clinic booking and management product. The server-rendered UX system (layouts, design tokens,
shell, command palette, dialogs, exports, charts, RBAC, audit) is shared infrastructure; the clinic business
logic is ported from the original DocBook source. Store/e-commerce functionality from the earlier
finance-hub prototype (sales orders, customers, purchases/COGS, delivery, marketing campaigns, partners,
budgets, Google Sheets, AI advisor) has been **removed** from code, schema, navigation and texts.

## 1. DocBook business logic preserved

| Rule | Where |
| --- | --- |
| Availability: weekday shifts + breaks, days off, slot step = doctor slot length, length = custom › service › doctor, real interval overlap, past dates refused, clinic time zone | `src/modules/clinic/scheduling.js` (unit-tested) |
| No double booking: MySQL named lock per doctor/date/time + re-validation inside the transaction | `scheduling.withSlot` (integration-tested with concurrent bookings) |
| Patient matching by exact phone within the clinic | `appointments.service.resolveOrCreatePatient` |
| Checkout: amount entered is net; original price and discount derived; sequential per-clinic invoice numbers | `money-rules.checkoutAmounts`, `appointments.service.checkout` |
| Voiding an invoice returns the visit to unpaid (audited with the full invoice) | `appointments.service.voidInvoice` |
| Commission: percentage / fixed per visit / fixed per patient, per-service overrides | `money-rules.commission` |
| Payroll: base + commission + approved bonuses − deductions − advances; four-eyes approval; paid months locked | `money-rules.payroll`, `payroll.service` |
| Supplies: low stock at `current_stock ≤ reorder_level`, alert raised once, supplier e-mailed | `supplies.service` |
| Clinical: vitals (nurse), SOAP + diagnosis (doctor), prescriptions, starter medication list | `clinical.service` |

## 2. Updates carried over from the reference system (v1.1)

- Editable landing page: section editor (add/move/toggle/duplicate/delete/reset, bilingual fields, header/footer/SEO, icon picker, safe links) for the platform super admin at `/admin/site`.
- Company portal → **clinic page** `/<address>`: clinic profile, doctors, services, online booking, and staff sign-in by role.
- Admin-generated password-reset links and staff accounts with temporary passwords (forced change at first login).
- Not carried over (HR-specific): QR attendance, jobs/talent/recruitment, pricing plans.

## 3. Roles and staff logins

| Role | Lands on | Scope |
| --- | --- | --- |
| Owner | Dashboard | Everything incl. deleting the clinic |
| Clinic manager | Dashboard | Everything except data restore/delete |
| Doctor | My day | Own schedule, own patients, clinical notes, prescriptions |
| Nurse | Front desk | Waiting room, check-in, vital signs, reads clinical records |
| Receptionist | Front desk | Bookings, calendar, check-in, payments |
| Accountant | Billing | Invoices, expenses, payroll, reports |

Custom roles can be built from the permission matrix. A doctor login is linked to exactly one doctor profile.

## 4. Decisions

- Expenses kept (generic clinic accounting, clinic categories).
- Online card payment is not included (no payment provider integration is configured); online bookings are pay-at-clinic.
- Suspended clinics are hidden from their staff and from the public.
- Arabic is the default language; English is complete.

## 5. Quality gates

- `npm test` — unit tests for the rules + integration tests (booking race, invoices, doctor scope, tenant isolation, payroll, staff logins).
- `npm run brand:check` — no foreign product names, no store vocabulary, no hard-coded colours.
- Every page crawled as owner, clinic manager, accountant, nurse, receptionist and doctor in both languages: no server errors, no untranslated keys, permission-denied pages return 403.
