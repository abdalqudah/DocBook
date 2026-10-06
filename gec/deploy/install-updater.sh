#!/usr/bin/env bash
# Installs the server updater behind Settings → System update. Run once on the server, as root, from the project:
#   sudo ./deploy/install-updater.sh            (Docker install — the default)
#   sudo UPDATE_MODE=systemd APP_SERVICE=gec ./deploy/install-updater.sh   (Node under systemd)
set -euo pipefail
APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
command -v python3 >/dev/null || { echo "python3 is required (apt install -y python3)"; exit 1; }
git -C "$APP_DIR" rev-parse --show-toplevel >/dev/null || { echo "$APP_DIR is not a git checkout — clone the repository instead of copying files"; exit 1; }
mkdir -p "$APP_DIR/runtime" && chown 1000:1000 "$APP_DIR/runtime"
chmod +x "$APP_DIR/deploy/updater.py" "$APP_DIR/deploy/backup.sh"
for u in gec-updater.service gec-updater.timer gec-updater.path; do
  sed "s#__APP_DIR__#$APP_DIR#g" "$APP_DIR/deploy/$u" > "/etc/systemd/system/$u"
done
[ -f /etc/default/gec-updater ] || cat > /etc/default/gec-updater <<CONF
APP_DIR=$APP_DIR
UPDATE_MODE=${UPDATE_MODE:-docker}
APP_SERVICE=${APP_SERVICE:-gec}
# UPDATE_BRANCH=main
CHECK_EVERY_MIN=30
CONF
systemctl daemon-reload
systemctl enable --now gec-updater.timer gec-updater.path
systemctl start gec-updater.service
echo "Updater installed. Open Settings → System update in the workspace; it should show 'Connected' within a minute."
