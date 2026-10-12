# MedWorks — Hostinger VPS Preparation Runbook (Stage E, before DNS)

Target: Hostinger VPS `srv2054361.hstgr.cloud`, IPv4 `187.7.75.192`, Ubuntu 24.04 LTS, Docker Compose, domain
`medworks.app`. Application release: **2.9.52, commit `351fa00`**.

This runbook prepares the server and runs MedWorks **with synthetic data only**, reachable only through an SSH tunnel.
It does **not** change DNS, request certificates, open ports 80/443, import real data or delete anything real.
Every step says what you should see. **STOP** marks a point that needs your explicit approval before going on.

> Nothing here was run on the VPS by Claude: the build environment cannot reach the server (port 22 is blocked from
> it). Every script and command sequence below was run on a local Docker copy of the same stack; results are in
> `docs/TEST_RESULTS.md` §9. Hostinger panel labels are given as they usually appear and may differ slightly.

## 0. What is fixed before you start

| Item | Value / check |
|---|---|
| Release archive | `update-2.9.52.zip`, 9 720 056 bytes, SHA-256 `1ca1e323d08b4aa6f6a23946eb1894d2b65bc3ce23923716def5385ad66a8dfa`, version 2.9.52, 981 files; every file identical to a clean build of `351fa00`. (A rebuilt zip has a different SHA-256 because zip entries carry timestamps; compare the extracted files instead.) |
| Code deployed on the VPS | Branch `claude/docbook-remoteway-ux-rebuild-xqi9wo` at the deployment-tooling commit after `351fa00`; the **application code is identical** to `351fa00` (only `deploy/`, `docs/`, `CHANGELOG.md` and the edition packager `scripts/build-editions.js` changed, none of which is in the image) — checked in step 6.4 |
| The VPS builds its image from git | The zip is the record of the release; Docker builds the same `dist` from the same commit |

## 1. On your computer

```bash
# 1.1 An SSH key (skip if you already have ~/.ssh/id_ed25519)
ssh-keygen -t ed25519 -C "medworks-admin"
cat ~/.ssh/id_ed25519.pub          # you will paste this line in step 3
```

## 2. First login (as root, the way you use today) — facts and a snapshot

```bash
ssh root@187.7.75.192
lsb_release -ds; uname -r; nproc; free -h; df -h /; swapon --show
ss -tlnp
ufw status; docker --version 2>/dev/null || echo "no docker"
```

Expected: `Ubuntu 24.04.x LTS`; note CPU/RAM/disk. `ss -tlnp` normally shows only `:22` (sshd) and
`127.0.0.53:53` (systemd-resolved). **If anything else listens (a web panel, MySQL on :3306, an old app) — stop and
tell me what it is before continuing.**

**Hostinger panel:** VPS → *Snapshots & backups* → **create a snapshot** now (a full-server restore point).
Also note where the **Browser terminal** is (VPS → Overview): it is your recovery console if SSH ever locks you out.

## 3. Updates, base packages, administrative user (root stays usable)

```bash
apt update && apt -y full-upgrade
apt -y install ca-certificates curl git gnupg ufw fail2ban unattended-upgrades rsync python3
dpkg-reconfigure -f noninteractive unattended-upgrades
timedatectl set-timezone UTC
[ -f /var/run/reboot-required ] && reboot        # then ssh root@187.7.75.192 again

adduser --disabled-password --gecos "MedWorks admin" deploy
usermod -aG sudo deploy
passwd deploy                                     # a sudo password → your password manager
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
nano /home/deploy/.ssh/authorized_keys            # paste the line from step 1
chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
```

**Verify in a SECOND terminal on your computer (keep the root session open):**

```bash
ssh deploy@187.7.75.192 'id; sudo -v && echo SUDO_OK'
```

Expected: `uid=1000(deploy) … groups=…,27(sudo)` then, after the sudo password, `SUDO_OK`.
Root login and password login stay **enabled** at this stage (recovery path). Hardening is gate **STOP A** (§11).

## 4. Restrictive firewall (only SSH for now)

Run as `deploy` from here on (`ssh deploy@187.7.75.192`).

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw limit OpenSSH          # allows 22/tcp, rate-limits repeated connection attempts
sudo ufw enable                 # answer y; your SSH session stays connected
sudo ufw status verbose
sudo fail2ban-client status sshd
```

Expected: `Status: active`, `Default: deny (incoming), allow (outgoing)`, one rule `22/tcp (OpenSSH) LIMIT IN`
(plus v6). fail2ban shows `Status for the jail: sshd`. **80/443 stay closed** until the go-live gate (STOP E).
If Hostinger's panel firewall is enabled for this VPS, allow 22/tcp there as well (and 80/443 only at STOP E).
Note: Docker-published ports bypass ufw; this stack publishes nothing before go-live except `127.0.0.1:8080`
(loopback, not reachable from outside), and only 80/443 (Caddy) after it.

## 5. Swap, Docker Engine, Docker settings

```bash
# 5.1 Swap (only if `swapon --show` printed nothing): the image build needs memory headroom
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 5.2 Docker from Docker's official repository
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt update
sudo apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 5.3 Daemon settings: containers keep running while Docker itself is upgraded; bounded logs for everything
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{ "live-restore": true, "log-driver": "local", "log-opts": { "max-size": "20m", "max-file": "5" } }
EOF
sudo systemctl restart docker
sudo usermod -aG docker deploy
exit                                   # log in again as deploy so the docker group applies
```

```bash
ssh deploy@187.7.75.192
docker version --format 'server {{.Server.Version}}'; docker compose version
docker info --format 'live-restore={{.LiveRestoreEnabled}} logs={{.LoggingDriver}}'
docker run --rm hello-world | head -2
```

Expected: a server version, `Docker Compose version v2.x`, `live-restore=true logs=local`, `Hello from Docker!`.
(If pulls fail with HTTP 429: `docker login` with a free Docker Hub account.)

## 6. Directories and the code

```bash
sudo install -d -m 755 -o deploy -g deploy /opt/medworks
sudo install -d -m 700 -o deploy -g deploy /var/backups/medworks

# 6.1 Read-only deploy key for the private repository
ssh-keygen -t ed25519 -N "" -f ~/.ssh/medworks_deploy -C "medworks-vps-deploy"
cat ~/.ssh/medworks_deploy.pub
#   GitHub → abdalqudah/docbook → Settings → Deploy keys → Add deploy key → paste, leave "Allow write access" OFF
printf 'Host github.com\n  IdentityFile ~/.ssh/medworks_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
chmod 600 ~/.ssh/config
ssh -T git@github.com        # first time: check GitHub's published fingerprint, answer yes → "successfully authenticated"

# 6.2 Clone and pin the commit
git clone git@github.com:abdalqudah/docbook.git /opt/medworks
cd /opt/medworks
git checkout claude/docbook-remoteway-ux-rebuild-xqi9wo
git log --oneline -3          # the top commit is the deployment-tooling commit; 351fa00 is below it

# 6.3 Scripts are executable
chmod +x deploy/*.sh
for f in deploy/*.sh; do bash -n "$f" || echo "SYNTAX ERROR in $f"; done

# 6.4 The application code is exactly the 2.9.52 release
git diff --quiet 351fa00 HEAD -- . ':!deploy' ':!docs' ':!CHANGELOG.md' ':!scripts/build-editions.js' \
  && echo "APP CODE IDENTICAL TO 351fa00" || echo "DIFFERENT — stop"
git diff --stat 351fa00 HEAD | tail -1      # what did change: deploy/ and docs/ only
node -v 2>/dev/null; grep '"version"' package.json | head -1
```

Expected: no syntax errors; `APP CODE IDENTICAL TO 351fa00`; `"version": "2.9.52"` (Node is not needed on the host).
*(No GitHub access from the VPS? Alternative: on your computer `git bundle create medworks.bundle claude/docbook-remoteway-ux-rebuild-xqi9wo`,
`scp medworks.bundle deploy@187.7.75.192:~`, then `git clone ~/medworks.bundle /opt/medworks`.)*

## 7. Production secrets (generated on the VPS, never printed)

```bash
cd /opt/medworks
deploy/init-env.sh 187.7.75.192
stat -c '%a %U %n' .env
nano .env       # check only: DOMAIN=medworks.app, APP_URL=https://medworks.app, ACME_EMAIL, SUPER_ADMIN_EMAIL,
                # DB_BUFFER_POOL (≈ 25–40 % of RAM, e.g. 2G on 8 GB). Do not paste secrets anywhere else.
```

Expected: `.env created (mode 600) with generated secrets; values not shown.` and `600 deploy .env`.
The script refuses to run if `.env` exists (it never overwrites).

Keep the only off-server copy of the secrets — **from your computer**:

```bash
scp deploy@187.7.75.192:/opt/medworks/.env ./medworks-production.env
# store its content in your password manager (one secure note), then:
shred -u ./medworks-production.env 2>/dev/null || rm -P ./medworks-production.env 2>/dev/null || rm ./medworks-production.env
```

Notes:
- `BACKUP_PASSPHRASE` exists only in `.env` and your password manager — without it no backup can be restored.
- Migration later: `APP_KEY` must then be replaced by the **old server's** `APP_KEY` (or its `SESSION_SECRET`)
  before the real import (STOP D). Nothing is encrypted with the new key except synthetic test data.
- Never run `docker compose config` without `--quiet` (it prints the environment, secrets included).

## 8. Validation before the first start (changes nothing)

```bash
cd /opt/medworks
docker compose config --quiet && echo COMPOSE_OK
deploy/preflight.sh --before-dns
```

Expected: `COMPOSE_OK`, then every line ✓ (docker, daemon reachable by deploy, `.env` 600, the secrets, `APP_URL`,
`DOMAIN matches APP_URL`, `ACME_EMAIL`, `BACKUP_PASSPHRASE`, `compose.yaml valid`, `published ports: only the proxy,
80/443`, free disk, `firewall (ufw) enabled`), an information line `i medworks.app → … (not this server yet: fine
before the DNS switch)` and `0 problem(s)`.

---

## STOP B — approval to run `deploy/deploy.sh --first --no-proxy`

**What it does, exactly** (verified on the local copy, `docs/TEST_RESULTS.md` §9):
1. Runs `preflight.sh --before-dns`; stops on any ✗.
2. Refuses if the working tree has uncommitted changes, and refuses `--first` if the volume `medworks_db_data`
   already exists (it can never be used on a server that holds data).
3. Takes no backup (there is no data).
4. Builds the image `medworks-app:latest` from the checked-out commit (downloads `node:22.23.3-bookworm-slim`,
   `mariadb:11.4` and the npm packages; 5–10 minutes).
5. Creates the Docker volumes `medworks_db_data`, `medworks_app_storage` and the networks; starts **only** `db` and
   `app`. MariaDB creates the database `medworks`, the user `medworks` and its rights on `medworks` and
   `medworks_*` (first start of an empty volume only). The app applies the 132 migrations and creates the platform
   super admin from `.env`.
6. Publishes the app on `127.0.0.1:8080` **only** (loopback). Caddy is **not** started: no port 80/443, no
   certificate request, no DNS.
7. Waits up to 5 min for the health check; prints `Healthy. Version: 2.9.52`.

**Database behaviour:** creates a new, empty database; nothing is dropped. **Rollback:** on a first deploy there is
no previous version; if it is not healthy it stops with the error and leaves the containers for `docker compose logs`.
Undoing it completely means deleting the volumes (`docker compose down -v`) — fine while only synthetic data exists,
but it is destructive, so it is only done with a separate approval.

```bash
cd /opt/medworks
deploy/deploy.sh --first --no-proxy
```

## 9. After the first start — checks

```bash
docker compose ps                                   # db and app: Up … (healthy); no proxy
curl -s http://127.0.0.1:8080/healthz; echo         # {"status":"ok"}
sudo ss -tlnp | grep -v 127.0.0                     # only :22 (sshd) — nothing on 80, 443, 3000, 3306, 8080 publicly
docker compose port db 3306 || true                 # prints nothing / ":0" → the database is not published
docker compose exec -T app sh -c 'id -u; touch /app/x 2>&1 | head -1'   # 1000, then "Read-only file system"
```

From **your computer** (proves nothing else is reachable):

```bash
nc -zv -w 5 187.7.75.192 3306    # must fail (timed out / refused)
nc -zv -w 5 187.7.75.192 8080    # must fail
nc -zv -w 5 187.7.75.192 80      # must fail until go-live
nmap -Pn -p 22,80,443,3000,3306,8080 187.7.75.192   # only 22 open (if you have nmap)
```

Open the app through an SSH tunnel (nothing exposed):

```bash
ssh -N -L 8080:127.0.0.1:8080 deploy@187.7.75.192      # leave running, then browse http://localhost:8080
```

- Super admin: e-mail from `SUPER_ADMIN_EMAIL`; password shown once on the VPS with
  `grep '^SUPER_ADMIN_PASSWORD=' /opt/medworks/.env` (then `clear`). Sign in at `http://localhost:8080/login`.
- Create a **synthetic** clinic: `http://localhost:8080/signup` with an address like `synthetic-owner@example.test`,
  clinic name `Synthetic Test Clinic`; add one or two invented patients. (Real e-mail is not configured yet.)

## 10. Off-server backup storage — set up and prove a restore

**10.1 Choose the destination** (needs your decision and an account — see STOP C):
an S3-compatible bucket (Backblaze B2, Cloudflare R2, Wasabi, AWS S3, Hetzner Object Storage) via **rclone**, or another
server / Hetzner Storage Box via **rsync over SSH**. Use a bucket/user dedicated to MedWorks, with an expiry rule
(e.g. delete objects after 90 days) and, if offered, object lock / versioning.

**10.2 Configure (rclone example):**

```bash
sudo apt -y install rclone
rclone config            # n → name: offsite → your provider → its access key/secret → defaults
chmod 600 ~/.config/rclone/rclone.conf
cd /opt/medworks
nano .env                # OFFSITE_TARGET=rclone:offsite:<bucket>/medworks
deploy/offsite.sh test
```

Expected: `Destination rclone OK: write, read back and verify worked.`
(rsync instead: create an SSH key for deploy, authorise it on the other machine, `OFFSITE_TARGET=rsync:user@host:/path`.)

**10.3 Backup → off-server → lost-server restore test (synthetic data):**

```bash
deploy/backup.sh                                  # Done: /var/backups/medworks/<time> (…)
deploy/offsite.sh push                            # <time> verified at the destination
N=$(ls -1 /var/backups/medworks | grep -v partial | tail -1); echo $N
deploy/offsite.sh pull "$N" /tmp/offsite-check    # Fetched … (manifest OK)
deploy/restore.sh --verify /tmp/offsite-check/$N  # Row counts: all … tables match … VERIFIED: this backup restores completely.
grep patients /tmp/offsite-check/$N/ROWCOUNTS.txt # your synthetic patients are counted
rm -rf /tmp/offsite-check
```

`restore.sh --verify` uses a temporary, network-less MariaDB container and never touches the live database.

**10.4 Nightly schedule (backup, then off-server copy):**

```bash
sudo cp deploy/systemd/medworks-backup.service deploy/systemd/medworks-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now medworks-backup.timer
sudo systemctl start medworks-backup.service      # one run now
systemctl status medworks-backup.service --no-pager | head -5   # "Deactivated successfully" / status=0
journalctl -u medworks-backup.service -n 20 --no-pager
systemctl list-timers medworks-backup.timer
```

Take a Hostinger snapshot again at this point.

---

## 11. Gates after this stage (each needs its own explicit approval)

**STOP A — SSH hardening** (only after `ssh deploy@…` + sudo has worked from two different sessions):

```bash
# Ubuntu reads /etc/ssh/sshd_config.d/*.conf in name order and keeps the FIRST value of each setting, and cloud
# images ship 50-cloud-init.conf with "PasswordAuthentication yes" — so this file must sort before it.
sudo tee /etc/ssh/sshd_config.d/01-medworks.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication) '
```

Expected: `permitrootlogin no`, `passwordauthentication no`, `kbdinteractiveauthentication no`. Test a NEW
`ssh deploy@187.7.75.192` before closing anything. Recovery if locked out: Hostinger Browser terminal →
`rm /etc/ssh/sshd_config.d/01-medworks.conf && systemctl reload ssh`.

**STOP C — off-server destination:** which provider/account (it stores only encrypted backups; costs money).

**STOP D — reset the synthetic installation and import real data** (`docs/DATABASE_MIGRATION_PLAN.md`): the import
only writes into empty databases, so the synthetic rehearsal must first be removed with
`docker compose down -v` (deletes the synthetic volumes — destructive), then `docker compose up -d db`, set `APP_KEY`
to the old server's value, and `deploy/import-migration.sh <export> --no-proxy` (keeps Caddy off, app on the tunnel).

**STOP E — go-live (DNS + TLS):**
```bash
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
# DNS: A @ → 187.7.75.192 and A www → 187.7.75.192 (TTL 300); wait until `dig +short medworks.app` shows it
deploy/preflight.sh                     # now including the DNS line: 0 problem(s)
deploy/deploy.sh                        # backup first, then starts Caddy (certificates) and drops the 127.0.0.1:8080 port
```
