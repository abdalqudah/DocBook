#!/usr/bin/env bash
# MedWorks restore.
#   deploy/restore.sh --verify <backup dir>       restores the backup into a temporary MariaDB container (never the live
#                                                 one), compares every table's row count with the backup's ROWCOUNTS.txt
#                                                 and checks the files archive against FILES.sha256; then removes it all.
#   deploy/restore.sh --production <backup dir>   replaces the live databases and files with the backup. Takes a safety
#                                                 backup first, stops the app, asks you to type the database name.
#   … --production <backup dir> --skip-safety-backup   only when the current databases are too damaged to back up
#                                                 (the safety backup fails): restores without one, after a warning.
source "$(dirname "$0")/lib.sh"
require_cmd docker; require_cmd gpg; require_cmd openssl; require_cmd sha256sum

MODE="${1:-}"; SRC="${2:-}"; SKIP_SAFETY=0; [ "${3:-}" = "--skip-safety-backup" ] && SKIP_SAFETY=1
[ "$MODE" = "--verify" ] || [ "$MODE" = "--production" ] || die "Usage: deploy/restore.sh --verify|--production <backup dir>"
[ -d "$SRC" ] || die "Backup folder not found: $SRC"
[ -f "$SRC/MANIFEST.sha256" ] || die "Not a MedWorks backup (no MANIFEST.sha256): $SRC"
(cd "$SRC" && sha256sum --quiet -c MANIFEST.sha256) || die "The backup's checksums do not match: it is damaged or incomplete."
log "Checksums OK: $SRC"

ENC="$(grep -E '^encrypted=' "$SRC/INFO.txt" | cut -d= -f2)"
PASS="$(envval BACKUP_PASSPHRASE)"
[ "$ENC" = 1 ] && [ -z "$PASS" ] && die "This backup is encrypted: set BACKUP_PASSPHRASE in .env."
open_file() { # open_file <path without .gpg> → plain bytes on stdout (fails if the file was changed)
  if [ "$ENC" = 1 ]; then gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 -d "$1.gpg" 3<<<"$PASS"
  else cat "$1"; fi
}
MAIN="$(envval DB_NAME)"; MAIN="${MAIN:-medworks}"
mapfile -t DBS < <(grep -E '^databases=' "$SRC/INFO.txt" | cut -d= -f2 | tr ' ' '\n' | sed '/^$/d')

count_rows() { # count_rows <client…>: "db.table count" lines for every restored database
  local db; for db in "${DBS[@]}"; do rowcounts "$db" "$db" "$@"; done
}

if [ "$MODE" = "--verify" ]; then
  NAME="medworks-restore-check-$$"
  ROOTPW="$(openssl rand -hex 24)"
  cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  log "Starting a temporary database ($NAME)"
  docker run -d --name "$NAME" --network none -e MARIADB_ROOT_PASSWORD="$ROOTPW" mariadb:11.4 \
    --character-set-server=utf8mb4 --collation-server=utf8mb4_general_ci --max-allowed-packet=256M >/dev/null
  for i in $(seq 1 60); do docker exec -e MYSQL_PWD="$ROOTPW" "$NAME" mariadb -uroot -e 'SELECT 1' >/dev/null 2>&1 && break; sleep 2; done
  tmp() { docker exec -i -e MYSQL_PWD="$ROOTPW" "$NAME" mariadb -uroot "$@"; }
  for db in "${DBS[@]}"; do
    log "  restoring $db"
    tmp -e "CREATE DATABASE \`$db\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
    open_file "$SRC/db-$db.sql.gz" | gunzip | tmp "$db"
  done
  count_rows tmp > /tmp/medworks-restored-counts.$$
  if diff <(sort "$SRC/ROWCOUNTS.txt") <(sort /tmp/medworks-restored-counts.$$) > /tmp/medworks-restore-diff.$$; then
    log "Row counts: all $(wc -l < "$SRC/ROWCOUNTS.txt") tables match."
  else
    cat /tmp/medworks-restore-diff.$$; rm -f /tmp/medworks-restore*.$$; die "Row counts differ after the restore."
  fi
  rm -f /tmp/medworks-restore*.$$
  log "  files archive"
  WORK="$(mktemp -d)"; trap 'cleanup; rm -rf "$WORK"' EXIT
  open_file "$SRC/storage.tar.gz" | tar -xzf - -C "$WORK"
  (cd "$WORK" && if [ -s "$SRC/FILES.sha256" ]; then sha256sum --quiet -c "$SRC/FILES.sha256"; fi) || die "Files differ from FILES.sha256."
  log "Files: $(wc -l < "$SRC/FILES.sha256") files match their checksums."
  log "VERIFIED: this backup restores completely."
  exit 0
fi

# ---- production
confirm "This REPLACES the live databases (${DBS[*]}) and the app's files with the backup in $SRC.
A safety backup of the current state is taken first." "$MAIN"
if [ "$SKIP_SAFETY" = 1 ]; then
  confirm "WITHOUT a safety backup: the current databases will be lost for good." "NO-BACKUP"
else
  log "Safety backup of the current state"
  "$(dirname "$0")/backup.sh" || die "The safety backup failed; nothing was restored. If the current databases are damaged beyond backup, add --skip-safety-backup."
fi
log "Stopping the app"
dc stop app
trap 'warn "The restore stopped half-way: the app is left stopped. Restore again, or restore the safety backup just taken."' ERR
# Clinic databases have foreign keys to the main one: drop them first (last to first), then create and fill the main
# database before the clinics' ones.
for (( i=${#DBS[@]}-1; i>=0; i-- )); do db_root -e "SET FOREIGN_KEY_CHECKS=0; DROP DATABASE IF EXISTS \`${DBS[$i]}\`"; done
for db in "${DBS[@]}"; do
  log "  restoring $db"
  db_root -e "CREATE DATABASE \`$db\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci; GRANT ALL PRIVILEGES ON \`$db\`.* TO '$(envval DB_USER)'@'%';"
  open_file "$SRC/db-$db.sql.gz" | gunzip | db_root "$db"
done
count_rows db_root > /tmp/medworks-restored-counts.$$
diff <(sort "$SRC/ROWCOUNTS.txt") <(sort /tmp/medworks-restored-counts.$$) || { rm -f /tmp/medworks-restored-counts.$$; die "Row counts differ after the restore (the safety backup is in $(envval BACKUP_DIR))."; }
rm -f /tmp/medworks-restored-counts.$$
log "  files"
open_file "$SRC/storage.tar.gz" | dc run --rm --no-deps -T --entrypoint sh app -c 'find /app/storage -mindepth 1 -delete && tar -xzf - -C /app/storage'
trap - ERR
log "Starting the app"
dc up -d app
wait_healthy app 300 || die "The app did not become healthy; check: docker compose logs app"
log "RESTORED from $SRC"
