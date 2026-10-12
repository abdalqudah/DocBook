#!/usr/bin/env bash
# Run on the NEW server to bring in the data exported from the old one (deploy/export-old-server.sh). It never runs by
# itself and refuses to touch databases that already hold data:
#   1. checks the export's checksums;  2. the app must be stopped and every target database empty;
#   3. you type IMPORT;  4. imports the main database into DB_NAME and each clinic database under its own name (with
#   the app user's rights on it), the files into the storage volume;  5. compares every table's row count and every
#   file's checksum with the export;  6. starts the app (it brings the database structure up to date) and checks that
#   the stored credentials are readable with this APP_KEY.
#   deploy/import-migration.sh <export folder> [--fix-mysql8-collation] [--no-proxy]
#     --no-proxy   before the DNS switch: starts only the database and the app (on 127.0.0.1:8080), never Caddy
source "$(dirname "$0")/lib.sh"
require_cmd docker; require_cmd sha256sum; require_cmd openssl
SRC="${1:?Usage: deploy/import-migration.sh <export folder> [--fix-mysql8-collation] [--no-proxy]}"; shift
FIX=0; SERVICES=()
for a in "$@"; do
  case "$a" in
    --fix-mysql8-collation) FIX=1 ;;
    # Before the domain points here: start only the database and the app (app on 127.0.0.1:8080), not Caddy.
    --no-proxy) export COMPOSE_FILE="compose.yaml:deploy/compose.preview.yaml"; SERVICES=(db app) ;;
    *) die "Unknown option $a" ;;
  esac
done
[ -f "$SRC/MANIFEST.sha256" ] && [ -f "$SRC/INFO.txt" ] || die "Not an export folder: $SRC"
(cd "$SRC" && sha256sum --quiet -c MANIFEST.sha256) || die "The export's checksums do not match: copy it again."
log "Export checksums OK"
ENC="$(grep -E '^encrypted=' "$SRC/INFO.txt" | cut -d= -f2)"
[ "$ENC" = 1 ] && [ -z "${EXPORT_PASSPHRASE:-}" ] && die "The export is encrypted: run with EXPORT_PASSPHRASE='…' deploy/import-migration.sh …"
open_file() { if [ "$ENC" = 1 ]; then openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:EXPORT_PASSPHRASE -in "$1.enc"; else cat "$1"; fi; }
OLD_MAIN="$(grep -E '^main_database=' "$SRC/INFO.txt" | cut -d= -f2)"
NEW_MAIN="$(envval DB_NAME)"; NEW_MAIN="${NEW_MAIN:-medworks}"
APPUSER="$(envval DB_USER)"
mapfile -t DBS < <(grep -E '^databases=' "$SRC/INFO.txt" | cut -d= -f2 | tr ' ' '\n' | sed '/^$/d')
target() { [ "$1" = "$OLD_MAIN" ] && printf '%s' "$NEW_MAIN" || printf '%s' "$1"; }
# A clinic database's views and foreign keys name the main database (`old`.`users`). When the main database gets a new
# name here, those schema lines are pointed at it; data lines (INSERT) are passed through untouched.
rewrite() {
  local cmd=()
  [ "$FIX" = 1 ] && cmd+=(-e 's/utf8mb4_0900_ai_ci/utf8mb4_general_ci/g')
  [ "$1" != "$OLD_MAIN" ] && [ "$OLD_MAIN" != "$NEW_MAIN" ] && cmd+=(-e "/^INSERT INTO /! s/\`${OLD_MAIN}\`\./\`${NEW_MAIN}\`./g")
  if [ ${#cmd[@]} -gt 0 ]; then sed "${cmd[@]}"; else cat; fi
}

app_running && die "Stop the app first: docker compose stop app"
dc up -d db >/dev/null; wait_healthy db 180 || die "The database is not healthy."
for db in "${DBS[@]}"; do
  t="$(target "$db")"
  n="$(db_root -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${t//\'/}'")"
  [ "$n" = 0 ] || die "Database $t already has $n tables. The import only goes into empty databases (it never overwrites data)."
done
confirm "Import ${#DBS[@]} database(s) from $SRC (old main $OLD_MAIN → $NEW_MAIN) and its files into this server." IMPORT

for db in "${DBS[@]}"; do
  t="$(target "$db")"
  log "  importing $db → $t"
  db_root -e "CREATE DATABASE IF NOT EXISTS \`$t\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci; GRANT ALL PRIVILEGES ON \`$t\`.* TO '$APPUSER'@'%';"
  open_file "$SRC/db-$db.sql.gz" | gunzip | rewrite "$db" | db_root "$t"
done

log "Comparing row counts"
: > /tmp/medworks-import-counts.$$
for db in "${DBS[@]}"; do rowcounts "$(target "$db")" "$db" db_root >> /tmp/medworks-import-counts.$$; done
if diff <(sort "$SRC/ROWCOUNTS.txt") <(sort /tmp/medworks-import-counts.$$); then log "All $(wc -l < "$SRC/ROWCOUNTS.txt") tables have the same number of rows."; else rm -f /tmp/medworks-import-counts.$$; die "Row counts differ (above). Nothing was started; fix and import again into empty databases."; fi
rm -f /tmp/medworks-import-counts.$$

log "Files"
open_file "$SRC/storage.tar.gz" | dc run --rm --no-deps -T --entrypoint tar app -xzf - -C /app/storage
dc run --rm --no-deps -T --entrypoint sh app -c 'cd /app/storage && find . -type f -print0 | sort -z | xargs -0 -r sha256sum' > /tmp/medworks-import-files.$$
if diff <(sort "$SRC/FILES.sha256") <(sort /tmp/medworks-import-files.$$) >/dev/null; then log "All $(wc -l < "$SRC/FILES.sha256") files match their checksums."; else diff <(sort "$SRC/FILES.sha256") <(sort /tmp/medworks-import-files.$$) | head -20; rm -f /tmp/medworks-import-files.$$; die "Files differ from the export (above)."; fi
rm -f /tmp/medworks-import-files.$$

log "Checking the stored credentials with this APP_KEY"
dc run --rm --no-deps -T app node app.js check-secrets || die "Stored credentials are NOT readable: set APP_KEY to the old server's value (or its SESSION_SECRET), then run: docker compose run --rm app node app.js check-secrets"
log "Starting the app (it brings the database structure up to date)"
dc up -d "${SERVICES[@]}"
wait_healthy app 600 || die "The app is not healthy: docker compose logs app"
log "IMPORT COMPLETE. Take a backup now: deploy/backup.sh"
