# Legacy Patient Recovery & Import (Clinica)

The Import Center brings a previous system's (Clinica) backup into a clinic: patients, treatments, clinical tables
and files. Each record is tied to a patient by the old patient id (`legacy_patient_id`), never by name.

- **Where:** Clinic → Patients → ⋯ → *Legacy Patient Recovery*, at `/app/import/legacy-clinica`. The old address
  `/admin/import/legacy-clinica` redirects there.
- **Who:** only members with `data.manage` (the clinic's owner / admin) can run an import. Medical staff with
  `clinical.view` read the result on the patient's **Legacy Records** tab, subject to the clinic's record-privacy rule.
- **Privacy:** all processing runs on this server. No patient data is sent to any outside service: no AI, no
  analytics and no third-party API.

---

## 1. Audit of the existing system

### 1.1 Patient schema
`patients` is a relational table (name, phones, file number, profile fields from 2.5.1), scoped by `business_id`.
- It had no field for a previous system's identity.
- Matching in the old ZIP import (`patientexport`) was by phone or name.

### 1.2 Attachment schema
`patient_files` stores files as a `MEDIUMBLOB` inside the database:
- 16 MB limit per file;
- a `sha256` column, but no de-duplication store;
- no source or legacy fields.

That shape cannot hold ~1,360+ files of any size, keyed by an old patient id.

### 1.3 Storage architecture
- Uploads are memory or `multer` temp files.
- `public/` is the only folder served as static files. `/storage/` is git-ignored and never served.
- Each clinic has a storage quota (`storage.service`, PARTS summed per table).

### 1.4 Existing APIs
- Server-rendered Express routes under `/app/*`, with CSRF on every POST.
- Multipart routes are allow-listed in `MULTIPART_ROUTES` and check their token after parsing.
- `/app/api/*` serves small JSON lookups for staff.

### 1.5 Authentication and RBAC
- Session login. `resolveBusiness` sets `req.ctx`, and every query filters on `ctx.businessId`; a tenant id from the
  browser is never trusted.
- `can()` / `canAny()` gate routes; `ownerOnly` covers destructive finance actions.
- `data.manage` is owner-only.
- `clinical.view` is held by doctors and nurses, and the record-privacy rule can narrow it further.
- Every view of a clinical record is logged in `record_access_log`.

### 1.6 Existing import capabilities
`patientexport/import.service.js` imports DocBook's own export ZIP:
- an in-process runner with JSON meta files;
- `import_links` for idempotency.

Its limits:
- it does not resume after a server restart;
- it has no per-item status, error log or reconciliation;
- it cannot read a multi-GB JSON file, because it reads whole files.

`core/zipread.js` already reads large ZIP64 archives entry by entry and is reused here.

## 2. Recommended database changes (migration `20261016000101_legacy_import`)

The migration only adds things: no existing column or row changes, and it is safe to run and roll back.

### New columns on `patients`
- `legacy_source`
- `legacy_patient_id`
- `legacy_patient_number`
- `legacy_import_job_id`
- `legacy_imported_at`

There is a unique index on (`business_id`, `legacy_source`, `legacy_patient_id`), so one old patient maps to at most
one patient file.

### New tables (tenant tables: they move with the clinic's database)

| Table | Holds |
|---|---|
| `import_jobs` | One import: status, stage, totals (total, processed, success, failed, skipped), source counts `src_*`, system counts `sys_*`, `runner` + `heartbeat_at` |
| `import_batches` | Each uploaded file (patients JSON / attachment ZIP): size, SHA-256, batch no / total, status, valid / invalid counts |
| `import_items` | One row per patient and per file: status (pending / processing / imported / failed / skipped / duplicate / unmatched / invalid), match, byte offset of the patient's record in the JSON, source checksum, attempts |
| `import_errors` | patient id, file, stage, error_code, message, level, status (open / ignored / resolved), time |
| `legacy_patients` | The old patient file (id, number, old name, mobile, telephone, group, nationality…) and the patient it is linked to (nullable = UNMATCHED) |
| `legacy_patient_links` | The patient's Clinica URLs |
| `legacy_treatments` | One row per treatment: date, tooth, description, doctor, price, type, status, complete date, note, referred by |
| `legacy_clinical_records` / `legacy_clinical_values` | Clinical tables (periodontal, pocket measurements, anesthesia, treatment details…): one record per row, one value per field |
| `legacy_field_values` | Every other field of a patient or treatment, kept as (field, value) rows so nothing in the source is lost |
| `patient_attachments` | patient_id, legacy ids, original / stored filename, mime type, category, file size, storage path, SHA-256 checksum, source URL, ZIP path, batch, job, uploaded_at |

There is no `patients.data` JSON column, and the uploaded JSON is never stored in the database. It is read as a
stream, and each record becomes ordinary rows.

## 3. Recommended architecture

```
upload (multer → private job folder, SHA-256)
   └─ import_batches ─┐
                      ▼
background runner (one per clinic, heartbeat; taken over when stale)
   ├─ analyze patients JSON  (core/jsonstream: byte scanner, any size)
   │     → import_items(patient, offset, length, checksum, match)
   │     → index.json (separate top-level lists per patient)
   ├─ analyze each ZIP (manifest + every entry: exists, size, real type, checksum)
   │     → import_items(attachment) | import_errors
   ├─ READY → preview → START IMPORT
   ├─ import patients, one transaction each (re-read by offset; checksum verified)
   ├─ import files (re-verified; content-addressed private store)
   └─ reconcile source vs system → completed | completed_with_issues
```

### Modules
- `src/core/jsonstream.js`: a streaming JSON element scanner that yields each element with its byte offset.
- `src/modules/legacy/clinica-map.js`: maps a Clinica record to its parts. Field names are matched loosely.
- `src/modules/legacy/files.js`: the private file store.
  - Location: `LEGACY_FILES_DIR`, default `storage/patient-attachments`, laid out as `<clinic>/<sha[0:2]>/<sha>`.
  - Writes are atomic.
  - A file's real type comes from its first bytes, not its name.
- `src/modules/legacy/import.service.js`: jobs, analysis, import, resume, reconciliation, retry / ignore, recovery
  (link or create) and the report.
- `src/modules/legacy/records.service.js`: the patient's Legacy Records and the recovery list.
- `src/modules/legacy/web.js`: the wizard, dashboard, error log, report (CSV / JSON) and recovery list.
- `src/modules/legacy/download.web.js`: `GET /api/patients/:id/attachments/:attachmentId/download`.
  - The member must be signed in, belong to the clinic that holds the patient, have `clinical.view` and pass the
    privacy rule.
  - Every access is logged.
  - `?inline=1` previews images and PDFs; anything else is always a download.

### Import modes and the patient key (2.7.2)
The import is a **migration**: every Clinica patient becomes a patient here. The key of a patient is
`patients.legacy_source` (= source system, `clinica`) + `patients.legacy_patient_id` (= the Clinica patient id), with a
unique index per clinic (`patients_legacy_uq` on `business_id, legacy_source, legacy_patient_id`). These fields are
filled by the import itself; they never need to exist beforehand.

For each old patient the preview shows its plan, and the import does exactly that:

| Plan | When | What the import does |
|---|---|---|
| **new** | the Clinica id is not on any patient here | CREATE a patient: name, mobile (`phone`), telephone (`phone2`), e-mail, gender, birth date, the Clinica number as the file number (when free), and `legacy_source`, `legacy_patient_id`, `legacy_patient_number`, `legacy_import_job_id`, `legacy_imported_at` |
| **existing** | the Clinica id is already on a patient here (an earlier import) | nothing is created; only missing treatments, clinical rows and files are added (resume / re-import) |
| **matched** | only with the optional duplicate check (below) | linked to the hand-entered patient |
| **review** | only with the optional check: two Clinica patients point at one hand-entered patient | not created, kept in the recovery list for a person |

Modes:
1. **Initial migration**: the clinic has no patients. Everything is created; no matching of any kind.
2. **Re-import / resume**: the same key is found, so nothing is created twice. A concurrent insert of the same key hits
   the unique index and is retried as "existing".
3. **Clinic with hand-entered patients**: an optional, separate duplicate check is shown in the preview. It is on by
   default only when such patients exist, and it never uses the name alone (old number; file number with first name or
   mobile; mobile with first name). It never stops an initial migration.

Attachments are tied to the patient by the folder / manifest `patient_id` (the Clinica id), never by name. Files whose
Clinica id is not in the patients file are kept, unattached, for review.

### Idempotency and resume

| Thing | Key |
|---|---|
| Patient | (clinic, source, old id) |
| Treatment / clinical row | (old patient, row key: the old id, else a content fingerprint) |
| File | (clinic, old patient id, SHA-256) |
| Stored copy | one per SHA-256 per clinic: duplicates point to it with `duplicate_of` and count 0 bytes against the quota |

- Each patient is imported in its own transaction.
- If the server stops, items left `processing` go back to `pending`. The next server start (`resumeAll`, also every
  5 minutes) takes over any job whose heartbeat is older than 2 minutes.
- Running the same import again adds nothing.

### File validation (FILE VALIDATION ERROR: the file is not imported)

| Code | Meaning |
|---|---|
| `CORRUPTED_ZIP` | The archive cannot be opened. |
| `MISSING_MANIFEST` | The archive has no `manifest.json`. |
| `INVALID_MANIFEST` | The manifest is not valid JSON or JSON Lines. |
| `FILE_MISSING` | The manifest lists a file that is not in the ZIP. |
| `PATIENT_FOLDER_MISMATCH` | The file's folder is not the patient id in the manifest. |
| `SIZE_MISMATCH` | The file's size differs from the manifest. |
| `CHECKSUM_MISMATCH` | The SHA-256 or MD5 differs from the manifest. |
| `MIME_MISMATCH` | The content is not what the extension says, e.g. a PNG named `.pdf`. |
| `FILE_TOO_LARGE` | The entry is larger than the reader allows. |
| `CORRUPTED_FILE` | The entry cannot be read. |

The following are warnings, not errors:
- `SOURCE_NOT_DOWNLOADED`: the old system's file was not downloaded; the file is skipped.
- `NOT_IN_MANIFEST`: the file is imported by its folder id.
- `DUPLICATE_FILE`: the file is in another ZIP; it is imported once.

The summary also reports duplicate ZIPs (same SHA-256), missing batches (from `NN-of-NN` in the file name or the
manifest) and the expected total.

### Reconciliation
Source and system counts are compared for patients, treatments, clinical rows and attachments. If any count differs,
or an error is still open, the job ends **Import Completed With Issues**; otherwise it ends **Import Complete**. Once
an import completes cleanly, its uploaded files are deleted.

## 4. Migration flow (how to run an import)

1. **Back up first.** Take a clinic backup (Settings → Data). The import never changes existing patient rows, apart
   from filling the new `legacy_*` columns of the patients it links.
2. Open **Patients → ⋯ → Legacy Patient Recovery → Start a new import**.
3. **Step 1:** drop `clinica-patients-xxxx.json`. It is checked in the background and the page updates by itself.
4. **Step 2:** drop the `clinica-attachments-NN-of-14.zip` archives, several at once if you like. Check the chips:
   detected, expected, missing batches, duplicates and corrupted archives.
5. **Step 3 (Preview):** check the counts: patients, matched, unmatched, treatments, clinical rows, valid and invalid
   files, errors. Nothing has been written yet. Then press **START IMPORT**, or **Cancel**.
6. **Step 4:** the import runs in the background with a progress bar, and the page can be closed. If the clinic's
   storage fills up, the job stops with `STORAGE_FULL`; raise the storage size, then press **Resume**.
7. **Step 5 (Report):** read the reconciliation and the error log, where each error can be retried, ignored or opened
   for details. Download the report as CSV or JSON.
8. **Recovery list:** for each UNMATCHED old patient, either:
   - press **Recover / Import**, which creates the patient from the old name and mobile; or
   - press **Link to a patient** to choose an existing patient.

   Either way, its treatments, clinical rows and files follow.
9. Doctors open **Patient → Legacy Records**, which shows:
   - an overview with the old ids, phones, group, nationality, Clinica URLs and the import date;
   - the treatments table;
   - the clinical tables;
   - the attachments: image thumbnails with a preview (zoom, full screen, download) and document cards (preview,
     download).

### Search
The patient list's search box also finds a patient by the old patient id or the old patient number (exact match).
The recovery list searches name, mobile, old id and old number.

### Settings (`.env`)

| Variable | Default | |
|---|---|---|
| `LEGACY_IMPORT_DIR` | `storage/legacy-import` | Uploaded files while an import needs them (private, mode 0700) |
| `LEGACY_FILES_DIR` | `storage/patient-attachments` | Imported medical files (private; never under `public/`) |
| `LEGACY_IMPORT_MAX_MB` | `8192` | Largest single upload |

Back up `LEGACY_FILES_DIR` together with the database. With PHP or Nginx in front, raise the upload limit
(`client_max_body_size`) to match `LEGACY_IMPORT_MAX_MB`.

---

# Moving / sharing patients between clinics (2.7.0)

A doctor who owns more than one clinic (e.g. Khalidi and Abdali — each possibly in its own database) can move or share
patients between them: **Patients → tick patients** (or filter, e.g. by the group "العبدلي", then "All N matching") →
**Move / share** → choose the clinic, the mode and (optionally) the doctor there → **Start**. It runs in the background
(`patient_transfers`, `patient_transfer_items` in the main database) and carries on after a server restart.

- **Share** — the patient is a patient of both clinics (visits here or there). Both files are linked (`patient_links`);
  either clinic can press **Update** (on the patient, or "Update from …" for all shared patients) to pull only what the
  other added since. Copies in both directions never double (import links are written both ways).
- **Move** — the file goes to the other clinic; here it stays as a read-only archive, hidden from the list (filter
  "Moved to another clinic" shows them), with a banner and **Bring back**.
- Everything is copied with the same engine as the patient export / import: details, visits, notes, diagnoses,
  prescriptions, tests, referrals, dental chart, growth, pregnancies, surgeries, specialty forms, files, the invoice /
  certificate PDFs (invoices are not re-created), groups, photo, and the legacy (Clinica) records and files. Upcoming
  bookings stay where they were booked; the result lists how many.
- Only a member who manages the data (`data.manage`, the owner) of **both** clinics can do it; it is audited in both.
- The second clinic does not need to exist yet: once it is opened (Workspaces → New clinic, by the same owner) it
  appears as a destination.

---

# Clinica data in the patient's own file (2.8.0)

The import no longer stops at a separate "Legacy Records" view: the data goes into the patient's file.

- **Treatments → treatment plan.** Each Clinica treatment becomes an item of the patient's treatment plan
  (`dental_plan_items`), shown on the patient's overview ("Treatment plan & treatments") and the dental chart:
  - fields: tooth (FDI), treatment, price, and status — done with its date, planned, or cancelled;
  - notes: the type, the note, "referred by", and a tooth written as a range (e.g. 11-21).
- **Doctors.** Doctors are matched by name, ignoring "Dr" / "د." and spelling variants. A doctor not found is added
  with its Clinica name (inactive: shown on the records, not offered for booking until the clinic turns it on).
- **Files.** Clinica files appear in the patient's "Tests & files" tab ("Files from Clinica"), opening through the
  authorised download.
- **Links.** Links inside Clinica text show the file's name. When that file was imported, the link opens it here;
  otherwise it opens the old address.
- **Linking and safety.** `legacy_treatments.plan_item_id` ↔ `dental_plan_items.legacy_treatment_id` (unique), so each
  treatment is converted once. Imports made before 2.8.0 are converted with **Import Center → "Move the treatments into
  the patients' files"**. The same button, run again after adding the clinic's doctors, fills in the doctors.
- **Original data.** The Legacy Records tab keeps the original Clinica data (clinical tables, every field) as the
  auditable source.

## 2.8.1: durable conversion, chosen doctors, the old calendar
- **Durable conversion.** The conversion is a saved job (`import_jobs` type `legacy_promote`, with a heartbeat and a
  cursor). A stopped process — a server restart or an idle-killed worker — is carried on by the server tick or when
  the Import Center is opened.
- **Doctors.** A Clinica doctor name is no longer turned into a doctor automatically. On **Import Center → Doctors of
  the Clinica data**, each name, and the treatments that have no doctor, is mapped to one of:
  - an existing doctor;
  - a new doctor with that name (inactive);
  - no doctor.

  The default is a doctor here with the same name. Saving re-applies the choice to the plan items and visits the
  import made, but not to items a person changed since.
- **Old calendar.** It fills the clinic's calendar:
  - Clinica's own appointments, when the file has them (inside the patient record, or as a list beside the
    patients), keep their date, time, doctor, status and note;
  - one visit is added for each day of treatments not already on the calendar, and that day's treatments are linked
    to it.
- **Imported visits** carry `external_source = 'clinica'` (one per key) and `source = 'import'`. Past visits are
  `payment_status = 'imported'`: never "unpaid" at the cash desk, and no review request is sent for them. Bookings
  still to come are ordinary bookings.

## 2.8.3: the real Clinica data — one doctor per person, chairs, clean text, groups and branches
What the real backup showed, and what the import does with it:
- **Doctor names.** Clinica writes doctors in English; the clinic's doctors here are often in Arabic. A name now finds
  the doctor here by its sound as well ("Faris Qudah" = "د. فارس القضاة", "Raghad  Kafina" = "Raghad Kafina" = "رغد
  كفينة"): a consonant skeleton per word, titles ("Dr", "د.") and "Al" / "ال" left out, the same first name and (when both
  have one) the same last name — and only when exactly one doctor here matches. Nothing is added for a name found this
  way. The Doctors page shows one row per person, whatever the spellings.
- **Chairs.** "Clinic One" … "Clinic Five" are written where the doctor goes. They are not doctors: such a treatment,
  and one with no doctor, takes the patient's doctor of that day, else the patient's usual doctor, else the doctor seen
  most with that name over the clinic's data (the choice "From the patient's visits", the default for these rows; the
  clinic can pick a doctor instead). The name stays in the plan item's notes ("Clinica: Clinic One"). Visits are one per
  day and doctor, so a chair's treatment joins the visit of the doctor it was given to.
- **Descriptions.** Clinica's page text is removed from a treatment's description ("more…X", "View Notes"); its
  details ("Chief Complaint: …", "HPI: …") go to the plan item's notes and to the visit's notes, with the treatment's own
  note.
- **Clinical tables.** In the backup they hold no patient data: the periodontal chart, pocket measurements, pocket
  distribution and anesthesia tables are Clinica's empty forms (the same on every patient), and "treatment details" are
  copies of the treatments. These are left out (`clinica-clean.clinicalRows`); Clinica's files table (file name, upload
  date) is kept on the Legacy Records tab. There is no perio data to put on the dental chart.
- **Groups and branches.** The patient's Clinica groups ("Implant", "Abdali Hospital"…) become patient groups. On the
  Doctors page each group can be tied to a branch (`legacy_branch_map`): the visits of its patients are on that branch;
  otherwise a visit is on its doctor's branch (main when the doctor has none).
- **After the import** a last conversion pass runs when treatments are still without a doctor (the clinic-wide
  fallback is known only once every patient is in).

### Cleaning a backup beforehand (optional)
`node scripts/clinica-clean.js <clinica-patients.json> <out-dir>` — on the clinic's own computer; nothing is sent
anywhere. It writes `clinica-patients-clean.json` (one spelling per doctor, clean descriptions, no empty forms — about
a fifth of the size), `clinica-doctors.csv` (spellings → one name) and `clinica-report.md/json` (counts only: patients,
treatments, visits, files, files listed in Clinica but not downloaded, doctors after merge, what the chairs become,
groups). The attachment ZIPs are imported unchanged.

## 2.8.5: no "Legacy Records" tab — everything in its place
- The patient file has no Legacy Records tab any more (an old `?tab=legacy` address opens the overview). What came from
  Clinica is where the clinic's own data is: treatments in the treatment plan, visits in the calendar and the
  appointments tab, groups on the patient, nationality (written out, e.g. "Jordan", → its code) and phones on the
  patient's details.
- **Files.** Clinica's files are in the patient's one file list (Tests & files), mixed with the files added here, newest
  first, each by its name and its date in Clinica (from Clinica's files table; else the import date). A file Clinica lists
  for the patient that was not brought over shows by name and date, marked as not brought over
  (`records.service.filesOf`).
- The original rows (`legacy_*`) stay in the database as the import's audit trail, and the Import Center and the
  recovery list still use them.

### Downloading the attachments the first extraction missed
`scripts/clinica-attachments-fetch.js` runs in the clinic's own signed-in Clinica tab (pasted in the browser console):
it reads each patient's Clinica pages with that session (never signs in, never changes anything), collects every
`/system/files/…` link, skips the files of the previous manifest, downloads the rest with retries and saves
`clinica-attachments-extra-NN-of-MM.zip` (a folder per patient id + `manifest.json`, the usual shape) and
`clinica-attachments-discovered.csv`. A stopped run carries on (progress kept in that browser). The ZIPs go to the
Import Center like the first ones; files already there are not added twice.

## 2.8.7: pull the files straight from Clinica (Import Center → "Pull the files straight from Clinica")
For the attachments the first extraction did not download. The owner enters the Clinica address, user name and
password; the server (`remote.service`):
- signs in with Clinica's own sign-in form (any form with a password field; its hidden fields kept; cookies kept across
  redirects), and signs in again when Clinica ends the session;
- for each Clinica patient imported here (`legacy_patients` with a patient), reads `/dental/<id>` and
  `/edit_patient/<id>`, collects every `/system/files/…` link on the Clinica address only (links, images, quoted
  addresses in scripts), skips what the patient already has (same address, or same content: SHA-256), downloads the
  rest into the patient's file (`patient_attachments`, private store) — one request at a time, retries with back-off;
- is a saved job (`import_jobs` type `legacy_remote`: total/processed = patients, `src_links` = found, success =
  downloaded, skipped, failed + an `import_errors` row each) with a live count on the page, Stop / Carry on, audited
  (`legacy.remote_started|stopped|completed`);
- never stores the password: it stays in the process's memory while the pull runs. After a restart, a stopped pull or a
  refused sign-in the job waits ("enter the password again") and carries on from the patient it was at.
- Only `https://` addresses on the internet (no private or local addresses). Owner only. Read-only towards Clinica.
- **Sign-in question (CAPTCHA, 2.8.8).** Clinica asks a math question at sign-in. The pull never answers it itself:
  step 1 ("Open the sign-in page") fetches Clinica's sign-in page and shows its question to the owner; step 2 sends the
  owner's user name, password and answer with that same page's session and hidden fields. If Clinica ends the session
  during the pull, its new question needs the owner again: the pull waits ("open the sign-in page again") and carries
  on from where it was. Codes sent by SMS / e-mail are not supported; `scripts/clinica-attachments-fetch.js` (in the
  signed-in browser) remains the other way.

## 2.8.9: checking the structure of Clinica's pages
To pull patients, the calendar and treatments straight from Clinica too, the pull has to know Clinica's pages. "Check
Clinica's structure only" (step 2 of the sign-in) signs in and reads the home page, one imported patient's
`/dental/<id>` and `/edit_patient/<id>`, and the menu pages the home page links to (one of each address pattern; never
an address that could sign out, change, send or delete). It keeps, per page, only its shape: the address with numbers
as `{n}` and query values dropped, forms (action, input names / types, select names and option counts), table headers
and row counts, form labels, linked address patterns, script addresses and the addresses scripts ask for (calendar
feeds). No text, value, title or heading — no patient data. The owner downloads it as `clinica-structure.json`
(memory only; audited `legacy.remote_probed`).

## 2.9.0: pull everything straight from Clinica — and add only what is missing
Built on the structure report of the real Clinica (2.8.9). After the owner's sign-in (with the answer to Clinica's
question) the pull runs three stages, as one saved job (`import_jobs.stats` keeps its counts and calendar range):
1. **Patients list** — `/patients?page=N` (50 a page, until the pager repeats): a Clinica id not here yet becomes a
   patient (same creation as the import: name, phones, number, nationality; `legacy_patients` row).
2. **Patient files** — for each Clinica patient here: `/dental/<id>` and `/edit_patient/<id>`:
   - details from Clinica's patient form fill only **empty** fields here (English name, phones, e-mail, birth date,
     gender, national number, nationality, address, occupation, important note, medical history, medication, note);
   - treatments of Clinica's treatments table not here yet (same day, tooth, treatment, doctor and note — counted, so two
     identical treatments stay two) become legacy treatments, then the patient's plan and visits as always;
   - attachments not here yet, as in 2.8.7.
3. **Calendar** — `/ncalendar?date=YYYY-MM-DD` for each day of the range (default 2019-01-01 → one year ahead): each
   appointment of the day's list (or of the day grid) → the clinic's calendar, key `clinica:<id>:a:cal:<day>:<time>:<calendar>`.
   The visit the import made for that day's treatments becomes this appointment (its time and calendar) instead of a
   second visit; a doctor or branch already set is kept. If Clinica shows another day than the one asked, the calendar
   stage stops without adding anything (`CALENDAR_DAY_NOT_SHOWN`). Each Clinica calendar (Mansour, Clinic 2, Abdali
   Clinic…) is listed on the Doctors page to tie to a branch.
Nothing here is deleted, cancelled or overwritten; running the pull again adds nothing that is already here. Patients the
pull added are removed by "Remove everything imported from Clinica" like those the import added.

## 2.9.4: photos from Clinica kept as small WebP
- On arrival (ZIP import or the direct pull), a photo (PNG / JPEG / WebP) is stored as a sharp WebP with the same
  rules as any upload in DocBook (core/imageopt: up to 2048 px on the long side, `sharp_yuv` for thin lines and text,
  exact alpha; a graphic is tried lossless). Only kept when it is smaller.
- The stored copy keeps the original's SHA-256 as its key and `checksum`, so the same file brought again is still
  recognised and never stored twice; `original_filename` / `stored_filename` stay as in Clinica (they are matched to
  Clinica's file list). The download gets a `.webp` ending; `Content-Length` is read from the disk.
- Photos imported before 2.9.4: Platform admin → Compress old images → "Patient photos brought from the old system"
  (rewritten in place, atomically; the attachments sharing the copy follow; tried once).
- PDFs, Word files and other documents are never changed: a scanned PDF is already compressed images, re-saving a
  PDF can break a digital signature, and shrinking the pictures inside would lower their quality.

## 2.9.5: real times from Clinica's calendar; the delete folded away
- Reading a calendar day, a row takes over what the file import made for that patient and day and is not yet tied to
  a calendar row: the visit of the day's treatments (`v:`) or an appointment of the uploaded file (`a:`, usually
  without a time, so at 09:00) — same time first. It gets the calendar's real time, doctor and branch; never a
  second appointment. Days not in the calendar keep their visit at 09:00 (history: completed, nothing booked).
- "12:30 AM" is read as 00:30.
- "Remove everything that came from Clinica" is folded away (only to start again from nothing) and is refused while
  the pull is running.
