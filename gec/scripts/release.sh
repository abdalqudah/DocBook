#!/usr/bin/env bash
# Builds gec-hostinger.zip: the platform with package.json at the top of the archive, ready to upload as a
# Node.js web app (Hostinger hPanel → upload archive). No node_modules (the host installs them), no tests,
# no .env (set environment variables in the hosting panel). Usage: ./scripts/release.sh [output.zip]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=$(realpath -m "${1:-gec-hostinger.zip}")
TMP=$(mktemp -d)
git archive HEAD:"$(git rev-parse --show-prefix | sed 's#/$##')" | tar -x -C "$TMP"
rm -rf "$TMP/test" "$TMP/.env" "$TMP/runtime"
printf '{"commit":"%s","built_at":"%s"}\n' "$(git rev-parse HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TMP/build-info.json"
rm -f "$OUT"
(cd "$TMP" && zip -qr "$OUT" .)
rm -rf "$TMP"
echo "built $OUT"
