#!/usr/bin/env bash
# Creates /opt/medworks/.env from deploy/.env.production.example with every secret generated on THIS server
# (SESSION_SECRET, APP_KEY, DB_PASSWORD, DB_ROOT_PASSWORD, BACKUP_PASSPHRASE, SUPER_ADMIN_PASSWORD). Secrets are
# never printed, never passed on a command line and never leave the server; .env is created with mode 600.
# It refuses to touch an existing .env (the database volume keeps the passwords it was first started with).
#   deploy/init-env.sh <server IPv4>
# Afterwards: copy .env to your password manager (it holds the only copy of BACKUP_PASSPHRASE), and
#   - moving from the old server: replace APP_KEY with the old server's APP_KEY (or its SESSION_SECRET if it never
#     had one) BEFORE importing (docs/DATABASE_MIGRATION_PLAN.md);
#   - see the super admin password once with:  grep '^SUPER_ADMIN_PASSWORD=' .env   (then clear your terminal).
source "$(dirname "$0")/lib.sh"
require_cmd openssl
IP="${1:-}"
[[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "Usage: deploy/init-env.sh <server IPv4>"
[ -e .env ] && die ".env already exists in $MW_DIR: it is never overwritten (edit it, or move it away yourself)."
TEMPLATE="deploy/.env.production.example"
[ -f "$TEMPLATE" ] || die "$TEMPLATE not found"

gen() { local v=""; while [ ${#v} -lt 48 ]; do v+="$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9')"; done; printf '%s' "${v:0:48}"; }
declare -A NEW=(
  [SESSION_SECRET]="$(gen)" [APP_KEY]="$(gen)" [DB_PASSWORD]="$(gen)" [DB_ROOT_PASSWORD]="$(gen)"
  [BACKUP_PASSPHRASE]="$(gen)" [SUPER_ADMIN_PASSWORD]="$(gen)" [SERVER_IP]="$IP"
)
tmp="$(mktemp .env.XXXXXX)"   # umask 077 (lib.sh): only this user can read it
while IFS= read -r line || [ -n "$line" ]; do
  key="${line%%=*}"
  if [[ "$line" =~ ^[A-Z_]+= ]] && [ -n "${NEW[$key]+x}" ]; then printf '%s=%s\n' "$key" "${NEW[$key]}"; else printf '%s\n' "$line"; fi
done < "$TEMPLATE" > "$tmp"
chmod 600 "$tmp" && mv -n "$tmp" .env
[ -f "$tmp" ] && { rm -f "$tmp"; die ".env appeared meanwhile; nothing was changed."; }
for k in SESSION_SECRET APP_KEY DB_PASSWORD DB_ROOT_PASSWORD BACKUP_PASSPHRASE SUPER_ADMIN_PASSWORD; do
  [ "$(envval "$k" | wc -c)" -ge 48 ] || die "$k was not written correctly"
done
log ".env created (mode $(stat -c %a .env)) with generated secrets; values not shown."
log "Review the non-secret settings: DOMAIN, ACME_EMAIL, APP_URL, SUPER_ADMIN_EMAIL, DB_BUFFER_POOL, SMTP_* (nano .env)."
log "Then store a copy of .env in your password manager."
