#!/usr/bin/env bash
# MedWorks deploy / update on the server (from the folder with compose.yaml, normally /opt/medworks):
#   1. preflight (settings, secrets, disk, firewall, DNS) — stops on any problem
#   2. refuses to build from a working tree with uncommitted changes (what runs is always a known commit)
#   3. an encrypted backup of every database and the files volume (skipped only on the very first deploy)
#   4. keeps the running image as medworks-app:previous, builds the new one, starts it; the app applies database
#      changes at start, one process at a time
#   5. waits for the health check; if the new version is not healthy in 5 minutes, puts the previous image back
#   deploy/deploy.sh [--first]    --first: the first deploy (no data yet, so no backup)
source "$(dirname "$0")/lib.sh"
FIRST=0; [ "${1:-}" = "--first" ] && FIRST=1

"$(dirname "$0")/preflight.sh" || die "Fix the problems above, then run the deploy again."
if [ -d .git ]; then
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "There are uncommitted changes in $MW_DIR: commit or discard them first (git status)."
  log "Deploying commit $(git rev-parse --short HEAD) ($(git log -1 --format=%s | cut -c1-70))"
fi

if [ "$FIRST" = 0 ]; then
  [ -n "$(dc ps -q db 2>/dev/null)" ] || die "Nothing is running yet: use deploy/deploy.sh --first for the first deploy."
  log "Backup before the update"
  "$(dirname "$0")/backup.sh" || die "The backup failed: the update was not started."
fi

if docker image inspect medworks-app:latest >/dev/null 2>&1; then
  docker tag medworks-app:latest medworks-app:previous
  log "Kept the running image as medworks-app:previous"
fi
log "Building the new image"
dc build --pull app
log "Starting"
# `up` returns an error when the new app never becomes healthy (the proxy waits for it): the health check below
# decides, so a failure here must not end the script before the rollback.
dc up -d --no-build app || true
if wait_healthy app 300; then
  dc up -d --no-build
  log "Healthy. Version: $(dc exec -T app node -p "require('./package.json').version")"
  dc ps
  exit 0
fi

warn "The new version did not become healthy. Last log lines:"
dc logs --tail 60 app >&2 || true
if docker image inspect medworks-app:previous >/dev/null 2>&1; then
  warn "Rolling back to the previous image"
  docker tag medworks-app:previous medworks-app:latest
  dc up -d --no-build app || true
  wait_healthy app 300 && { dc up -d --no-build || true; die "Rolled back to the previous version (healthy). The failed version's log is above; database changes it made are kept (they are additive). See docs/ROLLBACK_GUIDE.md."; }
  die "The previous version is not healthy either: restore the backup taken before this update (docs/ROLLBACK_GUIDE.md)."
fi
die "The first deploy is not healthy: docker compose logs app"
