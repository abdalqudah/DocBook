# MedWorks — Database and Files Migration Plan (old server → VPS)

Nothing in this plan has been run against the real production data. The scripts were tested end to end with the test
database `docbook_test` (synthetic data) on a local Docker stack; the evidence is in `docs/TEST_RESULTS.md`.

## 1. What moves

| Item | Source (old server) | Destination (VPS) |
|---|---|---|
| Main database | `DB_NAME` from the old `.env` | `DB_NAME` of the new `.env` (default `medworks`) |
| Clinic databases (when per-clinic databases are on) | every `businesses.db_name` | same names (they are referenced by `businesses.db_name`) |
| Files | the old `storage/` folder | volume `app_storage` (`/app/storage`) |
| Credential key | old `APP_KEY`, or old `SESSION_SECRET` if `APP_KEY` was never set | new `APP_KEY` |

Users' sessions move with the main database, so people stay signed in after the switch if the cookie domain is the same.

## 2. Rules

- The import only writes into **empty** databases and refuses otherwise. It never drops or overwrites anything.
- The old server is only read. Nothing on it is deleted; it stays as the rollback until the new server has run cleanly.
- Development or test data is never copied to production (the import takes only the export folder you give it).
- The export can be encrypted (`EXPORT_PASSPHRASE`, AES-256-CBC/PBKDF2) for the copy between servers.

## 3. Steps

**Rehearsal (no downtime, do this first):**

1. On the old server: `EXPORT_PASSPHRASE='…' bash deploy/export-old-server.sh /path/to/old/app /root/medworks-export`
   — `mysqldump --single-transaction` of every database, row counts, files archive and checksums.
2. Copy the folder to the VPS: `rsync -a /root/medworks-export deploy@VPS:/opt/medworks-import/`
3. On the VPS (fresh stack, app stopped): `EXPORT_PASSPHRASE='…' deploy/import-migration.sh /opt/medworks-import/medworks-export`
   It checks the checksums, imports, compares the row count of **every table**, compares every file's checksum, runs
   `check-secrets`, then starts the app (which applies any newer migrations) and waits for health.
4. Click through the app on a temporary hostname; then wipe the rehearsal (`docker compose down -v` on the VPS only).

**Cut-over (maintenance window):**

1. Put the old site in maintenance (Platform admin → maintenance) so no new data is written.
2. Repeat steps 1–3 with a fresh export.
3. Check: sign in as the platform admin and as one clinic owner, open patients, appointments, invoices, a document.
4. Lower the DNS TTL beforehand (e.g. 300 s a day before), then point `medworks.app` and `www` A records at the VPS.
5. Caddy obtains the certificates once DNS resolves. Check `https://medworks.app/healthz`.
6. Clinics with their own domains: their DNS points at `SERVER_IP` per the in-app instructions; update it if it pointed
   at the old IP.
7. Take the first backup on the VPS: `deploy/backup.sh`, then `deploy/restore.sh --verify <that backup>`.

## 4. Verification

| Check | How | Pass condition |
|---|---|---|
| Transfer integrity | `MANIFEST.sha256` of the export | all OK |
| Data completeness | `ROWCOUNTS.txt` vs. counts after import (every table, every database) | identical |
| Files | `FILES.sha256` vs. files in the volume | identical |
| Stored credentials | `node app.js check-secrets` | `OK` (exit 0) |
| Schema | app start applies pending migrations | app `healthy` |
| Function | manual sign-in and spot checks | pages load, data present |

## 5. Rollback

Before DNS switches: nothing to roll back — the old server is still live.
After DNS switches: point DNS back at the old server (which was only put in maintenance, not changed) and turn its
maintenance off. Data entered on the VPS after the switch would have to be re-entered or exported; keep the window
short and decide go/no-go within the first hour. Details: `docs/ROLLBACK_GUIDE.md`.

## 6. Known compatibility points

- Old server on MySQL 8 with `utf8mb4_0900_ai_ci` collations: MariaDB does not have them. Run the import with
  `--fix-mysql8-collation` (rewrites them to `utf8mb4_general_ci` during import).
- Clinic databases reference the main database by name in their views and foreign keys. When the new `DB_NAME`
  differs from the old main database name, the import rewrites those references in the clinic databases' schema lines
  (`CREATE VIEW`, `REFERENCES`) — data lines (`INSERT`) are never changed. Tested: old `mwold` + clinic database
  `mwold_synthetic_clinic` imported under `medworks`; all 77 views and 181 foreign keys point at `medworks`, none at
  the old name; the clinic owner signs in and sees the clinic's patients. Clinic databases keep their old names (they
  are recorded in `businesses.db_name`); the app user is granted rights on each.
