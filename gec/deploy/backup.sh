#!/usr/bin/env bash
# Nightly backup: database dump + uploaded files, kept for 14 days. Run from the project folder (docker compose).
#   crontab -e  →  30 2 * * * /opt/gec/deploy/backup.sh >> /var/log/gec-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=${BACKUP_DIR:-/var/backups/gec}
STAMP=$(date +%Y-%m-%d_%H%M)
mkdir -p "$DEST"
source .env
docker compose exec -T db mariadb-dump -u gec -p"$DB_PASSWORD" --single-transaction --routines gec | gzip > "$DEST/db_$STAMP.sql.gz"
docker compose cp app:/data/storage - | gzip > "$DEST/storage_$STAMP.tar.gz"
find "$DEST" -type f -mtime +14 -delete
echo "backup ok $STAMP"
