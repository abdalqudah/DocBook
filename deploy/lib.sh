#!/usr/bin/env bash
# Shared helpers for the MedWorks operations scripts (deploy, backup, restore, migration). Sourced, not run.
# The scripts run on the server from the folder that holds compose.yaml and .env (default /opt/medworks).
set -euo pipefail
umask 077
# The operator's answers (confirm) are read from fd 7; every other command reads nothing, so a docker command run
# before a question cannot swallow the answer typed or piped in for it.
exec 7<&0 </dev/null

MW_DIR="${MW_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$MW_DIR"

log()  { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

# One value from .env (KEY=value; no shell evaluation, so values with quotes, brackets or $ are read as written).
envval() {
  local key="$1" line
  [ -f .env ] || die ".env not found in $MW_DIR (copy deploy/.env.production.example)."
  line="$(grep -E "^${key}=" .env | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  printf '%s' "$line"
}

dc() { docker compose "$@"; }

# Pre-DNS preview mode (deploy/deploy.sh --no-proxy): the app is published on 127.0.0.1:8080 and Caddy is not
# running. When the app container was started that way, every script keeps that mode, so a backup, restore or
# import never starts Caddy (which would request certificates) or drops the preview port by itself.
MW_PREVIEW_AUTO=0
if [ -z "${COMPOSE_FILE:-}" ] && [ -f deploy/compose.preview.yaml ] \
   && docker inspect -f '{{json .HostConfig.PortBindings}}' medworks-app-1 2>/dev/null | grep -q '"HostIp":"127.0.0.1","HostPort":"8080"'; then
  export COMPOSE_FILE="compose.yaml:deploy/compose.preview.yaml"; MW_PREVIEW_AUTO=1
fi

# Runs SQL as the database root user inside the db container; the password goes through the environment, never argv.
db_root() { dc exec -T -e MYSQL_PWD="$(envval DB_ROOT_PASSWORD)" db mariadb -uroot "$@"; }

# The main database and every clinic database recorded in it (businesses.db_name), one per line.
databases() {
  local main; main="$(envval DB_NAME)"; main="${main:-medworks}"
  printf '%s\n' "$main"
  db_root -N -B "$main" -e "SELECT DISTINCT db_name FROM businesses WHERE db_name IS NOT NULL AND db_name <> '' ORDER BY db_name" 2>/dev/null || true
}

# Exact row counts of every table of database $1 as "<label>.<table> <count>" lines, in ONE query, run with the
# client command given after the label:  rowcounts medworks medworks db_root
rowcounts() {
  local db="$1" label="$2"; shift 2
  local tables sql
  tables="$("$@" -N -B -e "SELECT table_name FROM information_schema.tables WHERE table_schema='${db//\'/}' AND table_type='BASE TABLE' ORDER BY table_name")"
  [ -n "$tables" ] || return 0
  sql="$(printf '%s\n' $tables | awk -v d="$db" -v l="$label" -v q="'" 'BEGIN{ORS=""} {if (NR>1) print " UNION ALL "; print "SELECT CONCAT(" q l "." $0 " " q ", COUNT(*)) FROM `" d "`.`" $0 "`"}')"
  "$@" -N -B -e "$sql"
}

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "$1 is required."; }

confirm() { # confirm "message" "WORD": the operator must type WORD exactly
  local answer
  printf '%s\nType %s to continue: ' "$1" "$2"
  read -r answer <&7 || answer=""
  [ "$answer" = "$2" ] || die "Not confirmed. Nothing was changed."
}

app_running() { [ -n "$(dc ps --status running -q app 2>/dev/null)" ]; }

wait_healthy() { # wait_healthy <service> <seconds>
  local svc="$1" limit="$2" waited=0 id state
  while [ "$waited" -lt "$limit" ]; do
    id="$(dc ps -q "$svc" 2>/dev/null || true)"
    if [ -n "$id" ]; then
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
      [ "$state" = "healthy" ] && return 0
    fi
    sleep 5; waited=$((waited + 5))
  done
  return 1
}
