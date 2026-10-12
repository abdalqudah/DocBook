#!/usr/bin/env bash
# Checks the server and .env before a deploy; prints every problem and exits non-zero if any. Changes nothing.
source "$(dirname "$0")/lib.sh"
problems=0
bad() { printf '  ✗ %s\n' "$*"; problems=$((problems + 1)); }
ok()  { printf '  ✓ %s\n' "$*"; }

echo "Preflight in $MW_DIR"
command -v docker >/dev/null && ok "docker $(docker --version | awk '{print $3}' | tr -d ,)" || bad "docker is not installed"
docker compose version >/dev/null 2>&1 && ok "docker compose plugin" || bad "the docker compose plugin is missing"
[ -f .env ] || { bad ".env is missing (cp deploy/.env.production.example .env)"; echo "$problems problem(s)"; exit 1; }
perm="$(stat -c '%a' .env)"; [ "$perm" = "600" ] || [ "$perm" = "400" ] && ok ".env permissions $perm" || bad ".env is readable by others ($perm): chmod 600 .env"
git ls-files --error-unmatch .env >/dev/null 2>&1 && bad ".env is tracked by git: remove it from the repository" || true

len() { local v; v="$(envval "$1")"; printf '%s' "${#v}"; }
[ "$(len SESSION_SECRET)" -ge 32 ] && ok "SESSION_SECRET set" || bad "SESSION_SECRET must be at least 32 characters"
[ "$(len APP_KEY)" -ge 32 ] && ok "APP_KEY set" || bad "APP_KEY must be at least 32 characters (when moving servers: the OLD server's APP_KEY, or its SESSION_SECRET if it had none)"
[ "$(len DB_PASSWORD)" -ge 16 ] && ok "DB_PASSWORD set" || bad "DB_PASSWORD must be at least 16 characters"
[ "$(len DB_ROOT_PASSWORD)" -ge 16 ] && ok "DB_ROOT_PASSWORD set" || bad "DB_ROOT_PASSWORD must be at least 16 characters"
[ "$(envval DB_PASSWORD)" != "$(envval DB_ROOT_PASSWORD)" ] || bad "DB_PASSWORD and DB_ROOT_PASSWORD must differ"
url="$(envval APP_URL)"; dom="$(envval DOMAIN)"
case "$url" in https://*) ok "APP_URL $url" ;; *) bad "APP_URL must start with https://" ;; esac
[ -n "$dom" ] && [ "$url" = "https://$dom" ] && ok "DOMAIN matches APP_URL" || bad "DOMAIN ($dom) must be the host of APP_URL ($url)"
[ -n "$(envval ACME_EMAIL)" ] && ok "ACME_EMAIL set" || bad "ACME_EMAIL is required for the HTTPS certificates"
[ "$(len BACKUP_PASSPHRASE)" -ge 16 ] && ok "BACKUP_PASSPHRASE set" || bad "BACKUP_PASSPHRASE must be at least 16 characters (backups are encrypted)"
sa="$(envval SUPER_ADMIN_PASSWORD)"; [ -z "$sa" ] || [ ${#sa} -ge 12 ] && ok "SUPER_ADMIN_PASSWORD" || bad "SUPER_ADMIN_PASSWORD must be at least 12 characters"

free_kb="$(df -Pk . | awk 'NR==2 {print $4}')"
[ "$free_kb" -gt 3145728 ] && ok "free disk $((free_kb / 1024)) MB" || bad "less than 3 GB free disk space"
if command -v ufw >/dev/null 2>&1; then
  # /etc/ufw/ufw.conf is readable without sudo (ufw status is not)
  grep -q '^ENABLED=yes' /etc/ufw/ufw.conf 2>/dev/null && ok "firewall (ufw) enabled" || bad "the firewall is off (sudo ufw enable after allowing OpenSSH, 80, 443)"
fi
if [ -n "$dom" ] && command -v getent >/dev/null 2>&1; then
  ip="$(getent ahostsv4 "$dom" | awk 'NR==1{print $1}')"; mine="$(envval SERVER_IP)"
  if [ -z "$ip" ]; then bad "$dom does not resolve yet (A record → this server)"; elif [ -n "$mine" ] && [ "$ip" != "$mine" ]; then bad "$dom points to $ip, not SERVER_IP $mine"; else ok "$dom → $ip"; fi
fi
echo "$problems problem(s)"
[ "$problems" -eq 0 ]
