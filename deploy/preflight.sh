#!/usr/bin/env bash
# Checks the server and .env before a deploy; prints every problem and exits non-zero if any. Changes nothing and
# never prints a secret.
#   deploy/preflight.sh                 everything, including "the domain points at SERVER_IP"
#   deploy/preflight.sh --before-dns    the same, but the DNS line is information only (before the switch)
source "$(dirname "$0")/lib.sh"
BEFORE_DNS=0; [ "${1:-}" = "--before-dns" ] && BEFORE_DNS=1
problems=0
bad() { printf '  ✗ %s\n' "$*"; problems=$((problems + 1)); }
ok()  { printf '  ✓ %s\n' "$*"; }

echo "Preflight in $MW_DIR"
command -v docker >/dev/null && ok "docker $(docker --version | awk '{print $3}' | tr -d ,)" || bad "docker is not installed"
docker compose version >/dev/null 2>&1 && ok "docker compose plugin" || bad "the docker compose plugin is missing"
docker info >/dev/null 2>&1 && ok "docker daemon reachable by $(id -un)" || bad "cannot talk to the docker daemon as $(id -un) (sudo usermod -aG docker $(id -un), then log in again)"
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

# compose.yaml valid with this .env (checked quietly: `docker compose config` without --quiet would print the secrets)
if dc -f compose.yaml config --quiet 2>/dev/null; then ok "compose.yaml valid"; else bad "compose.yaml is not valid with this .env (docker compose config --quiet)"; fi
# Only Caddy may publish ports to the internet, and only 80/443; the database never.
published="$(dc -f compose.yaml config --format json 2>/dev/null | python3 -c '
import json,sys
c=json.load(sys.stdin)
for name,svc in c.get("services",{}).items():
    for p in svc.get("ports",[]) or []:
        print(name, p.get("host_ip") or "0.0.0.0", p.get("published"), p.get("protocol","tcp"))
' 2>/dev/null || true)"
unexpected="$(printf '%s\n' "$published" | awk 'NF && !($1=="proxy" && ($3=="80" || $3=="443"))')"
[ -n "$published" ] && [ -z "$unexpected" ] && ok "published ports: only the proxy, 80/443" || bad "unexpected published ports: ${unexpected:-none found}"

free_kb="$(df -Pk . | awk 'NR==2 {print $4}')"
[ "$free_kb" -gt 3145728 ] && ok "free disk $((free_kb / 1024)) MB" || bad "less than 3 GB free disk space"
if command -v ufw >/dev/null 2>&1; then
  # /etc/ufw/ufw.conf is readable without sudo (ufw status is not)
  grep -q '^ENABLED=yes' /etc/ufw/ufw.conf 2>/dev/null && ok "firewall (ufw) enabled" || bad "the firewall is off (sudo ufw enable after allowing OpenSSH, 80, 443)"
fi
if [ -n "$dom" ] && command -v getent >/dev/null 2>&1; then
  ip="$(getent ahostsv4 "$dom" 2>/dev/null | awk 'NR==1{print $1}' || true)"; mine="$(envval SERVER_IP)"
  if [ -n "$ip" ] && { [ -z "$mine" ] || [ "$ip" = "$mine" ]; }; then ok "$dom → $ip"
  elif [ "$BEFORE_DNS" = 1 ]; then printf '  i %s\n' "$dom → ${ip:-nothing} (not this server yet: fine before the DNS switch)"
  elif [ -z "$ip" ]; then bad "$dom does not resolve yet (A record → this server)"
  else bad "$dom points to $ip, not SERVER_IP $mine"; fi
fi
echo "$problems problem(s)"
[ "$problems" -eq 0 ]
