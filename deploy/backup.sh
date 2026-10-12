#!/usr/bin/env bash
# MedWorks backup: every database (the main one and each clinic's own) as a consistent dump, and the app's files volume
# (clinic backups, patient exports and imports, legacy attachments), with a manifest of row counts and SHA-256 sums.
# Encrypted with BACKUP_PASSPHRASE (GnuPG, AES-256 with an integrity check: a changed file does not decrypt). Old backups beyond BACKUP_KEEP_DAYS are removed.
#   deploy/backup.sh                 a backup in $BACKUP_DIR/<UTC time>/
#   deploy/backup.sh --no-encrypt    only for a test server: the files stay readable
# Restore: deploy/restore.sh (test a backup without touching production: deploy/restore.sh --verify <dir>).
source "$(dirname "$0")/lib.sh"
require_cmd docker; require_cmd gpg; require_cmd sha256sum; require_cmd flock

ENCRYPT=1
[ "${1:-}" = "--no-encrypt" ] && ENCRYPT=0
PASS="$(envval BACKUP_PASSPHRASE)"
[ "$ENCRYPT" = 1 ] && [ ${#PASS} -lt 16 ] && die "Set BACKUP_PASSPHRASE (at least 16 characters) in .env, or run with --no-encrypt on a test server."
ROOT_DIR="$(envval BACKUP_DIR)"; ROOT_DIR="${ROOT_DIR:-/var/backups/medworks}"
KEEP="$(envval BACKUP_KEEP_DAYS)"; KEEP="${KEEP:-14}"
mkdir -p "$ROOT_DIR"
exec 9>"$ROOT_DIR/.lock"
flock -n 9 || die "Another backup is running."

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$ROOT_DIR/$STAMP.partial"
mkdir -p "$OUT"
trap 'rm -rf "$OUT"' ERR

seal() { # seal <file>: encrypt in place (→ <file>.gpg) when encryption is on
  if [ "$ENCRYPT" = 1 ]; then
    gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 --symmetric --cipher-algo AES256 \
      --s2k-digest-algo SHA512 --s2k-count 65011712 -o "$1.gpg" "$1" 3<<<"$PASS"
    rm -f "$1"
  fi
}

log "Backup $STAMP → $ROOT_DIR"
mapfile -t DBS < <(databases)
[ "${#DBS[@]}" -ge 1 ] || die "No database found."
: > "$OUT/ROWCOUNTS.txt"
for db in "${DBS[@]}"; do
  log "  database $db"
  db_root -N -B -e "SELECT 1 FROM information_schema.schemata WHERE schema_name='${db//\'/}'" | grep -q 1 || { warn "database $db is recorded but missing; skipped"; continue; }
  dc exec -T -e MYSQL_PWD="$(envval DB_ROOT_PASSWORD)" db mariadb-dump -uroot --single-transaction --quick --routines --triggers --events \
    --hex-blob --default-character-set=utf8mb4 "$db" | gzip -6 > "$OUT/db-$db.sql.gz"
  [ -s "$OUT/db-$db.sql.gz" ] || die "The dump of $db is empty."
  rowcounts "$db" "$db" db_root >> "$OUT/ROWCOUNTS.txt"   # exact row counts, compared after a restore
  seal "$OUT/db-$db.sql.gz"
done

log "  files volume"
dc run --rm --no-deps -T --entrypoint sh app -c 'cd /app/storage && find . -type f -print0 | sort -z | xargs -0 -r sha256sum' > "$OUT/FILES.sha256" || die "Could not list the files volume."
dc run --rm --no-deps -T --entrypoint tar app -czf - -C /app/storage . > "$OUT/storage.tar.gz"
seal "$OUT/storage.tar.gz"

{
  echo "created_utc=$STAMP"
  echo "app_version=$(dc run --rm --no-deps -T --entrypoint node app -p "require('./package.json').version" 2>/dev/null || echo unknown)"
  echo "encrypted=$ENCRYPT"
  echo "databases=${DBS[*]}"
} > "$OUT/INFO.txt"
(cd "$OUT" && sha256sum -- * > MANIFEST.sha256)
mv "$OUT" "$ROOT_DIR/$STAMP"
trap - ERR
log "Done: $ROOT_DIR/$STAMP ($(du -sh "$ROOT_DIR/$STAMP" | cut -f1))"

find "$ROOT_DIR" -maxdepth 1 -mindepth 1 -type d -name '20*' -mtime +"$KEEP" -print -exec rm -rf {} + | sed 's/^/removed old backup: /' || true
