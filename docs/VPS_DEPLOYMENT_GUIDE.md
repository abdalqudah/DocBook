# MedWorks — VPS Deployment Guide (Hostinger, Ubuntu 24.04)

Exact commands, in order. Replace `203.0.113.10` with the VPS IP and `medworks.app` with the domain. Lines starting
with `#` are explanations. Nothing here contains a password: every secret is generated on the server.

> Status: these steps have **not** been run on the real VPS yet. The Docker part (sections 6–12) was run on a local
> test stack; see `docs/TEST_RESULTS.md`. For the Hostinger server (187.7.75.192) follow the step-by-step runbook
> with expected results and approval gates: `docs/VPS_PREPARATION_CHECKLIST.md`.

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

## 2. Non-root user with SSH keys (root stays usable until verified)

Exact commands with expected output: `docs/VPS_PREPARATION_CHECKLIST.md` §3. In short: create `deploy` (sudo),
put your public key in `/home/deploy/.ssh/authorized_keys`, and check `ssh deploy@203.0.113.10 'sudo -v'` from a
second terminal while the root session stays open. Only then, as a separate approved step, disable root and password
login:

```bash
# Files in /etc/ssh/sshd_config.d are read in name order and the FIRST value wins; Ubuntu cloud images ship
# 50-cloud-init.conf with "PasswordAuthentication yes", so this file must sort before it (01-…).
sudo tee /etc/ssh/sshd_config.d/01-medworks.conf >/dev/null <<'CONF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
CONF
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication) '   # all "no"
```

Keep the provider's browser / recovery console at hand to undo it (delete that file, reload ssh) if needed.

## 3. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw limit OpenSSH
sudo ufw enable
sudo ufw status verbose
# only at go-live (section 9):
# sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
```

Docker publishes only ports 80/443 (Caddy) after go-live, and before it only `127.0.0.1:8080` (loopback). The
database has no published port. Ports Docker publishes bypass ufw, so never add `ports:` to `db` or `app`
(`deploy/preflight.sh` checks it).

## 4. Docker Engine and Compose (official repository)

`docs/VPS_PREPARATION_CHECKLIST.md` §5: Docker's apt repository, `docker-ce` + `docker-compose-plugin`,
`/etc/docker/daemon.json` with `live-restore` and log rotation, `deploy` in the `docker` group, swap if none.

## 5. Get the code

`/opt/medworks` (owner `deploy`) and `/var/backups/medworks` (mode 700). Clone the private repository with a
read-only GitHub deploy key, check out the release branch, and confirm the application code equals the release
commit (checklist §6.4).

## 6. Environment file (secrets generated on the server, never printed)

```bash
cd /opt/medworks
deploy/init-env.sh 203.0.113.10        # creates .env (600) with random secrets; refuses if .env exists
nano .env                              # DOMAIN, APP_URL, ACME_EMAIL, SUPER_ADMIN_EMAIL, DB_BUFFER_POOL, SMTP_*, OFFSITE_TARGET
```

Copy `.env` into your password manager (it holds the only copy of `BACKUP_PASSPHRASE`). Moving from the old server:
`APP_KEY` must be the old server's value before the import. Every variable: `docs/ENVIRONMENT_VARIABLES.md`.
Never run `docker compose config` without `--quiet`: it prints the environment, secrets included.

## 7. Database

Nothing to install: MariaDB 11.4 runs in the `db` container, with its data in the `medworks_db_data` volume. On its
first start it creates `DB_NAME`, the app user, and (from `deploy/mariadb/init/`) the right to create the clinic
databases `<DB_NAME>_*`. The app creates every table at its first start (132 migrations).

## 8. First deploy before DNS (database + app only, reached through an SSH tunnel)

```bash
cd /opt/medworks
deploy/preflight.sh --before-dns        # all ✓; the DNS line is information only
deploy/deploy.sh --first --no-proxy     # db + app, app on 127.0.0.1:8080 only; Caddy NOT started: no certificates
curl -s http://127.0.0.1:8080/healthz   # {"status":"ok"}
# from your computer:  ssh -N -L 8080:127.0.0.1:8080 deploy@203.0.113.10   then open http://localhost:8080
```

`--first` is refused once the database volume exists; later updates use `deploy/deploy.sh --no-proxy` (before DNS)
or `deploy/deploy.sh` (after). Data from the old server goes into an **empty** installation:
`docs/DATABASE_MIGRATION_PLAN.md` (`import-migration.sh … --no-proxy` before the DNS switch).

## 9. Domain and HTTPS (go-live)

Only after section 8 is healthy and the switch is approved:

1. Open the web ports: `sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp`.
2. DNS for `medworks.app`: `A @ 203.0.113.10` and `A www 203.0.113.10`, TTL 300; remove `AAAA` records unless the
   VPS has IPv6 configured. Wait until `dig +short medworks.app www.medworks.app` shows the IP.
3. `deploy/preflight.sh` must end with `0 problem(s)` (DNS included).
4. `deploy/deploy.sh` takes a backup, then starts Caddy, which obtains the Let's Encrypt certificates
   (`docker compose logs proxy | grep -i certificate`); the `127.0.0.1:8080` preview port is removed.
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

Off-server copies: set `OFFSITE_TARGET` in `.env`, then `deploy/offsite.sh test` and `deploy/offsite.sh push`; the
nightly service runs the push after each backup (`docs/BACKUP_AND_RESTORE.md`).

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
