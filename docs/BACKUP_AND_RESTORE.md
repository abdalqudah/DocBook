# MedWorks — Backup and Restore

## What a backup contains

`deploy/backup.sh` writes one folder per run, `$BACKUP_DIR/<UTC time>/` (default `/var/backups/medworks`):

| File | Content |
|---|---|
| `db-<name>.sql.gz.gpg` | One per database (main + every clinic database): `mariadb-dump --single-transaction --quick --routines --triggers --events --hex-blob`, gzip, then GnuPG AES-256 |
| `storage.tar.gz.gpg` | The app's files volume (`/app/storage`) |
| `ROWCOUNTS.txt` | Exact row count of every table of every database at backup time |
| `FILES.sha256` | SHA-256 of every file in the volume |
| `INFO.txt` | Time, app version, database list, encrypted yes/no |
| `MANIFEST.sha256` | SHA-256 of every file above (detects a damaged or incomplete copy) |

- Consistent: `--single-transaction` gives a snapshot of each database without stopping the app.
- Encrypted with `BACKUP_PASSPHRASE` (gpg symmetric, AES-256, SHA-512 key derivation, with an integrity check: a changed
  file does not decrypt). **Without the passphrase, a backup cannot be restored**: keep it outside the server.
- Written to `<time>.partial/` and renamed when complete, under a lock (two backups never run at once).
- Retention: folders older than `BACKUP_KEEP_DAYS` (default 14) are removed after a successful backup.
- Most patient documents are stored inside the databases, so they are in the database dumps.

Clinics' own "download a backup of my clinic" (Settings → data) is a separate feature and keeps working.

## Schedule

```bash
sudo cp deploy/systemd/medworks-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now medworks-backup.timer
systemctl list-timers medworks-backup.timer          # next run (02:30 server time, up to 15 min later)
journalctl -u medworks-backup.service -n 50          # last run's log
```

Each deploy (`deploy/deploy.sh`) also takes a backup first and stops if it fails.

## Off-server copies (required for real disaster recovery)

A backup on the same disk does not survive the loss of the VPS. Not configured yet (needs a destination and approval).
Options: Hostinger's VPS snapshots (whole-server, in hPanel) **plus** a copy of the encrypted folders to another
provider, e.g. with `rclone` to S3-compatible storage, or `rsync` to another server:

```bash
rsync -a --delete-after /var/backups/medworks/ backup@other-host:/srv/medworks-backups/
```

The folders are already encrypted, so the destination never sees patient data in clear.

## Test a backup (never touches production)

```bash
deploy/restore.sh --verify /var/backups/medworks/<folder>
```

Checks the manifest, decrypts, restores every database into a **temporary MariaDB container without network**,
compares every table's row count with `ROWCOUNTS.txt`, checks the files archive against `FILES.sha256`, then deletes
the temporary container. Do this after setting up backups and then monthly.

## Restore production

```bash
deploy/restore.sh --production /var/backups/medworks/<folder>
```

1. Checks the manifest and that it can decrypt.
2. Asks you to type the main database name.
3. Takes a **safety backup** of the current state (so the restore itself can be undone).
4. Stops the app; drops and re-creates the databases from the backup (clinic databases are dropped before the main one
   and the main one is restored first, because clinic databases refer to it); grants the app user its rights.
5. Compares every table's row count with the backup; restores the files volume.
6. Starts the app and waits for it to be healthy.

If the current databases are too damaged for the safety backup (it fails), and only then:
`deploy/restore.sh --production <folder> --skip-safety-backup` (asks you to type `NO-BACKUP`).

If anything fails midway the app is left stopped and the script says so; fix the cause and run it again.

## Restore on a new server

Install as in `docs/VPS_DEPLOYMENT_GUIDE.md` sections 1–7 with the **same** `APP_KEY` and `BACKUP_PASSPHRASE`,
copy the backup folder, `docker compose up -d db`, then `deploy/restore.sh --production <folder>`.
`docker compose run --rm app node app.js check-secrets` confirms stored credentials are readable.

## Tested

Backup → `--verify`, tamper detection, wrong passphrase, and a `--production` restore that brought back a deleted
record were run on the local Docker stack (`docs/TEST_RESULTS.md`). Not yet run on the VPS.
