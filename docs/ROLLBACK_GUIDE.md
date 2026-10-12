# MedWorks — Rollback Guide

Pick the smallest step that fixes the problem.

## 1. A new version is unhealthy right after deploying

`deploy/deploy.sh` handles it: if the new container is not healthy within 5 minutes it re-tags
`medworks-app:previous` as `latest`, starts it, and stops with a message. Nothing to do except read the log it printed.

## 2. A new version is healthy but misbehaves

```bash
cd /opt/medworks
docker image ls medworks-app                 # latest and previous
docker tag medworks-app:previous medworks-app:latest
docker compose up -d --no-build app
docker compose ps                            # healthy?
git log --oneline -3                         # then put the code back to match:
git checkout <previous tag or commit>        # so the next deploy does not bring the bad version back
```

Database changes: migrations in this project only add tables/columns (they are written to be additive), so the
previous version runs on the newer schema. If a release notes otherwise, use section 3.

## 3. Data is wrong (bad migration, mistaken bulk change)

Restore the backup `deploy/deploy.sh` took just before the update (newest folder in `/var/backups/medworks`):

```bash
ls -1t /var/backups/medworks | head -3
deploy/restore.sh --verify  /var/backups/medworks/<folder>    # optional, proves it first
deploy/restore.sh --production /var/backups/medworks/<folder> # safety backup → restore → health check
```

Data entered after that backup is lost unless it is re-entered — the safety backup taken by the restore keeps it, so
it can be looked up afterwards (`--verify` it, or restore it into a separate database by hand).

## 4. The whole migration to the VPS must be undone

Before the DNS switch: nothing to undo; the old server is untouched.
After the DNS switch: point the `medworks.app` / `www` A records back at the old server's IP and turn its
maintenance mode off. The old server was only read during the migration. Data entered on the VPS in between must be
exported and re-entered (keep the decision window short — see `docs/DATABASE_MIGRATION_PLAN.md`).

## 5. The server is lost

New VPS → `docs/VPS_DEPLOYMENT_GUIDE.md` sections 1–7 with the saved `.env` → copy the latest off-server backup →
`deploy/restore.sh --production <folder>` → DNS to the new IP.

## Check after any rollback

```bash
docker compose ps
curl -s https://medworks.app/healthz
docker compose run --rm app node app.js check-secrets
docker compose logs --since 10m app | grep -i -E "error|fail" | tail
```
