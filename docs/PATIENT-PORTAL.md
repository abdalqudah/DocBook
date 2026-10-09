# Patient portal and platform link (2.9.1, rep visits and live offers 2.9.2)

## Patient portal (`/<slug>/account`, on a clinic domain `/account`)
Settings → Patient portal (owner / `settings.manage`): on/off, self sign-up, the sections patients see (visits,
prescriptions, treatment plan, visit records, files) and the WhatsApp authentication template for codes.
- **Sign-in:** the mobile (any form: 07…, +962…, 00962…) or the e-mail on the patient's file, and a password; an eye
  shows / hides the password; "Forgot password?"; under the form a **Staff sign-in** button (the clinic's staff login,
  `/<slug>/login`, to their dashboard).
- **First time (old patients of the clinic):** the patient types only the mobile / e-mail and presses Sign in → a one-time
  code goes to the mobile / e-mail **on the file** → the patient chooses a password and lands on their file. The code is
  required: a number alone never opens a medical file.
- **Sign-up** (separate page) and **forgot password**: a 6-digit code by WhatsApp (when a template is set), SMS or
  e-mail — through the clinic's messaging and e-mail settings. Codes are kept as SHA-256, live 10 minutes, 5 tries, used
  once; a mobile / e-mail on more than one file cannot sign up by itself (the clinic sends the activation).
- **Activation from the clinic:** on a patient's file, "Patient account" → send the activation link by WhatsApp (opens
  the member's own WhatsApp with the message), SMS or e-mail; the link lives 3 days, once.
- **Safety:** 5 wrong passwords lock the account for 15 minutes; answers never say whether a number has an account;
  patient sessions are separate from staff sessions (`req.session.pp`); a patient sees only their own file and only the
  sections shown; files open through the portal only when the clinic shows files; sign-ins and codes are audited.

## Platform link (a DocBook on a clinic's own server ↔ the DocBook platform)
- **Platform:** Admin → Linked installations → *Create a link key* (shown once; only its SHA-256 is kept; revoke any
  time). API `/hub/v1` (Bearer key, no session): `POST /hello` (the clinic's public card), `GET /offers`, `GET /ads`
  (the reps' live offers / approved ads that reach the clinic's specialty and city — the same targeting as a clinic on
  the platform), images, `POST /ads/:id/click`.
- **Installation:** Settings → Platform link: the platform address and the key (stored encrypted) → hello and sync;
  live after: a page that shows them reads the platform first when the copy is older than 15 seconds (waits at most 4
  s, else shows the copy), and a background sync every minute keeps it warm. The platform's offers appear in Marketplace → Offers ("From the main platform", with the rep's phone
  / WhatsApp / e-mail); its ads show on the dashboard and the Marketplace when there is no local ad (clicks counted on the
  platform). Unlink removes the cached offers and ads.
- **Reps** see the linked clinics (name, specialty, city, phone, WhatsApp, website) under Visits → Find a clinic, and
  **book a visit there live** (`/vendor/visits/hub/<link>`): in its hello the installation gives the platform its address
  and a secret (kept encrypted on both sides); the platform calls the installation's `/hub-in/v1` (`GET /rep/clinic`,
  `GET /rep/slots`, `POST /rep/book`, `POST /rep/cancel`, Bearer secret) — free times are read at once, the visit lands
  in the clinic's own Rep visits (a local stand-in rep, `vendors.hub_vendor_id`), the rep keeps a copy on the platform
  (`hub_visits`, in their Visits list). The clinic's confirm / decline / cancel is sent to the platform at once
  (`POST /hub/v1/visits/status`) and the rep is notified; the rep can cancel from the platform.
