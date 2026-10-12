#!/usr/bin/env bash
# MedWorks deploy / update on the server (from the folder with compose.yaml, normally /opt/medworks):
#   1. preflight (settings, secrets, disk, firewall, DNS) — stops on any problem
#   2. refuses to build from a working tree with uncommitted changes (what runs is always a known commit)
#   3. an encrypted backup of every database and the files volume (skipped only on the very first deploy)
#   4. keeps the running image as medworks-app:previous, builds the new one, starts it; the app applies database
#      changes at start, one process at a time
#   5. waits for the health check; if the new version is not healthy in 5 minutes, puts the previous image back
# It never deletes a volume, drops a database or changes DNS.
#   deploy/deploy.sh [--first] [--no-proxy]
#     --first      the first deploy on an EMPTY server (no database volume yet, so no backup). Refused when the
#                  database volume already exists: use deploy/deploy.sh without --first from then on.
#     --no-proxy   before the domain points here: starts only the database and the app, publishes the app on this
#                  server's loopback address (127.0.0.1:8080, for an SSH tunnel) and does NOT start Caddy, so no
#                  certificate is requested; the DNS check is reported but does not stop the deploy.
source "$(dirname "$0")/lib.sh"
FIRST=0; NOPROXY=0
for a in "$@"; do
  case "$a" in --first) FIRST=1 ;; --no-proxy) NOPROXY=1 ;; *) die "Unknown option $a (use --first and/or --no-proxy)" ;; esac
done
SERVICES=()
# Without --no-proxy this deploy leaves the pre-DNS preview mode (it starts Caddy: the go-live switch).
[ "$NOPROXY" = 0 ] && [ "$MW_PREVIEW_AUTO" = 1 ] && unset COMPOSE_FILE
if [ "$NOPROXY" = 1 ]; then
  export COMPOSE_FILE="compose.yaml:deploy/compose.preview.yaml"
  SERVICES=(db app)
  log "Pre-DNS mode: database and app only, app on 127.0.0.1:8080, no Caddy, no certificates"
fi
DB_VOLUME="medworks_db_data" # compose.yaml sets `name: medworks`
has_db_volume() { docker volume inspect "$DB_VOLUME" >/dev/null 2>&1; }

if [ "$NOPROXY" = 1 ]; then "$(dirname "$0")/preflight.sh" --before-dns || die "Fix the problems above, then run the deploy again."
else "$(dirname "$0")/preflight.sh" || die "Fix the problems above, then run the deploy again."; fi
if [ -d .git ]; then
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "There are uncommitted changes in $MW_DIR: commit or discard them first (git status)."
  log "Deploying commit $(git rev-parse --short HEAD) ($(git log -1 --format=%s | cut -c1-70))"
fi

if [ "$FIRST" = 1 ]; then
  has_db_volume && die "--first is only for an empty server, and the database volume $DB_VOLUME already exists. Run deploy/deploy.sh without --first (it backs the data up first)."
  log "First deploy: no database volume yet, nothing to back up"
else
  has_db_volume || die "No database volume yet: this is the first deploy, run deploy/deploy.sh --first."
  if [ -z "$(dc ps --status running -q db 2>/dev/null)" ]; then
    log "Starting the database for the backup"
    dc up -d --no-build db
    wait_healthy db 180 || die "The database is not healthy: docker compose logs db"
  fi
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
  dc up -d --no-build "${SERVICES[@]}"
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
  wait_healthy app 300 && { dc up -d --no-build "${SERVICES[@]}" || true; die "Rolled back to the previous version (healthy). The failed version's log is above; database changes it made are kept (they are additive). See docs/ROLLBACK_GUIDE.md."; }
  die "The previous version is not healthy either: restore the backup taken before this update (docs/ROLLBACK_GUIDE.md)."
fi
die "The first deploy is not healthy: docker compose logs app"
