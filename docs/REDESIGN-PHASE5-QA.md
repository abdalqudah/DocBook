# DocBook 2.0 redesign — Phase 5: journey QA

Run on 2026-10-01 against the branch after batches 3.1–3.13 and 4.1–4.15.

## What was checked

| Check | How | Result |
|---|---|---|
| Every page each role can reach | Browser crawl from `/app` following every in-app link: owner, receptionist, doctor, accountant, nurse × Arabic / English × desktop 1440 / phone 390 (20 runs, 58–214 pages each) | No server errors, no JS errors, no raw translation keys, no `undefined`/`NaN`, correct `dir`, no horizontal scroll on the phone |
| Links shown but not allowed | Same crawl: any link that answers 403/404 | 2 found and fixed (below) |
| Subscriptions on, package without website/AI features | Same crawl (owner AR desktop, owner EN desktop, receptionist and doctor EN phone) | Locked screens appear only inside the Website workspace; 1 bug fixed (below) |
| Old addresses | Every `GET /app/...` route of the pre-redesign list (`docs/redesign-routes.txt`) requested as the owner | 118 answer directly, 18 redirect to their new place, 0 broken (3 answer 404 by design without their query/data: `receipt/batch`, `teamops/patient-email`, `signatures/stamp.png`) |
| Translations | ar / en key sets compared; every literal `t('…')` key in code and views looked up | Identical key sets; no missing key |
| Fresh install from the dist zip | `node app.js migrate` on an empty database, production mode, sign up → 7 onboarding steps on a phone (AR) → finish → crawl 300 pages → publish the website → public page, `theme.css`, booking page | All pass |
| Upgrade from before the redesign | Database created and seeded by commit `8b1a39d`, a custom role with `settings.manage` and one without, then the dist's `migrate` | 6 migrations applied; the custom role with `settings.manage` received the 7 `website.*` permissions, the other did not; owner gets them from the system role; the clinic's classic page stays live until the first publish; old links 301; publish → new site + booking work |
| Automated suite | `npm test` | 308 pass, 0 fail |
| Brand check | `npm run brand:check` | OK |

## Fixed in this phase

1. **"+ New → Issue a certificate" opened a 404.** A document always belongs to a visit; without `?visit=` the
   page now lists the visits of the last 30 days that took place (a doctor sees only their own), with a patient-name
   search and the document type kept. `src/modules/certificates/web.js`, `views/pages/certificates/pick.ejs`.
2. **Doctor page linked upcoming appointments to the visit screen** for members without `clinical.view`
   (accountant → 403). It now links the appointment page for them, as the patient page already did.
3. **AI assistant links stayed visible when the area is off or outside the package** (Settings → AI and the
   button on Profit & loss led to the "turned off" page). Both now follow the module state.
4. Four code comments naming another product removed (brand check).

Tests added in `test/redesign.test.js`: every "+ New" action opens a page; the visit picker (own visits, no
cancelled ones); AI links hidden when the area is off.

## Follow-up fixes (the two observations)

- **A clinic without a doctor.** Onboarding "Continue" on the doctors step now explains that a doctor is needed and
  stays (422); "Skip for now" still moves on. The "ready" page shows a warning with "Add a doctor", Today lists
  "No doctor yet" for members with `doctors.manage`, and the public booking page shows the "call the clinic" page
  (phone / WhatsApp) instead of a form that cannot be sent.
- **Address of an Arabic-only clinic name.** `suggestSlug` transliterates Arabic to Latin letters and drops words such
  as "clinic"/"centre" when more remains ("عيادة النور" → `alnoor`); Arabic-Indic digits become 0–9. Existing
  addresses are not changed.
