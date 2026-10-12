#!/usr/bin/env bash
# Run on the CURRENT server (cPanel or any host where MedWorks runs today), from SSH. Read-only for the app: it dumps
# the main database and every clinic database recorded in it, archives the app's storage/ folder, and writes exact
# row counts and SHA-256 checksums so the new server can prove nothing was lost. Nothing on this server is changed.
#   bash export-old-server.sh /path/to/the/app [output folder]
# The app's folder is the one with its .env (e.g. ~/medworks or ~/docbook). Needs: mysqldump, mysql, tar, sha256sum.
# Set EXPORT_PASSPHRASE to encrypt the export for the transfer (recommended): EXPORT_PASSPHRASE='…' bash export-old-server.sh …
set -euo pipefail
umask 077
APP="${1:?Usage: export-old-server.sh /path/to/the/app [output folder]}"
OUT="${2:-$HOME/medworks-export-$(date -u +%Y%m%dT%H%M%SZ)}"
[ -f "$APP/.env" ] || { echo "No .env in $APP" >&2; exit 1; }
for c in mysqldump mysql tar sha256sum gzip; do command -v "$c" >/dev/null || { echo "$c is required" >&2; exit 1; }; done

val() { local l; l="$(grep -E "^$1=" "$APP/.env" | tail -n1 || true)"; l="${l#*=}"; l="${l%\"}"; l="${l#\"}"; printf '%s' "$l"; }
DB_NAME="$(val DB_NAME)"; DB_USER="$(val DB_USER)"; export MYSQL_PWD="$(val DB_PASSWORD)"
CONN=(-u"$DB_USER")
if [ -n "$(val DB_SOCKET)" ]; then CONN+=(--socket="$(val DB_SOCKET)"); else CONN+=(-h"$(val DB_HOST || true)"); [ -n "$(val DB_PORT)" ] && CONN+=(-P"$(val DB_PORT)"); fi
[ -z "$(val DB_HOST)" ] && [ -z "$(val DB_SOCKET)" ] && CONN=(-u"$DB_USER" -hlocalhost)
mkdir -p "$OUT"

DBS=("$DB_NAME")
while IFS= read -r d; do [ -n "$d" ] && DBS+=("$d"); done < <(mysql "${CONN[@]}" -N -B "$DB_NAME" -e "SELECT DISTINCT db_name FROM businesses WHERE db_name IS NOT NULL AND db_name <> '' ORDER BY db_name" 2>/dev/null || true)

seal() { if [ -n "${EXPORT_PASSPHRASE:-}" ]; then openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:EXPORT_PASSPHRASE -in "$1" -out "$1.enc" && rm -f "$1"; fi; }

: > "$OUT/ROWCOUNTS.txt"
for db in "${DBS[@]}"; do
  echo "database $db"
  mysqldump "${CONN[@]}" --single-transaction --quick --hex-blob --no-tablespaces --default-character-set=utf8mb4 "$db" | gzip -6 > "$OUT/db-$db.sql.gz"
  for t in $(mysql "${CONN[@]}" -N -B -e "SELECT table_name FROM information_schema.tables WHERE table_schema='$db' AND table_type='BASE TABLE' ORDER BY table_name"); do
    printf '%s.%s %s\n' "$db" "$t" "$(mysql "${CONN[@]}" -N -B "$db" -e "SELECT COUNT(*) FROM \`$t\`")" >> "$OUT/ROWCOUNTS.txt"
  done
  seal "$OUT/db-$db.sql.gz"
done

echo "files: $APP/storage"
if [ -d "$APP/storage" ]; then
  (cd "$APP/storage" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) > "$OUT/FILES.sha256"
  tar -czf "$OUT/storage.tar.gz" -C "$APP/storage" .
else
  : > "$OUT/FILES.sha256"; tar -czf "$OUT/storage.tar.gz" -T /dev/null
fi
seal "$OUT/storage.tar.gz"

{
  echo "created_utc=$(date -u +%Y%m%dT%H%M%SZ)"
  echo "source=old-server"
  echo "app_version=$(grep -m1 '"version"' "$APP/package.json" | sed -E 's/.*"([0-9][^"]*)".*/\1/')"
  echo "main_database=$DB_NAME"
  echo "databases=${DBS[*]}"
  echo "encrypted=$([ -n "${EXPORT_PASSPHRASE:-}" ] && echo 1 || echo 0)"
  echo "app_key_set=$([ -n "$(val APP_KEY)" ] && echo yes || echo no)"
} > "$OUT/INFO.txt"
(cd "$OUT" && sha256sum -- * > MANIFEST.sha256)
echo
echo "Export ready: $OUT ($(du -sh "$OUT" | cut -f1)), ${#DBS[@]} database(s), $(wc -l < "$OUT/ROWCOUNTS.txt") tables, $(wc -l < "$OUT/FILES.sha256") files."
echo "Copy it to the new server, e.g.:  scp -r '$OUT' deploy@NEW_SERVER_IP:/opt/medworks-import/"
echo "IMPORTANT: on the new server set APP_KEY to this server's $( [ -n "$(val APP_KEY)" ] && echo APP_KEY || echo SESSION_SECRET ) value (it encrypted the saved credentials)."
