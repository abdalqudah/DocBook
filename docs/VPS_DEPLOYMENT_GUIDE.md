# MedWorks — VPS Deployment Guide (Hostinger, Ubuntu 24.04)

Exact commands, in order. Replace `203.0.113.10` with the VPS IP and `medworks.app` with the domain. Lines starting
with `#` are explanations. Nothing here contains a password: every secret is generated on the server.

> Status: these steps have **not** been run on the real VPS yet. The Docker part (sections 6–10) was run on a local
> test stack; see `docs/TEST_RESULTS.md`.

## 0. Before you start

- In Hostinger hPanel → VPS: choose **Ubuntu 24.04**, note the IP, and add your **SSH public key** (hPanel → SSH keys).
- Keep the root password Hostinger shows in your password manager only. It is not used after step 2.
- Do **not** change DNS yet (section 9).

## 1. First login and updates

```bash
# from your computer
ssh root@203.0.113.10

apt update && apt -y full-upgrade
apt -y install ca-certificates curl git gnupg ufw fail2ban unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades     # automatic security updates
timedatectl set-timezone UTC
reboot   # if a new kernel was installed; then ssh in again
```

## 2. Non-root user with SSH keys; disable password and root login

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
passwd deploy        # a sudo password for deploy (password manager)

# SSH: keys only, no root login
cat >/etc/ssh/sshd_config.d/60-medworks.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sshd -t && systemctl reload ssh
```

**Open a second terminal and check `ssh deploy@203.0.113.10` works before closing the root session.**

## 3. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp      # HTTP/3
sudo ufw enable
sudo ufw status verbose
```

Docker publishes only ports 80/443 (Caddy). The database has no published port. Note: ports Docker publishes bypass
ufw rules, so never add `ports:` to the `db` or `app` services.
If Hostinger's own firewall (hPanel → VPS → Firewall) is enabled, allow 22, 80 and 443 there too.

## 4. Docker Engine and Compose (official repository)

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt update
sudo apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy
exit    # log out and back in as deploy so the group applies
docker version && docker compose version
```

## 5. Get the code

```bash
sudo mkdir -p /opt/medworks /var/backups/medworks
sudo chown deploy:deploy /opt/medworks /var/backups/medworks
chmod 700 /var/backups/medworks

# The repository is private: give the server a read-only deploy key
ssh-keygen -t ed25519 -N "" -f ~/.ssh/medworks_deploy -C "medworks-vps"
cat ~/.ssh/medworks_deploy.pub     # GitHub → repository → Settings → Deploy keys → Add (read-only)
cat >>~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/medworks_deploy
  IdentitiesOnly yes
EOF
git clone git@github.com:abdalqudah/docbook.git /opt/medworks
cd /opt/medworks
git checkout <release tag or branch to deploy>
```

## 6. Environment file

```bash
cd /opt/medworks
cp deploy/.env.production.example .env
chmod 600 .env
gen() { openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48; }
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(gen)|; s|^DB_PASSWORD=.*|DB_PASSWORD=$(gen)|; s|^DB_ROOT_PASSWORD=.*|DB_ROOT_PASSWORD=$(gen)|; s|^BACKUP_PASSPHRASE=.*|BACKUP_PASSPHRASE=$(gen)|; s|^SUPER_ADMIN_PASSWORD=.*|SUPER_ADMIN_PASSWORD=$(gen)|" .env
# APP_KEY: a NEW install → $(gen). MOVING from the old server → the old server's APP_KEY (or its SESSION_SECRET
# if it never had an APP_KEY). Set it by hand:
nano .env       # APP_KEY, DOMAIN, ACME_EMAIL, APP_URL, SERVER_IP=203.0.113.10, DB_BUFFER_POOL (≈ 25–40 % of RAM), SMTP_*
```

Copy `.env` to your password manager / an offline place (`BACKUP_PASSPHRASE` is needed to restore any backup).
Every variable: `docs/ENVIRONMENT_VARIABLES.md`.

## 7. Database

Nothing to install: MariaDB 11.4 runs in the `db` container, with its data in the `medworks_db_data` volume. On its
first start it creates `DB_NAME`, the app user, and (from `deploy/mariadb/init/`) the right to create the clinic
databases `<DB_NAME>_*`. The app creates every table at its first start (132 migrations).

## 8. First deploy (before DNS: test on the IP)

```bash
cd /opt/medworks
deploy/preflight.sh          # the DNS line fails until section 9 — that is expected now; everything else must be ✓
docker compose build app
docker compose up -d db app  # without the proxy: no certificate requests yet
docker compose ps            # db and app "healthy" (first start: 1–3 minutes, migrations)
docker compose exec app node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>r.text()).then(console.log)"
docker compose logs --tail 50 app
```

Moving data from the old server happens here, before the proxy and DNS: `docs/DATABASE_MIGRATION_PLAN.md`.

## 9. Domain and HTTPS

Only after section 8 is healthy and the switch is approved:

1. DNS for `medworks.app` (at the registrar / Hostinger DNS zone):
   - `A  @    203.0.113.10` TTL 300
   - `A  www  203.0.113.10` TTL 300
   - remove any `AAAA` records unless the VPS has IPv6 configured.
2. Wait until both resolve: `dig +short medworks.app www.medworks.app` → `203.0.113.10`.
3. Start everything:
   ```bash
   deploy/deploy.sh --first     # preflight must be all ✓ now; starts db, app and Caddy
   ```
4. Caddy obtains the Let's Encrypt certificates by itself (`docker compose logs proxy | grep -i certificate`).
5. Check:
   ```bash
   curl -sI http://medworks.app | head -3         # 308 → https
   curl -sI https://www.medworks.app | head -3    # 301 → https://medworks.app
   curl -s https://medworks.app/healthz           # {"status":"ok"}
   curl -sI https://medworks.app | grep -i -E "strict-transport|content-security"
   ```

## 10. Health, logs, restart

```bash
docker compose ps                         # STATUS healthy
docker compose logs -f app                # live log (Ctrl-C to stop)
docker compose logs --since 1h proxy
docker compose restart app                # restart (sessions survive: they are in the database)
docker stats --no-stream                  # memory / CPU
df -h / && docker system df               # disk
```

The containers restart by themselves after a crash or a reboot (`restart: unless-stopped`).

## 11. Backups

```bash
sudo cp deploy/systemd/medworks-backup.service deploy/systemd/medworks-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now medworks-backup.timer
systemctl list-timers medworks-backup.timer
deploy/backup.sh                                     # one now
deploy/restore.sh --verify /var/backups/medworks/<newest>   # prove it restores
```

Copy backups off the server as well (details and options in `docs/BACKUP_AND_RESTORE.md`).

## 12. Updates and rollback

```bash
cd /opt/medworks
git fetch && git checkout <new tag>
deploy/deploy.sh            # preflight → backup → build → start → health → automatic rollback if unhealthy
```

The in-app "System update" page is switched off inside Docker (it would only change files the next restart discards);
updates always go through `deploy/deploy.sh`. Manual rollback: `docs/ROLLBACK_GUIDE.md`.

## 13. Clinics' own domains

A clinic connecting `clinic-example.com` points its DNS at `SERVER_IP` (the in-app page shows the records). Caddy
requests a certificate on the first HTTPS visit, after asking the app whether that domain belongs to a clinic.
