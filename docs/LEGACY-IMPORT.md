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

### Matching
1. A patient here with the same `legacy_patient_id` (source `clinica`) is **MATCHED**.
2. Otherwise, a patient here with the same `legacy_patient_number` is **MATCHED**.
3. Otherwise the patient is **UNMATCHED**. Its data is staged in the `legacy_*` tables with `patient_id` NULL and can
   be linked later from the recovery list.

The name is for display only. A patient file is created automatically only when the person starting the import ticks
"create a patient file for each unmatched patient", and even then not when the mobile number belongs to a patient
already in the clinic.

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
