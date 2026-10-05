# GEC Platform — Audit & Architecture Plan

Date: 2026-10-05 · Scope: the supplied GEC website source (`gec-_-global-education-consultants.zip`), the GEC brand
assets (4 logo files) and the DocBook codebase in this repository (the reference CRM/booking architecture).

---

## 1. What was supplied

### 1.1 GEC website (zip)

| Item | Finding |
| --- | --- |
| Stack | Google AI Studio export: React 19 + Vite 6 + Tailwind 4 + lucide-react + motion. `express`, `@google/genai`, `jszip` are dependencies but **no server code exists**. |
| Routing | A single `App.tsx` with a `currentPage` state switch. **No URLs** — every page is `/`. No deep links, no back button, no shareable pages. |
| Pages (13) | Home, Study in USA, Destinations, Universities, Programs, Services, Scholarships, Visa guidance, About, Events, Resources, Contact, and a *WordPress Theme Hub*. |
| Components | Navbar (46 KB), Footer, ConsultationModal (3-step form), CostCalculatorModal (US only), UniversityCompareModal (max 3), GlobalSearchModal (Ctrl/Cmd+K, client-side over arrays), StudyFinder, WhatsApp floating button, GecLogo (SVG re-drawing of the cap). |
| Data | All content is TypeScript arrays: 6 universities, 6 programs, 6 scholarships, 15 destinations + US-state profiles, events/testimonials/articles/FAQs, 12 services, 39 KB of translations. |
| i18n | Arabic/English with RTL/LTR switching, but texts are mostly inline `isArabic ? … : …` ternaries (≈ 560 of them) rather than a dictionary. |

### 1.2 Brand assets

Horizontal logo (cap + **GEC** serif wordmark + rule + "Global Education Consultants"), stacked logo, and white
versions of both. Colours sampled from the logo and the existing CSS tokens:

| Token | Value | Source |
| --- | --- | --- |
| Primary (forest) | `#0B4D2C` | cap top / sub-line / rule |
| Primary strong | `#063A20` | cap shadow |
| Primary bright | `#0E6B3D` | cap highlight |
| Ink | `#0A0F0C` | the black **GEC** wordmark |
| Accent (lime) | `#84CC16` | existing `--color-brand-lime` |
| Surface tint | `#F4FAF5` | existing `--color-brand-light-bg` |
| Typography | Serif display (wordmark), Plus Jakarta Sans (Latin UI), IBM Plex Sans Arabic (Arabic UI) | existing `index.css` |

### 1.3 DocBook (this repository)

A production clinic SaaS: Express 4 + EJS server rendering + Knex/MySQL migrations, sessions in MySQL, strict CSP
(no inline scripts), CSRF tokens, rate limits, bcrypt, zod validation, AES-GCM encrypted credentials, RBAC with
permission catalog, audit log with old/new values, SMTP mailer, CSV/XLSX export, Arabic/English JSON dictionaries.
It is deeply multi-tenant (one database per clinic), so its modules cannot be dropped into GEC as-is — but its **core
patterns are proven** and are reused here.

---

## 2. Audit findings — GEC website

### Architecture
* **No backend at all.** Every form (`ConsultationModal`, `ContactPage`, `StudyFinder`) only sets `isSubmitted=true`;
  nothing is stored or sent. Leads submitted today are lost unless the visitor also taps WhatsApp.
* SPA without routing or SSR: search engines see one URL with an empty `<div id="root">`. No per-page titles,
  canonical URLs or structured data.
* Business data hard-coded in arrays; no admin can edit anything without a developer.

### Incomplete / broken flows
* Shortlist and compare are React state only — lost on refresh, not tied to a person.
* **Bug:** the initial shortlist/compare ids are `iit-chicago` and `depaul-chicago`, which do not exist in
  `universities.ts` (`illinois-tech`, `depaul-university`) — the compare modal opens empty with a "2" badge.
* Cost calculator is USA-only with fixed constants, cannot be saved or sent to a student.
* Global search searches 6 universities client-side; it cannot scale beyond a few hundred records.
* Events have "Register" buttons with no registration.
* `@google/genai` is listed but unused; `GEMINI_API_KEY` is described as needed for a feature that does not exist.

### Dead / out-of-scope code (≈ 245 KB, ~35 % of the source)
* `WordPressThemeHubPage.tsx`, `wordpressThemeFiles.ts`, `contactForm7Templates.ts`: a generator for a WordPress theme
  and Contact Form 7 templates. Not part of the platform; it ships to every visitor. → **Not ported.**

### Duplication
* `overviewEn`/`descriptionEn`, `degreesOffered`/`degreeLevels`, `scholarshipAvailable`/`maxScholarship`,
  `popularMajors`/`programsOffered` hold the same values twice in `universities.ts`.
* Each page re-implements its own card, filter bar and CTA blocks.

### Content / trust risks
* Unsourced performance claims ("98% F-1 visa approval rate", "Foundation for 100% of our successful admissions",
  "transfer guaranteed"). For a consultancy these read as guarantees. → Ported as **editable CMS text**, flagged for
  the business to verify; the platform itself never generates guarantees.

### UX / mobile / accessibility
* Heavy gradients, dense hero sections, very long pages (Home is 77 KB of JSX).
* Only 8 `aria-*` attributes in the whole app; 21 `<img>` tags without `alt`; icon-only buttons (close, compare)
  without accessible names; modals do not trap focus or restore it; no visible focus styles beyond defaults.
* Modals on mobile are full forms in an overlay — fine, but there is no way to deep-link to them.

### Security
* No server, so no server-side risk yet — but also no validation, no spam protection, no consent capture.
* Email addresses and phone numbers hard-coded in 40+ places.

---

## 3. Decision: stack

**The GEC platform is built as a server-rendered Node application in `gec/`, reusing DocBook's core stack and
patterns; the GEC React SPA is ported (content, flows, brand), not extended.**

Why the React SPA is not kept as the base:
1. It has no backend to extend — every requirement (auth, RBAC, CRM, uploads, e-mail, audit) needs a server anyway.
2. SEO (requirement 46) needs real URLs and server-rendered HTML; the SPA would need a full SSR framework migration
   (Next/Remix) — a larger rewrite than porting 13 presentational pages.
3. DocBook already runs this exact kind of product in production on the target hosting model (Node + MySQL, cPanel
   compatible), with hardened security middleware. Re-using it is the least risky path.

What is reused from the GEC SPA: every page's content and purpose, the 3-step consultation flow, the study finder,
compare, shortlist, global search shortcut, cost calculator logic (generalised to many countries), WhatsApp entry
point, bilingual copy (`translations.ts` → JSON dictionaries), all seed data (→ database seeds marked *demo*), brand
tokens.

What is reused from DocBook: config/env loading, error model (`AppError`), zod validation helper, i18n dictionaries,
audit log with diffs, token/crypto helpers, encrypted secrets, CSRF/locals middleware, error handler, session store,
strict CSP, rate limits, mailer layout, CSV export.

`gec/` is a self-contained app (own `package.json`, migrations, tests). DocBook is untouched.

---

## 4. Target architecture

```
gec/
  app.js                    entry (npm start)
  src/
    config/                 env, defaults
    core/                   errors, validate, i18n, audit, tokens, secrets, format, csv, mailer, events bus
    db/                     knex, migrations (one file per phase), seeds (demo data, flagged)
    middleware/             security, locals/CSRF, auth (staff / student), RBAC guard, tracking, errors
    modules/
      auth/                 staff + student sign-in, reset, sessions, lockout, OAuth-ready
      rbac/                 permission catalog, roles, data scopes (own / branch / all)
      settings/             general, branding (theme.css), integrations (encrypted)
      employees/ branches/
      crm/                  leads, students, activities, notes, tasks, duplicates, assignment
      catalog/              destinations, universities, programs, scholarships, finder, matching, compare, shortlist
      admissions/           applications (ATS), stages, documents, visa cases
      booking/              appointment types, availability, appointments, courses, events
      comms/                channels (email/SMS/WhatsApp adapters), templates, inbox, campaigns
      growth/               tracking, attribution, lead scoring, analytics, automations
      finance/              payments, invoices, partners, commissions
      portal/               student portal
      cms/                  pages, articles, FAQs, testimonials, services, navigation, SEO
      ai/                   advisor (retrieval over our DB, provider adapters)
    views/                  EJS: layouts (public, staff, portal, auth), partials, pages
    locales/{en,ar}/        JSON dictionaries
  public/                   css (tokens + components), js (progressive enhancement), fonts, icons, brand
  test/                     node:test unit + integration (real MySQL)
```

### Principles
* **One database, one workflow.** Every module writes to the same `activities` timeline and emits domain events
  (`lead.created`, `application.stage_changed`, …) consumed by automations, scoring and notifications.
* **Security on the server.** Every staff route declares its permission; every query on people is filtered by the
  user's *data scope* (own / branch / all). Hidden buttons are cosmetic only.
* **Progressive enhancement.** Pages work as HTML forms; JS adds palette, drag-and-drop, autosave, live search.
* **No fake features.** Integrations without credentials show "Not connected — configure in Settings"; nothing is
  pretended to be sent.
* **Demo data is labelled.** Seeded rows carry `is_demo = 1` and show a *Demo* chip in admin; one command removes them.

### Security model
bcrypt (cost 12) · session regeneration on sign-in · httpOnly/SameSite/secure cookies · CSRF token on every
state-changing request · helmet + strict CSP · rate limits on auth, forms, tracking and API · per-account lockout
after repeated failures · zod validation for all input · parameterised queries only (Knex) · upload allow-list by
magic bytes, size limits, files stored outside `public/` and served only through permission checks · secrets
encrypted with AES-256-GCM (`APP_KEY`) · audit log with old/new values and IP · session list & revocation.

### Delivery
Phases 1–10 as requested. Each phase: plan (what exists / reuse / change / DB / API / security) → implement →
migrations → tests → report. Reports live in `docs/PHASES.md`.
