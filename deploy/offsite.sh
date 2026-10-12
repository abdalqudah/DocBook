#!/usr/bin/env bash
# Copies the encrypted backups (deploy/backup.sh) to storage OUTSIDE this server, and back. Only encrypted backup
# folders are sent (the destination never sees patient data in clear, nor the passphrase). Nothing is ever deleted
# at the destination: set an expiry / lifecycle rule there (e.g. 90 days) instead.
# Destination in .env, one of:
#   OFFSITE_TARGET=rclone:<remote>:<path>     any rclone remote (S3, Backblaze B2, Cloudflare R2, Hetzner Storage Box…)
#                                             configured with `rclone config` as this user (~/.config/rclone, mode 600)
#   OFFSITE_TARGET=rsync:<user@host>:<path>   another server over SSH (key login for this user)
#   OFFSITE_TARGET=rsync:/mnt/<disk>/<path>    a separately attached disk (only off-server if it is another machine's)
#   deploy/offsite.sh push [<backup folder name>…]   copy every finished backup not yet there (or the ones named),
#                                                   then verify each copy's checksums against the local files
#   deploy/offsite.sh list                           backup folders at the destination
#   deploy/offsite.sh pull <folder name> <local dir> fetch one back (then: deploy/restore.sh --verify <local dir>/<name>)
#   deploy/offsite.sh test                           write, read back and remove a small marker file
source "$(dirname "$0")/lib.sh"
TARGET="$(envval OFFSITE_TARGET)"
ROOT_DIR="$(envval BACKUP_DIR)"; ROOT_DIR="${ROOT_DIR:-/var/backups/medworks}"
CMD="${1:-}"; shift || true
if [ -z "$TARGET" ]; then
  warn "OFFSITE_TARGET is not set in .env: backups stay on this server only (docs/BACKUP_AND_RESTORE.md)."
  [ "$CMD" = push ] && exit 0 || exit 1
fi
KIND="${TARGET%%:*}"; DEST="${TARGET#*:}"
case "$KIND" in
  rclone) require_cmd rclone ;;
  rsync) require_cmd rsync; [[ "$DEST" != *:* ]] || require_cmd ssh ;;
  *) die "OFFSITE_TARGET must start with rclone: or rsync:" ;;
esac

copy_up()  { if [ "$KIND" = rclone ]; then rclone copy --no-traverse "$1" "$DEST/$2"
             else rsync -a --partial --mkpath "$1/" "$DEST/$2/"; fi; }
# Prints the files that differ between the local folder and its copy (nothing = identical, compared by checksum).
differs()  { if [ "$KIND" = rclone ]; then rclone check --one-way "$1" "$DEST/$2" 2>&1 | grep -E 'ERROR|differences found' | grep -v ' 0 differences found' || true
             else rsync -anc --out-format='%n' "$1/" "$DEST/$2/" | grep -v '/$' || true; fi; }
list_remote() { if [ "$KIND" = rclone ]; then rclone lsf --dirs-only "$DEST" 2>/dev/null | sed 's#/$##'
                elif [[ "$DEST" != *:* ]]; then ls -1 "$DEST" 2>/dev/null || true
                else local host="${DEST%%:*}" path="${DEST#*:}"; ssh -o BatchMode=yes "$host" "ls -1 '$path' 2>/dev/null" || true; fi; }
copy_down() { if [ "$KIND" = rclone ]; then rclone copy "$DEST/$1" "$2/$1"; else rsync -a --mkpath "$DEST/$1/" "$2/$1/"; fi; }

case "$CMD" in
  push)
    [ -d "$ROOT_DIR" ] || die "No backup folder $ROOT_DIR"
    if [ $# -gt 0 ]; then names=("$@"); else mapfile -t names < <(find "$ROOT_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '*.partial' -printf '%f\n' | sort); fi
    [ ${#names[@]} -gt 0 ] || { log "No finished backups to send."; exit 0; }
    mapfile -t there < <(list_remote)
    sent=0
    for n in "${names[@]}"; do
      src="$ROOT_DIR/$n"
      [ -f "$src/MANIFEST.sha256" ] || { warn "$n: not a finished backup, skipped"; continue; }
      grep -q '^encrypted=1$' "$src/INFO.txt" || { warn "$n: NOT encrypted (made with --no-encrypt): never sent off the server"; continue; }
      if [ $# -eq 0 ] && printf '%s\n' "${there[@]}" | grep -qxF "$n" && [ -z "$(differs "$src" "$n")" ]; then continue; fi
      log "Sending $n"
      copy_up "$src" "$n"
      d="$(differs "$src" "$n")"; [ -z "$d" ] || die "$n: the copy at the destination differs from the local files: $d"
      log "  $n verified at the destination"
      sent=$((sent + 1))
    done
    log "Off-server copy up to date ($sent sent)."
    ;;
  list) list_remote ;;
  pull)
    [ $# -eq 2 ] || die "Usage: deploy/offsite.sh pull <folder name> <local dir>"
    [ -e "$2/$1" ] && die "$2/$1 already exists"
    mkdir -p "$2"; copy_down "$1" "$2"
    (cd "$2/$1" && sha256sum --quiet -c MANIFEST.sha256) || die "The fetched copy does not match its manifest."
    log "Fetched $1 into $2/$1 (manifest OK). Test it: deploy/restore.sh --verify $2/$1"
    ;;
  test)
    m="$(mktemp -d)"; echo "medworks offsite test $(date -u +%FT%TZ)" > "$m/marker.txt"
    copy_up "$m" ".medworks-offsite-test"
    mkdir -p "$m/back"; copy_down ".medworks-offsite-test" "$m/back"
    cmp -s "$m/marker.txt" "$m/back/.medworks-offsite-test/marker.txt" || die "Read-back differs: the destination is not usable."
    if [ "$KIND" = rclone ]; then rclone purge "$DEST/.medworks-offsite-test" >/dev/null 2>&1 || true
    elif [[ "$DEST" != *:* ]]; then rm -rf "$DEST/.medworks-offsite-test"
    else ssh -o BatchMode=yes "${DEST%%:*}" "rm -rf '${DEST#*:}/.medworks-offsite-test'" 2>/dev/null || true; fi
    rm -rf "$m"; log "Destination $KIND OK: write, read back and verify worked."
    ;;
  *) die "Usage: deploy/offsite.sh push|list|pull|test" ;;
esac
